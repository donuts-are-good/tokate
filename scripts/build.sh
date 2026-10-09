#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
runtime="${TOKATE_RUNTIME_IDENTIFIER:-linux-x64}"
case "$runtime" in linux-x64|linux-musl-x64) ;; *) exit 1 ;; esac
tests=artifacts/tests
if [[ "$runtime" == linux-musl-x64 ]]; then
    tests=artifacts/tests-musl
fi
dotnet restore Tokate.gsproj --locked-mode --nologo
formatter=$(dotnet msbuild Tokate.gsproj -getProperty:GsharpFormatterFullPath -nologo)
dotnet "$formatter" --check src tests
dotnet publish Tokate.gsproj -c Release -r "$runtime" --no-restore -o "artifacts/$runtime" --nologo -warnaserror
sh -n site/install.sh
dotnet restore tests/Tokate.Tests.gsproj --locked-mode --nologo
dotnet publish tests/Tokate.Tests.gsproj -c Release -r "$runtime" --no-restore -o "$tests" --nologo -warnaserror
