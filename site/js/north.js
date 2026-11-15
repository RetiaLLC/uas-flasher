// The master's northbound stream on USB: records in, commands out, one JSON
// object a line. And on top of it: flashing a sensor through the master.
//
// The second half is tools/flash_sensor.py of the firmware's repository, in a browser. It
// sends what that tool sends, in that order, and says what that tool says
// (master/README.md, "Flashing a sensor through the master"; issue 73). The
// master does the work: it keeps the image in its RAM, takes the sensor into
// its ROM loader, writes, compares and restarts it.

import { base64, crc32, hex8, md5 } from "./bytes.js";

export const ONE_SLOT_WARNING =
  "This version writes over the sensor's only firmware. If the sensor loses power while it is written, " +
  "or the new firmware does not link, only the sensor's own USB socket mends it.";

export const LEFT = {
  unchanged: "The sensor runs what it ran before.",
  loader: "The sensor waits in its ROM loader and the master holds the port. Flash it again from here: nothing else brings it back but its own USB socket or a power cycle.",
  silent: "Nothing answers on that port. Flash the sensor through its own USB socket, or power-cycle it.",
};

export const THROUGH_STEPS = [
  ["hand", "Hand the image to the master"],
  ["loader", "The sensor enters its loader"],
  ["write", "The master writes and compares"],
  ["restart", "The sensor restarts"],
  ["hello", "The sensor says hello"],
];

const REFUSALS = {
  "unsupported flash": "this master cannot flash a sensor",
  "unsupported ram": "this master has no external RAM to hold an image in",
  "unsupported download": "that sensor's firmware has no boot download command",
  "unsupported client": "this master does not take an image from this kind of client",
  "busy flash": "another flash stands, or a sensor waits in its loader on the other port",
  "busy port": "that port's sensor is not UP",
  "busy pairing": "a phone is being paired: try again when that is over",
  "busy calibrate": "a calibration runs: try again when it has ended",
  "busy seek": "a signal is being followed: stop that first",
  "busy battery": "the cell is too low: charge the unit first",
  "busy erased": "the old firmware is already erased: the master sees the write through",
  "not_found role": "no sensor of that kind is linked",
  "bad_arg role": "the sensor on that port is of the other kind",
  "bad_arg project": "the image's project is not that sensor's",
  "bad_arg chip": "the image is for another chip",
  "bad_arg image": "the file is not an application image",
  "bad_arg crc32": "the image did not arrive whole",
  "range size": "the image does not fit that sensor's application slot",
  "range offset": "that is not where an application of this sensor lies",
};

export function refusal(ack) {
  if (!ack) return "the master did not answer";
  return REFUSALS[`${ack.err} ${ack.key ?? ""}`.trim()] ?? `${ack.err ?? "refused"} ${ack.key ?? ""}`.trim();
}

/** The master's stream on an open LineIO. */
export class MasterLink {
  constructor(io) {
    this.io = io;
    this.records = [];
    this.nextId = (Date.now() % 100000) * 100;
    this.listeners = new Set();
    this.stop = io.onLine((line) => {
      if (line === null) { for (const fn of [...this.listeners]) fn(null); return; }
      let rec;
      try { rec = JSON.parse(line); } catch { return; }
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) return;
      this.records.push(rec);
      if (this.records.length > 4000) this.records.splice(0, 1000);
      for (const fn of [...this.listeners]) fn(rec);
    });
  }

  get lost() { return this.io.lost; }

  onRecord(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The first record from now on that pick() accepts, or null after the time or when the port ends. */
  wait(pick, timeoutMs) {
    return new Promise((resolve) => {
      let stop = () => {};
      const timer = setTimeout(() => { stop(); resolve(null); }, timeoutMs);
      stop = this.onRecord((rec) => {
        if (rec === null || pick(rec)) { clearTimeout(timer); stop(); resolve(rec); }
      });
    });
  }

  /** Sends a command and resolves to its ack, or null. */
  async cmd(name, members = {}, timeoutMs = 3000) {
    const id = ++this.nextId;
    const answer = this.wait((r) => r.event === "ack" && r.id === id, timeoutMs);
    try {
      await this.io.write(JSON.stringify({ ...members, cmd: name, id }));
    } catch {
      return null;
    }
    return answer;
  }

  /** The record a `get` brings. The master sends it before its ack. */
  async get(what, event) {
    const from = this.records.length;
    const ack = await this.cmd("get", { what });
    if (!ack) return null;
    for (let i = this.records.length - 1; i >= from; i--) {
      if (this.records[i].event === event) return this.records[i];
    }
    return this.wait((r) => r.event === event, 500);
  }

  close() { this.stop(); }
}

function withDefaults(hooks = {}) {
  return {
    log: hooks.log ?? (() => {}),
    step: hooks.step ?? (() => {}),
    progress: hooks.progress ?? (() => {}),
    confirm: hooks.confirm ?? (async () => false),
  };
}

export class ThroughError extends Error {
  constructor(message, { left = "unchanged", at = null, begun = false, stopped = false } = {}) {
    super(message);
    this.name = "ThroughError";
    this.left = left;
    this.at = at;
    this.begun = begun;       // false: nothing reached the sensor
    this.stopped = stopped;   // the person said stop: nothing went wrong
  }
}

/** Which port a sensor image goes to, from the master's hello and the flash that stands. */
export function choosePort(hello, standing, role, asked) {
  const ports = Object.fromEntries((hello.ports ?? []).map((p) => [p.port, p]));
  const held = standing && standing.left === "loader" ? standing.port : null;
  const matches = Object.keys(ports).filter((n) => ports[n].role === role && ports[n].state === "UP");
  let port = asked ?? matches[0] ?? null;
  if (held) {
    if (standing.role && standing.role !== role) {
      return { error: `The ${standing.role} sensor waits in its ROM loader on port ${held}. Flash that one first: this image is for the ${role} sensor.` };
    }
    if (!standing.role && asked !== held) {
      return { ask: held, error: `A sensor waits in its ROM loader on port ${held}, and the master does not know which one it is. If it is the ${role} sensor, choose port ${held}. The wrong image there would be written all the same.` };
    }
    port = held;
  }
  if (!port) return { error: `No ${role} sensor is UP on this master.` };
  return { port, held: port === held, now: ports[port] ?? null };
}

/**
 * Flash a sensor through the master.
 *
 *   link     a MasterLink
 *   role     "rid" | "rf"
 *   image    the sensor's application, as bytes
 *   version  what the image calls itself
 *   port     "a" | "b", only where the role does not decide it
 *   hooks    log, step(key, state, detail), progress(done, total, phase), confirm({...}) -> bool
 *   signal   an AbortSignal: before `go` it cancels; after it the master finishes alone
 *
 * Resolves to the `flash` record the master ended with (state `done`). Rejects with a ThroughError.
 */
export async function flashThroughMaster({ link, role, image, version, port: asked = null, hooks, signal = null }) {
  const H = withDefaults(hooks);
  const hello = await link.get("hello", "m_hello");
  if (!hello) throw new ThroughError("No master answers on this port.");
  if (!(hello.caps ?? []).includes("flash")) {
    throw new ThroughError(`Master ${hello.fw_ver} cannot flash a sensor: its capabilities do not name flash.`);
  }
  const standing = ((await link.cmd("get", { what: "flash" })) ?? {}).flash ?? {};
  const chosen = choosePort(hello, standing, role, asked);
  if (chosen.error) throw new ThroughError(chosen.error);
  const port = chosen.port;
  const go = await H.confirm({
    kind: "through-master", role, port, held: chosen.held,
    was: chosen.held ? null : chosen.now && chosen.now.fw_ver, now: version, size: image.length, warning: ONE_SLOT_WARNING,
  });
  if (!go) throw new ThroughError("Nothing was sent.", { stopped: true });

  // Hand the image over. Until `go` the sensor is not touched.
  H.step("hand", "run");
  const begin = { role, port, size: image.length, crc32: hex8(crc32(image)), md5: md5(image) };
  let ack = await link.cmd("flash", begin);
  if (ack && !ack.ok && ack.key === "flash" && (standing.state === "receiving" || standing.state === "ready")) {
    await link.cmd("flash", { cancel: true });   // an image of ours that an earlier visit left unfinished
    ack = await link.cmd("flash", begin);
  }
  if (!ack || !ack.ok) throw new ThroughError(`The master refused: ${refusal(ack)}.`);
  const piece = ack.piece;
  if (!(piece > 0)) throw new ThroughError("The master named no piece size.");
  let off = 0;
  while (off < image.length) {
    if (signal && signal.aborted) {
      await link.cmd("flash", { cancel: true });
      throw new ThroughError("Cancelled: nothing was written to the sensor.");
    }
    ack = null;
    for (let i = 0; i < 3 && !ack; i++) {
      ack = await link.cmd("flash", { off, data: base64(image.subarray(off, off + piece)) });
    }
    if (!ack) throw new ThroughError(`The master stopped answering at byte ${off}: nothing was written to the sensor.`);
    if (ack.ok) off = ack.got;
    else if (ack.key === "off" && "want" in ack) off = ack.want;   // an ack of ours was lost: go on where the master is
    else throw new ThroughError(`The master refused the image: ${refusal(ack)}. Nothing was written to the sensor.`);
    H.progress(off, image.length, "hand");
  }
  H.step("hand", "done", `${Math.ceil(image.length / piece)} pieces`);

  const from = link.records.length;
  ack = await link.cmd("flash", { go: true });
  if (!ack || !ack.ok) {
    await link.cmd("flash", { cancel: true });
    throw new ThroughError(`The master refused to begin: ${refusal(ack)}. Nothing was written to the sensor.`);
  }

  // Follow the master's own account of it.
  const stepOf = { loader: "loader", erasing: "write", writing: "write", verifying: "write", restarting: "restart" };
  const order = ["loader", "write", "restart", "hello"];
  let current = null;
  const show = (rec) => {
    const step = stepOf[rec.state];
    if (!step) return;
    if (step !== current) {
      for (const s of order.slice(0, order.indexOf(step))) H.step(s, "done");
      H.step(step, "run");
      current = step;
    }
    if (rec.state === "writing") H.progress(rec.pct ?? 0, 100, "write" + ((rec.try ?? 1) > 1 ? `, try ${rec.try}` : ""));
    if (rec.state === "restarting") { H.step("restart", "done"); H.step("hello", "run"); current = "hello"; }
  };
  const until = Date.now() + 120000 + (image.length / 1e6) * 240000;
  let at = from;
  for (;;) {
    while (at < link.records.length) {
      const rec = link.records[at++];
      if (rec.event !== "flash") continue;
      if (rec.state === "done") {
        for (const s of order) H.step(s, "done");
        return rec;
      }
      if (rec.state === "failed" || rec.state === "cancelled") {
        throw new ThroughError(`${rec.state} at ${rec.at ?? "-"}: ${rec.why ?? ""}`.trim(), { left: rec.left ?? "unchanged", at: rec.at, begun: true });
      }
      show(rec);
    }
    if (link.lost) {
      throw new ThroughError("The master left USB. It finishes the flash alone: plug it in again and look at the sensor's version.", { left: "unknown", begun: true });
    }
    if (Date.now() > until) {
      throw new ThroughError("The master sent no end of the flash.", { left: "unknown", begun: true });
    }
    await link.wait((r) => r.event === "flash", 500);
  }
}

/** Enter a sensor's loader, read the chip, leave. Nothing is written. Resolves to the master's `flash` record. */
export async function probeThroughMaster({ link, port }) {
  const from = link.records.length;
  const ack = await link.cmd("flash", { port, probe: true });
  if (!ack || !ack.ok) throw new ThroughError(`The master refused: ${refusal(ack)}.`);
  const until = Date.now() + 60000;
  let at = from;
  while (Date.now() < until) {
    while (at < link.records.length) {
      const rec = link.records[at++];
      if (rec.event === "flash" && (rec.state === "done" || rec.state === "failed" || rec.state === "cancelled")) return rec;
    }
    await link.wait((r) => r.event === "flash", 500);
  }
  throw new ThroughError("The master sent no end of the probe.", { left: "unknown", begun: true });
}
