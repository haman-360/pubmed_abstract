# PMID論文確認台帳

Python＋GitHub Actionsの配信処理を保ち、本人限定のGoogleスプレッドシート＋GAS Webアプリで、人の確認状態を管理します。台帳の移行・同期・検索・状態変更・メモ・TXT/CSV・バックアップでは、OpenAI APIもPubMed APIも呼びません。

## 構成と安全性

| シート | 内容 | 書き込み担当 |
|---|---|---|
| Papers | PMID主キー、書誌情報、分野、初回/最終検出日、出典 | Python同期のみ |
| Appearances | 配信ID・分野・PMIDごとの当時タイトル、選定区分、配信日、CURRENTリンク、本文参照 | Python同期のみ |
| Texts | 生成済み日本語要約・一行評価・理由・重要度のJSON。長文は2万文字ずつ分割 | Python同期のみ |
| Issues | 配信ID＋分野、PMID集合、掲載内容の版（一覧用の小さい索引） | Python同期のみ |
| TextRows | 保存本文の開始行・行数（詳細の必要範囲だけ取得する索引） | Python同期のみ |
| Reviews | 状態・メモの追記式操作履歴。PMID、版数、操作ID、要求ハッシュ、更新日時 | GASのみ |
| IssueReviews | 配信ID＋分野ごとの確認状態・確認した掲載内容の版・操作履歴（初回保存時に追加） | GASのみ |
| Settings | スキーマ、環境識別子、同期版数、最終同期日時 | Python同期のみ |

レビュー履歴がないPMIDは未確認です。移行時に未確認の行を書き込むことはありません。自動処理の `delivery_state` はレビュー状態に転用しません。

Pythonは既存データと新しいデータの和集合を作り、Reviewsを対象に含めず、Sheetsの1回の原子的batchUpdateで書誌・掲載履歴・本文・同期版数を更新します。更新前にはローカルJSONとDrive上の台帳コピーを保存します。変更がなければ書き込みもコピーも行いません。履歴の本文が異なる場合は旧本文を残し、別の訂正版履歴として保存します。

GASはScriptLock、期待版数、操作ID/要求ハッシュを使い、最大100件の状態・メモを一括検証後、1回の書き込みで追記します。保存後に読み戻して確認できた場合だけ成功を返します。応答不明時は同じ操作を再試行でき、競合時は再読み込みを促します。シートの直接手編集はこの保護を迂回するため、通常の状態・メモ変更はWebアプリから行ってください。

## Google設定

1. 既存OAuthのGoogle CloudプロジェクトでSheets APIを有効にします。Pythonのスコープは既存の `drive.file` だけで足ります。
2. そのOAuthクライアント自身で新しい台帳を作成します。他のコネクターで作ったSheetが同じOAuthから見えるとは限りません。
3. GASへ `gas/Code.gs`、`gas/Index.html`、`gas/appsscript.json` を配置します。
4. Script Propertiesに `OWNER_EMAIL`、`LEDGER_SHEET_ID`、`LEDGER_INSTANCE` を設定します。通常の本番識別子は `pubmed-review-production-v1`、TESTは `test-` で始めます。
5. Webアプリは**自分のみ／アクセスしているユーザーとして実行**でデプロイします。必要なGASスコープは `spreadsheets` と `userinfo.email` の2つです。Googleの承認は本人が行います。匿名公開にはしません。

実環境の接続ID、移行データ、メモを含むバックアップは `ledger_private/` に保存し、Gitには含めません。公開リポジトリに認証JSONや個人の台帳内容を追加しないでください。

## 移行と同期

初回は読み取り専用の棚卸しを実行し、`report.json` の入力元別件数、復元件数、不明項目を確認します。

```bash
python -m pmid_ledger inventory --include-drive --include-docs
python -m pmid_ledger create --drive-root "$GOOGLE_DRIVE_ROOT_FOLDER_ID"
# createが返したIDをPMID_LEDGER_SHEET_IDに設定
python -m pmid_ledger sync --include-drive --include-docs
```

ローカルの既存OAuth JSON、または環境変数 `GOOGLE_AUTHORIZED_USER_JSON` を使用します。コードは既存のDriveStoreを生成しないので、読み取り専用棚卸しがDriveフォルダーや自動検索台帳を作成・更新することはありません。

取り込み元は、既存のPMIDインデックス、raw scan、run manifest、生成済み評価JSON、保存済みTXT/Markdown/HTML、既知PMID集合、初回に指定したCURRENT文書の読み取りです。候補表のPMIDも保存します。過去の配信日がない場合は空欄で、ファイル更新時刻や月単位のファイル名を配信日に変換しません。CURRENTのコピーは `current_copy:` という復元元付き履歴で、過去の特定配信の本文と断定しません。

今後の文書作成では `current_doc.completed_at` を保存します。過去のrunは再実行・再要約しません。新しい独立workflow `PMID review ledger sync (no AI)` が毎時43分に既存成果物を読み取り、台帳だけへ同期します。完了済みrunも対象なので、同期失敗は次回または手動実行で回復できます。既存pollの成否と台帳同期の成否は分離しています。

GitHubの設定：

- `GOOGLE_DRIVE_ROOT_FOLDER_ID` とSecret `GOOGLE_AUTHORIZED_USER_JSON` は既存値を使います。
- Secret `PMID_LEDGER_SHEET_ID`：本番台帳ID。公開リポジトリのVariablesには保存しません。
- Variable `PMID_LEDGER_ENABLED=true`：同期の有効化。falseで同期のみ停止できます。
- Secret `PMID_LEDGER_WEB_URL`：本人限定WebアプリURL。設定後に生成する文書へPMID指定の確認リンクを追加します。既存文書の再生成は行いません。

自動メタデータ書き込みはこのworkflow一つに限定し、既存pipelineと同じconcurrency groupで直列化します。本番台帳へのローカル再同期は通常拒否します。保守が必要なときだけ、同期workflowを無効化し実行中ジョブの終了を確認してから `PMID_LEDGER_MAINTENANCE=1` を明示してください。GASからの手動状態変更は、別シートなので停止不要です。

## iPad・Macでの操作

初期表示は「配信ごとの確認」です。「PMID台帳」を開くと「最近の未確認」が表示されます。原文入手待ち・原文入手済み未読は全期間のまま残ります。日付不明の未確認は過去タブへ含め、物理移動はしません。1ページ50件で、一覧には要約全文を転送せず、詳細を開いたときだけ本文を取得します。

- PMID/タイトル検索、分野、状態、配信日の範囲、数値順PMID、配信日順、状態更新日順に対応します。分野と配信日を指定した場合は、同一掲載履歴で両条件を満たす必要があります。
- 「原文入手希望に追加」はワンタップ保存です。PMID台帳と配信内のどちらでも、各論文の状態と2000文字以内のメモを別々に編集し、一覧末尾の「画面上の変更をまとめて保存」で変更分だけを1回に保存できます。未保存の状態・メモはページをまたいで画面内に保持し、ページを離れる際に警告します。
- ページをまたいで選択でき、一括状態変更は100件までです。TXTは全期間の希望全件、または選択した希望PMIDだけを出力します。ファイル名は `pmids.txt`、UTF-8・BOMなし・数字だけ1行1件・数値順・重複なしです。
- `pubmed-pdf-fetcher` と `pubmed-grarec-notion` の入力に使えます。`#` は付けません。TXT取得だけで原文入手済みにはしません。既存入力の未処理PMIDを消さないよう、無断で既存ファイルを上書きする連携はありません。
- CSVは現在の表示条件、JSONバックアップは台帳全体です。CSVでは数式として解釈される文字列をエスケープします。正確な復元にはJSONを使用します。
- 台帳URLの `?pmid=12345678` で対象論文を検索・詳細表示できます。リンクを開くだけでは保存しません。

## 変更履歴

### 2026-09-02: PMID台帳画面から状態・メモをまとめて保存

- 通常のPMID台帳でも、各論文に異なる状態・メモを指定してから「画面上の変更をまとめて保存」で一度に保存できるようにした。
- 個別の「状態・メモを保存」ボタンを廃止し、未保存件数を表示する追従型の保存バーへ統一した。
- チェック済み論文へ同じ状態を適用する既存操作を「同じ状態へ一括変更・保存」と明示した。
- 1ページ50件、1回100件までの既存上限を維持し、変更分を1回の `saveReviews` 呼び出しで保存する。
- 本番Webアプリをバージョン6へ更新した。既存の `/exec` URL、実行者「アクセスしているユーザー」、アクセス範囲「自分のみ」を維持した。
- Node.jsテスト18件、Pythonテスト11件、`git diff --check`に合格し、本番の「原文入手待ち」12件画面で未保存件数が0→1→0になることを保存なしで確認した。

## バックアップと復元

Webアプリの「全台帳バックアップ（JSON）」、または次のCLIで、手動メモ・操作履歴・要約も含めて保存できます。

```bash
python -m pmid_ledger backup
python -m pmid_ledger restore-copy \
  --backup-file ledger_private/backup.json \
  --drive-root "$GOOGLE_DRIVE_ROOT_FOLDER_ID" \
  --title PMID台帳_復元確認 \
  --instance restore-unique-identifier
```

復元は**新しい識別子の空の別台帳へだけ**行います。本番台帳を上書きしません。復元内容を確認後、必要な場合のみGASの接続先・GitHubの台帳IDを切り替えます。誤操作を隠すためにReviewsの行を削除せず、Webアプリで正しい状態へ変更してください。

## 検証

```bash
python3 -m unittest discover -s tests -v
node --test pmid_ledger/tests/*.test.mjs
node pmid_ledger/preview.mjs  # localhost:8766、架空データ、メモリ保存のみ
```

実装検証では冪等移行、履歴の訂正版保持、長文分割/復元、単一掲載履歴での絞り込み、5000件ページ分割、保存競合、同一操作再試行、メモ保護、TXT/CSV、本人拒否、将来文書のリンク範囲を確認します。Google上の保存試験とiPad実機試験は別途記録します。

運用上の制限：Google権限と通信が必要で、オフライン保存はしません。メタデータの1回の同期は18MBで安全停止します。現状の約1000件ではこの上限を下回りますが、数万件や非常に長い全文を蓄積する場合は保存方式の再検討が必要です。将来AIによる再評価を追加する場合も、台帳と分離し、費用提示と承認なしに実行しません。

Google仕様の確認先：[Sheets batchUpdateと原子的更新](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate)、[drive.fileスコープ](https://developers.google.com/workspace/sheets/api/scopes)、[GASの非同期画面通信](https://developers.google.com/apps-script/guides/html/communication)。


## 配信ごとの確認

「配信ごとの確認」は、同じCURRENT文書IDでも配信IDと分野が違えば別の回として扱います。未確認／確認中／確認済み、振り分け済みPMID数、配信IDを表示し、分野・確認状態で絞り込めます。20配信ずつ表示します。

1. 「この配信の論文を確認」を開き、その回の論文を原文不要・原文入手希望などへ振り分けます。この画面の詳細にはその回の保存済み要約だけを表示します。
2. 未確認PMIDが0件になったら「この配信を確認済みにする」を押します。既に別の回で振り分けたPMIDは集計に反映されますが、配信自体は明示操作なしに確認済みにはなりません。
3. 原文入手希望・原文入手済みの論文は、配信を確認済みにした後も対応中一覧に残ります。配信完了はPMIDの状態・メモを一切変更しません。
4. 「確認中にする」「未確認に戻す」で中断・再確認を記録できます。確認済みになった後に掲載内容が追加・変更された場合は、「内容追加・更新あり」の確認中として表示し、以前の完了履歴も残します。

日付の欠損表示は省き、配信IDを残します。過去の本文と一致しないCURRENTリンクは画面に表示しません（保存済みURLはバックアップ・CSVに保持）。ローカル保存ファイル・CURRENT復元分は、実際の配信runとの対応が断定できないため、復元元を明示して別のまとまりとして扱います。欠損を埋めるためのAI利用や過去文書の再生成はしません。

確認履歴は追加の `IssueReviews` シートへGASが追記します。既存5シート構成も読み取れ、最初の配信状態保存時だけシートを追加します。Python同期はReviews・IssueReviewsのどちらにも書きません。バックアップ・別台帳復元では両方を保持します。旧形式バックアップでは配信確認履歴は空として扱います。

次回以降のGoogleドキュメントには、その配信だけを開くリンクも付きます。台帳URLの `?issue=` にJSON形式の `[配信ID,分野名]` をURLエンコードして渡します。URLを開くだけでは状態を変更しません。

## 表示の軽量化

同期時に `Issues` と `TextRows` を生成します。既存台帳には次回の同期で、書誌・本文と同じ原子的更新内に索引を追加します。手動のReviews・IssueReviewsは更新しません。索引の追加・修復後は再同期しても重複しません。旧バックアップは索引なしでも読み取れ、復元時に再生成します。

通常の配信一覧はIssuesと最新の手動操作履歴だけを取得し、全論文・全掲載履歴・要約は読みません。PMID画面用の書誌・掲載履歴は本人専用GASキャッシュに最大5分保存し、台帳ID・環境・同期版数で分離します。同期版数を前後で確認できた場合だけキャッシュを保存します。状態・メモ・配信確認履歴はキャッシュせず毎回読み、欠落・失効時は実データへ戻ります。本文は詳細を開いた論文／配信に必要な行だけ取得します。

読み込みのタイムアウトと、保存結果を確認できない場合の表示を区別します。読み込みだけで「保存結果は不明」とは表示しません。Google側の一時的な遅延やネットワーク障害時は再読み込みが必要です。
