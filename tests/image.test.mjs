// The checksums and what the page reads out of a firmware file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { catalog, sim, SITE } from "./helpers.mjs";

const { crc32, md5, sha256, hex8, framed, unframed, base64 } = await import(SITE + "/js/bytes.js");
const { readImage, readPartitionTable, readAppHead, imageHashOk } = await import(SITE + "/js/image.js");
const { compareVersions, loaderLines } = await import(SITE + "/js/boards.js");
const { classify } = await import(SITE + "/js/identify.js");

test("MD5, CRC-32 and SHA-256 agree with Node's own", async () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 70001]) {
    const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
    assert.equal(md5(data), createHash("md5").update(data).digest("hex"), `md5 of ${n} bytes`);
    assert.equal(await sha256(data), createHash("sha256").update(data).digest("hex"));
  }
  assert.equal(hex8(crc32(new TextEncoder().encode("123456789"))), "CBF43926");
  assert.equal(base64(new Uint8Array([1, 2, 3, 250])), Buffer.from([1, 2, 3, 250]).toString("base64"));
});

test("the sensor link's framing gives the benches' own lines", () => {
  // The two lines sensors/rid/detector/tools/portal_flash.sh sends, with their checksums.
  assert.equal(framed('{"cmd":"hb","ms":1}'), '{"cmd":"hb","ms":1}*C97C6CEB');
  assert.equal(framed('{"cmd":"boot","id":4000000001,"mode":"download"}'), '{"cmd":"boot","id":4000000001,"mode":"download"}*F5FB19CD');
  assert.equal(unframed('{"a":1}*0123ABCD'), '{"a":1}');
  assert.equal(unframed('{"a":1}'), '{"a":1}');
});

test("each board's own way into its loader", () => {
  assert.deepEqual(loaderLines("master", 7, framed).first, ['{"cmd":"reboot","id":7,"mode":"download"}']);
  assert.deepEqual(loaderLines("rid", 7, framed).first, ['{"cmd":"boot","id":7,"mode":"download"}']);
  assert.deepEqual(loaderLines("rf", 7, framed).first, ["BOOTLOADER"]);
  assert.match(loaderLines("rid", 7, framed).second[0], /^\{"cmd":"hb","ms":1\}\*[0-9A-F]{8}$/);
});

test("the files of the release in the catalog say what the catalog says of them", async () => {
  const release = catalog().releases[0];
  for (const [role, board] of Object.entries(release.boards)) {
    for (const p of board.parts) {
      const data = new Uint8Array(readFileSync(join(SITE, p.file)));
      assert.equal(await sha256(data), p.sha256, p.file);
      if (p.kind === "partition-table") {
        const table = readPartitionTable(data);
        assert.equal(table.app.offset, board.app_slot.offset);
        assert.equal(table.nvs.offset, board.nvs.offset);
        continue;
      }
      const image = readImage(data);
      assert.deepEqual(image.problems, [], p.file);
      assert.equal(image.kind, p.kind);
      assert.equal(image.chipId, 23);
      assert.equal(await imageHashOk(data, image), true);
      if (p.kind === "app") {
        assert.equal(image.project, board.project);
        assert.equal(image.version, board.version);
        assert.deepEqual(image.flash, board.flash);
        assert.equal(readAppHead(data.subarray(0, 0x120)).version, board.version, role);
      }
    }
  }
});

test("a file that is cut short, or changed, is seen", async () => {
  const good = await sim.makeImage({ project: "c5_drone_detector", version: "1.2.3" });
  assert.deepEqual(readImage(good).problems, []);
  assert.equal(await imageHashOk(good, readImage(good)), true);
  assert.match(readImage(good.subarray(0, good.length - 40)).problems[0], /ends|cut short/);
  const changed = good.slice();
  changed[5000] ^= 1;
  assert.match(readImage(changed).problems.join(" "), /checksum/);
  assert.equal(await imageHashOk(changed, readImage(changed)), false);
  assert.match(readImage(new Uint8Array(64)).problems[0], /0xE9/);
});

test("versions: older, newer, the same, or not comparable", () => {
  assert.equal(compareVersions("0.10.0", "0.11.0"), "older");
  assert.equal(compareVersions("0.13.0", "0.11.0"), "newer");
  assert.equal(compareVersions("0.7.3", "0.7.3"), "same");
  assert.equal(compareVersions("0.7.3-dirty", "0.7.3"), "same");
  assert.equal(compareVersions("c9dfff6", "160e231"), "other");
});

test("what a line on USB tells about the board", () => {
  assert.equal(classify('{"schema":1,"event":"m_hello","fw":"uas-detector-master","fw_ver":"0.11.0"}').role, "master");
  assert.equal(classify('{"schema":1,"event":"hello","role":"rid","fw":"c5_drone_detector","fw_ver":"0.7.3"}*0123ABCD').role, "rid");
  const rf = classify("INFO widscan58|esp32c5|7|160e231|2026-11-15T09:00:00+01:00|phy 1.2");
  assert.deepEqual([rf.role, rf.sure, rf.record.fw_ver], ["rf", true, "160e231"]);
  assert.equal(classify('{"schema":1,"event":"m_status","level":"CLEAR"}').sure, false);
  assert.equal(classify("ERR unknown"), null);
  assert.equal(classify("ESP-ROM:esp32c5-eco2-20250121"), null);
});
