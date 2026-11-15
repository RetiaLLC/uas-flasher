#!/usr/bin/env python3
"""Start the firmware repository's own master_host between its simulated sensors, and
serve the master's USB stream on a TCP port, for tests/master_host.test.mjs.

    rig_bridge.py TREE

TREE is a checkout or an export of the firmware's repository at a commit
that has the sensor flasher (branch tools/sensor-flash, pull requests 95 and
96). Everything here is that repository's test rig (tests/test_master.py,
tests/test_flash.py), used as it is; nothing is copied from it.

Prints one JSON line with the port, then answers lines on stdin:
    state   what each simulated sensor runs, and the MD5 of its application
    quit
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile


def main():
    tree = os.path.abspath(sys.argv[1])
    for sub in ("tools", "tests"):
        sys.path.insert(0, os.path.join(tree, sub))
    import test_flash   # noqa: E402  (the firmware repository's)
    import test_master  # noqa: E402

    tmp = tempfile.mkdtemp(prefix="uas_flasher_rig_")
    try:
        exe = test_master.build_master_host(tmp)
        rig = test_master.Rig(exe, sensor_kw=test_flash.sensors())
        bridge = None
        try:
            rig.wait_up()
            bridge = test_flash.Bridge(rig)
            print(json.dumps({"port": bridge.port, "scale": test_master.SCALE}), flush=True)
            for line in sys.stdin:
                word = line.strip()
                if word == "quit":
                    break
                if word.startswith("state"):
                    size = int(word.split()[1]) if len(word.split()) > 1 else 0
                    out = []
                    for sim in rig.sensors:
                        # A simulated sensor has a flash only once it has been in its loader.
                        held = bytes(sim.flash[0x10000:0x10000 + size]) if sim.flash is not None else b""
                        out.append({"role": sim.role, "mode": sim.mode, "fw_ver": sim.fw_ver, "md5": hashlib.md5(held).hexdigest()})
                    print(json.dumps({"sensors": out}), flush=True)
        finally:
            if bridge:
                bridge.close()
            err = rig.close()
            print(json.dumps({"stderr": err[-400:]}), flush=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
