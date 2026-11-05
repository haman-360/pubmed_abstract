# 本人限定認証のローカル検証：2026-11-05 JST

**署名付きJWTによる本人限定判定と権限分離を、Node.jsとworkerdのAPIで検証した。追加費用0円。** 実際のGoogleログイン、Firebase／Cloudflareの設定、公開鍵の外部取得、クラウドCPU・iPad実機は未確認。現在地は①「遅さの調査・改善」の後半で、認証方式の成立性を確かめている。

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

## 次に確認すること

- Googleの公式公開鍵取得とCache-Controlに沿った更新、Accessのteam公開鍵取得、kid更新、通信失敗時の拒否をクラウド用入口へ接続する。今回の公開鍵fixtureを本番鍵に流用しない。
- 本人のCloudflare Workers Free／Firebase Sparkの状態、既存の課金リンク、AccessのFree設定を確認する。Zero Trustの初期設定は公式案内上Freeでも支払情報が必要で、こちらでは登録していない。[Zero Trust初期設定](https://developers.cloudflare.com/cloudflare-one/setup/)
- 実Googleログイン→token取得／更新→ログアウトの流れを確認する。署名・期限の検証だけでは、有効期限前のtokenの失効・盗難対策まで確認したことにはならない。クライアントでのログアウト後も既発行tokenの扱いを決める。[Firebaseセッション管理](https://firebase.google.com/docs/auth/admin/manage-sessions)
- クラウド用入口では検証済みidentityを直接保存APIへ渡し、固定テストtoken・障害注入・ローカル鍵fixtureを含めない。本人以外を拒否する状態を確かめた後、別TESTで実際のCPU・Mac／iPad往復を測る。

これらは今後の作業で、今回の検証による実ログイン成功や無料運用の保証ではない。本番GAS・実台帳・既存配信workflowは変更していない。GAS同期・deployment・クラウド作成・有料API呼出しは行っていない。

依存関係確認：`npm audit`には既存Miniflare系（Miniflare／sharp／undici）のhighが3件残った。新規jose／esbuildは指摘されていない。既存の依存バージョンは変えておらず、`audit fix --force`や古いMiniflareへの切替は実行していない。開発環境の更新は別途必要で、今回のローカル入口を公開用に扱わない。

## 再現

```bash
cd pmid_ledger/prototype
npm ci
npm run test:identity
npm test
```

無料の公開npmパッケージを取得した後は、ローカルの一時DBだけで試験できる。Cloudflare／Firebaseのアカウント、実token、APIキーは不要。秘密情報をチャットへ送る必要はない。
