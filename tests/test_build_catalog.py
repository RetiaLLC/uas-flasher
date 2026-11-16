"""The build step: what it takes, and what it refuses.

    python3 -m unittest tests/test_build_catalog.py

The images are made up here; nothing is fetched.
"""
import hashlib
import json
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import build_catalog as bc  # noqa: E402


def image(kind, project="uas_detector_master", version="1.0.0", chip=23, size=4096, extra=b""):
    """A made-up application or bootloader that is whole by its own headers."""
    end = size - 32
    length = end - 33
    if kind == "app":
        desc = struct.pack("<II8x32s32s16s16s32s", 0xABCD5432, 0, version.encode(), project.encode(), b"12:00:00", b"Nov 15 2026", b"v5.5.1")
    else:
        desc = struct.pack("<B3xI32s24s", 0x50, 1, b"v5.5.1", b"Nov 15 2026 12:00:00")
    body = (desc + extra).ljust(length, b"\x11")
    head = struct.pack("<BBBBIB3xHBHH4xB", 0xE9, 1, 2, 0x3F, 0x40800000, 0xEE, chip, 0, 100, 199, 1)
    out = head + struct.pack("<II", 0x42000020, length) + body
    checksum = 0xEF
    for b in body:
        checksum ^= b
    out += bytes([checksum])
    return out + hashlib.sha256(out).digest()


def table(app_size=0x400000):
    rows = [(b"nvs", 1, 2, 0x9000, 0x6000), (b"phy_init", 1, 1, 0xF000, 0x1000), (b"factory", 0, 0, 0x10000, app_size)]
    out = b"".join(struct.pack("<2sBBII16sI", b"\xaa\x50", t, st, off, size, label, 0) for label, t, st, off, size in rows)
    out += b"\xeb\xeb" + b"\xff" * 14 + hashlib.md5(out).digest()
    return out.ljust(0xC00, b"\xff")


class Release:
    def __init__(self, test):
        self.dir = tempfile.mkdtemp(prefix="uas_flasher_release_")
        test.addCleanup(lambda: __import__("shutil").rmtree(self.dir, ignore_errors=True))

    def put(self, name, data):
        with open(os.path.join(self.dir, name), "wb") as f:
            f.write(data)
        return self

    def board(self, role, project, version="1.0.0", app=None, sums=True):
        files = {"%s-%s-bootloader.bin" % (role, version): image("bootloader"),
                 "%s-%s-partition-table.bin" % (role, version): table(),
                 "%s-%s-%s.bin" % (role, version, project): app if app is not None else image("app", project, version)}
        for name, data in files.items():
            self.put(name, data)
        if sums:
            self.put("SHA256SUMS-%s.txt" % role, "".join("%s  %s\n" % (hashlib.sha256(d).hexdigest(), n) for n, d in files.items()).encode())
        return self


class BuildCatalog(unittest.TestCase):
    def refused(self, release, words):
        with self.assertRaises(bc.Refused) as caught:
            bc.read_release(release.dir)
        self.assertIn(words, str(caught.exception))

    def test_a_whole_release_is_read_from_the_files_alone(self):
        r = Release(self).board("master", "uas_detector_master", "0.11.0").board("rid", "c5_drone_detector", "0.7.3")
        boards, notes = bc.read_release(r.dir)
        self.assertEqual(sorted(boards), ["master", "rid"])
        m = boards["master"]
        self.assertEqual((m["project"], m["version"], m["flash"]), ("uas_detector_master", "0.11.0", {"mode": "dio", "freq": "80m", "size": "8MB"}))
        self.assertEqual([(p["kind"], p["offset"]) for p in m["parts"]], [("bootloader", 0x2000), ("partition-table", 0x8000), ("app", 0x10000)])
        self.assertEqual(m["nvs"], {"offset": 0x9000, "size": 0x6000})
        self.assertTrue(any("no files for rf" in n for n in notes))

    def test_the_kind_of_a_file_is_read_from_it_not_from_its_name(self):
        r = Release(self)
        r.put("rid-9-a.bin", image("app", "c5_drone_detector", "9")).put("rid-9-b.bin", table()).put("rid-9-c.bin", image("bootloader"))
        boards, _ = bc.read_release(r.dir, need_sums=False)
        self.assertEqual({p["kind"]: p["file"] for p in boards["rid"]["parts"]},
                         {"app": "rid-9-a.bin", "partition-table": "rid-9-b.bin", "bootloader": "rid-9-c.bin"})

    def test_a_master_bench_build_is_refused(self):
        bench = image("app", "uas_detector_master", extra=b"BENCH BUILD: lines that begin with '!' drive the board")
        self.refused(Release(self).board("master", "uas_detector_master", app=bench), "bench build")

    def test_another_project_under_a_boards_name_is_refused(self):
        self.refused(Release(self).board("rid", "widscan58"), "names itself widscan58")
        self.refused(Release(self).board("master", "rid_transmitter"), "names itself rid_transmitter")

    def test_another_chip_is_refused(self):
        self.refused(Release(self).board("rid", "c5_drone_detector", app=image("app", "c5_drone_detector", chip=9)), "not for the ESP32-C5")

    def test_a_file_that_does_not_match_its_sum_is_refused(self):
        r = Release(self).board("rid", "c5_drone_detector")
        r.put("rid-1.0.0-bootloader.bin", image("bootloader", size=4112))
        self.refused(r, "does not match SHA256SUMS-rid.txt")

    def test_missing_sums_are_refused_unless_waived(self):
        r = Release(self).board("rid", "c5_drone_detector", sums=False)
        self.refused(r, "SHA256SUMS-rid.txt is missing")
        self.assertIn("rid", bc.read_release(r.dir, need_sums=False)[0])

    def test_a_file_cut_short_is_refused(self):
        whole = image("app", "c5_drone_detector")
        self.refused(Release(self).board("rid", "c5_drone_detector", app=whole[:-100]), "ends")

    def test_an_application_too_large_for_its_partition_is_refused(self):
        r = Release(self).board("rid", "c5_drone_detector", sums=False)
        r.put("rid-1.0.0-partition-table.bin", table(app_size=0x800))
        with self.assertRaises(bc.Refused) as caught:
            bc.read_release(r.dir, need_sums=False)
        self.assertIn("its partition holds", str(caught.exception))

    def test_a_board_with_a_file_missing_is_refused(self):
        r = Release(self).board("rid", "c5_drone_detector", sums=False)
        os.remove(os.path.join(r.dir, "rid-1.0.0-bootloader.bin"))
        with self.assertRaises(bc.Refused) as caught:
            bc.read_release(r.dir, need_sums=False)
        self.assertIn("has no bootloader", str(caught.exception))

    def test_one_sensor_can_have_a_build_for_each_board(self):
        r = Release(self)
        files = {}
        for middle in ("9.9-xiao", "9.9-ipex-zero"):
            for part, data in (("bootloader", image("bootloader")), ("partition-table", table()),
                               ("widscan58", image("app", "widscan58", "9.9"))):
                name = "rf-%s-%s.bin" % (middle, part)
                r.put(name, data)
                files[name] = data
        r.put("SHA256SUMS-rf.txt", "".join("%s  %s\n" % (hashlib.sha256(d).hexdigest(), n) for n, d in files.items()).encode())
        boards, _ = bc.read_release(r.dir)
        self.assertEqual(sorted(boards), ["rf-9.9-ipex-zero", "rf-9.9-xiao"])
        for key, b in boards.items():
            self.assertEqual(b["role"], "rf")
            self.assertEqual(b["variant"], key[len("rf-"):])
            self.assertTrue(all(p["file"].startswith(key + "-") for p in b["parts"]))

    def test_release_json_adds_what_the_files_cannot_say(self):
        r = Release(self).board("master", "uas_detector_master")
        r.put("release.json", json.dumps({"schema": 1, "boards": {"master": {"settings": {"sg_margin_db": 12}, "notes": ["a note"]}}}).encode())
        m = bc.read_release(r.dir)[0]["master"]
        self.assertEqual((m["settings"], m["notes"]), ({"sg_margin_db": 12}, ["a note"]))

    def test_build_writes_the_catalog_and_copies_the_files(self):
        root = tempfile.mkdtemp(prefix="uas_flasher_build_")
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        releases, site = os.path.join(root, "releases"), os.path.join(root, "site")
        os.makedirs(os.path.join(releases, "v1"))
        os.makedirs(site)
        r = Release(self).board("master", "uas_detector_master", "0.11.0")
        for name in os.listdir(r.dir):
            os.rename(os.path.join(r.dir, name), os.path.join(releases, "v1", name))
        with open(os.path.join(releases, "v1", "release.meta.json"), "w") as f:
            json.dump({"tag": "v1", "title": "One", "date": "2026-11-15", "channel": "verified", "body": "notes"}, f)
        none = os.path.join(root, "no-config.json")
        self.assertEqual(bc.main(["build", "--releases", releases, "--out", site, "--config", none]), 0)
        with open(os.path.join(site, "catalog.json")) as f:
            cat = json.load(f)
        rel = cat["releases"][0]
        self.assertEqual((cat["schema"], rel["tag"], rel["channel"], rel["missing"]), (1, "v1", "verified", ["rid", "rf"]))
        self.assertNotIn("notes", rel, "the team's notes stay out of a catalog that anyone can read")
        for p in rel["boards"]["master"]["parts"]:
            with open(os.path.join(site, p["file"]), "rb") as f:
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(), p["sha256"])
        self.assertEqual(bc.main(["build", "--releases", releases, "--out", site, "--config", none, "--with-notes"]), 0)
        with open(os.path.join(site, "catalog.json")) as f:
            self.assertEqual(json.load(f)["releases"][0]["notes"], "notes")

    def test_the_publisher_names_a_release_alpha_or_beta(self):
        root = tempfile.mkdtemp(prefix="uas_flasher_build_")
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        releases, site = os.path.join(root, "releases"), os.path.join(root, "site")
        os.makedirs(site)
        for tag, version, state in (("r1", "0.11.0", "draft"), ("r2", "0.12.0", "draft")):
            os.makedirs(os.path.join(releases, tag))
            r = Release(self).board("master", "uas_detector_master", version)
            for name in os.listdir(r.dir):
                os.rename(os.path.join(r.dir, name), os.path.join(releases, tag, name))
            with open(os.path.join(releases, tag, "release.meta.json"), "w") as f:
                json.dump({"tag": tag, "title": tag, "date": "2026-11-15", "channel": state, "body": ""}, f)
        config = os.path.join(root, "releases.config.json")
        with open(config, "w") as f:
            json.dump({"releases": {"r1": {"channel": "alpha", "label": "Alpha", "note": "Validated."}, "r2": {"channel": "beta", "label": "Beta"}}}, f)
        self.assertEqual(bc.main(["build", "--releases", releases, "--out", site, "--config", config]), 0)
        with open(os.path.join(site, "catalog.json")) as f:
            got = json.load(f)["releases"]
        self.assertEqual([(r["tag"], r["channel"], r.get("label"), r.get("note")) for r in got],
                         [("r1", "alpha", "Alpha", "Validated."), ("r2", "beta", "Beta", None)])
        # recommended first, fallback last, and a borrowed sensor build
        r = Release(self).board("rid", "c5_drone_detector", "0.7.3")
        for name in os.listdir(r.dir):
            os.rename(os.path.join(r.dir, name), os.path.join(releases, "r1", name))
        with open(config, "w") as f:
            json.dump({"releases": {"r1": {"channel": "fallback", "label": "Fallback"},
                                    "r2": {"channel": "recommended", "label": "Recommended", "borrow": {"rid": "r1"}}}}, f)
        self.assertEqual(bc.main(["build", "--releases", releases, "--out", site, "--config", config]), 0)
        with open(os.path.join(site, "catalog.json")) as f:
            got = json.load(f)["releases"]
        self.assertEqual([(r["tag"], r["channel"]) for r in got], [("r2", "recommended"), ("r1", "fallback")])
        self.assertEqual(sorted(got[0]["boards"]), ["master", "rid"])
        self.assertEqual(got[0]["boards"]["rid"]["parts"][0]["file"].split("/")[1], "r1")
        self.assertNotIn("rid", got[0]["missing"])
        with open(config, "w") as f:
            json.dump({"releases": {"r1": {"channel": "gamma"}}}, f)
        self.assertEqual(bc.main(["build", "--releases", releases, "--out", site, "--config", config]), 1)


if __name__ == "__main__":
    unittest.main()
