#!/bin/bash
set -e
ctg_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec /bin/bash "$ctg_directory/start-context-guard.sh" "$@"
