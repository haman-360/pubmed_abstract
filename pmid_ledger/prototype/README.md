# Workers＋D1 ローカル試作

**追加費用0円・架空データ専用。** Miniflare 4のworkerd／D1 bindingで動作する。Cloudflareアカウント・APIキー・Google認証・OpenAI APIは不要。クラウドへの作成・公開・課金は行わない。

## 起動

Node.js 22以上、Python 3.9以上が必要。リポジトリのルートから実行する。

```bash
cd pmid_ledger/prototype
npm ci
npm start
```

[ローカル画面](http://127.0.0.1:8787)を開く。初回の`npm ci`は無料の公開npmパッケージを取得する。起動後のWorkerの外向きHTTPは実行環境で拒否する。Wrangler CLIを追加せず、同じローカル実行基盤のMiniflareを直接使う。[MiniflareのD1 binding](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/)

120 PMID・6配信をPythonの既存`Dataset`／`to_tables`で生成する。実台帳、既存成果物、ローカルの認証設定は読まない。初回起動だけ初期化し、編集はGit対象外の`.local-d1/`へ保存する。Ctrl+Cで停止でき、再起動後も保存内容を保持する。試験用DBは別の一時DBで、通常起動用DBを変更しない。

画面では配信内の状態・メモを変更し、「途中まで保存」または「保存して確認完了」を押す。100件の配信は50件ずつ表示し、未保存編集はページをまたいで保持する。配信一覧へ戻る／再読み込み時は未保存内容の破棄を確認する。本文ボタンは表示上2000文字までに制限するが、APIの詳細取得は全本文を返す。

## 実装した範囲

- 配信一覧、配信内一覧、候補評価、候補なし配信、詳細本文、APIでの配信内部分文字列検索。読み取りは1 SQLのスナップショットから組み立てる。
- 最大100件の異なる状態・メモの保存。DB trigger内で全件の期待版数・存在・配信所属を検証する。
- 保存＋確認完了を1つのD1 batchで確定。配信版・掲載内容版・同期版・保存後の未確認0件も同じ処理内で検証し、不成立なら現在値・全履歴・操作ID登録をrollbackする。
- 操作ID＋正規化した要求のSHA-256で重複を防止。同じID・別内容や、別操作の補助IDの流用を拒否する。応答喪失後の再送は再書込せず最新状態を返す。
- 全件の架空メタデータを未公開世代へstageし、期待する旧世代と照合してpublish。同じ世代・内容のstageや直後のpublish再送は安全に繰り返せる。後続の別世代を古いpublishで巻き戻さない。手動履歴は世代の外へ保持する。
- 本人役／同期役のローカル仮認証、Origin制限、localhost限定、外向きHTTP拒否。**実際の本人認証の代用にはならない。**

操作要求は現行GASと同じ版数・操作ID等に加え、一覧で返した`revision`を必要とする。`saveAndCompleteIssue`の論文操作IDは`review_operation_id`、完了操作IDは`operation_id`。D1側の内部履歴は1つの原子的な親操作へ関連付ける。履歴の形式と要求ハッシュはGASバックアップの形式とは異なり、そのまま相互復元できるものではない。

## 検証

```bash
npm test
```

ローカルポートの使用を許可した環境で実行する。Miniflareの実D1 bindingに対する10個の統合テストで、次を確認する。

- 同じPython架空データをGASの既存Node VMへ入れ、6配信の一覧、候補、検索、ページ、本文と、100件保存後の状態・メモ・版を照合する。実行時刻、内部履歴フィールドは比較対象から分離する。
- 100件の最後の1件の競合、101件、不正状態、メモ長、所属外PMID、誤った配信版で追記がない。
- DB batch末尾の強制失敗でtriggerが作った履歴・現在値・操作IDも戻る。
- commit後の503による応答喪失と同じ要求の再送で重複しない。
- 2つの同時保存は一方だけ成功。古い再送は後続のメモ変更・配信再開を上書きしない。
- 0／51／100件編集、全5状態、メモだけ変更時の状態更新日時保持、同期世代公開・再送・競合、内容変更後の再確認、仮認証の分離。
- ランタイムの停止・再起動後も、メモ・操作履歴・再送判定を保持する。

2026-11-04に統合テスト10件成功。現行GASのNode.jsテスト54件も成功。MacのChromeで820×1180の画面を開き、保存＋完了、再読み込み後のメモ保持、ページ間編集、異なる状態のまとめ保存、横はみ出し・ブラウザーエラーなしを確認した。commit後503の画面試験でも、編集を固定して同じ要求を再送し、論文履歴・完了履歴が各1件に留まることを確認した。iPad実機の確認ではない。

## API（ローカル専用）

POST JSON。閲覧・保存は`Authorization: Bearer local-synthetic-owner`、同期は`Bearer local-synthetic-sync`。これらは固定のテスト文字列で、秘密情報ではない。

| パス | 用途 |
| --- | --- |
| `/api/listIssues` | 全配信一覧。現段階では状態・分野・日付の絞り込みなし |
| `/api/listIssuePapers` | `issue_key`、任意の`offset`／`query`／`status` |
| `/api/getPaperDetail` | `pmid`、任意の`issue_key` |
| `/api/saveReviews` | 論文の途中保存 |
| `/api/saveAndCompleteIssue` | 編集保存＋配信完了 |
| `/api/saveIssueReview` | 配信状態の更新／再開 |
| `/sync/stage` | `fixture.py`の全メタデータを未公開世代へ保存 |
| `/sync/publish` | `generation`と`expected_revision`（初回はnull）で公開 |

テスト時だけ、保存要求の`X-Local-Fault: rollback`はbatch末尾で失敗を注入し、`drop-response`はcommit後に503を返す。通常の画面は指定しない。同期入力はメタデータ表だけを許可し、Reviews／IssueReviewsを受け付けない。

## 限界と次の作業

これは保存契約の成立性を試す初段階。現行機能の全面移植・本番用バックエンドではない。

- 読み取りは世代の全メタデータJSONと現在値をDB内で取得して処理する。画面へ本文を返さなくてもWorker内には本文を含む全メタデータが届く。検索・ページングのSQL最適化、5000件の負荷試験は未実施。これを速度・無料枠適合の証拠にしない。
- 全世代を一括stageする。大きいデータの分割転送・段階的な検証・不要世代の安全な整理、PythonからHTTPで同期する実運用adapterは未実装。
- 通常PMID台帳、全絞り込み・並び順、TXT／CSV、完全JSONバックアップと別DB復元は未実装。クラウド試作前に復元手段が必要。
- Firebase認証、Service Auth、ネイティブログイン、FreeプランのCPU・保存容量・要求上限、クラウド往復・失敗率は未検証。ローカルの経過秒数をGAS本番との改善率に換算しない。
- deployment用設定・remote D1 binding・クラウド資格情報は置いていない。次も追加費用0円を維持し、まずローカルで検索のSQL化・バックアップ復元・同期adapterを進める。FirestoreのRules成立性の比較は別の作業。
