// Resource-bounded end-to-end model smoke; explicitly run, never part of npm test.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NativeQueue } from "../../extension/native-queue.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const binary = process.argv[2];
const output = process.argv[3];
assert.ok(binary && output, "Pass the installed binary and a new receipt path.");
const meter = process.env.DECKARD_PROCESS_METRICS || `${root}/native-cli/build/bin/deckard-process-metrics`;
assert.ok(existsSync(meter), "Build the native process meter or set DECKARD_PROCESS_METRICS before running inference.");
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
  const result = spawnSync(meter, [String(child.pid)], { encoding: "utf8", timeout: 5000 });
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
  const text = "On Saturday I repaired the wooden shelf beside my kitchen window. The screws had worked loose " +
    "after several years of holding jars, notebooks, and a small blue watering can. I moved everything " +
    "onto the table, measured the brackets, and walked to the local hardware shop for replacements. " +
    "Rain started while I was walking home, so I stopped under an awning and checked the receipt. " +
    "The shopkeeper had included two spare screws. By lunchtime the shelf was level again, and the " +
    "watering can was back beside the window.";
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
  const result = await queue.request("analyze", prefix(75));
  assert.equal(result.status, "complete");
  assert.equal(result.score, result.max_score);
  assert.equal(result.cached, true);
  assert.equal((await queue.request("ping")).model_loaded, true);
  const plan = await queue.request("plan", [text.repeat(6)]);
  assert.equal(plan.status, "planned");
  const replay = [];
  if (process.argv[4]) {
    const inputs = JSON.parse(await readFile(process.argv[4], "utf8"));
    assert.ok(Array.isArray(inputs) && inputs.length <= 16);
    for (const input of inputs) {
      assert.ok(typeof input === "string" && input.length <= 20000);
      replay.push({ sha256: createHash("sha256").update(input).digest("hex"),
        result: await queue.request("analyze", input) });
    }
  }
  const beforeIdle = metrics();
  await new Promise(resolve => setTimeout(resolve, 2000));
  const afterIdle = metrics();
  receipt = { status: "complete", minimum_words: 50, boundary, result, plan, replay,
    before_idle: beforeIdle, after_idle: afterIdle };
  assert.ok(!stderr.includes(text));
} finally {
  clearInterval(watch);
  queue.disconnect();
  const exit = await closed;
  clearTimeout(deadline);
  if (failure) throw failure;
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  assert.equal(pending.length, 0);
}
receipt.maximum_physical_footprint_bytes = maximumFootprint;
await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ status: receipt.status, max_footprint_bytes: maximumFootprint, steady_footprint_bytes: receipt.after_idle.physical_footprint_bytes }));
