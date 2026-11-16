// The page: what a person sees and presses. The work is in js/.
//
//   js/catalog.js   the releases this site serves, and their files, checked
//   js/direct.js    a board through its own USB socket (esptool-js)
//   js/north.js     a sensor through the master (the master's `flash` commands)
//   demo/sim.js     pretend boards, loaded only with ?demo in the address
//
// Everything a board says (versions, names) is shown with textContent, never as markup.

import { BOARDS, ROLES, compareVersions, sameVersion } from "./js/boards.js";
import { bytesText } from "./js/bytes.js";
import { FileError, VALIDATED, fetchBoard, firstRelease, loadCatalog } from "./js/catalog.js";
import { DIRECT_STEPS, FlashError, flashDirect, look } from "./js/direct.js";
import { LEFT, MasterLink, THROUGH_STEPS, ThroughError, flashThroughMaster } from "./js/north.js";

const $ = (id) => document.getElementById(id);
const demo = new URLSearchParams(location.search).has("demo");
const ESPRESSIF = { usbVendorId: 0x303a };

const state = {
  catalog: null,
  release: null,
  serial: null,     // navigator.serial, or the pretend one
  esptool: null,    // esptool-js, loaded when first needed
  conn: null,       // { port, io, guard, who, link }: the board on the cable now
  seen: {},         // role -> { version, git, via: "usb" | "master", port, up }
  busy: false,
  armed: false,
  wipe: false,
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("data-") || k === "type" || k === "for" || k === "href" || k === "colspan") node.setAttribute(k, v);
    else node[k] = v;
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// --- the hero ---------------------------------------------------------------
function hero(stateName, word, line) {
  $("level").dataset.state = stateName;
  $("hero-word").dataset.state = stateName;
  $("hero-word").textContent = word;
  if (line !== undefined) $("hero-line").textContent = line;
}

const IDLE_LINE = "Plug a board into this computer with a USB-C cable and press Connect. The page asks the board what it is, shows what it runs, and offers this release for it.";

function heroFromConnection() {
  const c = state.conn;
  if (!state.serial) {
    hero("none", "NO WEB SERIAL", "This browser cannot reach a USB serial port. Open the page in Chrome or Edge on a computer. You can still look around, or try the page with pretend boards from the link at the foot.");
    return;
  }
  if (!c) { hero("idle", "READY", IDLE_LINE); return; }
  if (!c.who.role) {
    hero("linked", "CONNECTED", "The board on this cable says nothing that names a firmware. It may sit in its loader, be asleep, or carry none. You can still flash it: choose below which board it is.");
    return;
  }
  const rel = state.release && state.release.boards[c.who.role];
  let line = `The ${BOARDS[c.who.role].noun} is on this cable, firmware ${c.who.version ?? "of an unknown version"}.`;
  if (rel) line += sameVersion(c.who.version, rel.version) ? " That is what this release holds." : ` This release holds ${rel.version}.`;
  if (c.who.role === "master" && c.who.ports) {
    for (const p of c.who.ports) {
      line += p.role ? ` Port ${p.port.toUpperCase()}: ${BOARDS[p.role].noun} ${p.fw_ver ?? ""}.` : ` Port ${p.port.toUpperCase()}: no sensor up.`;
    }
  }
  hero("linked", "CONNECTED", line);
}

// --- the release ------------------------------------------------------------
const CHANNEL = {
  alpha: ["ALPHA", "green"],
  beta: ["BETA", "amber"],
  verified: ["VERIFIED", "green"],
  untested: ["UNTESTED", "amber"],
  draft: ["DRAFT", "amber"],
};
const GATE = {
  beta: "The Beta is the most up-to-date master, with the landscape screen, and it may contain bugs. It has not been validated as the Alpha has. Tick here to flash it all the same.",
  untested: "This release is marked untested: nobody has confirmed it on a unit. Tick here to flash it all the same.",
  draft: "This release is a draft: it has not been published yet. Tick here to flash it all the same.",
};

function renderReleasePicker() {
  const select = $("release-select");
  const name = (r) => (r.label ? `${r.label}  \u00b7  ${r.date || r.tag}` : r.tag + (r.date ? "  " + r.date : ""));
  const waiting = (state.catalog.pending ?? []).map((w) => el("option", { disabled: true, text: `${w.label ?? w.channel}  \u00b7  not here yet` }));
  select.replaceChildren(...state.catalog.releases.map((r) => el("option", { value: r.tag, text: name(r) })), ...waiting);
  select.value = state.release.tag;
  select.disabled = state.catalog.releases.length + waiting.length < 2;
}

function renderRelease() {
  const r = state.release;
  const [label, tone] = CHANNEL[r.channel] ?? [r.channel.toUpperCase(), "amber"];
  $("release-channel").textContent = label;
  $("release-channel").dataset.tone = tone;

  const gate = $("gate");
  if (VALIDATED.has(r.channel)) {
    gate.hidden = true;
    state.armed = true;
  } else {
    gate.hidden = false;
    $("gate-text").textContent = GATE[r.channel] ?? GATE.untested;
    $("gate-tick").checked = state.armed = false;
  }

  const body = $("release-body");
  const has = ROLES.filter((role) => r.boards[role]).map((role) => `the ${BOARDS[role].noun} (${r.boards[role].version})`);
  const lacks = ROLES.filter((role) => !r.boards[role]).map((role) => `the ${BOARDS[role].noun}`);
  const list = (items) => (items.length < 2 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1]);
  const summary = r.notes
    ? r.notes.split(/\n\s*\n/)[0].replace(/\*\*/g, "").replace(/`/g, "").trim()
    : `Firmware for ${list(has)}.` + (lacks.length ? ` None for ${list(lacks)} yet.` : "");
  const rows = [];
  for (const role of ROLES) {
    const b = r.boards[role];
    if (!b) {
      rows.push(el("tr", { class: "grp" }, el("td", { colspan: "4", text: `${BOARDS[role].label}: not in this release` })));
      continue;
    }
    rows.push(el("tr", { class: "grp" }, el("td", { colspan: "4", text: `${BOARDS[role].label}  ${b.version}  built ${b.built}  ESP-IDF ${b.idf}` })));
    for (const p of b.parts) {
      rows.push(el("tr", {},
        el("td", { text: p.file.split("/").pop() }),
        el("td", { class: "num", text: "0x" + p.offset.toString(16) }),
        el("td", { class: "num", text: bytesText(p.size) }),
        el("td", { class: "sha", text: p.sha256 })));
    }
    for (const note of b.notes ?? []) rows.push(el("tr", {}, el("td", { colspan: "4", text: note })));
  }
  const table = el("table", { class: "files" },
    el("thead", {}, el("tr", {}, el("th", { text: "FILE" }), el("th", { class: "num", text: "WRITTEN AT" }), el("th", { class: "num", text: "SIZE" }), el("th", { text: "SHA-256" }))),
    el("tbody", {}, rows));
  const waiting = (state.catalog.pending ?? []).map((w) => `${w.label ?? w.channel}: ${w.note ?? "not here yet"}`);
  body.replaceChildren(
    el("p", { class: "release-summary" }, el("strong", { text: (r.label ?? r.tag) + ". " }), r.note ? r.note + " " : "", summary, r.label ? ` It is ${r.tag} of the firmware.` : ""),
    waiting.length ? el("p", { class: "release-summary", text: waiting.join(" ") }) : null,
    el("div", { class: "files-scroll" }, table),
    r.notes ? el("details", { class: "release-notes" }, el("summary", { text: "THE RELEASE'S OWN NOTES" }), el("pre", { class: "notes-text", text: r.notes })) : null);
}

// --- the three boards ---------------------------------------------------------
function cardState(role) {
  const rel = state.release.boards[role];
  const seen = state.seen[role];
  if (!rel) return ["NOT IN THIS RELEASE", ""];
  if (!seen) return ["NOT CONNECTED", ""];
  if (seen.via === "master" && !seen.up) return ["DOWN", "red"];
  if (!seen.version) return ["CONNECTED", "blue"];
  return {
    same: ["UP TO DATE", "green"],
    older: ["UPDATE", "amber"],
    newer: ["NEWER THAN THIS RELEASE", "blue"],
    other: ["DIFFERS", "amber"],
  }[compareVersions(seen.version, rel.version)];
}

const WHAT = {
  master: "The board with the screen. It collects from both sensors, raises the alerts and talks to the phone.",
  rid: "The XIAO with the radio board under it. It listens for Remote ID and on 868 MHz.",
  rf: "The XIAO by itself. It listens for video and control links on 2.4 and 5.8 GHz.",
};

/** Why a sensor cannot be flashed through the master right now, or null if it can. */
function throughBlock(role) {
  const c = state.conn;
  if (!c || c.who.role !== "master") return "Connect the master first: its USB-C socket reaches the sensors.";
  if (!c.who.caps.includes("flash")) return `This master's firmware (${c.who.version}) cannot flash a sensor yet. Use the sensor's own socket.`;
  const seen = state.seen[role];
  if (!seen || seen.via !== "master" || !seen.up) return `No ${BOARDS[role].noun} is up on this master.`;
  return null;
}

function renderUnit() {
  const cards = ROLES.map((role) => {
    const b = BOARDS[role];
    const rel = state.release.boards[role];
    const seen = state.seen[role];
    const [label, tone] = cardState(role);
    const here = !!(state.conn && state.conn.who.role === role);
    const blocked = state.busy || !state.serial || !rel || !state.armed;

    const onBoard = seen
      ? el("dd", {}, seen.version ?? "unknown", " ", el("small", { text: seen.via === "master" ? `port ${seen.port.toUpperCase()}, as the master says` : "on this cable" }))
      : el("dd", { class: "none", text: "not known yet" });
    const inRelease = rel
      ? el("dd", {}, rel.version, " ", el("small", { text: `built ${rel.built.replace(/ \d\d:\d\d:\d\d$/, "")}` }))
      : el("dd", { class: "none", text: "no files for this board" });

    const actions = [];
    if (role === "master") {
      const tick = el("input", { type: "checkbox", checked: state.wipe, disabled: blocked });
      tick.addEventListener("change", () => { state.wipe = tick.checked; });
      const go = el("button", { class: "btn btn-main btn-wide", type: "button", text: "FLASH THE MASTER", disabled: blocked });
      go.addEventListener("click", () => flashOwn("master"));
      actions.push(go, el("label", { class: "tick" }, tick, el("span", { text: "Also erase its settings, its paired phones and the signals it has learned" })));
      if (!rel) actions.push(el("p", { class: "why", text: "This release holds no master firmware." }));
    } else {
      const block = throughBlock(role);
      const through = el("button", { class: "btn btn-main btn-wide", type: "button", text: "THROUGH THE MASTER", disabled: blocked || !!block });
      through.addEventListener("click", () => flashThrough(role));
      const own = el("button", { class: "btn btn-wide", type: "button", text: "THROUGH ITS OWN SOCKET", disabled: blocked });
      own.addEventListener("click", () => flashOwn(role));
      actions.push(through);
      if (rel && block) actions.push(el("p", { class: "why", text: block }));
      actions.push(own);
      actions.push(el("p", { class: "why", text: rel
        ? "With the cable in the sensor's own socket, keep the cell or the master's USB plugged in as well."
        : `This release holds no ${b.noun} firmware yet.` }));
    }

    return el("article", { class: "card", "data-here": String(here) },
      el("header", { class: "card-head" }, el("h2", { class: "card-title", text: b.label }), el("span", { class: "card-state", "data-tone": tone, text: label })),
      el("div", {}, el("p", { class: "card-what", text: WHAT[role] }), el("p", { class: "card-hw", text: b.hardware })),
      el("dl", { class: "facts" }, el("dt", { text: "ON THE BOARD" }), onBoard, el("dt", { text: "THIS RELEASE" }), inRelease),
      el("div", { class: "card-actions" }, actions));
  });
  $("unit").replaceChildren(...cards);

  $("connect").disabled = state.busy || !state.serial;
  $("connect").hidden = !!state.conn;
  $("disconnect").hidden = !state.conn;
  $("disconnect").disabled = state.busy;
}

function render() {
  renderUnit();
  heroFromConnection();
}

// --- the connection -------------------------------------------------------------
/** Takes what a board said of itself into what the cards show. */
function note(who) {
  if (!who.role) return;
  state.seen[who.role] = { version: who.version, git: who.git, via: "usb", up: true };
  if (who.role === "master" && who.ports) {
    for (const role of ["rid", "rf"]) if (state.seen[role] && state.seen[role].via === "master") delete state.seen[role];
    for (const p of who.ports) {
      if (p.role === "rid" || p.role === "rf") state.seen[p.role] = { version: p.fw_ver, git: p.git, via: "master", port: p.port, up: p.state === "UP" };
    }
  }
}

async function drop() {
  const c = state.conn;
  state.conn = null;
  state.seen = {};
  if (c) {
    if (c.link) c.link.close();
    try { await c.io.close(); } catch { /* gone already */ }
  }
}

function adopt(port, io, guard, who) {
  state.conn = { port, io, guard, who, link: who.role === "master" ? new MasterLink(io) : null };
  state.seen = {};
  note(who);
}

async function pickPort() {
  try {
    return await state.serial.requestPort({ filters: [ESPRESSIF] });
  } catch (e) {
    if (e && e.name === "NotFoundError") return null;   // the person closed the list
    throw e;
  }
}

async function connect() {
  if (state.busy) return;
  let port;
  try { port = await pickPort(); } catch (e) { hero("fail", "FAILED", "The browser could not list serial ports: " + e.message); return; }
  if (!port) return;
  state.busy = true;
  renderUnit();
  hero("work", "ASKING", "Asking the board what it is.");
  try {
    await drop();
    const { io, guard, who } = await look(port);
    adopt(port, io, guard, who);
  } catch (e) {
    hero("fail", "FAILED", openTrouble(e));
    state.busy = false;
    renderUnit();
    return;
  }
  state.busy = false;
  render();
}

function openTrouble(e) {
  const text = e && e.message ? e.message : String(e);
  if (/open|in use|busy|access/i.test(text)) return "The port could not be opened. Another program may hold it: close serial monitors and other flashing tools, then connect again.";
  return "The board could not be reached: " + text;
}

/** Asks a connected master again what it and its sensors run. */
async function refreshMaster() {
  const c = state.conn;
  if (!c || !c.link) return;
  const hello = await c.link.get("hello", "m_hello");
  if (!hello) return;
  c.who = { ...c.who, version: hello.fw_ver, git: hello.git || null, caps: hello.caps ?? [], ports: hello.ports ?? null, record: hello };
  note(c.who);
}

// --- the sheet --------------------------------------------------------------------
const MARK = { wait: "·", run: "›", done: "✓", warn: "!", fail: "×" };
const sheet = {
  lines: [],
  open(title, sub, steps) {
    this.lines = [];
    $("sheet-title").textContent = title;
    $("sheet-sub").textContent = sub;
    $("sheet-steps").replaceChildren(...steps.map(([key, name]) =>
      el("li", { "data-key": key, "data-state": "wait" }, el("span", { class: "mark", text: MARK.wait }), el("span", { class: "name" }, name, el("span", { class: "detail" })))));
    this.word("work", "WORKING");
    $("sheet-meter").hidden = true;
    $("sheet-ask").hidden = true;
    $("sheet-outcome").hidden = true;
    $("sheet-again").hidden = true;
    $("sheet-close").hidden = true;
    $("sheet-log").textContent = "";
    $("sheet-log-box").open = false;
    $("sheet").hidden = false;
  },
  word(stateName, text) {
    $("sheet-word").dataset.state = stateName;
    $("sheet-word").textContent = text;
  },
  step(key, stepState, detail) {
    const li = $("sheet-steps").querySelector(`[data-key="${key}"]`);
    if (!li) return;
    li.dataset.state = stepState;
    li.querySelector(".mark").textContent = MARK[stepState] ?? MARK.wait;
    if (detail) li.querySelector(".detail").textContent = detail;
  },
  progress(done, total, label) {
    $("sheet-meter").hidden = false;
    const pct = total > 0 ? Math.min(100, Math.round((done * 100) / total)) : 0;
    $("sheet-fill").style.width = pct + "%";
    $("sheet-meter-text").textContent = (label ? label + " " : "") + pct + " %";
  },
  log(text) {
    this.lines.push(text);
    const pre = $("sheet-log");
    pre.textContent += text + "\n";
    pre.scrollTop = pre.scrollHeight;
  },
  /** A question with two answers. Resolves true for `yes`. */
  ask({ text, more = null, yes, no }) {
    return new Promise((resolve) => {
      $("sheet-ask-text").textContent = text;
      $("sheet-ask-more").textContent = more ?? "";
      $("sheet-ask-more").hidden = !more;
      $("sheet-yes").textContent = yes;
      $("sheet-no").textContent = no;
      $("sheet-ask").hidden = false;
      this.word("ask", "YOUR WORD");
      const done = (answer) => {
        $("sheet-ask").hidden = true;
        this.word("work", "WORKING");
        $("sheet-yes").onclick = $("sheet-no").onclick = null;
        resolve(answer);
      };
      $("sheet-yes").onclick = () => done(true);
      $("sheet-no").onclick = () => done(false);
      $("sheet-no").focus();
    });
  },
  /** The browser's list of ports needs a press of a button: this asks for one. Resolves to a port or null. */
  pick(text) {
    return new Promise((resolve) => {
      $("sheet-ask-text").textContent = text;
      $("sheet-ask-more").hidden = true;
      $("sheet-yes").textContent = "CHOOSE THE BOARD";
      $("sheet-no").textContent = "STOP";
      $("sheet-ask").hidden = false;
      this.word("ask", "YOUR WORD");
      const done = (port) => {
        $("sheet-ask").hidden = true;
        this.word("work", "WORKING");
        $("sheet-yes").onclick = $("sheet-no").onclick = null;
        resolve(port);
      };
      $("sheet-yes").onclick = () => { pickPort().then(done, () => done(null)); };
      $("sheet-no").onclick = () => done(null);
    });
  },
  finish(tone, word, nodes, again = null) {
    this.word(tone === "green" ? "done" : tone === "red" ? "fail" : "work", word);
    const box = $("sheet-outcome");
    box.dataset.tone = tone;
    box.replaceChildren(...nodes);
    box.hidden = false;
    $("sheet-close").hidden = false;
    $("sheet-again").hidden = !again;
    $("sheet-again").onclick = again;
    if (tone !== "green") $("sheet-meter").hidden = true;
    if (tone === "red" && this.lines.length) $("sheet-log-box").open = true;
    $("sheet-close").focus();
  },
  close() { $("sheet").hidden = true; },
};

const HINTS = {
  busy: ["Another program may hold the port. Close serial monitors and other flashing tools, then try again."],
  "boot-button": [
    "Put the board into its loader by hand: unplug its USB cable, hold its BOOT button, plug the cable in, let go.",
    "Then press Try again. The firmware that is on it is not harmed by this.",
  ],
  "boot-button-silent": [
    "The board said nothing and no loader answered. It may be asleep, or carry no firmware.",
    "Unplug its USB cable, hold its BOOT button, plug the cable in, let go. Then press Try again.",
  ],
  replug: ["Unplug the board's USB cable and plug it in again, then press Try again."],
  again: ["The board waits in its loader. Press Try again: the loader is in the chip itself and cannot be overwritten."],
};
const LEFT_DIRECT = {
  unchanged: "Nothing was written. The board has what it had.",
  loader: "The board sits in its loader with a flash that is not whole. It will not start until a flash goes through.",
  unknown: "The board's state is not known.",
};

async function loadEsptool() {
  if (!state.esptool) state.esptool = await import("./vendor/esptool-js/bundle.js");
  return state.esptool;
}

function setBusy(on, word, line) {
  state.busy = on;
  renderUnit();
  if (on) hero("work", word, line);
}

/** The words for a question that the flashing code asks. */
function question(q, role) {
  if (q.kind === "other-board") {
    return {
      text: `This board carries the ${BOARDS[q.says].noun}'s firmware${q.version ? " (" + q.version + ")" : ""}. You chose to write the ${BOARDS[q.chosen].noun}'s onto it.`,
      more: "The two sensors are the same board with different firmware, so this can be what you want. A master is another board: sensor firmware does nothing on it.",
      yes: "WRITE IT ANYWAY", no: "STOP",
    };
  }
  if (q.kind === "other-flash") {
    return {
      text: `This board has ${q.flashBytes / 1048576} MB of flash. The ${BOARDS[q.chosen].noun}'s board has ${q.expected / 1048576} MB.`,
      more: "It looks like one of the unit's other boards. Check which socket the cable is in.",
      yes: "WRITE IT ANYWAY", no: "STOP",
    };
  }
  if (q.kind === "usb-reset") {
    return {
      text: "This board does not answer as one of the unit's three firmwares, and it is not in its loader. A new master is like that: it runs its maker's firmware.",
      more: "The page can restart it into its loader over USB. That has worked on the master boards tried so far (chip revision 1.2). A sensor's chip (revision 1.0) hangs when this is done to it, until its power is cut: say yes only for the board with the screen. The other way is by hand: hold BOOT, press RESET, let go, and try again.",
      yes: "RESTART IT OVER USB", no: "STOP",
    };
  }
  if (q.kind === "through-master") {
    return {
      text: q.held
        ? `Port ${q.port.toUpperCase()}: a sensor waits there in its loader. Write the ${BOARDS[role].noun}'s firmware ${q.now} to it (${bytesText(q.size)})?`
        : `Port ${q.port.toUpperCase()}: ${BOARDS[role].noun}, ${q.was ?? "unknown"} to ${q.now} (${bytesText(q.size)}).`,
      more: q.warning,
      yes: "WRITE IT", no: "STOP",
    };
  }
  return { text: "Go on?", yes: "GO ON", no: "STOP" };
}

// --- a board through its own socket ----------------------------------------------
async function flashOwn(role, retryPort = null) {
  if (state.busy) return;
  const b = BOARDS[role];
  const rel = state.release.boards[role];
  if (!rel) return;

  // Which port: the board on the cable if it is this one (or says nothing), else ask.
  let port = retryPort;
  const c = state.conn;
  const usesConn = !port && c && (c.who.role === role || !c.who.role);
  if (usesConn) port = c.port;
  if (!port) {
    try { port = await pickPort(); } catch (e) { hero("fail", "FAILED", "The browser could not list serial ports: " + e.message); return; }
    if (!port) return;
  }
  if (c && port === c.port) await drop();

  const wipe = role === "master" && state.wipe;
  setBusy(true, "WORKING", `Flashing the ${b.noun}.`);
  sheet.open(`FLASHING THE ${b.label}`, `${rel.version}, through ${b.socket}.` + (wipe ? " Its settings are erased as well." : ""),
    [["files", "Fetch and check the files"], ...DIRECT_STEPS]);
  const hooks = {
    log: (t) => sheet.log(t),
    step: (key, s, detail) => sheet.step(key, s, detail),
    progress: (done, total, kind) => sheet.progress(done, total, kind === "done" ? "" : kind),
    confirm: (q) => sheet.ask(question(q, role)),
    pickAgain: (why) => sheet.pick(`The board left USB for ${why} and the browser did not hand it back. Choose it again from the list.`),
  };
  let lastPort = port;
  try {
    sheet.step("files", "run");
    const { board, parts } = await fetchBoard(state.release, role, (done, total) => sheet.progress(done, total, "files"));
    sheet.step("files", "done", `${parts.length} files, each matches its SHA-256`);
    const esptool = await loadEsptool();
    const out = await flashDirect({ serial: state.serial, esptool, port, role, board, parts, wipe, hooks });
    lastPort = out.guard ? out.guard.port : port;

    const nodes = [];
    if (out.settled) {
      nodes.push(el("p", {}, el("strong", { text: `The ${b.noun} runs ${out.now.version}.` }), out.was && out.was.version ? ` It ran ${out.was.version} before.` : ""));
    } else if (out.now) {
      nodes.push(el("p", {}, el("strong", { text: "Written and compared." }), ` The board now says it is the ${BOARDS[out.now.role].noun}, ${out.now.version ?? ""}.`));
    } else {
      nodes.push(el("p", {}, el("strong", { text: "Written and compared." }), " The board has not said hello yet. Unplug it, plug it in again and press Connect to see what it runs."));
    }
    nodes.push(el("p", { class: "mono", text: `ESP32-C5 revision ${out.rev}, ${out.mac}` }));
    if (role !== "master") nodes.push(el("p", { text: "On the master, press PORTS: this sensor's port should be green and name the new version." }));

    // The board stays on the cable: keep talking to it. A master that was
    // connected before a sensor was flashed on another cable stays the connection.
    const keepMaster = !!(state.conn && state.conn.link && role !== "master");
    if (out.io) {
      if (!keepMaster && out.now && out.now.role) {
        adopt(out.guard.port, out.io, out.guard, { ...out.now, caps: out.now.caps ?? [], heard: 1 });
      } else {
        try { await out.io.close(); } catch { /* gone */ }
      }
    }
    if (keepMaster) {
      await new Promise((r) => setTimeout(r, 1500));     // the sensor links to its master again
      try { await refreshMaster(); } catch { /* the cards keep what they had */ }
    }
    if (role === "master" && out.settled && board.settings && state.conn && state.conn.link) {
      const send = el("button", { class: "btn", type: "button", text: "SEND THESE SETTINGS" });
      const said = el("span", { class: "mono" });
      send.addEventListener("click", async () => {
        send.disabled = true;
        const ack = await state.conn.link.cmd("set", { cfg: board.settings });
        said.textContent = ack && ack.ok ? "The master took them." : "The master did not take them.";
      });
      nodes.push(el("p", { text: "This release names settings that a freshly flashed master does not have:" }),
        el("p", { class: "mono", text: JSON.stringify(board.settings) }), el("div", { class: "row" }, send, said));
    }
    sheet.finish(out.settled ? "green" : "amber", out.settled ? "DONE" : "CHECK IT", nodes);
    state.busy = false;
    render();
    if (out.settled) hero("done", "DONE", $("hero-line").textContent);
  } catch (e) {
    if (e && e.port) lastPort = e.port;
    const nodes = [el("p", {}, el("strong", { text: e && e.message ? e.message : String(e) }))];
    if (e instanceof FlashError && e.stopped) {
      sheet.finish("amber", "STOPPED", nodes);
      state.busy = false;
      render();
      return;
    }
    if (e instanceof FlashError) {
      nodes.push(el("p", { text: LEFT_DIRECT[e.left] ?? LEFT_DIRECT.unknown }));
      const hint = HINTS[e.hint];
      if (hint) nodes.push(el("ol", {}, hint.map((h) => el("li", { text: h }))));
    } else if (e instanceof FileError) {
      nodes.push(el("p", { text: "Nothing was sent to the board. The files on this site did not pass their checks: tell whoever runs it." }));
    }
    sheet.finish("red", "FAILED", nodes, () => { sheet.close(); flashOwn(role, lastPort); });
    state.busy = false;
    render();
    hero("fail", "FAILED", "The flash did not go through. The sheet says what state the board is in.");
  }
}

// --- a sensor through the master ---------------------------------------------------
async function flashThrough(role) {
  if (state.busy || throughBlock(role)) return;
  const b = BOARDS[role];
  const rel = state.release.boards[role];
  const link = state.conn.link;
  setBusy(true, "WORKING", `Flashing the ${b.noun} through the master.`);
  sheet.open(`FLASHING THE ${b.label}`, `${rel.version}, through the master.`, [["files", "Fetch and check the file"], ...THROUGH_STEPS]);
  const hooks = {
    log: (t) => sheet.log(t),
    step: (key, s, detail) => sheet.step(key, s, detail),
    progress: (done, total, phase) => sheet.progress(done, total, phase === "hand" ? "to the master" : phase),
    confirm: (q) => sheet.ask(question(q, role)),
  };
  const stopLog = link.onRecord((rec) => {
    if (rec && (rec.event === "flash" || (rec.event === "log" && rec.code === "flash"))) sheet.log(JSON.stringify(rec));
  });
  try {
    sheet.step("files", "run");
    const { parts } = await fetchBoard(state.release, role, (done, total) => sheet.progress(done, total, "files"));
    const app = parts.find((p) => p.kind === "app");
    sheet.step("files", "done", `${bytesText(app.data.length)}, matches its SHA-256`);
    const end = await flashThroughMaster({ link, role, image: app.data, version: rel.version, hooks });
    await refreshMaster();
    const nodes = [
      el("p", {}, el("strong", { text: `The ${b.noun} on port ${String(end.port).toUpperCase()} runs ${end.now}.` }), end.was ? ` It ran ${end.was} before.` : ""),
      el("p", { class: "mono", text: `written and compared at ${end.baud} baud in ${Math.round((end.ms ?? 0) / 1000)} s, try ${end.try ?? 1}` }),
    ];
    if (end.version_ok === false) nodes.push(el("p", { text: `Its hello does not name the image's version (${rel.version}). Check on the master's PORTS screen that it runs what was sent.` }));
    sheet.finish(end.version_ok === false ? "amber" : "green", end.version_ok === false ? "CHECK IT" : "DONE", nodes);
    state.busy = false;
    render();
  } catch (e) {
    const nodes = [el("p", {}, el("strong", { text: e && e.message ? e.message : String(e) }))];
    if (e instanceof ThroughError && e.stopped) {
      sheet.finish("amber", "STOPPED", nodes);
      state.busy = false;
      render();
      return;
    }
    if (e instanceof ThroughError) {
      nodes.push(el("p", { text: e.begun ? (LEFT[e.left] ?? "The sensor's state is not known: look at the master's PORTS screen.") : "Nothing reached the sensor." }));
    } else if (e instanceof FileError) {
      nodes.push(el("p", { text: "Nothing was sent to the master. The file on this site did not pass its checks: tell whoever runs it." }));
    }
    try { await refreshMaster(); } catch { /* the master may have gone */ }
    sheet.finish("red", "FAILED", nodes, () => { sheet.close(); flashThrough(role); });
    state.busy = false;
    render();
  } finally {
    stopLog();
  }
}

// --- pretend boards, for ?demo ------------------------------------------------------
async function pretend() {
  const sim = await import("./demo/sim.js");
  const serial = new sim.PretendSerial();
  const mk = (project, version, seed) => sim.makeImage({ project, version, size: 256 * 1024, seed });
  const opts = { pace: 1, awayMs: 500 };
  const rfA = serial.add(new sim.PretendBoard({ name: "The same unit's RF sensor, by its own socket", kind: "xiao", image: await mk("widscan58", "c9dfff6", 3), mac: [0x10, 0xbd, 0xa3, 0x00, 0x0a, 0x03], ...opts }));
  const ridA = serial.add(new sim.PretendBoard({ name: "The same unit's Remote ID sensor, by its own socket", kind: "xiao", image: await mk("c5_drone_detector", "0.7.0", 4), mac: [0x10, 0xbd, 0xa3, 0x00, 0x0a, 0x02], ...opts }));
  const masterA = serial.add(sim.wire(new sim.PretendBoard({ name: "A unit's master", kind: "master", image: await mk("uas_detector_master", "0.10.0", 5), mac: [0x10, 0xbd, 0xa3, 0x00, 0x0a, 0x01], ...opts }), { a: rfA, b: ridA }));
  const rfB = new sim.PretendBoard({ kind: "xiao", image: await mk("widscan58", "c9dfff6", 6), ...opts });
  const ridB = new sim.PretendBoard({ kind: "xiao", image: await mk("c5_drone_detector", "0.7.0", 7), ...opts });
  const masterB = serial.add(sim.wire(new sim.PretendBoard({ name: "A master that can flash its sensors", kind: "master", image: await mk("uas_detector_master", "0.13.0", 8), mac: [0x10, 0xbd, 0xa3, 0x00, 0x0b, 0x01], ...opts }), { a: rfB, b: ridB }));
  const blank = serial.add(new sim.PretendBoard({ name: "A blank XIAO, held in its loader", kind: "xiao", image: null, inLoader: true, mac: [0x10, 0xbd, 0xa3, 0x00, 0x0c, 0x01], ...opts }));
  const fresh = serial.add(new sim.PretendBoard({ name: "A new master, as its maker ships it", kind: "master", image: null, foreign: true, mac: [0x10, 0xbd, 0xa3, 0x00, 0x0d, 0x01], ...opts }));
  const about = new Map([
    [masterA, "firmware 0.10.0; an RF sensor on port A, a Remote ID sensor on port B"],
    [ridA, "firmware 0.7.0, a revision 1.0 chip"],
    [rfA, "firmware c9dfff6, a revision 1.0 chip"],
    [masterB, "firmware 0.13.0, the version that takes sensor images; sensors on both ports"],
    [blank, "nothing on it; as with the BOOT button held while it was plugged in"],
    [fresh, "it runs the maker's own firmware, which knows none of the page's commands"],
  ]);
  const order = [masterA, fresh, ridA, rfA, masterB, blank];
  serial.choose = (boards) => new Promise((resolve) => {
    const list = $("chooser-list");
    const close = (board) => { $("chooser").hidden = true; resolve(board); };
    list.replaceChildren(...order.filter((x) => boards.includes(x)).map((board) => {
      const button = el("button", { class: "btn", type: "button" }, board.name, el("small", { text: about.get(board) }));
      button.addEventListener("click", () => close(board));
      return el("li", {}, button);
    }));
    $("chooser-cancel").onclick = () => close(null);
    $("chooser").hidden = false;
  });
  window.pretend = { serial, boards: { masterA, ridA, rfA, masterB, ridB, rfB, blank, fresh } };   // for a look from the console
  return serial;
}

// --- start ----------------------------------------------------------------------------
async function start() {
  try {
    state.catalog = await loadCatalog();
    state.release = firstRelease(state.catalog);
    if (!state.release) throw new Error("the catalog lists no release");
  } catch (e) {
    hero("fail", "NO CATALOG", "The list of releases could not be loaded: " + e.message);
    $("connect").disabled = true;
    return;
  }
  if (demo) {
    $("demo-banner").hidden = false;
    $("demo-link").hidden = true;
    state.serial = await pretend();
  } else if ("serial" in navigator) {
    state.serial = navigator.serial;
  }

  renderReleasePicker();
  renderRelease();
  render();

  $("release-select").addEventListener("change", (e) => {
    state.release = state.catalog.releases.find((r) => r.tag === e.target.value) ?? state.release;
    renderRelease();
    render();
  });
  $("gate-tick").addEventListener("change", (e) => { state.armed = e.target.checked; renderUnit(); });
  $("connect").addEventListener("click", connect);
  $("disconnect").addEventListener("click", async () => { await drop(); render(); });
  $("sheet-close").addEventListener("click", () => sheet.close());
  $("sheet-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(sheet.lines.join("\n"));
      $("sheet-copy").textContent = "COPIED";
    } catch {
      $("sheet-log-box").open = true;
      $("sheet-copy").textContent = "SELECT IT BELOW";
    }
    setTimeout(() => { $("sheet-copy").textContent = "COPY LOG"; }, 1600);
  });
  if (state.serial) {
    // A cable pulled while nothing is being flashed: forget the board.
    state.serial.addEventListener("disconnect", (event) => {
      const port = event.port ?? event.target;
      if (!state.busy && state.conn && port === state.conn.port) drop().then(render);
    });
  }
}

start();
