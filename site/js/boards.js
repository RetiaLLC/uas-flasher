// The three boards of a unit, and what the page knows about each.
//
// Read from the firmware's repository on 15 Nov 2026: the project names from the three
// CMakeLists.txt, the `fw` names from each firmware's hello record, the loader
// commands from the sensors' READMEs and the benches' flash scripts.

export const ESPRESSIF_VID = 0x303a;
export const USB_JTAG_SERIAL_PID = 0x1001;
export const CHIP_NAME = "ESP32-C5";

export const BOARDS = {
  master: {
    role: "master",
    name: "Master",            // as a title
    noun: "master",            // in a sentence
    label: "MASTER",
    hardware: "Waveshare ESP32-C5-Touch-LCD-2.8",
    project: "uas_detector_master",
    fw: "uas-detector-master",
    socket: "the master's USB-C socket",
    // The Waveshare board carries 32 MB of flash, a XIAO 8 MB. A second way to tell them apart.
    flashBytes: 32 * 1024 * 1024,
  },
  rid: {
    role: "rid",
    name: "Remote ID sensor",
    noun: "Remote ID sensor",
    label: "REMOTE ID SENSOR",
    hardware: "Seeed XIAO ESP32-C5 on a Wio-SX1262",
    project: "c5_drone_detector",
    fw: "c5_drone_detector",
    socket: "the Remote ID sensor's own USB-C socket",
    flashBytes: 8 * 1024 * 1024,
  },
  rf: {
    role: "rf",
    name: "RF sensor",
    noun: "RF sensor",
    label: "RF SENSOR",
    hardware: "Seeed XIAO ESP32-C5",
    project: "widscan58",
    fw: "fpv-detector",
    socket: "the RF sensor's own USB-C socket",
    flashBytes: 8 * 1024 * 1024,
  },
};

export const ROLES = ["master", "rid", "rf"];

export function roleOfProject(project) {
  return ROLES.find((r) => BOARDS[r].project === project) ?? null;
}

/**
 * The lines that ask a running firmware to restart into the chip's ROM loader.
 * `first` is each firmware's own plain command. `second` is the sensor link's
 * framed form (a heartbeat, then `boot`), which the benches' scripts send as
 * well, for a sensor that has taken the link on its USB port.
 */
export function loaderLines(role, id, framed) {
  if (role === "master") {
    return { first: [`{"cmd":"reboot","id":${id},"mode":"download"}`], second: [] };
  }
  const boot = `{"cmd":"boot","id":${id},"mode":"download"}`;
  const linked = [framed('{"cmd":"hb","ms":1}'), framed(`{"cmd":"boot","id":${id + 1},"mode":"download"}`)];
  if (role === "rf") return { first: ["BOOTLOADER"], second: [boot, ...linked] };
  return { first: [boot], second: linked };
}

/** Compares two version strings loosely: equal, or one is a git name that contains the other. */
export function sameVersion(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const strip = (v) => v.replace(/^v/, "").replace(/-dirty$/, "");
  return strip(a) === strip(b);
}

/**
 * How a board's version stands to a release's: "same", "older", "newer", or
 * "other" where the two cannot be put in order (a git name, for one).
 */
export function compareVersions(onBoard, inRelease) {
  if (sameVersion(onBoard, inRelease)) return "same";
  const parse = (v) => (/^v?\d+(\.\d+)*$/.test(v ?? "") ? v.replace(/^v/, "").split(".").map(Number) : null);
  const a = parse(onBoard);
  const b = parse(inRelease);
  if (!a || !b) return "other";
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? "older" : "newer";
  }
  return "same";
}
