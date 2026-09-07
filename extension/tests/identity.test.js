import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import "../core.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../manifest.json"));
const extensionId = "bkihjdkalohbkgnjjoobababhipefjdg";

function deriveId(der) {
  return createHash("sha256").update(der).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, nibble => String.fromCharCode(97 + parseInt(nibble, 16)));
}

test("public manifest key reproducibly pins the stable Chrome extension ID", () => {
  const der = Buffer.from(manifest.key, "base64");
  assert.equal(der.toString("base64"), manifest.key);
  const key = createPublicKey({ key: der, type: "spki", format: "der" });
  assert.equal(key.type, "public");
  assert.equal(key.asymmetricKeyType, "rsa");
  assert.deepEqual(key.export({ type: "spki", format: "der" }), der);
  assert.match(deriveId(der), /^[a-p]{32}$/);
  assert.equal(deriveId(der), extensionId);
  assert.ok(read("../../README.md").includes(`\`${extensionId}\``));
});

test("Deckard brand, release version and native host remain consistent", () => {
  assert.equal(manifest.name, "Deckard");
  assert.equal(manifest.version, "0.4.0");
  const pkg = JSON.parse(read("../../package.json"));
  assert.equal(pkg.name, "deckard");
  assert.equal(pkg.version, manifest.version);
  const native = read("../../native-cli/src/support.hpp");
  assert.match(native, /app_version = "0\.4\.0"/);
  assert.match(native, /host_name = "com\.sgoedecke\.deckard"/);
  assert.match(read("../service-worker.js"), /connectNative\("com\.sgoedecke\.deckard"\)/);
  assert.match(read("../popup.html"), /<title>Deckard<\/title>/);
  assert.match(read("../icons/icon.svg"), /<title>Deckard<\/title>/);
});

test("public branding does not alter model identity, marking floor or page budget", () => {
  const C = globalThis.DeckardCore;
  assert.equal(C.PROTOCOL_VERSION, 2);
  assert.equal(C.MIN_WORDS, 50);
  assert.equal(C.MAX_PAGE_WORDS, 25000);
  assert.equal(C.FLAG_THRESHOLD, 0.9824231167326641);
  assert.equal(C.MODEL_REVISION, "c2e8b6df87f8a211cbffb713fa9873a0c3a9713f");
  assert.equal(C.validThreshold(0.7), true);
  assert.equal(C.validThreshold(0.99), true);
  assert.equal(C.validThreshold(0.699), false);
  assert.equal(C.validThreshold(0.991), false);
});
