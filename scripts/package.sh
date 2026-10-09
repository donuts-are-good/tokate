#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
runtime="${TOKATE_RUNTIME_IDENTIFIER:-linux-x64}"
case "$runtime" in linux-x64|linux-musl-x64) ;; *) exit 1 ;; esac
version=$(dotnet msbuild Tokate.gsproj -getProperty:Version -nologo)
test "$("artifacts/$runtime/tokate" --version)" = "tokate $version"
bundle="tokate-$version-$runtime"
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/$bundle/docs" "$staging/$bundle/licenses"
install -m 755 "artifacts/$runtime/tokate" "$staging/$bundle/tokate"
cp README.md AGENTS.md LICENSE "$staging/$bundle/"
install -Dm755 plugins/install.sh "$staging/$bundle/plugins/install.sh"
install -Dm644 plugins/tokate/SKILL.md "$staging/$bundle/plugins/tokate/SKILL.md"
cp docs/owners.md docs/donors.md docs/recovery.md docs/security.md docs/development.md \
    docs/nix.md docs/alpine.md docs/linux-security.md docs/linux-harnesses.md "$staging/$bundle/docs/"
cp licenses/dotnet-LICENSE.TXT licenses/dotnet-THIRD-PARTY-NOTICES.TXT \
    licenses/GSharp.txt licenses/Spectre.Console.txt "$staging/$bundle/licenses/"
tar --owner=0 --group=0 --numeric-owner -czf "artifacts/$bundle.tar.gz" \
    -C "$staging" "$bundle"
(cd artifacts && sha256sum "$bundle.tar.gz" > "$bundle.tar.gz.sha256")
