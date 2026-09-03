#!/bin/bash
set -e

status="$1"
sha="$2"

if [[ "$status" == "N" ]]; then
  echo "Unsigned commit: ${sha:-<unknown>}" >&2
  exit 1
fi
