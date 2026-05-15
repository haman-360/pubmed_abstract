#!/bin/zsh

set -e

cd "$(dirname "$0")"

if [ -f ".env" ]; then
  source ".env"
fi

if [ -z "$OPENAI_API_KEY" ]; then
  echo "OPENAI_API_KEY が設定されていません。"
  echo
  echo ".env.example を .env にコピーして、APIキーを貼り付けてください。"
  echo
  echo "この画面は閉じても大丈夫です。"
  read -k 1 "?終了するには何かキーを押してください。"
  exit 1
fi

echo "PubMed月次更新 + AI選定を開始します。"
echo "月次テーマを検索し、重要論文10本の日本語評価と英語abstract集を作成します。"
echo

python3 pubmed_ai_select.py --frequency monthly

echo
echo "完了しました。"
echo "ai_selected フォルダを開きます。"
open ai_selected
echo
echo "この画面は閉じても大丈夫です。"
read -k 1 "?終了するには何かキーを押してください。"
