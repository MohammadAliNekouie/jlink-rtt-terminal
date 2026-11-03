#!/usr/bin/env bash
# Offline simulation of the whole flashing stack (real SwdDap + flasher + drivers) against fake
# STM32F1 / STM32F4 chips behind a fake J-Link. Needs only TypeScript (devDependency) and node.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/flash"
cp "$ROOT"/src/*.ts "$T"/
cp "$ROOT"/src/flash/*.ts "$T"/flash/
rm -f "$T/session.ts" "$T/rtt.ts"          # not part of the flashing stack
cp "$ROOT"/tests/sim/*.ts "$T"/            # stub native.ts / jlink.ts replace the real ones
if [ -x "$ROOT/node_modules/.bin/tsc" ]; then TSC="$ROOT/node_modules/.bin/tsc"; else TSC="tsc"; fi
cd "$T"
"$TSC" --target es2020 --module commonjs --skipLibCheck --strict test.ts
node test.js | tee out.txt
if grep -q '^FAIL' out.txt; then echo "SIMULATION FAILED"; exit 1; fi
echo "SIMULATION PASSED ($(grep -c '^ok' out.txt) checks)"
