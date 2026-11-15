// Pretend boards: a stand-in for Web Serial with made-up ESP32-C5 boards behind
// it, so that the page and its tests can run with nothing plugged in.
//
// A stand-in to try the page against, not a model of the chip. It answers the
// way the page's code and esptool-js 0.7.1 ask, and where the real chip's
// behaviour is not known the comment says what was assumed. Written from
// Espressif's description of the serial protocol and from what the three
// firmwares say on USB (read in the firmware's repository, 15 Nov 2026). Nothing here has
// met a real board.
//
// What a pretend board does:
//   - runs "firmware": whatever application its pretend flash holds at 0x10000.
//     A master greets with m_hello and takes get / reboot / set / flash; a
//     Remote ID sensor takes get hello and boot; an RF sensor has the text
//     console with INFO and BOOTLOADER.
//   - restarts into a ROM loader on those commands, drops off USB and comes
//     back as a new port object, as a USB device does in Chrome.
//   - in the loader, speaks SLIP: SYNC, the register commands, the security
//     info, the stub upload, compressed and plain flash writes, MD5, read flash.
//   - a revision 1.0 chip that is reset through DTR and RTS hangs until its
//     power is cycled (measured on the benches, 13 and 14 Nov 2026). The page
//     must never do that, and the tests check that it never does.
//   - its LP watchdog, written the way the page writes it, restarts the chip.

import { crc32, hex8, md5 as md5hex, concat, framed, unframed } from "../js/bytes.js";
import { readAppHead } from "../js/image.js";

const CHIP_ESP32C5 = 23;
const APP_OFFSET = 0x10000;
const SLIP_END = 0xc0;
const enc = new TextEncoder();

// Loader commands.
const C = {
  FLASH_BEGIN: 0x02, FLASH_DATA: 0x03, FLASH_END: 0x04, MEM_BEGIN: 0x05, MEM_END: 0x06, MEM_DATA: 0x07,
  SYNC: 0x08, WRITE_REG: 0x09, READ_REG: 0x0a, SPI_SET_PARAMS: 0x0b, SPI_ATTACH: 0x0d, CHANGE_BAUD: 0x0f,
  DEFL_BEGIN: 0x10, DEFL_DATA: 0x11, DEFL_END: 0x12, FLASH_MD5: 0x13, SECURITY_INFO: 0x14,
  ERASE_FLASH: 0xd0, ERASE_REGION: 0xd1, READ_FLASH: 0xd2, RUN_USER_CODE: 0xd3,
};
const REG = {
  MAGIC: 0x40001000, EFUSE_MAC0: 0x600b4844, EFUSE_MAC1: 0x600b4848, EFUSE_VER: 0x600b484c,
  UARTDEV_BUF_NO: 0x4085f514, UART_CLKDIV: 0x60000014,
  WDT_CONFIG0: 0x600b1c00, WDT_CONFIG1: 0x600b1c04, WDT_WPROTECT: 0x600b1c18,
  SWD_CONFIG: 0x600b1c1c, SWD_WPROTECT: 0x600b1c20,
  SPI_CMD: 0x60003000, SPI_USR2: 0x60003020, SPI_W0: 0x60003058,
};
const WDT_KEY = 0x50d83aa1;

const u32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const rd32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slip(packet) {
  const out = [SLIP_END];
  for (const b of packet) {
    if (b === 0xc0) out.push(0xdb, 0xdc);
    else if (b === 0xdb) out.push(0xdb, 0xdd);
    else out.push(b);
  }
  out.push(SLIP_END);
  return new Uint8Array(out);
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function lost() {
  return new DOMException("The device has been lost.", "NetworkError");
}

/**
 * A made-up application image: right in every field a loader, the master or
 * this page looks at, and noise otherwise. `size` is a multiple of 16.
 */
export async function makeImage({ project, version, size = 64 * 1024, chip = CHIP_ESP32C5, seed = 1, date = "Nov 15 2026", time = "12:00:00" }) {
  if (size % 16 || size < 0x120 + 96) throw new Error("size must be a multiple of 16 and at least 384");
  const end = size - 32;
  const length = end - 33;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out[0] = 0xe9; out[1] = 1; out[2] = 2; out[3] = 0x3f;       // one segment, dio, 8MB, 80m
  view.setUint32(4, 0x40800000, true);
  out[8] = 0xee;
  view.setUint16(12, chip, true);
  view.setUint16(15, 100, true);
  view.setUint16(17, 199, true);
  out[23] = 1;
  view.setUint32(24, 0x42000020, true);
  view.setUint32(28, length, true);
  let s = seed >>> 0 || 1;
  for (let i = 32; i < 32 + length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[i] = s & 255;
  }
  out.fill(0, 32, 32 + 256);
  view.setUint32(32, 0xabcd5432, true);
  out.set(enc.encode(version), 48);
  out.set(enc.encode(project), 80);
  out.set(enc.encode(time), 112);
  out.set(enc.encode(date), 128);
  out.set(enc.encode("v5.5.1"), 144);
  let checksum = 0xef;
  for (let i = 32; i < 32 + length; i++) checksum ^= out[i];
  out[end - 1] = checksum;
  out.set(new Uint8Array(await crypto.subtle.digest("SHA-256", out.subarray(0, end))), end);
  return out;
}

const PROJECT_ROLE = { uas_detector_master: "master", c5_drone_detector: "rid", widscan58: "rf" };
const ROLE_FW = { master: "uas-detector-master", rid: "c5_drone_detector", rf: "fpv-detector" };
const SLOT_BYTES = { rid: 0x3f0000, rf: 0x1f0000 };

function versionAtLeast(version, want) {
  const a = String(version).split(".").map((n) => parseInt(n, 10));
  const b = want.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < b.length; i++) {
    if (!(a[i] >= 0)) return false;
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/** The look-alike of a SerialPort. One exists for each time a board appears on USB. */
class PretendPort extends EventTarget {
  constructor(board) {
    super();
    this.board = board;
    this.connected = true;
    this._open = false;
    this._dead = false;
    this._readable = null;
    this._writable = null;
    this._rc = null;
    this._pending = [];
  }
  getInfo() { return { usbVendorId: 0x303a, usbProductId: 0x1001 }; }
  async open(options) {
    if (this._dead) throw lost();
    if (this._open) throw new DOMException("The port is already open.", "InvalidStateError");
    if (!options || !options.baudRate) throw new TypeError("baudRate is required");
    this._open = true;
    this._pending = [];
    this.board._opened();
  }
  async close() {
    if (this._readable && this._readable.locked) throw new TypeError("Cannot close: the readable is locked");
    if (this._writable && this._writable.locked) throw new TypeError("Cannot close: the writable is locked");
    this._open = false;
    this._readable = this._writable = this._rc = null;
  }
  async forget() { this.board.granted = false; }
  get readable() {
    if (!this._open || this._dead) return null;
    if (!this._readable) {
      this._readable = new ReadableStream({
        start: (c) => {
          this._rc = c;
          for (const chunk of this._pending.splice(0)) c.enqueue(chunk);
        },
        cancel: () => { this._readable = null; this._rc = null; },
      });
    }
    return this._readable;
  }
  get writable() {
    if (!this._open || this._dead) return null;
    if (!this._writable) {
      this._writable = new WritableStream({
        write: (chunk) => {
          if (this._dead) throw lost();
          this.board._rx(new Uint8Array(chunk));
        },
      });
    }
    return this._writable;
  }
  async setSignals(signals) {
    if (!this._open) throw new DOMException("The port is closed.", "InvalidStateError");
    this.board._signals(signals);
  }
  async getSignals() { return { dataCarrierDetect: false, clearToSend: false, ringIndicator: false, dataSetReady: false }; }
  /** Bytes from the board to whoever reads. */
  _deliver(bytes) {
    if (!this._open || this._dead) return;
    if (this._rc) {
      try { this._rc.enqueue(bytes); } catch { /* the stream was cancelled under us */ }
    } else {
      this._pending.push(bytes);
      if (this._pending.length > 512) this._pending.splice(0, 128);
    }
  }
  /** The board has left USB. */
  _lose() {
    this._dead = true;
    this.connected = false;
    if (this._rc) {
      try { this._rc.error(lost()); } catch { /* closed already */ }
    }
    this._rc = null;
    this._readable = this._writable = null;
  }
}

/** The look-alike of navigator.serial. `choose(boards, options)` stands for the browser's chooser. */
export class PretendSerial extends EventTarget {
  constructor() {
    super();
    this.boards = [];
    this.choose = async (boards) => boards[0] ?? null;
  }
  add(board) {
    board.serial = this;
    this.boards.push(board);
    return board;
  }
  async getPorts() {
    return this.boards.filter((b) => b.granted && b.port).map((b) => b.port);
  }
  async requestPort(options) {
    const present = this.boards.filter((b) => b.port);
    const board = await this.choose(present, options);
    if (!board) throw new DOMException("No port selected by the user.", "NotFoundError");
    board.granted = true;
    return board.port;
  }
  _announce(type, port) {
    const event = new Event(type);
    event.port = port;
    this.dispatchEvent(event);
  }
}

/**
 * One pretend board.
 *
 *   name         what the pretend chooser calls it
 *   kind         "master" (32 MB of flash, revision 1.2) or "xiao" (8 MB, revision 1.0)
 *   image        the application it starts with, or null for an empty flash
 *   pace         0 for tests; 1 makes erases and writes take a moment, so a person can watch
 *   awayMs       how long it is off USB when it restarts
 *   sameObject   come back as the same port object (other browsers may; Chrome hands out a new one)
 *   keepsUsb     stay on USB through a restart asked for by firmware
 *   inLoader     start in the ROM loader, as with the BOOT button held
 *   deafToPlain  a sensor that ignores the plain loader command and takes only the link's framed one
 */
export class PretendBoard {
  constructor({ name, kind = "xiao", image = null, mac = null, pace = 0, awayMs = 60, sameObject = false, keepsUsb = false,
                inLoader = false, deafToPlain = false, git = "abc1234" } = {}) {
    this.name = name ?? kind;
    this.kind = kind;
    this.flashBytes = kind === "master" ? 32 * 1024 * 1024 : 8 * 1024 * 1024;
    this.rev = kind === "master" ? { major: 1, minor: 2 } : { major: 1, minor: 0 };
    this.mac = mac ?? (kind === "master" ? [0x10, 0xbd, 0xa3, 0xdf, 0x00, 0x01] : [0x10, 0xbd, 0xa3, 0xc9, 0x00, 0x02]);
    this.flash = new Uint8Array(this.flashBytes).fill(0xff);
    if (image) this.flash.set(image, APP_OFFSET);
    this.pace = pace;
    this.awayMs = awayMs;
    this.sameObject = sameObject;
    this.keepsUsb = keepsUsb;
    this.deafToPlain = deafToPlain;
    this.git = git;
    this.serial = null;
    this.granted = false;
    this.port = new PretendPort(this);
    this.mode = "off";
    this.latch = false;          // "start in the loader", set by firmware, cleared by a whole-chip reset
    this.links = {};             // a master's two ports: { a: board, b: board }
    this.masterOf = null;        // a sensor's master, if it is wired to one
    this.canFlash = null;        // a master: true/false to force the `flash` capability; null = by version
    this.timers = new Set();
    this.q = Promise.resolve();
    this.log = [];               // what happened, for tests: ["dtr-rts", "wdt-reset", "write 0x10000 982912", ...]
    this.signalChanges = 0;
    this.seq = 0;
    this.bootMs = Date.now();
    this.settings = { sg_margin_db: 10 };
    this._start(inLoader ? "loader" : "boot");
  }

  // --- power and resets ---------------------------------------------------
  _clearTimers() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers.clear();
  }
  _later(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }
  _every(ms, fn) {
    const t = setInterval(fn, ms);
    this.timers.add(t);
    return t;
  }
  /** Stop every timer: a test is done with this board. */
  stop() { this._clearTimers(); }

  _start(how) {
    this._clearTimers();
    this.rxText = "";
    this.slipBuf = [];
    this.slipIn = false;
    this.slipEsc = false;
    this.stub = false;
    this.regs = new Map();
    this.wdt = { open: false, ticks: 0 };
    this.defl = null;
    this.reading = null;
    this.linkedOnUsb = false;
    this.bootMs = Date.now();
    this.seq = 0;
    this.mflash = null;
    if (how === "wedged") { this.mode = "wedged"; return; }
    if (how === "loader" || this.latch) {
      this.mode = "loader";
      this._say("ESP-ROM:esp32c5-eco2-20250121\r\nBuild:Jan 21 2025\r\nrst:0xc (SW_CPU),boot:0x4 (DOWNLOAD(USB/UART0))\r\nwaiting for download\r\n");
      return;
    }
    const head = readAppHead(this.flash.subarray(APP_OFFSET, APP_OFFSET + 0x120));
    this.app = head && head.chipId === CHIP_ESP32C5 ? { ...head, role: PROJECT_ROLE[head.project] ?? null } : null;
    if (!this.app) { this.mode = "blank"; return; }     // nothing to start: the ROM loops and USB says nothing useful
    this.mode = "app";
    if (this.app.role === "master") this._every(1000, () => this._masterStatus());
    if (this.app.role === "rid") this._every(1000, () => this._record({ event: "status", radio: "run", heap: 96000 }));
    if (this.port && this.port._open) this._opened();
  }

  /** The whole chip restarts: the LP watchdog, or its power. Clears the loader latch. */
  _systemReset(why) {
    this.log.push(why);
    this.latch = false;
    this._usbCycle(() => this._start("boot"));
  }
  /** Firmware restarts the chip into its ROM loader. */
  _toLoader() {
    this.log.push("fw-to-loader");
    this.latch = true;
    if (this.keepsUsb) { this._start("loader"); return; }
    this._usbCycle(() => this._start("loader"));
  }
  _usbCycle(then) {
    this._clearTimers();
    this.mode = "off";
    const old = this.port;
    if (old) {
      this.port = null;
      old._lose();
      if (this.serial) this.serial._announce("disconnect", old);
    }
    this._later(this.awayMs, () => {
      if (this.sameObject && old) {
        old._dead = false; old._open = false; old.connected = true; old._pending = [];
        this.port = old;
      } else {
        this.port = new PretendPort(this);
      }
      then();
      if (this.serial) this.serial._announce("connect", this.port);
    });
  }
  /** A person unplugs every supply and plugs it in again. */
  powerCycle() { this._systemReset("power-cycle"); }

  /** DTR and RTS, as the USB-Serial/JTAG controller reads them. */
  _signals(signals) {
    this.signalChanges++;
    this.log.push("dtr-rts");
    const was = { dtr: this.dtr ?? false, rts: this.rts ?? false };
    if (signals.dataTerminalReady !== undefined) this.dtr = !!signals.dataTerminalReady;
    if (signals.requestToSend !== undefined) this.rts = !!signals.requestToSend;
    if (this.rts && !was.rts) this.bootSel = was.dtr;            // reset asserted: the boot pin as DTR had it
    if (!this.rts && was.rts && this.mode !== "off") {           // reset released
      if (this.rev.major === 1 && this.rev.minor === 0) {
        // Measured on revision 1.0: the ROM hangs with USB dead until a whole-chip reset.
        this.log.push("wedged");
        this._clearTimers();
        this.mode = "wedged";
      } else if (this.bootSel) {
        this.log.push("usb-reset-to-loader");
        this._usbCycle(() => this._start("loader"));
      } else {
        this.log.push("usb-reset");
        this._usbCycle(() => this._start("boot"));              // the latch outlives it, as measured on the master
      }
    }
  }

  // --- bytes --------------------------------------------------------------
  _say(text) { this._send(enc.encode(text)); }
  _send(bytes) { if (this.port) this.port._deliver(bytes); }
  _opened() {
    if (this.mode === "app" && this.app.role === "master") this._later(150, () => this._masterHello());
  }
  _rx(bytes) {
    this.q = this.q.then(() => this._handle(bytes)).catch((e) => { this.log.push("sim-error " + (e && e.message)); });
    return this.q;
  }
  async _handle(bytes) {
    if (this.mode === "loader") {
      for (const b of bytes) {
        if (b === SLIP_END) {
          if (this.slipIn && this.slipBuf.length) {
            const packet = new Uint8Array(this.slipBuf);
            this.slipBuf = [];
            this.slipIn = false;
            await this._packet(packet);
            if (this.mode !== "loader") return;
          } else {
            this.slipIn = true;
            this.slipBuf = [];
          }
          this.slipEsc = false;
        } else if (this.slipIn) {
          if (this.slipEsc) { this.slipBuf.push(b === 0xdc ? 0xc0 : b === 0xdd ? 0xdb : b); this.slipEsc = false; }
          else if (b === 0xdb) this.slipEsc = true;
          else this.slipBuf.push(b);
        }
      }
      return;
    }
    if (this.mode !== "app") return;
    this.rxText += new TextDecoder().decode(bytes);
    let cut;
    while ((cut = this.rxText.indexOf("\n")) >= 0) {
      const line = this.rxText.slice(0, cut).replace(/\r$/, "");
      this.rxText = this.rxText.slice(cut + 1);
      if (line) this._line(line);
      if (this.mode !== "app") return;
    }
    if (this.rxText.length > 8192) this.rxText = "";
  }

  // --- firmware -----------------------------------------------------------
  _record(members, { framedOut = false } = {}) {
    const text = JSON.stringify({ schema: 1, ...members, seq: this.seq++, uptime_ms: Date.now() - this.bootMs });
    this._say((framedOut ? framed(text) : text) + "\n");
  }
  _line(line) {
    const role = this.app.role;
    if (role === "rf" && !line.startsWith("{")) return this._rfConsole(line);
    const isFramed = unframed(line) !== line;
    let msg;
    try { msg = JSON.parse(unframed(line)); } catch { msg = null; }
    if (!msg || typeof msg !== "object") {
      if (role === "rf") this._say("ERR unknown\n");
      return;
    }
    if (role === "master") return this._masterCmd(msg);
    if (role === "rid" || role === "rf") return this._sensorCmd(msg, isFramed);
  }
  _sensorHello() {
    const role = this.app.role;
    return {
      event: "hello", link: 1, role, fw: ROLE_FW[role], fw_ver: this.app.version, git: this.git, board: "xiao_esp32c5",
      mac: this.mac.map((b) => b.toString(16).padStart(2, "0")).join(":"), reset: "poweron", radio: "run",
      caps: role === "rid" ? ["dwell", "profile", "jitter", "subghz", "download"] : ["focus", "cadence", "bands", "spectrum", "selftest", "download"],
      cfg_id: 0,
    };
  }
  _sensorCmd(msg, isFramed) {
    const role = this.app.role;
    // The RF sensor's USB port is its text console until a framed heartbeat moves the link there.
    if (role === "rf" && !isFramed) { this._say("ERR unknown\n"); return; }
    if (msg.cmd === "hb") { if (isFramed) this.linkedOnUsb = true; return; }
    const out = { framedOut: isFramed };
    const ack = (extra = {}) => this._record({ event: "ack", id: msg.id, ok: true, ...extra }, out);
    if (msg.cmd === "get" && msg.what === "hello") { this._record(this._sensorHello(), out); ack(); return; }
    if (msg.cmd === "get") { ack(); return; }
    if (msg.cmd === "boot") {
      if (msg.mode !== "download" && msg.mode !== "restart") {
        this._record({ event: "ack", id: msg.id, ok: false, err: "bad_arg", key: "mode" }, out);
        return;
      }
      if (msg.mode === "download" && this.deafToPlain && !isFramed) return;
      ack();
      if (msg.mode === "download") this._later(100, () => this._toLoader());
      else this._later(100, () => this._systemReset("fw-restart"));
      return;
    }
    this._record({ event: "ack", id: msg.id, ok: false, err: "unsupported" }, out);
  }
  _rfConsole(line) {
    if (line === "INFO") this._say(`INFO widscan58|esp32c5|7|${this.app.version}|2026-11-15T09:00:00+01:00|phy 1.2\n`);
    else if (line === "BOOTLOADER") { this._say("OK BOOTLOADER\n"); this._later(100, () => this._toLoader()); }
    else if (line === "REBOOT") { this._say("OK REBOOT\n"); this._later(100, () => this._systemReset("fw-restart")); }
    else this._say("ERR unknown\n");
  }

  // --- a master's firmware --------------------------------------------------
  _caps() {
    const caps = ["levels", "seek", "battery", "location", "calibrate", "card", "walk_log"];
    const can = this.canFlash ?? versionAtLeast(this.app.version, "0.13.0");
    if (can) caps.push("flash");
    return caps;
  }
  _portEntry(letter) {
    const s = this.links[letter];
    const why = this.mflash && this.mflash.port === letter && this.mflash.busy ? "flashing" : undefined;
    if (!s || s.mode !== "app" || !s.app || !s.app.role || why) {
      return { port: letter, state: "DOWN", role: null, fw: null, fw_ver: null, git: null, board: null, mac: null, reset: null, caps: [], ...(why ? { why } : {}) };
    }
    const h = s._sensorHello();
    return { port: letter, state: "UP", role: h.role, fw: h.fw, fw_ver: h.fw_ver, git: h.git, board: h.board, mac: h.mac, reset: h.reset, caps: h.caps };
  }
  _masterHello() {
    if (this.mode !== "app") return;
    this._record({
      event: "m_hello", fw: "uas-detector-master", fw_ver: this.app.version, git: this.git, board: "pretend", link: 1, crc_ok: true,
      caps: this._caps(), first_hb_ms: 24, settings: { sensitivity: "normal", ...this.settings, passthrough: false, walk_log: false },
      ports: ["a", "b"].map((l) => this._portEntry(l)),
    });
  }
  _masterStatus() {
    if (this.mode !== "app" || !this.port || !this.port._open) return;
    const rec = {
      event: "m_status", level: "CLEAR", coverage: "full", missing: [], battery_mv: 4010, battery_pct: 82, location: null, clock: false,
      ports: ["a", "b"].map((l) => { const p = this._portEntry(l); return { port: l, state: p.state, role: p.role, ...(p.why ? { why: p.why } : {}) }; }),
      known: 0, card: { state: "none" },
    };
    if (this.mflash && (this.mflash.busy || this.mflash.rec.left === "loader")) rec.flash = this.mflash.rec;
    this._record(rec);
  }
  _masterCmd(msg) {
    const ack = (extra = {}) => this._record({ event: "ack", id: msg.id, ok: true, ...extra });
    const no = (err, key, extra = {}) => this._record({ event: "ack", id: msg.id, ok: false, err, ...(key ? { key } : {}), ...extra });
    switch (msg.cmd) {
      case "get":
        if (msg.what === "hello") { this._masterHello(); return ack(); }
        if (msg.what === "status") { this._masterStatus(); return ack(); }
        if (msg.what === "flash") return ack({ flash: this.mflash ? this.mflash.rec : null });
        if (msg.what === "settings") return ack({ settings: this.settings });
        return no("bad_arg", "what");
      case "set":
        if (msg.cfg && typeof msg.cfg === "object") Object.assign(this.settings, msg.cfg);
        this.log.push("set " + JSON.stringify(msg.cfg ?? null));
        return ack();
      case "reboot":
        if (this.mflash && this.mflash.busy) return no("busy", "flash");
        ack();
        if (msg.mode === "download") this._later(100, () => this._toLoader());
        else this._later(100, () => this._systemReset("fw-restart"));
        return;
      case "flash":
        if (!this._caps().includes("flash")) return no("unsupported", "flash");
        return this._masterFlash(msg, ack, no);
      default:
        return no("unsupported");
    }
  }

  // The master's sensor flasher, as master/README.md of the sensor-flash branch describes its stream.
  _flashRec(state, extra = {}) {
    const f = this.mflash;
    f.rec = { state, port: f.port, role: f.role, by: "usb", size: f.size, offset: APP_OFFSET, version: f.version ?? null, ...extra };
    this._record({ event: "flash", ...f.rec });
  }
  _masterFlash(msg, ack, no) {
    const f = this.mflash;
    if ("data" in msg) {
      if (!f || f.rec.state !== "receiving") return no("not_found", "flash");
      if (msg.off !== f.got) return no("range", "off", { want: f.got });
      let bytes;
      try { bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0)); } catch { return no("bad_arg", "data"); }
      if (!bytes.length || bytes.length > 672 || f.got + bytes.length > f.size) return no("range", "data");
      if (f.got === 0) {
        if (bytes[0] !== 0xe9) { this.mflash = null; return no("bad_arg", "image"); }
        if ((bytes[12] | (bytes[13] << 8)) !== CHIP_ESP32C5) { this.mflash = null; return no("bad_arg", "chip"); }
      }
      f.image.set(bytes, f.got);
      f.got += bytes.length;
      if (f.got >= 0x120 && !f.checked) {
        f.checked = true;
        const head = readAppHead(f.image.subarray(0, 0x120));
        if (!head) { this.mflash = null; return no("bad_arg", "image"); }
        if (PROJECT_ROLE[head.project] !== f.role) { this.mflash = null; return no("bad_arg", "project"); }
        f.version = head.version;
      }
      if (f.got === f.size) {
        if (hex8(crc32(f.image)) !== f.crc32 || md5hex(f.image) !== f.md5) { this.mflash = null; return no("bad_arg", "crc32"); }
        f.rec = { ...f.rec, state: "ready", got: f.got, version: f.version };
        return ack({ got: f.got, ready: true });
      }
      f.rec.got = f.got;
      return ack({ got: f.got });
    }
    if (msg.go) {
      if (!f || (f.rec.state !== "ready" && f.rec.left !== "loader")) return no("not_found", "flash");
      ack({ flash: f.rec });
      this._runFlash();
      return;
    }
    if (msg.cancel) {
      if (!f) return no("not_found", "flash");
      if (f.busy) return no("busy", "erased");
      this._flashRec("cancelled", { left: "unchanged" });
      this.mflash = null;
      return ack({ flash: null });
    }
    if (msg.probe) {
      if (f && f.busy) return no("busy", "flash");
      const s = this.links[msg.port];
      if (!s || s.mode !== "app") return no("busy", "port");
      this.mflash = { port: msg.port, role: s.app.role, size: 0, busy: true, rec: {} };
      this._flashRec("loader", { probe: true });
      ack({ flash: this.mflash.rec });
      this._later(40 + 400 * this.pace, () => {
        this._flashRec("done", { probe: true, chip: 23, rev: 100, baud: 921600, asked_baud: 921600, xtal_khz: 48000, rom_xtal_mhz: 48,
                                 role: s.app.role, now: s.app.version, reset: "poweron", ms: 900 });
        this.mflash = null;
      });
      return;
    }
    // Begin.
    if (f && (f.busy || f.rec.state === "receiving" || f.rec.state === "ready" || f.rec.left === "loader")) return no("busy", "flash");
    if (msg.role !== "rid" && msg.role !== "rf") return no("bad_arg", "role");
    const letter = msg.port ?? ["a", "b"].find((l) => this._portEntry(l).role === msg.role);
    if (!letter) return no("not_found", "role");
    const entry = this._portEntry(letter);
    if (entry.state !== "UP") return no("busy", "port");
    if (entry.role !== msg.role) return no("bad_arg", "role");
    if (!(msg.size > 0x120) || msg.size > SLOT_BYTES[msg.role]) return no("range", "size");
    if (typeof msg.crc32 !== "string" || !/^[0-9A-Fa-f]{8}$/.test(msg.crc32)) return no("bad_arg", "crc32");
    if (typeof msg.md5 !== "string" || !/^[0-9a-f]{32}$/.test(msg.md5)) return no("bad_arg", "md5");
    this.mflash = { port: letter, role: msg.role, size: msg.size, crc32: msg.crc32.toUpperCase(), md5: msg.md5, got: 0,
                    image: new Uint8Array(msg.size), busy: false, was: entry.fw_ver, wasGit: entry.git, rec: {} };
    this.mflash.rec = { state: "receiving", port: letter, role: msg.role, by: "usb", size: msg.size, offset: APP_OFFSET, got: 0 };
    return ack({ piece: 672, flash: this.mflash.rec });
  }
  async _runFlash() {
    const f = this.mflash;
    const sensor = this.links[f.port];
    const started = Date.now();
    f.busy = true;
    const wait = (ms) => sleep(20 + ms * this.pace);
    try {
      this._flashRec("loader");
      sensor.log.push("master-boot-download");
      sensor._clearTimers();
      sensor.mode = "held";                   // in its loader, on the link's wires: off its own USB console
      await wait(600);
      this._flashRec("erasing", { baud: 921600, try: 1 });
      await wait(900);
      for (let pct = 0; pct <= 100; pct += 10) {
        this._flashRec("writing", { baud: 921600, try: 1, pct });
        await wait(180);
      }
      sensor.flash.fill(0xff, APP_OFFSET, APP_OFFSET + ((f.size + 0xfff) & ~0xfff));
      sensor.flash.set(f.image, APP_OFFSET);
      sensor.log.push(`master-write 0x${APP_OFFSET.toString(16)} ${f.size}`);
      this._flashRec("verifying", { baud: 921600, try: 1 });
      await wait(400);
      this._flashRec("restarting", { baud: 921600, try: 1 });
      sensor.latch = false;
      sensor._start("boot");
      await wait(700);
      const now = sensor.app ? sensor.app.version : null;
      this._flashRec("done", { baud: 921600, try: 1, was: f.was, was_git: f.wasGit, now, now_git: sensor.git, reset: "poweron",
                               version_ok: now === f.version, ms: Date.now() - started });
      this.mflash = null;
    } catch (e) {
      this._flashRec("failed", { at: "write", why: String(e && e.message), left: "loader" });
      f.busy = false;
    }
  }

  // --- the ROM loader, and its stub -------------------------------------------
  _reply(op, { value = 0, data = new Uint8Array(0), failed = 0, error = 0 } = {}) {
    const status = this.stub ? new Uint8Array([failed, error]) : new Uint8Array([failed, error, 0, 0]);
    const body = concat(data, status);
    this._send(slip(concat(new Uint8Array([1, op, body.length & 255, body.length >> 8]), u32(value), body)));
  }
  async _packet(p) {
    if (this.reading && p.length === 4) return this._readFlashAck(rd32(p, 0));
    if (p.length < 8 || p[0] !== 0) return;
    const op = p[1];
    const size = p[2] | (p[3] << 8);
    const checksum = rd32(p, 4);
    const data = p.subarray(8);
    if (size !== data.length) return this._reply(op, { failed: 1, error: 5 });
    const w = (i) => rd32(data, i * 4);
    switch (op) {
      case C.SYNC:
        for (let i = 0; i < 8; i++) this._reply(op, { value: this.stub ? 0 : 0x20120707 });
        return;
      case C.READ_REG:
        return this._reply(op, { value: this._readReg(w(0)) });
      case C.WRITE_REG:
        this._writeReg(w(0), w(1));
        return this._reply(op);
      case C.SECURITY_INFO: {
        const info = concat(u32(0), new Uint8Array(8), u32(CHIP_ESP32C5), u32(100));
        return this._reply(op, { data: info });
      }
      case C.MEM_BEGIN:
      case C.MEM_DATA:
      case C.SPI_ATTACH:
      case C.SPI_SET_PARAMS:
      case C.CHANGE_BAUD:
      case C.FLASH_END:
      case C.DEFL_END:
        return this._reply(op);
      case C.MEM_END:
        this._reply(op);
        if (w(1) !== 0) {                       // an entry point: the stub starts and greets
          this.stub = true;
          this._send(slip(enc.encode("OHAI")));
        }
        return;
      case C.FLASH_BEGIN: {
        const [erase, blocks, block, offset] = [w(0), w(1), w(2), w(3)];
        if (offset + erase > this.flashBytes) return this._reply(op, { failed: 1, error: 6 });
        this._erase(offset, erase);
        this.plain = { offset, block, blocks };
        await sleep(this.pace * Math.min(1500, 200 + erase / 2000));
        return this._reply(op);
      }
      case C.FLASH_DATA: {
        const [length, seq] = [w(0), w(1)];
        const block = data.subarray(16, 16 + length);
        if (!this.plain || block.length !== length) return this._reply(op, { failed: 1, error: 6 });
        if (this._sum(block) !== (checksum & 255)) return this._reply(op, { failed: 1, error: 7 });
        this.flash.set(block, this.plain.offset + seq * this.plain.block);
        return this._reply(op);
      }
      case C.DEFL_BEGIN: {
        const [size_, blocks, , offset] = [w(0), w(1), w(2), w(3)];
        if (offset + size_ > this.flashBytes) return this._reply(op, { failed: 1, error: 6 });
        this._erase(offset, size_);
        this.defl = { offset, size: size_, blocks, parts: [], next: 0 };
        await sleep(this.pace * Math.min(1500, 200 + size_ / 2000));
        return this._reply(op);
      }
      case C.DEFL_DATA: {
        const [length, seq] = [w(0), w(1)];
        const block = data.subarray(16, 16 + length);
        const d = this.defl;
        if (!d || block.length !== length || seq !== d.next) return this._reply(op, { failed: 1, error: 6 });
        if (this._sum(block) !== (checksum & 255)) return this._reply(op, { failed: 1, error: 7 });
        d.parts.push(block.slice());
        d.next++;
        await sleep(this.pace * 45);
        if (d.next === d.blocks) {
          let plain;
          try { plain = await inflate(concat(...d.parts)); } catch { return this._reply(op, { failed: 1, error: 8 }); }
          if (plain.length !== d.size) return this._reply(op, { failed: 1, error: 8 });
          this.flash.set(plain, d.offset);
          this.log.push(`write 0x${d.offset.toString(16)} ${d.size}`);
          this.defl = null;
        }
        return this._reply(op);
      }
      case C.FLASH_MD5: {
        const [addr, size_] = [w(0), w(1)];
        const digest = md5hex(this.flash.subarray(addr, addr + size_));
        await sleep(this.pace * 120);
        if (this.stub) return this._reply(op, { data: Uint8Array.from(digest.match(/../g), (h) => parseInt(h, 16)) });
        return this._reply(op, { data: enc.encode(digest) });
      }
      case C.READ_FLASH: {
        if (!this.stub) return this._reply(op, { failed: 1, error: 5 });
        const [addr, size_, block] = [w(0), w(1), w(2)];
        this._reply(op);
        this.reading = { addr, size: size_, block: block || 0x1000, sent: 0 };
        return this._readFlashMore();
      }
      case C.ERASE_FLASH:
        this.flash.fill(0xff);
        this.log.push("erase-all");
        await sleep(this.pace * 1500);
        return this._reply(op);
      case C.ERASE_REGION:
        this._erase(w(0), w(1));
        return this._reply(op);
      default:
        return this._reply(op, { failed: 1, error: 5 });
    }
  }
  _sum(block) {
    let x = 0xef;
    for (const b of block) x ^= b;
    return x;
  }
  _erase(offset, size) {
    const start = offset & ~0xfff;
    const end = Math.min(this.flashBytes, (offset + size + 0xfff) & ~0xfff);
    this.flash.fill(0xff, start, end);
  }
  _readFlashMore() {
    const r = this.reading;
    const n = Math.min(r.block, r.size - r.sent);
    this._send(slip(this.flash.subarray(r.addr + r.sent, r.addr + r.sent + n)));
    r.sent += n;
  }
  _readFlashAck(total) {
    const r = this.reading;
    if (total < r.sent) return;
    if (r.sent < r.size) return this._readFlashMore();
    const digest = md5hex(this.flash.subarray(r.addr, r.addr + r.size));
    this._send(slip(Uint8Array.from(digest.match(/../g), (h) => parseInt(h, 16))));
    this.reading = null;
  }
  _readReg(addr) {
    switch (addr) {
      case REG.MAGIC: return this.rev.minor >= 2 ? 0x30e1706f : 0x1101406f;
      case REG.EFUSE_VER: return (this.rev.major << 4) | this.rev.minor;
      case REG.EFUSE_MAC0: return ((this.mac[2] << 24) | (this.mac[3] << 16) | (this.mac[4] << 8) | this.mac[5]) >>> 0;
      case REG.EFUSE_MAC1: return (this.mac[0] << 8) | this.mac[1];
      case REG.UARTDEV_BUF_NO: return 3;                      // the ROM talks on USB-Serial/JTAG
      case REG.UART_CLKDIV: return 416;
      case REG.SPI_CMD: return 0;                             // a flash command is done at once
      case REG.SPI_W0: {
        const command = (this.regs.get(REG.SPI_USR2) ?? 0) & 0xff;
        if (command === 0x9f) return 0xc8 | (0x40 << 8) | (Math.log2(this.flashBytes) << 16);   // maker, type, size
        return 0;
      }
      default: return this.regs.get(addr) ?? 0;
    }
  }
  _writeReg(addr, value) {
    this.regs.set(addr, value >>> 0);
    if (addr === REG.WDT_WPROTECT) this.wdt.open = value >>> 0 === WDT_KEY;
    else if (addr === REG.WDT_CONFIG1 && this.wdt.open) this.wdt.ticks = value >>> 0;
    else if (addr === REG.WDT_CONFIG0 && this.wdt.open) {
      if (value >>> 31 && this.wdt.ticks) {
        this.log.push("wdt-armed");
        this._later(40, () => this._systemReset("wdt-reset"));
      } else if (value === 0) {
        this.log.push("wdt-off");
      }
    } else if (addr === REG.SWD_CONFIG && value & (1 << 18)) {
      this.log.push("swd-autofeed");
    }
  }
}

/** A whole pretend unit: a master with a sensor on each port, each also reachable by its own USB socket. */
export function wire(master, { a = null, b = null } = {}) {
  master.links = { a, b };
  for (const s of [a, b]) if (s) s.masterOf = master;
  return master;
}
