#!/usr/bin/env node
// Run the page's own code against a real board, from a terminal.
//
//   node tools/board_run.mjs look  --device /dev/cu.usbmodem1101
//   node tools/board_run.mjs flash --device /dev/cu.usbmodem1101 --role master
//   node tools/board_run.mjs flash --device /dev/ttyACM0 --role rid --yes other-board
//
// A browser asks a person to pick the port; here the device is named. Everything
// after that is the page's code as the browser runs it: site/js/direct.js with
// esptool-js from site/vendor/, writing the files of the newest release in
// site/catalog.json. Node has no serial ports, so tools/serial_bridge.py (Python
// with pyserial) opens the device and tools/node_serial.mjs dresses it as Web Serial.
//
//   --role master|rid|rf   which board's firmware to write
//   --wipe                 also blank the settings partition
//   --usb-reset            say yes when the page asks to restart a master over USB
//   --yes KIND[,KIND]      say yes to other questions: other-board, other-flash
//   --python PATH          a Python that has pyserial (default: $PYTHON, then python3)
//   --release TAG          a release other than the first in the catalog
//
// `look` writes nothing: it opens the port, asks the board what it is, and says what it heard.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeSerial } from "./node_serial.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const { flashDirect, look, FlashError } = await import(join(SITE, "js/direct.js"));
const { sha256 } = await import(join(SITE, "js/bytes.js"));
const { BOARDS } = await import(join(SITE, "js/boards.js"));

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    if (["wipe", "usb-reset"].includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

const opt = args(process.argv.slice(2));
const action = opt._[0];
if (!["look", "flash"].includes(action) || !opt.device || (action === "flash" && !BOARDS[opt.role])) {
  console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(2);
}

const t0 = Date.now();
const say = (text) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}] ${text}`);

// The bridge.
const python = opt.python ?? process.env.PYTHON ?? "python3";
const bridge = spawn(python, [join(ROOT, "tools", "serial_bridge.py"), opt.device, "0"], { stdio: ["ignore", "pipe", "inherit"] });
const first = await new Promise((resolve, reject) => {
  createInterface({ input: bridge.stdout }).once("line", (l) => resolve(JSON.parse(l)));
  bridge.once("exit", (code) => reject(new Error(`the bridge ended (${code}): does ${python} have pyserial?`)));
});
const serial = new BridgeSerial({ device: opt.device, port: first.listening });
const finish = async (code) => {
  serial.stop();
  bridge.kill();
  say("USB: " + (serial.log.length ? serial.log.join(" | ") : "the board never left it"));
  process.exit(code);
};

try {
  const port = await serial.requestPort();
  if (action === "look") {
    const { io, who } = await look(port);
    say(who.role ? `it says it is the ${BOARDS[who.role].noun}, firmware ${who.version}` + (who.git ? ` (${who.git})` : "") : `nothing that names a firmware (${who.heard} lines heard)`);
    if (who.ports) for (const p of who.ports) say(`  port ${p.port}: ${p.state} ${p.role ?? "no sensor"} ${p.fw_ver ?? ""}`);
    if (who.caps && who.caps.length) say("  capabilities: " + who.caps.join(", "));
    for (const line of io.lines.slice(0, 6)) say("  heard: " + line.slice(0, 150));
    await io.close();
    await finish(0);
  }

  const catalog = JSON.parse(readFileSync(join(SITE, "catalog.json"), "utf8"));
  const release = opt.release ? catalog.releases.find((r) => r.tag === opt.release) : catalog.releases[0];
  const board = release && release.boards[opt.role];
  if (!board) throw new Error(`no ${opt.role} firmware in release ${opt.release ?? "(first in the catalog)"}`);
  const parts = [];
  for (const p of board.parts) {
    const data = new Uint8Array(readFileSync(join(SITE, p.file)));
    if ((await sha256(data)) !== p.sha256) throw new Error(`${p.file} does not match its SHA-256 in the catalog`);
    parts.push({ kind: p.kind, offset: p.offset, data });
  }
  say(`release ${release.tag} (${release.channel}): ${BOARDS[opt.role].noun} ${board.version}, ${parts.length} files, each matches its SHA-256`);

  const esptool = await import(join(SITE, "vendor/esptool-js/bundle.js"));
  const yes = new Set((opt.yes ?? "").split(",").filter(Boolean));
  if (opt["usb-reset"]) yes.add("usb-reset");
  let lastPct = -10;
  const hooks = {
    log: (text) => { if (!/^Writing at /.test(text)) say("  " + text); },
    step: (key, state, detail) => say(`STEP ${key}: ${state}${detail ? "  " + detail : ""}`),
    progress: (done, total, kind) => {
      const pct = Math.floor((done * 100) / Math.max(1, total));
      if (pct >= lastPct + 10 || pct === 100) { lastPct = pct; say(`  ${pct} %  ${kind ?? ""}`); }
    },
    confirm: async (q) => {
      const answer = yes.has(q.kind);
      say(`ASKED ${q.kind} ${JSON.stringify(q)} -> ${answer ? "yes" : "no"}`);
      return answer;
    },
    pickAgain: async (why) => { say(`the page would ask the person to choose the board again (${why})`); return (await serial.getPorts())[0] ?? null; },
  };
  const out = await flashDirect({ serial, esptool, port, role: opt.role, board, parts, wipe: !!opt.wipe, hooks });
  say("RESULT " + JSON.stringify({
    settled: out.settled, was: out.was, now: out.now && { role: out.now.role, version: out.now.version, git: out.now.git, caps: out.now.caps },
    chip: out.chip, rev: out.rev, mac: out.mac, flashMB: out.flashBytes && out.flashBytes / 1048576, usbReset: !!out.usbReset, blanked: !!out.blanked,
  }));
  if (out.io) await out.io.close();
  await finish(out.settled ? 0 : 1);
} catch (e) {
  if (e instanceof FlashError) say(`FAILED at ${e.at}: ${e.message}  (left: ${e.left}${e.hint ? ", hint: " + e.hint : ""}${e.stopped ? ", stopped by the answer" : ""})`);
  else say("FAILED: " + (e && e.stack ? e.stack : e));
  await finish(1);
}
