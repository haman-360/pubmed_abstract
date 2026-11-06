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
