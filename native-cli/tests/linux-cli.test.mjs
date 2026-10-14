// Linux install and host behavior: the XDG default paths, the model cache in
// ~/.cache/deckard (offline reuse, resumed downloads, corrupt files,
// --no-download) and a host that Chrome starts niced. The network is cut off
// through a dead HTTPS proxy, so any download attempt fails at once.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validResult } from "../../extension/native-queue.js";
import { assets, modelAvailable } from "./model-fixture.mjs";

const binary = process.env.DECKARD_BIN || fileURLToPath(new URL("../build/dist/bin/deckard", import.meta.url));
const model = process.env.DECKARD_MODEL_DIR;
const linux = process.platform === "linux";
const available = linux && modelAvailable(model);
const extension = fileURLToPath(new URL("../../extension", import.meta.url));
const manifestName = "com.sgoedecke.deckard.json";
const offline = "http://127.0.0.1:9";  // the discard port: connections are refused

function fixture(t) {
  const root = fs.mkdtempSync(fileURLToPath(new URL(".linux-cli-", import.meta.url)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const user = path.join(root, "home");
  const cache = path.join(user, ".cache/deckard");
  fs.mkdirSync(user);
  const env = { HOME: user, PATH: "/usr/bin:/bin", https_proxy: offline, HTTPS_PROXY: offline };
  const run = (args, { command = binary, ...options } = {}) => spawnSync(command, args,
    { encoding: "utf8", timeout: 300000, env, ...options });
  // Installs into the test's own prefix and manifest directory; `defaults`
  // leaves both to deckard, as a plain `deckard install` does.
  const install = (args = [], defaults = false) => run(["install", "--no-extension", "--shell", "none",
    ...(defaults ? [] : ["--home", path.join(root, "prefix"), "--manifest-dir", path.join(root, "manifests")]), ...args]);
  // Fills the model cache from DECKARD_MODEL_DIR without copying where it can:
  // hard links share the original's bytes, so callers must never write to them.
  const fillCache = (except = []) => {
    fs.mkdirSync(cache, { recursive: true });
    for (const name of Object.keys(assets.files).filter(name => !except.includes(name))) {
      try { fs.linkSync(path.join(model, name), path.join(cache, name)); }
      catch { fs.copyFileSync(path.join(model, name), path.join(cache, name), fs.constants.COPYFILE_FICLONE); }
    }
  };
  return { root, user, cache, run, install, fillCache };
}

test("with only HOME set, install uses the XDG paths and the model cache, offline", { skip: !available }, t => {
  const f = fixture(t);
  f.fillCache();
  let result = f.install([], true);
  assert.equal(result.status, 0, result.stderr);
  const prefix = path.join(f.user, ".local/share/deckard");
  const registration = path.join(f.user, ".config/google-chrome/NativeMessagingHosts", manifestName);
  const host = JSON.parse(fs.readFileSync(registration)).path;
  assert.ok(host.startsWith(prefix + path.sep), host);
  assert.ok(fs.statSync(host).isFile());
  result = f.run(["uninstall"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(registration));
  assert.ok(!fs.existsSync(host));
  assert.ok(modelAvailable(f.cache), "uninstall leaves the model cache alone");
});

test("a fully downloaded .download file in the cache is completed without the network", { skip: !available }, t => {
  const f = fixture(t);
  // A copy, not a link: a failed resume would append to this file.
  f.fillCache(["config.json"]);
  fs.copyFileSync(path.join(model, "config.json"), path.join(f.cache, "config.json.download"));
  const result = f.install();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(f.cache, "config.json")));
  assert.ok(!fs.existsSync(path.join(f.cache, "config.json.download")));
});

test("a corrupt file in the model cache is refused and nothing is activated", { skip: !available }, t => {
  const f = fixture(t);
  f.fillCache(["tokenizer.json"]);
  fs.writeFileSync(path.join(f.cache, "tokenizer.json"), "{}");
  const result = f.install();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /asset_mismatch/);
  assert.ok(!fs.existsSync(path.join(f.root, "prefix/current")));
  assert.ok(!fs.existsSync(path.join(f.root, "manifests", manifestName)));
});

test("an empty model cache fails before activation, with or without downloads", { skip: !linux }, t => {
  const f = fixture(t);
  let result = f.install(["--no-download"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /model_missing/, "--no-download must not try the network");
  assert.match(result.stderr, /--model-dir/);
  result = f.install();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /download_failed/);
  assert.match(result.stderr, /--model-dir/);
  assert.ok(!fs.existsSync(path.join(f.root, "prefix/current")));
  assert.ok(!fs.existsSync(path.join(f.root, "manifests", manifestName)));
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

test("a host started niced, as by a niced Chrome, still scores text", { skip: !available }, t => {
  // An unprivileged process cannot lower its nice value; the host must keep
  // the priority it inherited instead of failing to start.
  const f = fixture(t);
  const installed = f.install(["--model-dir", model]);
  assert.equal(installed.status, 0, installed.stderr);
  const registration = JSON.parse(fs.readFileSync(path.join(f.root, "manifests", manifestName)));
  const text = "The committee met on Tuesday to review the budget for the coming year. After a long " +
    "discussion about road repairs, the library roof and the new playground, members agreed to " +
    "postpone the vote until residents could comment at the next public meeting. Several people " +
    "asked for the draft to be posted online beforehand, and the chair promised to do so by Friday " +
    "so that everyone would have time to read it.";
  const input = Buffer.concat([
    frame({ id: "ping", type: "ping", protocol_version: 3 }),
    frame({ id: "analyze", type: "analyze", protocol_version: 3, text }),
    frame({ id: "loaded", type: "ping", protocol_version: 3 }),
  ]);
  const result = f.run(["-n", "5", registration.path, ...registration.allowed_origins],
    { command: "nice", input, encoding: "buffer" });
  assert.equal(result.status, 0, result.stderr.toString());
  const [ping, analyze, loaded] = replies(result.stdout);
  assert.ok(ping.ok && validResult("ping", ping.result), JSON.stringify(ping));
  assert.ok(analyze.ok && validResult("analyze", analyze.result), JSON.stringify(analyze));
  assert.equal(analyze.result.status, "complete");
  assert.equal(loaded.result.model_loaded, true);
});
