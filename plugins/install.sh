#!/bin/sh
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo 'Usage: sh plugins/install.sh codex|claude|pi|omp|hermes [SKILLS_DIRECTORY]' >&2
    exit 1
fi
case "$1" in
    codex) root="$HOME/.agents/skills" ;;
    claude) root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills" ;;
    pi) root="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills" ;;
    omp)
        root=${2:-}
        if [ -z "$root" ]; then
            root=$(omp config path)
            case "$root" in
                /*) root="$root/skills" ;;
                *) echo 'OMP did not return an absolute agent directory.' >&2; exit 1 ;;
            esac
        fi
        ;;
    hermes) root="${HERMES_HOME:-$HOME/.hermes}/skills" ;;
    *) echo 'Unknown harness.' >&2; exit 1 ;;
esac
root=${2:-$root}
case "$root" in /*) ;; *) echo 'Use an absolute skills directory.' >&2; exit 1 ;; esac
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source="$source_dir/tokate/SKILL.md"
destination="$root/tokate"
if [ -L "$destination" ] || [ -L "$destination/SKILL.md" ] || [ -L "$destination/.tokate-sha256" ]; then
    echo 'Existing skill links are preserved. Choose another skills directory.' >&2
    exit 1
fi
if [ -e "$destination" ]; then
    if [ ! -d "$destination" ]; then
        echo 'Existing skill path is preserved.' >&2
        exit 1
    fi
    if ! cmp -s "$source" "$destination/SKILL.md"; then
        if [ ! -f "$destination/.tokate-sha256" ] || [ ! -f "$destination/SKILL.md" ] ||
            [ "$(sha256sum "$destination/SKILL.md" | cut -d ' ' -f 1)" != "$(cat "$destination/.tokate-sha256")" ]; then
            echo 'Existing or edited skill is preserved. Choose another skills directory.' >&2
            exit 1
        fi
    fi
fi
mkdir -p -- "$destination"
cp -- "$source" "$destination/SKILL.md"
sha256sum "$destination/SKILL.md" | cut -d ' ' -f 1 > "$destination/.tokate-sha256"
printf 'Installed Tokate skill: %s\n' "$destination/SKILL.md"
