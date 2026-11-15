#!/bin/sh
# Copy site/ to a directory outside ~/Documents and print it.
# macOS asks before a program reads ~/Documents, and a preview server started
# by a tool that cannot answer the question hangs. Serving a copy avoids it.
#   sh scripts/preview_copy.sh /tmp/uas-site && (cd /tmp/uas-site && python3 -m http.server 8791 --bind 127.0.0.1)
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
to=${1:?where to put the copy}
mkdir -p "$to"
rsync -a --delete "$here/site/" "$to/"
echo "$to"
