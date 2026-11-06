# Workers＋D1 ローカル試作

**追加費用0円・架空データ専用。** Miniflare 4のworkerd／D1 bindingで動作する。通常の試作ではCloudflareアカウント・APIキー・Google認証・OpenAI APIは不要。別途、本人のFirebase無料プロジェクトを使うログイン専用試験と、未公開の[クラウドTEST用API](#クラウドtest用apiの準備)を追加した。クラウドへの作成・公開・課金は行っていない。

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

通常の配信一覧は**直近2か月**を表示する。日本時間の今日から暦で2か月前の同日までを含み、月末に同日がなければその月の末日を使う。配信日を基準とし、論文の出版日や手動メモの更新日では絞らない。「過去の月を指定」で任意の1か月、「配信日不明」で日付がない配信を開ける。いずれも20配信ずつ表示する。古いデータ・メモは削除せず、必要な配信を開いた時だけ内容を取得する。固定の架空データは2026年8月と1月なので、現在の日付で直近に該当しなければ対象月を指定する。

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
| `LEDGER_TEST_ONLY` | `synthetic`に固定。実データを受け付ける移行機能ではない |
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

2026-11-06職場Macでの実接続：台帳APIのアップロード・コード読戻し一致を確認。既存Worker全体のService Authを残し、TEST本番ホストの`/api/*`だけをホスト名AccessアプリのBypassでWorkerのFirebase本人認証へ委ねた。本人APIは未認証・偽token・二重ヘッダーで`identity_denied`、`/sync/status`・ルート・`/api`境界は既存Accessで403になることを確認。同期はまだ無効で、本人の実token保存・架空120件のクラウド同期は未実施。プレビューも既存Worker全体の保護対象のまま。

`workers.dev`はPython標準`urllib`のUser-AgentをCloudflareの`1010`で拒否する場合があるため、同期CLIは自身を`PMIDLedgerTest/1.0`と明示する。実TESTでこの識別子による本人API到達と未認証拒否を確認した。ブラウザーを偽装せず、Browser Integrity Checkも変更しない。403だけでAccess認証の検証成功と判断せず、WorkerのJSONエラーとCloudflare側の拒否を区別する。[公式の1010説明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)

追加7件を含むNode.js 65件とPython専用13件が成功。クラウド用bundleをworkerd＋一時D1で動かし、本人役の保存・再送、同期役の分割公開・手動履歴保持、他UID・偽認証・期限・二重ヘッダー・Origin・容量超過の拒否を確認した。公開鍵は架空応答に差し替え、実Accessへの接続はしていない。クラウド用ログイン画面、実token保存、FreeのCPU、Mac／iPad往復はこれから。外部公開前に、新規TESTの対象と認証・公開設定を確定する。

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
| `/api/listIssues` | 既定`scope: recent`で直近2か月。`month`＋`YYYY-MM`、`unknown`も可。`offset`で20件ずつ。比較・保守用だけ明示`all`も可 |
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
- 通常PMID台帳、分野・状態など残る絞り込みと並び順、TXT／CSV、GASバックアップとの相互変換は未実装。ローカルD1用の分割NDJSONバックアップ・空DB復元と旧V1 JSON互換は実装・検証済み。
- Firebase形式／Access形式の署名JWTと実Firebaseログインのローカル検証は実装した。Service Authの外部接続、ネイティブログイン、FreeプランのCPU・保存容量・要求上限、クラウド往復・失敗率は未検証。ローカルの経過秒数をGAS本番との改善率に換算しない。
- クラウドTEST用API・非公開が既定の設定例・架空データ専用同期を準備した。利用者の許可後に認証付き初期WorkerとD1を作成し、接続情報はGit対象外へ保存した。TEST専用のコード反映CLIを追加したが、実tokenや実接続IDはGitへ置かない。追加費用0円を維持し、認証とコード反映を確認してからクラウド実測へ進む。FirestoreのRules成立性の比較は別の作業。
