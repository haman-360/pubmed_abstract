# 本人限定認証のローカル検証：2026-11-05 JST

**署名付きJWTによる本人限定判定と権限分離を、Node.jsとworkerdのAPIで検証した。追加費用0円。** 実Googleログイン・本人UID固定・token更新・認証付き一覧取得・画面サインアウトをアプリ内ブラウザーで確認した。Cloudflare Workers Free（$0・現在のプラン）は実コンソールで確認済み。Zero Trust Freeも利用者の初期設定後に実画面で確認し、実Access teamの公開鍵2本の取得・読込まで確認した。実Access JWTによる同期・クラウドCPU・iPad実機は未確認。Firebaseは後続の利用者設定と公開APIでSpark・Google provider・Webアプリ・localhostを確認した。Google公式の公開証明書取得は後続試験で確認した。現在地は①「遅さの調査・改善」の後半で、認証方式の成立性を確かめている。

## 実装

`identity.mjs`は既存ライブラリ`jose 6.2.15`でRS256の署名とJWT claimsを検証する。鍵の供給元を信頼できる設定／providerに限定し、tokenに書かれたURL・埋込鍵は使わない。独自の暗号方式は実装しない。[jose](https://github.com/panva/jose)

| 用途 | 許可する条件 | 認証情報を受け取る場所 |
| --- | --- | --- |
| 閲覧・手動保存・バックアップ | 指定Firebase projectの署名、issuer、audience、許可した本人UID、Google provider、期限・発行時刻・auth_time | AuthorizationのBearer token |
| Pythonメタデータ同期 | 指定Access teamの署名、AUD、service tokenのClient ID、app token、空のsubject、期限・発行時刻 | Cf-Access-Jwt-Assertion |

Firebase側は公式の署名・鍵ID・claims条件を検証し、この台帳用に本人UIDとGoogle providerも限定する。token更新で`auth_time`が以前のログイン時刻のままでも、許可条件を満たせば受け付ける。[Firebase ID token検証](https://firebase.google.com/docs/auth/admin/verify-id-tokens)

Access側は人のログインtokenを同期権限に流用せず、署名済みの`common_name`を許可したClient IDと照合する。Client ID／Secretのヘッダー文字列だけでは認証済みと扱わない。本人tokenと同期tokenの相互流用・両方を同時指定した要求は拒否する。[Accessの署名検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[service tokenのclaims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)

## workerdでの試験方法

`identity-worker.mjs`は**ローカル検証専用の入口**。`runtime({identityFixture: ...})`を指定した試験だけで、esbuild 0.28.2を使ってメモリ内でbundleする。JWT検証後にだけ既存のローカル台帳ハンドラーへ渡す。既存ハンドラーの固定テスト認証へ変換する部分は試験用adapterであり、クラウド用コードではない。localhost限定・外向き通信拒否は維持する。

- 一時的なRSA鍵と署名tokenを試験プロセスのメモリ内で生成する。
- workerdへ渡すfixtureは架空のproject／UID／Client IDと公開鍵だけ。秘密鍵・tokenをファイル・Git・ログ・バックアップに保存しない。
- 通常の`npm start`や利用中の`.local-d1/`へJWT認証を有効にする変更は行っていない。現在のブラウザー試作は従来の仮認証のまま。
- 検証用入口で固定の`local-synthetic-*`文字列を送っても通らない。認証が確認できない要求はDBへ到達しない。
- token不正時は403の汎用エラー、設定／公開鍵の構成不正は503。tokenの中身・UID・鍵・署名エラーの詳細を応答へ含めない。

## 確認した結果

`npm run test:identity`の7件が成功。複数の不正入力を各試験内で確認した。

1. 許可UIDの所有者役と正しい同期service tokenを許可し、所有者役のtoken更新も受け付ける。
2. 他UID・別project・別issuer・Google以外のprovider・必須claims欠落・未来時刻・期限切れを拒否。
3. 改ざんpayload・別鍵による署名・未知／欠落kid・HS256／署名なし・tokenの鍵URL／埋込鍵・過大tokenを拒否。
4. 同期の別team／AUD／Client ID、個人用Access token、token種別の不一致と権限の流用を拒否。
5. 設定された旧／新公開鍵での検証、鍵欠落・provider失敗時の拒否、時間経過後の期限切れを確認。外部から自動で鍵を更新した試験ではない。
6. workerdの同期・本文取得・手動保存まで正しいtokenで実行。他UID等の保存は履歴0件、正しい保存と同一操作の再送は履歴1件にとどまる。
7. 認証失敗時は閲覧・本文・バックアップ・保存・同期のいずれもDB呼出し0件。曖昧なヘッダー、公開鍵設定への秘密鍵混入も拒否する。

全体の`npm test`は46件成功し、直近2か月・過去月・上限案内・保存・同期・復元の既存試験も通った。新しい認証UIや実Googleアカウントを使ったブラウザー試験は行っていない。

## 公開鍵の取得・更新を追加検証

利用者からCloudflareアカウントがあると確認した。Workers／Accessの契約状態とFirebase利用状況は未確認で、こちらでは設定を変更していない。

`identity-keys.mjs`はFirebaseの公式X509証明書URLと、信頼した設定のAccess teamのcerts URLだけを取得対象にする。GETにはtoken・Authorizationを付けず、リダイレクトを追わない。workerdは`redirect: error`を受け付けなかったため、`manual`＋HTTP 200の確認にした。[Firebaseの鍵とキャッシュ条件](https://firebase.google.com/docs/auth/admin/verify-id-tokens)、[Accessの鍵取得先](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

- `Cache-Control: max-age`から`Age`を引いた期間、公開鍵をメモリだけに保持する。最長24時間で更新し、no-store／no-cache／期限指定なしは継続利用しない。tokenを保存するキャッシュではない。
- 並行した更新は1取得にまとめる。期限内キャッシュの未知kidによる更新は30秒以上空ける。期限切れの鍵を更新できない場合、古い鍵へ戻して許可しない。
- JSONは64KiB・16鍵まで、取得は5秒で打ち切る。不正なHTTP／JSON／証明書・秘密鍵入りJWKS・過大応答を拒否する。利用していない間の定期更新は追加していない。
- 自動試験ではworkerdの公開鍵HTTPをメモリ内の架空応答へ差し替える。対象以外の通信は拒否し、通常のnpm startは外向き拒否を維持する。証明書作成は標準の`/usr/bin/openssl`を使い、試験用秘密鍵はstdinで渡してファイルへ書かない。

公開鍵の追加7件が成功し、認証関連は14件、Node.js全体は53件成功した。実Googleログインと実Access teamは未使用。

| 確認したケース | 結果 |
| --- | --- |
| Firebase X509／Access JWKS→署名JWT検証 | 両方成功。取得要求にtokenなし |
| max-age／Age・並行取得・no-cache | 期限と1取得への集約が一致 |
| 未知kid・新旧鍵の入替 | 再取得後に新鍵を許可、除外された旧鍵を拒否 |
| 期限切れ後のHTTP失敗・不正／過大応答 | 認証を拒否 |
| workerdで鍵更新不可→保存 | 履歴0件。復帰後の同じ操作は履歴1件 |
| 通常の外向き拒否 | 維持 |

さらに、Googleの公式公開証明書を認証情報なしで1回だけ実HTTP取得し、HTTP 200・2証明書・RSA公開鍵の読込を確認した。その時点のCache-Controlはmax-age 18,894秒、Age 56秒。読み戻した公開応答で2回鍵を解決し、メモリ内の読込は1回だった。これは公開情報の取得・形式確認であり、Google本人ログイン成功の証拠ではない。証明書やtokenはGitへ保存していない。Cloudflareのアカウント・チームにはアクセスしていない。

## Firebase無料設定の準備手順（利用者が設定済み）

Cloudflareは既存アカウントを使う。Firebase側は[コンソール](https://console.firebase.google.com/)で利用状況を確認し、実ログイン試験用の専用プロジェクトを用意する。既存GASのGoogleプロジェクトへ無条件に追加しない。

1. FirebaseコンソールへGoogleでログインする。
2. 台帳検証用プロジェクトを用意し、**Spark（無料）・請求先未リンク**を確認する。Blazeへの変更や支払方法登録は行わない。Analyticsは今回不要。
3. AuthenticationのSign-in methodでGoogleを有効にして保存する。電話／SMSは使わない。
4. Webアプリを登録してFirebaseのWeb設定を確認する。Hosting／Firestore作成は今回のログイン試験に不要。localhostでのログインを試す段階では、Authorized domainsへlocalhostを明示追加する。新しいプロジェクトでは既定で追加されない。

[Firebase料金](https://firebase.google.com/pricing)、[Web設定の公式手順](https://firebase.google.com/docs/web/setup)、[Googleログイン設定](https://firebase.google.com/docs/auth/web/google-signin)、[localhostの注意](https://firebase.google.com/docs/auth/faq-and-troubleshooting)。Sparkは支払方法不要と案内されている。本人の実際の設定は未確認なので、既存の有料Google Cloud請求先がつながっているプロジェクトを無料と判断しない。

実ログイン画面を後続で追加した。パスワード・秘密鍵・ログインtokenをチャットへ送らない。設定情報はローカルで扱い、実UIDや接続設定を公開Gitへ追加しない。

## 実Googleログイン画面の追加（同日）

- 利用者が新規Firebaseプロジェクトを作成し、Google providerとWebアプリを登録した。利用者の画像と実コンソールでSpark（無料）を確認。こちらでは請求設定・権限・providerを変更していない。Cloudflare側のプランは未確認。
- Web設定をコンソールのDOMから正確に取得し、Git対象外の`ledger_private/firebase-web.json`へmode 0600で保存。Firebase Web API keyはクライアント用設定であり、サービスアカウント秘密鍵ではない。UIDはnullで開始し、実設定値をGit・本記録へ転記しない。
- 公開設定のGET `/v1/projects`はHTTP 200。承認済みドメインにlocalhostが含まれていたため追加操作は不要だった。[公開プロジェクト設定API](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/TopLevel/getProjects)
- `npm run login`でlocalhost:8788の専用画面を起動。別の`.login-d1/`に架空データだけを保存し、通常の8787番を変更しない。サーバーはGoogle公式公開鍵の取得だけを明示許可。ブラウザーは公式CDNの13.2.0 App/Authを使用し、Analyticsは読み込まない。
- `/identity/probe`はGoogle署名とclaimsを確認して、そのログインのUID・email・本人設定の一致状態を返す。権限は付与しない。本人アカウント確認後にだけCLIの`--owner`でUIDを固定し、設定一致後に台帳APIを許可する。HTTP登録・同期経路は拒否する。
- `initializeAuth`は最初からメモリ保持に限定。再確認はtokenの強制更新を要求し、サインアウト時は認証表示を即消去。遅れて返ったprobe／読取を画面へ適用しない。tokenをファイル・URL・ブラウザー永続領域・ログへ保存しない。
- 追加のworkerd／設定3件と画面処理2件が成功（全体56件＋追加画面2件）。未登録の初回ログインに権限なし、CLIによる固定、他UID拒否、正しい保存の再送1件、Origin・期限・偽認証・HTTP登録拒否、メモリ保持・再確認・サインアウト後の遅延応答・SDK取得失敗を確認。自動試験のtokenは架空のメモリ内署名を使用した。
- 実Chromeで公式SDKから認証を初期化し、ログインボタンが有効になること、初期画面の横はみ出しがないことを確認。画面追加時点では実Googleログインは未確認だった。本人UID固定・実token更新・実サインアウトの後続確認は下記へ記載。

起動・本人UID固定の具体的な手順は[試作README](README.md#実googleログインの専用試験)を参照。追加費用・有料API・クラウド公開・本番データ変更はなし。GASのソース変更・同期・deploymentはない。

## 実アカウントでの確認結果（同日・画面追加後）

利用者がログインしたアプリ内ブラウザーのlocalhost:8788で確認した。実UID・email・tokenの値は記録へ転記しない。

| 確認 | 結果 |
| --- | --- |
| Googleログイン→署名／発行元／期限検証 | 成功。本人アカウントとUIDが表示された |
| ローカルCLIの本人UID固定 | 成功。Git対象外の設定ファイルは0600 |
| 「認証を再確認」による実token更新 | 更新要求後の署名検証と本人UID一致が成功 |
| 本人認証付きlistIssues | 成功。直近2か月は固定fixtureの日付により0件の空結果 |
| 画面サインアウト | UID／email表示消去、再確認／取得の無効化、ログインボタン復帰を確認 |

実tokenを使った保存・空でない配信の取得・サーバー側の既発行token失効・別実アカウント拒否は今回未検証。保存・他UID拒否・再送は前回の架空署名による自動試験の証拠と区別する。今回アプリコードは変更しておらず、自動試験58件は再実行せず、実画面と設定ファイルの読戻しを確認した。画面はサインアウト済みで残し、ローカルサーバーは継続している。

追加費用0円。Firebase／Cloudflareの課金・権限・公開設定、GAS、本番台帳は変更していない。

## 次に確認すること

- 本人の実Access teamの公開鍵取得・読込は後続で確認済み。実JWTによる同期認証と鍵更新の実接続を確認する。公開鍵fixtureを本番鍵に流用しない。
- 本人のCloudflare Workers Free（$0・現在のプラン）とFirebase Sparkの表示は実画面で確認済み。Cloudflare管理用のiCloud+メールと台帳Googleログインは別のアカウントを使う。利用者がZero Trust Freeの支払方法登録を完了し、Free表示も確認した。こちらから課金設定は変更していない。[Zero Trust初期設定](https://developers.cloudflare.com/cloudflare-one/setup/)
- 実Googleログイン→token更新→画面サインアウトは上記で確認した。署名・期限の検証だけでは、有効期限前のtokenの失効・盗難対策まで確認したことにはならない。クライアントでのログアウト後も既発行tokenの扱いを決める。[Firebaseセッション管理](https://firebase.google.com/docs/auth/admin/manage-sessions)
- クラウド用入口では検証済みidentityを直接保存APIへ渡し、固定テストtoken・障害注入・ローカル鍵fixtureを含めない。本人以外を拒否する状態を確かめた後、別TESTで実際のCPU・Mac／iPad往復を測る。

これらは今後の作業であり、ローカル実ログインの成功だけでクラウドの性能・無料枠適合を保証しない。本番GAS・実台帳・既存配信workflowは変更していない。GAS同期・deployment・クラウド作成・有料API呼出しは行っていない。

依存関係確認：`npm audit`には既存Miniflare系（Miniflare／sharp／undici）のhighが3件残った。新規jose／esbuildは指摘されていない。既存の依存バージョンは変えておらず、`audit fix --force`や古いMiniflareへの切替は実行していない。開発環境の更新は別途必要で、今回のローカル入口を公開用に扱わない。

## 再現

```bash
cd pmid_ledger/prototype
npm ci
npm run test:identity
npm test
```

無料の公開npmパッケージを取得した後は、ローカルの一時DBだけで試験できる。Cloudflare／Firebaseのアカウント、実token、APIキーは不要。秘密情報をチャットへ送る必要はない。

## 2026-11-06：職場Macへ引き継ぐ現在地

利用者が同期用service token（720時間・2026-12-06期限）を発行・保存し、その1つだけを対象とするService Authポリシーを作成した。TEST専用D1は初期化・DB binding済み。利用者の段階作成許可後に、全通信を同ポリシーで保護した初期Hello World Workerを作成し、認証なし403を確認した。台帳APIの反映・同期・本人保存は未完了。全通信Service AuthのままではFirebase本人tokenだけで到達できない。

自宅のコードエディターは空白のため、Worker限定APIトークンを非表示入力する専用アップロードCLIを準備したが、実アップロード・読戻し結果はまだない。private設定・認証セッション・生成bundleはGitでは移らない。職場Macでは既存TESTとFirebaseから設定を再構成し、認証保護を維持したまま再開する。具体的な順序と依頼文は[開発ログの職場Mac引継ぎ](../DEVELOPMENT_LOG.md)を参照。
