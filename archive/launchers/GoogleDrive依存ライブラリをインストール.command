#!/bin/zsh

set -e

cd "/Users/thama/Documents/GitHub/pubmed_abstract"

echo "Google Drive API用ライブラリをインストールします。"
echo
echo "注意: この処理はインターネット接続が必要です。"
echo

mkdir -p vendor/google_drive
python3 -m pip install --target vendor/google_drive -r requirements-google-drive.txt

echo
echo "完了しました。"
read -k 1 "?終了するには何かキーを押してください。"
