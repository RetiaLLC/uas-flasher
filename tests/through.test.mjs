// A sensor through the master: the page's north.js against a pretend master
// that speaks the `flash` commands as master/README.md of the sensor-flash
// branch describes them. tests/master_host.test.mjs runs the same client
// against the firmware repository's own master_host.
import test from "node:test";
import assert from "node:assert/strict";
import { sim, sameBytes, recorder, SITE } from "./helpers.mjs";

const { MasterLink, flashThroughMaster, probeThroughMaster, ThroughError, choosePort, ONE_SLOT_WARNING } = await import(SITE + "/js/north.js");
const { LineIO } = await import(SITE + "/js/port.js");

async function unit({ masterVersion = "0.13.0" } = {}) {
  const serial = new sim.PretendSerial();
  const rf = serial.add(new sim.PretendBoard({ name: "rf", kind: "xiao", image: await sim.makeImage({ project: "widscan58", version: "c9dfff6" }) }));
  const rid = serial.add(new sim.PretendBoard({ name: "rid", kind: "xiao", image: await sim.makeImage({ project: "c5_drone_detector", version: "0.7.0" }) }));
  const master = serial.add(sim.wire(new sim.PretendBoard({ name: "master", kind: "master", image: await sim.makeImage({ project: "uas_detector_master", version: masterVersion }) }), { a: rf, b: rid }));
  serial.choose = async (boards) => boards.find((b) => b.name === "master");
  const io = new LineIO(await serial.requestPort());
  await io.open();
  const link = new MasterLink(io);
  const done = async () => { link.close(); await io.close(); for (const b of [master, rf, rid]) b.stop(); };
  return { serial, master, rf, rid, link, done };
}

test("a Remote ID image goes to the port its sensor is on, and the sensor then runs it", async () => {
  const u = await unit();
  const image = await sim.makeImage({ project: "c5_drone_detector", version: "0.7.3", size: 80 * 1024, seed: 3 });
  const r = recorder({ "through-master": true });
  const end = await flashThroughMaster({ link: u.link, role: "rid", image, version: "0.7.3", hooks: r.hooks });
  assert.equal(end.state, "done");
  assert.equal(end.port, "b");
  assert.equal(end.was, "0.7.0");
  assert.equal(end.now, "0.7.3");
  assert.equal(end.version_ok, true);
  assert.ok(sameBytes(u.rid.flash.subarray(0x10000, 0x10000 + image.length), image));
  assert.ok(sameBytes(u.rf.flash.subarray(0x10000, 0x10020), (await sim.makeImage({ project: "widscan58", version: "c9dfff6" })).subarray(0, 0x20)), "the other sensor was not touched");
  const asked = r.seen.confirms[0];
  assert.equal(asked.kind, "through-master");
  assert.equal(asked.was, "0.7.0");
  assert.equal(asked.warning, ONE_SLOT_WARNING);
  assert.deepEqual(r.seen.steps.filter((s) => s[1] === "done").map((s) => s[0]).slice(-4), ["loader", "write", "restart", "hello"]);
  const hello = await u.link.get("hello", "m_hello");
  assert.equal(hello.ports.find((p) => p.port === "b").fw_ver, "0.7.3");
  await u.done();
});

test("nothing reaches the sensor when the person says no", async () => {
  const u = await unit();
  const image = await sim.makeImage({ project: "c5_drone_detector", version: "0.7.3" });
  await assert.rejects(flashThroughMaster({ link: u.link, role: "rid", image, version: "0.7.3", hooks: recorder({ "through-master": false }).hooks }),
    (e) => e instanceof ThroughError && e.begun === false);
  assert.deepEqual(u.rid.log, []);
  assert.equal((await u.link.cmd("get", { what: "flash" })).flash, null);
  await u.done();
});

test("a master whose capabilities do not name flash is not asked to", async () => {
  const u = await unit({ masterVersion: "0.11.0" });
  const image = await sim.makeImage({ project: "c5_drone_detector", version: "0.7.3" });
  const r = recorder({ "through-master": true });
  await assert.rejects(flashThroughMaster({ link: u.link, role: "rid", image, version: "0.7.3", hooks: r.hooks }), /cannot flash a sensor/);
  assert.equal(r.seen.confirms.length, 0);
  await u.done();
});

test("an image of the other sensor's project is turned away by the master, in its words", async () => {
  const u = await unit();
  const image = await sim.makeImage({ project: "widscan58", version: "160e231" });
  await assert.rejects(flashThroughMaster({ link: u.link, role: "rid", image, version: "160e231", hooks: recorder({ "through-master": true }).hooks }),
    /the image's project is not that sensor's/);
  assert.deepEqual(u.rid.log, []);
  await u.done();
});

test("a cancel before go leaves nothing behind", async () => {
  const u = await unit();
  const image = await sim.makeImage({ project: "c5_drone_detector", version: "0.7.3", size: 200 * 1024 });
  const abort = new AbortController();
  const r = recorder({ "through-master": true });
  r.hooks.progress = (done) => { if (done > 20000) abort.abort(); };
  await assert.rejects(flashThroughMaster({ link: u.link, role: "rid", image, version: "0.7.3", hooks: r.hooks, signal: abort.signal }), /Cancelled/);
  assert.deepEqual(u.rid.log, []);
  assert.equal((await u.link.cmd("get", { what: "flash" })).flash, null);
  await u.done();
});

test("a probe enters the loader and leaves, and writes nothing", async () => {
  const u = await unit();
  const before = u.rf.flash.slice(0x10000, 0x10400);
  const end = await probeThroughMaster({ link: u.link, port: "a" });
  assert.equal(end.state, "done");
  assert.equal(end.probe, true);
  assert.equal(end.chip, 23);
  assert.ok(sameBytes(u.rf.flash.subarray(0x10000, 0x10400), before));
  await u.done();
});

test("which port: by role, or the one a sensor waits in its loader on", () => {
  const hello = { ports: [{ port: "a", role: "rf", state: "UP", fw_ver: "x" }, { port: "b", role: "rid", state: "UP", fw_ver: "0.7.0" }] };
  assert.equal(choosePort(hello, {}, "rid", null).port, "b");
  assert.equal(choosePort(hello, {}, "rf", null).port, "a");
  assert.match(choosePort({ ports: [hello.ports[0]] }, {}, "rid", null).error, /No rid sensor is UP/);
  const held = choosePort(hello, { left: "loader", port: "b", role: "rid" }, "rid", null);
  assert.deepEqual([held.port, held.held], ["b", true]);
  assert.match(choosePort(hello, { left: "loader", port: "b", role: "rid" }, "rf", null).error, /Flash that one first/);
  assert.equal(choosePort(hello, { left: "loader", port: "a", role: null }, "rf", null).ask, "a");
  assert.equal(choosePort(hello, { left: "loader", port: "a", role: null }, "rf", "a").port, "a");
});

test("a board-only build through the master is refused for a sensor on another board", async () => {
  const u = await unit();
  const image = await sim.makeImage({ project: "widscan58", version: "a2a45f2" });
  const r = recorder({ "through-master": true });
  await assert.rejects(flashThroughMaster({ link: u.link, role: "rf", image, version: "a2a45f2", hooks: r.hooks, boardId: "waveshare_esp32_c5_zero" }),
    /only for a sensor on the board waveshare_esp32_c5_zero/);
  assert.deepEqual(u.rf.log, []);
  await u.done();
});
