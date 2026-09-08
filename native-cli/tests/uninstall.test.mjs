import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const binary = process.env.DECKARD_BIN || fileURLToPath(new URL("../build/dist/bin/deckard", import.meta.url));
const host = "com.sgoedecke.deckard";
const write = (file, contents = "owned") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
};
function fixture(t, version = "0.5.0") {
  const root = fs.mkdtempSync(fileURLToPath(new URL(".uninstall-", import.meta.url)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "application with spaces");
  const manifests = path.join(root, "native manifests");
  const owned = ["0.4.0", "0.4.1", "0.5.0"].includes(version);
  const hostName = owned ? host : "com.example.other";
  const registration = path.join(manifests, `${hostName}.json`);
  const userHome = path.join(root, "user");
  fs.mkdirSync(userHome);
  const run = (args = [], env = {}) => spawnSync(binary,
    ["uninstall", "--home", home, "--manifest-dir", manifests, ...args],
    { encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: userHome, ...env } });
  const config = {
    format: 1, product: "Deckard", version, model: "ShantanuT01/gradient-ai-text-detector",
    revision: "c2e8b6df87f8a211cbffb713fa9873a0c3a9713f",
    policy: version === "0.5.0" ? "gradient-q4-two-scale-v1" : "gradient-q4-composite-v1-retrospective",
    flag_threshold: version === "0.5.0" ? 0.97 : 0.9824231167326641,
    experimental: true, extension_id: "a".repeat(32), source: "verified-packed-export",
    weights_sha256: "1".repeat(64), tokenizer_sha256: "2".repeat(64), binary_sha256: "3".repeat(64),
    mlx_sha256: "4".repeat(64), metal_sha256: "5".repeat(64),
    license_files: ["share/licenses/MLX-LICENSE"],
  };
  const licenses = config.license_files;
  if (!owned) delete config.product;
  const cli = owned ? "deckard" : "other-app";
  const sorted = JSON.stringify(Object.fromEntries(Object.keys(config).sort().map(key => [key, config[key]])));
  const name = `${config.version}-${createHash("sha256").update(sorted).digest("hex").slice(0, 20)}`;
  const release = path.join(home, "releases", name);
  function install() {
    write(path.join(release, "install.json"), sorted);
    for (const file of [`bin/${cli}`, "lib/libmlx.dylib", "lib/mlx.metallib",
      "models/packed.safetensors", "models/tokenizer.json", ...licenses])
      write(path.join(release, file));
    fs.symlinkSync(cli, path.join(release, `bin/${cli}-host`));
    fs.symlinkSync(`releases/${name}`, path.join(home, "current"));
    write(registration, JSON.stringify({
      name: hostName, type: "stdio", path: path.join(home, `current/bin/${cli}-host`),
      allowed_origins: [`chrome-extension://${"a".repeat(32)}/`],
    }));
  }
  return { root, home, userHome, manifests, registration, release, run, install };
}

test("absent uninstall is idempotent and creates no directories", t => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(f.home));
    assert.ok(!fs.existsSync(f.manifests));
  }
});

test("uninstall still recognizes positively owned Deckard 0.4.0 releases", t => {
  const f = fixture(t, "0.4.0");
  f.install();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(f.release));
  assert.ok(!fs.existsSync(f.registration));
});

test("uninstall removes owned files only and retains the lock inode", t => {
  const f = fixture(t);
  f.install();
  write(path.join(f.home, ".install.lock"), "");
  const inode = fs.statSync(path.join(f.home, ".install.lock")).ino;
  for (const file of ["personal.txt", "downloads/checkpoint", "models/unrecognized", "releases/personal.txt"])
    write(path.join(f.home, file), "keep");
  write(path.join(f.release, "personal.txt"), "keep");
  write(path.join(f.manifests, "another-host.json"), "keep");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Retaining unrecognized/);
  assert.ok(!fs.existsSync(f.registration));
  assert.ok(!fs.existsSync(path.join(f.home, "current")));
  assert.ok(!fs.existsSync(path.join(f.release, "models")));
  assert.ok(!fs.existsSync(path.join(f.release, "bin")));
  assert.ok(!fs.existsSync(path.join(f.release, "share")));
  assert.equal(fs.readFileSync(path.join(f.release, "personal.txt"), "utf8"), "keep");
  for (const file of ["personal.txt", "downloads/checkpoint", "models/unrecognized", "releases/personal.txt"])
    assert.equal(fs.readFileSync(path.join(f.home, file), "utf8"), "keep");
  assert.equal(fs.statSync(path.join(f.home, ".install.lock")).ino, inode);
  assert.equal(f.run().status, 0);
  assert.equal(fs.readFileSync(path.join(f.manifests, "another-host.json"), "utf8"), "keep");
});

test("clean validated release is removed without removing its prefix", t => {
  const f = fixture(t);
  f.install();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(f.home), [".install.lock"]);
  assert.equal(f.run().status, 0);
});

for (const version of ["0.2.0", "0.3.0"]) test(`foreign metadata ${version} is never removed or replaced`, t => {
  const f = fixture(t, version);
  f.install();
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /not a Deckard installation/);
  const install = spawnSync(binary, ["install", "--home", f.home, "--manifest-dir", f.manifests,
    "--shell", "none", "--no-extension", "--no-register"], { encoding: "utf8", env: { ...process.env, HOME: f.userHome } });
  assert.equal(install.status, 1);
  assert.match(install.stderr, /not a Deckard installation/);
  assert.ok(fs.existsSync(path.join(f.release, "models/packed.safetensors")));
  assert.ok(fs.existsSync(path.join(f.release, "bin/other-app")));
  assert.ok(fs.existsSync(path.join(f.release, "share/licenses/MLX-LICENSE")));
  assert.ok(fs.existsSync(path.join(f.release, "install.json")));
  assert.ok(fs.existsSync(f.registration));
});

test("symlink prefixes are refused, including trailing-slash aliases", t => {
  const f = fixture(t);
  f.install();
  const alias = path.join(f.root, "alias");
  fs.symlinkSync(f.home, alias);
  for (const home of [alias, `${alias}/`, `${alias}/.`]) {
    const result = spawnSync(binary, ["uninstall", "--home", home, "--manifest-dir", f.manifests],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uninstall_conflict/);
    assert.ok(fs.existsSync(f.registration));
    assert.ok(fs.existsSync(path.join(f.release, "bin/deckard")));
  }
});

test("unsafe home boundaries are refused before any changes", t => {
  const f = fixture(t);
  for (const home of ["/", f.userHome, process.cwd()]) {
    const result = spawnSync(binary, ["uninstall", "--home", home, "--manifest-dir", f.manifests],
      { encoding: "utf8", env: { ...process.env, HOME: f.userHome }, timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uninstall_conflict/);
  }
  assert.deepEqual(fs.readdirSync(f.userHome), []);
  assert.ok(!fs.existsSync(f.manifests));
});

for (const scenario of [
  "registration-path", "registration-name", "registration-type", "registration-symlink",
  "current-outside", "current-absolute", "current-file", "release-symlink",
  "releases-symlink", "models-symlink", "prefix-models-symlink", "metadata-invalid",
  "metadata-symlink", "release-name", "host-symlink", "lock-symlink", "lock-hardlink",
]) {
  test(`conflict preflight preserves all installation data: ${scenario}`, t => {
    const f = fixture(t);
    f.install();
    const outside = path.join(f.root, "outside");
    write(path.join(outside, "keep"), "safe");
    const replaceWithSymlink = (target, link) => {
      fs.renameSync(link, `${link}.saved`);
      fs.symlinkSync(target, link);
    };
    switch (scenario) {
      case "registration-path":
      case "registration-name":
      case "registration-type": {
        const manifest = JSON.parse(fs.readFileSync(f.registration));
        manifest[scenario.slice("registration-".length)] = "another-installation";
        write(f.registration, JSON.stringify(manifest));
        break;
      }
      case "registration-symlink": replaceWithSymlink(`${f.registration}.saved`, f.registration); break;
      case "current-outside": replaceWithSymlink("../../outside", path.join(f.home, "current")); break;
      case "current-absolute": replaceWithSymlink(f.release, path.join(f.home, "current")); break;
      case "current-file":
        fs.unlinkSync(path.join(f.home, "current"));
        write(path.join(f.home, "current"));
        break;
      case "release-symlink": replaceWithSymlink(`${f.release}.saved`, f.release); break;
      case "releases-symlink": replaceWithSymlink(outside, path.join(f.home, "releases")); break;
      case "models-symlink": replaceWithSymlink(outside, path.join(f.release, "models")); break;
      case "prefix-models-symlink": fs.symlinkSync(outside, path.join(f.home, "models")); break;
      case "metadata-invalid": write(path.join(f.release, "install.json"), "{}"); break;
      case "metadata-symlink":
        replaceWithSymlink(path.join(f.release, "install.json.saved"), path.join(f.release, "install.json"));
        break;
      case "release-name": fs.renameSync(f.release, `${f.release}-wrong`); break;
      case "host-symlink": replaceWithSymlink(outside, path.join(f.release, "bin/deckard-host")); break;
      case "lock-symlink": fs.symlinkSync(path.join(outside, "keep"), path.join(f.home, ".install.lock")); break;
      case "lock-hardlink": fs.linkSync(path.join(outside, "keep"), path.join(f.home, ".install.lock")); break;
    }
    const registrationBefore = fs.readFileSync(f.registration);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /uninstall_conflict|install_lock/);
    assert.deepEqual(fs.readFileSync(f.registration), registrationBefore);
    assert.ok(fs.lstatSync(path.join(f.home, "current")));
    assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "safe");
  });
}
