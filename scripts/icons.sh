#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
vips copy web/public/favicon.svg web/public/apple-touch-icon.png
