// Flash a board through its own USB socket.
//
// The sequence is the benches' own (sensors/rid/detector/tools/portal_flash.sh,
// sensors/rf/tools/wb_flash.sh, tests/board_check.py --download), carried into
// a browser:
//
//   1. ask the running firmware what it is,
//   2. ask it to restart into the chip's ROM loader with its own command,
//   3. talk to the loader with no reset on DTR or RTS,
//   4. write the bootloader, the partition table and the application at their
//      places, each compared with the loader's MD5 of the flash,
//   5. leave with the chip's LP watchdog, which resets the whole chip and
//      clears the "start in the loader" latch,
//   6. wait for the new firmware's hello.
//
// A board that says nothing is tried as it is: it may sit in its loader already
// (the BOOT button, or a flash that was cut off).

import { BOARDS, CHIP_NAME, loaderLines, roleOfProject } from "./boards.js";
import { framed, md5, sleep } from "./bytes.js";
import { APP_HEAD_BYTES, readAppHead } from "./image.js";
import { identify } from "./identify.js";
import { GuardedPort, LineIO, waitForReturn } from "./port.js";

export const DIRECT_STEPS = [
  ["ask", "Ask the board what it is"],
  ["loader", "Restart it into its loader"],
  ["chip", "Read the chip"],
  ["write", "Write and compare"],
  ["restart", "Restart it"],
  ["hello", "Wait for its hello"],
];

// The ESP32-C5's LP watchdog (ESP-IDF 5.5.1, soc/esp32c5: lp_wdt_reg.h, lpwdt_ll.h).
const LP_WDT_CONFIG0 = 0x600b1c00;
const LP_WDT_CONFIG1 = 0x600b1c04;
const LP_WDT_WPROTECT = 0x600b1c18;
const LP_WDT_SWD_CONFIG = 0x600b1c1c;
const LP_WDT_SWD_WPROTECT = 0x600b1c20;
const LP_WDT_KEY = 0x50d83aa1;
const SWD_AUTO_FEED = 1 << 18;

/** What went wrong, where, and what state the board is in. */
export class FlashError extends Error {
  constructor(at, message, { left = "unchanged", hint = null, stopped = false } = {}) {
    super(message);
    this.name = "FlashError";
    this.at = at;
    this.left = left;         // "unchanged" | "loader" | "unknown"
    this.hint = hint;         // a key the page turns into instructions
    this.stopped = stopped;   // the person said stop: nothing went wrong
  }
}

function withDefaults(hooks = {}) {
  return {
    log: hooks.log ?? (() => {}),
    step: hooks.step ?? (() => {}),
    progress: hooks.progress ?? (() => {}),
    confirm: hooks.confirm ?? (async () => false),
    pickAgain: hooks.pickAgain ?? (async () => null),
  };
}

function terminal(H) {
  let line = "";
  return {
    clean() {},
    writeLine(text) { H.log(line + text); line = ""; },
    write(text) {
      line += text;
      if (line.includes("\n")) { H.log(line.replace(/[\r\n]+$/, "")); line = ""; }
    },
  };
}

/**
 * While a chip sits in its loader on USB, its watchdogs keep running and can
 * reset it in the middle of a write. Espressif's own tool switches the LP
 * watchdog off and lets the super watchdog feed itself; esptool-js does not
 * do it for this chip.
 */
async function quietWatchdogs(loader) {
  await loader.writeReg(LP_WDT_WPROTECT, LP_WDT_KEY);
  await loader.writeReg(LP_WDT_CONFIG0, 0);
  await loader.writeReg(LP_WDT_WPROTECT, 0);
  await loader.writeReg(LP_WDT_SWD_WPROTECT, LP_WDT_KEY);
  const swd = await loader.readReg(LP_WDT_SWD_CONFIG);
  await loader.writeReg(LP_WDT_SWD_CONFIG, (swd | SWD_AUTO_FEED) >>> 0);
  await loader.writeReg(LP_WDT_SWD_WPROTECT, 0);
}

/**
 * Restart the whole chip with its LP watchdog: unlock, a short stage, enable
 * with "reset the system" as the stage's action, lock. The four values are the
 * ones Espressif's tool writes for its watchdog reset.
 */
export async function watchdogReset(loader) {
  await loader.writeReg(LP_WDT_WPROTECT, LP_WDT_KEY);
  await loader.writeReg(LP_WDT_CONFIG1, 2000);
  await loader.writeReg(LP_WDT_CONFIG0, ((1 << 31) | (5 << 28) | (1 << 8) | 2) >>> 0);
  await loader.writeReg(LP_WDT_WPROTECT, 0);
}

/**
 * Meets the loader. Returns the esptool-js loader with its stub running.
 *
 * mode "no_reset": the port is in its loader already, and DTR and RTS are held back.
 * mode "usb_reset": the board is first restarted into its loader through DTR and
 * RTS, the way Espressif's tools do it. Only for a master's board, and only at
 * the person's word: see the guard in port.js for what it does to a sensor's chip.
 */
async function meetLoader(guard, esptool, H, attempts, mode = "no_reset") {
  const transport = new esptool.Transport(guard, false);
  // The rate stays at the ROM's: on USB it means nothing, and a change that
  // fails makes esptool-js try a reset through DTR and RTS.
  const loader = new esptool.ESPLoader({ transport, baudrate: 115200, romBaudrate: 115200, terminal: terminal(H), debugLogging: false });
  try {
    guard.allowSignals = mode === "usb_reset";
    try {
      await loader.detectChip(mode, attempts);
    } finally {
      guard.allowSignals = false;
    }
    if (!loader.chip || loader.chip.CHIP_NAME !== CHIP_NAME) {
      throw new FlashError("chip", `This is an ${loader.chip ? loader.chip.CHIP_NAME : "unknown chip"}, and every board of the unit is an ${CHIP_NAME}. Nothing was written.`);
    }
    await quietWatchdogs(loader);
    await loader.runStub();
    return { loader, transport };
  } catch (e) {
    try { await transport.disconnect(); } catch { /* the port has gone */ }
    throw e;
  }
}

/**
 * Flash one board through its own USB socket.
 *
 *   serial   navigator.serial
 *   esptool  { ESPLoader, Transport } of esptool-js
 *   port     the port the user picked
 *   role     "master" | "rid" | "rf": what the user chose to write
 *   board    that role's entry of the catalog
 *   parts    [{ kind, offset, data }]: the files, already fetched and checked
 *   wipe     also blank the settings partition
 *   hooks    log(text), step(key, state, detail), progress(done, total), confirm({...}) -> bool, pickAgain() -> port
 *
 * Resolves to what was found and done. Rejects with a FlashError.
 */
export async function flashDirect({ serial, esptool, port, role, board, parts, wipe = false, hooks }) {
  const H = withDefaults(hooks);
  const guard = new GuardedPort(port, { onBlocked: () => H.log("held back a change of DTR/RTS") });
  const out = { role, was: null, chip: null, mac: null, rev: null, now: null, settled: false };
  let id = (Date.now() % 100000) * 100 + 1;
  let session = null;
  let written = false;

  const comeBack = async (before, why) => {
    await guard.close();        // the old port object is done with, whatever the browser does with it
    let back = await waitForReturn(serial, guard.port, before, 9000);
    if (!back) {
      H.log(`the board did not come back by itself after ${why}`);
      back = await H.pickAgain(why);
    }
    if (!back) throw new FlashError("loader", "The board left USB and did not come back.", { left: written ? "unknown" : "unchanged", hint: "replug" });
    guard.swap(back);
  };

  try {
    // 1. What is on the port?
    H.step("ask", "run");
    let io = new LineIO(guard);
    try {
      await io.open();
    } catch (e) {
      throw new FlashError("open", "The port could not be opened: " + (e && e.message ? e.message : e), { hint: "busy" });
    }
    let who = await identify(io, { id: id++ });
    // A firmware has named itself: note it, and stop if it is not the board that was chosen.
    const heard = async () => {
      out.was = { role: who.role, version: who.version, git: who.git, from: "hello" };
      H.step("ask", "done", `${BOARDS[who.role].name}, firmware ${who.version ?? "of an unknown version"}`);
      if (who.role !== role) {
        const go = await H.confirm({ kind: "other-board", says: who.role, chosen: role, version: who.version });
        if (!go) {
          await io.close();
          throw new FlashError("ask", `The board says it is the ${BOARDS[who.role].noun}. Nothing was written.`, { stopped: true });
        }
      }
      if (who.role === "master" && who.caps.includes("flash")) {
        // A master that is flashing a sensor must not be restarted under it.
        const asked = id++;
        await io.write(`{"cmd":"get","id":${asked},"what":"flash"}`);
        const ack = await io.wait((line) => {
          try { const r = JSON.parse(line); return r && r.event === "ack" && r.id === asked ? r : null; } catch { return null; }
        }, 1500);
        const f = ack && ack.flash;
        if (f && (f.left === "loader" || ["receiving", "ready", "loader", "erasing", "writing", "verifying", "restarting"].includes(f.state))) {
          await io.close();
          throw new FlashError("ask", "This master is in the middle of flashing a sensor, or holds one in its loader. Finish that first. Nothing was written.");
        }
      }
    };
    if (who.role) await heard();
    else H.step("ask", "done", who.heard ? "it sends something that is none of the three firmwares" : "it says nothing: trying its loader");

    // 2. Into the loader, by the firmware's own command.
    H.step("loader", "run");
    const attempt = async (lines) => {
      const before = await serial.getPorts();
      for (const line of lines) {
        try { await io.write(line); } catch { break; }
      }
      const left = await io.waitLost(lines.length ? 2500 : 0);
      await io.release();
      if (left) await comeBack(before, "the restart into its loader");
      const meet = async () => {
        try {
          return await meetLoader(guard, esptool, H, 4);
        } catch (e) {
          if (e instanceof FlashError) throw e;
          H.log("no loader answered: " + (e && e.message ? e.message : e));
          return null;
        }
      };
      let met = await meet();
      if (!met && !(await serial.getPorts()).includes(guard.port)) {
        // The board left USB later than expected, while the loader was being called.
        await comeBack(before, "the restart into its loader");
        met = await meet();
      }
      return met;
    };
    const linesFor = (r) => { const l = loaderLines(r, id, framed); id += 2; return l; };
    const again = async () => { io = new LineIO(guard); await io.open(); await sleep(300); };
    let lines = who.role ? linesFor(who.role) : null;
    // A board that said nothing may sit in its loader already: try it as it is.
    session = await attempt(lines ? lines.first : []);
    if (!session && !who.role) {
      // No loader. A firmware that was slow to answer? The RF sensor's console
      // waits up to four seconds for its radio before it takes a command.
      await again();
      who = await identify(io, { id: id++, settleMs: 300, answerMs: 5000 });
      if (who.role) {
        await heard();
        lines = linesFor(who.role);
        session = await attempt(lines.first);
      } else {
        // Still nothing that names itself. Send the chosen board's own lines
        // blind: a firmware in a safe mode may take them without answering.
        const blind = linesFor(role);
        session = await attempt([...blind.first, ...blind.second]);
      }
    }
    if (!session && lines && lines.second.length) {
      // The firmware did not take its plain command: try the link's framed form.
      await again();
      session = await attempt(lines.second);
    }
    if (!session && role === "master") {
      // Nothing took the page's word. A new master runs its maker's firmware,
      // which knows none of our commands. A master's board can be restarted
      // into its loader over USB; a sensor's chip hangs when that is done to it,
      // so the person is asked, and only for the master.
      const go = await H.confirm({ kind: "usb-reset", heard: who.heard > 0 });
      if (go) {
        H.log("restarting the board into its loader through DTR and RTS, at the person's word");
        const before = await serial.getPorts();
        const meet = async (mode) => {
          try {
            return await meetLoader(guard, esptool, H, 3, mode);
          } catch (e) {
            if (e instanceof FlashError) throw e;
            H.log("no loader answered: " + (e && e.message ? e.message : e));
            return null;
          }
        };
        session = await meet("usb_reset");
        if (!session && !(await serial.getPorts()).includes(guard.port)) {
          await comeBack(before, "the restart into its loader");
          session = await meet("no_reset");      // it is in its loader now: no second reset
        }
        out.usbReset = true;
      }
    }
    if (!session) {
      throw new FlashError("loader", "The board did not enter its loader.", { hint: who.role ? "boot-button" : "boot-button-silent" });
    }
    const { loader, transport } = session;
    H.step("loader", "done");

    // 3. The chip, and what it carries now.
    H.step("chip", "run");
    const major = await loader.chip.getMajorChipVersion(loader);
    const minor = await loader.chip.getMinorChipVersion(loader);
    out.rev = `${major}.${minor}`;
    out.mac = await loader.chip.readMac(loader);
    out.chip = CHIP_NAME;
    let flashBytes = null;
    try {
      const sizeCode = ((await loader.readFlashId()) >> 16) & 0xff;
      if (sizeCode >= 0x12 && sizeCode <= 0x1c) flashBytes = 2 ** sizeCode;
    } catch {
      /* the size stays unknown */
    }
    out.flashBytes = flashBytes;
    let installed = null;
    let headRead = false;
    try {
      installed = readAppHead(await loader.readFlash(board.app_slot.offset, APP_HEAD_BYTES));
      headRead = true;
    } catch (e) {
      H.log("the application's header could not be read back: " + (e && e.message ? e.message : e));
    }
    out.installed = installed;
    if (!out.was && installed) {
      out.was = { role: roleOfProject(installed.project), version: installed.version, project: installed.project, from: "flash" };
    }
    H.step("chip", "done", `${CHIP_NAME} revision ${out.rev}, ${out.mac}` + (flashBytes ? `, ${flashBytes / 1048576} MB of flash` : ""));

    const installedRole = installed ? roleOfProject(installed.project) : null;
    const leaveUnchanged = async (message) => {
      // Nothing has been erased: send the board back to the firmware it has.
      try { await watchdogReset(loader); } catch { /* it is left in its loader */ }
      await sleep(400);
      try { await transport.disconnect(); } catch { /* gone already */ }
      session = null;
      throw new FlashError("chip", message, { stopped: true });
    };
    if (!who.role && installedRole && installedRole !== role) {
      const go = await H.confirm({ kind: "other-board", says: installedRole, chosen: role, version: installed.version });
      if (!go) await leaveUnchanged(`The board carries the ${BOARDS[installedRole].noun}'s firmware. Nothing was written.`);
    }
    if (flashBytes && flashBytes !== BOARDS[role].flashBytes) {
      const go = await H.confirm({ kind: "other-flash", chosen: role, flashBytes, expected: BOARDS[role].flashBytes });
      if (!go) await leaveUnchanged(`The board has ${flashBytes / 1048576} MB of flash, and the ${BOARDS[role].noun}'s board has ${BOARDS[role].flashBytes / 1048576} MB. Nothing was written.`);
    }

    // 4. Write, and compare each file with the loader's MD5 of the flash.
    H.step("write", "run");
    const files = parts.map((p) => ({ data: p.data, address: p.offset, kind: p.kind }));
    // A board that did not run this firmware before has nothing of it to keep,
    // and what lies where its settings will be is another firmware's: a new
    // master's maker keeps other things there. It starts with a blank partition.
    const fresh = headRead && who.role !== role && installedRole !== role;
    out.blanked = !!((wipe || fresh) && board.nvs);
    if (out.blanked) {
      if (fresh && !wipe) H.log("this board did not run this firmware before: its settings partition is blanked");
      files.splice(files.length - 1, 0, { data: new Uint8Array(board.nvs.size).fill(0xff), address: board.nvs.offset, kind: "settings" });
    }
    const total = files.reduce((n, f) => n + f.data.length, 0);
    const doneBefore = files.map((_, i) => files.slice(0, i).reduce((n, f) => n + f.data.length, 0));
    written = true;
    try {
      await loader.writeFlash({
        fileArray: files.map((f) => ({ data: f.data, address: f.address })),
        flashMode: "keep",
        flashFreq: "keep",
        flashSize: "keep",
        eraseAll: false,
        compress: true,
        calculateMD5Hash: (image) => md5(image),
        reportProgress: (index, sent, of) => {
          H.progress(doneBefore[index] + Math.round((files[index].data.length * sent) / Math.max(1, of)), total, files[index].kind);
        },
      });
    } catch (e) {
      throw new FlashError("write", "The write did not finish: " + (e && e.message ? e.message : e), { left: "loader", hint: "again" });
    }
    H.progress(total, total, "done");
    H.step("write", "done", `${parts.length} files, ${parts.reduce((n, p) => n + p.data.length, 0)} bytes, each compared` + (out.blanked ? "; settings partition blanked" : ""));

    // 5. Out of the loader.
    H.step("restart", "run");
    const before = await serial.getPorts();
    try {
      await watchdogReset(loader);
    } catch (e) {
      H.log("the watchdog's registers were not all acknowledged: " + (e && e.message ? e.message : e));
    }
    await sleep(600);
    try { await transport.disconnect(); } catch { /* the board has left USB, as it should */ }
    session = null;
    H.step("restart", "done");

    // 6. The new firmware's hello.
    H.step("hello", "run");
    let back = await waitForReturn(serial, guard.port, before, 9000);
    if (!back) back = await H.pickAgain("its restart");
    if (!back) {
      out.settled = false;
      H.step("hello", "warn", "the board did not come back on USB: unplug it and plug it in again");
      return out;
    }
    guard.swap(back);
    io = new LineIO(guard);
    await io.open();
    let now = { role: null };
    const hear = async (tries) => {
      for (let i = 0; i < tries && !now.role; i++) {
        now = await identify(io, { id: id++, settleMs: 700, answerMs: 1500 });
        if (!now.role && i + 1 < tries) await sleep(500);
      }
    };
    await hear(1);          // a master greets a reader within a second of its start
    if (!now.role && role === "master" && (major > 1 || minor >= 1)) {
      // Measured on a revision 1.2 master, 15 Nov 2026: after the loader's
      // watchdog restart the firmware runs and takes commands, but nothing it
      // sends reaches USB, and its own restart does not mend that. A restart
      // through RTS does: the one a flash from the firmware's build tools ends
      // with. The chip has said which revision it is; a revision 1.0 chip,
      // which hangs on this, never gets here.
      H.log("the firmware does not speak after the watchdog's restart: one more restart, through RTS (the chip is revision " + out.rev + ")");
      const beforeRts = await serial.getPorts();
      guard.allowSignals = true;
      try {
        await guard.setSignals({ dataTerminalReady: false, requestToSend: true });
        await sleep(150);
        await guard.setSignals({ dataTerminalReady: false, requestToSend: false });
        out.rtsRestart = true;
      } catch (e) {
        H.log("the restart through RTS could not be sent: " + (e && e.message ? e.message : e));
      } finally {
        guard.allowSignals = false;
      }
      if (await io.waitLost(1200)) {
        await io.release();
        const again = await waitForReturn(serial, guard.port, beforeRts, 9000);
        if (again) {
          guard.swap(again);
          io = new LineIO(guard);
          await io.open();
        }
      }
      await hear(4);
    } else {
      await hear(3);
    }
    out.io = io;          // left open for the page, which may go on talking to a master
    out.guard = guard;
    if (now.role) {
      out.now = { role: now.role, version: now.version, git: now.git, caps: now.caps, ports: now.ports, record: now.record };
      out.settled = now.role === role;
      H.step("hello", out.settled ? "done" : "warn", `${BOARDS[now.role].name}, firmware ${now.version ?? "of an unknown version"}`);
    } else {
      H.step("hello", "warn", "it was written and compared, and it has not said hello yet");
    }
    return out;
  } catch (e) {
    if (session) {
      try { await session.transport.disconnect(); } catch { /* nothing to close */ }
    } else {
      await guard.close();
    }
    const error = e instanceof FlashError ? e : new FlashError("unknown", e && e.message ? e.message : String(e), { left: written ? "loader" : "unchanged" });
    error.port = guard.port;      // the board's port as it is now, for another try
    throw error;
  }
}

/**
 * Look at a board without writing: its firmware's hello if it runs one.
 * Leaves the port open in line mode and returns { io, guard, who }.
 */
export async function look(port) {
  const guard = new GuardedPort(port);
  const io = new LineIO(guard);
  await io.open();
  const who = await identify(io, { id: (Date.now() % 100000) * 100 });
  return { io, guard, who };
}
