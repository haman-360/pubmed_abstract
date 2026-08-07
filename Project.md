# PubMed automation Google OAuth障害・復旧記録

最終更新: 2026-08-05 22:16 JST

全体の障害・運用確認履歴は[INCIDENT_LOG.md](INCIDENT_LOG.md)を参照する。本書は2026-08-04〜05のGoogle OAuth障害に関する詳細記録である。

## 結論

- Google OAuthの再認証とGitHub Secretの更新が完了した。
- 2026-08-05 22:16 JSTごろにGitHub Actionsの`poll`を手動実行し、28秒で正常終了した。
- Google Driveへのアクセスを含む`poll`が成功したため、`invalid_grant: Token has been expired or revoked.`からの復旧を確認した。
- 以後は定期`poll`と次回のPubMedメール通知を監視する。

## 発生した問題

- GitHub Actionsの`PubMed automation`は、2026-08-04 23:40 JSTのrun #94から失敗した。
- 確認できたrun #100まで、`poll`ジョブは同じGoogle OAuthエラーで連続して失敗した。
- エラーは`invalid_grant: Token has been expired or revoked.`で、Google Driveへ最初にアクセスする段階で停止していた。
- Python 3.9、LibreSSL、GitHub ActionsのNode.js非推奨警告は、今回の直接原因ではなかった。

参考:

- 失敗開始: https://github.com/haman-360/pubmed_abstract/actions/runs/30920181954
- 復旧前に確認した最新失敗: https://github.com/haman-360/pubmed_abstract/actions/runs/30972479257

## 原因

Google Auth PlatformのOAuthアプリが、外部ユーザー向けの「テスト中」になっていた。Googleの仕様では、テスト中の外部アプリが基本的なプロフィール情報以外のスコープを要求した場合、認証から7日後に認可とrefresh tokenが失効する。

このアプリは次のスコープを使用するため、7日間の失効条件に該当した。

- `https://www.googleapis.com/auth/drive.file`
- `https://www.googleapis.com/auth/gmail.send`

公開ステータスを「本番環境」に変更しても、すでに失効したrefresh tokenは復活しない。そのため、新しいrefresh tokenの発行とGitHub Secretの更新が必要だった。

## 実施した復旧作業

### 1. Google Auth Platformの設定

Google Cloudプロジェクト`PubMed Google Docs Uploader`で、次を確認・設定した。

- 公開ステータス: `本番環境`
- ユーザーの種類: `外部`
- OAuthクライアント: `PubMed Workflow Desktop`
- クライアントの種類: `デスクトップ`
- データアクセス:
  - `drive.file`
  - `gmail.send`

`gmail.send`の用途は、PubMed処理の完了・失敗・状態通知を、認証ユーザーのGmailから設定済み宛先へ送ることに限定している。メールの読み取り、一覧取得、変更、削除、連絡先へのアクセスは行わない。

### 2. ローカルの認証ファイルを確認

リポジトリ内のファイルは次の役割だった。

- `credentials.json`: Desktop OAuthクライアント設定。再認証の入力に使用する。
- `token_drive_file.json`: 旧Driveアップロード機能用。`drive.file`だけを持つため、今回の再認証には使用しない。
- `google_authorized_user.json`: GitHub Actions用の認証情報。失効した内容を再認証で上書きする。

3ファイルは同じOAuthクライアントIDに紐づいていた。

### 3. Google OAuthを再認証

システムの`python3`には`google_auth_oauthlib`がなかったが、既存の`.venv`には必要な依存パッケージが導入済みだった。次のコマンドで、既存Driveルートを変更せずに再認証した。

```bash
cd /Users/thama/Documents/GitHub/pubmed_abstract

./.venv/bin/python scripts/create_google_authorized_user.py \
  credentials.json \
  --token-only
```

`--token-only`は必須である。付けない場合、新しいDriveルートフォルダーが作成される。

再認証後の`google_authorized_user.json`について、次を確認した。

- 更新日時: 2026-08-05 22:12:09 JST
- `drive.file`スコープあり
- `gmail.send`スコープあり
- refresh tokenあり
- 必須キーあり

### 4. GitHub Secretを更新

GitHubの次の場所で、`GOOGLE_AUTHORIZED_USER_JSON`を新しい`google_authorized_user.json`の内容全体に置き換えた。

`Settings` → `Secrets and variables` → `Actions` → `Repository secrets`

次の値は変更していない。

- Variable `GOOGLE_DRIVE_ROOT_FOLDER_ID`
- Secret `OPENAI_API_KEY`
- Secret `GMAIL_NOTIFY_TO`
- その他のSecretsとVariables

### 5. 手動pollで復旧確認

GitHubの`Actions` → `PubMed automation` → `Run workflow`で、次を指定した。

- `action`: `poll`
- `test`: `false`
- その他の入力: 空欄

`poll`ジョブは28秒で正常終了した。Node.js 20の非推奨warningは表示されたが、OAuth障害とは無関係であり、実行結果には影響しなかった。

## 失敗したworkflowの扱い

- 過去の失敗runは、GitHub Actions上で失敗履歴のまま残る。
- 個々の失敗runを再実行する必要はない。
- 今回の失敗はGoogle Driveへの最初のアクセスで起きたため、失敗runはDrive台帳やDocumentを変更していない。
- `poll`はDrive上の台帳から未完了cycleとmanifestを読み込み、後続の`poll`でBatch結果回収、Document更新、通知を再開する。
- 失敗していたのは`poll`であり、新しい文献検索を開始する`dispatch`ではない。そのため、失敗runごとの手動backfillは不要である。

## 今後の再発可能性

公開ステータスを「本番環境」に変更したため、「テスト中なので7日後に失効する」という同じ問題は通常再発しない。

ただし、本番環境でもrefresh tokenは次の理由で無効になることがある。

- Googleアカウント側でアプリのアクセス権を取り消した。
- Gmailスコープを含む状態でGoogleアカウントのパスワードを変更した。
- refresh tokenが6か月間使用されなかった。
- 同一Googleアカウント・同一OAuthクライアントで多数のrefresh tokenを発行し、上限を超えた。
- Google Workspace管理者またはGoogleのセキュリティ処理によりアクセスが制限された。
- OAuthクライアントを削除、再作成、または不整合な状態に変更した。

このworkflowは定期的に`poll`を実行するため、通常は「6か月間未使用」には該当しない。再び`invalid_grant`が発生した場合は、本記録の再認証手順を実行し、GitHub Secretを更新する。

## 継続確認

- 次回の定期`poll`が成功する。
- 未完了Batchがある場合、結果回収とDocument更新が進む。
- 次回のPubMedダイジェストメールが届く。
- Gmail通知が失敗した場合は、`retry-notification`を使用する。

## セキュリティ上の注意

- `credentials.json`、`client_secret*.json`、`token_drive_file.json`、`google_authorized_user.json`をGitへ追加しない。
- 認証JSONの内容をIssue、コミット、Actionsログ、チャットへ貼らない。
- 認証ファイルは`.gitignore`の対象だが、コミット前に必ず`git status`を確認する。
- 認証復旧のために新しいDriveルートフォルダーを作成しない。
- `GOOGLE_DRIVE_ROOT_FOLDER_ID`は既存値を維持する。
