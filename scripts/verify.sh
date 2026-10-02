#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
dotnet restore Tokate.gsproj --locked-mode --nologo
tokate_sdk_cache="${NUGET_PACKAGES:-$HOME/.nuget/packages}"
dotnet "$tokate_sdk_cache/gsharp.net.sdk/0.4.591/tools/formatter/gsfmt.dll" --check src tests
dotnet build Tokate.gsproj -c Release --no-restore --nologo -warnaserror
dotnet publish Tokate.gsproj -c Release --no-restore -o artifacts/linux-x64 --nologo -warnaserror
python3 -W error::ResourceWarning -m unittest discover -s tests -p native_e2e.py -v
sh -n site/install.sh
dotnet restore tests/Tokate.Tests.gsproj --locked-mode --nologo
dotnet publish tests/Tokate.Tests.gsproj -c Release --no-restore -o artifacts/tests --nologo -warnaserror
artifacts/tests/tokate-tests
artifacts/linux-x64/tokate --version
git diff --check
