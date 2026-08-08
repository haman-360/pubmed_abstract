# PubMed automation 障害・運用確認履歴

最終更新: 2026-08-08 JST

このファイルは、PubMed automationで発生した障害、GitHubから届いた失敗通知、調査結果、対処、再発時の判断材料を時系列で残すための記録である。

## 実行の種類

GitHub Actionsの`PubMed automation`には、役割の異なる2つの定期実行がある。

- `dispatch`: 毎週土曜05:00 JSTに、新しいPubMed文献の検索とOpenAI Batchの投入を開始する。
- `poll`: 毎時17分ごろに、開始済みBatchの進捗確認、Google Docs更新、完了通知を進める。処理中のcycleがない時間帯にも起動する。

GitHubから件名`Run failed: PubMed automation`で届くメールは、GitHub Actions自体の失敗通知である。アプリが送る件名`PubMed最新論文ダイジェスト ...`とは別物であり、前者だけではabstract収集が失敗したとは判断できない。

## 履歴一覧

| 日時（JST） | 事象 | 原因 | 影響 | 状態 |
|---|---|---|---|---|
| 2026-08-08 | Google Docsの第3部「候補論文スコア一覧」が読みにくい | 5項目をGoogle Docsの表ではなく、`|`区切りの通常テキストとして挿入していた | 第1部・第2部と収録データには影響なし。第3部だけ列が揃わず、候補論文の比較が難しかった | Google Docsネイティブ表への変換処理と回帰テストを追加済み。次回の文書生成・更新から適用 |
| 2026-08-08 06:54以降 | 完了メールのCURRENTリンクを開くと「ファイルはゴミ箱にあります」と表示 | 重複に見えた文書を整理した際、Drive台帳が参照する固定CURRENT文書も手動でゴミ箱へ移動していた。workflowはゴミ箱状態を確認せず、同じIDの文書を更新した | abstract生成と文書更新は完了したが、メールのリンク先を通常閲覧できなかった | 原因特定。固定CURRENTをゴミ箱から復元予定。恒久対策は課題として保留 |
| 2026-08-07 01:58–02:14、03:39–03:54 | 定期`poll`が2回キャンセル | GitHub Hosted Runnerを複数回試行しても確保できなかった | Runner上の処理は開始されず、PubMed、OpenAI、Google Drive、Gmailへのアクセスなし | 自然復旧、対応不要 |
| 2026-08-04 23:40–2026-08-05 21:14 | 定期`poll`が連続失敗 | Google OAuth refresh tokenの失効（`invalid_grant`） | Google Driveへの最初のアクセスで停止。新規文献検索を行う`dispatch`ではないためbackfill不要 | 再認証とGitHub Secret更新で復旧 |
| 2026-07-28 | Drive検索結果が空の場合の処理不備を修正 | 空の`files`配列を想定していなかった | 実運用上の発生日時・影響は記録からは確認できない | 修正・回帰テスト追加済み |

## 2026-08-08: 第3部「候補論文スコア一覧」をGoogle Docsの表へ変更

### 利用者が確認した現象

自動作成されたGoogle Docsは、第1部、第2部、第3部という全体構成には問題がなかった。一方、第3部「候補論文スコア一覧」は、次の5項目が`|`で区切られた通常テキストとして連続表示されていた。

- PMID
- タイトル
- 総合スコア
- 役立つか
- 短いメモ

長い英語タイトルや日本語メモが複数行に折り返されると、どの値がどの項目・論文に対応するのか判別しにくかった。利用者から、過去に作成された読みやすい文書と同様の表形式にする要望があった。比較資料として、`今回の読みにくい第3部.png`と`理想の読みやすい第3部.png`が提示された。

### 原因

`automation_core.render_notebook_doc()`は第3部を`PMID | タイトル | 総合スコア | 役立つか | 短いメモ`というプレーンテキストに整形し、`GoogleWorkspaceClient.replace_doc_text()`は文書全体を`insertText`でGoogle Docsへ挿入していた。

Google Docs APIの`insertText`は`|`区切りを表として解釈しないため、生成データに5項目が含まれていても、Google Docs上では罫線やセルを持たない通常本文になっていた。

### 実施した変更

- 第1部と第2部の生成形式は変更しない。
- 第3部の見出しは通常本文に残し、その直下へGoogle Docs APIの`insertTable`で5列のネイティブ表を作成する。
- 1行目を列見出し、2行目以降を候補論文ごとのデータ行として各セルへ挿入する。
- 見出し行に薄い背景色を設定し、タイトルと短いメモはセル内で折り返して表示できるようにする。
- タイトルまたはメモに改行や半角`|`が含まれても、表の列数が崩れないよう正規化する。
- 第3部を認識できない既存形式の入力では、従来どおり通常テキストを挿入するフォールバックを維持する。

変更対象:

- `automation_core.py`: 第3部の5列データを安全に受け渡す整形処理
- `automation_services.py`: 第3部の抽出、Google Docs表の作成、セルへの入力、見出し行の装飾
- `tests/test_automation_core.py`: 改行・`|`を含むセル内容の回帰テスト
- `tests/test_failure_semantics.py`: 5列への分割とGoogle Docs表作成リクエストの回帰テスト

### 影響と検証結果

- 第1部「日本語要約」と第2部「英語Abstract」の本文生成処理は維持される。
- 第3部に収録する候補論文、スコア、外来有用性、短い評価メモの内容は変更されない。
- 表示方法だけが、`|`区切り本文から5列のGoogle Docsネイティブ表へ変わる。
- `python3 -m unittest discover -s tests -v`を実行し、18件すべて成功した。
- Python構文チェックと`git diff --check`も成功した。
- 実Google Docsへの本番アップロードは、この修正作業中には実行していない。

次回の文書生成または固定CURRENT文書の更新時から新しい表形式が適用される。既に作成済みの文書は、そのままでは変化せず、workflowによる再生成・更新が必要である。

## 2026-08-08: 完了メールのCURRENTリンクがゴミ箱状態

### 利用者が確認した現象

`PubMed最新論文ダイジェスト scheduled-2026-08-08`は2026-08-08 06:54 JSTに正常に届いた。メールでは4テーマすべてが`COMPLETED`、`失敗テーマ: なし`、`CURRENT更新未完了: なし`となっていた。

しかし、メール内のCURRENTリンクを開くと、Google Docsに「ファイルはゴミ箱にあります」と表示された。Driveのゴミ箱には、同じテーマ名を持つ次のような文書が複数あり、画面上の名前だけではメールのリンク先を区別しにくい状態だった。

- 固定文書: `<テーマ>_NotebookLM_CURRENT`
- 旧手動run: `<テーマ>_manual-<ID>_NotebookLM`
- 旧手動run: `<テーマ>_manual-<ID>_全件アーカイブ`
- 同名に見える過去のCURRENT文書

### 調査結果

メール内のリンク先IDと、Driveの`automation_ledger.json`に保存された`current_file_id`は一致していた。対象は次の4文書だった。

- 小児感染症: `1c1v9_lIMl_-FlwdNLBkeSgdqsrE7GNTBCDEGOKxVtzY`
- 小児腎臓: `1vcjrXe7XRORJIIcKxKlhh4pRwqH-3qkOWCKTYetIk7A`
- 小児喘息: `1sr3JaTLtndOD3Y_U_8y49e08vS7ZCsHlsbl7DZ7nv5g`
- プライマリケア・レビュー: `1DjGkN5oTlmXCEn5hG82sjxeZD0pH_2J5UmpS1UKUvxM`

各文書には`scheduled-2026-08-08`の内容が書き込まれており、abstract生成とCURRENT更新そのものは成功していた。メールも台帳に記録された正しいIDを使用していたため、ファイル名の重複やメールリンク生成の誤りではなかった。

利用者が、以前生成されたCURRENT、NotebookLM、全件アーカイブのうち内容が同じに見える文書を整理してゴミ箱へ移動した際、現在の自動処理が継続使用する固定CURRENT文書も一緒に移動していたことが原因と判明した。

現在の実装は、台帳に`current_file_id`がある場合、そのIDを指定してGoogle Docs本文を更新する。更新前後にDriveの`trashed`状態を確認していないため、ゴミ箱内の文書でも本文更新が成功し、`current_doc: COMPLETED`として通知メールを送信できてしまう。

### 影響

- PubMed検索、OpenAI Batch、abstract生成は正常に完了した。
- 4テーマのCURRENT本文は2026-08-08分へ更新された。
- メール送信も正常に完了した。
- 問題は、リンク先の固定CURRENT文書がゴミ箱状態で、通常閲覧に警告と復元操作が必要だったことに限定される。
- 再検索、Batch再実行、文書再生成、メール再送は不要である。

### 今回の対処

メールの各リンクまたはDriveのゴミ箱から、上記の固定CURRENT文書を「ゴミ箱の外に移動」して同じファイルIDのまま復元する。旧`manual-*`文書など、台帳が参照していない文書まで復元する必要はない。

生成日時をCURRENTのファイル名に加えて毎回新規作成する方法は採用しない。CURRENTはNotebookLMの参照先を変えずに済むよう、同じファイルIDを継続更新することが目的である。

### 次回に残す課題

不要な旧文書を安全に整理でき、管理対象CURRENTを誤って削除しにくくする方法を検討する。候補は次のとおり。

- CURRENT更新前にDriveメタデータの`trashed`を確認する。
- `trashed: true`なら自動復元してから更新する、または更新失敗として通知を保留する。
- 更新後にも`trashed: false`を検証し、ゴミ箱内の文書を`COMPLETED`と扱わない。
- Driveの`description`または`appProperties`に「自動処理が管理する固定CURRENT」であることを記録する。
- 管理対象の固定CURRENT IDと、削除可能な旧`manual-*`・旧アーカイブを一覧化する。
- 安全な整理手順または専用cleanupコマンドを用意し、台帳参照中のIDは削除対象から除外する。

この時点ではコード変更を行わず、課題として記録する。

## 2026-08-07: GitHub Hosted Runnerを確保できず`poll`がキャンセル

### 利用者が確認した現象

GitHubから次のような失敗通知メールが届いた。

- 件名: `[haman-360/pubmed_abstract] Run failed: PubMed automation - main (2adb4a3)`
- 02:14の通知: run #116
- 03:54の通知: run #117
- 表示: `poll: Cancelled`、`dispatch: Skipped`、`validate: Skipped`

### 調査結果

対象run:

- run #116: https://github.com/haman-360/pubmed_abstract/actions/runs/31121693280
- run #117: https://github.com/haman-360/pubmed_abstract/actions/runs/31126188764

両方の`poll` jobに、GitHubから次のfailure annotationが付いていた。

> The job was not acquired by Runner of type hosted even after multiple attempts

run #116は2026-08-07 01:58:58 JSTに待機を開始し、02:13:59 JSTにキャンセルされた。jobにはRunner名、step、実行ログがなく、GitHub Hosted Runner上でworkflowのstepが一つも開始されていないことを確認した。run #117も同じ状態・同じannotationだった。

`dispatch`と`validate`が`Skipped`なのは異常ではない。毎時scheduleでは条件に一致する`poll`だけが対象となる。

### 影響

- 新しいabstractの検索・収集は行われていない。
- PubMed、OpenAI Batch、Google Drive、Google Docs、Gmailへのアクセスは行われていない。
- 完了済みの`scheduled-2026-08-01` cycle、作成済みCURRENT文書、8月1日の通知メールへの影響はない。
- 次の新規収集は、予定どおり2026-08-08 05:00 JSTの`dispatch`で開始する設計である。

### 対処と復旧確認

コード、Secrets、Google設定の変更は行っていない。その後の定期`poll`は成功しており、最初に確認できた復旧後の成功は2026-08-07 09:44 JSTのrun #118だった。以後のrunも成功したため、一時的なGitHub Hosted Runner確保障害と判断した。

同じ通知が再発した場合は、job annotationを確認する。上記と同じ文言で、stepとログが空であり、後続runが成功している場合は、通常は再実行やbackfillは不要である。

## 2026-08-04〜05: Google OAuth refresh token失効

### 現象と原因

2026-08-04 23:40 JSTのrun #94から、定期`poll`がGoogle Driveへの最初のアクセスで連続して失敗した。確認したエラーは次のとおり。

> `invalid_grant: Token has been expired or revoked.`

Google Auth PlatformのOAuthアプリが外部ユーザー向けの「テスト中」で、`drive.file`と`gmail.send`スコープを使用していたため、refresh tokenが失効した。

### 影響

- 失敗したのは`poll`であり、新規検索を始める`dispatch`ではなかった。
- Google Driveへの最初のアクセスで停止したため、Drive台帳やGoogle Docsは変更されなかった。
- 完了状態はDrive上に保存される設計なので、失敗runごとのbackfillや再実行は不要だった。

### 対処

- Google Auth Platformの公開ステータスを「本番環境」に変更した。
- 既存Driveルートを維持したまま、`--token-only`でGoogle OAuthを再認証した。
- GitHub Secret `GOOGLE_AUTHORIZED_USER_JSON`を新しい認証JSONで更新した。
- 2026-08-05 22:15 JSTの手動`poll`（run #104）で復旧を確認した。

詳細な手順と注意事項は[Project.md](Project.md)を参照する。

## 2026-07-28: Drive検索結果が空の場合の処理不備

Google Driveで対象名の子ファイルが見つからず、APIが空の`files`配列を返した場合、先頭要素を直接参照していた処理を修正した。

- 修正commit: `b910af4` (`Handle empty Drive search results (#1)`)
- 修正後: 空の場合は`None`を返し、必要なフォルダーまたはファイルを作成できる。
- 回帰テスト: `DriveLookupTests.test_find_child_returns_none_when_drive_search_is_empty`

コミット履歴から修正内容は確認できるが、実運用でいつ発生し、どの処理に影響したかは記録されていない。そのため、本件は「確認済みの本番障害」ではなく「開発時に修正された不具合」として扱う。

同日、OAuth再認証時に不要な新規Driveルートを作らないための`--token-only`オプション追加、認証ファイルの`.gitignore`登録、依存関係の明記も行われた（commit `44eae4f`）。これは障害記録ではなく、再発予防の改善である。

## 再発時の確認順序

1. GitHubメールの送信者と件名を確認する。
   - `notifications@github.com` / `Run failed`: GitHub Actionsの失敗通知。
   - `PubMed最新論文ダイジェスト ...`: PubMed automationの完了通知。
2. workflow画面で、`dispatch`と`poll`のどちらが対象か確認する。
3. jobの状態、annotation、開始済みstep、ログの有無を確認する。
4. `poll`失敗の場合、未完了cycleが存在するかDriveの`automation_ledger.json`で確認する。
5. 後続の定期`poll`が成功しているか確認する。
6. Google認証エラーなら[Project.md](Project.md)の再認証手順を使用する。
7. 文書が完了し通知だけ失敗した場合に限り、`retry-notification`を検討する。

## 新しい記録のテンプレート

```markdown
## YYYY-MM-DD: 事象名

### 現象

- 利用者が確認した内容:
- 対象run/cycle:
- 発生日時（JST）:

### 原因

- ログまたはannotation:
- 確定した原因:
- 推測が残る場合:

### 影響

- PubMed検索:
- OpenAI Batch:
- Google Drive / Docs:
- Gmail通知:

### 対処と復旧確認

- 実施した変更:
- 復旧を確認したrun:
- backfillまたは通知再送の要否:
- 今後の再発防止:
```
