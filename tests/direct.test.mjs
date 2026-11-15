// A board through its own USB socket: the page's flashDirect with esptool-js
// 0.7.1 against pretend boards, writing the files of the release in the catalog.
import test from "node:test";
import assert from "node:assert/strict";
import { esptool, sim, catalog, loadBoard, sameBytes, recorder, SITE } from "./helpers.mjs";

const { flashDirect, FlashError } = await import(SITE + "/js/direct.js");
const release = catalog().releases[0];

function unit() {
  const serial = new sim.PretendSerial();
  return serial;
}
function holds(board, parts) {
  for (const p of parts) {
    assert.ok(sameBytes(board.flash.subarray(p.offset, p.offset + p.data.length), p.data), `${p.kind} at 0x${p.offset.toString(16)} is in the flash`);
  }
}

test("the master: its own command into the loader, three files, the watchdog out", async () => {
  const serial = unit();
  const old = await sim.makeImage({ project: "uas_detector_master", version: "0.10.0" });
  const board = serial.add(new sim.PretendBoard({ name: "master", kind: "master", image: old }));
  board.flash.fill(0x5a, 0x9000, 0xf000);                       // settings that an update must not touch
  const { board: entry, parts } = loadBoard(release, "master");
  const port = await serial.requestPort();
  const r = recorder();
  const out = await flashDirect({ serial, esptool, port, role: "master", board: entry, parts, hooks: r.hooks });
  holds(board, parts);
  assert.equal(out.was.version, "0.10.0");
  assert.equal(out.rev, "1.2");
  assert.equal(out.flashBytes, 32 * 1024 * 1024);
  assert.equal(out.now.version, entry.version);
  assert.equal(out.settled, true);
  assert.ok(board.flash.subarray(0x9000, 0xf000).every((b) => b === 0x5a), "the settings partition was left alone");
  for (const mark of ["fw-to-loader", "wdt-off", "swd-autofeed", "wdt-reset"]) assert.ok(board.log.includes(mark), mark);
  // As on the real board: mute after the watchdog's restart, so one restart through RTS, and nothing else on those lines.
  assert.equal(board.signalChanges, 2, "DTR and RTS were changed for the one restart through RTS only");
  assert.deepEqual(board.log.slice(board.log.indexOf("wdt-reset") + 1), ["dtr-rts", "dtr-rts", "usb-reset"]);
  assert.equal(out.rtsRestart, true);
  assert.deepEqual(r.seen.steps.filter((s) => s[1] === "done").map((s) => s[0]), ["ask", "loader", "chip", "write", "restart", "hello"]);
  await out.io.close();
  board.stop();
});

test("the master, with the settings blanked as well", async () => {
  const serial = unit();
  const board = serial.add(new sim.PretendBoard({ kind: "master", image: await sim.makeImage({ project: "uas_detector_master", version: "0.10.0" }) }));
  board.flash.fill(0x5a, 0x9000, 0xf000);
  const { board: entry, parts } = loadBoard(release, "master");
  const out = await flashDirect({ serial, esptool, port: await serial.requestPort(), role: "master", board: entry, parts, wipe: true, hooks: recorder().hooks });
  holds(board, parts);
  assert.ok(board.flash.subarray(0x9000, 0xf000).every((b) => b === 0xff), "the settings partition is blank");
  await out.io.close();
  board.stop();
});

test("the Remote ID sensor, a revision 1.0 chip: never a reset through DTR or RTS", async () => {
  const serial = unit();
  const board = serial.add(new sim.PretendBoard({ kind: "xiao", image: await sim.makeImage({ project: "c5_drone_detector", version: "0.7.0" }) }));
  const { board: entry, parts } = loadBoard(release, "rid");
  const r = recorder();
  const out = await flashDirect({ serial, esptool, port: await serial.requestPort(), role: "rid", board: entry, parts, hooks: r.hooks });
  holds(board, parts);
  assert.equal(out.rev, "1.0");
  assert.equal(out.was.version, "0.7.0");
  assert.equal(out.now.version, entry.version);
  assert.equal(board.signalChanges, 0);
  assert.ok(!board.log.includes("wedged"));
  assert.equal(r.seen.confirms.length, 0, "nothing had to be asked");
  await out.io.close();
  board.stop();
});

// There is no RF sensor build in the release yet: a made-up application with the RF project's name stands for it.
async function rfRelease() {
  const rid = loadBoard(release, "rid");
  const app = await sim.makeImage({ project: "widscan58", version: "160e231", size: 96 * 1024, seed: 7 });
  return {
    board: { ...rid.board, project: "widscan58", version: "160e231", app_slot: { offset: 0x10000, size: 0x1f0000 } },
    parts: [rid.parts[0], rid.parts[1], { kind: "app", offset: 0x10000, data: app }],
  };
}

test("the RF sensor: named by INFO on its console, into the loader by BOOTLOADER", async () => {
  const serial = unit();
  const board = serial.add(new sim.PretendBoard({ kind: "xiao", image: await sim.makeImage({ project: "widscan58", version: "c9dfff6" }) }));
  const { board: entry, parts } = await rfRelease();
  const r = recorder();
  const out = await flashDirect({ serial, esptool, port: await serial.requestPort(), role: "rf", board: entry, parts, hooks: r.hooks });
  holds(board, parts);
  assert.equal(out.was.role, "rf");
  assert.equal(out.was.version, "c9dfff6");
  assert.equal(out.now.version, "160e231");
  assert.equal(board.signalChanges, 0);
  await out.io.close();
  board.stop();
});

test("a board that says nothing and sits in its loader (the BOOT button, or a flash that was cut off)", async () => {
  const serial = unit();
  const board = serial.add(new sim.PretendBoard({ kind: "xiao", image: null, inLoader: true }));
  const { board: entry, parts } = loadBoard(release, "rid");
  const r = recorder();
  const out = await flashDirect({ serial, esptool, port: await serial.requestPort(), role: "rid", board: entry, parts, hooks: r.hooks });
  holds(board, parts);
  assert.equal(out.was, null, "it carried nothing");
  assert.equal(out.now.version, entry.version);
  assert.equal(board.signalChanges, 0);
  await out.io.close();
  board.stop();
});

test("the wrong board is asked about, and refused: nothing is written and it keeps running", async () => {
  const serial = unit();
  const old = await sim.makeImage({ project: "uas_detector_master", version: "0.10.0" });
  const board = serial.add(new sim.PretendBoard({ kind: "master", image: old }));
  const before = board.flash.slice(0, 0x20000);
  const { board: entry, parts } = loadBoard(release, "rid");
  const r = recorder({ "other-board": false });
  await assert.rejects(
    flashDirect({ serial, esptool, port: await serial.requestPort(), role: "rid", board: entry, parts, hooks: r.hooks }),
    (e) => e instanceof FlashError && e.left === "unchanged" && /master/.test(e.message));
  assert.deepEqual(r.seen.confirms.map((c) => [c.kind, c.says, c.chosen]), [["other-board", "master", "rid"]]);
  assert.ok(sameBytes(board.flash.subarray(0, 0x20000), before));
  assert.equal(board.mode, "app");
  assert.ok(!board.log.includes("fw-to-loader"), "it was never taken into its loader");
  board.stop();
});

test("a sensor board chosen as the master is caught by its flash size, and sent back to what it ran", async () => {
  const serial = unit();
  const board = serial.add(new sim.PretendBoard({ kind: "xiao", image: null, inLoader: true }));
  const { board: entry, parts } = loadBoard(release, "master");
  const r = recorder({ "other-flash": false });
  await assert.rejects(
    flashDirect({ serial, esptool, port: await serial.requestPort(), role: "master", board: entry, parts, hooks: r.hooks }),
    (e) => e instanceof FlashError && e.left === "unchanged" && /8 MB/.test(e.message));
  assert.equal(r.seen.confirms[0].kind, "other-flash");
  assert.ok(board.flash.subarray(0x2000, 0x20000).every((b) => b === 0xff), "nothing was written");
  assert.ok(board.log.includes("wdt-armed"), "it was restarted with the watchdog, not left in its loader");
  await new Promise((r2) => setTimeout(r2, 150));
  board.stop();
});

test("a sensor that takes only the link's framed command still gets into its loader", async () => {
  const serial = unit();
  const board = serial.add(new sim.PretendBoard({ kind: "xiao", deafToPlain: true, image: await sim.makeImage({ project: "c5_drone_detector", version: "0.7.0" }) }));
  const { board: entry, parts } = loadBoard(release, "rid");
  const out = await flashDirect({ serial, esptool, port: await serial.requestPort(), role: "rid", board: entry, parts, hooks: recorder().hooks });
  holds(board, parts);
  assert.equal(board.signalChanges, 0);
  await out.io.close();
  board.stop();
});

for (const [name, options] of [["stays on USB through its restart", { keepsUsb: true }], ["comes back as the same port object", { sameObject: true }]]) {
  test(`a board that ${name}`, async () => {
    const serial = unit();
    const board = serial.add(new sim.PretendBoard({ kind: "xiao", ...options, image: await sim.makeImage({ project: "c5_drone_detector", version: "0.7.0" }) }));
    const { board: entry, parts } = loadBoard(release, "rid");
    const out = await flashDirect({ serial, esptool, port: await serial.requestPort(), role: "rid", board: entry, parts, hooks: recorder().hooks });
    holds(board, parts);
    assert.equal(out.now.version, entry.version);
    assert.equal(board.signalChanges, 0);
    await out.io.close();
    board.stop();
  });
}

test("two boards on USB at once: the one that restarted is found again, the other is left alone", async () => {
  const serial = unit();
  const other = serial.add(new sim.PretendBoard({ name: "other", kind: "xiao", image: await sim.makeImage({ project: "widscan58", version: "c9dfff6" }) }));
  const board = serial.add(new sim.PretendBoard({ name: "rid", kind: "xiao", mac: [0x10, 0xbd, 0xa3, 0x00, 0x0a, 0x02], image: await sim.makeImage({ project: "c5_drone_detector", version: "0.7.0" }) }));
  other.granted = true;                                   // the browser remembers it from an earlier visit
  serial.choose = async (boards) => boards.find((b) => b.name === "rid");
  const { board: entry, parts } = loadBoard(release, "rid");
  const otherBefore = other.flash.slice(0x10000, 0x10200);
  const out = await flashDirect({ serial, esptool, port: await serial.requestPort(), role: "rid", board: entry, parts, hooks: recorder().hooks });
  holds(board, parts);
  assert.equal(out.mac, "10:bd:a3:00:0a:02");
  assert.ok(sameBytes(other.flash.subarray(0x10000, 0x10200), otherBefore));
  assert.deepEqual(other.log, []);
  await out.io.close();
  board.stop(); other.stop();
});

test("a new master, running its maker's firmware: asked first, then restarted over USB, written, and its settings partition blanked", async () => {
  const serial = unit();
  const board = serial.add(new sim.PretendBoard({ kind: "master", image: null, foreign: true }));
  board.flash.fill(0x5a, 0x9000, 0xf000);                       // the maker's own data lies where our settings will be
  const { board: entry, parts } = loadBoard(release, "master");
  const r = recorder({ "usb-reset": true });
  const out = await flashDirect({ serial, esptool, port: await serial.requestPort(), role: "master", board: entry, parts, hooks: r.hooks });
  holds(board, parts);
  assert.deepEqual(r.seen.confirms.map((c) => c.kind), ["usb-reset"]);
  assert.equal(out.usbReset, true);
  assert.equal(out.blanked, true);
  assert.ok(board.flash.subarray(0x9000, 0xf000).every((b) => b === 0xff), "what the maker kept there is gone");
  assert.ok(board.log.includes("usb-reset-to-loader"));
  assert.ok(!board.log.includes("fw-to-loader"), "its firmware took no command of ours");
  assert.equal(out.was, null);
  assert.equal(out.now.version, entry.version);
  assert.equal(out.settled, true);
  await out.io.close();
  board.stop();
});

test("a new master, and the person says no to the restart over USB: nothing is done to it", async () => {
  const serial = unit();
  const board = serial.add(new sim.PretendBoard({ kind: "master", image: null, foreign: true }));
  const before = board.flash.slice(0, 0x20000);
  const { board: entry, parts } = loadBoard(release, "master");
  const r = recorder({ "usb-reset": false });
  await assert.rejects(
    flashDirect({ serial, esptool, port: await serial.requestPort(), role: "master", board: entry, parts, hooks: r.hooks }),
    (e) => e instanceof FlashError && e.at === "loader" && e.left === "unchanged");
  assert.equal(board.signalChanges, 0);
  assert.ok(sameBytes(board.flash.subarray(0, 0x20000), before));
  assert.equal(board.mode, "foreign");
  board.stop();
});

test("a blank sensor board gets a blank settings partition too", async () => {
  const serial = unit();
  const board = serial.add(new sim.PretendBoard({ kind: "xiao", image: null, inLoader: true }));
  board.flash.fill(0x33, 0x9000, 0xf000);
  const { board: entry, parts } = loadBoard(release, "rid");
  const out = await flashDirect({ serial, esptool, port: await serial.requestPort(), role: "rid", board: entry, parts, hooks: recorder().hooks });
  assert.equal(out.blanked, true);
  assert.ok(board.flash.subarray(0x9000, 0xf000).every((b) => b === 0xff));
  assert.equal(board.signalChanges, 0);
  await out.io.close();
  board.stop();
});

test("a board that answers nothing at all ends with the BOOT button's instructions, and no reset was tried", async () => {
  const serial = unit();
  const board = serial.add(new sim.PretendBoard({ kind: "xiao", image: null }));      // an empty flash: the ROM has nothing to start
  const { board: entry, parts } = loadBoard(release, "rid");
  await assert.rejects(
    flashDirect({ serial, esptool, port: await serial.requestPort(), role: "rid", board: entry, parts, hooks: recorder().hooks }),
    (e) => e instanceof FlashError && e.at === "loader" && e.hint === "boot-button-silent" && e.left === "unchanged");
  assert.equal(board.signalChanges, 0);
  board.stop();
});

test("a restart over USB is never offered for a sensor, whatever it does", async () => {
  const serial = unit();
  const board = serial.add(new sim.PretendBoard({ kind: "xiao", image: null, foreign: true }));
  const { board: entry, parts } = loadBoard(release, "rf" in release.boards ? "rf" : "rid");
  const r = recorder({ "usb-reset": true });                     // even a person who would say yes is not asked
  await assert.rejects(
    flashDirect({ serial, esptool, port: await serial.requestPort(), role: "rid", board: entry, parts, hooks: r.hooks }),
    (e) => e instanceof FlashError && e.at === "loader");
  assert.deepEqual(r.seen.confirms, []);
  assert.equal(board.signalChanges, 0);
  assert.ok(!board.log.includes("wedged"));
  board.stop();
});
