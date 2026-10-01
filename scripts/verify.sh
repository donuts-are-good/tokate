#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
gslint --strict src
dotnet build Tokate.gsproj -c Release --nologo
tokate_sdk_cache="${NUGET_PACKAGES:-$HOME/.nuget/packages}"
dotnet "$tokate_sdk_cache/gsharp.net.sdk/0.4.591/tools/formatter/gsfmt.dll" --check src
dotnet publish Tokate.gsproj -c Release -r linux-x64 -o artifacts/linux-x64 --nologo
python3 -W error::ResourceWarning -m unittest discover -s tests -p native_e2e.py -v
artifacts/linux-x64/tokate --version
git diff --check
