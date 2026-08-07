# PubMed automation 障害・運用確認履歴

最終更新: 2026-08-07 JST

このファイルは、PubMed automationで発生した障害、GitHubから届いた失敗通知、調査結果、対処、再発時の判断材料を時系列で残すための記録である。

## 実行の種類

GitHub Actionsの`PubMed automation`には、役割の異なる2つの定期実行がある。

- `dispatch`: 毎週土曜05:00 JSTに、新しいPubMed文献の検索とOpenAI Batchの投入を開始する。
- `poll`: 毎時17分ごろに、開始済みBatchの進捗確認、Google Docs更新、完了通知を進める。処理中のcycleがない時間帯にも起動する。

GitHubから件名`Run failed: PubMed automation`で届くメールは、GitHub Actions自体の失敗通知である。アプリが送る件名`PubMed最新論文ダイジェスト ...`とは別物であり、前者だけではabstract収集が失敗したとは判断できない。

## 履歴一覧

| 日時（JST） | 事象 | 原因 | 影響 | 状態 |
|---|---|---|---|---|
| 2026-08-07 01:58–02:14、03:39–03:54 | 定期`poll`が2回キャンセル | GitHub Hosted Runnerを複数回試行しても確保できなかった | Runner上の処理は開始されず、PubMed、OpenAI、Google Drive、Gmailへのアクセスなし | 自然復旧、対応不要 |
| 2026-08-04 23:40–2026-08-05 21:14 | 定期`poll`が連続失敗 | Google OAuth refresh tokenの失効（`invalid_grant`） | Google Driveへの最初のアクセスで停止。新規文献検索を行う`dispatch`ではないためbackfill不要 | 再認証とGitHub Secret更新で復旧 |
| 2026-07-28 | Drive検索結果が空の場合の処理不備を修正 | 空の`files`配列を想定していなかった | 実運用上の発生日時・影響は記録からは確認できない | 修正・回帰テスト追加済み |

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

