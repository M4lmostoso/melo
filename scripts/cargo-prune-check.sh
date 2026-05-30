#!/bin/bash
# Auto-prune Cargo build artifacts every N builds to keep disk usage in check.
# Runs `cargo cache --autoclean` (removes only stale/unreferenced artifacts)
# rather than the nuclear `cargo clean`.

PRUNE_EVERY=3
COUNT_FILE="$(dirname "$0")/../.build-count"

count=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
count=$((count + 1))

if [ "$count" -ge "$PRUNE_EVERY" ]; then
  echo "→ Auto-pruning Cargo cache (build #${count})..."
  cargo cache --autoclean
  count=0
fi

echo "$count" > "$COUNT_FILE"
