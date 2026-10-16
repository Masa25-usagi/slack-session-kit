# Slack Session Kit ローカル追加版

SlackをAIとの作業セッションとして扱うツール。

ローカルで作成したツールの公開用ソースです。試作段階の機能も含みます。実際の利用記録、認証セッション、APIキー、個人用の配備設定は配布していません。

## セットアップ

Node.js 22.18以上を使用してください。

```sh
npm ci
npm test
npm run check
npm run build
```

## 設定とデータ

外部サービスを使用する機能は、利用者自身のアカウントとAPIキーを設定してください。環境変数の例は `.env.example` を参照してください。このツールは `.env` を自動では読み込みません。キーはサーバー側またはOSの安全な保存領域に置き、Gitへ追加しないでください。

デモには架空の入力を使用してください。生成された記録・録音・予定・健康データは利用者の環境だけに保存し、公開リポジトリへ追加しないでください。

## Chromeでログイン済みのSlackを使う

macOSのChromeでSlackにログインし、`chrome://inspect/#remote-debugging` でリモートデバッグを有効にしてください。接続の許可を求められたらChrome側で許可します。複数のワークスペースが開いている場合は、利用するワークスペースだけを残してください。

ビルド後、CLIで認証と検索を確認できます。

```sh
node dist/cli/bin.js auth-test --from-chrome
node dist/cli/bin.js search --from-chrome --query 'in:general test' --count 3
```

`--from-chrome` を使うときは、`SLACK_SESSION_TOKEN` / `SLACK_TOKEN` を同時に設定しないでください。ChromeのHTTPタブ一覧が404を返す環境では、`DevToolsActivePort` に記載されたローカルのブラウザWebSocketからSlackのタブへ接続します。認証情報はメモリ内で扱い、取得後すぐにChromeとの接続を閉じます。

stdio MCPでも同じ認証方法を使用できます。

```sh
SLACK_AUTH_SOURCE=chrome node dist/mcp/bin.js
```

既定では読み取り専用です。検索・スレッド取得・チャンネル一覧はフォーム形式でパラメータを送信します。ListsやCanvasなどの構造化されたAPIにはJSONを使用します。

## ライセンス

MIT。依存ライブラリには各ライブラリのライセンスが適用されます。
