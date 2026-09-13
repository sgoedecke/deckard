import fs from "node:fs";
import { createHash } from "node:crypto";

const rawAssets = fs.readFileSync(new URL("../model-assets.json", import.meta.url));
export const assets = JSON.parse(rawAssets);
export const assetsHash = createHash("sha256").update(rawAssets).digest("hex");
export const version = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url))).version;

export function installationMetadata() {
  return {
    format: 1, product: "Deckard", version, model: assets.model, revision: assets.revision,
    policy: "gradient-q4-two-scale-v1", flag_threshold: 0.97, experimental: true,
    extension_id: "a".repeat(32), source: "verified-coreml-export", runtime: assets.runtime,
    weights_sha256: assets.source_weights_sha256, tokenizer_sha256: assets.files["tokenizer.json"],
    model_assets_sha256: assetsHash, model_files: assets.files,
    binary_sha256: "3".repeat(64), license_files: ["share/licenses/NLOHMANN-LICENSE"],
  };
}

export function canonicalJson(value) {
  const sort = item => Array.isArray(item) ? item.map(sort) :
    item && typeof item === "object" ?
      Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}
