# Slack Session Kit — 計画と決定ログ

更新: 2026-10-05。対象: 個人・少人数の開発者がSlackをスクリプトやAIエージェントから操作するためのTypeScript SDK。初版はローカル利用の0.1版。

## 元の計画のレビュー

- Slack Listsは未公開APIではない。`slackLists.items.list/create/update`は[公式API](https://docs.slack.dev/reference/methods/slackLists.items.list/)で、公式Node SDKにも型がある。有料ワークスペース向けの機能である。
- Canvas作成・編集も[公式API](https://docs.slack.dev/reference/methods/canvases.edit/)である。「Canvas編集のリバースエンジニアリング」を初版の主題にしない。
- 型付きSDKそのものは[Slack公式SDK](https://docs.slack.dev/tools/node-slack-sdk/web-api/)と競合する。全APIを作り直す意味は薄い。
- [slackcli](https://github.com/shaharia-lab/slackcli)にはすでにブラウザ認証、検索、Saved items、未読、Canvas読み取りがある。[slack-mcp-server](https://github.com/korotovsky/slack-mcp-server)にもSaved itemsと未読がある。これらを未実装の市場の穴とは表現しない。
- 過去の回答にあった作成日・スター数は製品の判断材料にしない。機能と実装を一次情報で確認する。
- 「Webセッションなら全機能にアクセスできる」は保証できない。セッション失効、ワークスペース設定、プラン、権限に依存する。App不要でもブラウザでSlackにログインする必要がある。

## 作る価値と初版の受け入れ条件

小さな再利用可能SDKに、同じ操作を使うCLIとstdio MCPを付ける。価値の仮説は「自分のワークスペースを、Appの用意なしで、明示的な型と失敗理由を持つAPIとして扱えること」。独自技術や商業的優位は未検証。

1. `xoxc`と`d` cookieの組、または`xoxp/xoxb`で認証できる。認証情報はSDK引数または環境変数で渡す。自動抽出・保存・OAuthサーバーを作らない。
2. SDK・CLI・MCPが同じ検証と操作を使用する。単一パッケージ、ESM、Node 22以上。GUI・プラグインシステム・独自DB・常駐サーバーを導入しない。
3. 基本操作: 認証確認、チャンネル一覧、履歴、スレッド、検索、メッセージ送信、Lists項目の一覧/追加/更新、Canvas末尾へのMarkdown追記。
4. `saved.list`と`client.counts`だけを実験的なWeb内部APIとして分離する。ブラウザ認証と明示的な実験機能の有効化が必要。未知のレスポンス項目はunknownとして保持し、検証していない完全な型を主張しない。
5. 読み取りが既定。書き込みはSDK/CLI/MCPの明示的なオプトインが必要。MCPに任意API、shell、任意ファイルアクセスを公開しない。
6. 公式レスポンス型は再利用する。結果はSlackの形を維持し、cursor/pageを明示する。無制限な自動巡回、全ワークスペースの一括取得、検索キャッシュを作らない。
7. HTTP 429のRetry-After、Slackのok:false、権限不足、認証失効、タイムアウトを構造化エラーとして返す。特に書き込みは自動再試行せず、通信断で結果が不明な場合を区別する。
8. 認証情報をログや成果物に含めない。Slack以外へのリダイレクトに追従しない。MCPのstdoutはプロトコル専用。
9. 実通信を模したHTTPテスト、CLI実行テスト、MCPハンドシェイク・呼び出しテスト、ビルド、npmパッケージ化を確認する。実アカウントの送信テストは実施しない。

## 対象と配布範囲

「Slack App不要」「個人と少人数の開発者向け」を要件とする。成果物はSDK・CLI・MCPの単一パッケージ。ソースを非公開GitHubリポジトリで管理し、認証情報、レビュー会話の原文、ローカル実行ログは含めない。npmリリース・外部デプロイは初版の範囲外。

## 今回見送るもの

全APIの体系化、Chrome cookieの自動取得、トークン保管庫、複数プロフィール、巨大なモノレポ、独自OAuthフロー、ファイルアップロード、Canvas全文読み取り/置換、削除操作、画面UI、定期同期。初版を使い、必要性と実アカウントでの動作が確かめられたものだけ追加する。

## 未検証・残る制約

- 認証済みSlackでの動作は、ユーザーが選んだ認証情報を設定した後に確認する。環境変数がなければライブ検証済みとは表示しない。
- 内部APIはSlackの変更で壊れる可能性がある。公式APIの利用でもブラウザトークンのサポートはSlackの保証対象としない。
- Listsの列ID/行IDは対象のListから取得する。自然言語から列を自動推定しない。
- 商業的な差別化はユーザー利用で検証する。既存ツールを置き換えるという主張をしない。

## モデルレビュー

DeepSeek Harness経由でStellaのClaude Sonnet 5.5およびGrok 4.7へこの計画を渡した。[REVIEW.md](./REVIEW.md)に採否を記録する。モデルの指摘は根拠を確認して判断する。
