// What a firmware file says about itself.
//
// The layout is ESP-IDF's (esp_app_format.h, esp_app_desc.h, esp_bootloader_desc.h,
// and the partition table's binary form). An image begins with a header of 24
// bytes: 0xE9, the count of segments, the flash mode, size and frequency, the
// chip in bytes 12 and 13, and "a SHA-256 follows" in byte 23. Each segment
// comes behind its address and length. The first segment of an application
// begins with its descriptor: project, version, build date. The first segment
// of a bootloader begins with a shorter one.

import { ascii, hex } from "./bytes.js";

export const CHIP_ESP32C5 = 23;
const IMAGE_MAGIC = 0xe9;
const APP_DESC_MAGIC = 0xabcd5432;
const BOOT_DESC_MAGIC = 0x50;
const FLASH_MODES = { 0: "qio", 1: "qout", 2: "dio", 3: "dout" };
const FLASH_FREQS = { 0: "40m", 1: "26m", 2: "20m", 15: "80m" };
const FLASH_SIZES = { 0: "1MB", 1: "2MB", 2: "4MB", 3: "8MB", 4: "16MB", 5: "32MB", 6: "64MB", 7: "128MB" };

/** Reads an application or a bootloader image. `problems` is empty for one that is whole. */
export function readImage(bytes) {
  const out = { kind: "unknown", size: bytes.length, problems: [] };
  if (bytes.length < 24 + 8 || bytes[0] !== IMAGE_MAGIC) {
    out.problems.push("not an image: it does not begin with 0xE9");
    return out;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  out.chipId = view.getUint16(12, true);
  out.flash = {
    mode: FLASH_MODES[bytes[2]] ?? String(bytes[2]),
    freq: FLASH_FREQS[bytes[3] & 15] ?? String(bytes[3] & 15),
    size: FLASH_SIZES[bytes[3] >> 4] ?? String(bytes[3] >> 4),
  };
  out.minRev = view.getUint16(15, true);
  out.maxRev = view.getUint16(17, true);

  let at = 24;
  let checksum = 0xef;
  const first = at + 8;
  for (let i = 0; i < bytes[1]; i++) {
    if (at + 8 > bytes.length) { out.problems.push("the file ends inside a segment's header"); return out; }
    const length = view.getUint32(at + 4, true);
    at += 8;
    if (at + length > bytes.length) { out.problems.push("the file ends inside a segment: it is cut short"); return out; }
    for (let j = at; j < at + length; j++) checksum ^= bytes[j];
    at += length;
  }
  const end = (Math.floor(at / 16) + 1) * 16;
  if (end > bytes.length) { out.problems.push("the file ends before its checksum"); return out; }
  if (bytes[end - 1] !== checksum) out.problems.push("the checksum over its segments is wrong");
  out.total = end;
  out.hashAppended = bytes[23] === 1;
  if (out.hashAppended) {
    out.total = end + 32;
    if (out.total > bytes.length) out.problems.push("the file ends before its SHA-256");
    else out.hashedLength = end;
  }
  if (out.total < bytes.length) {
    for (let j = out.total; j < bytes.length; j++) {
      if (bytes[j] !== 0xff) { out.problems.push((bytes.length - out.total) + " bytes follow the image that are not part of it"); break; }
    }
  }

  if (first + 176 <= bytes.length && view.getUint32(first, true) === APP_DESC_MAGIC) {
    out.kind = "app";
    out.version = ascii(bytes.subarray(first + 16, first + 48));
    out.project = ascii(bytes.subarray(first + 48, first + 80));
    out.time = ascii(bytes.subarray(first + 80, first + 96));
    out.date = ascii(bytes.subarray(first + 96, first + 112));
    out.idf = ascii(bytes.subarray(first + 112, first + 144));
    out.elfSha256 = hex(bytes.subarray(first + 144, first + 176));
  } else if (first + 64 <= bytes.length && bytes[first] === BOOT_DESC_MAGIC) {
    out.kind = "bootloader";
    out.idf = ascii(bytes.subarray(first + 8, first + 40));
    out.built = ascii(bytes.subarray(first + 40, first + 64));
  } else {
    out.problems.push("an image with no descriptor: neither an application nor a bootloader of ESP-IDF 5");
  }
  return out;
}

/** Checks the SHA-256 an image carries at its end. Resolves to true, false, or null if it carries none. */
export async function imageHashOk(bytes, image) {
  if (!image.hashAppended || image.hashedLength == null) return null;
  const want = hex(bytes.subarray(image.hashedLength, image.hashedLength + 32));
  const got = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.subarray(0, image.hashedLength))));
  return want === got;
}

/** The first bytes of an application, as read back from a board's flash: enough for its descriptor. */
export const APP_HEAD_BYTES = 0x120;

export function readAppHead(bytes) {
  if (bytes.length < APP_HEAD_BYTES || bytes[0] !== IMAGE_MAGIC) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0x20, true) !== APP_DESC_MAGIC) return null;
  return {
    chipId: view.getUint16(12, true),
    version: ascii(bytes.subarray(0x30, 0x50)),
    project: ascii(bytes.subarray(0x50, 0x70)),
    time: ascii(bytes.subarray(0x70, 0x80)),
    date: ascii(bytes.subarray(0x80, 0x90)),
  };
}

/** Reads a partition table. Returns null if the file is not one. */
export function readPartitionTable(bytes) {
  if (bytes.length < 32 || bytes[0] !== 0xaa || bytes[1] !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let md5 = null;
  for (let at = 0; at + 32 <= bytes.length; at += 32) {
    if (bytes[at] === 0xaa && bytes[at + 1] === 0x50) {
      entries.push({
        label: ascii(bytes.subarray(at + 12, at + 28)),
        type: bytes[at + 2],
        subtype: bytes[at + 3],
        offset: view.getUint32(at + 4, true),
        size: view.getUint32(at + 8, true),
      });
    } else if (bytes[at] === 0xeb && bytes[at + 1] === 0xeb) {
      md5 = hex(bytes.subarray(at + 16, at + 32));
      break;
    } else {
      break;
    }
  }
  // The slot a fresh board starts from: the factory application, or the first OTA slot.
  const app = entries.find((e) => e.type === 0 && e.subtype === 0) ?? entries.find((e) => e.type === 0 && e.subtype === 0x10) ?? null;
  const nvs = entries.find((e) => e.type === 1 && e.subtype === 2) ?? null;
  return { entries, md5, app, nvs };
}
