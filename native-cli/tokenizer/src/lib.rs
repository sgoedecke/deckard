//! Local-file-only tokenizer C ABI. No network features or scripting runtime.
//!
//! All calls return a status: 0 success, 1 invalid argument, 2 invalid UTF-8,
//! 3 tokenizer failure, 4 unsupported special-token layout, 5 size limit,
//! 6 caught panic. Errors never include input text or filesystem paths.
//!
//! Safety contract: non-null pointers must be aligned, live allocations of the
//! declared length/type. Output descriptors must be writable, own no live buffer,
//! and not alias input.
//! Handles must come from open, remain live throughout each call, and must not
//! be freed concurrently. Buffers must only be released by the matching free
//! function, using their original descriptor exactly once. Null/zero input is
//! empty; null/nonzero is invalid. Empty output is always null/zero.

use std::mem::{align_of, size_of};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Once;
use std::{ptr, slice, str};
use tokenizers::{Encoding, Token, Tokenizer};

const INVALID: i32 = 1;
const UTF8: i32 = 2;
const TOKENIZER: i32 = 3;
const LAYOUT: i32 = 4;
const LIMIT: i32 = 5;
const PANIC: i32 = 6;
const MAX_TEXT: usize = 16 * 1024 * 1024;
const MAX_IDS: usize = 1024 * 1024;
const MAX_PATH: usize = 32 * 1024;
const CAPACITY: usize = 510;
const CLS: u32 = 1;
const SEP: u32 = 2;

pub struct Handle {
    tokenizer: Tokenizer,
}

#[repr(C)]
pub struct Ids {
    pub data: *mut u32,
    pub len: usize,
}

#[repr(C)]
pub struct Bytes {
    pub data: *mut u8,
    pub len: usize,
}

fn boundary(f: impl FnOnce() -> Result<(), i32>) -> i32 {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        tokenizers::utils::parallelism::set_parallelism(false);
        // The default panic hook can print tokenizer input before unwind is caught.
        std::panic::set_hook(Box::new(|_| eprintln!("AI Hider: tokenizer_panic")));
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

#[test]
fn ffi_initialization_disables_parallel_tokenization() {
    assert_eq!(boundary(|| Ok(())), 0);
    assert!(!tokenizers::utils::parallelism::get_parallelism());
}

fn aligned<T>(p: *const T) -> bool {
    !p.is_null() && (p as usize) % align_of::<T>() == 0
}

unsafe fn input<'a, T>(p: *const T, len: usize, max: usize) -> Result<&'a [T], i32> {
    if len > max || len > isize::MAX as usize / size_of::<T>() {
        return Err(LIMIT);
    }
    if len == 0 {
        return Ok(&[]);
    }
    if !aligned(p) {
        return Err(INVALID);
    }
    Ok(slice::from_raw_parts(p, len))
}

unsafe fn handle<'a>(p: *const Handle) -> Result<&'a Handle, i32> {
    if !aligned(p) {
        return Err(INVALID);
    }
    Ok(&*p)
}

unsafe fn reset_ids<'a>(out: *mut Ids) -> Result<&'a mut Ids, i32> {
    if !aligned(out) {
        return Err(INVALID);
    }
    out.write(Ids { data: ptr::null_mut(), len: 0 });
    Ok(&mut *out)
}

unsafe fn reset_bytes<'a>(out: *mut Bytes) -> Result<&'a mut Bytes, i32> {
    if !aligned(out) {
        return Err(INVALID);
    }
    out.write(Bytes { data: ptr::null_mut(), len: 0 });
    Ok(&mut *out)
}

fn export<T>(values: Vec<T>) -> (*mut T, usize) {
    if values.is_empty() {
        return (ptr::null_mut(), 0);
    }
    let values = values.into_boxed_slice();
    let len = values.len();
    (Box::into_raw(values) as *mut T, len)
}

fn validate_ids(tokenizer: &Tokenizer, ids: &[u32]) -> Result<(), i32> {
    // decode otherwise silently drops unknown IDs.
    if ids.iter().any(|&id| tokenizer.id_to_token(id).is_none()) {
        return Err(INVALID);
    }
    Ok(())
}

fn wrapped(tokenizer: &Tokenizer, ids: &[u32]) -> Result<Vec<u32>, i32> {
    let tokens = ids.iter().map(|&id| {
        tokenizer.id_to_token(id).map(|value| Token::new(id, value, (0, 0)))
            .ok_or(INVALID)
    }).collect::<Result<Vec<_>, _>>()?;
    let encoding = tokenizer.post_process(Encoding::from_tokens(tokens, 0), None, true)
        .map_err(|_| TOKENIZER)?;
    let result = encoding.get_ids();
    if result.len() != ids.len() + 2
        || result.first() != Some(&CLS)
        || result.last() != Some(&SEP)
        || &result[1..result.len() - 1] != ids
        || !encoding.get_overflowing().is_empty()
    {
        return Err(LAYOUT);
    }
    Ok(result.to_vec())
}

fn prepare(mut tokenizer: Tokenizer) -> Result<Handle, i32> {
    tokenizer.with_truncation(None).map_err(|_| TOKENIZER)?;
    tokenizer.with_padding(None);
    let added = tokenizer.get_added_tokens_decoder();
    for (text, id) in [("[CLS]", CLS), ("[SEP]", SEP)] {
        if tokenizer.token_to_id(text) != Some(id)
            || tokenizer.id_to_token(id).as_deref() != Some(text)
            || !added.get(&id).is_some_and(|token| token.special && token.content == text)
        {
            return Err(LAYOUT);
        }
    }
    if tokenizer.get_post_processor().is_none() {
        return Err(LAYOUT);
    }
    // Exercise both the empty case and actual content through the JSON processor.
    wrapped(&tokenizer, &[])?;
    let probe = tokenizer.encode("Tokenizer layout verification.", false).map_err(|_| TOKENIZER)?;
    wrapped(&tokenizer, probe.get_ids())?;
    Ok(Handle { tokenizer })
}

#[no_mangle]
pub unsafe extern "C" fn aih_tokenizer_open(
    path: *const u8, len: usize, out: *mut *mut Handle,
) -> i32 {
    boundary(|| {
        if !aligned(out) {
            return Err(INVALID);
        }
        out.write(ptr::null_mut());
        let path = input(path, len, MAX_PATH)?;
        if path.is_empty() || path.contains(&0) {
            return Err(INVALID);
        }
        let path = str::from_utf8(path).map_err(|_| UTF8)?;
        let tokenizer = Tokenizer::from_file(path).map_err(|_| TOKENIZER)?;
        out.write(Box::into_raw(Box::new(prepare(tokenizer)?)));
        Ok(())
    })
}

#[no_mangle]
pub unsafe extern "C" fn aih_tokenizer_encode(
    tokenizer: *const Handle, text: *const u8, len: usize, out: *mut Ids,
) -> i32 {
    boundary(|| {
        let out = reset_ids(out)?;
        let tokenizer = &handle(tokenizer)?.tokenizer;
        let text = str::from_utf8(input(text, len, MAX_TEXT)?).map_err(|_| UTF8)?;
        let encoding = tokenizer.encode(text, false).map_err(|_| TOKENIZER)?;
        if encoding.len() > MAX_IDS {
            return Err(LIMIT);
        }
        (out.data, out.len) = export(encoding.get_ids().to_vec());
        Ok(())
    })
}

#[no_mangle]
pub unsafe extern "C" fn aih_tokenizer_decode(
    tokenizer: *const Handle, ids: *const u32, len: usize, out: *mut Bytes,
) -> i32 {
    boundary(|| {
        let out = reset_bytes(out)?;
        let tokenizer = &handle(tokenizer)?.tokenizer;
        let ids = input(ids, len, MAX_IDS)?;
        validate_ids(tokenizer, ids)?;
        let text = tokenizer.decode(ids, true).map_err(|_| TOKENIZER)?;
        if text.len() > MAX_TEXT {
            return Err(LIMIT);
        }
        (out.data, out.len) = export(text.into_bytes());
        Ok(())
    })
}

#[no_mangle]
pub unsafe extern "C" fn aih_tokenizer_wrap(
    tokenizer: *const Handle, ids: *const u32, len: usize, out: *mut Ids,
) -> i32 {
    boundary(|| {
        let out = reset_ids(out)?;
        let tokenizer = &handle(tokenizer)?.tokenizer;
        let ids = input(ids, len, CAPACITY)?;
        (out.data, out.len) = export(wrapped(tokenizer, ids)?);
        Ok(())
    })
}

#[no_mangle]
pub unsafe extern "C" fn aih_tokenizer_close(tokenizer: *mut Handle) -> i32 {
    boundary(|| {
        if !tokenizer.is_null() {
            if !aligned(tokenizer) {
                return Err(INVALID);
            }
            drop(Box::from_raw(tokenizer));
        }
        Ok(())
    })
}

unsafe fn release<T>(data: *mut T, len: usize) -> Result<(), i32> {
    if len == 0 {
        return if data.is_null() { Ok(()) } else { Err(INVALID) };
    }
    if !aligned(data) || len > isize::MAX as usize / size_of::<T>() {
        return Err(INVALID);
    }
    drop(Box::from_raw(ptr::slice_from_raw_parts_mut(data, len)));
    Ok(())
}

#[no_mangle]
pub unsafe extern "C" fn aih_tokenizer_free_ids(out: *mut Ids) -> i32 {
    boundary(|| {
        if !aligned(out) {
            return Err(INVALID);
        }
        let Ids { data, len } = out.read();
        out.write(Ids { data: ptr::null_mut(), len: 0 });
        release(data, len)
    })
}

#[no_mangle]
pub unsafe extern "C" fn aih_tokenizer_free_bytes(out: *mut Bytes) -> i32 {
    boundary(|| {
        if !aligned(out) {
            return Err(INVALID);
        }
        let Bytes { data, len } = out.read();
        out.write(Bytes { data: ptr::null_mut(), len: 0 });
        release(data, len)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Handle {
        use tokenizers::models::wordlevel::WordLevel;
        use tokenizers::processors::template::TemplateProcessing;
        use tokenizers::AddedToken;
        let vocab = [("[UNK]", 0), ("[CLS]", 1), ("[SEP]", 2), ("hello", 3)]
            .into_iter().map(|(s, id)| (s.to_owned(), id)).collect();
        let model = WordLevel::builder().vocab(vocab).unk_token("[UNK]".into()).build().unwrap();
        let mut tokenizer = Tokenizer::new(model);
        tokenizer.add_special_tokens(&[
            AddedToken::from("[CLS]", true), AddedToken::from("[SEP]", true),
        ]);
        tokenizer.with_post_processor(Some(TemplateProcessing::builder()
            .try_single("[CLS] $A [SEP]").unwrap()
            .special_tokens(vec![("[CLS]", 1), ("[SEP]", 2)]).build().unwrap()));
        prepare(tokenizer).unwrap()
    }

    #[test]
    fn owned_buffers_and_empty_input() {
        let h = fixture();
        unsafe {
            let mut ids = Ids { data: ptr::null_mut(), len: 0 };
            assert_eq!(aih_tokenizer_encode(&h, b"hello".as_ptr(), 5, &mut ids), 0);
            assert_eq!(slice::from_raw_parts(ids.data, ids.len), &[3]);
            let mut bytes = Bytes { data: ptr::null_mut(), len: 0 };
            assert_eq!(aih_tokenizer_decode(&h, ids.data, ids.len, &mut bytes), 0);
            assert_eq!(slice::from_raw_parts(bytes.data, bytes.len), b"hello");
            assert_eq!(aih_tokenizer_free_bytes(&mut bytes), 0);
            assert!(bytes.data.is_null() && bytes.len == 0);
            assert_eq!(aih_tokenizer_free_bytes(&mut bytes), 0);
            assert_eq!(aih_tokenizer_free_ids(&mut ids), 0);
            assert_eq!(aih_tokenizer_encode(&h, ptr::null(), 0, &mut ids), 0);
            assert!(ids.data.is_null() && ids.len == 0);
            assert_eq!(aih_tokenizer_decode(&h, ptr::null(), 0, &mut bytes), 0);
            assert!(bytes.data.is_null() && bytes.len == 0);
            assert_eq!(aih_tokenizer_wrap(&h, ptr::null(), 0, &mut ids), 0);
            assert_eq!(slice::from_raw_parts(ids.data, ids.len), &[1, 2]);
            assert_eq!(aih_tokenizer_decode(&h, ids.data, ids.len, &mut bytes), 0);
            assert_eq!(bytes.len, 0);
            assert_eq!(aih_tokenizer_free_ids(&mut ids), 0);
            assert_eq!(aih_tokenizer_free_ids(&mut ids), 0);
            assert_eq!(aih_tokenizer_close(Box::into_raw(Box::new(fixture()))), 0);
            assert_eq!(aih_tokenizer_close(ptr::null_mut()), 0);
        }
    }

    #[test]
    fn invalid_arguments_are_explicit_and_outputs_are_empty() {
        let h = fixture();
        unsafe {
            let mut ids = Ids { data: ptr::null_mut(), len: 99 };
            let mut bytes = Bytes { data: ptr::null_mut(), len: 99 };
            assert_eq!(aih_tokenizer_encode(&h, [0xff].as_ptr(), 1, &mut ids), UTF8);
            assert!(ids.data.is_null() && ids.len == 0);
            assert_eq!(aih_tokenizer_encode(&h, ptr::null(), 1, &mut ids), INVALID);
            assert_eq!(aih_tokenizer_encode(&h, ptr::null(), MAX_TEXT + 1, &mut ids), LIMIT);
            assert_eq!(aih_tokenizer_encode(ptr::null(), ptr::null(), 0, &mut ids), INVALID);
            assert_eq!(aih_tokenizer_encode(&h, ptr::null(), 0, ptr::null_mut()), INVALID);
            assert_eq!(aih_tokenizer_decode(&h, [u32::MAX].as_ptr(), 1, &mut bytes), INVALID);
            assert!(bytes.data.is_null() && bytes.len == 0);
            assert_eq!(aih_tokenizer_decode(&h, ptr::null(), 1, &mut bytes), INVALID);
            assert_eq!(aih_tokenizer_wrap(&h, ptr::null(), CAPACITY + 1, &mut ids), LIMIT);
            assert_eq!(aih_tokenizer_free_ids(ptr::null_mut()), INVALID);
            let mut opened = ptr::null_mut();
            assert_eq!(aih_tokenizer_open(ptr::null(), 0, &mut opened), INVALID);
            assert_eq!(aih_tokenizer_open([0xff].as_ptr(), 1, &mut opened), UTF8);
            assert_eq!(aih_tokenizer_open(b"bad\0path".as_ptr(), 8, &mut opened), INVALID);
            assert_eq!(aih_tokenizer_open(b".".as_ptr(), 1, &mut opened), TOKENIZER);
            assert_eq!(aih_tokenizer_open(b"".as_ptr(), 0, ptr::null_mut()), INVALID);
            assert!(opened.is_null());
        }
        assert_eq!(boundary(|| panic!("test panic")), PANIC);
    }

    #[test]
    fn layout_and_capacity_are_checked() {
        let h = fixture();
        assert_eq!(wrapped(&h.tokenizer, &[3]).unwrap(), [1, 3, 2]);
        let mut wrong = h.tokenizer.clone();
        wrong.with_post_processor(None::<tokenizers::processors::PostProcessorWrapper>);
        assert!(matches!(prepare(wrong), Err(LAYOUT)));
        let mut configured = h.tokenizer.clone();
        configured.with_truncation(Some(tokenizers::utils::truncation::TruncationParams {
            max_length: 3, ..Default::default()
        })).unwrap();
        configured.with_padding(Some(tokenizers::utils::padding::PaddingParams::default()));
        let configured = prepare(configured).unwrap();
        assert!(configured.tokenizer.get_truncation().is_none());
        assert!(configured.tokenizer.get_padding().is_none());
        unsafe {
            let input = vec![3; CAPACITY];
            let mut ids = Ids { data: ptr::null_mut(), len: 0 };
            assert_eq!(aih_tokenizer_wrap(&h, input.as_ptr(), input.len(), &mut ids), 0);
            assert_eq!(ids.len, 512);
            assert_eq!(aih_tokenizer_free_ids(&mut ids), 0);
        }
    }

    #[test]
    fn real_tokenizer_from_explicit_environment() {
        let Some(path) = std::env::var_os("AI_HIDER_TOKENIZER_JSON") else { return };
        let path = path.to_str().expect("fixture path must be UTF-8");
        unsafe {
            let mut h = ptr::null_mut();
            assert_eq!(aih_tokenizer_open(path.as_ptr(), path.len(), &mut h), 0);
            let text = "  Hello   world! Café\n";
            let mut ids = Ids { data: ptr::null_mut(), len: 0 };
            assert_eq!(aih_tokenizer_encode(h, text.as_ptr(), text.len(), &mut ids), 0);
            let raw = slice::from_raw_parts(ids.data, ids.len).to_vec();
            let mut wrapped_ids = Ids { data: ptr::null_mut(), len: 0 };
            assert_eq!(aih_tokenizer_wrap(h, ids.data, ids.len, &mut wrapped_ids), 0);
            let wrapped = slice::from_raw_parts(wrapped_ids.data, wrapped_ids.len);
            assert_eq!(&wrapped[1..wrapped.len() - 1], raw);
            assert_eq!(wrapped.first(), Some(&1));
            assert_eq!(wrapped.last(), Some(&2));
            let mut decoded = Bytes { data: ptr::null_mut(), len: 0 };
            assert_eq!(aih_tokenizer_decode(h, wrapped_ids.data, wrapped_ids.len, &mut decoded), 0);
            let result = str::from_utf8(slice::from_raw_parts(decoded.data, decoded.len)).unwrap();
            assert_eq!(result, "Hello world! Café");
            assert_eq!(aih_tokenizer_free_bytes(&mut decoded), 0);
            assert_eq!(aih_tokenizer_free_ids(&mut wrapped_ids), 0);
            assert_eq!(aih_tokenizer_free_ids(&mut ids), 0);
            assert_eq!(aih_tokenizer_close(h), 0);
        }
    }

    #[test]
    fn explicit_tokenizer_fixtures_have_identical_behavior() {
        let (Some(first), Some(second)) = (
            std::env::var_os("AI_HIDER_TOKENIZER_JSON"),
            std::env::var_os("AI_HIDER_TOKENIZER_COMPARE_JSON"),
        ) else { return };
        let first = prepare(Tokenizer::from_file(first).unwrap()).unwrap();
        let second = prepare(Tokenizer::from_file(second).unwrap()).unwrap();
        let long = "hello ".repeat(900);
        let texts = [
            "", " ", "Hello, world!", "  Hello   world! Café\n",
            "Cafe\u{301} ＡＢＣ ① ﬁ", "中文 日本語 한국어", "👋🏽 🧑‍💻 ❤️",
            "a\tb\r\nc\u{a0}d\u{200b}e", "[CLS] hello [SEP] [PAD] [MASK]",
            "a\0b", "e-mail user@example.com 12.345", &long,
        ];
        unsafe {
            for text in texts {
                let mut results = Vec::new();
                for h in [&first, &second] {
                    let mut ids = Ids { data: ptr::null_mut(), len: 0 };
                    assert_eq!(aih_tokenizer_encode(h, text.as_ptr(), text.len(), &mut ids), 0);
                    let tokens = input(ids.data, ids.len, MAX_IDS).unwrap().to_vec();
                    let mut bytes = Bytes { data: ptr::null_mut(), len: 0 };
                    assert_eq!(aih_tokenizer_decode(h, ids.data, ids.len, &mut bytes), 0);
                    let decoded = input(bytes.data, bytes.len, MAX_TEXT).unwrap().to_vec();
                    assert_eq!(aih_tokenizer_free_bytes(&mut bytes), 0);
                    let mut wrapped = Ids { data: ptr::null_mut(), len: 0 };
                    let status = aih_tokenizer_wrap(h, ids.data, ids.len, &mut wrapped);
                    let wrapped_tokens = if tokens.len() <= CAPACITY {
                        assert_eq!(status, 0);
                        input(wrapped.data, wrapped.len, CAPACITY + 2).unwrap().to_vec()
                    } else {
                        assert_eq!(status, LIMIT);
                        Vec::new()
                    };
                    assert_eq!(aih_tokenizer_free_ids(&mut wrapped), 0);
                    assert_eq!(aih_tokenizer_free_ids(&mut ids), 0);
                    results.push((tokens, decoded, wrapped_tokens));
                }
                assert_eq!(results[0], results[1]);
                if text == long {
                    assert!(results[0].0.len() > CAPACITY);
                }
            }
        }
    }
}
