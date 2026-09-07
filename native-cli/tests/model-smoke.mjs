// Resource-bounded end-to-end model smoke; explicitly run, never part of npm test.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NativeQueue } from "../../extension/native-queue.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const binary = process.argv[2];
const output = process.argv[3];
assert.ok(binary && output, "Pass the installed binary and a new receipt path.");
const listeners = () => {
  const callbacks = [];
  return { addListener: fn => callbacks.push(fn), fire: value => callbacks.forEach(fn => fn(value)) };
};
const child = spawn(binary, ["start"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
let pending = Buffer.alloc(0), stderr = "", failure, maximumFootprint = 0;
const port = {
  onMessage: listeners(), onDisconnect: listeners(),
  disconnect: () => child.stdin.end(),
  postMessage(message) {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([header, body]));
  },
};
const queue = new NativeQueue(() => port, { timeout: 60000 });
function fail(error) {
  failure ||= error;
  port.error = error;
  port.onDisconnect.fire();
  child.kill("SIGKILL");
}
child.on("error", fail);
child.stdin.on("error", fail);
child.stderr.on("data", data => { stderr += data; });
child.stdout.on("data", data => {
  pending = Buffer.concat([pending, data]);
  try {
    while (pending.length >= 4) {
      const length = pending.readUInt32LE();
      assert.ok(length > 0 && length <= 131072);
      if (pending.length < length + 4) break;
      const message = JSON.parse(pending.subarray(4, length + 4));
      pending = pending.subarray(length + 4);
      port.onMessage.fire(message);
    }
  } catch (error) { fail(error); }
});
const closed = new Promise(resolve => child.once("close", (code, signal) => {
  port.onDisconnect.fire();
  resolve({ code, signal });
}));
function metrics() {
  const result = spawnSync(`${root}/cache/gradient-accelerator/process_metrics`, [String(child.pid)], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, "Native process memory meter failed.");
  const value = JSON.parse(result.stdout);
  maximumFootprint = Math.max(maximumFootprint, value.physical_footprint_bytes, value.peak_physical_footprint_bytes);
  assert.ok(maximumFootprint <= 6 * 1024 ** 3, "Native process exceeded the 6 GiB safety limit.");
  return value;
}
const watch = setInterval(() => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { metrics(); } catch (error) { fail(error); }
}, 200);
const deadline = setTimeout(() => fail(new Error("Native smoke exceeded 90 seconds.")), 90000);
let receipt;
try {
  const ping = await queue.request("ping");
  assert.equal(ping.model_loaded, false);
  assert.equal(ping.min_words, 50);
  const passages = JSON.parse(await readFile(`${root}/laptop/assets/real-passages.json`));
  const text = passages.find(value => value.cloud_tokens < 400).text;
  const prefix = count => text.trim().split(/\s+/u).slice(0, count).join(" ");
  assert.ok(text.trim().split(/\s+/u).length >= 75);
  const short = await queue.request("analyze", prefix(49));
  assert.equal(short.status, "skipped");
  assert.equal(short.reason, "too_short");
  assert.equal(short.words, 49);
  assert.equal((await queue.request("ping")).model_loaded, false);
  const boundary = [];
  for (const count of [50, 74, 75]) {
    const value = await queue.request("analyze", prefix(count));
    assert.equal(value.status, "complete");
    assert.equal(value.words, count);
    assert.ok(value.chunks.every(chunk => chunk.words >= 50));
    boundary.push(value);
  }
  const result = await queue.request("analyze", text);
  assert.equal(result.status, "complete");
  assert.equal(result.score, result.max_score);
  assert.equal((await queue.request("analyze", text)).cached, true);
  assert.equal((await queue.request("ping")).model_loaded, true);
  const long = await queue.request("analyze", Array(12).fill(text).join("\n").slice(0, 19000));
  assert.equal(long.status, "partial");
  assert.equal(globalThis.AIHiderCore.shouldFlag(long, { enabled: true }), false);
  const beforeIdle = metrics();
  await new Promise(resolve => setTimeout(resolve, 2000));
  const afterIdle = metrics();
  receipt = { status: "complete", minimum_words: 50, boundary, result, partial: long,
    before_idle: beforeIdle, after_idle: afterIdle };
  assert.ok(!stderr.includes(text));
} finally {
  queue.disconnect();
  const exit = await closed;
  clearInterval(watch);
  clearTimeout(deadline);
  if (failure) throw failure;
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  assert.equal(pending.length, 0);
}
receipt.maximum_physical_footprint_bytes = maximumFootprint;
await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ status: receipt.status, max_footprint_bytes: maximumFootprint, steady_footprint_bytes: receipt.after_idle.physical_footprint_bytes }));
