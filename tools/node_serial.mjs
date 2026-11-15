// A stand-in for navigator.serial that reaches one real serial device through
// tools/serial_bridge.py, so that the page's code can run against a real board
// from a terminal.
//
// It behaves as Chrome does for a USB device, as far as the page's code can
// tell: open and close, a readable and a writable stream, setSignals, and a
// board that leaves USB when it restarts and comes back as a NEW port object,
// with "disconnect" and "connect" events.

import net from "node:net";
import { existsSync } from "node:fs";

const lost = () => new DOMException("The device has been lost.", "NetworkError");
const frame = (kind, payload = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5);
  head.write(kind, 0, "latin1");
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};

class BridgePort extends EventTarget {
  constructor(serial) {
    super();
    this.serial = serial;
    this.connected = true;
    this.socket = null;
    this._dead = false;
    this._readable = null;
    this._writable = null;
    this._rc = null;
    this._pending = [];
    this._acks = [];
    this.signalChanges = 0;
  }
  getInfo() { return { usbVendorId: 0x303a, usbProductId: 0x1001 }; }
  open(options) {
    if (this._dead) return Promise.reject(lost());
    if (this.socket) return Promise.reject(new DOMException("The port is already open.", "InvalidStateError"));
    if (!options || !options.baudRate) return Promise.reject(new TypeError("baudRate is required"));
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.serial.port, "127.0.0.1");
      socket.setNoDelay(true);
      let buf = Buffer.alloc(0);
      let opened = false;
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 5) {
          const size = buf.readUInt32BE(1);
          if (buf.length < 5 + size) break;
          const kind = String.fromCharCode(buf[0]);
          const payload = buf.subarray(5, 5 + size);
          buf = buf.subarray(5 + size);
          if (kind === "O") { opened = true; this.socket = socket; this._pending = []; resolve(); }
          else if (kind === "E") { socket.destroy(); reject(new DOMException("Failed to open serial port: " + payload.toString(), "NetworkError")); }
          else if (kind === "D") this._deliver(new Uint8Array(payload));
          else if (kind === "A") { const done = this._acks.shift(); if (done) done(); }
          else if (kind === "L") this._lose();
        }
      });
      socket.on("error", (e) => { if (!opened) reject(new DOMException("the bridge is not there: " + e.message, "NetworkError")); });
      socket.on("close", () => { if (opened && this.socket === socket) this._lose(); });
    });
  }
  async close() {
    if (this._readable && this._readable.locked) throw new TypeError("Cannot close: the readable is locked");
    if (this._writable && this._writable.locked) throw new TypeError("Cannot close: the writable is locked");
    const socket = this.socket;
    this.socket = null;
    this._readable = this._writable = this._rc = null;
    if (socket) {
      await new Promise((r) => { socket.once("close", r); socket.destroy(); });
      await new Promise((r) => setTimeout(r, 60));     // the bridge closes the device
    }
  }
  get readable() {
    if (!this.socket || this._dead) return null;
    if (!this._readable) {
      this._readable = new ReadableStream({
        start: (c) => { this._rc = c; for (const chunk of this._pending.splice(0)) c.enqueue(chunk); },
        cancel: () => { this._readable = null; this._rc = null; },
      });
    }
    return this._readable;
  }
  get writable() {
    if (!this.socket || this._dead) return null;
    if (!this._writable) {
      this._writable = new WritableStream({
        write: (chunk) => new Promise((resolve, reject) => {
          if (!this.socket || this._dead) return reject(lost());
          this.socket.write(frame("D", Buffer.from(chunk)), (e) => (e ? reject(lost()) : resolve()));
        }),
      });
    }
    return this._writable;
  }
  setSignals(signals) {
    if (!this.socket) return Promise.reject(new DOMException("The port is closed.", "InvalidStateError"));
    this.signalChanges++;
    this.serial.log.push("dtr-rts " + JSON.stringify(signals));
    const wire = {};
    if (signals.dataTerminalReady !== undefined) wire.dtr = !!signals.dataTerminalReady;
    if (signals.requestToSend !== undefined) wire.rts = !!signals.requestToSend;
    return new Promise((resolve) => {
      this._acks.push(resolve);
      this.socket.write(frame("S", Buffer.from(JSON.stringify(wire))));
    });
  }
  _deliver(bytes) {
    if (this._rc) { try { this._rc.enqueue(bytes); } catch { /* cancelled under us */ } }
    else { this._pending.push(bytes); if (this._pending.length > 2048) this._pending.splice(0, 512); }
  }
  _lose() {
    if (this._dead) return;
    this._dead = true;
    this.connected = false;
    if (this._rc) { try { this._rc.error(lost()); } catch { /* closed already */ } }
    this._rc = null;
    this._readable = this._writable = null;
    if (this.socket) { this.socket.destroy(); this.socket = null; }
    for (const done of this._acks.splice(0)) done();
    this.serial._gone(this);
  }
}

/** navigator.serial for one device path, through a bridge on a TCP port. */
export class BridgeSerial extends EventTarget {
  constructor({ device, port }) {
    super();
    this.device = device;
    this.port = port;
    this.log = [];                       // what happened on USB: "left", "back", "dtr-rts ..."
    this.current = existsSync(device) ? new BridgePort(this) : null;
    this.timer = setInterval(() => this._look(), 50);
  }
  stop() { clearInterval(this.timer); }
  async getPorts() { return this.current ? [this.current] : []; }
  async requestPort() {
    if (!this.current) throw new DOMException("No port selected by the user.", "NotFoundError");
    return this.current;
  }
  _announce(type, port) {
    const event = new Event(type);
    event.port = port;
    this.dispatchEvent(event);
  }
  _gone(port) {
    if (this.current !== port) return;
    this.current = null;
    this.log.push("left " + new Date().toISOString().slice(11, 23));
    this._announce("disconnect", port);
  }
  _look() {
    const there = existsSync(this.device);
    if (!there && this.current) this.current._lose();
    else if (there && !this.current) {
      this.current = new BridgePort(this);
      this.log.push("back " + new Date().toISOString().slice(11, 23));
      this._announce("connect", this.current);
    }
  }
}
