import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const binary = process.env.DECKARD_BIN || fileURLToPath(new URL("../build/dist/bin/deckard", import.meta.url));
const model = process.env.DECKARD_MODEL_DIR;
const available = !!model && fs.existsSync(path.join(model, "packed.safetensors"));
const extension = fileURLToPath(new URL("../../extension", import.meta.url));
const manifestName = "com.sgoedecke.deckard.json";
const key = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"))).key;
const id = key && [...createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16)]
  .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");

function fixture(t, shell = "zsh") {
  const root = fs.mkdtempSync(fileURLToPath(new URL(".setup-", import.meta.url)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const user = path.join(root, "user home");
  const home = path.join(user, "Library/Application Support/Deckard's app");
  const manifests = path.join(user, "Chrome manifests");
  fs.mkdirSync(user);
  const profile = path.join(user, shell === "bash" ? ".bash_profile" : ".zshrc");
  const env = { ...process.env, HOME: user, SHELL: `/bin/${shell}`, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  delete env.DECKARD_HOME;
  const run = (command, args = [], extraEnv = {}) => spawnSync(binary,
    [command, "--home", home, ...args], {
      encoding: "utf8", timeout: 30000, env: { ...env, ...extraEnv },
    });
  const install = (args = [], extraEnv = {}) => run("install",
    ["--model-dir", model, "--extension-dir", extension, "--manifest-dir", manifests, ...args], extraEnv);
  return { root, user, home, manifests, profile, env, run, install };
}

for (const shell of ["zsh", "bash"]) for (const original of [null, "", "export PERSONAL=kept", "# owned by user\n\n"]) {
  test(`owned ${shell} setup restores profile bytes (${JSON.stringify(original)})`, { skip: !available }, t => {
    const f = fixture(t, shell);
    if (original !== null) fs.writeFileSync(f.profile, original, { mode: 0o640 });
    let result = f.install();
    assert.equal(result.status, 0, result.stderr);
    const content = fs.readFileSync(f.profile, "utf8");
    assert.equal(content.split("# >>> Deckard PATH >>>").length, 2);
    const registration = JSON.parse(fs.readFileSync(path.join(f.manifests, manifestName)));
    assert.deepEqual(registration.allowed_origins, [`chrome-extension://${id}/`]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, "extension/manifest.json"))).key, key);
    const command = shell === "zsh" ? "/bin/zsh" : "/bin/bash";
    const profileCheck = spawnSync(command, ["-f", "-c", '. "$HOME/' + path.basename(f.profile) +
      '"; . "$HOME/' + path.basename(f.profile) + '"; command -v deckard; printf "%s\\n" "$PATH"'], {
      encoding: "utf8", env: f.env,
    });
    assert.equal(profileCheck.status, 0, profileCheck.stderr);
    assert.equal(profileCheck.stdout.split("\n")[0], path.join(f.home, "current/bin/deckard"));
    assert.equal(profileCheck.stdout.split("\n")[1].split(":").filter(p => p === path.join(f.home, "current/bin")).length, 1);
    result = f.install();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(f.profile, "utf8"), content);
    const inode = fs.statSync(path.join(f.home, ".install.lock")).ino;
    result = f.run("uninstall");
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(path.join(f.home, "extension")));
    assert.ok(!fs.existsSync(path.join(f.manifests, manifestName)));
    assert.deepEqual(fs.readdirSync(f.home), [".install.lock"]);
    assert.equal(fs.statSync(path.join(f.home, ".install.lock")).ino, inode);
    if (original === null) assert.ok(!fs.existsSync(f.profile));
    else {
      assert.equal(fs.readFileSync(f.profile, "utf8"), original);
      assert.equal(fs.statSync(f.profile).mode & 0o777, 0o640);
    }
    assert.equal(f.run("uninstall").status, 0);
    assert.equal(f.install().status, 0);
    assert.equal(f.run("uninstall").status, 0);
  });
}

test("upgrade updates extension at stable path; uninstall preserves unrelated profile and extension files", { skip: !available }, t => {
  const f = fixture(t);
  fs.writeFileSync(f.profile, "export PERSONAL=kept");
  assert.equal(f.install().status, 0);
  fs.appendFileSync(f.profile, "export OTHER=also-kept\n");
  const copy = path.join(f.root, "new extension");
  fs.cpSync(extension, copy, { recursive: true });
  fs.appendFileSync(path.join(copy, "popup.css"), "\n/* upgrade fixture */\n");
  let result = f.run("install", ["--model-dir", model, "--extension-dir", copy]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(f.home, "extension/popup.css"), "utf8"), /upgrade fixture/);
  fs.appendFileSync(f.profile, "# unrelated later edit\n");
  fs.writeFileSync(path.join(f.home, "extension/personal.txt"), "keep");
  result = f.run("uninstall");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.profile, "utf8"), "export PERSONAL=kept\nexport OTHER=also-kept\n# unrelated later edit\n");
  const shell = spawnSync("/bin/zsh", ["-f", "-c",
    '. "$HOME/.zshrc"; printf "%s\\n" "$PERSONAL" "$OTHER"'], { encoding: "utf8", env: f.env });
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(shell.stdout, "kept\nalso-kept\n");
  assert.equal(fs.readFileSync(path.join(f.home, "extension/personal.txt"), "utf8"), "keep");
});

test("uninstall preserves a command appended after a no-newline profile", { skip: !available }, t => {
  const f = fixture(t);
  fs.writeFileSync(f.profile, "export PERSONAL=kept");
  assert.equal(f.install().status, 0);
  fs.appendFileSync(f.profile, "export OTHER=also-kept\n");
  const result = f.run("uninstall");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.profile, "utf8"), "export PERSONAL=kept\nexport OTHER=also-kept\n");
});

for (const scenario of ["unowned-block", "path-command", "profile-symlink", "profile-hardlink", "registration", "extension-directory"]) {
  test(`install preflight is non-destructive: ${scenario}`, { skip: !available }, t => {
    const f = fixture(t);
    const keep = path.join(f.root, "keep");
    fs.writeFileSync(keep, "unrelated");
    const extraEnv = {};
    if (scenario === "unowned-block") fs.writeFileSync(f.profile, "# >>> Deckard PATH >>>\nforeign\n# <<< Deckard PATH <<<\n");
    if (scenario === "profile-symlink") fs.symlinkSync(keep, f.profile);
    if (scenario === "profile-hardlink") fs.linkSync(keep, f.profile);
    if (scenario === "path-command") {
      const bin = path.join(f.root, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "deckard"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      extraEnv.PATH = `${bin}:${f.env.PATH}`;
    }
    if (scenario === "registration") {
      fs.mkdirSync(f.manifests, { recursive: true });
      fs.writeFileSync(path.join(f.manifests, manifestName), '{"path":"/unrelated","name":"unrelated"}');
    }
    if (scenario === "extension-directory") {
      fs.mkdirSync(path.join(f.home, "extension"), { recursive: true });
      fs.writeFileSync(path.join(f.home, "extension/keep"), "unrelated");
    }
    const before = fs.existsSync(f.profile) ? fs.readFileSync(f.profile) : null;
    const result = f.install(["--replace"], extraEnv);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /setup_conflict|registration_conflict/);
    assert.ok(!fs.existsSync(path.join(f.home, "current")));
    assert.equal(fs.readFileSync(keep, "utf8"), "unrelated");
    if (before) assert.deepEqual(fs.readFileSync(f.profile), before);
    else assert.ok(!fs.existsSync(f.profile));
  });
}

for (const scenario of ["edited-block", "edited-extension", "redirected-extension", "different-manifest", "unknown-extension-upgrade"]) {
  test(`existing setup conflict prevents partial teardown or upgrade: ${scenario}`, { skip: !available }, t => {
    const f = fixture(t);
    assert.equal(f.install().status, 0);
    if (scenario === "edited-block") fs.appendFileSync(f.profile, "# >>> Deckard PATH >>>\n");
    if (scenario === "edited-extension") fs.appendFileSync(path.join(f.home, "extension/popup.css"), "changed");
    if (scenario === "redirected-extension") {
      fs.renameSync(path.join(f.home, "extension"), path.join(f.home, "moved"));
      fs.symlinkSync("moved", path.join(f.home, "extension"));
    }
    if (scenario === "unknown-extension-upgrade") fs.writeFileSync(path.join(f.home, "extension/unowned"), "keep");
    const before = fs.readFileSync(f.profile);
    const result = scenario === "unknown-extension-upgrade" ? f.install() :
      f.run("uninstall", scenario === "different-manifest" ? ["--manifest-dir", path.join(f.root, "elsewhere")] : []);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(fs.existsSync(path.join(f.home, "current/bin/deckard")));
    assert.ok(fs.existsSync(path.join(f.manifests, manifestName)));
    assert.deepEqual(fs.readFileSync(f.profile), before);
  });
}

test("corrupt model cannot activate or change profile and extension", { skip: !available }, t => {
  const f = fixture(t);
  assert.equal(f.install().status, 0);
  const before = fs.readFileSync(f.profile);
  const current = fs.readlinkSync(path.join(f.home, "current"));
  const bad = path.join(f.root, "bad model");
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, "packed.safetensors"), "corrupt");
  const result = f.run("install", ["--model-dir", bad, "--extension-dir", extension]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /asset_mismatch/);
  assert.equal(fs.readlinkSync(path.join(f.home, "current")), current);
  assert.deepEqual(fs.readFileSync(f.profile), before);
  assert.ok(!fs.readdirSync(f.home).some(name => name.startsWith(".stage-")));
});

test("activation failure rolls back published PATH and extension without deleting a conflicting pointer", { skip: !available }, async t => {
  const f = fixture(t);
  fs.mkdirSync(f.home, { recursive: true });
  fs.writeFileSync(f.profile, "original profile bytes");
  const child = spawn(binary, ["install", "--home", f.home, "--model-dir", model,
    "--extension-dir", extension, "--manifest-dir", f.manifests], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  const pointer = path.join(f.home, `.current-${child.pid}`);
  fs.writeFileSync(pointer, "foreign pointer");
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => clearTimeout(timeout));
  assert.equal(code, 1, stderr);
  assert.equal(fs.readFileSync(f.profile, "utf8"), "original profile bytes");
  assert.equal(fs.readFileSync(pointer, "utf8"), "foreign pointer");
  assert.ok(!fs.existsSync(path.join(f.home, "extension")));
  assert.ok(!fs.existsSync(path.join(f.home, "setup.json")));
  assert.ok(!fs.existsSync(path.join(f.home, "current")));
  assert.ok(!fs.existsSync(path.join(f.manifests, manifestName)));
  assert.ok(!fs.readdirSync(f.home).some(name => name.startsWith(".stage-")));
});

for (const identical of [false, true]) test(`rerunning install recovers interrupted publication (identical=${identical})`, { skip: !available }, t => {
  const f = fixture(t);
  fs.writeFileSync(f.profile, "before");
  assert.equal(f.install().status, 0);
  const previous = JSON.parse(fs.readFileSync(path.join(f.home, "setup.json")));
  const profileBefore = fs.readFileSync(f.profile, "utf8");
  const registration = path.join(f.manifests, manifestName);
  const manifest = JSON.parse(fs.readFileSync(registration));
  const current = fs.readlinkSync(path.join(f.home, "current"));
  const stage = path.join(f.home, ".stage-interrupted-fixture");
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.renameSync(path.join(f.home, "extension"), path.join(stage, "previous-extension"));
  fs.cpSync(path.join(stage, "previous-extension"), path.join(f.home, "extension"), { recursive: true });
  if (!identical) fs.appendFileSync(path.join(f.home, "extension/popup.css"), "\n/* interrupted upgrade */\n");
  const next = structuredClone(previous);
  next.transaction_id = path.basename(stage);
  next.extension_files["extension/popup.css"] = createHash("sha256")
    .update(fs.readFileSync(path.join(f.home, "extension/popup.css"))).digest("hex");
  if (identical) fs.renameSync(path.join(f.home, "extension"), path.join(stage, "extension"));
  fs.writeFileSync(path.join(f.home, ".transaction.json"), JSON.stringify({
    format: 1, product: "Deckard", prefix: f.home, stage: path.basename(stage),
    next_setup: next, previous_setup: previous, profile_before: profileBefore,
    profile_after: profileBefore, profile_existed: true,
    previous_current: current, next_current: current, registration,
    previous_manifest: manifest, next_manifest: manifest, registering: true,
  }), { mode: 0o600 });
  const result = f.install();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(stage));
  assert.ok(!fs.existsSync(path.join(f.home, ".transaction.json")));
  assert.equal(fs.readFileSync(f.profile, "utf8"), profileBefore);
  assert.doesNotMatch(fs.readFileSync(path.join(f.home, "extension/popup.css"), "utf8"), /interrupted upgrade/);
  assert.equal(f.run("uninstall").status, 0);
  assert.equal(fs.readFileSync(f.profile, "utf8"), "before");
});

test("interrupted uninstall resumes after PATH removal and partial extension deletion", { skip: !available }, t => {
  const f = fixture(t);
  fs.writeFileSync(f.profile, "preserve");
  assert.equal(f.install().status, 0);
  const metadata = JSON.parse(fs.readFileSync(path.join(f.home, "setup.json")));
  const before = fs.readFileSync(f.profile, "utf8");
  const after = before.replace(metadata.path_block, "");
  const next = { ...metadata, profile: "", path_block: "", profile_created: false,
    extension_files: {}, uninstalling: true };
  fs.writeFileSync(path.join(f.home, ".transaction.json"), JSON.stringify({
    format: 1, product: "Deckard", prefix: f.home, operation: "uninstall",
    previous_setup: metadata, next_setup: next, profile_before: before, profile_after: after,
  }), { mode: 0o600 });
  fs.writeFileSync(f.profile, after);
  fs.unlinkSync(path.join(f.home, "extension/popup.css"));
  const result = f.run("uninstall");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.profile, "utf8"), "preserve");
  assert.ok(!fs.existsSync(path.join(f.home, "extension")));
  assert.ok(!fs.existsSync(path.join(f.manifests, manifestName)));
  assert.deepEqual(fs.readdirSync(f.home), [".install.lock"]);
  assert.equal(f.run("uninstall").status, 0);
});

test("interrupted final release-directory removal uses saved ownership instead of accepting arbitrary empty directories", { skip: !available }, t => {
  const f = fixture(t);
  assert.equal(f.install(["--shell", "none"]).status, 0);
  const metadata = JSON.parse(fs.readFileSync(path.join(f.home, "setup.json")));
  const relative = fs.readlinkSync(path.join(f.home, "current"));
  const release = path.join(f.home, relative);
  const config = JSON.parse(fs.readFileSync(path.join(release, "install.json")));
  const digest = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  const drained = { ...metadata, extension_files: {}, uninstalling: true,
    release_cleanup: { [path.basename(release)]: { product: "Deckard", version: "0.4.0", metadata_sha256: digest } } };
  fs.rmSync(path.join(f.home, "extension"), { recursive: true });
  fs.unlinkSync(path.join(f.home, "current"));
  fs.unlinkSync(path.join(f.manifests, manifestName));
  fs.rmSync(release, { recursive: true });
  fs.mkdirSync(release);
  fs.writeFileSync(path.join(f.home, "setup.json"), JSON.stringify(drained));
  const result = f.run("uninstall");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(f.home), [".install.lock"]);
});
