// The page's north.js against the firmware repository's own master: master_host, the
// same master_core the board runs, between that repository's simulated sensors
// and pretend ROM loader (pull requests 95 and 96).
//
// Needs UAS_TREE: a checkout or an export of the firmware's repository at a commit that
// has the sensor flasher. Skipped without it.
//
//   git -C <clone> archive origin/tools/sensor-flash master components tools tests | tar -x -C /tmp/uas_tree
//   UAS_TREE=/tmp/uas_tree node --test tests/master_host.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sim, recorder, ROOT, SITE } from "./helpers.mjs";

const { MasterLink, flashThroughMaster, probeThroughMaster } = await import(SITE + "/js/north.js");
const { LineIO } = await import(SITE + "/js/port.js");
const { md5 } = await import(SITE + "/js/bytes.js");

const tree = process.env.UAS_TREE;
const usable = tree && existsSync(join(tree, "tools", "flash_sensor.py")) && existsSync(join(tree, "tests", "test_flash.py"));

/** A TCP socket dressed as a serial port, so that LineIO reads it unchanged. */
function socketPort(socket) {
  let rc = null;
  const readable = new ReadableStream({
    start(c) { rc = c; },
    cancel() { rc = null; },
  });
  socket.on("data", (d) => { if (rc) rc.enqueue(new Uint8Array(d)); });
  socket.on("close", () => { try { if (rc) rc.close(); } catch { /* closed */ } });
  const writable = new WritableStream({ write: (chunk) => new Promise((res, rej) => socket.write(chunk, (e) => (e ? rej(e) : res()))) });
  return { readable, writable, open: async () => {}, close: async () => { socket.destroy(); }, getInfo: () => ({}) };
}

async function rig() {
  const proc = spawn("python3", ["-I", join(ROOT, "tests", "rig_bridge.py"), tree], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: proc.stdout });
  let ended = false;
  proc.once("exit", () => { ended = true; });
  const next = () => new Promise((resolve, reject) => {
    if (ended) return reject(new Error("the rig has ended"));
    const onExit = () => reject(new Error("the rig ended"));
    proc.once("exit", onExit);
    lines.once("line", (l) => { proc.off("exit", onExit); resolve(JSON.parse(l)); });
  });
  const { port } = await next();
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((r) => socket.once("connect", r));
  const io = new LineIO(socketPort(socket));
  await io.open();
  const link = new MasterLink(io);
  return {
    link,
    state: async (size) => { proc.stdin.write(`state ${size}\n`); return (await next()).sensors; },
    close: async () => {
      link.close();
      await io.close();
      if (ended) return;
      proc.stdin.write("quit\n");
      await Promise.race([new Promise((r) => proc.once("exit", r)), new Promise((r) => setTimeout(() => { proc.kill(); r(); }, 8000))]);
    },
  };
}

test("the firmware repository's master takes a Remote ID image from the page's client and its sensor then runs it", { skip: !usable && "UAS_TREE is not set" }, async () => {
  const r = await rig();
  try {
    const hello = await r.link.get("hello", "m_hello");
    assert.ok(hello.caps.includes("flash"), "this master can flash a sensor");
    const image = await sim.makeImage({ project: "c5_drone_detector", version: "0.7.4", size: 24 * 1024, seed: 11 });
    const rec = recorder({ "through-master": true });
    const end = await flashThroughMaster({ link: r.link, role: "rid", image, version: "0.7.4", hooks: rec.hooks });
    assert.equal(end.state, "done");
    assert.equal(end.role, "rid");
    assert.equal(end.now, "0.7.4");
    assert.equal(end.version_ok, true);
    const rid = (await r.state(image.length)).find((s) => s.role === "rid");
    assert.deepEqual([rid.mode, rid.fw_ver, rid.md5], ["app", "0.7.4", md5(image)], "the simulated sensor runs the image, byte for byte");
    assert.equal(rec.seen.confirms[0].port, end.port);
    assert.deepEqual(rec.seen.steps.filter((s) => s[1] === "done").map((s) => s[0]).slice(-4), ["loader", "write", "restart", "hello"]);
  } finally {
    await r.close();
  }
});

test("the firmware repository's master turns away an image of the other sensor, and a probe writes nothing", { skip: !usable && "UAS_TREE is not set" }, async () => {
  const r = await rig();
  try {
    const wrong = await sim.makeImage({ project: "widscan58", version: "9.9.9", size: 24 * 1024 });
    await assert.rejects(flashThroughMaster({ link: r.link, role: "rid", image: wrong, version: "9.9.9", hooks: recorder({ "through-master": true }).hooks }),
      /the image's project is not that sensor's|the sensor on that port is of the other kind/);
    const hello = await r.link.get("hello", "m_hello");
    const port = hello.ports.find((p) => p.role === "rf").port;
    // What each simulated sensor runs. (Its pretend flash exists only once it has been in its loader, so bytes are not compared here.)
    const runs = async () => (await r.state(0)).map((s) => [s.role, s.mode, s.fw_ver]);
    const before = await runs();
    const end = await probeThroughMaster({ link: r.link, port });
    assert.equal(end.state, "done");
    assert.equal(end.probe, true);
    assert.equal(end.chip, 23, "the master names the chip by its image id: 23 is the ESP32-C5");
    assert.deepEqual(await runs(), before, "both sensors run what they ran");
  } finally {
    await r.close();
  }
});
