#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c 'import xml.etree.ElementTree as E; print(E.parse("Tokate.gsproj").findtext(".//Version"))')
test "$(artifacts/linux-x64/tokate --version)" = "tokate $version"
bundle="tokate-$version-linux-x64"
mkdir -p "artifacts/$bundle"
install -m 755 artifacts/linux-x64/tokate "artifacts/$bundle/tokate"
cp README.md LICENSE "artifacts/$bundle/"
cp -R docs licenses "artifacts/$bundle/"
tar -czf "artifacts/$bundle.tar.gz" -C artifacts "$bundle"
(cd artifacts && sha256sum "$bundle.tar.gz" > "$bundle.tar.gz.sha256")
