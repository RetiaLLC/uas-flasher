# UAS Detector firmware page

The page at **https://retiallc.github.io/uas-flasher/** flashes the three boards of a UAS detector unit from a browser, over USB, with Web Serial. It is made in the manner of scriptkitty.sh.

> **State, 16 Nov 2026: one real master flashed, from a terminal and from Chrome.** The page's own code took a new master board from its maker's firmware to master 0.11.0 and updated it again, from a terminal with `tools/board_run.mjs`. The maintainer then flashed the same board from Chrome on the live page, which ended with DONE; the master's hello was read afterwards and named 0.11.0. No sensor has met the page yet.

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
| `scripts/build_guide.py` | Fetches the unit's user guide and turns it into `site/guide/` |
| `scripts/serve.py` | A local server with caching off, for a look at the page |
| `tools/` | The page's code against a real board, from a terminal: see below |
| `releases.config.json` | The name each release goes by on the page (Alpha, Beta), and a line about where it stands |
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

### Alpha and Beta

`releases.config.json` gives a release the name it goes by on the page. A release that is not listed there is shown by its own state on GitHub: verified, untested or draft.

```json
{
  "releases": {
    "release-2026-11-15": { "channel": "alpha", "label": "Alpha", "note": "Validated on a unit through the night of 14 to 15 Nov 2026." }
  },
  "pending": [ { "channel": "beta", "label": "Beta", "note": "The current build. Its files are not in a release yet." } ]
}
```

- **Alpha** is the release that has been through a validation. It is offered first and flashed without a tick.
- **Beta** is the current build. The page asks for a tick before it flashes it.
- A name under `pending` is listed as waiting until a release takes its channel.

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

## The user guide

The unit's guide is written in the firmware's repository (`docs/guide/`) and published here as `site/guide/`: the full guide, the quickstart and the how-to pages, with their pictures, and the two sensors' own pages (`sensors/*/docs/guide/`, published at the maintainer's word of 16 Nov 2026). With `gh` signed in and markdown-it-py installed:

```
python3 scripts/build_guide.py fetch --repo <owner>/<firmware repository> --into guide-src
python3 scripts/build_guide.py build --src guide-src --out site/guide
```

As the guide's owner asked: its last section, which is for the team, is left out, and a link that leaves the guide (into the private repository) is dropped with its words kept. Nothing else changes. `tests/test_guide_pages.py` checks the published pages for both, and that every link and picture inside the guide is there.

## Looking at it on your own computer

```
python3 scripts/serve.py site 8791
```

Then open `http://localhost:8791/`, or `http://localhost:8791/?demo` for pretend boards. `localhost` counts as a secure address, so Web Serial works there.

On a Mac a program needs permission to read `~/Documents`, and a server started by a tool that cannot answer the system's question hangs before it listens. `sh scripts/preview_copy.sh /tmp/uas-site` copies `site/` to a place that needs no permission.

## On a real board, from a terminal

A browser asks a person to pick the port. To run the same code with the device named, and to see every step:

```
PYTHON=/path/to/a/python/with/pyserial node tools/board_run.mjs look  --device /dev/cu.usbmodem1101
PYTHON=... node tools/board_run.mjs flash --device /dev/cu.usbmodem1101 --role master
PYTHON=... node tools/board_run.mjs flash --device /dev/cu.usbmodem1101 --role master --usb-reset
```

`look` writes nothing. `flash` runs `site/js/direct.js` with esptool-js from `site/vendor/`, as the browser does, and writes the first release in the catalog. `--usb-reset` answers yes when the page asks whether to restart a new master over USB; `--yes other-board,other-flash` answers its other questions. Node has no serial ports, so `tools/serial_bridge.py` opens the device and `tools/node_serial.mjs` dresses it as Web Serial, with a board that leaves USB and comes back as a new port.

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

- **It holds DTR and RTS back, except in two places on a master.** Both sensors are revision 1.0 ESP32-C5 chips, and one that is reset through those lines hangs in its ROM until its power is cut (measured on the project's benches, 13 and 14 Nov 2026). esptool-js falls back to that reset when a change of baud rate fails. The page keeps the rate at the ROM's, which costs nothing on USB, and `GuardedPort` holds every change of the two lines back unless the code has opened the guard. It opens it twice, both only when the board chosen is the master: for a restart into the loader that the person has said yes to, and for one restart at the end on a chip that has said it is revision 1.1 or later.
- **Into the loader by the firmware's own command.** The master: `{"cmd":"reboot","id":N,"mode":"download"}`. The Remote ID sensor: the plain line `{"cmd":"boot","id":N,"mode":"download"}`, then the link's framed form. The RF sensor: `BOOTLOADER` on its console. A board that says nothing is tried as it is, since it may sit in its loader already.
- **A new master is asked about.** It runs its maker's firmware, which knows none of these commands. The page asks whether to restart it into its loader over USB, says that a sensor's chip hangs when that is done to it, and names the other way: hold BOOT, press RESET. A sensor is never offered the restart over USB.
- **It asks before it writes onto another board than the one chosen.** A board names itself by its hello, or by the application in its flash. The master's board is also told from a sensor's by its flash size.
- **Watchdogs off while it writes, and the watchdog to leave.** Both are register writes to the chip's LP watchdog at `0x600B1C00` (read in ESP-IDF 5.5.1, `soc/esp32c5/register/soc/lp_wdt_reg.h`). The reset clears the "start in the loader" latch, which an ordinary reset does not.
- **Every file is compared.** The page checks each file's SHA-256 against the catalog before it sends a byte, and after each write it compares the loader's MD5 of the flash with the file's.
- **An update leaves the settings alone. A first flash does not.** An update writes three files at their own places. A board that did not run this firmware before gets a blank settings partition as well: what lies there is another firmware's. The box on the master's card blanks it on an update too.
- **A sensor through the master** carries the master's own warning: that version of its flasher writes over the sensor's only firmware.

## What the first real board showed

Measured on 15 Nov 2026 on a new Waveshare ESP32-C5-Touch-LCD-2.8 (ESP32-C5 revision 1.2, 32 MB of flash) on a Mac's USB, with `tools/board_run.mjs`. The board's whole flash was read out with Espressif's esptool first.

| What | Result |
| --- | --- |
| The board as its maker ships it | It runs the maker's firmware, with its application at `0x20000` and other data where the master's settings go. It logs a line now and then and takes none of the page's commands |
| Restart into the loader over USB, by esptool-js | Worked: one reset sequence, about 8 s until the loader answered. The board stayed on USB |
| The stub, the chip's revision, MAC and flash size | Read as Espressif's esptool reads them: revision 1.2, 32 MB |
| Bootloader, partition table, blank settings, application | Written; each MD5 from the chip equal to the file's. 982 912 bytes of application in 4.4 s |
| Restart by the LP watchdog | The board left USB for about 270 ms and came back as a new port |
| **The firmware after that restart** | **It runs and takes commands, and nothing it sends arrives on USB.** Its own `reboot` does not mend that. A restart through RTS does, and the master then says hello: panel, touch, sound and Bluetooth all up |
| An update of the same board, by its own `reboot` `download` | Worked in 18 s from start to hello. The board stayed on USB when it entered the loader |

What the page does about the mute restart: on a master whose chip is revision 1.1 or later it follows the watchdog's restart with one through RTS, if no hello came. The firmware's owner knows of it.

## What has been checked, and what has not

Checked on 15 Nov 2026:

- `sh tests/run.sh` passes: 13 tests of the build step and 32 of the page's code (two of the 32 need `UAS_TREE`). The pretend boards behave as the real master did.
- On a real master board: the two runs of the table above, and on 16 Nov one flash from Chrome on the live page by the maintainer. It ended with DONE and the master's hello named 0.11.0 afterwards. The sheet's log of that run was not kept.
- In a browser, with pretend boards: a master flashed with the release's real files, a new master through the question about USB, a sensor through a pretend master, a sensor through its own socket, the question about a wrong board, and the layout at 375 px.
- `north.js` took the firmware repository's own master through a whole sensor flash against its simulated sensor and pretend ROM loader.

Not checked:

- **Any sensor.** No revision 1.0 chip has met the page's code.
- How a real sensor answers on its own USB port while it is linked to a master.

## Licences of what is served

- esptool-js 0.7.1: Apache License 2.0, `site/vendor/esptool-js/LICENSE.txt`. See `VENDOR.md` beside it.
- Space Grotesk and JetBrains Mono: SIL Open Font License 1.1, `site/vendor/fonts/README.txt`.
- The firmware images are built on ESP-IDF 5.5.1 (Apache License 2.0). The Remote ID sensor's firmware is under the Apache License 2.0.
- The page's own code and the master's firmware: no licence chosen yet.
