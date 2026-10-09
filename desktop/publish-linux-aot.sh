#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -gt 1 ]]; then
    printf 'Usage: %s [output-directory]\n' "$0" >&2
    exit 2
fi
if [[ "${1:-}" == --help ]]; then
    printf 'Usage: %s [output-directory]\nBuilds committed HEAD on the pinned glibc 2.34 baseline.\n' "$0"
    exit 0
fi
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
revision=$(git -C "$root" rev-parse HEAD)
destination=${1:-"$root/artifacts/desktop-linux-aot-${revision:0:12}"}
context=$(mktemp -d)
container=
trap 'test -z "$container" || docker rm -f "$container" >/dev/null; rm -rf "$context"' EXIT
if [[ -e "$destination" ]]; then
    printf 'Output already exists: %s\n' "$destination" >&2
    exit 1
fi
git -C "$root" archive --format=tar HEAD -o "$context/source.tar"
cp "$root/desktop/linux-aot.Dockerfile" "$context/Dockerfile"
image="tokate-desktop-aot:${revision:0:12}"
docker build --tag "$image" "$context"
container=$(docker create --entrypoint /out/tokate-desktop "$image")
mkdir -p "$destination"
docker cp "$container:/out/." "$destination/"
printf '%s\n' "$revision" > "$destination/source-revision.txt"
printf '%s\n' "$destination"
