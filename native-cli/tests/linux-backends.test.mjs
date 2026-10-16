// Linux runtime selection: Candle, ONNX Runtime, and the Auto fallback between
// them (gradient_backend.cpp). Model-dependent cases need DECKARD_MODEL_DIR
// with the pinned files; the ONNX cases also need its pinned model.onnx.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assets, modelAvailable } from "./model-fixture.mjs";

const linux = process.platform === "linux";
const binary = process.env.DECKARD_BIN || fileURLToPath(new URL("../build/dist/bin/deckard", import.meta.url));
const model = process.env.DECKARD_MODEL_DIR;
const onnxModel = !!model && fs.existsSync(path.join(model, "model.onnx"));
const linuxManifest = fs.readFileSync(new URL("../model-assets-linux.json", import.meta.url));
const onnxAssets = JSON.parse(fs.readFileSync(new URL("../model-assets-onnx.json", import.meta.url)));
const run = (args, options = {}) => spawnSync(binary, args, { encoding: "utf8", timeout: 600000, ...options });

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckard-backends-"));
  t.after(() => {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

// A model directory of hard links to the real pinned files (links would be refused).
function modelCopy(root, { onnx = true } = {}) {
  const directory = path.join(root, "model");
  fs.mkdirSync(directory);
  const names = [...Object.keys(assets.files), ...(onnx ? Object.keys(onnxAssets.files) : [])];
  for (const name of names) fs.linkSync(path.join(model, name), path.join(directory, name));
  return directory;
}

// Reference fixtures from Candle, which runs the Hugging Face checkpoint itself.
function candleFixtures(root, directory) {
  const ids = [1, ...Array.from({ length: 62 }, (_, i) => 3 + i * 37), 2];
  const draft = path.join(root, "draft.json");
  fs.writeFileSync(draft, JSON.stringify({ cases: [{ name: "len64", logit: 0,
    feed: { input_ids: [ids], attention_mask: [ids.map(() => 1)] } }] }));
  const result = run(["verify", "--model", directory, "--fixtures", draft, "--candle", "--cache-dir", path.join(root, "cache")]);
  const logit = JSON.parse(result.stdout).cases[0].logit;
  const fixtures = path.join(root, "fixtures.json");
  fs.writeFileSync(fixtures, JSON.stringify({ cases: [{ name: "len64", logit,
    feed: { input_ids: [ids], attention_mask: [ids.map(() => 1)] } }] }));
  return fixtures;
}

test("--onnx and --candle are mutually exclusive", { skip: !linux && "Linux only" }, () => {
  const result = run(["scan", "--onnx", "--candle", "--file", "-"], { input: "text" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Choose either --onnx or --candle/);
});

test("model.onnx is pinned for the same checkpoint, apart from the Linux manifest", () => {
  const linuxAssets = JSON.parse(linuxManifest);
  assert.deepEqual([onnxAssets.model, onnxAssets.revision], [linuxAssets.model, linuxAssets.revision]);
  assert.match(onnxAssets.files["model.onnx"], /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(linuxAssets).includes("model.onnx"));
});

test("model-assets-linux.json keeps the identity that existing installations record", () => {
  // install.json records this SHA-256; changing the file makes deckard refuse
  // to upgrade or uninstall every earlier Linux installation.
  assert.equal(createHash("sha256").update(linuxManifest).digest("hex"),
    "e657b13eee35001a767ccc61c7c3d8df235c2769fe3f364c047ab379fed4281e");
});

test("ONNX Runtime reproduces the Candle reference and Auto prefers it",
  { skip: (!linux && "Linux only") || (!onnxModel && "needs DECKARD_MODEL_DIR with model.onnx") }, t => {
    const root = scratch(t);
    const directory = modelCopy(root);
    const fixtures = candleFixtures(root, directory);
    for (const flags of [["--onnx"], []]) {
      const result = run(["verify", "--model", directory, "--fixtures", fixtures, ...flags,
        "--cache-dir", path.join(root, "cache")]);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.runtime, "native-onnx");
      assert.equal(report.status, "complete");
      assert.ok(report.max_score_error <= 0.002);
    }
  });

test("Auto falls back to Candle when ONNX Runtime cannot start; --onnx does not",
  { skip: (!linux && "Linux only") || (!onnxModel && "needs DECKARD_MODEL_DIR with model.onnx") }, t => {
    const root = scratch(t);
    const directory = modelCopy(root);
    const fixtures = candleFixtures(root, directory);
    const readOnly = path.join(root, "read-only-cache");
    fs.mkdirSync(readOnly, { mode: 0o500 });
    let result = run(["verify", "--model", directory, "--fixtures", fixtures, "--cache-dir", readOnly]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /onnx_fallback \(onnx_unavailable\)/);
    assert.equal(JSON.parse(result.stdout).runtime, "native-candle");
    result = run(["verify", "--model", directory, "--fixtures", fixtures, "--onnx", "--cache-dir", readOnly]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /onnx_unavailable/);
  });

test("a tampered model.onnx is an integrity error, never a silent fallback",
  { skip: (!linux && "Linux only") || (!modelAvailable(model) && "needs DECKARD_MODEL_DIR") }, t => {
    const root = scratch(t);
    const directory = modelCopy(root, { onnx: false });
    fs.writeFileSync(path.join(directory, "model.onnx"), "tampered");
    const fixtures = path.join(root, "fixtures.json");
    fs.writeFileSync(fixtures, JSON.stringify({ cases: [{ name: "x", logit: 0,
      feed: { input_ids: [[1, 5, 2]], attention_mask: [[1, 1, 1]] } }] }));
    const result = run(["verify", "--model", directory, "--fixtures", fixtures, "--cache-dir", path.join(root, "cache")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /asset_mismatch/);
    assert.doesNotMatch(result.stderr, /onnx_fallback/);
  });

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function replies(buffer) {
  const result = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const size = buffer.readUInt32LE(offset);
    result.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + size)));
    offset += 4 + size;
  }
  return result;
}

test("the host's ping names the runtime that scored, ONNX Runtime once it has",
  { skip: (!linux && "Linux only") || (!onnxModel && "needs DECKARD_MODEL_DIR with model.onnx") }, t => {
    const root = scratch(t);
    const home = path.join(root, "prefix");
    const installed = run(["install", "--home", home, "--manifest-dir", path.join(root, "manifests"),
      "--model-dir", modelCopy(root), "--no-extension", "--shell", "none"], { env: { ...process.env, HOME: root } });
    assert.equal(installed.status, 0, installed.stderr);
    const text = "The committee met on Tuesday to review the budget for the coming year. After a long " +
      "discussion about road repairs, the library roof and the new playground, members agreed to " +
      "postpone the vote until residents could comment at the next public meeting. Several people " +
      "asked for the draft to be posted online beforehand, and the chair promised to do so by Friday.";
    const host = spawnSync(path.join(home, "current/bin/deckard"), ["start", "--home", path.join(home, "current")], {
      input: Buffer.concat([
        frame({ id: "before", type: "ping", protocol_version: 3 }),
        frame({ id: "analyze", type: "analyze", protocol_version: 3, text }),
        frame({ id: "after", type: "ping", protocol_version: 3 }),
      ]),
      timeout: 600000, env: { ...process.env, HOME: root },
    });
    assert.equal(host.status, 0, host.stderr.toString());
    const [before, analyze, after] = replies(host.stdout);
    // Before the first analysis no runtime has started: the platform default.
    assert.deepEqual([before.result.model_loaded, before.result.runtime], [false, "native-candle"]);
    assert.equal(analyze.ok, true, JSON.stringify(analyze));
    assert.deepEqual([after.result.model_loaded, after.result.runtime], [true, "native-onnx"]);
  });

test("installing with and without model.onnx switches the active release",
  { skip: (!linux && "Linux only") || (!onnxModel && "needs DECKARD_MODEL_DIR with model.onnx") }, t => {
    // The documented order: install, export model.onnx, install again. The
    // second install must not reuse the release without model.onnx.
    const root = scratch(t);
    const home = path.join(root, "prefix");
    const directory = modelCopy(root, { onnx: false });
    const install = () => {
      const result = run(["install", "--home", home, "--manifest-dir", path.join(root, "manifests"),
        "--model-dir", directory, "--no-extension", "--shell", "none"], { env: { ...process.env, HOME: root } });
      assert.equal(result.status, 0, result.stderr);
      const current = fs.readlinkSync(path.join(home, "current"));
      return { current, onnx: fs.existsSync(path.join(home, current, "models/model.onnx")) };
    };
    const candle = install();
    assert.equal(candle.onnx, false);
    fs.linkSync(path.join(model, "model.onnx"), path.join(directory, "model.onnx"));
    const onnx = install();
    assert.notEqual(onnx.current, candle.current);
    assert.equal(onnx.onnx, true);
    const config = JSON.parse(fs.readFileSync(path.join(home, onnx.current, "install.json")));
    assert.deepEqual(config.optional_model_files, onnxAssets.files);
    // Without model.onnx again: back to the release without it.
    fs.rmSync(path.join(directory, "model.onnx"));
    assert.deepEqual(install(), candle);
  });

test("export-onnx.sh leaves a pinned model.onnx alone",
  { skip: (!linux && "Linux only") || (!onnxModel && "needs DECKARD_MODEL_DIR with model.onnx") }, t => {
    // Reads the real pins: an already pinned model.onnx needs no Python, venv,
    // download or new file.
    const root = scratch(t);
    const directory = modelCopy(root);
    const before = fs.statSync(path.join(directory, "model.onnx"));
    const script = fileURLToPath(new URL("../../scripts/export-onnx.sh", import.meta.url));
    const result = spawnSync(script, [directory], { encoding: "utf8",
      env: { ...process.env, PYTHON: "deckard-no-such-python" } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /is already the pinned model\.onnx\./);
    const after = fs.statSync(path.join(directory, "model.onnx"));
    assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs]);
    assert.deepEqual(fs.readdirSync(directory).sort(), [...Object.keys(assets.files), "model.onnx"].sort());
  });

test("install names a model.onnx of another pin and how to fix it",
  { skip: (!linux && "Linux only") || (!modelAvailable(model) && "needs DECKARD_MODEL_DIR") }, t => {
    // After a pin change the cache still holds the old export.
    const root = scratch(t);
    const home = path.join(root, "prefix");
    const directory = modelCopy(root, { onnx: false });
    fs.writeFileSync(path.join(directory, "model.onnx"), "model.onnx of an earlier pin");
    const result = run(["install", "--home", home, "--manifest-dir", path.join(root, "manifests"),
      "--model-dir", directory, "--no-extension", "--shell", "none"], { env: { ...process.env, HOME: root } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /model\.onnx in .*\/model does not match its pin\. Export it again \(scripts\/export-onnx\.sh\), or delete it to use Candle\./);
    assert.equal(fs.existsSync(path.join(home, "current")), false);
  });
