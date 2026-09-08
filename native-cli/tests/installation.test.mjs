import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const binary = process.env.DECKARD_BIN || fileURLToPath(new URL("../build/dist/bin/deckard", import.meta.url));
const model = process.env.DECKARD_MODEL_DIR;
const available = !!model && fs.existsSync(path.join(model, "packed.safetensors"));
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
  assert.doesNotMatch(child.stdout, /homebrew|\.venv|libpython/);
  assert.match(child.stdout, /@rpath\/libmlx\.dylib/);
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
