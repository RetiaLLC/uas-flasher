# Vendored: esptool-js 0.7.1

`bundle.js` is the self-contained bundle of the npm package `esptool-js` 0.7.1 (Espressif, Apache-2.0, see `LICENSE`), copied unchanged on 15 Nov 2026.

- Package: `esptool-js-0.7.1.tgz`, npm shasum `493dccb5f33f35336e9217c38ed838611471e5a4`
- SHA-256 of `bundle.js`: `d6a4b0b7c9b747a7370cfa976164a962f56332d5faa7c3b45cdb95a2a8b1d456`

Why this version and no older one: 0.7.0 added the chip-magic value of the ESP32-C5 revision 1.2 and fixed the C5's SPI register base. The master's chip is a revision 1.2.

What the page does around it (in `js/direct.js` and `js/port.js`), because the library does not:

- It never lets the library change DTR or RTS. A revision 1.0 ESP32-C5 that is reset through those lines hangs in its ROM, and the library falls back to that reset when a change of baud rate fails. The page keeps the rate where it is and holds every change of the two lines back.
- It switches the chip's watchdogs off after it has met the loader, as Espressif's own tool does on a USB-Serial/JTAG port.
- It restarts the chip with its LP watchdog. The library's `watchdogReset` for this chip says "not yet implemented".

To update: `npm pack esptool-js@<version>`, replace `bundle.js` and `LICENSE`, change the figures above, run `sh tests/run.sh`.
