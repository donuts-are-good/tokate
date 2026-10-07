#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(dotnet msbuild Tokate.gsproj -getProperty:Version -nologo)
test "$(artifacts/linux-x64/tokate --version)" = "tokate $version"
bundle="tokate-$version-linux-x64"
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/$bundle/docs" "$staging/$bundle/licenses"
install -m 755 artifacts/linux-x64/tokate "$staging/$bundle/tokate"
cp README.md AGENTS.md LICENSE "$staging/$bundle/"
cp docs/reference.md docs/transparency.md "$staging/$bundle/docs/"
cp docs/coordination-v2.md docs/pi.md "$staging/$bundle/docs/"
cp docs/claude-proof.md "$staging/$bundle/docs/"
cp licenses/dotnet-LICENSE.TXT licenses/dotnet-THIRD-PARTY-NOTICES.TXT \
    licenses/GSharp.txt licenses/Spectre.Console.txt "$staging/$bundle/licenses/"
tar --owner=0 --group=0 --numeric-owner -czf "artifacts/$bundle.tar.gz" \
    -C "$staging" "$bundle"
(cd artifacts && sha256sum "$bundle.tar.gz" > "$bundle.tar.gz.sha256")
