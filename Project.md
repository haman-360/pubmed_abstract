# PubMed automation 作業引継ぎ

最終更新: 2026-08-05

## 現在の状況

- GitHub Actions の `PubMed automation` は、2026-08-04 23:40 JST の run #94 から失敗している。
- 確認できた run #100 まで、`poll` ジョブは同じ Google OAuth エラーで連続して失敗した。
- エラーは `invalid_grant: Token has been expired or revoked.`。Google Drive へ最初にアクセスする段階で停止している。
- 原因は、Google OAuth アプリが「テスト中」で、外部ユーザー向け refresh token が認証から約7日後に失効した可能性が極めて高い。
- 2026-08-05、Google Auth Platform の公開ステータスを「本番環境」に変更済み。
- 既存の refresh token はすでに失効しているため、新しいトークンの発行と GitHub Secret の更新が必要。
- Python 3.9 および LibreSSL の警告は今回の直接原因ではない。

参考:

- 失敗開始: https://github.com/haman-360/pubmed_abstract/actions/runs/30920181954
- 確認時点の最新失敗: https://github.com/haman-360/pubmed_abstract/actions/runs/30972479257

## 自宅Macで行うTODO

### 1. 最新状態を取得する

```bash
cd /Users/haman14/Documents/GitHub/pubmed_abstract
git pull
```

### 2. 元のDesktop OAuthクライアントJSONを探す

```bash
find ~/Downloads ~/Desktop -maxdepth 2 -name 'client_secret*.json'
```

見つからない場合は、ほかの保存フォルダも確認する。Google Cloud 側で新しいクライアントやシークレットを作成する前に、元のJSONが本当にないか確認する。

### 3. Google OAuthを再認証する

`/実際のパス/client_secret....json` を、手順2で見つかった実際のファイルパスに置き換える。

```bash
python3 scripts/create_google_authorized_user.py \
  /実際のパス/client_secret....json \
  --token-only
```

- ブラウザで本人のGoogleアカウントを選択し、DriveとGmail送信権限を許可する。
- `--token-only` は必須。新しいDriveルートフォルダーを作らず、既存データを引き継ぐため。
- 成功すると、リポジトリ直下に `google_authorized_user.json` が作成される。

### 4. GitHub Secretを更新する

GitHubで以下を開く。

`pubmed_abstract` → `Settings` → `Secrets and variables` → `Actions` → `Repository secrets`

`GOOGLE_AUTHORIZED_USER_JSON` の `Update secret` を選び、手順3で生成された `google_authorized_user.json` の内容全体で置き換える。

- `GOOGLE_DRIVE_ROOT_FOLDER_ID` は変更しない。
- `OPENAI_API_KEY` や他のSecretsも変更しない。

### 5. pollを手動実行する

GitHubの `Actions` → `PubMed automation` → `Run workflow` で次を指定する。

- `action`: `poll`
- `test`: `false`
- その他の入力: 空欄

実行後、`poll` が成功することを確認する。失敗した場合は、Secret更新直後に再実行したrunのログを確認する。

### 6. 復旧確認

- 手動 `poll` が成功している。
- Google Drive上の既存ルートと台帳を読み込めている。
- 次回の定期 `poll` も成功している。
- 未完了Batchがある場合、後続pollで結果回収とDocument更新が再開される。

## セキュリティ上の注意

- `client_secret*.json` と `google_authorized_user.json` はGitへ追加しない。
- JSONの内容をIssue、コミット、Actionsログ、チャットへ貼らない。
- 両ファイルは `.gitignore` の対象になっているが、コミット前には必ず `git status` を確認する。
- 認証復旧のために新しいDriveルートフォルダーを作成しない。
