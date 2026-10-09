#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
binary=$(realpath "${TOKATE_BINARY:-artifacts/linux-x64/tokate}")
proof=$(mktemp -d "${RUNNER_TEMP:-$HOME}/tokate-layouts.XXXXXXXX")
trap 'rm -rf "$proof"' EXIT
runtime_path=$PATH
run() {
    local home_dir=$1
    shift
    mkdir -p "$home_dir"
    (cd "$home_dir"; env -i HOME="$home_dir" PATH="$runtime_path" LANG=C.UTF-8 "$@")
}
probe() {
    local home_dir=$1 harness=$2
    shift 2
    mkdir -p "$home_dir/.local/state/tokate/runs/layout-proof"
    printf 'saved-work' > "$home_dir/.local/state/tokate/runs/layout-proof/keep"
    run "$home_dir" "$@" "$binary" doctor --managed --harness "$harness" --fix --yes --json > "$home_dir/$harness-doctor.json"
    test "$(cat "$home_dir/.local/state/tokate/runs/layout-proof/keep")" = saved-work
    python3 - "$home_dir/$harness-doctor.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as source:
    report = json.load(source)
assert report['status'] == 'ok' and report['data']['inference'] is False, report
PY
}
curl -qfsSL --proto '=https' --proto-redir '=https' https://pi.dev/install.sh -o "$proof/pi-install.sh"
sha256sum "$proof/pi-install.sh"
mkdir -p "$proof/native-codex"
run "$proof/native-codex" CODEX_INSTALL_DIR="$proof/native-codex/bin" CODEX_HOME="$proof/native-codex/state" "$binary" doctor --managed --fix --yes --json > "$proof/native-codex/setup.json"
probe "$proof/native-codex" codex CODEX_INSTALL_DIR="$proof/native-codex/bin" CODEX_HOME="$proof/native-codex/state"
run "$proof/native-codex" "$proof/native-codex/bin/codex" --version
mkdir -p "$proof/native-pi/bin"
run "$proof/native-pi" PATH="$proof/native-pi/bin:$runtime_path" PI_CODING_AGENT_DIR="$proof/native-pi/agent" sh "$proof/pi-install.sh"
probe "$proof/native-pi" pi PATH="$proof/native-pi/bin:$runtime_path" PI_CODING_AGENT_DIR="$proof/native-pi/agent"
run "$proof/native-pi" "$proof/native-pi/bin/pi" --version
codex_version=$(run "$proof/npm" npm view @openai/codex version)
pi_version=$(run "$proof/npm" npm view @earendil-works/pi-coding-agent version)
run "$proof/npm" NPM_CONFIG_PREFIX="$proof/npm/prefix" npm install --global "@openai/codex@$codex_version" "@earendil-works/pi-coding-agent@$pi_version"
probe "$proof/npm" codex NPM_CONFIG_PREFIX="$proof/npm/prefix"
probe "$proof/npm" pi NPM_CONFIG_PREFIX="$proof/npm/prefix"
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
probe "$proof/bun-home" codex BUN_INSTALL_BIN="$proof/bun-home/bin"
probe "$proof/bun-home" pi BUN_INSTALL_BIN="$proof/bun-home/bin"
printf 'PASS native, npm and Bun Codex/Pi installation discovery and sandbox probes without inference. npm/Bun versions: Codex %s, Pi %s\n' "$codex_version" "$pi_version"
