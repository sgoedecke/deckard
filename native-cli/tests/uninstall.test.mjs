import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const binary = process.env.AI_HIDER_BIN || fileURLToPath(new URL("../build/dist/bin/ai-hider", import.meta.url));
const script = fileURLToPath(new URL("../../install.sh", import.meta.url));
const host = "com.ai_hider.editlens";
const write = (file, contents = "owned") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
};
function fixture(t, version = "0.3.0") {
  const root = fs.mkdtempSync(fileURLToPath(new URL(".uninstall-", import.meta.url)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "application with spaces");
  const manifests = path.join(root, "native manifests");
  const registration = path.join(manifests, `${host}.json`);
  const userHome = path.join(root, "user");
  fs.mkdirSync(userHome);
  const run = (args = [], env = {}) => spawnSync(binary,
    ["uninstall", "--home", home, "--manifest-dir", manifests, ...args],
    { encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: userHome, ...env } });
  const config = {
    format: 1, version, model: "ShantanuT01/gradient-ai-text-detector",
    revision: "c2e8b6df87f8a211cbffb713fa9873a0c3a9713f",
    policy: "gradient-q4-composite-v1-retrospective", flag_threshold: 0.9824231167326641,
    experimental: true, extension_id: "a".repeat(32), source: "verified-packed-export",
    weights_sha256: "1".repeat(64), tokenizer_sha256: "2".repeat(64), binary_sha256: "3".repeat(64),
    mlx_sha256: "4".repeat(64), metal_sha256: "5".repeat(64),
    license_files: ["share/licenses/MLX-LICENSE"],
  };
  const licenses = config.license_files;
  if (version === "0.2.0") delete config.license_files;
  const sorted = JSON.stringify(Object.fromEntries(Object.keys(config).sort().map(key => [key, config[key]])));
  const name = `${config.version}-${createHash("sha256").update(sorted).digest("hex").slice(0, 20)}`;
  const release = path.join(home, "releases", name);
  function install() {
    write(path.join(release, "install.json"), sorted);
    for (const file of ["bin/ai-hider", "lib/libmlx.dylib", "lib/mlx.metallib",
      "models/packed.safetensors", "models/tokenizer.json", ...licenses])
      write(path.join(release, file));
    fs.symlinkSync("ai-hider", path.join(release, "bin/ai-hider-host"));
    fs.symlinkSync(`releases/${name}`, path.join(home, "current"));
    write(registration, JSON.stringify({
      name: host, type: "stdio", path: path.join(home, "current/bin/ai-hider-host"),
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

test("legacy native releases lose runtime and weights but retain uninventoried notices", t => {
  const f = fixture(t, "0.2.0");
  f.install();
  fs.unlinkSync(f.registration);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(path.join(f.release, "models")));
  assert.ok(!fs.existsSync(path.join(f.release, "bin")));
  assert.ok(fs.existsSync(path.join(f.release, "share/licenses/MLX-LICENSE")));
  assert.ok(fs.existsSync(path.join(f.release, "install.json")));
  assert.equal(f.run().status, 0);
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
    assert.ok(fs.existsSync(path.join(f.release, "bin/ai-hider")));
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
      case "host-symlink": replaceWithSymlink(outside, path.join(f.release, "bin/ai-hider-host")); break;
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

test("script uninstall dispatches without bootstrap, CMake, or downloads", t => {
  const f = fixture(t);
  const entry = path.join(f.root, "install.sh");
  fs.copyFileSync(script, entry);
  const capture = path.join(f.root, "arguments");
  const built = path.join(f.root, "native-cli/build/dist/bin/ai-hider");
  const installed = path.join(f.home, "current/bin/ai-hider");
  const fake = '#!/bin/sh\nif [ "$1" = --help ]; then echo "ai-hider uninstall [--home DIR]"; else printf "%s\\n" "$@" > "$CAPTURE"; fi\n';
  write(built, fake);
  fs.chmodSync(built, 0o700);
  write(path.join(f.root, "native-cli/bootstrap.sh"), `#!/bin/sh\ntouch "${f.root}/bootstrapped"\nexit 99\n`);
  const args = ["--uninstall", "--home", f.home, "--manifest-dir", f.manifests];
  const run = supplied => spawnSync("/bin/sh", [entry, ...supplied], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: f.userHome, CAPTURE: capture, PATH: "/usr/bin:/bin" },
  });
  assert.equal(run(args).status, 0);
  assert.deepEqual(fs.readFileSync(capture, "utf8").trimEnd().split("\n"), ["uninstall", ...args.slice(1)]);
  fs.unlinkSync(capture);
  write(built, "#!/bin/sh\necho 'old CLI without uninstall support'\n");
  assert.equal(run(args).status, 1);
  assert.ok(!fs.existsSync(capture));
  write(installed, fake);
  fs.chmodSync(installed, 0o700);
  assert.equal(run(args).status, 0, "fallback to an installed current CLI");
  const badOrder = run(["--home", f.home, "--uninstall"]);
  assert.equal(badOrder.status, 1);
  assert.match(badOrder.stderr, /put --uninstall first/);
  assert.ok(!fs.existsSync(path.join(f.root, "bootstrapped")));
});
