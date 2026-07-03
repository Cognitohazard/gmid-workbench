#!/bin/sh
# Build the local release staging under release/ (gitignored):
#   - a fresh offline single-file app (web/dist/index.html), and
#   - the open-PDK dataset tarball: data/pdk tables + PROVENANCE.md + Apache-2.0.txt
#     + the offline app, under a gmid-open-pdk-data/ archive root, with a sha256.
# Run from anywhere; requires the dataset present under data/pdk/
# (regenerate with tools/gen_gmid.py — see data/pdk/PROVENANCE.md).
set -eu
cd "$(dirname "$0")/.."

DATE=$(date +%Y-%m-%d)
STAGE="release/gmid-open-pdk-data"
TARBALL="release/gmid-open-pdk-data-$DATE.tar.gz"

# 1. Fresh offline app (single self-contained HTML, everything inlined).
(cd web && npm run build)

# 2. Stage the archive layout.
mkdir -p release
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp data/pdk/PROVENANCE.md data/pdk/Apache-2.0.txt "$STAGE/"
cp -r data/pdk/sky130 data/pdk/gf180mcu "$STAGE/"
cp web/dist/index.html "$STAGE/index.html"

# 3. Pack (archive root: gmid-open-pdk-data/) and checksum, then drop the staging copy.
tar -C release -czf "$TARBALL" gmid-open-pdk-data
(cd release && sha256sum "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256")
rm -rf "$STAGE"

echo "Wrote $TARBALL ($(tar -tzf "$TARBALL" | wc -l) entries)"
