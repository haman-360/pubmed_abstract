#!/bin/zsh

set -e

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

python3 workflow_menu.py
