import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const release = process.env.DECKARD_RELEASE_DIR;
const available = !!release && fs.existsSync(path.join(release, "SHA256SUMS"));

test("real release archive installs, upgrades, uninstalls and reinstalls through a piped bootstrap in isolated HOME",
  { skip: !available }, t => {
    const scratch = fs.mkdtempSync(path.join(root, "dist/release-acceptance-"));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const user = path.join(scratch, "isolated home");
    const commands = path.join(scratch, "mock commands");
    fs.mkdirSync(user);
    fs.mkdirSync(commands);
    const profile = path.join(user, ".zshrc");
    const original = "# unrelated settings\nexport PERSONAL_TEST_SETTING=preserved";
    fs.writeFileSync(profile, original);
    const archiveName = "deckard-v0.5.0-macos-arm64.tar.gz";
    const archive = path.resolve(release, archiveName);
    const script = fs.readFileSync(path.join(release, "install.sh"), "utf8");
    const curlLog = path.join(scratch, "curl.log");
    fs.writeFileSync(path.join(commands, "curl"), `#!/bin/bash
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    https:*) url=$1; shift ;;
    *) shift ;;
  esac
done
[ "$url" = "https://github.com/sgoedecke/deckard/releases/download/v0.5.0/${archiveName}" ]
[ -n "$output" ]
printf '%s\\n' "$url" >> "$CURL_LOG"
cp "$RELEASE_ARCHIVE" "$output"
`, { mode: 0o700 });
    const env = { ...process.env, HOME: user, SHELL: "/bin/zsh", ZDOTDIR: user,
      PATH: `${commands}:/usr/bin:/bin:/usr/sbin:/sbin`, RELEASE_ARCHIVE: archive, CURL_LOG: curlLog };
    delete env.DECKARD_HOME;
    const run = (command, args, input) => spawnSync(command, args, {
      cwd: scratch, env, input, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024,
    });
    const hashes = spawnSync("/usr/bin/shasum", ["-a", "256", "-c", "SHA256SUMS"], {
      cwd: release, encoding: "utf8", timeout: 30000,
    });
    assert.equal(hashes.status, 0, hashes.stderr);
    const denied = run("/bin/bash", ["-s", "--", "--no-open", "--shell", "zsh"], script);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /No controlling terminal/);
    assert.ok(!fs.existsSync(curlLog));
    assert.equal(fs.readFileSync(profile, "utf8"), original);
    const install = () => run("/bin/bash", ["-s", "--", "--yes", "--no-open", "--shell", "zsh"], script);
    const prefix = path.join(user, "Library/Application Support/Deckard");
    const binary = path.join(prefix, "current/bin/deckard");
    const registration = path.join(user, "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sgoedecke.deckard.json");
    let result = install();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /chrome:\/\/extensions/);
    assert.match(result.stdout, /Load unpacked/);
    const firstProfile = fs.readFileSync(profile, "utf8");
    const extension = JSON.parse(fs.readFileSync(path.join(prefix, "extension/manifest.json")));
    assert.equal(extension.name, "Deckard");
    assert.equal(extension.version, "0.5.0");
    assert.deepEqual(JSON.parse(fs.readFileSync(registration)).allowed_origins,
      ["chrome-extension://bkihjdkalohbkgnjjoobababhipefjdg/"]);
    const status = run(binary, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).installation.product, "Deckard");
    if (process.env.DECKARD_SMOKE_RECEIPT) {
      const smoke = run(process.execPath, [path.join(root, "native-cli/tests/model-smoke.mjs"),
        binary, path.resolve(process.env.DECKARD_SMOKE_RECEIPT)]);
      assert.equal(smoke.status, 0, smoke.stderr);
    }
    result = install();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(profile, "utf8"), firstProfile);
    const inode = fs.statSync(path.join(prefix, ".install.lock")).ino;
    fs.writeFileSync(path.join(prefix, "personal.txt"), "unrelated");
    result = run(binary, ["uninstall"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(profile, "utf8"), original);
    assert.ok(!fs.existsSync(registration));
    assert.ok(!fs.existsSync(path.join(prefix, "extension")));
    assert.ok(!fs.existsSync(binary));
    assert.equal(fs.readFileSync(path.join(prefix, "personal.txt"), "utf8"), "unrelated");
    result = install();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(path.join(prefix, ".install.lock")).ino, inode);
    result = run(binary, ["uninstall"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(profile, "utf8"), original);
    assert.ok(!fs.readdirSync(scratch).some(name => name.startsWith(".deckard-bootstrap.")));
    assert.equal(fs.readFileSync(curlLog, "utf8").trim().split("\n").length, 3);
  });
