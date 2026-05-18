#!/bin/zsh

set -e

cd "/Users/thama/Documents/GitHub/pubmed_abstract"

echo "ChatGPTの回答をGoogle Docs用ファイルに保存します。"
echo
echo "先にChatGPTの回答をコピーしておいてください。"
echo

python3 save_chatgpt_output_menu.py

echo
echo "完了しました。"
read -k 1 "?終了するには何かキーを押してください。"
