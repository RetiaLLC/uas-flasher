# UAS Detector firmware page

The page at **https://retiallc.github.io/uas-flasher/** flashes the three boards of a UAS detector unit from a browser, over USB, with Web Serial. It is made in the manner of scriptkitty.sh.

> **State, 15 Nov 2026: not yet tried on a real board.** The page and its code have been run against pretend boards only. The notice at the top of the page says so, and comes out once a real board has been flashed from it.

Add `?demo` to the address to try the page with pretend boards and nothing plugged in.

## Three ways in

| | Cable in | How |
| --- | --- | --- |
| The master | The master's USB-C | The page asks the running master to restart into its loader, writes the bootloader, the partition table and the application with esptool-js, leaves with the chip's watchdog and reads the master's new hello |
| A sensor, through the master | The master's USB-C | The page hands the sensor's application to the master, which writes it over the two wires of the sensor link. Offered only when the master says it can, which no released master does yet |
| A sensor, directly | That sensor's USB-C | The page sends the sensor's own loader command, writes, and leaves with the watchdog |

## What is here

| Path | What |
| --- | --- |
| `site/` | Everything that is served, as it is: edit and reload |
| `site/app.js` | What a person sees and presses |
| `site/js/direct.js` | A board through its own USB socket |
| `site/js/north.js` | The master's stream on USB, and a sensor through the master |
| `site/js/port.js` | The guard that holds DTR and RTS back; text lines on a port; finding a board again after it restarts |
| `site/js/identify.js`, `boards.js` | Asking a board what it is; what the page knows of each board |
| `site/js/image.js`, `bytes.js`, `catalog.js` | Reading a firmware file's own headers; checksums; the catalog and its files, checked again in the browser |
| `site/demo/sim.js` | Pretend boards behind a stand-in for Web Serial. Loaded only with `?demo`, and by the tests |
| `site/vendor/` | esptool-js 0.7.1 and two typefaces, served from here. The page loads nothing from another site |
| `site/catalog.json`, `site/firmware/` | Written by the build step below. The page reads nothing else |
| `scripts/build_catalog.py` | Fetches releases and turns them into the catalog and the served files |
| `scripts/serve.py` | A local server with caching off, for a look at the page |
| `tests/` | `sh tests/run.sh` |
| `.github/workflows/pages.yml` | On every push to `main`: runs the tests, then publishes `site/` |

## Bringing a release onto the page

A browser cannot fetch a release file from GitHub, so the page serves its own copies. The firmware's repository is private; with `gh` signed in to an account that can read it:

```
python3 scripts/build_catalog.py fetch --repo <owner>/<firmware repository> --into releases
python3 scripts/build_catalog.py build --releases releases --out site
git add site && git commit && git push
```

`fetch` skips drafts unless given `--drafts`; the page marks a draft as one and asks for a tick before it flashes it. `build` checks every file, refuses a release that fails a check, and writes `site/firmware/<tag>/` and `site/catalog.json`. The push publishes it.

The catalog carries what the page needs and no more. A release's own notes are written for the team that makes the firmware and stay out unless `build` is given `--with-notes`.

To see what one directory of files says of itself:

```
python3 scripts/build_catalog.py check releases/<tag>
```

### What a release has to be

1. A published release with a tag. A pre-release is shown as untested, a full release as verified.
2. Three files a board, named `<role>-<version>-<anything>.bin` with `<role>` one of `master`, `rid`, `rf`: a bootloader, a partition table, an application. Which is which is read from the files.
3. `SHA256SUMS-<role>.txt` beside them.
4. Normal builds only.
5. Optionally `release.json`, for what the files cannot say:

```json
{
  "schema": 1,
  "boards": {
    "master": {
      "settings": {"sg_margin_db": 12},
      "notes": ["Shown under the board's files."]
    }
  }
}
```

`settings` is one `set` command that the page offers to send to a master after it has flashed it. `table_offset` overrides 0x8000, the one place the files do not name.

Read from the files and never typed by a person: the board an application is for (its project name), its version and build date, the flash settings, where the application goes (the partition table), and that nothing is cut short (the SHA-256 each image carries).

Refused: files that do not match their sums; an application that is not one of the three projects, is not for the ESP32-C5, or does not fit its partition; a board with a file missing or doubled; and a master bench build, which writes the pairing passkey to its log and must not be handed out.

## Looking at it on your own computer

```
python3 scripts/serve.py site 8791
```

Then open `http://localhost:8791/`, or `http://localhost:8791/?demo` for pretend boards. `localhost` counts as a secure address, so Web Serial works there.

On a Mac a program needs permission to read `~/Documents`, and a server started by a tool that cannot answer the system's question hangs before it listens. `sh scripts/preview_copy.sh /tmp/uas-site` copies `site/` to a place that needs no permission.

## Tests

```
sh tests/run.sh
```

Needs Node 20 or later and Python 3. About a minute.

| File | What it shows |
| --- | --- |
| `tests/test_build_catalog.py` | The build step: a whole release read from its files, and each thing it refuses |
| `tests/image.test.mjs` | The checksums against Node's own; the sensor link's framing; the catalog's files against what the catalog says |
| `tests/direct.test.mjs` | `direct.js` with esptool-js 0.7.1 against pretend boards, writing the real files of the release in the catalog: the master, both sensors, a silent board in its loader, the wrong board, two boards at once, a board that stays on USB. Every test checks that DTR and RTS were never changed |
| `tests/through.test.mjs` | `north.js` against a pretend master |
| `tests/master_host.test.mjs` | `north.js` against the firmware repository's own master, built for a laptop, and its simulated sensors. Needs `UAS_TREE` and is skipped without it |

`UAS_TREE` is a checkout or an export of the firmware's repository at a commit that has the master's sensor flasher:

```
UAS_TREE=/path/to/that/tree sh tests/run.sh
```

## How the page treats a board

- **It never changes DTR or RTS.** Both sensors are revision 1.0 ESP32-C5 chips, and one that is reset through those lines hangs in its ROM until its power is cut (measured on the project's benches, 13 and 14 Nov 2026). esptool-js falls back to that reset when a change of baud rate fails. The page keeps the rate at the ROM's, which costs nothing on USB, and `GuardedPort` holds every change of the two lines back, whoever asks for it.
- **Into the loader by the firmware's own command.** The master: `{"cmd":"reboot","id":N,"mode":"download"}`. The Remote ID sensor: the plain line `{"cmd":"boot","id":N,"mode":"download"}`, then the link's framed form. The RF sensor: `BOOTLOADER` on its console. A board that says nothing is tried as it is, since it may sit in its loader already.
- **It asks before it writes onto another board than the one chosen.** A board names itself by its hello, or by the application in its flash. The master's board is also told from a sensor's by its flash size.
- **Watchdogs off while it writes, and the watchdog to leave.** Both are register writes to the chip's LP watchdog at `0x600B1C00` (read in ESP-IDF 5.5.1, `soc/esp32c5/register/soc/lp_wdt_reg.h`). The reset clears the "start in the loader" latch, which an ordinary reset does not.
- **Every file is compared.** The page checks each file's SHA-256 against the catalog before it sends a byte, and after each write it compares the loader's MD5 of the flash with the file's.
- **An update leaves the settings alone.** It writes three files at their own places. The box on the master's card also blanks the settings partition.
- **A sensor through the master** carries the master's own warning: that version of its flasher writes over the sensor's only firmware.

## What has been checked, and what has not

Checked on 15 Nov 2026, on a Mac, with no board:

- `sh tests/run.sh` passes: 12 tests of the build step and 28 of the page's code (two of the 28 need `UAS_TREE`).
- In a browser, with pretend boards: a master flashed with the release's real files, a sensor through a pretend master, a sensor through its own socket, the question about a wrong board, and the layout at 375 px.
- `north.js` took the firmware repository's own master through a whole sensor flash against its simulated sensor and pretend ROM loader.

Not checked:

- **Anything on a board.** No ESP32-C5 has met esptool-js here. The pretend boards answer the way the code asks; they are not the chip.
- Web Serial itself: whether a board that restarts comes back as a new port without the browser asking again. The code handles both, and asks the person to choose the board again if neither happens.
- How a real sensor answers on its own USB port while it is linked to a master.

The first board step: a master, read through the page, flashed with the release it already runs, its hello compared before and after.

## Licences of what is served

- esptool-js 0.7.1: Apache License 2.0, `site/vendor/esptool-js/LICENSE.txt`. See `VENDOR.md` beside it.
- Space Grotesk and JetBrains Mono: SIL Open Font License 1.1, `site/vendor/fonts/README.txt`.
- The firmware images are built on ESP-IDF 5.5.1 (Apache License 2.0). The Remote ID sensor's firmware is under the Apache License 2.0.
- The page's own code and the master's firmware: no licence chosen yet.
