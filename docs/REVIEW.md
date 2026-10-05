# 計画レビューと採否

2026-10-05。計画: [PLAN.md](./PLAN.md)。リーダー: Codex。実装担当: AntigravityのGemini 3.8 Flash。

## 他モデルへの依頼

DeepSeek HarnessからStella経由でClaude Sonnet 5.5とGrok 4.7に同じ計画を渡し、レビューを受けた。

採否は一次資料と対象範囲で決める。以下に製品に関係する指摘と判断を残す。レビュー会話の原文はリポジトリに含めない。モデル名はStellaの一覧と送信ルートで確認したもので、提供元内部の推論エンジンを独自検証したものではない。

## 採用

- 認証形式と操作可否を分ける。botで検索、OAuthで内部APIなど、分かっている非対応は通信前に明示する。Lists/Canvasは権限・プラン依存で、ブラウザ認証での実機互換性は未検証とする。
- 公式APIと非公開APIを区別する。ブラウザ認証自体もSlackの公式保証対象とは表現しない。
- 読み取りを既定にし、MCPに既定で書き込みツールを登録しない。書き込み許可を明示する。Slack本文は第三者由来のデータで、エージェントの指示とは扱わない。
- 書き込みを自動再試行しない。タイムアウト・通信断で結果が不明なら、それを成功/失敗の確定と区別する。
- エラーを構造化し、秘密情報をマスクする。cookieは単一のd値として受け付け、二重のURLエンコードやヘッダへの不正入力を避ける。
- SDK入口でCLI/MCPを読み込まない。各entryは分けるが、単一パッケージを維持する。
- 内部APIのfixtureは合成データであると明示する。レスポンス変化により必要な形がなくなったらエラーにする。未知の項目はunknownとして保持する。
- ページング、チャンネルtypes、MCPのstdoutとエラー仕様をREADMEに記載する。

## 修正して採用／不採用

- Claudeの `slackLists:read/write` というスコープ名は誤り。公式は [`lists:read`](https://docs.slack.dev/reference/methods/slackLists.items.list/) / [`lists:write`](https://docs.slack.dev/reference/methods/slackLists.items.create/)。
- Claudeの「xoxcではLists/Canvasが必ず使えない」は根拠不足。公式OAuthのスコープ要件だけから非公式セッションの挙動は断定しない。互換性未検証を明示し、Slackが返す権限エラーを保持する。
- Claudeの「searchは1req/min」は誤り。 [`search.messages`](https://docs.slack.dev/reference/methods/search.messages/) はTier 2と記載されている。数値の独自制御を加えずRetry-Afterを返す。
- GrokのCanvas追記への疑義には、公式 [`canvases.edit`](https://docs.slack.dev/reference/methods/canvases.edit/) が `insert_at_end` とMarkdownの `document_content` を明示していることで対応する。追記だけを実装し、全文置換・削除は実装しない。
- OAuthを認証確認だけに限定する提案は不採用。公式対応のAPIを同じ小さな操作面で使えることは有益で、認証対応表と実行時エラーで差を示せる。
- 全操作にteam_id必須という提案は不採用。対象がworkspace tokenである場合もある。必須性を推測で増やさない。
- トークンの「30日有効」、利用規約の特定条文・罰則、汎用の冪等性保証など、確認できない断定は製品説明に入れない。
- OSキーチェーン、独自認証ファイル保存、スナップショット基盤、巨大な安全ポリシーシステム、進捗通知基盤は初版の対象外。環境変数・SDK引数、既定読み取り、小さなテストで必要な範囲を満たす。

## 公開前に必要な確認

現時点の受け入れは実装と合成HTTP/プロセスによる検証まで。ユーザーが選んだSlack資格情報で認証・読み取りを確認する必要がある。今回、Slackの本番アカウントへのメッセージ送信やList/Canvas更新は行わない。ライブ未検証の機能を「実機動作確認済み」と表示しない。
