// The catalog the build step wrote (scripts/build_catalog.py), and the files it lists.
//
// The page trusts nothing it fetches until it has checked it again here: each
// file's SHA-256 against the catalog, and what each file says of itself against
// the board it is offered for. The build step made the same checks; a file
// that changed on the way does not get written to a board.

import { BOARDS } from "./boards.js";
import { sha256 } from "./bytes.js";
import { CHIP_ESP32C5, readImage, readPartitionTable } from "./image.js";

export async function loadCatalog(url = "catalog.json") {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`the catalog could not be fetched (${response.status})`);
  const catalog = await response.json();
  if (catalog.schema !== 1 || !Array.isArray(catalog.releases)) throw new Error("the catalog is not one this page reads");
  return catalog;
}

/** Channels that have been through a validation: flashed without a tick. */
export const VALIDATED = new Set(["alpha", "verified"]);

/** The release a visitor is offered first: the newest validated one, else the first listed. */
export function firstRelease(catalog) {
  return catalog.releases.find((r) => VALIDATED.has(r.channel)) ?? catalog.releases[0] ?? null;
}

export class FileError extends Error {}

/**
 * Fetches one board's files of a release and checks them.
 * Resolves to { board, parts: [{ kind, offset, data, file }] }.
 */
/** The builds of a release for one role: [[key, build], ...]. Most roles have one; a sensor may have one a board. */
export function buildsOf(release, role) {
  return Object.entries(release ? release.boards : {}).filter(([key, b]) => (b.role ?? key) === role);
}

export async function fetchBoard(release, key, onProgress = () => {}, base = "") {
  const board = release.boards[key];
  if (!board) throw new FileError(`this release has no files for ${key}`);
  const role = board.role ?? key;
  const parts = [];
  const total = board.parts.reduce((n, p) => n + p.size, 0);
  let done = 0;
  for (const p of board.parts) {
    const response = await fetch(base + p.file);
    if (!response.ok) throw new FileError(`${p.file} could not be fetched (${response.status})`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== p.size) throw new FileError(`${p.file} is ${data.length} bytes and the catalog says ${p.size}`);
    if ((await sha256(data)) !== p.sha256) throw new FileError(`${p.file} does not match its SHA-256 in the catalog`);
    check(role, board, p, data);
    done += data.length;
    onProgress(done, total);
    parts.push({ kind: p.kind, offset: p.offset, data, file: p.file });
  }
  return { board, parts };
}

/** What the file says of itself has to fit the board it is offered for. */
function check(role, board, part, data) {
  if (part.kind === "partition-table") {
    const table = readPartitionTable(data);
    if (!table || !table.app) throw new FileError(`${part.file} is not a partition table with an application`);
    if (table.app.offset !== board.app_slot.offset) throw new FileError(`${part.file} puts the application elsewhere than the catalog does`);
    return;
  }
  const image = readImage(data);
  if (image.problems.length) throw new FileError(`${part.file}: ${image.problems[0]}`);
  if (image.kind !== part.kind) throw new FileError(`${part.file} is a ${image.kind}, and the catalog lists it as the ${part.kind}`);
  if (image.chipId !== CHIP_ESP32C5) throw new FileError(`${part.file} is for another chip`);
  if (part.kind === "app") {
    if (image.project !== BOARDS[role].project) throw new FileError(`${part.file} names itself ${image.project}, which is not the ${BOARDS[role].name}'s firmware`);
    if (data.length > board.app_slot.size) throw new FileError(`${part.file} does not fit its partition`);
  }
}
