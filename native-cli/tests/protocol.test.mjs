import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validResult } from "../../extension/native-queue.js";

const binary = process.env.DECKARD_BIN || fileURLToPath(new URL("../build/dist/bin/deckard", import.meta.url));
const C = globalThis.DeckardCore;
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
function frame(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function replies(buffer) {
  const result = [];
  for (let offset = 0; offset < buffer.length;) {
    assert.ok(offset + 4 <= buffer.length, "complete response prefix");
    const size = buffer.readUInt32LE(offset);
    offset += 4;
    assert.ok(size > 0 && size <= 131072 && offset + size <= buffer.length, "bounded complete response");
    result.push(JSON.parse(buffer.subarray(offset, offset + size).toString()));
    offset += size;
  }
  return result;
}
function fixture(t) {
  const root = fs.mkdtempSync(fileURLToPath(new URL("../build/protocol-", import.meta.url)));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.mkdirSync(path.join(root, "models"));
  fs.writeFileSync(path.join(root, "models/packed.safetensors"), "fixture");
  fs.writeFileSync(path.join(root, "models/tokenizer.json"), "fixture");
  fs.writeFileSync(path.join(root, "install.json"), JSON.stringify({
    format: 1, product: "Deckard", version: "0.5.0", model: C.MODEL, revision: C.MODEL_REVISION, policy: C.POLICY,
    flag_threshold: C.FLAG_THRESHOLD, experimental: true, extension_id: "a".repeat(32),
    weights_sha256: hash("fixture"), tokenizer_sha256: hash("fixture"),
  }));
  return root;
}
function run(home, input) {
  return spawnSync(binary, ["start", "--home", home], { input, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
}
test("native CLI help and pure native self-tests require no model", () => {
  for (const command of ["--help", "self-test"]) {
    const child = spawnSync(binary, [command], { encoding: "utf8", timeout: 15000 });
    assert.equal(child.status, 0, child.stderr);
  }
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15000 });
  assert.equal(version.status, 0, version.stderr);
  const packageVersion = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)))).version;
  const extensionVersion = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../extension/manifest.json", import.meta.url)))).version;
  assert.equal(version.stdout.trim(), packageVersion);
  assert.equal(version.stdout.trim(), extensionVersion);
});
test("real compiled native messaging matches the extension's validator without loading a model", t => {
  const home = fixture(t);
  const input = Buffer.concat([
    frame({ id: "ping", type: "ping", protocol_version: 3 }),
    frame({ id: "short", type: "analyze", protocol_version: 3, text: "private ".repeat(49).trim() }),
    frame({ id: "after", type: "ping", protocol_version: 3 }),
  ]);
  const child = run(home, input);
  assert.equal(child.status, 0, child.stderr.toString());
  const output = replies(child.stdout);
  assert.equal(output.length, 3);
  assert.ok(validResult("ping", output[0].result));
  assert.equal(output[0].result.min_words, 50);
  assert.ok(validResult("analyze", output[1].result));
  assert.equal(output[1].result.status, "skipped");
  assert.equal(output[1].result.words, 49);
  assert.equal(output[2].result.model_loaded, false);
  assert.ok(!child.stderr.includes("private"));
});
test("legacy extension requests fail closed, and valid later requests still work", t => {
  const child = run(fixture(t), Buffer.concat([
    frame({ id: "old", type: "ping" }),
    frame({ id: "bad", type: "analyze", protocol_version: 3, text: "x", extra: 1 }),
    frame({ id: "new", type: "ping", protocol_version: 3 }),
  ]));
  assert.equal(child.status, 0, child.stderr.toString());
  const output = replies(child.stdout);
  assert.equal(output[0].error.code, "extension_update_required");
  assert.equal(output[1].error.code, "invalid_request");
  assert.equal(output[2].ok, true);
});
test("invalid, oversized and truncated frames terminate with a framed error", t => {
  const home = fixture(t);
  const tooLarge = Buffer.alloc(4);
  tooLarge.writeUInt32LE(4 * 1024 * 1024 + 1);
  for (const input of [Buffer.from([1, 0]), tooLarge, frame(Buffer.from("{")), frame(Buffer.from([0xff]))]) {
    const child = run(home, input);
    assert.equal(child.status, 2, child.stderr.toString());
    assert.equal(replies(child.stdout)[0].ok, false);
  }
});
test("Unicode limits and missing assets produce explicit errors without page text", t => {
  const home = fixture(t);
  fs.unlinkSync(path.join(home, "models/packed.safetensors"));
  const child = run(home, Buffer.concat([
    frame({ id: "large", type: "analyze", protocol_version: 3, text: "x".repeat(20001) }),
    frame({ id: "missing", type: "ping", protocol_version: 3 }),
  ]));
  assert.equal(child.status, 0);
  const output = replies(child.stdout);
  assert.equal(output[0].error.code, "invalid_text");
  assert.equal(output[1].error.code, "missing_assets");
});
test("installed metadata integrity and CLI argument errors are checked", t => {
  const home = fixture(t);
  let child = spawnSync(binary, ["status", "--home", home], { encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  fs.appendFileSync(path.join(home, "models/packed.safetensors"), "changed");
  child = spawnSync(binary, ["status", "--home", home], { encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /asset_mismatch/);
  child = spawnSync(binary, ["start", "--download"], { encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 1);
});

test("context planning rejects malformed, excessive and legacy requests before loading assets", t => {
  const invalid = [null, {}, [], [""], [null], ["x".repeat(500001)], ["x ".repeat(25001)],
    Array(501).fill("word")];
  const child = run(fixture(t), Buffer.concat([
    ...invalid.map((texts, index) => frame({ id: `invalid-${index}`, type: "plan", protocol_version: 3, texts })),
    frame({ id: "old-helper", type: "plan", protocol_version: 2, texts: ["hello"] }),
  ]));
  const output = replies(child.stdout);
  assert.equal(child.status, 0);
  assert.equal(output.length, invalid.length + 1);
  assert.ok(output.slice(0, -1).every(reply => reply.error.code === "invalid_text"));
  assert.equal(output.at(-1).error.code, "extension_update_required");
});

test("native tokenizer plans exact full Unicode coverage and rebalances a short tail without loading weights",
  { skip: !process.env.DECKARD_MODEL_DIR }, t => {
    const home = fixture(t);
    const tokenizer = fs.readFileSync(path.join(process.env.DECKARD_MODEL_DIR, "tokenizer.json"));
    fs.writeFileSync(path.join(home, "models/tokenizer.json"), tokenizer);
    const config = JSON.parse(fs.readFileSync(path.join(home, "install.json")));
    config.tokenizer_sha256 = hash(tokenizer);
    fs.writeFileSync(path.join(home, "install.json"), JSON.stringify(config));
    const texts = ["alpha ".repeat(540).trim(), "café 🙂 naïve\n\n".repeat(200).trim(),
      "short ".repeat(49).trim(), "large ".repeat(3000).trim()];
    const child = run(home, Buffer.concat([
      frame({ id: "plan", type: "plan", protocol_version: 3, texts }),
      frame({ id: "ping", type: "ping", protocol_version: 3 }),
    ]));
    assert.equal(child.status, 0, child.stderr);
    const output = replies(child.stdout);
    assert.equal(output[0].ok, true);
    assert.equal(C.validPlan(output[0].result, texts), true);
    const groups = output[0].result.groups;
    assert.deepEqual(groups[0].map(span => span.end_word - span.start_word), [270, 270]);
    assert.ok(groups[0].every(span => span.complete && span.tokens <= 510));
    assert.ok(groups[1].every(span => span.complete && span.tokens <= 510));
    assert.equal(groups[2][0].complete, false);
    assert.ok(groups[3].length > 4, "no four-window document cap");
    assert.equal(output[1].result.model_loaded, false);
  });
