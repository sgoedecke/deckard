//! Local-file-only DeBERTa-v2 inference C ABI backed by Candle. No network
//! features. Loads Hugging Face `config.json` + `model.safetensors` directly.
//!
//! All calls return a status: 0 success, 1 invalid argument, 2 asset failure
//! (missing/unreadable config or weights), 3 model load failure, 4 forward
//! failure, 5 non-finite output, 6 caught panic. Errors never include input
//! text or filesystem paths.
//!
//! Safety contract: non-null pointers must be aligned, live allocations of the
//! declared length/type. Output scalar pointers must be writable and must not
//! alias input. Handles must come from open, remain live throughout each call,
//! and must not be freed concurrently.

use std::mem::align_of;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::Once;
use std::{ptr, slice, str};

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::debertav2::{Config, DebertaV2SeqClassificationModel};

const INVALID: i32 = 1;
const ASSETS: i32 = 2;
const LOAD: i32 = 3;
const FORWARD: i32 = 4;
const NONFINITE: i32 = 5;
const PANIC: i32 = 6;
const MAX_SEQ: usize = 512;
const MAX_PATH: usize = 32 * 1024;
const VOCAB: u32 = 128_100;

pub struct Handle {
    model: DebertaV2SeqClassificationModel,
    device: Device,
}

fn boundary(f: impl FnOnce() -> Result<(), i32>) -> i32 {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        std::panic::set_hook(Box::new(|_| eprintln!("Deckard: candle_panic")));
    });
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(())) => 0,
        Ok(Err(code)) => code,
        Err(payload) => {
            // A custom panic payload's destructor may itself panic.
            std::mem::forget(payload);
            PANIC
        }
    }
}

fn aligned<T>(p: *const T) -> bool {
    !p.is_null() && (p as usize) % align_of::<T>() == 0
}

unsafe fn input_path(value: *const u8, len: usize) -> Result<String, i32> {
    if len == 0 || len > MAX_PATH || !aligned(value) {
        return Err(INVALID);
    }
    // Model paths come from UTF-8 JSON manifests; this mirrors the tokenizer crate.
    str::from_utf8(slice::from_raw_parts(value, len))
        .map(str::to_owned)
        .map_err(|_| INVALID)
}

unsafe fn input_ids(values: *const u32, len: usize) -> Result<Vec<u32>, i32> {
    if len == 0 || len > MAX_SEQ || !aligned(values) {
        return Err(INVALID);
    }
    let values = slice::from_raw_parts(values, len);
    if values.iter().any(|&id| id >= VOCAB) {
        return Err(INVALID);
    }
    Ok(values.to_vec())
}

unsafe fn input_mask(values: *const f32, len: usize, ids_len: usize) -> Result<Vec<f32>, i32> {
    if len != ids_len || !aligned(values) {
        return Err(INVALID);
    }
    let values = slice::from_raw_parts(values, len);
    if values.iter().any(|&value| value != 0.0 && value != 1.0) {
        return Err(INVALID);
    }
    Ok(values.to_vec())
}

unsafe fn model<'a>(handle: *const Handle) -> Result<&'a Handle, i32> {
    if !aligned(handle) {
        return Err(INVALID);
    }
    // Handles outlive each call; open/close are serialized by the caller.
    Ok(&*handle)
}

unsafe fn scalar(out: *mut f64, value: f64) -> Result<(), i32> {
    if !aligned(out) {
        return Err(INVALID);
    }
    out.write(value);
    Ok(())
}

fn load(config_path: String, weights_path: String) -> Result<Box<Handle>, i32> {
    let config_text = std::fs::read(Path::new(&config_path)).map_err(|_| ASSETS)?;
    let config: Config = serde_json::from_slice(&config_text).map_err(|_| ASSETS)?;
    let device = Device::Cpu;
    // SAFETY: The mmap'd safetensors wrap the file for the lifetime of the model.
    let vb = unsafe {
        VarBuilder::from_mmaped_safetensors(&[Path::new(&weights_path)], DType::F32, &device)
            .map_err(|_| ASSETS)?
    };
    let model = DebertaV2SeqClassificationModel::load(vb.pp("deberta"), &config, None)
        .map_err(|_| LOAD)?;
    Ok(Box::new(Handle { model, device }))
}

fn logit(handle: &Handle, ids: Vec<u32>, mask: Vec<f32>) -> Result<f64, i32> {
    let seq = ids.len();
    let input_ids = Tensor::from_vec(ids, (1, seq), &handle.device).map_err(|_| FORWARD)?;
    let attention_mask =
        Tensor::from_vec(mask, (1, seq), &handle.device).map_err(|_| FORWARD)?;
    let logits = handle
        .model
        .forward(&input_ids, None, Some(attention_mask))
        .map_err(|_| FORWARD)?;
    if logits.elem_count() != 1 {
        return Err(FORWARD);
    }
    let value = logits
        .flatten_all().map_err(|_| FORWARD)?
        .squeeze(0).map_err(|_| FORWARD)?
        .to_scalar::<f32>().map_err(|_| FORWARD)?;
    if !value.is_finite() {
        return Err(NONFINITE);
    }
    Ok(value as f64)
}

/// Loads the model from `config_path` (config.json) and `weights_path`
/// (model.safetensors), storing a live handle in `*out`.
#[no_mangle]
pub unsafe extern "C" fn aih_candle_open(
    config_path: *const u8,
    config_len: usize,
    weights_path: *const u8,
    weights_len: usize,
    out: *mut *mut Handle,
) -> i32 {
    boundary(|| {
        if !aligned(out) {
            return Err(INVALID);
        }
        out.write(ptr::null_mut());
        let config_path = input_path(config_path, config_len)?;
        let weights_path = input_path(weights_path, weights_len)?;
        let handle = load(config_path, weights_path)?;
        out.write(Box::into_raw(handle));
        Ok(())
    })
}

/// Runs inference. `ids` are wrapped model tokens (CLS .. SEP), `mask` is the
/// per-token attention mask (0/1, same length as `ids`). Results match the
/// Core ML backend: masked positions never contribute, and position ids are
/// independent of the sequence length.
#[no_mangle]
pub unsafe extern "C" fn aih_candle_logit(
    handle: *const Handle,
    ids: *const u32,
    ids_len: usize,
    mask: *const f32,
    mask_len: usize,
    out: *mut f64,
) -> i32 {
    boundary(|| {
        let handle = model(handle)?;
        let ids = input_ids(ids, ids_len)?;
        let mask = input_mask(mask, mask_len, ids_len)?;
        let value = logit(handle, ids, mask)?;
        scalar(out, value)
    })
}

/// Frees a handle from `aih_candle_open`. A null handle is a no-op.
#[no_mangle]
pub unsafe extern "C" fn aih_candle_close(handle: *mut Handle) -> i32 {
    boundary(|| {
        if handle.is_null() {
            return Ok(());
        }
        if !aligned(handle) {
            return Err(INVALID);
        }
        drop(Box::from_raw(handle));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundary_maps_results_and_catches_panics() {
        assert_eq!(boundary(|| Ok(())), 0);
        assert_eq!(boundary(|| Err(ASSETS)), ASSETS);
        assert_eq!(boundary(|| panic!("test panic")), PANIC);
    }

    #[test]
    fn input_validation() {
        unsafe {
            let ids = [0u32, 1, 2];
            assert_eq!(input_ids(ids.as_ptr(), 0), Err(INVALID));
            assert_eq!(input_ids(ids.as_ptr(), MAX_SEQ + 1), Err(INVALID));
            assert_eq!(input_ids(ids.as_ptr(), 2).unwrap(), [0, 1]);
            let bad = [VOCAB];
            assert_eq!(input_ids(bad.as_ptr(), 1), Err(INVALID));
            let mask = [1.0f32, 0.0];
            assert_eq!(input_mask(mask.as_ptr(), 1, 2), Err(INVALID));
            let strange = [0.5f32];
            assert_eq!(input_mask(strange.as_ptr(), 1, 1), Err(INVALID));
            assert_eq!(input_mask(mask.as_ptr(), 2, 2).unwrap(), [1.0, 0.0]);
            let path = b"/nonexistent/config.json";
            assert_eq!(input_path(path.as_ptr(), 0), Err(INVALID));
        }
    }

    #[test]
    fn missing_assets_fail_with_assets_code() {
        unsafe {
            let mut out = ptr::null_mut();
            let a = b"/nonexistent/config.json";
            let b = b"/nonexistent/model.safetensors";
            assert_eq!(
                aih_candle_open(a.as_ptr(), a.len(), b.as_ptr(), b.len(), &mut out),
                ASSETS
            );
            assert!(out.is_null());
        }
    }

    #[test]
    fn real_model_from_explicit_environment() {
        let (Some(config), Some(weights)) = (
            std::env::var_os("DECKARD_CANDLE_CONFIG"),
            std::env::var_os("DECKARD_CANDLE_WEIGHTS"),
        ) else {
            return;
        };
        let config = config.to_str().expect("fixture path must be UTF-8");
        let weights = weights.to_str().expect("fixture path must be UTF-8");
        unsafe {
            let mut h = ptr::null_mut();
            assert_eq!(
                aih_candle_open(
                    config.as_ptr(),
                    config.len(),
                    weights.as_ptr(),
                    weights.len(),
                    &mut h
                ),
                0
            );
            let ids = Vec::from([1u32, 1, 2]);
            let mask = Vec::from([1.0f32; 3]);
            let mut value = -1.0f64;
            assert_eq!(
                aih_candle_logit(h, ids.as_ptr(), ids.len(), mask.as_ptr(), mask.len(), &mut value),
                0
            );
            assert!(value.is_finite());
            assert_eq!(aih_candle_close(h), 0);
        }
    }
}