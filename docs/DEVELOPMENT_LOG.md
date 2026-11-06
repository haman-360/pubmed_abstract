# 開発ログ

今後の開発記録の正本。過去の台帳開発・調査記録は [pmid_ledger/DEVELOPMENT_LOG.md](../pmid_ledger/DEVELOPMENT_LOG.md) に保持し、書き換えない。

## 2026-11-06 JST：職場MacへTEST設定を復元（台帳コード反映待ち）

- 未コミット変更のないmainから `origin/codex/ledger-candidate-review` をfetchし、追跡ブランチへ切替。取得時HEADは指定の `dc90053`。mainへの統合は行わない。
- 引継ぎ冒頭、試作README、認証検証記録を確認。既存Cloudflareの `pmid-ledger-test` Workerと同名D1への `DB` binding、全通信の既存Service Auth保護を管理画面で確認。作成し直していない。認証なしの実HTTP要求1回は403。既存FirebaseはSpark（無料）と既登録の本人アカウント1件を確認した。
- 接続IDと固定済み本人UIDを既存管理画面から確認し、Git対象外の `ledger_private/cloud-test-resources.json` と `cloud-test-owner.json` を0600で復元。実値・tokenは文書へ転記しない。最初にログインした人の自動登録は行わない。Webログイン試験はまだ再開していないため `firebase-web.json` は未復元。
- 本人UIDの非表示転記に127.0.0.1限定の一時フォームを使用。保存後に専用タブを閉じ、サーバーを停止し、一時スクリプトを削除した。既存ローカルDB・他サーバーは変更していない。
- `npm ci --no-audit --no-fund` でlockfile固定の32パッケージを取得。sandbox内の初回取得は失敗したため、許可した環境と一時npmキャッシュで再取得した。依存バージョン・lockfileの変更なし。
- `npm run build:cloud-test` が成功。生成bundleは92,665バイト、SHA-256は `5875d8d6ea974bf99bf81a8e31ecf2b62525b635b09194f40b82ed2fbc3cbb8d`。`deploy_cloud_test.py` のHTTPなし準備確認も成功。生成物はGit対象外。
- 検証：試作Node.js 65件、専用Python 19件がすべて成功。架空同期の `--inspect` はHTTPなしで120件・6配信・7チャンク。設定の0600、Git除外、`git diff --check` を確認。既存業務コードは変更していない。
- 職場MacでもCloudflareコードエディターの読込が完了せず、専用CLIへ移行。Worker専用APIトークンは利用者が発行し、実ターミナルの `getpass` へ非表示入力する必要がある。値をチャット・引数・環境変数・ファイルへ求めない。現在は入力待ちで、台帳コード反映・クラウド読戻し一致は未確認。同期用Client ID／Secretも未入力。
- 次：リポジトリのルートから `python3 pmid_ledger/prototype/deploy_cloud_test.py --upload` を利用者が実行し、秘密値を含まない `.cloud-test/deployment-verification.json` を確認する。全通信Accessを維持し、反映・読戻し一致後に本人APIと同期経路の分離を検討する。架空120件のクラウド同期・実Google tokenでの保存・CPU測定・Mac／iPad往復は未実施。
- 追加費用0円。本番GAS・実台帳・既存Pages・既存workflow・課金設定の変更なし。TESTの新規作成、APIトークン発行、Access変更も行っていない。GAS変更なし、`clasp push` 不要、GAS deploy未実施。TEST Workerのアップロードも本記録時点では未実施。

## 2026-11-06 JST：TEST台帳APIの反映・クラウド読戻し一致

- 利用者がWorker限定APIトークンを発行し、専用CLIへ非表示入力してアップロードを完了したと通知。ローカルの `.cloud-test/deployment-verification.json` を直接確認し、`uploaded: true`、`source_readback_verified: true`、92,665バイト、SHA-256が手元のbundleと一致することを検証した。検証時刻は2026-11-06 09:00:33 JST。結果ファイルは0600、Git対象外。tokenの値は読み出していない。
- 反映したのは既存 `pmid-ledger-test` の台帳APIコード、既存TEST D1 binding、固定本人設定。`metadata_sync_enabled: false`。新規TEST作成・実データ同期・既存Pages変更は行っていない。
- コード反映後、認証なしPOSTを `/api/listIssues` と `/sync/status` に各1回実行し、両方403を確認。現在もWorker全体の既存Service Auth保護を維持している。
- 既存TEST D1で集計用SELECTを1回実行し、16テーブル・2トリガー・1ビュー、公開世代null、論文0件・操作0件を再確認。初期化・再作成・データ書込は行っていない。実行前の直近24時間の表示は260行読取・65行書込、168kBだった。これは当該DBの表示値であり、アカウント全体の日次残枠や今後の無料枠適合を保証する値ではない。
- 次は経路分離。既存の全体保護を維持したまま、TEST本番ホストの `/api/*` だけに優先するホスト名ポリシーを設定し、本人のFirebase署名・固定UID認証へ委ねる案を確認する。`/sync/*`・その他のパス・プレビューの全体保護は維持する。設定保存はまだ行っていない。本人JWTとAccess assertionが同時に付く要求は現コードが拒否するため、全体Service Authのまま本人tokenだけで到達したとは扱わない。
- [公式のWorker Access優先順](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)と[パス指定](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)を確認。既存Accessアプリの確認用未保存入力はreloadで破棄し、新規Accessアプリ `pmid-ledger-test-owner-api` の下書きでTEST本番ホストの `/api/*` だけを指定。`pmid-ledger-test-firebase-owner-only` の下書きはAccess側のバイパス／全員であり、本人の判定はWorkerの固定UID認証が行う。名前だけでAccess本人判定済みと解釈しない。ポリシー・アプリともまだ保存していない。
- コンピューター操作ツールの確認規則で、Access保護の一部解除には実行時確認が必要。未認証通信もWorkerへ届くようになる点と、Firebase署名・本人UIDの一致前にはD1へ到達しない点を説明し、保存・検証の確認待ち。既存の全体Service Authや同期設定を先に緩めていない。
- 検証は前段で成功した65件＋19件と、今回の実コード読戻し・SHA-256照合・反映後の認証なし拒否。コード変更なしのため自動試験の重複実行はしない。
- 追加費用0円、本番GAS・実台帳・既存Pages・課金設定は変更なし。`clasp push` 不要、GAS deploy未実施。今回は利用者によるTEST Workerだけのコードアップロードを確認した。

## 2026-11-06 JST：本人APIの経路分離とPythonクライアントの1010対策

- 利用者から、TEST本番ホストの `/api/*` だけをAccessのバイパス／全員へ設定し、WorkerのFirebase署名・固定本人UID検証へ委ねる保存・検証の明示承認を受けた。既存Worker全体のService Authは変更せず、ホスト名アプリ `pmid-ledger-test-owner-api` とポリシー `pmid-ledger-test-api-use-firebase` を保存。後者は下書き名から変更し、Access自身がFirebase本人判定を行うと誤解しない名前にした。
- 保存済み画面を読み戻し、サブドメインがTEST Worker、ドメインが既存workers.dev、パスが `api/*`、アクションBypass、対象全員であることを確認。他のパス・他Worker・既存Pagesを対象に追加していない。既存アプリとService Authポリシーも一覧に残る。
- WorkerのAccessタブでも、ホスト名ポリシーが当該 `/api/*` のバイパスだけで、既存Workerポリシーは「すべてのTraffic」「すべてのURL（本番とプレビュー）」のService Authのままであることを再確認した。プレビューへの実通信は行っていない。
- 最初のPython実通信はすべて403だったため成功扱いせず切り分けた。応答はHTMLではなく `text/plain` の `error code: 1010`。Python標準urllibのUser-AgentがCloudflareのBrowser Integrity Checkに拒否されていた。ブラウザーGETではWorkerの `post_required` に到達し、明示したアプリ識別子 `PMIDLedgerTest/1.0` のPOSTでは `identity_denied` を確認した。[公式1010資料](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)
- 訂正：先の記録の「認証なし403」だけでは、Accessが拒否したのか1010なのかは区別できない。今回の実検証は識別子を明示し、1010がないことと、本人APIのJSON応答／他経路の非JSON応答を区別して判定した。Cloudflareの保護設定は変更・無効化していない。
- 実TESTへの6要求で、`/api/listIssues` の未認証・偽Bearer・二重認証ヘッダーがいずれも403 JSON `identity_denied`、`/sync/status`・ルート・`/api`境界は非JSONの403、全件1010なしを確認。結果はGit対象外 `.cloud-test/access-verification.json` に0600で保存した。実tokenは使用せず、DB書込APIも呼んでいない。
- 同期CLI `CloudTestTransport` へアプリ識別ヘッダーを追加し、標準urllib署名が拒否されるケースの回帰試験を追加。専用Python20件が成功。ローカル同期・本番workflow・GAS・Workerの実装bundleは変更していない。試作READMEへ実接続結果と1010の区別を追記した。
- 同期はまだ無効。既存同期用service tokenのClient ID／Secretを職場Macの保存先から取り出せるか利用者へ確認中。値をチャットへ求めず、見つからない場合も既存TESTやtokenを無断で再作成しない。同期権限の明示的な有効化、架空120件の同期、実Google本人tokenでの保存、CPU・Mac／iPad往復は次の段階。
- 追加費用0円。本番GAS・実台帳・既存Pages・課金設定は変更なし。`clasp push` 不要、GAS deploy未実施。この段階ではWorkerの再アップロードも行っていない。

## 2026-11-06 JST：非表示入力の同期セッションを準備

- 利用者から、既存同期用 `pmid-ledger-test-sync` のClient ID／Secretを職場Macの保存先から取り出せると回答を受けた。値をチャットへ求めていない。既存Accessアプリのissuer／AUDだけをGit対象外の `cloud-test-access.json` へ0600で復元し、資格情報は保存していない。
- D1一覧の日次表示（UTC午前0時起点、November 6）を確認：DB総数1/10、読取118/500万行、書込0/10万行、総ストレージ167.94kB/5GB。固定fixtureの初回書込見積は2,167行。今回の実行予算は10,000行以内とし、日次残枠の自動管理や反映遅延を含む料金保証とは区別する。
- `cloud_test_session.py` を追加。既定はHTTP・入力なしの準備確認。実行には `--enable-sync`、架空120件の転送にはさらに `--sync-synthetic --write-budget` が必要。実ターミナルで既存同期用Client ID・Secret・Worker更新用APIトークンを非表示入力し、値を引数・環境変数・ファイル・ログへ置かない。非表示入力のfallbackも拒否する。
- 実行順序は既存TESTの経路分離確認、同じWorkerへコード・同期有効設定を送信、コードと非秘密設定の読戻し一致、署名付き同期status、既知fixture以外の公開データ拒否、予算内転送・公開、全7チャンク照合、経路分離の再確認。既存D1・Worker・Access・tokenは作り直さず、本番系へ接続しない。Client SecretをWorkerへ渡さず、固定本人設定と同期JWTの検証情報だけをWorkerのsecretへ送る。
- `deploy_cloud_test.py` の関数へ明示指定時だけの同期設定を追加。従来CLIの既定は同期無効のまま。同期指定時は `/settings` GETでDB ID・同期有効値・各plain変数・本人設定がsecretであることを照合し、不一致・HTTPエラーで停止。secret値は読み戻せないため、実claims一致は後続の署名付き同期要求で検証する。
- 結果は既存のGit対象外生成ディレクトリへ0600で保存。新しい試行は未検証状態から始め、古い成功報告を流用しない。失敗時は資格情報の参照を破棄し、自動再送・公開データの自動削除・Access保護変更は行わない。経過秒はCPU時間と区別する。
- 検証：専用Python31件、同期Node.js10件が成功。署名設定の不正・secret混入・DB binding読戻し不一致・非TTY／echo fallback・フラグ／予算不足・経路誤設定・未知の既存データ・全チャンク不一致・中断・資格情報非出力を確認。一時workerd＋D1で実際の120件同期・全7チャンク照合と2回目の重複なしも成功。HTTPなし準備確認と構文・差分検査も成功。Pythonの通常cacheへの構文検査書込はsandboxで拒否されたため、一時cache先を明示して再実行した。
- 試作READMEへ職場Macでの実行手順を追記。現時点では利用者の非表示入力待ちで、クラウド同期の有効化・120件の転送はまだ行っていない。追加費用0円。本番GAS・実台帳・既存Pages・課金設定は変更なし。`clasp push` 不要、GAS deploy未実施。

## 2026-11-06 JST：大きなAccess拒否ページによる事前チェックの誤停止を修正

- 利用者が同期セッションを実行し、トークン入力前に `test_access_path_separation_not_verified` で停止したと報告。該当順序ではWorker更新・同期転送へ進まないことを確認した。
- 秘密値なしの4要求で再現。本人APIは期待どおり403 JSON `identity_denied`。同期・ルート・`/api`境界も403だが、Cloudflareの `text/html` 拒否ページが8KiBを超えていた。本文サイズ超過を本人API以外にも適用した実装が誤停止の原因だった。認証経路の設定不備や利用者の入力ミスではない。
- 本文の取得は従来どおり最大8KiB＋1バイトで打ち切り、Access拒否ページの全体サイズは経路誤設定とみなさないよう修正。本人APIのJSONは従来どおりサイズ制限と内容の完全一致を要求。他経路の403・非JSON・1010拒否でないことの確認も維持する。Cloudflareの認証・バイパス・署名検証・公開範囲を変更していない。
- 専用Python31件が成功。大きなAccess拒否HTMLは通し、大きすぎる本人JSONや保護対象経路へのWorker JSON応答は拒否する回帰ケースを追加した。構文・差分検査も成功。修正済み関数を実TESTへ4要求で実行し、事前チェック成功を確認。秘密値の入力・利用なし、Worker更新・DB書込なし。
- 試作READMEへ誤停止条件と処理前停止の説明を追記。次は同じコマンドで非表示入力を再開する。クラウド同期の有効化・架空120件の転送はまだ未実施。追加費用0円。本番GAS・実台帳・既存Pages・課金設定は変更なし。`clasp push` 不要、GAS deploy未実施。

## 2026-11-06 JST：同期設定の反映成功・403の読取専用診断を準備

- 利用者が同期用Client ID／Secretの保存項目を確認。以前のWorker更新用APIトークンの保存先が見つからなかったため、既存TEST Worker限定・Individual Workers Editor・7日で発行直前のフォームを準備し、利用者自身が新しい更新用トークンを発行して「パスワード」へ保存したと通知した。値は読み出さず、保存後に発行画面のタブを閉じた。既存の同期用service token・TEST D1・Workerは作り直していない。
- 利用者が3値を非表示入力して同期セッションを実行し、`sync_http_403`で停止したと報告。結果ファイルを直接確認し、2026-11-06 11:14:09 JSTのコードGET一致、92,665バイト・既存SHA-256一致、binding読戻し一致、`metadata_sync_enabled: true`を確認した。**同期設定のクラウド反映は完了したが、実同期の成功はまだ確認できていない。**
- 既存Accessのサービス認証ログを読取表示へ切替え、11:14:09・11:14:11 JSTの当該TEST向け要求2件が「許可」であることを確認。Client ID／SecretはAccess側で受け入れられている。ログの実Client ID・IP・メール・接続IDを本記録へ転記していない。WorkerのAccessタブでも既存issuer／AUDとprivate設定が一致し、既存Service Authが残ることを確認した。
- TEST D1でSELECTを1回実行し、公開世代null、同期世代0・チャンク0・論文0・操作0を読み戻した。架空120件の転送や公開はまだ行われていない。`sync-verification.json`は未検証のstartedのままで、成功扱いしていない。403の最終原因は未特定。
- 切り分け用に`--use-existing-worker`を追加。同期有効設定のコード・binding検証結果と手元のbundleハッシュが一致する場合だけ、再更新せず既存TESTへ接続する。既定はstatus読取だけで、利用者が同期用Client ID／Secretの2値を非表示入力する。更新用APIトークンは不要。別途`--sync-synthetic --write-budget`を指定した場合だけ転送でき、`--enable-sync`とは排他にした。
- クラウドHTTPエラーの本文を最大8KiB＋1バイトだけ読み、既知のWorker JSONエラー・Access／edge・1010などの固定分類、status、action、要求数だけを保持・出力する。応答本文・ヘッダー・資格情報は保存・出力しない。既存の`sync_http_403`等のエラー名、ローカル同期の動作、redirect／proxy／自動再送なしは維持。失敗結果もGit対象外の診断ファイルへ0600で保存する。
- 検証：Python35件、workerd＋一時D1の同期Node.js10件が成功。既存Workerモードが2値だけを要求し更新しないこと、古いbundle検証結果の拒否、エラー分類で秘密値を出さないこと、資格情報の参照破棄、既存の中断・再送・予算・リダイレクト拒否を確認。HTTPなし準備確認、非TTY拒否、構文・差分検査も成功。試作READMEへ診断・再開コマンドを追記した。
- 次は利用者の2値の非表示入力で読取専用診断を1回行い、HTTP応答元を確認する。診断を理由に署名・claims・Access保護を緩めず、架空データ転送やWorker再更新を先に繰り返さない。追加費用0円、本番GAS・実台帳・既存Pages・課金設定は変更なし。`clasp push` 不要、GAS deploy未実施。この診断準備ではWorkerの再アップロードを行っていない。

## 2026-11-06 JST：実Access署名付き同期statusの読取に成功

- 利用者が `--use-existing-worker` を実行し、読取診断の成功結果を通知。Git対象外 `sync-diagnostic.json` を直接読み、2026-11-06 11:27:16 JST、`session_verified: true`、`signed_access_verified: true`、`sync_enabled: true`、`path_separation_verified_after_sync: true` を確認した。実Accessによる同期JWTの検証を通り、D1のstatusを1要求で読み取った。
- `published: false` は公開された台帳メタデータ世代がまだないという正常な状態。`writes_requested: false`、`worker_updated: false` で、架空データ転送・Worker再更新を行っていない。診断処理の経過は0.916秒で、CPU時間ではない。結果ファイルは0600。既存のコード・binding検証結果と手元のbundleハッシュも引き続き一致した。
- 前回の403の最終原因は現時点では断定しない。今回は認証条件・Access保護・Workerコードを緩めたり変更したりせず、同じ既存設定の読取が成功したことを確認した。トークン値はチャット・ログへ出していない。
- 次の転送前にD1一覧の日次表示を再確認。November 6・UTC午前0時起点、DB1/10、読取120/500万行、書込0/10万行、ストレージ167.94kB/5GB。固定fixtureの初回書込見積2,167行に対し、今回の実行予算を10,000行として、再更新なしで架空120件・全7チャンクの転送／読戻しへ進む。
- 試作READMEの現在地を、同期無効から「有効化・設定読戻し・実署名付きstatus成功」へ更新した。コード変更なしのため自動試験は重複実行せず、結果ファイルの値・0600・ハッシュ一致・残枠・差分を確認した。
- 現時点では架空120件のクラウド転送、実Google本人tokenでのクラウド保存、CPU・Mac／iPad往復は未実施。追加費用0円、本番GAS・実台帳・既存Pages・課金設定は変更なし。`clasp push` 不要、GAS deploy未実施。

## 2026-11-06 JST：架空120件のクラウド同期・全チャンク読戻しが成功

- 利用者が既存Workerモードで架空同期を実行。0600のGit対象外 `sync-verification.json` を直接確認し、2026-11-06 11:30:49 JST、120論文・141掲載・23要求、`verified`／`full_readback_verified`／`session_verified`／`signed_access_verified`／同期後の経路分離確認がすべてtrue、Worker再更新falseを確認した。更新・同期・読戻しの経過は30.809秒で、CPU時間ではない。
- D1のSELECTで公開世代あり、同期世代1・チャンク7・論文120・配信6・掲載141・保存操作0を確認。同期直後の日次表示は約4,550読取／500万、約2,170書込／10万で、設定した1万書込予算内。丸め表示・反映遅延があるため、これらを正確な差分や将来の料金保証とは扱わない。
- 既存TESTを作り直さず、実データ・本番GAS・既存Pages・課金設定を変更していない。次の本人保存に向けて同期成功記録を保持した。API token・service tokenの値は記録していない。

## 2026-11-06 JST：実Google本人によるクラウド保存・再送・サインアウトを確認

- 既存FirebaseのSpark表示と登録済みWebアプリを確認し、公開Web設定と固定済み本人UIDをGit対象外 `firebase-web.json` へ0600で復元。owner設定とのproject／UID一致を照合した。転記用127.0.0.1限定の一時フォームは保存後に停止し、一時スクリプトも削除した。新規Firebaseプロジェクト・provider・ドメイン・課金設定は追加していない。
- `npm run login:cloud-test` でlocalhost:8789のGoogle保存確認を追加。固定本人設定と120件の全チャンク読戻し記録を起動条件にし、永続化しない一時D1を用い、操作は既存クラウドTESTの本人APIへ送る。通常の8787／8788と保存DBは変更しない。固定の架空PMID 1とテスト用メモだけを許可し、他UID・他論文・任意メモ・同期・登録・他host・redirect・大きすぎる本文は拒否する。
- ローカルとクラウドの両方でGoogle署名・issuer・audience・期限・本人UIDを検証する。クラウドへ固定仮tokenへ置換して送る処理はない。Firebase SDKのメモリ保持を使い、tokenをファイル・URL・ログへ保存しない。保存結果不明時は同じ画面の同じ操作IDで確認でき、独自の自動再送は行わない。
- 利用者のGoogleログイン完了通知後、実画面で本人認証・クラウド6配信取得を確認。架空1件の保存ボタンを実行し、保存・同じ操作ID再送・状態／メモ／版数の読戻し・本文取得が成功した。画面の確認全体は2.78秒（1回、CPUではなく、GASと同条件の比較でもない）。D1のSELECTでも保存操作1・論文履歴1・版数1・状態want_fulltext・テストメモ一致・配信操作0を確認した。
- token強制更新後の取得と、画面サインアウト・保存／再確認ボタンの無効化を確認。画面はサインアウト状態で残し、新しい8789番サーバーは稼働中。観測の集計はGit対象外 `owner-save-verification.json` に0600で保存し、実UID・メール・tokenは含めない。利用者に資格情報のコピー入力を追加で求めていない。
- 検証：Node.js全71件成功。新規5件で別の一時cloud D1への保存・再送で履歴1件、ローカルDBへの保存0件、固定fixture以外の拒否、redirect拒否、メモリ保持、応答喪失後の同一操作、サインアウト後の遅延応答を確認した。初回の試験では登録拒否要求のContent-Type不足による期待値不一致と、サインアウト文言の上書きを検出し、試験の要求条件と画面文言を修正して全件再実行した。構文・差分検査、クラウドbundle除外検査も成功。
- 生成したクラウドbundleは引き続き92,665バイト・従来SHA-256と一致。今回はローカル試験画面の追加だけで、Worker再アップロードは行っていない。試作README・認証検証記録を更新した。追加費用0円、本番GAS・実台帳・既存Pages・課金設定は変更なし。`clasp push` 不要、GAS deploy未実施。

## 2026-11-06 JST：実CPUの集計表示を確認、採用判断は保留

- Worker Metricsの過去24時間表示で56呼出し・エラー0・CPU時間制限超過0を確認。CPUサマリー表示3ms、表示されたCPUチャートの1集計点にP50 3.465ms・P90／P99 13.358msがあった。これらはバージョン・操作を混ぜた集計点で、本人保存だけのCPU・個別要求の最大値・最新全要求を示す値ではない。集計と限界をGit対象外の0600 `cloud-metrics-observation.json` へ記録した。
- [公式CPU制限](https://developers.cloudflare.com/workers/platform/limits/)のFree HTTP要求あたり10msと、一時超過を吸収する余裕・継続超過時の停止を再確認。上位集計点が10msを超えているため、停止0件・小規模成功だけで無料プラン成立や方式採用を確定しない。有料化やCPU上限引上げは行わない。
- 無料枠記録へ実クラウド同期・本人保存・CPUの値と条件を追記した。現在地は①クラウドTESTでの実測段階。次はCPUの重い操作の特定と削減、クラウドの規模・世代蓄積、iPad実機往復の検証。②オンラインアプリ化・③オフライン対応は未着手。追加費用0円、本番系・課金設定変更なし、GAS deploy未実施。

## 2026-11-06 JST：TESTのCPU負荷を粗く確認し、D1往復削減と速度比較を完了

- 利用者指定：①置換候補の評価→②アプリ化→③オフラインの順序を維持し、今回はTESTのCPU・速度比較を行う。細かな遅延原因の精査は広げず、難しい場合は直近2か月などの機能制限を優先する。追加費用0円、本番GAS・実台帳・既存Pagesは変更しない。
- localhost:8789へ固定fixtureの操作別計測（一覧・100件配信の先頭50件・詳細・1件保存を各10回）と、CPU観測用の読取（30秒経過後は次を送らず最大80要求）を追加。後者は今回40要求で終了した。計測結果は時刻・時間・D1カウンターだけで、token・UID・本文は出力しない。保存結果不明の同一操作を保持中は、別の速度計測を禁止する。ログインはFirebaseのメモリ保持で、資格情報のコピー入力は不要。
- 12:21 JST開始の変更前中央値は、一覧712.8ms・論文一覧360.35ms・詳細788.2ms・1件保存507.8ms。一覧と詳細はD1へ4往復だった。実クラウドのCPUプロファイル採取は、通信中も2回「No recent executions」となったため打ち切り、永続ログや課金を有効にして追跡しなかった。
- 同じ変更前bundleをローカルworkerd・架空RSA署名・一時D1・固定120件で各読取50回サンプリングし、署名検証とD1通信のfetch／toJson／text等の標本が目立つことを確認。サンプルは診断・JIT・実行環境の影響を含み、クラウドの操作別CPU時間ではない。署名検証は維持し、D1通信回数を減らす変更へ絞った。ハッシュ整形の小さな高速化案もローカルで比較したが、今回は採用していない。
- 配信一覧を1つのSQL snapshotへまとめ、固定世代・件数・日付索引から選んだ20キーのページを同時に取得（D1往復4→1）。詳細は取得済み世代を再利用し、掲載と順序付き本文パーツをまとめて取得（今回の固定1件は4→2）。共有PMID・複数掲載・本文パーツ順序・欠落時の拒否は維持した。同期対象や本文を切り捨てる変更は加えていない。
- `deploy_cloud_test.py --update-code-only` を追加。[公式keep_bindings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)で既存d1／plain_text／secret_textを継承し、固定TEST DB・同期有効設定等をPUT前後で照合、コードもGET読戻しする。異なるDB・未知binding・無効同期等なら更新前に停止し、通信結果不明や不一致でも再送しない。利用者が保存済みWorker更新用API tokenを非表示入力し、12:32:16 JSTに93,167バイト・SHA-256 `79450da3b6e348a0d0e43a595be09d99d64e00f45d119b31ed1acbd7bc7ba562` の読戻し一致・binding継承を確認。同期Client ID／Secret・本人UIDの再入力や再発行はしていない。
- 同じ画面の本人tokenで12:32 JSTから再計測。各10回の中央値は一覧370.0ms・論文一覧360.05ms・詳細535.4ms・1件保存485.15ms。最長は順に999.7／387.4／611.5／530.4ms。ブラウザーのproxy往復時間で、CPUではない。初回を含む別時刻の逐次比較で、ランダム化したAB試験ではない。Node.jsの一時DBとクラウドのD1カウンターも往復削減と一致。詳細行読取は15→12、一覧は650→654で、行数の大幅削減とは扱わない。
- 更新後の新バージョンだけを選んだMetricsは43要求・CPU P50表示2.23ms／P90 4.00ms／P99 8.18ms・実行エラー0・CPU制限停止0。小規模試験の結果で、混在していた変更前集計とのCPU削減率や、同期・増量・公開鍵更新周期を含む無料適合は保証しない。本人APIの未認証拒否、同期・ルート・/api境界のAccess拒否も再確認した。
- 保存後の状態・メモ・期待版数増分の読戻しが成功。D1のSELECTで論文120・保存操作21・PMID 1履歴21・版数21・want_fulltext・テストメモ一致・配信操作0を確認（前回の1件＋変更前後各10件）。計測画面をサインアウトし、集計だけを表示した状態で保持。最終ソースを反映した8789サーバーは稼働中。生の集計・CPU観測・更新前bundleはGit対象外`.cloud-test/`に0600で保持し、実token等は保存していない。
- 検証：Node.js全73件成功。Python全37件成功。新規試験で速度計測の要求上限・固定1件以外の拒否・応答不明保存と計測の分離・共有掲載／本文欠落・binding不一致時のPUT前停止／更新後不一致を確認。生成bundleのローカル認証／故障入口除外、構文・差分検査も成功。CPU採取用の一時スクリプト初回はws URLのHTTP一覧取得で失敗し、取得プロトコルを修正して採取した。クラウドプロファイル失敗を測定成功とは記録しない。
- 試作README・無料枠記録・認証記録を更新。11/4のGAS本番中央値（一覧2651ms・論文一覧2811ms）は参考として併記したが、実台帳／別日／件数が異なり改善率は計算しない。今回GASへ計測通信・書込を行っていない。120件の範囲では①の細かな最適化を一区切りとし、次は直近2か月を前提とした実用件数の上限・iPad往復を確認して方式を判断する。②アプリ化・③オフラインは未着手。追加費用0円、既存TESTを再作成せず、本番GAS・実台帳・既存Pages・課金・Access設定は変更なし。clasp push不要、GAS deploy未実施。今回の公開反映は既存TEST Workerのコード更新だけ。
