#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd "$SCRIPT_DIR/.." && pwd)

cd "$ROOT_DIR"

git pull --ff-only
npm install
npm run build

exec node dist/index.mjs "$@"
