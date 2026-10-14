// Accuracy of the Linux model backend: `deckard verify` must reproduce the
// PyTorch reference logits of the pinned fp32 checkpoint
// (fixtures/linux-reference.json, written by fixtures/linux_reference.py).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { modelAvailable } from "./model-fixture.mjs";

const binary = process.env.DECKARD_BIN || fileURLToPath(new URL("../build/dist/bin/deckard", import.meta.url));
const model = process.env.DECKARD_MODEL_DIR;
const runsModel = process.platform === "linux" && modelAvailable(model);
const referencePath = fileURLToPath(new URL("fixtures/linux-reference.json", import.meta.url));
const reference = JSON.parse(fs.readFileSync(referencePath));
const pins = JSON.parse(fs.readFileSync(new URL("../model-assets-linux.json", import.meta.url)));
const flagThreshold = 0.97;  // the host's default flag threshold
const sigmoid = value => 1 / (1 + Math.exp(-value));

function verify(t, fixtures) {
  const root = fs.mkdtempSync(fileURLToPath(new URL(".accuracy-", import.meta.url)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(binary, ["verify", "--model", model, "--fixtures", fixtures, "--cache-dir", path.join(root, "cache")],
    { encoding: "utf8", timeout: 600000 });
  return { status: child.status, stderr: child.stderr, result: child.stdout ? JSON.parse(child.stdout) : null };
}

test("the Linux reference fixtures belong to the pinned checkpoint and cover both decisions", () => {
  assert.deepEqual(
    [reference.source.model, reference.source.revision, reference.source.source_weights_sha256],
    [pins.model, pins.revision, pins.files["model.safetensors"]],
    "regenerate fixtures/linux-reference.json with linux_reference.py when the pin changes");
  assert.equal(reference.cases.length, 12);
  assert.equal(new Set(reference.cases.map(item => item.name)).size, reference.cases.length);
  for (const item of reference.cases) {
    const [ids] = item.feed.input_ids, [mask] = item.feed.attention_mask;
    assert.equal(item.feed.input_ids.length, 1, item.name);
    assert.ok(ids.length <= pins.sequence_length, item.name);
    assert.equal(ids[0], 1, `${item.name} starts with CLS`);
    assert.equal(ids.at(-1), 2, `${item.name} ends with SEP`);
    assert.deepEqual(mask, ids.map(id => Number(id !== 0)), item.name);
    assert.ok(Math.abs(item.score - sigmoid(item.logit)) < 1e-12, item.name);
  }
  const flagged = reference.cases.filter(item => item.score >= flagThreshold).length;
  assert.ok(flagged > 0 && flagged < reference.cases.length, "cases on both sides of the flag threshold");
});

test("Candle reproduces the PyTorch reference logits", { skip: !runsModel }, t => {
  const { status, stderr, result } = verify(t, referencePath);
  assert.equal(status, 0, stderr);
  assert.equal(result.status, "complete");
  assert.equal(result.runtime, "native-candle");
  assert.equal(result.fixtures_sha256, createHash("sha256").update(fs.readFileSync(referencePath)).digest("hex"));
  assert.deepEqual(result.cases.map(item => item.name), reference.cases.map(item => item.name));
  assert.ok(result.cases.every(item => item.same_default_decision));
  assert.ok(result.max_score_error <= 0.002, `max score error ${result.max_score_error}`);
  // fp32 on both sides: far closer than verify's score tolerance.
  assert.ok(result.max_logit_error <= 0.001, `max logit error ${result.max_logit_error}`);
});

test("verify fails when scores drift beyond the tolerance, even with the same decisions", { skip: !runsModel }, t => {
  // Shifting the shortest case's logit by 0.1 moves its score by about 0.009,
  // well below the flag threshold, so only the numerical screening can fail.
  const [first] = reference.cases;
  const drifted = { cases: [{ ...first, logit: first.logit + 0.1, score: sigmoid(first.logit + 0.1) }] };
  const fixtures = path.join(fs.mkdtempSync(fileURLToPath(new URL(".accuracy-", import.meta.url))), "drifted.json");
  t.after(() => fs.rmSync(path.dirname(fixtures), { recursive: true, force: true }));
  fs.writeFileSync(fixtures, JSON.stringify(drifted));
  const { status, stderr, result } = verify(t, fixtures);
  assert.equal(status, 1);
  assert.match(stderr, /fidelity_failed/);
  assert.equal(result.status, "failed");
  assert.equal(result.same_default_decisions, true);
  assert.ok(result.max_score_error > 0.002);
});
