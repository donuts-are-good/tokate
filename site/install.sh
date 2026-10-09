#!/bin/sh
set -eu

fail() {
    printf 'tokate: %s\n' "$*" >&2
    exit 1
}

download() {
    curl -q --fail --silent --show-error --location --proto '=https' \
        --proto-redir '=https' --connect-timeout 15 --max-time 180 --retry 2 "$@"
}

setup_path() {
    cat > "$tokate_data/env" <<'ENV'
case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
ENV
    tokate_hook='[ ! -f "$HOME/.local/share/tokate/env" ] || . "$HOME/.local/share/tokate/env"'
    case "${tokate_shell##*/}" in
        bash)
            if [ ! -f "$tokate_data/path-bash" ]; then
                tokate_profile="$HOME/.profile"
                if [ -f "$HOME/.bash_profile" ]; then
                    tokate_profile="$HOME/.bash_profile"
                elif [ -f "$HOME/.bash_login" ]; then
                    tokate_profile="$HOME/.bash_login"
                fi
                printf '\n%s\n' "$tokate_hook" >> "$HOME/.bashrc"
                printf '\n%s\n' "$tokate_hook" >> "$tokate_profile"
                touch "$tokate_data/path-bash"
            fi
            ;;
        zsh)
            if [ ! -f "$tokate_data/path-zsh" ]; then
                mkdir -p "${ZDOTDIR:-$HOME}"
                printf '\n%s\n' "$tokate_hook" >> "${ZDOTDIR:-$HOME}/.zshrc"
                touch "$tokate_data/path-zsh"
            fi
            ;;
        fish)
            tokate_fish="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/tokate.fish"
            if [ -e "$tokate_fish" ] && [ ! -f "$tokate_data/path-fish" ]; then
                fail "Refusing to replace an existing $tokate_fish"
            fi
            mkdir -p "$(dirname "$tokate_fish")"
            printf '%s\n' 'contains -- "$HOME/.local/bin" $PATH; or set -gx PATH "$HOME/.local/bin" $PATH' > "$tokate_fish"
            printf '%s\n' "$tokate_fish" > "$tokate_data/path-fish"
            ;;
        *)
            if [ ! -f "$tokate_data/path-profile" ]; then
                printf '\n%s\n' "$tokate_hook" >> "$HOME/.profile"
                touch "$tokate_data/path-profile"
            fi
            ;;
    esac
}

main() {
    tokate_action=${1:-install}
    case "$tokate_action" in install|update|uninstall) ;; *) fail 'Use install, update, or uninstall.' ;; esac
    [ "$#" -le 2 ] || fail 'Too many arguments.'
    tokate_os=$(uname -s)
    [ "$tokate_os" = Linux ] || fail "Unsupported operating system: $tokate_os. Tokate requires Linux x86_64 with glibc 2.34+ or Alpine musl; Windows and macOS are not supported."
    [ -n "${HOME:-}" ] && [ "${HOME#/}" != "$HOME" ] || fail 'HOME must be an absolute path.'
    tokate_shell=$(printenv SHELL 2>/dev/null) || tokate_shell=
    tokate_bin="$HOME/.local/bin/tokate"
    tokate_data="$HOME/.local/share/tokate"
    if [ "$tokate_action" != install ]; then
        [ "${2:-}" = "$tokate_bin" ] || fail 'This command manages ~/.local/bin/tokate. Use the installer for this copy.'
        [ -f "$tokate_data/installed" ] || fail 'This copy was not installed by the Tokate installer.'
    fi
    [ ! -L "$tokate_bin" ] || fail "Refusing to replace a symlink at $tokate_bin"
    [ ! -e "$tokate_bin" ] || [ -f "$tokate_bin" ] || fail "Expected a regular file at $tokate_bin"
    if [ "$tokate_action" = uninstall ]; then
        rm -f "$tokate_bin" "$tokate_data/env" "$tokate_data/installed"
        if [ -f "$tokate_data/path-fish" ]; then
            IFS= read -r tokate_fish < "$tokate_data/path-fish"
            rm -f "$tokate_fish" "$tokate_data/path-fish"
        fi
        printf 'Tokate removed. Saved runs and shell setup markers were kept.\n'
        return
    fi
    if [ -r /etc/os-release ]; then
        while IFS= read -r tokate_release_line; do
            case "$tokate_release_line" in
                ID=nixos|ID=\"nixos\"|ID=\'nixos\')
                    fail 'On NixOS, use nix profile add github:obselate/tokate. Existing installation was kept.'
                    ;;
            esac
        done < /etc/os-release
    fi
    if [ -z "$tokate_shell" ] && command -v getent >/dev/null 2>&1; then
        if tokate_uid=$(id -u 2>/dev/null) && tokate_account=$(getent passwd "$tokate_uid" 2>/dev/null); then
            tokate_shell=${tokate_account##*:}
        fi
    fi
    tokate_arch=$(uname -m)
    [ "$tokate_arch" = x86_64 ] || fail "Unsupported architecture: $tokate_arch. Install on Linux x86_64; ARM64 is not supported."
    tokate_runtime=linux-x64
    if [ -f /lib/ld-musl-x86_64.so.1 ]; then
        tokate_runtime=linux-musl-x64
    else
        tokate_libc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'Cannot detect glibc or the Alpine x86_64 musl loader.'
        case "$tokate_libc" in
            'glibc '*) ;;
            *) fail "Unsupported libc: $tokate_libc. Tokate requires glibc 2.34+ or Alpine x86_64 musl." ;;
        esac
        tokate_libc=${tokate_libc#glibc }
        tokate_major=${tokate_libc%%.*}
        tokate_minor=${tokate_libc#*.}
        tokate_minor=${tokate_minor%%.*}
        case "$tokate_major" in ''|*[!0-9]*) fail "Cannot parse glibc version: $tokate_libc. Tokate requires glibc 2.34+." ;; esac
        case "$tokate_minor" in ''|*[!0-9]*) fail "Cannot parse glibc version: $tokate_libc. Tokate requires glibc 2.34+." ;; esac
        [ "$tokate_major" -gt 2 ] || { [ "$tokate_major" -eq 2 ] && [ "$tokate_minor" -ge 34 ]; } || fail "Unsupported glibc version: $tokate_libc. Use a system with glibc 2.34 or newer. Existing installation was kept."
    fi
    for tokate_tool in curl tar sha256sum mktemp install; do
        command -v "$tokate_tool" >/dev/null 2>&1 || fail "Install $tokate_tool first."
    done
    tokate_tmp=$(mktemp -d)
    tokate_stage=
    trap 'rm -rf "$tokate_tmp"; [ -z "$tokate_stage" ] || rm -f "$tokate_stage"' EXIT
    trap 'exit 1' HUP INT TERM
    tokate_release=$(download --output /dev/null --write-out '%{url_effective}' https://github.com/obselate/tokate/releases/latest)
    tokate_tag=${tokate_release##*/}
    printf '%s\n' "$tokate_tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail 'Could not resolve a stable Tokate release.'
    tokate_bundle="tokate-${tokate_tag#v}-$tokate_runtime"
    tokate_url="https://github.com/obselate/tokate/releases/download/$tokate_tag/$tokate_bundle.tar.gz"
    printf 'Downloading Tokate %s...\n' "${tokate_tag#v}"
    download --output "$tokate_tmp/archive.tar.gz" "$tokate_url"
    download --output "$tokate_tmp/checksum" "$tokate_url.sha256"
    read -r tokate_expected tokate_name < "$tokate_tmp/checksum"
    [ "$tokate_name" = "$tokate_bundle.tar.gz" ] || fail 'Unexpected checksum filename.'
    tokate_actual=$(sha256sum "$tokate_tmp/archive.tar.gz")
    [ "${tokate_actual%% *}" = "$tokate_expected" ] || fail 'Release checksum mismatch. Existing installation was kept.'
    tar -xOzf "$tokate_tmp/archive.tar.gz" "$tokate_bundle/tokate" > "$tokate_tmp/tokate"
    chmod 755 "$tokate_tmp/tokate"
    [ "$("$tokate_tmp/tokate" --version)" = "tokate ${tokate_tag#v}" ] || fail 'Downloaded binary did not pass its version check.'
    mkdir -p "$HOME/.local/bin" "$tokate_data"
    tokate_stage=$(mktemp "$HOME/.local/bin/.tokate.XXXXXX")
    install -m 755 "$tokate_tmp/tokate" "$tokate_stage"
    setup_path
    mv -f "$tokate_stage" "$tokate_bin"
    tokate_stage=
    printf '%s\n' "$tokate_tag" > "$tokate_data/installed"
    printf 'Installed Tokate %s.\nUpdate: tokate update\nRemove: tokate uninstall\n' "${tokate_tag#v}"
    case ":$PATH:" in
        *":$HOME/.local/bin:"*) printf 'Run tokate --help to get started.\n' ;;
        *)
            case "${tokate_shell##*/}" in
                bash|zsh|fish) printf 'Open a new terminal, then run tokate --help.\n' ;;
                *) printf 'Add ~/.local/bin to PATH in your shell startup file.\nBash/Zsh: . "$HOME/.local/share/tokate/env"\nFish: fish_add_path "$HOME/.local/bin"\n' ;;
            esac
            printf 'For this terminal: %s --help\n' "$tokate_bin"
            ;;
    esac
}

main "$@"
