# PubMed自動選定・Google Drive配信

既存のMacアプリ、`pubmed_fetch.py`、`pubmed_ai_select.py`による手動運用はそのまま残し、GitHub Actions用の非同期パイプラインを追加しています。定期実行は初期状態では無効です。

## 処理の流れ

1. 毎週土曜05:00 JSTに14テーマをEDATで検索し、テーマ別PMIDインデックスで重複を除きます。
2. `automation_config.json`の週次・隔週・月次設定に該当するテーマだけを配信runにまとめます。
3. 1論文1リクエストの一次Responses Batchを投入します。
4. 上位20本に最大4本の重要論文救済を加え、最大24本を最終Responses Batchへ送ります。
5. 全件アーカイブと固定CURRENTをGoogle Docsに作ります。
6. 同じcycleのテーマが終端状態になったらGmailを1通送ります。

GitHub Actionsのpollerは毎時17分に動きます。各Batchの`completion_window`は24時間で、一次と最終を直列に行うため最大約48時間を想定しています。

Batch応答のinput/cached input/output/total tokenは段階別にmanifestへ記録し、Gmailにもtotal tokenと推定USDを載せます。`automation_config.json`には2026-07-28時点の公式通常単価へBatchの50%割引を適用した単価を設定しています。価格改定時は`input_usd_per_million`、`cached_input_usd_per_million`、`output_usd_per_million`を変更できます。単価を`null`にすると、推定費用を出さずトークン数だけを記録します。

仕様照合先: [Batch API](https://developers.openai.com/api/docs/guides/batch)、[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)

## Google認証の初回設定

Google CloudでDrive API、Docs API、Gmail APIを有効化し、Desktop appのOAuth client JSONをダウンロードします。その後、ローカルで次を実行します。

```bash
python3 -m pip install -r requirements-automation.txt
python3 scripts/create_google_authorized_user.py /path/to/client_secret.json
```

ブラウザで本人OAuthを完了すると、権限を所有者だけに限定した`google_authorized_user.json`と、新規DriveルートフォルダーIDが作られます。ルートをこのOAuthアプリ自身が作ることで、`drive.file`の最小権限のまま継続利用できます。

GitHub repositoryに以下を設定します。

- Secret `OPENAI_API_KEY`
- Secret `GOOGLE_AUTHORIZED_USER_JSON`: `google_authorized_user.json`の中身を保存
- Secret `GMAIL_NOTIFY_TO`
- Variable `GOOGLE_DRIVE_ROOT_FOLDER_ID`: 標準エラーに表示されたID
- Variable `AUTOMATION_ENABLED`: 縦切り確認までは`false`

authorized-user JSONやclient secretはrepositoryへ追加しないでください。

## 最初の縦切り試験

Actionsの「PubMed automation」を手動実行し、次を指定します。

- `action`: `dispatch`
- `test`: `true`
- `limit`: `5`

TESTフォルダーだけに、小児腎臓の実データ5論文、一次Batch入力・結果、最終Batch入力・結果、run manifest、全件アーカイブ、固定CURRENTが作られます。メール件名には`[TEST]`が付きます。

Batchは非同期なので、完了までActionsを手動で`action=poll`、`test=true`として実行します（通常の定期pollerは本番領域だけを対象にします）。同じ縦切りのCURRENTは同一内容でもう一度更新し、manifestの`stability_verified=true`でfile ID不変を確認します。

縦切り成功後は、まず通常の`dispatch`を手動実行してDrive構造・トークン使用量・通知を確認し、最後にRepository variable `AUTOMATION_ENABLED=true`へ変更します。

## 手動操作

```bash
# 設定だけを検証（認証不要）
python3 pubmed_automation.py validate

# 特定テーマを頻度に関係なく実行
python3 pubmed_automation.py dispatch --topic ped_nephrology_update --force

# 全未完cycleを進める
python3 pubmed_automation.py poll

# 特定cycleの通知だけを手動再試行
python3 pubmed_automation.py retry-notification --cycle-id manual-12345
```

## Driveの正本

- `system/automation_ledger.json`: 軽量台帳。設定ハッシュ、EDAT、固定file ID、run manifest参照、状態だけ
- `topics/{topic}/pmid_index.json`: PMID、初回取得、raw参照、run、配信状態
- `runs/{cycle}/{topic}/`: Abstract JSON、Batch JSONL、生出力、評価、候補、manifest
- `documents/{topic}/archive/`: 全新着のAbstractと評価、最終10本・次点5本
- `documents/{topic}/current/`: 最終10本までのAbstract全文を含む、NotebookLMへ登録する固定文書

Gmailだけが失敗してもrunと文書は完了状態のままです。通知は最大5回自動再試行し、その後も手動再試行できます。送信済み応答IDを台帳に保存し、同じcycleの通常再実行では再送しません。ネットワーク切断がGmail側の受付直後に起きたという判定不能ケースに備え、メールにはcycle内容由来の固定Message-IDも付けます。

## テスト

```bash
PYTHONPYCACHEPREFIX=/tmp/pubmed-pycache python3 -m unittest discover -s tests -v
```

外部認証を使わないテストでは、14テーマ対応、頻度、EDATページング、救済、候補上限、選定・次点分離、NotebookLM除外条件、軽量台帳、Gmail失敗時の非ロールバックを確認します。実APIの縦切りはSecretsを設定した後に行います。
