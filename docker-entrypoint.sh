#!/bin/sh
set -e

# Initialize qmd collection if not already configured.
# The config lives in a named volume so this only runs once across container recreations.
if ! qmd collection list 2>/dev/null | grep -q "vault"; then
  echo "[entrypoint] Registering qmd vault collection..."
  qmd collection add /vault --name vault
  qmd context add qmd://vault "Sean Balbale personal knowledge base — wiki, entities, concepts, sources, daily notes"
  echo "[entrypoint] qmd collection registered."
fi

exec "$@"
