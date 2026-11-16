#!/bin/sh
# Every test of the flashing page. Needs Node 20 or later and Python 3.
#   sh tests/run.sh
# With UAS_TREE set to a checkout or an export of the firmware's repository at a commit
# that has the sensor flasher, the page's client is also run against the
# firmware repository's own master_host (see tests/master_host.test.mjs).
set -e
cd "$(dirname "$0")/.."
python3 -m unittest -q tests/test_build_catalog.py tests/test_guide_pages.py tests/test_build_guide.py
# esptool-js prints a TRACE line when a board leaves USB, as it does after every
# flash. They are left out of what is shown; the tests' own result decides.
# The limit is for a whole file: the direct-flash tests wait as a person's board would, about two minutes in all.
out=$(mktemp)
status=0
node --test --test-timeout=420000 tests/*.test.mjs >"$out" 2>&1 || status=$?
grep -v '^TRACE' "$out" || true
rm -f "$out"
exit $status
