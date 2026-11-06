#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if ! command -v node >/dev/null 2>&1; then
  print 'Node.js 22以降が必要です。'
else
  node pmid_ledger/prototype/export-wanted.mjs
fi
print '\n終了しました。Enterで閉じます。'
read -r
