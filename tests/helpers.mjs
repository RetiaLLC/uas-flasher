// Shared by the tests: the page's own modules, esptool-js as the page ships it,
// the catalog the build step wrote, and pretend boards.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SITE = join(ROOT, "site");

export const esptool = await import(join(SITE, "vendor/esptool-js/bundle.js"));
export const sim = await import(join(SITE, "demo/sim.js"));

export function catalog() {
  const path = join(SITE, "catalog.json");
  if (!existsSync(path)) throw new Error("site/catalog.json is missing: run scripts/build_catalog.py first (see README.md)");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** A board of a release with its files read in: { board, parts: [{kind, offset, data}] }. */
export function loadBoard(release, role) {
  const board = release.boards[role];
  if (!board) return null;
  const parts = board.parts.map((p) => ({ kind: p.kind, offset: p.offset, data: new Uint8Array(readFileSync(join(SITE, p.file))) }));
  return { board, parts };
}

export function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Hooks that record everything and answer confirmations from a table. */
export function recorder(answers = {}) {
  const seen = { log: [], steps: [], confirms: [], progress: 0 };
  return {
    seen,
    hooks: {
      log: (t) => seen.log.push(t),
      step: (key, state, detail) => seen.steps.push([key, state, detail ?? ""]),
      progress: () => { seen.progress++; },
      confirm: async (q) => { seen.confirms.push(q); return answers[q.kind] ?? false; },
      pickAgain: async () => null,
    },
  };
}
