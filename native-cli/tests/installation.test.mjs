import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { canonicalJson, installationMetadata } from "./model-fixture.mjs";

const binary = process.env.DECKARD_BIN || fileURLToPath(new URL("../build/dist/bin/deckard", import.meta.url));
const model = process.env.DECKARD_MODEL_DIR;
const available = !!model && fs.existsSync(path.join(model, "model.mlpackage/Manifest.json"));
const run = (exe, args, input) => spawnSync(exe, args, {
  input, encoding: input ? undefined : "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
});

test("installation is idempotent, conflict-safe, relocatable, and independent of Python", { skip: !available }, t => {
  const root = fs.mkdtempSync(fileURLToPath(new URL(".installation-", import.meta.url)));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const home = path.join(root, "application");
  const manifests = path.join(root, "manifests");
  const args = ["install", "--home", home, "--manifest-dir", manifests, "--extension-id", "a".repeat(32),
    "--model-dir", model, "--shell", "none", "--no-extension"];
  let child = run(binary, args);
  assert.equal(child.status, 0, child.stderr);
  const original = fs.readlinkSync(path.join(home, "current"));
  child = run(binary, args);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.readlinkSync(path.join(home, "current")), original);
  assert.equal(fs.readdirSync(path.join(home, "releases")).length, 1);
  child = run(binary, args.map(value => value === "a".repeat(32) ? "b".repeat(32) : value));
  assert.equal(child.status, 1);
  assert.match(child.stderr, /registration_conflict/);
  assert.equal(fs.readlinkSync(path.join(home, "current")), original);
  const manifestPath = path.join(manifests, "com.sgoedecke.deckard.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  assert.equal(manifest.type, "stdio");
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${"a".repeat(32)}/`]);
  assert.ok(fs.statSync(manifest.path).isFile());
  const message = Buffer.from(JSON.stringify({ id: "launch", type: "ping", protocol_version: 3 }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(message.length);
  child = run(manifest.path, manifest.allowed_origins, Buffer.concat([prefix, message]));
  assert.equal(child.status, 0, child.stderr.toString());
  assert.equal(JSON.parse(child.stdout.subarray(4)).result.model_loaded, false);
  const relocated = path.join(root, "relocated");
  fs.renameSync(home, relocated);
  let installed = path.join(relocated, "current/bin/deckard");
  child = run(installed, ["status"]);
  assert.equal(child.status, 0, child.stderr);
  const files = fs.readdirSync(fs.realpathSync(path.join(relocated, "current")), { recursive: true });
  assert.ok(!files.some(file => /\.(py|pyc|whl)$/.test(file) || /(?:^|\/)(python|cargo|rustc)(?:\/|$)/.test(file)));
  child = run("/usr/bin/otool", ["-L", installed]);
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stdout, /homebrew|\.venv|libpython|libmlx|Metal\.framework/);
  assert.match(child.stdout, /CoreML\.framework/);
  assert.ok(!files.some(file => /packed\.safetensors|libmlx|mlx\.metallib/.test(file)));
  child = run(binary, ["uninstall", "--home", relocated, "--manifest-dir", manifests]);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /uninstall_conflict|setup_conflict/);
  assert.ok(fs.existsSync(installed), "a stale registration must not cause partial teardown");
  fs.renameSync(relocated, home);
  installed = path.join(home, "current/bin/deckard");
  const lockInode = fs.statSync(path.join(home, ".install.lock")).ino;
  fs.writeFileSync(path.join(home, "keep-me.txt"), "personal");
  fs.writeFileSync(path.join(manifests, "unrelated.json"), "{}");
  child = run(installed, ["uninstall", "--home", home, "--manifest-dir", manifests]);
  assert.equal(child.status, 0, child.stderr);
  assert.ok(!fs.existsSync(installed), "the running installed CLI can remove itself");
  assert.ok(!fs.existsSync(path.join(home, "releases")));
  assert.ok(!fs.existsSync(manifestPath));
  assert.equal(fs.statSync(path.join(home, ".install.lock")).ino, lockInode);
  assert.equal(fs.readFileSync(path.join(home, "keep-me.txt"), "utf8"), "personal");
  assert.ok(fs.existsSync(path.join(manifests, "unrelated.json")));
  child = run(binary, ["uninstall", "--home", home, "--manifest-dir", manifests]);
  assert.equal(child.status, 0, child.stderr);
});

test("registration failure cannot activate a new release", { skip: !available }, t => {
  const root = fs.mkdtempSync(fileURLToPath(new URL(".rollback-", import.meta.url)));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const home = path.join(root, "application");
  const manifests = path.join(root, "manifests");
  const args = ["install", "--home", home, "--manifest-dir", manifests, "--model-dir", model,
    "--extension-id", "a".repeat(32), "--shell", "none", "--no-extension"];
  let child = run(binary, [...args, "--no-register"]);
  assert.equal(child.status, 0, child.stderr);
  const previous = fs.readlinkSync(path.join(home, "current"));
  fs.mkdirSync(path.join(manifests, "com.sgoedecke.deckard.json"), { recursive: true });
  child = run(binary, [...args.map(value => value === "a".repeat(32) ? "b".repeat(32) : value), "--replace"]);
  assert.equal(child.status, 1);
  assert.equal(fs.readlinkSync(path.join(home, "current")), previous);
  assert.ok(!fs.readdirSync(home).some(file => file.startsWith(".stage-")));
});

test("owned MLX 0.5 metadata upgrades to Core ML without losing registration or legacy teardown", { skip: !available }, t => {
  const root = fs.mkdtempSync(fileURLToPath(new URL(".migration-", import.meta.url)));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const home = path.join(root, "application");
  const manifests = path.join(root, "manifests");
  const config = {
    ...installationMetadata(), version: "0.5.0", source: "verified-packed-export",
    mlx_sha256: "4".repeat(64), metal_sha256: "5".repeat(64),
    license_files: ["share/licenses/MLX-LICENSE"],
  };
  for (const key of ["runtime", "model_assets_sha256", "model_files"]) delete config[key];
  const metadata = canonicalJson(config);
  const relative = `releases/0.5.0-${createHash("sha256").update(metadata).digest("hex").slice(0, 20)}`;
  const legacy = path.join(home, relative);
  for (const name of ["bin/deckard", "lib/libmlx.dylib", "lib/mlx.metallib",
    "models/packed.safetensors", "models/tokenizer.json", ...config.license_files]) {
    const file = path.join(legacy, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "owned legacy fixture; never executed");
  }
  fs.writeFileSync(path.join(legacy, "install.json"), metadata);
  fs.symlinkSync("deckard", path.join(legacy, "bin/deckard-host"));
  fs.symlinkSync(relative, path.join(home, "current"));
  fs.mkdirSync(manifests);
  const registration = path.join(manifests, "com.sgoedecke.deckard.json");
  fs.writeFileSync(registration, JSON.stringify({
    name: "com.sgoedecke.deckard", description: "Deckard native Gradient MLX (experimental marking)",
    type: "stdio", path: path.join(home, "current/bin/deckard-host"),
    allowed_origins: [`chrome-extension://${"a".repeat(32)}/`],
  }));
  fs.writeFileSync(path.join(home, "setup.json"), JSON.stringify({
    format: 1, product: "Deckard", prefix: home, manifest_dir: manifests, profile: "",
    path_block: "", profile_created: false, extension_files: {}, transaction_id: "legacy-fixture",
  }));
  let child = run(binary, ["install", "--home", home, "--manifest-dir", manifests,
    "--extension-id", "a".repeat(32), "--model-dir", model, "--shell", "none", "--no-extension"]);
  assert.equal(child.status, 0, child.stderr);
  assert.notEqual(fs.readlinkSync(path.join(home, "current")), relative);
  assert.equal(fs.readdirSync(path.join(home, "releases")).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "current/install.json"))).runtime, "native-coreml");
  assert.match(JSON.parse(fs.readFileSync(registration)).description, /Core ML/);
  child = run(binary, ["uninstall", "--home", home, "--manifest-dir", manifests]);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(fs.readdirSync(home), [".install.lock"]);
  assert.ok(!fs.existsSync(registration));
});
