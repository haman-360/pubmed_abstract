# Workers＋D1 オンラインTEST／ローカル試作

**追加費用0円・既存TEST専用。** Workers＋D1を②オンラインアプリの接続先にする方針を選び、既存TESTへ本人専用Web画面を追加した。通常のローカル試作はMiniflare 4のworkerd／D1 bindingで動作し、Cloudflareアカウント・APIキー・Google認証・OpenAI APIは不要。クラウドTESTには既存FirebaseのGoogle本人認証を使う。架空120件の同期と本人保存・読戻し・再送は確認済み。課金設定・本番GAS・実台帳・既存Pagesは変更していない。本番移行は別作業。

> 2026-11-06反映完了：利用者が既存TESTのコードとmainの定期同期参照を更新し、未確認100配信・824論文の同期と全表読戻しが成功。Macで配信100件の表示、希望PMID34件のTXT出力も確認した。詳細は「未確認キューと希望PMID出力」を参照。

## オンライン版（既存TEST）

### 配信文書から直接開く（2026-11-10クラウド・本人直リンク確認済み）

今後の配信Google Docsは研究台帳の `/api/app/#issue=<配信キー>` へリンクする。PMID別リンクは同じ配信キーに `&pmid=<PMID>` を付け、その配信内の対象論文1件を完全一致で開く。`#pmid=<PMID>` だけの場合は、取り込み済みの新しい配信を探す。未ログインでもリンク先はURLに保持し、本人Googleログイン後に解決する。リンクを開くだけで状態・メモ・確認完了を保存しない。過去のDocsは一括更新しない。

確認済みなどで現在の作業用キューから外れた配信は、保存操作が証明する公開済みデータから閲覧のみで開く。状態・メモは最新の保存値を表示し、過去版への編集・確認完了・再開は許可しない。未公開の転送途中データは参照しない。新しいDB表や索引、同期対象の拡大は不要。まだ取り込まれていない新着や参照可能な履歴がないリンクは、未取得の案内を表示する。

2026-11-10に既存TEST Workerのコード更新・読戻し・本人ログイン後の実PMID表示を確認し、利用者の明示承認後に配信側 [PR #12](https://github.com/haman-360/pubmed_abstract/pull/12) をmainへ統合した（`aa5ba77`）。今後新しく生成されるDocsから切り替わる。定期同期の固定commit、GAS、Access・本人設定、Secretsの変更は不要。旧 `PMID_LEDGER_WEB_URL` Secretは削除せず、今後の配信処理からの参照だけを止める。

[短い実装計画](../ONLINE_APP_PLAN.md)に沿ったMac・iPad向けWebアプリ。既存TEST Workerの `https://<既存TESTホスト>/api/app/` を開き「Googleでログイン」する。同じWorkerの本人APIへ接続し、DBの作り直しや既存Pagesへの追加は行わない。表示するシェルとFirebaseの公開Web設定4項目だけはGET可能で、台帳の取得・保存は毎回サーバーで署名・固定本人UIDを検証する。Worker全体のService Authと `/api/*` の既存経路分離を維持する。

- 新仕様の初期表示は全期間の未確認・確認中。サーバーで内容版が一致する確認済みを除外してから20配信を取得し、返す配信だけ進捗を計算する。配信内は50件ずつ、本文は開いた時だけ。確認完了後は未確認一覧へ戻る。
- PMID・タイトルの部分一致検索、候補評価、詳細本文、3択の状態・メモ、途中保存、保存＋確認完了、配信再開。以前の2つの状態は保持し、メモだけ変更できる。長い本文は画面で先頭12,000文字までを明示して表示する。
- 編集はページをまたいでメモリに保持し、100件までまとめて保存。配信全体で未確認が残る場合は完了ボタンを無効化し、サーバーも同じ条件を再検証する。保存結果不明時は編集を固定し、同じ操作ID・内容を手動再送する。競合・版変更時は内容を控えてから破棄・再取得する。
- token・本文・メモ・結果不明の要求はlocalStorage等へ保存しない。再読み込みやタブ終了で未保存内容が消える。サインアウトで表示・編集を消去し、遅れて返った応答を捨てる。通信が戻っても自動保存しない。Service Worker・オフライン対応は未実装。

Firebaseの承認済みドメインには、利用者の保存時確認を受けて既存TESTホスト1つだけを追加した。既存3ドメイン・provider・Spark・固定本人UIDは維持している。新しいOAuth client・秘密鍵・認証情報の保存は不要。

画面を更新する場合は、0600の職場Mac用Firebase Web設定と固定本人設定を用意し、次を実行する。buildは通信なしで公開Web設定4項目だけをGit対象外bundleへ含め、本人UID・service tokenは含めない。更新用API tokenはターミナルの非表示入力だけで扱う。

```bash
cd pmid_ledger/prototype
npm run build:online-test
python3 deploy_cloud_test.py --update-code-only
```

`npm run build:cloud-test` は従来のAPI専用bundleを生成するため、オンライン画面を保つ更新には `build:online-test` を使う。保存後はコードと既存bindingの読戻しを確認する。公開先はTESTのみで、本番GAS・実台帳・既存Pages・課金設定を変更しない。

クラウドへ接続しない画面試験は `npm run preview:online`、`http://localhost:8790/api/app/`。架空RSA署名と一時DBだけを使い、「画面試験ログイン」で表示できる。直近に表示するためローカルfixtureの配信日だけを今日へ調整する。これはクラウドのfixtureや実Google認証を変更する処理ではなく、本番bundleにも入らない。Ctrl+Cで停止し、一時DBを破棄できる。

2026-11-06の実確認：Macで実Googleログイン・過去月の配信取得・架空PMID 1のメモ保存＋確認完了に成功。利用者のiPad実機でもログインと同月の一覧を表示し、「synthetic-small」の「論文を確認する」からメモ欄を開いて追記・保存できた。Macで再取得してiPad追記を確認し、D1でも120論文・保存操作23・論文履歴23・版数23・配信操作1で一致した。Macはサインアウト済み。Chromeの820px／375px幅では横はみ出しなし・保存バーの画面内固定、ローカルではページ間編集のまとめ保存・配信再開・本文表示制限も確認した。Node.js81件・Python37件が成功。ホーム画面へ追加した状態の独立した実機確認、実データ・実用上限・本番移行・オフラインは別作業。

## 起動

Node.js 22以上、Python 3.9以上が必要。リポジトリのルートから実行する。

```bash
cd pmid_ledger/prototype
npm ci
npm start
```

[ローカル画面](http://127.0.0.1:8787)を開く。初回の`npm ci`は無料の公開npmパッケージを取得する。起動後のWorkerの外向きHTTPは実行環境で拒否する。Wrangler CLIを追加せず、同じローカル実行基盤のMiniflareを直接使う。[MiniflareのD1 binding](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/)

120 PMID・6配信をPythonの既存`Dataset`／`to_tables`で生成する。実台帳、既存成果物、ローカルの認証設定は読まない。初回起動だけ初期化し、編集はGit対象外の`.local-d1/`へ保存する。Ctrl+Cで停止でき、再起動後も保存内容を保持する。試験用DBは別の一時DBで、通常起動用DBを変更しない。

更新前から起動中の場合は、未保存の編集を保存してからCtrl+Cで停止し、`npm start`で再起動してブラウザーを再読み込みする。不足する一覧用投影だけを作成し、保存済みの状態・メモは保持する。

新しいオンライン画面と `listIssues` の既定は全期間の未確認キュー。ローカルの従来診断画面・保守用APIでは明示的な `scope: recent/month/unknown/all` を互換維持するが、現在公開世代の外を自動検索する機能ではない。新しい定期同期は日付ではなく確認状態で取込み対象を選ぶ。

D1の日次無料枠の上限に達した場合は、画面に「24時間後にもう一度アクセスしてください」と表示する。HTTP 429・`Retry-After: 86400`・案内時点の24時間後の`retry_at`を返す。自動再送・有料切替・翌日の自動取得は行わない。D1の実際のリセットはUTC午前0時（日本時間9時）なので、この案内は余裕を持った再アクセス目安であり、アカウント全体の利用状況や復旧を保証しない。容量上限・CPU・SQLエラーを日次上限とは判定しない。[D1料金と日次リセット](https://developers.cloudflare.com/d1/platform/pricing/)

画面の状態は「未確認（初期値）・原本不要・入手希望」の3択。以前の試作で保存した「原文入手済み未読」「読了」は消去・一括変換せず、旧状態の保持を表示する。旧状態のままメモだけ保存でき、状態を変える場合は3択から選ぶ。

画面では配信内の状態・メモを変更し、「途中まで保存」または「保存して確認完了」を押す。100件の配信は50件ずつ表示し、未保存編集はページをまたいで保持する。配信一覧へ戻る／再読み込み時は未保存内容の破棄を確認する。本文ボタンは表示上2000文字までに制限するが、APIの詳細取得は全本文を返す。

## 実装した範囲

- 配信一覧、配信内一覧、候補評価、候補なし配信、詳細本文、画面・APIでの配信内部分文字列検索。同期時に本文を含まない一覧用投影を生成し、SQLで検索・状態絞り込み・50件ページングする。一覧・保存応答では全メタデータJSONや要約全文をWorkerへ取得しない。詳細はSQLで対象掲載履歴・本文だけを返す。
- 最大100件の異なる状態・メモの保存。DB trigger内で全件の期待版数・存在・配信所属を検証する。
- 保存＋確認完了を1つのD1 batchで確定。配信版・掲載内容版・同期版・保存後の未確認0件も同じ処理内で検証し、不成立なら現在値・全履歴・操作ID登録をrollbackする。
- 操作ID＋正規化した要求のSHA-256で重複を防止。同じID・別内容や、別操作の補助IDの流用を拒否する。応答喪失後の再送は再書込せず最新状態を返す。
- 架空メタデータを論理行と最大196,608バイトの転送チャンクへ分割し、未公開世代に保存する。manifest・件数・参照・本文パーツを検証した後、期待する旧世代と照合してpublish。同じチャンクや直後のpublish再送は安全に繰り返せる。後続の別世代を古いpublishで巻き戻さない。手動履歴は世代の外へ保持する。
- 本人役／同期役のローカル仮認証、Origin制限、localhost限定、外向きHTTP拒否。**実際の本人認証の代用にはならない。**

操作要求は現行GASと同じ版数・操作ID等に加え、一覧で返した`revision`を必要とする。`saveAndCompleteIssue`の論文操作IDは`review_operation_id`、完了操作IDは`operation_id`。D1側の内部履歴は1つの原子的な親操作へ関連付ける。履歴の形式と要求ハッシュはGASバックアップの形式とは異なり、そのまま相互復元できるものではない。

## 検証

```bash
npm test
```

ローカルポートの使用を許可した環境で実行する。Miniflareの実D1 bindingとPython HTTP同期に対する65個のテストで、次を確認する。

- 同じPython架空データをGASの既存Node VMへ入れ、6配信の一覧、候補、検索、ページ、本文と、100件保存後の状態・メモ・版を照合する。実行時刻、内部履歴フィールドは比較対象から分離する。
- 100件の最後の1件の競合、101件、不正状態、メモ長、所属外PMID、誤った配信版で追記がない。
- DB batch末尾の強制失敗でtriggerが作った履歴・現在値・操作IDも戻る。
- commit後の503による応答喪失と同じ要求の再送で重複しない。
- 2つの同時保存は一方だけ成功。古い再送は後続のメモ変更・配信再開を上書きしない。
- 0／51／100件編集、全5状態、メモだけ変更時の状態更新日時保持、同期世代公開・再送・競合、内容変更後の再確認、仮認証の分離。
- ランタイムの停止・再起動後も、メモ・操作履歴・再送判定を保持する。
- Python同期の再実行・中断再開・応答喪失・競合・redirect拒否、UTF-8容量制限、診断値の内容、履歴増加時の操作ID検索を確認する。
- 分割転送の欠落・重複・誤った順序、公開前の全件検証、未完了アップロードがあっても起動できること、複数世代・取得中編集の一貫したバックアップ、破損・途中終了した復元を公開しないことを確認する。

2026-11-05に試作Node.js 58件・Python専用7件（Pythonは前回確認）、既存Node.js 54件・Python 69件が成功した。ローカル負荷試験の方法・集計・容量上限は[試験結果](LOAD_TEST_RESULTS.md)を参照。

2026-11-04に統合テスト16件成功。現行GASのNode.jsテスト54件も成功。MacのChromeで820×1180の画面を開き、保存＋完了、再読み込み後のメモ保持、ページ間編集、異なる状態のまとめ保存、横はみ出し・ブラウザーエラーなしを確認した。commit後503の画面試験でも、編集を固定して同じ要求を再送し、論文履歴・完了履歴が各1件に留まることを確認した。今回の3択・初期値・旧状態を保ったメモ保存・検索・バックアップダウンロードもChromeで確認した。iPad実機の確認ではない。

## 本人認証のローカル検証

`npm run test:identity`で、署名JWTによる本人限定判定・同期権限の分離を試験する。[認証検証記録](IDENTITY_VALIDATION.md)に署名判定7件・公開鍵取得／更新7件と残る条件を記録した。joseで署名とclaimsを検証し、workerdでも不正な要求がDBへ届かないことを確認する。秘密鍵とtokenは試験時にメモリ内で作る。公開鍵のHTTP応答も自動試験では架空の応答へ差し替えるため、クラウドアカウントは不要。証明書生成には標準の`/usr/bin/openssl`を使う。esbuildはJWT試験の入口だけをメモリ内でbundleする。

通常の`npm start`と8787番の画面は従来の仮認証のまま。実Googleログイン用の別画面は次の手順で8788番へ起動する。実Access team・クラウドCPUは未確認で、クラウドへ公開する設定は追加していない。

### 実Googleログインの専用試験

利用者がFirebaseの無料Sparkプロジェクト・Google provider・Webアプリを用意した。Web設定はGit対象外の`ledger_private/firebase-web.json`に保存する。公開用Web設定のうち次の4項目だけを使い、Analytics・Hosting・Firestoreは追加しない。

```json
{"firebase":{"apiKey":"<Firebase Web API key>","authDomain":"<project-id>.firebaseapp.com","projectId":"<project-id>","appId":"<Web app ID>"},"ownerUid":null}
```

秘密鍵・Googleパスワード・ID tokenはこのファイルへ入れない。別MacにはGit経由で移らない。設定ファイルは所有者のみ読み書きできる権限にする。

```bash
# pmid_ledger/prototype から
npm run login
```

[専用画面](http://localhost:8788/)で「Googleでログイン」を押す。専用の`.login-d1/`へ架空120件を初期化し、8787番のDBは使わない。サーバーはGoogle公式公開証明書のGETだけを許可し、ブラウザーは公式CDNのFirebase SDK 13.2.0（App/Authのみ）とGoogleログインへ接続する。使わない日の定期通信はない。[公式SDK設定](https://firebase.google.com/docs/web/setup)、[Googleログイン](https://firebase.google.com/docs/auth/web/google-signin)

署名・project・Google provider・期限を確認した後、画面へそのログインのUIDを表示する。**最初の利用者を自動で所有者へ登録しない。** 本人のアカウントであることを確認してから、ローカルの別ターミナルでUIDを固定する。

```bash
node login-local.mjs --owner '<画面で確認した本人UID>'
```

「認証を再確認」でtokenを更新し、本人UID一致後に「架空データを取得して確認」を押す。設定は要求ごとに読み直すため再起動は不要。固定前や別UIDは台帳APIへ入れない。HTTPの自動登録・同期APIは提供しない。架空の配信日は固定なので、直近2か月の結果が0件でも正常。

認証は初期化時から`inMemoryPersistence`とし、tokenをファイル・localStorage・sessionStorage・URL・ログへ保存しない。再読み込み後は再度ログインする。サインアウト直後は表示を消し、遅れて届いた応答も反映しない。これは画面のサインアウトであり、発行済みtokenのサーバー失効まで実装したものではない。[認証の永続化](https://firebase.google.com/docs/auth/web/auth-state-persistence)

実ChromeでSDK読込・初期画面・ログインボタン有効・横はみ出しなしを確認した後、利用者がログインしたアプリ内ブラウザーで実Google署名検証・本人UID固定・実token更新・認証付き一覧取得（空結果）・画面サインアウトを確認した。実tokenによる保存と既発行tokenのサーバー失効は未確認。Firebaseの公開設定APIはHTTP 200で、localhostが承認済み。秘密情報をチャットへ送る必要はない。詳細は[認証検証記録](IDENTITY_VALIDATION.md)を参照。

## クラウドTEST用APIの準備

2026-11-06、利用者がCloudflareへ再ログインした後、管理画面でD1未作成（0/10、表示上の読書き0）とZero Trust初期設定前を確認した。Worker／D1・Accessアプリ・service tokenは作成していない。Workers Freeは前日の実画面確認を引き継ぐ。Zero Trust Freeは公式手順上、支払情報の入力が必要だが課金されないと案内されている。初期設定・契約・支払情報入力は利用者の操作が必要。[公式初期設定](https://developers.cloudflare.com/cloudflare-one/setup/)

同日後続：利用者がZero Trust Freeの初期設定と支払方法登録を完了し、管理画面でもFreeを確認した。利用者が`pmid-ledger-test-sync`（720時間、2026-12-06まで）を発行・保存し、同じトークンだけを対象とするService Authポリシーを作成した。利用者の明示許可後にTEST専用D1と、全通信をこのポリシーで保護した初期Workerを作成した。D1は16テーブル・2トリガー・1ビュー・公開版nullまで照合し、Workerの`DB`へ接続した。認証なしのTEST URLは403。これは台帳APIの実反映・同期・本人保存まで完了したという意味ではない。

`cloud-worker.mjs`は`worker.mjs`とは別のAPI専用入口。共有するD1処理だけを`ledger-api.mjs`へ分離した。本人のFirebase JWTを検証し、同期を明示的に有効にした場合だけAccessの署名済みJWTを検証する。検証前にはDBへ触れない。固定テストtoken、UIDの自動登録、ローカル鍵fixture、HTTPの障害注入コードはbundleへ含めない。通常の8787／8788番の起動方法・DBは従来どおり。

```bash
# 試作ディレクトリで実行。外向き通信・アップロード・deployなし
npm run build:cloud-test
```

生成先はGit対象外の`.cloud-test/worker.mjs`。設定例`cloud-test.wrangler.example.json`は`workers_dev: false`・`preview_urls: false`・ログ収集無効で、DB IDとサブドメインも未設定。Wrangler設定・Wrangler CLIは実運用に使わず、後述の専用Python経路でコードを反映する。専用TESTのDBとWorkerだけを対象にし、既存Pagesへbindingを追加しない。

Cloudflareのコードエディターが再読み込み後も空白だったため、既存のTEST Workerだけへ直接送る`deploy_cloud_test.py`を追加した。通常実行は準備確認だけでHTTPなし。明示的な`--upload`時だけ、実ターミナルでこのWorker専用のAPIトークンを非表示入力する。同期用service tokenとは別の資格情報。新しい認証情報の発行・入力は利用者が行い、値をチャット・コマンド引数・Git・ログへ置かない。

```bash
# リポジトリのルートから。HTTPなし
python3 pmid_ledger/prototype/deploy_cloud_test.py
# 利用者が実ターミナルで実行。Cloudflare TESTだけを更新する
python3 /Users/thama/Documents/GitHub/pubmed_abstract/pmid_ledger/prototype/deploy_cloud_test.py --upload
python3 -m unittest pmid_ledger.prototype.tests.test_deploy_cloud_test -v
```

接続先はGit対象外・0600の`ledger_private/cloud-test-resources.json`（`accountId`・`workerName`・`origin`・`databaseId`）、本人は`cloud-test-owner.json`（`projectId`・`ownerUid`）から読み、対象名を`pmid-ledger-test`へ限定する。ファイルは同じMacだけに残り、Gitでは別Macへ移らない。アップロードは公式Cloudflare APIへmultipartでコード・TESTのD1 binding・本人限定設定を送る。同期は無効のまま。PUT後にコードをGETし、バイト一致を確認してから、tokenを含まない結果を`.cloud-test/deployment-verification.json`（0600）へ保存する。redirect・proxy・自動再送はしない。失敗・応答不明・読戻し不一致は成功扱いしない。料金プラン・Accessポリシー・本番GASのdeploymentは変更しない。[公式アップロードAPI](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)

| 設定 | 条件 |
| --- | --- |
| `DB` | 新規TEST専用のD1。別途`schema.sql`の初期適用が必要。要求ごとの自動migrationなし |
| `LEDGER_TEST_ONLY` | 既存binding名・値 `synthetic` を保持するTEST限定ガード。通常入口は架空専用、実コピーは下記の明示的・少量の別入口だけ |
| `LEDGER_ORIGIN` | 正確な`https://pmid-ledger-test.<subdomain>.workers.dev`だけ。別host、HTTP、query、他Originを拒否 |
| `LEDGER_IDENTITY` | JSON文字列。`projectId`と固定済み`ownerUid`が必須。Gitへ実値を置かず、Workerのsecret設定として渡す |
| `LEDGER_SYNC_ENABLED` | 既定無効。`1`時はidentity設定へ`accessIssuer`・`accessAudience`・`syncClientId`も必要 |
| `LEDGER_TEST_DIAGNOSTICS` | `1`時、認証成功後の応答へD1の読書き行数・呼出し数・経過時間だけを追加。CPU時間ではない |

Accessを用意する場合は`/sync/*`だけを専用Service Authポリシーで保護し、`/api/*`のFirebase認証と混ぜない。Worker全体をAccessで保護すると本人要求にもAccess assertionが付き、この入口は二重の認証ヘッダーを拒否する。workers.dev上でこのパス分離を設定できるかは実設定時の確認項目。成立しなければ同期を無効のまま止め、認証を緩めて進めない。[Accessのパス](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)、[service tokenの接続](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

Pythonの`sync_cloud_test.py`も通常の`sync_local.py`とは別入口。内蔵の架空120件のみで、実台帳やファイル入力・5,000件同期・既存workflowへの接続はない。次はHTTPを使わない確認だけを実行できる。

```bash
# リポジトリのルートから。認証設定不要・HTTPなし
python3 -m pmid_ledger.prototype.sync_cloud_test --inspect
python3 -m unittest pmid_ledger.prototype.tests.test_sync_local pmid_ledger.prototype.tests.test_sync_cloud_test -v
```

クラウド接続は、TEST公開・Access設定後に対象URLを明示し、`LEDGER_TEST_ACCESS_CLIENT_ID`／`LEDGER_TEST_ACCESS_CLIENT_SECRET`をプロセス環境から渡す。実値をコマンド履歴・Git・ログ・チャットへ貼らない。既定の動作は同期状態の読取のみ。`--sync-synthetic`と、管理画面で確認した残枠以内の`--write-budget`（64〜80,000）の両方を指定した時だけ転送する。これは1回の見積予算で、日次累積や他用途の消費を自動管理しない。redirect・proxy・自動再送はなく、429／応答不明では停止する。中断後は残枠を再確認してから同じfixtureで再開する。

2026-11-06職場Macでの実接続：台帳APIのアップロード・コード読戻し一致を確認。既存Worker全体のService Authを残し、TEST本番ホストの`/api/*`だけをホスト名AccessアプリのBypassでWorkerのFirebase本人認証へ委ねた。本人APIは未認証・偽token・二重ヘッダーで`identity_denied`、`/sync/status`・ルート・`/api`境界は既存Accessで403になることを確認。実Access署名付き同期で120件・6配信・141掲載・7チャンクを転送し、全チャンク読戻しが成功。実Google本人認証で架空1件の保存・読戻し・再送、認証の再確認・サインアウトも成功した。プレビューも既存Worker全体の保護対象のまま。CPUの上位集計値には10msを超えるものがあり、無料プラン成立の確定とiPad実機往復は今後の検証。

`workers.dev`はPython標準`urllib`のUser-AgentをCloudflareの`1010`で拒否する場合があるため、同期CLIは自身を`PMIDLedgerTest/1.0`と明示する。実TESTでこの識別子による本人API到達と未認証拒否を確認した。ブラウザーを偽装せず、Browser Integrity Checkも変更しない。403だけでAccess認証の検証成功と判断せず、WorkerのJSONエラーとCloudflare側の拒否を区別する。[公式の1010説明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)

### 職場Mac：既存トークンの非表示入力による同期セッション

`cloud_test_session.py`は既存TESTの同期有効化と、任意の架空120件の転送・全7チャンク読戻しをまとめて実行する。既定はHTTPなしの準備確認。実行には、0600の既存resources／owner設定に加え、Git対象外の`ledger_private/cloud-test-access.json`（既存Accessアプリの`accessIssuer`・`accessAudience`だけ）が必要。同期用Client ID／SecretやWorker更新用APIトークンをこのファイルへ保存しない。

```bash
# リポジトリのルートから。HTTP・資格情報入力なし
python3 pmid_ledger/prototype/cloud_test_session.py
# 利用者の実ターミナルで実行。残枠を確認した後だけ使用
python3 pmid_ledger/prototype/cloud_test_session.py --enable-sync --sync-synthetic --write-budget 10000
```

実行時は既存の同期用Client ID、同期用Client Secret、TEST Worker更新用APIトークンの順に非表示入力する。引数・環境変数・ファイル・ログへ資格情報を置かず、非表示入力が使えなければ停止する。Client SecretはCloudflare Accessへの要求だけに使う。Workerの本人限定secret設定に渡すのは固定本人設定と同期JWTのissuer／AUD／Client IDで、Client Secretは含めない。

コード更新前に本人APIと同期・ルート・パス境界の拒否を確認し、同じ既存TEST Workerへ同期を明示有効化した設定を送る。コードGETのバイト一致と、設定GETのTEST D1 binding・同期有効値・本人設定がsecretであることを照合する。secretの値自体は公式APIでは読めないため、続く同期要求で実Access assertionの署名・AUD・Client ID一致が通ることを確認する。[設定読取API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/)

事前チェックは本文の読取量を制限するが、Cloudflareの拒否HTMLの全体が8KiBを超えること自体は異常と判定しない。本人APIの短いJSON拒否は厳密に照合し、他の経路では403・非JSON・1010でないことを確認する。`test_access_path_separation_not_verified`でトークン入力前に停止した場合、その実行ではWorker更新・同期転送はまだ行われていない。

転送前に既存公開データが未公開または同じ固定fixtureであることを確認し、別の内容があれば上書きせず停止する。転送は既存の予算内・中断再開・公開処理を使い、公開後は7チャンクの内容を固定fixtureと照合し、最後に認証経路を再確認する。redirect・proxy・自動再送・TEST作成・Accessポリシー変更・本番接続は行わない。`--enable-sync`だけなら有効化後の署名付きstatus読取までで、データ転送はしない。

結果はGit対象外`.cloud-test/deployment-verification.json`と`sync-verification.json`へ0600で保存する。新しい更新試行前にセッション結果を未検証へ戻し、古い成功記録を今回の成功と取り違えない。`full_readback_verified: true`は全チャンク一致、`paused: true`は未公開の予算内中断であり成功扱いしない。`wall_seconds`は更新開始から同期・読戻しまでの経過時間で、CPU時間ではない。書込予算は1回の見積上限で、日次累積や管理画面の反映遅延を自動管理しない。失敗・応答不明・429では止め、再実行前に残枠と結果を確認する。

既に同期有効設定のコード・binding読戻しを検証できたWorkerには、`--use-existing-worker`で再アップロードせず接続できる。ローカルの検証結果とbundleハッシュが一致することを確認してから、同期用Client ID／Secretの2つだけを非表示入力する。更新用APIトークンは求めず、`--enable-sync`とは同時指定できない。

```bash
# status読取のみ。Worker更新・メタデータ転送なし
python3 pmid_ledger/prototype/cloud_test_session.py --use-existing-worker
# 読取診断後、残枠と結果を確認してから架空120件を転送する場合
python3 pmid_ledger/prototype/cloud_test_session.py --use-existing-worker --sync-synthetic --write-budget 10000
```

読取だけの結果は`.cloud-test/sync-diagnostic.json`へ0600で保存する。HTTPエラー時はステータス・固定分類（`worker_identity_denied`、`worker_configuration_invalid`、`access_or_edge`、`cloudflare_1010`、`other_json`、`unknown`）・失敗action・要求数だけを追加し、応答本文・ヘッダー・資格情報を出力しない。分類は403の発生箇所を切り分ける手掛かりで、署名拒否の詳細原因を特定した証拠ではない。認証条件の緩和や自動再送は行わない。

### Google本人認証でクラウドTESTの保存を確認する

職場Macでは既存Firebaseの公開Web設定と固定済み本人UIDを`ledger_private/firebase-web.json`へ0600で復元済み。新しいFirebaseプロジェクト・サービスアカウント秘密鍵・API tokenは不要。resources／owner設定とのproject・UID一致、および架空120件の全チャンク読戻し記録が起動条件になる。

```bash
cd pmid_ledger/prototype
npm run login:cloud-test
```

同じMacの`http://localhost:8789/`でGoogleログインする。通常の8787／8788番や保存DBは変更せず、8789番はlocalhost限定・永続化しない一時DBで起動し、台帳の操作先だけを既存のクラウドTESTへ限定する。ローカルとクラウドの両方で署名・発行元・期限・固定本人UIDを検証する。最初のログイン者を登録せず、別UIDや同期経路を許可しない。認証情報はメモリだけで扱い、ページ再読込やサインアウトで消去する。

「架空論文1件で保存を確認」は固定fixtureのPMID 1を入手希望にし、固定のテスト用メモを保存する。同じ操作IDを再送して履歴を増やさず、版数・状態・メモを読み戻し、本文取得も確かめる。応答不明時は同じ画面で同じ操作を再確認でき、自動再送はしない。proxyは4つの本人API・固定の配信／論文／メモだけを許可し、他の論文・任意メモ・他host・redirect・同期・登録経路は拒否する。通常のローカル仮認証へ置き換えてクラウドへ送る処理はない。

初回の実試験ではクラウドの6配信取得、保存＋読戻し＋再送＋本文取得が成功し、D1の保存操作1・論文履歴1・版数1を確認した。画面の確認全体は2.78秒（1回、CPU時間やGASとの同条件比較ではない）。認証の強制更新後の取得とサインアウトも確認済み。後続の速度試験で同じ架空1件に20件保存し、その時点の保存操作・履歴・版数は各21。8789番の画面はMac内の検証専用で、直接利用できるオンライン版とiPad実機の後続確認は冒頭の節を参照する。

同じ画面の「操作別の速度を測る」は、配信一覧・固定100件配信の先頭50件・架空PMID 1の詳細・同1件保存を各10回、逐次実行する。保存は毎回新しい操作IDで、同じ論文に10件のテスト履歴を追加し、最後に状態・メモを読み戻す。表示するのは時刻・所要時間・D1カウンターだけで、token・UID・本文は計測結果へ含めない。最初の1回も集計に含み、キャッシュ消去やランダム化したAB比較は行わない。初回値・中央値・p95（10回では最大値）を表示する。通信失敗時は停止し、自動再送しない。保存確認中の結果不明操作がある場合は、先にその同じ操作を確認するか、サインアウトしてから計測をやり直す。

「CPU観測用の読取」は固定詳細だけを30秒以内・最大80要求まで逐次取得し、保存は行わない。実CPUはCloudflareのMetricsで確認する。レスポンスの`worker_wall_ms`やブラウザーの所要時間はCPU時間ではない。クラウドのプロファイル採取が失敗した場合も、認証条件の緩和・ログの永続保存・有料化は行わない。

同期を有効化済みの既存TESTでコードだけを更新する場合は、次を使用する。Worker更新用API tokenだけを非表示入力し、既存の本人UID・同期認証・DB設定は再入力しない。処理前後に固定TEST D1・設定の種類と値を照合し、[公式`keep_bindings`](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)で既存bindingを継承する。コードも読戻して一致を確認する。旧`--upload`は同期を無効化する初回用なので、今回の更新には使用しない。

```bash
python3 pmid_ledger/prototype/deploy_cloud_test.py --update-code-only
```

これは既存TEST Workerだけの更新で、D1の作り直し・本番GAS・実台帳・既存Pages・課金設定の変更は行わない。標準出力と0600のGit対象外`deployment-verification.json`に読戻し結果を出す。既存bindingの照合に失敗した場合はPUT前に停止し、更新後の不一致や通信結果不明でも自動再送しない。非表示入力できない端末では停止する。

2026-11-06の軽量化では配信一覧を1つのSQL snapshotへまとめ、世代・件数・ページを同時に確定する。本文も固定世代の掲載・本文パーツをまとめて取得する。実TESTのD1往復は一覧4→1回・詳細4→2回となった。各10回の中央値は一覧712.8→370.0ms、論文一覧360.35→360.05ms、詳細788.2→535.4ms、1件保存507.8→485.15ms。新バージョンだけのMetricsは43要求・CPU P50表示2.23ms／P90 4.00ms／P99 8.18ms、CPU制限停止0件。小規模・別時刻の比較で、全件のCPU適合やGASに対する改善率は保証しない。[条件とCPU測定の限界](FREE_PLAN_READINESS.md#2026-11-06-jsttestの軽量化と変更前後の比較)を参照。通常表示の直近2か月は維持し、同期対象の切詰めや認証の省略は加えていない。

クラウドAPI準備時はNode.js 65件とPython専用13件が成功し、公開鍵を架空応答に差し替えたworkerd＋一時D1で権限分離と保存を確認した。その後、実Access同期・実Google本人保存・CPU比較を経て②へ進んだ。現在のNode.js81件・Python37件、iPad実機往復と方式選択は冒頭のオンライン版の節を参照する。長期・実用規模の無料適合と本番移行は別判断。

## Python同期と負荷試験

以下はリポジトリのルートから実行する。起動中のローカル試作へ自動生成した架空データだけを送る。実データの同期や既存の毎時workflowへの接続は行わない。

```bash
python3 -m pmid_ledger.prototype.sync_local
# 架空の訂正版を同期
python3 -m pmid_ledger.prototype.sync_local --revised
# 大きいfixtureのサイズだけ確認（HTTPなし）
python3 -m pmid_ledger.prototype.sync_local --scale --inspect
python3 -m unittest pmid_ledger.prototype.tests.test_sync_local -v
```

`--base-url http://127.0.0.1:<port>`で別ポートを使える。外部ホスト・proxy・redirectは使えない。手動のレビュー表は対象に含めず、既存のメタデータを世代固定のチャンクで取得し、和集合を分割転送して検証後にpublishし、読み戻す。変更なしは状態取得1回だけ。中断確認用の`--stop-after-stage`では公開版を変えず、通常コマンドの再実行で再開する。既定の見積書込予算は1回8万行で、超える前に`paused: true`で止まる。転送済みチャンクは再送しない。これはローカルの1回分の予算であり、アカウントの日次枠を管理する機能ではない。5,000件は3回の中断・再開で完成する。

負荷試験は試作ディレクトリから実行する。

```bash
npm run benchmark
```

起動中の試作は使わず、新しい一時D1と自動割当ポートを使う。120／500／1,000／5,000件の各操作を30回測定し、5,000件側は5万行の架空履歴を追加して再測定する。分割バックアップ→別DB復元→再出力ハッシュ一致と同一操作の再送も確認する。出力はGit対象外の`.benchmarks/`。`npm run benchmark -- --quick`は試験スクリプト確認用の短縮実行で、本計測とは区別する。

無料枠向けの読書き量・中断再開・容量は`npm run preflight`で再現できる。[無料プラン成立性](FREE_PLAN_READINESS.md)に実測・本人認証の条件・残る課題を記録した。負荷試験では3枠を連続実行して再開を検証するが、クラウドの日次枠へ収まる実行時刻を自動管理するものではない。

診断はローカルの`X-Local-Profile: 1`指定時だけ有効。正常応答の`profile`に数値カウンターと時間を返す。`database_calls`はbatchを1回と数え、`database_bytes_max`はローカルD1の`size_after`の最大値。実クラウドのCPU時間や料金を示すものではなく、通常画面は指定しない。

## バックアップ・別DBへの復元

画面の「JSONバックアップ」は、完了済みメタデータ全世代・両操作履歴・再送判定IDをページ単位で取得し、NDJSON（1行ずつJSON、`.ndjson`）へ出力する。開始時の世代と操作境界を固定するため取得中も編集でき、開始後の保存・未保存編集・未完了アップロードは含めない。状態・メモ・一覧投影は復元時に再構築する。各ページと全体のSHA-256を確認し、GASのバックアップとは別形式のローカル試作用ファイルとして扱う。

起動中の試作から、コマンドでも取得できる。

```bash
node backup.mjs export
```

出力先はGit対象外の`.backups/`で、既存ファイルを上書きせず、ファイル権限は0600。画面からダウンロードしたNDJSONと、以前の小さいV1 JSONも復元に使える。

```bash
node backup.mjs restore /absolute/path/to/backup.ndjson
```

復元は毎回`.restored-d1/`配下の新しいDBへ行い、通常の`.local-d1/`を上書きしない。ページの読み戻し、全体チェックサム、世代の件数・参照、履歴の連続版数、操作と履歴の対応を検証し、現在値を最終履歴から再構築して最後に公開する。分割復元の途中失敗は公開せず、CLIが新規作成した不完全な復元先だけを削除する。SQLや認証設定はバックアップから実行・読み込みしない。

復元成功時に表示される`node local.mjs --restored <database-id>`で起動する。8787番ポートを使うため、通常の試作を停止してから実行する。元のDBはそのまま残る。バックアップ・復元先フォルダーをGitへ追加しない。

## API（ローカル専用）

POST JSON。閲覧・保存は`Authorization: Bearer local-synthetic-owner`、同期は`Bearer local-synthetic-sync`。これらは固定のテスト文字列で、秘密情報ではない。

| パス | 用途 |
| --- | --- |
| `/api/listIssues` | 既定`scope: pending`で全期間の未確認・確認中。`offset`で20件ずつ。比較・保守用の`recent/month/unknown/all`は明示指定で互換維持 |
| `/api/wantedPmids` | 本人専用。全期間の保存済み入手希望を500件ずつ。`after`と操作cutoffで一貫性を検証。PMIDのみで本文・メモなし |
| `/sync/queueState` | 同期役専用。現在の配信状態・内容版、保存済みPMIDの存在だけを500件ずつ。本文・メモ・全履歴なし |
| `/api/listIssuePapers` | `issue_key`、任意の`offset`／`query`／`status` |
| `/api/getPaperDetail` | `pmid`、任意の`issue_key` |
| `/api/backup` | 旧互換・小容量だけの一括JSON（大容量は分割経路を指定して拒否） |
| `/api/backupStart` | 完了世代と操作境界・件数を固定 |
| `/api/backupPage` | 固定境界の元データをページ取得 |
| `/api/saveReviews` | 論文の途中保存 |
| `/api/saveAndCompleteIssue` | 編集保存＋配信完了 |
| `/api/saveIssueReview` | 配信状態の更新／再開 |
| `/sync/status` | 公開中の版・manifest（旧形式では表）。手動レビューを含めない |
| `/sync/begin` | manifestを未公開世代へ登録 |
| `/sync/chunk` | ハッシュ付きチャンク保存・読み戻し |
| `/sync/build` | 5配信ずつ一覧用投影を構築 |
| `/sync/finish` | 全体の件数・参照を検証し公開可能にする |
| `/sync/read` | 固定世代の検証済みチャンクを取得 |
| `/sync/stage` | 小さい旧形式の互換経路（全体1,900,000バイト以下） |
| `/sync/publish` | `generation`と`expected_revision`（初回はnull）で公開 |

テスト時だけ、保存要求の`X-Local-Fault: rollback`はbatch末尾で失敗を注入し、`drop-response`はcommit後に503を返す。通常の画面は指定しない。同期入力はメタデータ表だけを許可し、Reviews／IssueReviewsを受け付けない。

## 限界と次の作業

これは保存契約の成立性を試す初段階。現行機能の全面移植・本番用バックエンドではない。

- 一覧は本文なし投影をSQLで検索する。5,000件・5万行履歴のローカル試験と別DB復元まで成功したが、実際のクラウド読取量・CPU評価は未実施で、無料枠適合の証拠にはしない。
- 分割前の約16.8MBを小さな論理行として保存できた。表示期間の制限は通常の読取を減らすもので、全件の初期同期・バックアップを省略する機能ではない。1論理行180,000バイト、1転送チャンク196,608バイト、1配信用一覧投影196,608バイトの上限を設けるため、件数だけで扱える範囲は決まらない。世代の無期限蓄積・自動削除・実データ移行は未実装。
- 通常PMID台帳、分野・状態など残る絞り込みと並び順、CSV、GASバックアップとの相互変換は未実装。希望PMIDのTXTは新しいMac用 `.command` で出力できる。ローカルD1用の分割NDJSONバックアップ・空DB復元と旧V1 JSON互換は実装・検証済み。
- Firebase形式／Access形式の署名JWTと実Firebaseログインのローカル検証は実装した。Service Authの外部接続、ネイティブログイン、FreeプランのCPU・保存容量・要求上限、クラウド往復・失敗率は未検証。ローカルの経過秒数をGAS本番との改善率に換算しない。
- クラウドTEST用API・非公開が既定の設定例・架空データ専用同期を準備した。利用者の許可後に認証付き初期WorkerとD1を作成し、接続情報はGit対象外へ保存した。TEST専用のコード反映CLIを追加したが、実tokenや実接続IDはGitへ置かない。追加費用0円を維持し、認証とコード反映を確認してからクラウド実測へ進む。FirestoreのRules成立性の比較は別の作業。


## 実データの少量コピー試験（本番への書戻しなし）

2026-11-06、利用者が既存TESTのバックアップ後、直近2か月の実データの一部をコピーすることを指示した。Google Driveの読取機能だけで実台帳から11月3日の3配信・30論文を取得し、Git対象外・0600の `ledger_private/real-trial/source.json` に保存した。本文・評価・AIメモ・現在の確認状態を含む。選択範囲の手動メモは空。元台帳の全履歴やGoogle認証設定は移行しない。公開される静的アプリに実データは含めない。

事前バックアップ（244,734バイト）の別DB復元・再出力chain一致を確認後、利用者の非表示入力で既存Workerだけを更新し、30論文・3配信の実コピー世代を公開した。34要求で公開前後の7表全件読戻しが一致。既存6binding・認証・同期設定と旧架空世代を保持する。本人APIで現在の確認状態30件・3配信の完了状態を反映・読戻し確認済み。Macで一覧・評価・AIメモ・手動メモ欄を確認し、先頭論文のTEST確認用メモを保存・再取得して一致した。iPad実機からも同じ3配信とメモを利用者が確認した。コピー後の追加バックアップ（354,742バイト、2世代）も別DB復元・chain一致を確認済み。データと記録は全てGit対象外0600で保管。自動同期・本番移行・オフライン化は含めない。

手順（リポジトリのルートから実行）:

1. `python3 -m pmid_ledger.prototype.prepare_real_trial` で読取済みデータから専用planを一度だけ生成する。既存planは上書きしない。配信全体を保持し、最大3配信・50論文、直近2か月、1回10,000書込の見積上限を確認する。今回のメタデータ・状態取込みの見積は保守的に1,802書込。日次残枠を保証するものではない。上限エラー時は停止し、課金・自動再送は行わない。
2. `node pmid_ledger/prototype/trial-maintenance.mjs` でlocalhost:8791を開き、Google本人認証後「既存TESTをバックアップ・復元検証」。Workerの本人APIから全ての完了世代・操作・履歴をページ取得し、hashと件数を確認する。別の一時ローカルD1へ復元し、再出力のchain一致を確認して初めて `backup-receipt.json` を保存する。UUID付きNDJSONは上書きしない。既存TESTのD1やWorkerは作り直さない。
3. `npm --prefix pmid_ledger/prototype run build:online-test` 後、`python3 pmid_ledger/prototype/real_trial_session.py --update-and-publish`。Worker専用更新API token、同期用Client ID（末尾.access）、同期用Secretを順に非表示入力する。値は保存・ログ出力しない。旧bundleはprivateに退避し、既存6binding・認証・同期を維持してコード読戻し後に転送する。
4. 実コピーはmanifestの `data_source: real-copy` と明示的な `real_copy: true` の組だけを受け付ける。既存メタデータとマージせず、別の不変世代へ保存する。旧TESTとPMID／配信キーが重複した場合は拒否する。全7表を公開前・公開後に読戻し比較し、バックアップ時の世代と操作cutoffをatomicに照合して切り替える。途中で他画面が保存したら切替を拒否し、新しいバックアップから再確認する。元の架空世代と手動履歴は保持する。通常の架空syncから実コピーへのマージは禁止。
5. 保守画面の「コピーした確認状態を反映・読戻し」で、選択範囲の現在状態／手動メモと配信の確認状態をTEST専用の新操作IDで反映する。旧操作ID・版数・更新時刻・全履歴は引き継がず、TESTで版1から開始する。同じplanの再実行は同じ操作を再送する。Mac・iPadは同じ既存オンラインURLで「TEST · 実データのコピー」、直近2か月の一覧、本文・AIメモ・手動メモ欄を確認できる。
6. 終了時はサインアウトし、8791の保守サーバーを停止する。切戻しが必要なら、先に現在のコピー側を再バックアップ・復元検証し、`python3 pmid_ledger/prototype/real_trial_session.py --rollback` を実行する。最初のバックアップ参照はplanの `baseline_backup`、元世代は `baseline_revision` に保持する。現在の操作cutoffを照合し、表示対象だけを元世代に戻す。TEST側の新しい履歴も削除しない。元台帳への反映経路はない。

保守画面はlocalhost固定・Host/Origin検証・署名済Google本人UID一致が必須。tokenはリクエスト中のメモリ内のみ。原本のバックアップ、実コピー、plan、検証記録、復旧bundleは全てGit対象外のprivate内に置く。バックアップ後に実コピーを含む場合は `synthetic: false, test_only: true` と明示し、従来の架空バックアップも復元できる。新しいクラウド資源・課金設定・Access・Firebase設定・GAS・Pages・既存配信workflowは変更しない。

今回の対象は「読み忘れ候補」3分冊。この配信種別の元データにはAI評価30件と配信文書リンク30件がある一方、`summary_ja` は空である。画面でも本文未登録を表示し、「配信文書を開く」への導線を保持する。本文の補完・AI生成は行わない。確認用の手動メモはTEST側の先頭論文だけに追加し、元台帳へ書き戻していない。確認後は保守画面をサインアウトし、8791サーバーを終了。オンライン台帳のMacタブは利用用に残す。

## 直近2か月全件の定期同期

3配信の少量試験から、配信日が直近2か月に入る全配信へ広げる実装を追加した。2026-11-06の対象は70配信・486論文・537掲載。既存TESTへ全件反映・全表読戻しが成功し、Macで全70配信の4ページと既存メモ保持・通常配信の本文要約を確認、iPadでも70配信の表示を利用者が確認済み。実台帳を読取だけで参照し、Google Drive versionが読取中に変われば停止する。既存の土曜05:00 JSTの配信と毎時の実台帳更新は変更しない。

`recent_sync.py` の専用経路でTESTへ不変世代を追加し、全7表の公開前後の読戻し後に切り替える。既存TESTのメモ・確認状態・履歴は保持し、元台帳の状態はTESTに状態がない論文／配信だけ初期化する。初回移行は復元検証済みbackupが必須。定期更新時は本人の同時保存を保持し、古い画面の未保存編集には再取得を求める。実台帳への書戻し・原本の変更は行わない。同一メタデータなら新世代やメタデータ書込を増やさない。

上限は500配信・5,000論文・1回30,000見積書込、保存済みメタデータと今回入力を合わせ64MB。今回は18,953見積書込・46チャンク。過去の履歴や世代を勝手に削除せず、無料枠・安全上限・資格情報の期限・通信エラーでは停止する。既存の同期用資格情報の期限は延長しない。これらの上限はアカウント全体の無料残枠を保証するものではない。

定期実行は独立した `pmid-ledger-test.yml` を毎日12:23／21:23 JST（UTC 03:23／12:23）に設定する。実際の起動にはGitHub側の遅延があり、配信完了後に実台帳へ載ったデータを次回実行で取得する。`main` にはこの新しいworkflowだけを追加し、取得するコードは検証済みcommitへ固定する。既存workflowや本番コードをまとめてmergeしない。新しいTEST有効化変数がtrueになるまではjobを起動しない。

導入用CLIは `python3 pmid_ledger/prototype/recent_sync.py --update-and-sync --configure-actions`。2026-11-06に利用者が非表示入力で実行し、70配信・486論文・537掲載の初回同期172要求と、GitHub設定・初回手動Actionsを完了した。更新用API token、同期用Client ID、同じSecretを非表示入力する。更新用API tokenは保存しない。同期用2値だけをGitHub公開鍵で暗号化して `PMID_TEST_ACCESS_CLIENT_ID`／`PMID_TEST_ACCESS_CLIENT_SECRET` に登録し、既存 `GOOGLE_AUTHORIZED_USER_JSON`／`PMID_LEDGER_SHEET_ID` はそのまま参照する。TEST専用有効化変数を設定し、手動の初回Actionsも要求する。GitHubの既存認証はGit credential helper経由でメモリ内だけに取り込み、チャット・ログ・ファイルへ出力しない。

公開repoの標準Ubuntu runnerだけを許可し、private化されるとjobを停止する。大きなrunner、Actions artifact、Actions cache、AI APIを使わない。[GitHubの標準runner料金](https://docs.github.com/en/billing/concepts/product-billing/github-actions)、[scheduleの条件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)、[D1無料枠](https://developers.cloudflare.com/d1/platform/pricing/)を確認した。課金設定は変更しない。


2026-11-06の実稼働確認：TEST専用変数はtrue。既存の配信・実台帳更新の有効化変数もtrueを保持。[初回Actions](https://github.com/haman-360/pubmed_abstract/actions/runs/42176210755) は成功し、既存Google認証で原本を読み取って同じ70配信・486論文を確認した。追加16要求でメタデータ・状態とも変更なし、新世代や重複状態を作らなかった。未認証の本人API・recentStatus・seedReviewsは全て403。全件同期後のバックアップも別DB復元・chain一致に成功（3世代・129操作・144論文履歴・15配信履歴）。元の試験世代と手動履歴を保持している。

同期範囲は常に配信日で直近2か月。範囲外の配信は新しい公開世代へ含めず、画面の過去月指定も現在公開世代の中だけを表示する。保存済みメモ・状態・過去世代は削除しない。原本への書戻し、古い世代を横断する閲覧、ホーム画面での独立起動確認、オフライン対応は別作業。

## Dock／ホーム画面から使うオンラインアプリ

既存TESTの同じ `/api/app/` を端末へ追加する。manifestのstandalone指定に加え、PNGアイコン・Apple touch icon・安定idを整備し、画面末尾に追加手順と起動モードを表示する。2026-11-06に既存TESTへ反映し、Macの独立ウィンドウとiPadのホーム画面アイコンからの起動で、Googleログイン後の「配信70」「アプリで起動中」を確認済み。Macは「研究台帳 TEST」としてDockへ追加し、終了後の再起動でも独立ウィンドウのログイン画面を確認した。

- **Mac（macOS Sonoma 14以降）**：Safariでオンライン台帳を開き、「ファイル」→「Dockに追加」。名前は「研究台帳 TEST」。追加後はDockまたはSpotlightから起動する。
- **iPad**：Safariでオンライン台帳を開き、共有→「ホーム画面に追加」。「Webアプリとして開く」があればオンにして追加し、ホーム画面のアイコンから起動する。
- 追加したアプリ内でGoogle本人ログインする。画面末尾の「アプリで起動中」で確認できる。メモはサーバーへ保存してから終了する。従来のメモリ内認証を維持するため、終了・再起動後は再ログインが必要。

SafariのWebアプリ機能を使うためApp Store申請や新しいクラウド資源は不要。オフライン・通知・認証の永続保存は追加していない。[AppleのMac手順](https://support.apple.com/ja-jp/104996)、[WebKitのホーム画面Webアプリ仕様](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)を参照。

アイコンの再生成は `python3 pmid_ledger/prototype/build-app-icons.py`。Pillow 11.3.0が必要で、このMacではprivateのvendor領域へ配置した。既存SVGと同じ図案の座標を描画し、OSに角を処理させる不透明RGBのPNGを出力する。通常のbundle生成はGit管理済みPNGを読むだけで、Pillowを必要としない。

### 配信の状態表示とアプリ内ログインの再試行

配信のバッヂは、未確認を橙色の「○」、確認中を青色の「◐」、確認済みを濃緑色の「✓」で表示する。右上のTESTバッヂは削除し、データ種別・元台帳へ書き戻さないこと・オンライン専用という案内は、下部の「この台帳について」にまとめた。接続先は従来の既存TESTのまま。

2026-11-06 18:36 JST、利用者のcode-only更新が成功し、コード・既存bindingの読戻しと公開HTML／CSS／JSの完全一致を確認した。既に開いている画面は再読込みすると更新される。以下の初回認証エラーは、再試行の補助を反映した段階で、根本解消は未確認。

Mac・iPadのSafariから追加したアプリでは、Googleログイン初回にFirebase側が「missing initial state」を表示し、2回目は成功するとの利用者報告がある。これは認証ヘルパーの一時状態を読み出せないという表示で、台帳データの欠落を意味しない。既にFirebaseのポップアップ方式を使用しているため、単純なredirectへの切替は行わない。[Firebase公式のブラウザー保存領域の制約と対処](https://firebase.google.com/docs/auth/web/redirect-best-practices)を確認したが、今回の実機での根本原因は未確定。

エラーが出たログイン画面を閉じ、元の台帳からもう一度Googleログインできる。ボタンが押せない場合は、ログイン画面の「ログイン画面でエラーが出るとき」内の「ログイン画面を開き直す」でページを再初期化する。このボタンは未ログイン時だけ有効で、認証済みの編集や結果不明保存を破棄する用途には使えない。自動再試行・端末保存・Google／Access設定変更は追加しない。ログイン中の一時的な未ログイン通知で二重ポップアップを開かない制御と、認証完了直後の台帳読込み中に操作制限を解除しない修正も含む。これらは操作競合の防止・復帰補助であり、Firebase側の初回エラーの根本解消とは区別する。

`deploy_cloud_test.py --update-code-only` は、設定に加えて既存コードを先にGETする。同じコードならPUTを省略し、コード・設定の再読戻し一致で `already_current: true, uploaded: false` を返す。更新中のHTTPエラーには `stage` と `write_attempted` を付ける。`read_existing_settings`／`read_existing_code` かつ `write_attempted: false` ならコード更新前で停止。`upload_code`／`readback_code`／`readback_settings` かつ `write_attempted: true` なら更新が反映された可能性があり、成功とは扱わない。PUTの自動再送は行わず、利用者が同じコマンドを再実行した際にコードを改めて照合する。エラー本文・資格情報・接続IDは表示しない。


## 未確認キューと希望PMID出力（2026-11-06反映済み）

### ふだんの確認と過去分

オンライン画面は「未確認・確認中（全期間）」だけを新しい順に20配信ずつ取得する。確認済み配信を取得して画面で隠す処理ではなく、SQLで先に除外する。内容版が変わった確認済みは確認中として戻る。確認完了を保存すると一覧へ戻り、その配信の論文を自動再取得しない。配信を完了してもPMIDの入手希望・手動メモは保持する。

同期も固定2か月から未確認キューへ変更する。クラウドの現在状態を優先し、未登録の配信だけ元台帳の完了状態を参照する。日付不明・過去の配信も対象。1回の作業用キューは最大100配信・配信所属のユニークPMID最大1,000件を新しい順に選ぶ。書込見積30,000件を超える場合は配信単位でさらに縮める。先の古い未確認は完了扱いにせず、確認が進んだ次回同期で補充する。待機分があれば画面にその旨を表示する。新着も定期同期後に追加される。同期時刻は従来の毎日12:23／21:23 JSTのまま。

元台帳の軽い書誌・掲載・状態・本文索引を先に読み、選んだ未確認配信に必要な `Texts` の行範囲だけ取得する。確認済み配信だけの本文は読み込まない。元台帳の入手希望・入手済み・読了・メモありPMIDは、配信本文を含めず書誌と現在状態を引き継ぐ。クラウドに既存状態があれば元台帳で上書きしない。以前取り込んだ本文・手動履歴・過去世代は削除しない。

これは差分行だけを書き換える同期への全面移行ではない。未確認の作業用データが変わった場合は、上限内の不変世代を作成・全表読戻し検証する。同じメタデータなら世代やメタデータ書込は増やさないが、未確認分の元本文読取は行う。保存済み状態の書誌を含む5,000 PMID・保存64MB・元台帳の20MB読取など既存の停止ガードは継続する。保存容量・履歴の増加や無料枠全体を無制限に保証する仕組みではない。

### Macから希望PMIDを出力

リポジトリ直下の **`希望PMIDを出力.command`** をダブルクリックする。

1. ブラウザーで開く `http://localhost:8792/` に、台帳と同じGoogleアカウントでログインする。
2. 「希望PMIDをTXTへ保存」を押す。
3. `ledger_private/exports/pmids-日時-識別子.txt` を原本取得プログラムに渡す。保存後は出力フォルダが開き、ターミナルにも保存先を表示する。

TXTはUTF-8・BOMなし・数字のみ1行1件・数値順・重複なし。確認済み・現在公開世代の範囲外の入手希望も、保存済み現在状態から出力する。未保存の選択は対象外。0件なら空TXTを作る。日時付きファイルを0600で新規作成し、既存TXTを上書きしない。出力だけで入手済みにはしない。本文・メモは取得せず、端末に認証tokenを保存しない。PMIDだけの出力なのでメモの別ファイルは作らず、メモは台帳に保持する。

実行にはNode.js 22以降と `pmid_ledger/prototype` の `npm ci`、既存の0600ローカルFirebase／本人／TEST接続設定が必要。APIキー・同期用Secretの入力は不要で、Google本人認証を使う。8792番はこの処理だけに使用し、完了時または15分後に待受を終了する。出力途中に別端末の保存・同期による状態追加があれば、一貫性が失われるため出力を中断し、TXTは作らない。接続断で保存結果が不明な場合はターミナルと出力先を確認する。

### 検証結果

Node全92件・Python全50件成功。5,000論文・200配信のうち199配信を確認済みにしたローカルD1試験では、一覧は1配信のみ、DB問い合わせ1回・読取1,017行。旧配信の補充・空キュー・保存済みメモと希望の保持・backup復元・501件の出力ページング・出力中の状態変更拒否も確認した。Mac出力のローカルHTTP画面・不正認証／Origin拒否も確認済み。

2026-11-06 19:43:58 JST、利用者が既存TESTコードを更新し、177,728バイト・SHA-256 `f6ee019ac3385c3d0c1ac975c9645c2789a66d23fa20f5b1efd6c24b337018f3` の読戻しと既存binding保持が成功。公開HTML／JSも準備ファイルと完全一致した。利用者がmainのTEST同期参照を固定コードcommitへ変更し、19:46:35 JSTに[手動同期](https://github.com/haman-360/pubmed_abstract/actions/runs/42205233733)を実行。19:51:45 JSTに全step成功し、100配信・824論文・1,220掲載を271要求で取り込み、公開前後の全表読戻し一致・元台帳への書込なしを確認した。古い未確認28配信は次回以降の補充待ち。利用者がMacのアプリ再読込みで配信100件を確認した。

続いて利用者がMac用 `.command` でTXTを出力し、生成ファイルを共有した。34件・299バイトで、数字のみ1行1件・重複なし・数値順・UTF-8/BOMなし・末尾改行・0600を直接検証した。実Google本人認証からクラウドの希望PMIDを取得してMacへ保存する経路まで確認できた。PMID本文やメモ・認証情報はGitへ保存しない。今回の新仕様についてiPad実機での再確認、実運用での完了後の次回補充、クラウドCPUの継続測定は未実施。

### 利用者による反映手順

以下の手順は2026-11-06に利用者の手動操作で完了した。エージェントはdeployを実行せず、結果の読取確認だけを行った。再反映時も順序は次の通り。

1. `npm run build:online-test` で準備済みbundleを確認し、利用者が従来の `python3 deploy_cloud_test.py --update-code-only` で既存TESTだけを更新する。新規DBやスキーマ変更は不要。
2. mainの `.github/workflows/pmid-ledger-test.yml` に、固定コードcommit `dd7e0c1f6f8248337d3e1fb5b5f9459ae474e1c7` へのcheckout参照を反映する。利用者がmain commit `a9a2ff71cabae9354fe2e6b60ae90fd2a655a229` でrefの1行を更新済み。作業branchの控えもmainの実設定に一致させた。既存スケジュール・workflow名・有効化変数・Secretsは保持。**コード反映より先にworkflowを切り替えない。**
3. TEST同期workflowを手動実行するか次回定期実行を待つ。成功後、アプリを再読み込みし、過去の未確認が表示されることと保存済みメモを確認する。
4. Mac用 `.command` で希望PMIDを出力する。

手動で先に1回同期する場合は、リポジトリ直下から `python3 -m pmid_ledger.prototype.recent_sync --sync --sheet-id <元台帳ID>`。既存Google資格情報の0600ファイルを読み取り、同期用Client ID／Secretだけをターミナルで非表示入力する。チャットへ貼らない。元台帳はGETのみで、GAS・本番配信・既存Pagesへ書き戻さない。
