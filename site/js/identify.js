// Ask a board what it is, over its own USB port, without changing anything.
//
// The master greets a new reader with `m_hello` and sends `m_status` every
// second. A sensor answers the plain line `get` `hello` with a `hello` record
// that names its role. The RF sensor also has a text console, where `INFO`
// names its build. A board that says nothing is in its ROM loader, asleep,
// or has no firmware.

import { BOARDS, ROLES } from "./boards.js";
import { unframed } from "./bytes.js";

function parse(line) {
  const text = unframed(line.trim());
  if (!text.startsWith("{")) return null;
  try {
    const rec = JSON.parse(text);
    return rec && typeof rec === "object" && !Array.isArray(rec) ? rec : null;
  } catch {
    return null;
  }
}

/** What one line tells: { role, sure, record } or null. `sure` is true for a record that names the firmware. */
export function classify(line) {
  const rec = parse(line);
  if (rec) {
    if (rec.event === "m_hello") return { role: "master", sure: true, record: rec };
    if (rec.event === "hello" && ROLES.includes(rec.role)) return { role: rec.role, sure: true, record: rec };
    const byFw = ROLES.find((r) => BOARDS[r].fw === rec.fw);
    if (byFw && rec.event === "hello") return { role: byFw, sure: true, record: rec };
    if (rec.event === "m_status" || rec.event === "alert") return { role: "master", sure: false, record: rec };
    if (rec.role === "rid" || rec.role === "rf") return { role: rec.role, sure: false, record: rec };
    return null;
  }
  // The RF sensor's text console answers INFO with
  //   INFO widscan58|<target>|<protocol>|<version>|<commit date>|<PHY version>
  const info = /^INFO widscan58\|/.exec(line.trim());
  if (info) {
    const fields = line.trim().split("|");
    return { role: "rf", sure: true, record: { fw: "fpv-detector", fw_ver: fields[3] || null, board: fields[1] || null } };
  }
  return null;
}

/**
 * Listens, then asks. Returns
 *   { role, version, git, record, heard }   a firmware answered
 *   { role: null, heard }                   nothing that names a firmware (heard: how many lines came)
 */
export async function identify(io, { settleMs = 450, answerMs = 1500, id = 1 } = {}) {
  let best = null;
  let heard = 0;
  const stop = io.onLine((line) => {
    if (line === null) return;
    heard++;
    const got = classify(line);
    if (got && (!best || (got.sure && !best.sure))) best = got;
  });
  const waitSure = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until && !(best && best.sure) && !io.lost) await new Promise((r) => setTimeout(r, 30));
  };
  try {
    await waitSure(settleMs);
    if (!(best && best.sure) && !io.lost) {
      // Both forms at once: a sensor's JSON command, and the RF sensor's console word.
      // Each firmware ignores the line that is not its own.
      await io.write(`{"cmd":"get","id":${id},"what":"hello"}`);
      await io.write("INFO");
      await waitSure(answerMs);
    }
  } catch {
    // The port went away while we asked: the caller sees io.lost.
  } finally {
    stop();
  }
  if (!best) return { role: null, heard };
  const rec = best.record ?? {};
  return {
    role: best.role,
    sure: best.sure,
    version: rec.fw_ver ?? rec.version ?? null,
    git: rec.git || null,
    board: rec.board ?? null,
    caps: Array.isArray(rec.caps) ? rec.caps : [],
    ports: Array.isArray(rec.ports) ? rec.ports : null,
    record: best.record,
    heard,
  };
}
