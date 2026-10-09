#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
binary=$(realpath "${TOKATE_BINARY:-artifacts/linux-x64/tokate}")
proof=$(mktemp -d "${RUNNER_TEMP:-$HOME}/tokate-layouts.XXXXXXXX")
trap 'rm -rf "$proof"' EXIT
runtime_path=$PATH
host_harnesses=()
IFS=: read -ra path_dirs <<< "$runtime_path"
for directory in "${path_dirs[@]}"; do
    for harness in codex pi; do
        if [[ "$directory" = /* && -x "$directory/$harness" ]]; then
            host_harnesses+=(--ro-bind /dev/null "$(realpath "$directory/$harness")")
        fi
    done
done
run() {
    local home_dir=$1
    shift
    mkdir -p "$home_dir"
    (cd "$home_dir"; bwrap --die-with-parent --new-session --ro-bind / / --tmpfs /tmp --tmpfs /var/tmp \
        --bind "$proof" "$proof" --ro-bind "$binary" "$binary" --proc /proc --dev /dev "${host_harnesses[@]}" -- \
        env -i HOME="$home_dir" PATH="$runtime_path" LANG=C.UTF-8 "$@")
}
probe() {
    local home_dir=$1 harness=$2 bin_dir=$3
    shift 3
    mkdir -p "$home_dir/.local/state/tokate/runs/layout-proof"
    printf 'saved-work' > "$home_dir/.local/state/tokate/runs/layout-proof/keep"
    run "$home_dir" PATH="$bin_dir:$runtime_path" "$@" "$binary" doctor --managed --harness "$harness" --json > "$home_dir/$harness-doctor.json"
    test "$(cat "$home_dir/.local/state/tokate/runs/layout-proof/keep")" = saved-work
    python3 - "$home_dir/$harness-doctor.json" "$home_dir" "$harness" <<'PY'
import json
from pathlib import Path
import sys

with open(sys.argv[1]) as source:
    report = json.load(source)
assert report['status'] == 'ok' and report['data']['inference'] is False, report
runtime = next(tool for tool in report['data']['tools'] if tool['name'] == sys.argv[3])
assert Path(runtime['path']).resolve(strict=True).is_relative_to(Path(sys.argv[2]).resolve()), runtime
PY
}
curl -qfsSL --proto '=https' --proto-redir '=https' https://pi.dev/install.sh -o "$proof/pi-install.sh"
sha256sum "$proof/pi-install.sh"
mkdir -p "$proof/native-codex"
curl -qfsSL --proto '=https' --proto-redir '=https' https://chatgpt.com/codex/install.sh -o "$proof/codex-install.sh"
run "$proof/native-codex" CODEX_INSTALL_DIR="$proof/native-codex/bin" CODEX_HOME="$proof/native-codex/state" CODEX_NON_INTERACTIVE=1 sh "$proof/codex-install.sh"
probe "$proof/native-codex" codex "$proof/native-codex/bin" CODEX_INSTALL_DIR="$proof/native-codex/bin" CODEX_HOME="$proof/native-codex/state"
codex_version=$(run "$proof/native-codex" "$proof/native-codex/bin/codex" --version)
codex_version=${codex_version##* }
mkdir -p "$proof/native-pi/bin"
run "$proof/native-pi" PATH="$proof/native-pi/bin:$runtime_path" PI_CODING_AGENT_DIR="$proof/native-pi/agent" sh "$proof/pi-install.sh"
probe "$proof/native-pi" pi "$proof/native-pi/bin" PI_CODING_AGENT_DIR="$proof/native-pi/agent"
pi_version=$(run "$proof/native-pi" "$proof/native-pi/bin/pi" --version)
run "$proof/npm" NPM_CONFIG_PREFIX="$proof/npm/prefix" npm install --global "@openai/codex@$codex_version" "@earendil-works/pi-coding-agent@$pi_version"
probe "$proof/npm" codex "$proof/npm/prefix/bin" NPM_CONFIG_PREFIX="$proof/npm/prefix"
probe "$proof/npm" pi "$proof/npm/prefix/bin" NPM_CONFIG_PREFIX="$proof/npm/prefix"
curl -qfsSL --proto '=https' https://api.github.com/repos/oven-sh/bun/releases/latest -o "$proof/bun.json"
python3 - "$proof/bun.json" "$proof" <<'PY'
import hashlib
import json
import pathlib
import sys
import urllib.request
import zipfile

with open(sys.argv[1]) as source:
    release = json.load(source)
asset = next(item for item in release['assets'] if item['name'] == 'bun-linux-x64.zip')
assert not release['draft'] and not release['prerelease']
url = asset['browser_download_url']
assert url.startswith('https://github.com/oven-sh/bun/releases/download/')
with urllib.request.urlopen(url, timeout=120) as response:
    data = response.read()
assert 'sha256:' + hashlib.sha256(data).hexdigest() == asset['digest']
root = pathlib.Path(sys.argv[2])
archive = root / 'bun.zip'
archive.write_bytes(data)
with zipfile.ZipFile(archive) as package:
    binary = root / 'bun'
    binary.write_bytes(package.read('bun-linux-x64/bun'))
    binary.chmod(0o755)
print(release['tag_name'], asset['digest'])
PY
run "$proof/bun-home" BUN_INSTALL_GLOBAL_DIR="$proof/bun-home/packages" BUN_INSTALL_BIN="$proof/bun-home/bin" "$proof/bun" install --global "@openai/codex@$codex_version" "@earendil-works/pi-coding-agent@$pi_version"
probe "$proof/bun-home" codex "$proof/bun-home/bin" BUN_INSTALL_BIN="$proof/bun-home/bin"
probe "$proof/bun-home" pi "$proof/bun-home/bin" BUN_INSTALL_BIN="$proof/bun-home/bin"
printf 'PASS native, npm and Bun Codex/Pi installation discovery and sandbox probes without inference. npm/Bun versions: Codex %s, Pi %s\n' "$codex_version" "$pi_version"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'codex=%s\npi=%s\n' "$codex_version" "$pi_version" >> "$GITHUB_OUTPUT"
fi
