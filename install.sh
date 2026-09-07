#!/bin/bash
# Release packaging replaces this template's digest. Keep all execution in the
# function: an interrupted curl pipe must not execute a partially read installer.
deckard_bootstrap() (
  set -eu
  export LC_ALL=C
  fail() { printf 'Deckard: %s\n' "$*" >&2; exit 1; }
  usage() {
    printf '%s\n' \
      'Usage: install.sh [--yes] [--no-open] [--shell zsh|bash|none] [--home DIR] [--manifest-dir DIR] [--extension-id ID]' \
      'Chrome is never opened automatically; --no-open explicitly selects this default.' \
      'After installation, follow the native CLI instructions to load the extension manually in Chrome.'
  }
  yes=false
  shell_choice=
  native_options=(install)
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --yes) yes=true; shift ;;
      --no-open) shift ;;
      --shell|--home|--manifest-dir|--extension-id)
        [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value."
        case "$2" in --*) fail "$1 requires a value." ;; esac
        if [ "$1" = --shell ]; then shell_choice=$2
        else native_options+=("$1" "$2"); fi
        shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) usage >&2; fail "Unknown option: $1" ;;
    esac
  done
  if [ -z "$shell_choice" ]; then
    shell_choice=${SHELL-}
    shell_choice=${shell_choice##*/}
    case "$shell_choice" in
      zsh|bash) ;;
      *) fail 'Specify --shell zsh, --shell bash, or --shell none (or set SHELL to zsh/bash).' ;;
    esac
  fi
  case "$shell_choice" in
    zsh|bash|none) ;;
    *) fail 'Specify --shell zsh, --shell bash, or --shell none (or set SHELL to zsh/bash).' ;;
  esac
  [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] ||
    fail 'macOS 15 or newer on Apple Silicon (arm64) is required.'
  version=$(sw_vers -productVersion) || fail 'Cannot determine macOS version.'
  major=${version%%.*}
  case "$major" in ''|*[!0-9]*) fail "Invalid macOS version: $version" ;; esac
  [ "$major" -ge 15 ] || fail 'macOS 15 or newer is required.'
  if [ "$yes" = false ]; then
    if ! { exec 3<>/dev/tty; } 2>/dev/null; then
      fail 'No controlling terminal. Re-run with --yes and a supported --shell (or SHELL).'
    fi
    printf 'Install Deckard v0.4.1 (including model weights) and configure shell %s? [y/N] ' "$shell_choice" >&3
    answer=
    IFS= read -r answer <&3 || fail 'Confirmation could not be read.'
    exec 3>&-
    case "$answer" in y|Y|yes|YES) ;; *) fail 'Installation cancelled.' ;; esac
  fi
  expected='@ARCHIVE_SHA256@'
  case "$expected" in ''|*[!0-9a-f]*) fail 'This source template is not a release installer: missing pinned archive SHA-256.' ;; esac
  [ "${#expected}" -eq 64 ] || fail 'Invalid pinned archive SHA-256.'
  for tool in curl shasum tar awk sort uniq; do
    command -v "$tool" >/dev/null || fail "Required command not found: $tool"
  done
  work="$PWD/.deckard-bootstrap.$$.$RANDOM"
  (umask 077; mkdir "$work") || fail 'Cannot create private staging directory in the current directory.'
  trap 'rm -rf -- "$work"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  archive="$work/deckard-v0.4.1-macos-arm64.tar.gz"
  url='https://github.com/sgoedecke/deckard/releases/download/v0.4.1/deckard-v0.4.1-macos-arm64.tar.gz'
  printf 'Downloading Deckard v0.4.1…\n'
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 30 --max-time 1800 --output "$archive" "$url" ||
    fail 'Download failed. The pinned v0.4.1 release must be published before this installer can be used.'
  actual=$(shasum -a 256 "$archive")
  actual=${actual%% *}
  [ "$actual" = "$expected" ] || fail 'Archive SHA-256 checksum mismatch; nothing was installed.'
  tar -tzf "$archive" > "$work/entries" || fail 'Cannot inspect release archive.'
  tar -tvzf "$archive" > "$work/details" || fail 'Cannot inspect release archive types.'
  # Reject all links and special files, not just obvious "../" paths. Restrict
  # names to the release format so escaped newlines cannot disguise entries.
  awk '
    !/^[A-Za-z0-9_.\/-]+$/ { exit 1 }
    /^\// || /(^|\/)\.\.?($|\/)/ || /\/\// { exit 1 }
    !/^(bin|lib|share|extension|models)(\/|$)/ { exit 1 }
    END { if (NR == 0) exit 1 }
  ' "$work/entries" || fail 'Unsafe archive path.'
  awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" { exit 1 }
       END { if (NR == 0) exit 1 }' "$work/details" || fail 'Archive links or special files are not permitted.'
  [ -z "$(sort "$work/entries" | uniq -d)" ] || fail 'Duplicate archive paths are not permitted.'
  mkdir "$work/bundle"
  tar -xzf "$archive" -C "$work/bundle" --no-same-owner --no-same-permissions \
    --no-xattrs --no-acls --no-fflags || fail 'Archive extraction failed.'
  bundle="$work/bundle"
  [ -x "$bundle/bin/deckard" ] && [ -d "$bundle/lib" ] &&
    [ -d "$bundle/share/licenses" ] && [ -f "$bundle/extension/manifest.json" ] &&
    [ -f "$bundle/models/packed.safetensors" ] && [ -f "$bundle/models/tokenizer.json" ] ||
    fail 'Release archive is missing required files.'
  "$bundle/bin/deckard" "${native_options[@]}" --model-dir "$bundle/models" \
    --extension-dir "$bundle/extension" --shell "$shell_choice"
)
deckard_bootstrap "$@"
