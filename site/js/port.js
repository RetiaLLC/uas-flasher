// Serial port plumbing on top of Web Serial.
//
// GuardedPort stands between a library and the real port. It makes open()
// harmless when the port is already open, and it holds back every change of
// DTR and RTS unless told otherwise. A revision 1.0 ESP32-C5 that is reset
// through those lines hangs in its ROM until its power is cut (measured on
// the benches, 13 and 14 Nov 2026), and esptool-js falls back to exactly that
// reset when a change of baud rate fails. Nothing gets through here by accident.
//
// LineIO reads and writes text lines: the form all three firmwares speak on
// their own USB port.

import { sleep } from "./bytes.js";

export class GuardedPort {
  constructor(port, { allowSignals = false, onBlocked = null } = {}) {
    this.port = port;
    this.allowSignals = allowSignals;
    this.onBlocked = onBlocked;
    this.blocked = 0;
  }
  get readable() { return this.port.readable; }
  get writable() { return this.port.writable; }
  getInfo() { return this.port.getInfo(); }
  get isOpen() { return !!(this.port.readable || this.port.writable); }
  async open(options) {
    if (this.isOpen) return;
    await this.port.open(options);
  }
  async close() {
    try { await this.port.close(); } catch { /* already closed, or the board has gone */ }
  }
  async setSignals(signals) {
    if (!this.allowSignals) {
      this.blocked++;
      if (this.onBlocked) this.onBlocked(signals);
      return;
    }
    await this.port.setSignals(signals);
  }
  /** After a board has come back as a new port object. */
  swap(port) { this.port = port; }
}

export class LineIO {
  constructor(port, { baudRate = 115200 } = {}) {
    this.port = port;
    this.baudRate = baudRate;
    this.lines = [];          // every line received, oldest first
    this.listeners = new Set();
    this.lost = false;        // the port went away under us
    this.closed = false;
    this.reader = null;
    this.pump = null;
  }

  async open() {
    if (!(this.port.readable || this.port.writable)) {
      await this.port.open({ baudRate: this.baudRate, bufferSize: 64 * 1024 });
    }
    this.pump = this._pump();
  }

  async _pump() {
    const decoder = new TextDecoder();
    let rest = "";
    try {
      while (!this.closed && this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) return;
            if (!value) continue;
            rest += decoder.decode(value, { stream: true });
            let cut;
            while ((cut = rest.indexOf("\n")) >= 0) {
              const line = rest.slice(0, cut).replace(/\r$/, "");
              rest = rest.slice(cut + 1);
              if (line) this._line(line);
            }
            if (rest.length > 16384) rest = "";   // not text: a loader's packets, or noise
          }
        } finally {
          try { this.reader.releaseLock(); } catch { /* released already */ }
          this.reader = null;
        }
      }
    } catch (e) {
      if (!this.closed) this.lost = true;
    } finally {
      if (!this.closed && !this.port.readable) this.lost = true;
      for (const fn of [...this.listeners]) fn(null);
    }
  }

  _line(line) {
    this.lines.push(line);
    if (this.lines.length > 2000) this.lines.splice(0, 500);
    for (const fn of [...this.listeners]) fn(line);
  }

  /** Calls fn(line) for each line from now on, and fn(null) when the port ends. Returns a function that stops it. */
  onLine(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async write(text) {
    if (!this.port.writable) throw new Error("the port is not open");
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(text.endsWith("\n") ? text : text + "\n"));
    } finally {
      writer.releaseLock();
    }
  }

  /** The first line from now on for which pick(line) returns something, or null after the time. */
  wait(pick, timeoutMs) {
    return new Promise((resolve) => {
      let stop = () => {};
      const timer = setTimeout(() => { stop(); resolve(null); }, timeoutMs);
      stop = this.onLine((line) => {
        if (line === null) { clearTimeout(timer); stop(); resolve(null); return; }
        const got = pick(line);
        if (got) { clearTimeout(timer); stop(); resolve(got); }
      });
    });
  }

  /** Resolves true once the port has gone away, or false after the time. */
  async waitLost(timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.lost) return true;
      await sleep(40);
    }
    return this.lost;
  }

  /** Stops reading and leaves the port open, for whoever talks to it next. */
  async release() {
    this.closed = true;
    try { if (this.reader) await this.reader.cancel(); } catch { /* the stream had failed already */ }
    try { await this.pump; } catch { /* nothing to do */ }
  }

  async close() {
    await this.release();
    try { await this.port.close(); } catch { /* closed, or gone */ }
  }
}

/**
 * A board that restarts drops off USB and comes back, and Web Serial then
 * hands out a new port object for it. This waits for that object.
 *
 * serial   navigator.serial (or the pretend one)
 * old      the port object the board had
 * before   the ports that were known before the restart was asked for
 * Returns the port to use, or null when none came back in time.
 */
export async function waitForReturn(serial, old, before, timeoutMs) {
  let fresh = null;
  const onConnect = (event) => { fresh = event.target && event.target !== serial ? event.target : (event.port ?? fresh); };
  serial.addEventListener("connect", onConnect);
  try {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const now = await serial.getPorts();
      if (fresh && now.includes(fresh)) return fresh;
      const added = now.filter((p) => !before.includes(p));
      if (added.length === 1) return added[0];
      // The same object again: the board never left USB, or the browser kept the object.
      // It is left open if it opens: one opening less for the board to live through.
      if (now.includes(old) && (old.connected === undefined || old.connected)) {
        if (await opens(old)) return old;
      }
      await sleep(150);
    }
    return null;
  } finally {
    serial.removeEventListener("connect", onConnect);
  }
}

async function opens(port) {
  if (port.readable || port.writable) return true;
  try {
    await port.open({ baudRate: 115200, bufferSize: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}
