#!/bin/bash
set -euo pipefail
ctg_directory="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ctg_runtime="${HOME}/.context-traffic-guard/runtime"
ctg_node=""
ctg_system="$(uname -s)"
case "$ctg_system" in Darwin) ctg_platform=darwin;; Linux) ctg_platform=linux;; *) echo 'Use the Windows .cmd launcher on Windows.' >&2; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) ctg_arch=x64;; arm64|aarch64) ctg_arch=arm64;; *) echo 'This architecture needs a separately installed Node.js 24 runtime.' >&2; exit 1;; esac
ctg_valid_node() { [ -n "$1" ] && [ -x "$1" ] && [ "$("$1" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -ge 24 ]; }
for ctg_candidate in "${CTG_NODE:-}" "$(command -v node || true)" "$ctg_runtime"/node-v24.*-"$ctg_platform"-"$ctg_arch"*/bin/node; do
  if ctg_valid_node "$ctg_candidate"; then ctg_node="$ctg_candidate"; break; fi
done
if [ -z "$ctg_node" ]; then
  command -v curl >/dev/null || { echo 'curl is needed to fetch the official Node.js runtime.' >&2; exit 1; }
  mkdir -p "$ctg_runtime"
  ctg_runtime="$(cd "$ctg_runtime" && pwd -P)"
  ctg_tmp="$(mktemp -d "$ctg_runtime/unpack.XXXXXXXX")"
  case "$ctg_tmp" in "$ctg_runtime"/unpack.*) ;; *) exit 1;; esac
  trap 'case "$ctg_tmp" in "$ctg_runtime"/unpack.*) rm -rf -- "$ctg_tmp";; esac' EXIT
  echo 'Preparing a private Node.js 24 runtime from nodejs.org; system PATH is unchanged.' >&2
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 60 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' -o "$ctg_tmp/sums"
  ctg_line="$(awk -v p="$ctg_platform" -v a="$ctg_arch" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-" p "-" a "\\.tar\\.gz$") { print $0 }' "$ctg_tmp/sums")"
  [ "$(printf '%s\n' "$ctg_line" | wc -l | tr -d ' ')" = 1 ] || { echo 'Ambiguous official checksum entry.' >&2; exit 1; }
  read -r ctg_expected ctg_filename <<< "$ctg_line"
  [[ "$ctg_expected" =~ ^[0-9a-f]{64}$ ]] && [[ "$ctg_filename" =~ ^node-v24\.[0-9]+\.[0-9]+-(darwin|linux)-(x64|arm64)\.tar\.gz$ ]] || { echo 'Invalid official archive entry.' >&2; exit 1; }
  ctg_release="${ctg_filename#node-}"; ctg_release="${ctg_release%%-*}"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 300 "https://nodejs.org/dist/$ctg_release/$ctg_filename" -o "$ctg_tmp/archive.tar.gz"
  if command -v sha256sum >/dev/null; then ctg_actual="$(sha256sum "$ctg_tmp/archive.tar.gz" | awk '{print $1}')"; else ctg_actual="$(shasum -a 256 "$ctg_tmp/archive.tar.gz" | awk '{print $1}')"; fi
  [ "$ctg_actual" = "$ctg_expected" ] || { echo 'Runtime checksum mismatch; archive will not be executed.' >&2; exit 1; }
  ctg_package="${ctg_filename%.tar.gz}"
  tar -xzf "$ctg_tmp/archive.tar.gz" -C "$ctg_tmp"
  ctg_destination="$ctg_runtime/$ctg_package-$RANDOM$RANDOM"
  case "$ctg_destination" in "$ctg_runtime"/node-v24.*) ;; *) exit 1;; esac
  [ ! -e "$ctg_destination" ] || { echo 'Runtime destination already exists.' >&2; exit 1; }
  mv -- "$ctg_tmp/$ctg_package" "$ctg_destination"
  ctg_node="$ctg_destination/bin/node"
  ctg_valid_node "$ctg_node" || { echo 'The verified Node.js runtime could not run on this system.' >&2; exit 1; }
  rm -rf -- "$ctg_tmp"
  trap - EXIT
fi
exec "$ctg_node" --no-warnings "$ctg_directory/scripts/setup.mjs" "$@"
