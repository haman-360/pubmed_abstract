#!/bin/zsh

set -e

cd "$(dirname "$0")"

echo "PubMed月次更新を開始します。"
echo "月次テーマを検索し、MarkdownとGoogle Docs取り込み用HTMLを作成します。"
echo

python3 pubmed_fetch.py --frequency monthly

echo
echo "完了しました。"
echo "google_docs フォルダを開きます。"
open google_docs
echo
echo "この画面は閉じても大丈夫です。"
read -k 1 "?終了するには何かキーを押してください。"
