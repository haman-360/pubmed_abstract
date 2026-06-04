#!/bin/zsh

set -e

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

python3 pubmed_menu.py
