#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
LAMBDA_DIR="$ROOT_DIR/lambda/elastic_search"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

pushd "$LAMBDA_DIR" >/dev/null
zip -r "$DIST_DIR/elastic_search.zip" .
popd >/dev/null

echo "Lambda bundle created at dist/elastic_search.zip"
