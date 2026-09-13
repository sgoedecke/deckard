import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const binary = path.join(root, "cache/coreml/bin/deckard-coreml");
const work = path.join(root, "cache/coreml/tests", randomUUID());
const manifest = {
  format: "deckard-coreml-split-v1",
  sequence_length: 4,
  model: "ShantanuT01/gradient-ai-text-detector",
  revision: "c2e8b6df87f8a211cbffb713fa9873a0c3a9713f",
  source_sha256: "85a9e02ebdcbbe1dd84cdbf893b708e44ee4691cadc7e1a4780039e22097ac98",
  layers: 24,
};
const validInput = { input_ids: [0, 128099, 2], attention_mask: [1, 0, 1] };

describe("experimental native Core ML runner (no inference)", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, () => {
  before(() => {
    const build = spawnSync("bash", ["native-cli/coreml/build.sh"], {
      cwd: root, encoding: "utf8", timeout: 120_000,
    });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    mkdirSync(work, { recursive: true });
  });

  after(() => rmSync(work, { recursive: true, force: true }));

  function fixture(input = validInput, metadata = manifest) {
    const directory = path.join(work, randomUUID());
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(metadata));
    writeFileSync(path.join(directory, "input.json"), JSON.stringify(input));
    return directory;
  }

  function reject(directory, pattern, args = [directory, path.join(directory, "input.json")]) {
    const result = spawnSync(binary, args, { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.equal(result.signal, null, "runner should report an error, not crash");
    assert.equal(result.stdout, "", "errors must not emit a result");
    assert.match(result.stderr, pattern);
  }

  it("reports usage with a nonzero exit", () => {
    reject(work, /Usage:.*<bundle-directory> <input.json>/, []);
    reject(work, /Usage:/, ["--gpu"]);
    reject(work, /Usage:/, ["bundle", "input", "--gpu"]);
  });

  it("rejects invalid profiler settings without loading a model", () => {
    for (const [length, units, scheduling] of [
      ["0", "cpu", "default"], ["513", "cpu-ane", "background"],
      ["512", "gpu", "default"], ["512", "cpu", "invalid"],
    ]) {
      reject(work, /Profile requires/, ["missing.mlpackage", length, "--profile-layer", units, scheduling]);
    }
    reject(work, /Profile repeats/, ["missing.mlpackage", "512", "--profile-layer", "cpu", "default", "0"]);
  });

  it("reports missing manifest and missing input files", () => {
    reject(work, /manifest\.json/);
    const directory = fixture();
    rmSync(path.join(directory, "input.json"));
    reject(directory, /input\.json/);
  });

  for (const [name, contents] of [
    ["malformed JSON", "{"],
    ["array root", "[]"],
    ["null root", "null"],
  ]) {
    it(`rejects ${name}`, () => {
      const directory = fixture();
      writeFileSync(path.join(directory, "input.json"), contents);
      reject(directory, /JSON object/);
    });
  }

  for (const [name, metadata] of [
    ["missing manifest fields", {}],
    ["wrong format", { ...manifest, format: "other" }],
    ["wrong model", { ...manifest, model: "other" }],
    ["wrong revision", { ...manifest, revision: "main" }],
    ["wrong layers", { ...manifest, layers: 23 }],
    ["noninteger layers", { ...manifest, layers: 24.5 }],
    ["zero length", { ...manifest, sequence_length: 0 }],
    ["excess length", { ...manifest, sequence_length: 513 }],
    ["fractional length", { ...manifest, sequence_length: 1.5 }],
    ["boolean length", { ...manifest, sequence_length: true }],
    ["string length", { ...manifest, sequence_length: "4" }],
  ]) {
    it(`rejects manifest ${name}`, () => reject(fixture(validInput, metadata), /Invalid manifest/));
  }

  for (const [name, sha] of [
    ["missing", undefined],
    ["null", null],
    ["numeric", 85],
    ["boolean", true],
    ["object", {}],
    ["empty", ""],
    ["truncated", manifest.source_sha256.slice(0, -1)],
    ["nonhexadecimal", "g".repeat(64)],
    ["different checkpoint", "0".repeat(64)],
  ]) {
    it(`rejects ${name} source SHA`, () => {
      reject(fixture(validInput, { ...manifest, source_sha256: sha }), /Invalid manifest source_sha256/);
    });
  }

  for (const [name, input] of [
    ["missing arrays", {}],
    ["null arrays", { input_ids: null, attention_mask: null }],
    ["string arrays", { input_ids: "0", attention_mask: "1" }],
    ["empty arrays", { input_ids: [], attention_mask: [] }],
    ["unequal lengths", { input_ids: [0, 1], attention_mask: [1] }],
    ["overlong arrays", { input_ids: [0, 0, 0, 0, 0], attention_mask: [1, 1, 1, 1, 1] }],
  ]) {
    it(`rejects input ${name}`, () => reject(fixture(input), /equal-length arrays/));
  }

  for (const [name, id, mask] of [
    ["negative token", -1, 1],
    ["out-of-vocabulary token", 128100, 1],
    ["fractional token", 0.5, 1],
    ["boolean token", true, 1],
    ["string token", "0", 1],
    ["null token", null, 1],
    ["object token", {}, 1],
    ["nested array token", [0], 1],
    ["negative mask", 0, -1],
    ["mask greater than one", 0, 2],
    ["fractional mask", 0, 0.5],
    ["boolean mask", 0, false],
    ["null mask", 0, null],
    ["string mask", 0, "1"],
  ]) {
    it(`rejects ${name}`, () => {
      reject(fixture({ input_ids: [id], attention_mask: [mask] }), /Invalid input at index 0/);
    });
  }

  it("validates legal input before reporting a missing embedding package", () => {
    reject(fixture(), /Missing model package:.*embedding\.mlpackage/);
  });

  it("accepts fused bundles and preflights their single model", () => {
    const directory = fixture(validInput, { ...manifest, format: "deckard-coreml-fused-v1" });
    reject(directory, /Missing model package:.*model\.mlpackage/);
    reject(directory, /Missing model package:.*model\.mlpackage/,
      [directory, path.join(directory, "input.json"), "--power-worker"]);
  });

  it("accepts the length boundaries and an all-zero attention mask", () => {
    for (const length of [1, 512]) {
      reject(fixture({
        input_ids: Array(length).fill(0), attention_mask: Array(length).fill(0),
      }, { ...manifest, sequence_length: length }), /Missing model package/);
    }
  });

  it("never accepts an unchecked compiled sibling as a substitute", () => {
    const directory = fixture();
    mkdirSync(path.join(directory, "embedding.mlmodelc"));
    reject(directory, /Missing model package:.*embedding\.mlpackage.*unchecked/);
  });

  it("rejects a regular file in place of a package directory", () => {
    const directory = fixture();
    writeFileSync(path.join(directory, "embedding.mlpackage"), "not a package");
    reject(directory, /Missing model package:.*embedding\.mlpackage/);
  });

  it("preflights all layers before compiling or loading any model", () => {
    const directory = fixture();
    mkdirSync(path.join(directory, "embedding.mlpackage"));
    reject(directory, /Missing model package:.*layer-00\.mlpackage/);
    for (let i = 0; i < 24; i++) {
      mkdirSync(path.join(directory, `layer-${String(i).padStart(2, "0")}.mlpackage`));
    }
    reject(directory, /Missing model package:.*head\.mlpackage/);
  });
});
