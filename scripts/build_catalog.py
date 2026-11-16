#!/usr/bin/env python3
"""Turn releases of the UAS detector into what the flashing page serves.

    build_catalog.py check DIR                      # what the files of one release say of themselves
    build_catalog.py fetch --repo OWNER/NAME --into releases [--drafts]
    build_catalog.py build --releases releases --out site

A browser cannot fetch a release file from GitHub (a private repository needs
a login, and a public one's release files come without the header a page on
another origin needs), so the page serves its own copies. `fetch` brings each
release into its own directory with the `gh` tool. `build` checks every file
and writes site/firmware/<tag>/ and site/catalog.json, which is all the page
reads.

What a release has to be (issue 102 of the firmware's repository):

- Three files a board, named <role>-<version>-<anything>.bin with <role> one
  of master, rid, rf: a bootloader, a partition table, an application. Which
  is which is read from the files, never from their names.
- SHA256SUMS-<role>.txt beside them.
- Optionally release.json, for what the files cannot say (see README.md).

`build` refuses a release whose files do not match their sums, an application
that is not one of the three projects or not for the ESP32-C5 or that does not
fit its partition, and a master bench build. It never changes a file.

Standard library only. Python 3.9 or later.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import zlib

CHIP_ESP32C5 = 23
BOOTLOADER_OFFSET = 0x2000       # where the ESP32-C5's ROM looks for the second-stage loader
TABLE_OFFSET = 0x8000            # ESP-IDF's default; the one figure the files do not carry
TABLE_BYTES = 0xC00
ROLES = ("master", "rid", "rf")
# The project an application names itself by, and the board it is for
# (master/CMakeLists.txt, sensors/rid/detector/CMakeLists.txt, sensors/rf/CMakeLists.txt).
PROJECT_OF = {"master": "uas_detector_master", "rid": "c5_drone_detector", "rf": "widscan58"}
# A master bench build writes the pairing passkey to its log. Its start-up note
# carries this text; a normal build has no "bench" in it at all.
BENCH_MARK = b"BENCH BUILD"
NAME = re.compile(r"^(master|rid|rf)-(.+?)-[^-]+\.bin$")

MODES = {0: "qio", 1: "qout", 2: "dio", 3: "dout"}
FREQS = {0: "40m", 1: "26m", 2: "20m", 15: "80m"}
SIZES = {0: "1MB", 1: "2MB", 2: "4MB", 3: "8MB", 4: "16MB", 5: "32MB", 6: "64MB", 7: "128MB"}


class Refused(Exception):
    """A release that the page must not serve, with the reason."""


def cstr(b):
    return b.split(b"\0", 1)[0].decode("ascii", "replace")


def read_image(d):
    """An application or a bootloader, read. `problems` is empty for one that is whole."""
    out = {"kind": "unknown", "problems": []}
    if len(d) < 32 or d[0] != 0xE9:
        out["problems"].append("not an image: it does not begin with 0xE9")
        return out
    out["chip_id"] = struct.unpack_from("<H", d, 12)[0]
    out["flash"] = {"mode": MODES.get(d[2], str(d[2])), "freq": FREQS.get(d[3] & 15, str(d[3] & 15)),
                    "size": SIZES.get(d[3] >> 4, str(d[3] >> 4))}
    at, checksum, first = 24, 0xEF, 32
    for _ in range(d[1]):
        if at + 8 > len(d):
            out["problems"].append("the file ends inside a segment's header")
            return out
        length = struct.unpack_from("<I", d, at + 4)[0]
        at += 8
        if at + length > len(d):
            out["problems"].append("the file ends inside a segment: it is cut short")
            return out
        for b in d[at:at + length]:
            checksum ^= b
        at += length
    end = (at // 16 + 1) * 16
    if end > len(d):
        out["problems"].append("the file ends before its checksum")
        return out
    if d[end - 1] != checksum:
        out["problems"].append("the checksum over its segments is wrong")
    total = end
    if d[23] == 1:
        total = end + 32
        if total > len(d):
            out["problems"].append("the file ends before its SHA-256")
        elif hashlib.sha256(d[:end]).digest() != d[end:end + 32]:
            out["problems"].append("the SHA-256 at its end does not match the file")
    else:
        out["problems"].append("no SHA-256 is appended: the file cannot show that it is whole")
    if total < len(d) and d[total:].strip(b"\xff"):
        out["problems"].append("%d bytes follow the image that are not part of it" % (len(d) - total))
    if struct.unpack_from("<I", d, first)[0] == 0xABCD5432:
        out["kind"] = "app"
        out["version"] = cstr(d[first + 16:first + 48])
        out["project"] = cstr(d[first + 48:first + 80])
        out["built"] = (cstr(d[first + 96:first + 112]) + " " + cstr(d[first + 80:first + 96])).strip()
        out["idf"] = cstr(d[first + 112:first + 144])
    elif d[first] == 0x50:
        out["kind"] = "bootloader"
        out["idf"] = cstr(d[first + 8:first + 40])
        out["built"] = cstr(d[first + 40:first + 64])
    else:
        out["problems"].append("an image with no descriptor: neither an application nor a bootloader of ESP-IDF 5")
    return out


def read_table(d):
    """A partition table, read; None if the file is not one."""
    if len(d) < 32 or d[:2] != b"\xaa\x50":
        return None
    entries, md5_ok, at = [], None, 0
    while at + 32 <= len(d):
        e = d[at:at + 32]
        if e[:2] == b"\xaa\x50":
            entries.append({"label": cstr(e[12:28]), "type": e[2], "subtype": e[3],
                            "offset": struct.unpack_from("<I", e, 4)[0], "size": struct.unpack_from("<I", e, 8)[0]})
        elif e[:2] == b"\xeb\xeb":
            md5_ok = hashlib.md5(d[:at]).digest() == e[16:32]
            break
        else:
            break
        at += 32
    app = next((e for e in entries if e["type"] == 0 and e["subtype"] == 0), None) or \
        next((e for e in entries if e["type"] == 0 and e["subtype"] == 0x10), None)
    nvs = next((e for e in entries if e["type"] == 1 and e["subtype"] == 2), None)
    return {"entries": entries, "md5_ok": md5_ok, "app": app, "nvs": nvs}


def read_sums(path):
    sums = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$", line)
            if m:
                sums[os.path.basename(m.group(2))] = m.group(1).lower()
    return sums


def middle_of(name, role):
    """The version-and-board part of a file's name: what is left between the role and the part name."""
    stem = name[len(role) + 1:-len(".bin")]
    for part in ("-partition-table", "-bootloader", "-" + PROJECT_OF[role]):
        if stem.endswith(part):
            return stem[:-len(part)]
    return NAME.match(name).group(2)


def read_release(directory, need_sums=True):
    """Every board of one release directory, checked. Returns (boards, notes) or raises Refused."""
    names = sorted(os.listdir(directory))
    extra = {}
    if "release.json" in names:
        with open(os.path.join(directory, "release.json"), encoding="utf-8") as f:
            extra = json.load(f)
        if extra.get("schema") != 1:
            raise Refused("release.json has schema %r, and this build reads schema 1" % extra.get("schema"))
    boards, notes = {}, []
    for role in ROLES:
        mine = [n for n in names if NAME.match(n) and NAME.match(n).group(1) == role]
        if not mine:
            notes.append("no files for %s: the page leaves that board out of this release" % role)
            continue
        more = (extra.get("boards") or {}).get(role) or {}
        sums_name = "SHA256SUMS-%s.txt" % role
        sums = read_sums(os.path.join(directory, sums_name)) if sums_name in names else None
        if sums is None and need_sums:
            raise Refused("%s is missing: the files of %s cannot be checked" % (sums_name, role))
        # One build a board for most roles. A role may have several, one for each
        # board it runs on: their files differ in the middle of the name,
        # <role>-<version and board>-<part>.bin, and each becomes its own entry.
        groups = {}
        for n in mine:
            groups.setdefault(middle_of(n, role), []).append(n)
        for middle, mine in sorted(groups.items()):
            key = role if len(groups) == 1 else "%s-%s" % (role, middle)
            parts = {}
            for n in mine:
                with open(os.path.join(directory, n), "rb") as f:
                    d = f.read()
                sha = hashlib.sha256(d).hexdigest()
                if sums is not None:
                    if n not in sums:
                        raise Refused("%s is not listed in %s" % (n, sums_name))
                    if sums[n] != sha:
                        raise Refused("%s does not match %s" % (n, sums_name))
                table = read_table(d)
                if table:
                    kind, info = "partition-table", table
                else:
                    info = read_image(d)
                    kind = info["kind"]
                    if info["problems"]:
                        raise Refused("%s: %s" % (n, "; ".join(info["problems"])))
                    if info["chip_id"] != CHIP_ESP32C5:
                        raise Refused("%s is for chip %d, not for the ESP32-C5 (23)" % (n, info["chip_id"]))
                if kind in parts:
                    raise Refused("%s has two files of the kind %s: %s and %s" % (role, kind, parts[kind]["file"], n))
                parts[kind] = {"file": n, "size": len(d), "sha256": sha, "info": info, "data": d}
            for kind in ("bootloader", "partition-table", "app"):
                if kind not in parts:
                    raise Refused("%s has no %s among %s" % (role, kind, ", ".join(mine)))
            app, table, boot = parts["app"], parts["partition-table"], parts["bootloader"]
            if app["info"]["project"] != PROJECT_OF[role]:
                raise Refused("%s names itself %s, and the %s board takes %s" % (
                    app["file"], app["info"]["project"], role, PROJECT_OF[role]))
            if role == "master" and BENCH_MARK in app["data"]:
                raise Refused("%s is a bench build: it logs the pairing passkey and must not be handed out" % app["file"])
            if table["info"]["md5_ok"] is False:
                raise Refused("%s: the table's own MD5 does not match its entries" % table["file"])
            slot = table["info"]["app"]
            if not slot:
                raise Refused("%s has no application partition" % table["file"])
            if app["size"] > slot["size"]:
                raise Refused("%s is %d bytes and its partition holds %d" % (app["file"], app["size"], slot["size"]))
            table_offset = int(str(more.get("table_offset", TABLE_OFFSET)), 0)
            first = min(e["offset"] for e in table["info"]["entries"])
            if BOOTLOADER_OFFSET + boot["size"] > table_offset:
                raise Refused("%s would run into the partition table at 0x%x" % (boot["file"], table_offset))
            if table_offset + TABLE_BYTES > first:
                raise Refused("the partition table at 0x%x would run into the first partition at 0x%x" % (table_offset, first))
            named = middle_of(app["file"], role)
            if named != app["info"]["version"]:
                notes.append("%s: the file's name says %s and the application says %s; the page shows the application's" % (
                    role, named, app["info"]["version"]))
            offsets = {"bootloader": BOOTLOADER_OFFSET, "partition-table": table_offset, "app": slot["offset"]}
            boards[key] = {
                "role": role,
                "variant": middle,
                "project": app["info"]["project"],
                "version": app["info"]["version"],
                "built": app["info"]["built"],
                "idf": app["info"]["idf"],
                "flash": app["info"]["flash"],
                "app_slot": {"offset": slot["offset"], "size": slot["size"]},
                "nvs": ({"offset": table["info"]["nvs"]["offset"], "size": table["info"]["nvs"]["size"]}
                        if table["info"]["nvs"] else None),
                "parts": [{"kind": kind, "file": parts[kind]["file"], "offset": offsets[kind], "size": parts[kind]["size"],
                           "sha256": parts[kind]["sha256"]} for kind in ("bootloader", "partition-table", "app")],
            }
            for k2 in ("settings", "notes", "reads_settings_from"):
                if k2 in more:
                    boards[key][k2] = more[k2]
    if not boards:
        raise Refused("no board's files were found: nothing is named <role>-<version>-<part>.bin")
    return boards, notes


def cmd_check(args):
    try:
        boards, notes = read_release(args.dir, need_sums=not args.no_sums)
    except Refused as e:
        print("REFUSED: %s" % e)
        return 1
    for role, b in boards.items():
        print("%s: %s %s, built %s, ESP-IDF %s, flash %s %s %s" % (
            role, b["project"], b["version"], b["built"], b["idf"], b["flash"]["mode"], b["flash"]["freq"], b["flash"]["size"]))
        for p in b["parts"]:
            print("  0x%-6x %-16s %-44s %8d bytes  sha256 %s" % (p["offset"], p["kind"], p["file"], p["size"], p["sha256"][:16]))
        print("  application partition: 0x%x, %d bytes" % (b["app_slot"]["offset"], b["app_slot"]["size"]))
    for n in notes:
        print("note: %s" % n)
    return 0


def gh(*argv):
    done = subprocess.run(("gh",) + argv, capture_output=True, text=True)
    if done.returncode:
        raise Refused("gh %s: %s" % (" ".join(argv[:3]), done.stderr.strip()[-300:]))
    return done.stdout


def cmd_fetch(args):
    listed = json.loads(gh("api", "repos/%s/releases?per_page=50" % args.repo))
    os.makedirs(args.into, exist_ok=True)
    count = 0
    for r in listed:
        if r["draft"] and not args.drafts:
            continue
        tag = r["tag_name"]
        if not re.match(r"^[A-Za-z0-9._-]+$", tag):
            print("skipped %r: a tag the page cannot use as a directory" % tag)
            continue
        target = os.path.join(args.into, tag)
        os.makedirs(target, exist_ok=True)
        gh("release", "download", tag, "-R", args.repo, "-D", target, "--clobber")
        meta = {"tag": tag, "title": r.get("name") or tag,
                "date": (r.get("published_at") or r.get("created_at") or "")[:10],
                "channel": "draft" if r["draft"] else "untested" if r["prerelease"] else "verified",
                "commit": r.get("target_commitish"), "body": r.get("body") or ""}
        with open(os.path.join(target, "release.meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        count += 1
        print("fetched %s (%s): %d files" % (tag, meta["channel"], len(os.listdir(target)) - 1))
    if not count:
        print("no release to fetch: a draft is fetched only with --drafts")
    return 0


CHANNELS = ("recommended", "fallback", "alpha", "beta", "verified", "untested", "draft")


def read_config(path):
    """releases.config.json: how the page presents each release. {} if there is none."""
    if not path or not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        whole = json.load(f)
    listed = whole.get("releases") or {}
    for tag, how in listed.items():
        if how.get("channel") not in CHANNELS:
            raise Refused("%s: %s gives the channel %r, and the page knows %s" % (path, tag, how.get("channel"), ", ".join(CHANNELS)))
    listed = dict(listed)
    listed[None] = whole.get("pending") or []      # what is named and not there yet
    return listed


def cmd_build(args):
    out_fw = os.path.join(args.out, "firmware")
    config = read_config(args.config)
    releases, failed = [], False
    for tag in sorted(os.listdir(args.releases)):
        directory = os.path.join(args.releases, tag)
        if not os.path.isdir(directory):
            continue
        meta_path = os.path.join(directory, "release.meta.json")
        meta = {"tag": tag, "title": tag, "date": "", "channel": "untested", "body": ""}
        if os.path.exists(meta_path):
            with open(meta_path, encoding="utf-8") as f:
                meta.update(json.load(f))
        try:
            boards, notes = read_release(directory, need_sums=not args.no_sums)
        except Refused as e:
            print("REFUSED %s: %s" % (tag, e))
            failed = True
            continue
        target = os.path.join(out_fw, meta["tag"])
        if os.path.isdir(target):
            shutil.rmtree(target)
        os.makedirs(target)
        for b in boards.values():
            for p in b["parts"]:
                shutil.copyfile(os.path.join(directory, p["file"]), os.path.join(target, p["file"]))
                p["file"] = "firmware/%s/%s" % (meta["tag"], p["file"])
        entry = {"tag": meta["tag"], "date": meta["date"], "channel": meta["channel"], "boards": boards,
                 "missing": [r for r in ROLES if r not in {b["role"] for b in boards.values()}]}
        how = config.get(meta["tag"])
        if how:
            # The publisher's own word on how this release is presented, in place of its state on GitHub.
            entry["channel"] = how["channel"]
            for key in ("label", "note"):
                if how.get(key):
                    entry[key] = how[key]
            # Per build: keyed by "<role>-<version and board>", the start of its files' names.
            for name, more in (how.get("boards") or {}).items():
                for b in boards.values():
                    if name == "%s-%s" % (b["role"], b["variant"]):
                        for k2 in ("board_id", "hardware", "label", "notes"):
                            if k2 in more:
                                b[k2] = more[k2]
        if args.with_notes:
            # The release's own title, notes and commit are written for the team that makes the firmware.
            entry.update({"title": meta["title"], "commit": meta.get("commit"), "notes": meta.get("body", "")})
        releases.append(entry)
        print("%s (%s): %s" % (meta["tag"], entry["channel"], ", ".join(
            "%s %s" % (key, b["version"]) for key, b in boards.items())))
        for n in notes:
            print("  note: %s" % n)
    if failed and not args.keep_going:
        print("nothing was written: a refused release stops the build (--keep-going leaves it out instead)")
        return 1
    # A release may list another release's build of a sensor as its own ("borrow": {"rid": "<tag>"}),
    # so the recommended release carries every current build in one place.
    by_tag = {r["tag"]: r for r in releases}
    for r in releases:
        for role, tag in ((config.get(r["tag"]) or {}).get("borrow") or {}).items():
            src = by_tag.get(tag)
            got = {k: dict(b) for k, b in (src or {}).get("boards", {}).items() if b.get("role", k) == role}
            if not got:
                raise SystemExit("%s borrows %s from %s, which has none" % (r["tag"], role, tag))
            r["boards"].update(got)
            r["missing"] = [x for x in r["missing"] if x != role]
    order = {"recommended": 0, "alpha": 1, "verified": 1, "beta": 2, "untested": 2, "draft": 3, "fallback": 4}
    releases.sort(key=lambda r: r["date"], reverse=True)
    releases.sort(key=lambda r: order.get(r["channel"], 3))
    # Directories of releases that are no longer served.
    if os.path.isdir(out_fw):
        for name in os.listdir(out_fw):
            if os.path.isdir(os.path.join(out_fw, name)) and name not in {r["tag"] for r in releases}:
                shutil.rmtree(os.path.join(out_fw, name))
    catalog = {"schema": 1,
               "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "releases": releases}
    # A name the publisher has given to a release that is not there yet is listed as waiting.
    waiting = [w for w in config.get(None, []) if w.get("channel") not in {r["channel"] for r in releases}]
    if waiting:
        catalog["pending"] = [{k: w[k] for k in ("channel", "label", "note") if w.get(k)} for w in waiting]
    with open(os.path.join(args.out, "catalog.json"), "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=1)
        f.write("\n")
    print("wrote %s: %d release%s" % (os.path.join(args.out, "catalog.json"), len(releases), "" if len(releases) == 1 else "s"))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check", help="say what one release directory holds, and whether the page would serve it")
    c.add_argument("dir")
    c.add_argument("--no-sums", action="store_true", help="do not ask for SHA256SUMS files")
    c.set_defaults(fn=cmd_check)
    f = sub.add_parser("fetch", help="bring a repository's releases into a directory each, with gh")
    f.add_argument("--repo", required=True, help="OWNER/NAME")
    f.add_argument("--into", required=True)
    f.add_argument("--drafts", action="store_true", help="also fetch drafts; the page marks them as such")
    f.set_defaults(fn=cmd_fetch)
    b = sub.add_parser("build", help="check every fetched release and write the site's firmware and catalog")
    b.add_argument("--releases", required=True)
    b.add_argument("--out", required=True, help="the site's directory")
    b.add_argument("--no-sums", action="store_true", help="do not ask for SHA256SUMS files")
    b.add_argument("--keep-going", action="store_true", help="leave a refused release out and write the rest")
    b.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "releases.config.json"),
                   help="how the page presents each release (default: releases.config.json beside the scripts)")
    b.add_argument("--with-notes", action="store_true",
                   help="also put each release's title, notes and commit into the catalog; they are the team's own words, "
                        "so leave this out for a page that anyone can read")
    b.set_defaults(fn=cmd_build)
    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except Refused as e:
        print("REFUSED: %s" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
