#!/bin/bash
set -e

for dir in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin"; do
  [ -d "$dir" ] || continue
  case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac
done
export PATH

LAZYBOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$HOME/.config/urras/env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$HOME/.config/urras/env"
  set +a
fi

if [ -n "$LAZYBOY_PATH" ]; then
  export PATH="$LAZYBOY_PATH:$PATH"
fi

while true; do
  deno run --allow-all "$LAZYBOY_DIR/src/index.ts" tick
  sleep 300
done
