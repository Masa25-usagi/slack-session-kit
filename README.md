# Slack Session Kit (0.1.0)

Slack App の新規作成・管理を行わずに、自分や少人数の開発者がスクリプトや AI エージェント（MCP）から Slack ワークスペースを操作するための TypeScript SDK、薄い CLI、stdio MCP サーバーです。

単一パッケージ、Pure ESM、Node 22 対応。公式レスポンス型を再利用し、小さな実装と厳格な安全設計を重視しています。

---

## ⚠️ 重要: 未公開パッケージおよび実機未検証の明記

> 1. **本パッケージは npm レジストリに公開されていません。**  
>    インストールはビルド済みのローカル tarball（`npm install ./slack-session-kit-0.1.0.tgz`）から行うか、本リポジトリ内で直接ビルド・実行してください。
> 2. **すべての実 Slack 通信は未検証（Unverified）です。**  
>    本リポジトリのテスト・動作確認はすべて合成モック（Synthetic HTTP Fixtures）およびサブプロセス実行テストによって実施されています。実行環境に本番 Slack の認証情報は設定されておらず、本番ワークスペースでの実際の通信は未検証です。利用時は読み取り操作から慎重に確認してください。

---

## 主な特徴と設計方針

1. **セッション認証 & 公式 OAuth の両対応**
   - ブラウザの Web セッション (`xoxc-...` トークン + `d` cookie) に対応。
   - Slack App の User トークン (`xoxp-...`) や Bot トークン (`xoxb-...`) にも対応。
   - OAuth トークン利用時は、環境変数にブラウザ Cookie が存在していても誤送信しないようクライアント側で厳格に分離。
2. **読み取り既定（Read-by-Default）& 明示的書き込みオプトイン**
   - 誤送信や意図しない変更を防ぐため、書き込み操作は明示的に許可（`allowWrite: true` または `--write`）しない限り実行できません。
3. **書き込み結果不明（Write Result Unknown）の区別**
   - メッセージ送信やリスト更新などの書き込み操作中にタイムアウト・通信切断・サーバー5xx・レスポンス破損が発生した場合、Slack 側で処理されたか不明な状態（`WRITE_RESULT_UNKNOWN`）としてエラーを返します。**自動再試行は行いません**。
4. **秘密情報のマスキング（Secret Redaction）**
   - トークンや Cookie（Base64 記号 `+/=` や URL エンコードされた `%` 表記を含む値）、設定された認証情報がエラーメッセージやスタックトレース、CLI のエラー出力に現れた場合、`[REDACTED]` でマスクする処理を適用します（完全な漏洩防止を保証するものではありません）。
5. **ホスト検証（Host Gate）とリダイレクト拒絶**
   - 認証情報の漏洩を防ぐため、HTTPS の本番 Slack ドメイン（`https://slack.com/api/*` または `https://*.slack.com/api/*`）およびテスト用の完全一致ローカルループバック（`127.0.0.1`, `localhost`）のみを許可します。
   - `http://localhost.attacker.example` などのバイパス試行やクエリ文字列・ハッシュを含む URL は通信前に遮断します。
   - リダイレクト（3xx）は追従せず即座に拒絶します。
6. **Cookie Encoding & インジェクション防止**
   - `d` Cookie は単一の d 値として受け付け、改行コード（CRLF）やセミコロンによる HTTP ヘッダーインジェクションを遮断し、二重エンコードを防止します。
7. **dotenv の自動読み込みを行わない & CLI は環境変数認証のみ**
   - ライブラリがカレントディレクトリの `.env` を自動読込することはありません。
   - CLI 引数から `--token` 等のフラグを排除し、`ps aux` などのプロセス一覧からのトークン漏洩を防止（環境変数のみから取得）。
8. **公式 MCP SDK 準拠 & stdio プロトコル専用**
   - MCP サーバーの標準出力（`stdout`）は JSON-RPC プロトコル専用です。すべてのログ出力は `stderr` にルーティングされます。
   - 任意のシェル実行、ファイル操作、任意 API 呼び出しツールは一切公開しません。
   - MCP の書き込みツールは **既定で非登録** です。
   - SDK、CLI、MCP で共通の Zod スキーマ（`.shape`）を共有し、検証ルールが乖離しません。

---

## 認証方式と Capability マトリクス

認証タイプに応じて、確実な非対応と実機未検証を区別しています。

| 操作 | 公式 API / 内部 | Browser Session (`xoxc` + `d`) | User OAuth (`xoxp`) | Bot OAuth (`xoxb`) | 必要スコープ / 備考 |
| :--- | :--- | :---: | :---: | :---: | :--- |
| `auth.test` | 公式 | ✅ 対応 | ✅ 対応 | ✅ 対応 | 認証確認 |
| `conversations.list` | 公式 | ✅ 対応 | ✅ 対応 | ✅ 対応 | 会話種別に応じて `channels:read`, `groups:read`, `im:read`, `mpim:read` |
| `conversations.history` | 公式 | ✅ 対応 | ✅ 対応 | ✅ 対応 | 会話種別に応じて `channels:history`, `groups:history`, `im:history`, `mpim:history` |
| `conversations.replies` | 公式 | ✅ 対応 | ✅ 対応 | ✅ 対応 | 会話種別に応じて `channels:history`, `groups:history`, `im:history`, `mpim:history` |
| `search.messages` | 公式 | ✅ 対応 | ✅ 対応 | ❌ **確実な非対応** | Bot トークンは Slack 公式仕様で検索非対応（通信前に遮断） |
| `chat.postMessage` | 公式 | ✍️ 要オプトイン | ✍️ 要オプトイン | ✍️ 要オプトイン | `chat:write`（書き込み許可必須） |
| `slackLists.items.list` | 公式 | ⚠️ **実機未検証** | ✅ 対応 | ✅ 対応 | 公式スコープ: `lists:read`（プラン・権限依存） |
| `slackLists.items.create` | 公式 | ⚠️ **実機未検証** | ✍️ 要オプトイン | ✍️ 要オプトイン | 公式 `initial_fields` 配列形式（書き込み許可必須） |
| `slackLists.items.update` | 公式 | ⚠️ **実機未検証** | ✍️ 要オプトイン | ✍️ 要オプトイン | 公式 `cells` 配列形式（`row_id`+`column_id`）（書き込み許可必須） |
| `canvases.edit` (追記) | 公式 | ⚠️ **実機未検証** | ✍️ 要オプトイン | ✍️ 要オプトイン | 公式アクション: `insert_at_end`（書き込み許可必須） |
| `saved.list` | 内部 (Web) | 🧪 **要実験オプトイン** | ❌ **非対応** | ❌ **非対応** | ブラウザセッション専用・unknown保持 |
| `client.counts` | 内部 (Web) | 🧪 **要実験オプトイン** | ❌ **非対応** | ❌ **非対応** | ブラウザセッション専用・unknown保持 |

- **会話スコープの注意**: `conversations.*` メソッドは対象チャンネルの種別（パブリック、プライベート、DM、グループDM）に応じて必要なスコープ（`channels:*`, `groups:*`, `im:*`, `mpim:*`）が異なります。現行の公式仕様に基づき、Bot トークンでも各スコープが付与されていればスレッド返信の取得が可能です。
- **確実な非対応**: 事前チェックによりリクエスト送信前に `CapabilityError` をスローします。
- **実機未検証**: ブラウザセッションにおける Lists や Canvas はワークスペースのプランや権限に依存します。事前拒否はせず呼び出しますが、Slack が返す権限エラー（`missing_scope` など）を構造化エラーとして保持します。
- **Lists ワイヤフォーマット**: 公式 API 仕様に準拠し、項目作成時は `initial_fields` 配列（各要素に `column_id` と型別値）、項目更新時は `cells` 配列（各要素に `row_id`, `column_id` と値）を使用します。
- **Canvas 追記**: 公式の `insert_at_end` アクションを用いた Markdown 追記のみをサポートします（全文置換や削除は初版対象外）。
- **内部 API**: レスポンスは最小限の shape 検証のみを行い、スキーマを偽らず `unknown` として保持します。

---

## インストールと利用準備

本パッケージは未公開のため、ビルド済み成果物からローカルインストールするか、リポジトリ内で直接実行します。

### クローンしたリポジトリからの実行

Node.js 22以上を用意し、リポジトリのルートで実行してください。`dist/` と tarball はGitに含めず、手元で生成します。

```bash
npm ci
npm run build
node dist/cli/bin.js --help
```

### ローカル tarball からのインストール
```bash
# パッケージのビルドと成果物作成
npm run build
npm pack

# 他プロジェクトへインストールする場合
npm install /path/to/slack-session-kit/slack-session-kit-0.1.0.tgz
```

---

## 環境設定と設定の優先順位

`.env` の自動読込は行いません。シェルの環境変数等で設定してください。

### 初期設定例（安全のため false から開始）
```bash
# ブラウザセッションを使う場合
export SLACK_SESSION_TOKEN="xoxc-..."
export SLACK_COOKIE_D="xoxd-..."

# または OAuth トークンを使う場合
# export SLACK_TOKEN="xoxp-..."

# 安全設定（初期値は false）
export SLACK_ALLOW_WRITE=false
export SLACK_ALLOW_EXPERIMENTAL=false
```

### 設定の優先順位
1. **SDK**: コンストラクタ引数（`allowWrite` 等） > 環境変数（`SLACK_ALLOW_WRITE` 等） > 既定値（`false`）
2. **CLI**: コマンドラインフラグ（`--write` 等） > 環境変数（`SLACK_ALLOW_WRITE` 等） > 既定値（`false`）

---

## SDK 利用方法

SDK エントリポイント（`slack-session-kit`）は MCP や CLI をインポートしないため、軽量にバンドルされます。

```typescript
import {
  SlackSessionKit,
  WriteNotAllowedError,
  WriteResultUnknownError,
  SlackRateLimitError,
} from 'slack-session-kit';

const slack = new SlackSessionKit({
  token: process.env.SLACK_SESSION_TOKEN,
  cookieD: process.env.SLACK_COOKIE_D,
  allowWrite: false, // 既定は読み取り専用
});

// 1. 認証確認
const auth = await slack.authTest();
console.log(`Logged in as: ${auth.user}`);

// 2. チャンネル一覧（ページングとtypes対応）
const channels = await slack.listChannels({
  types: 'public_channel,private_channel',
  limit: 50,
});

// 3. Lists 項目作成（公式 initial_fields 配列。テキスト列は rich_text ブロック構造、または checkbox 等の型指定が必要）
// await slack.createListItem({
//   list_id: 'L12345678',
//   initial_fields: [
//     {
//       column_id: 'col_task',
//       rich_text: [
//         {
//           type: 'rich_text',
//           elements: [
//             {
//               type: 'rich_text_section',
//               elements: [{ type: 'text', text: 'Task description' }],
//             },
//           ],
//         },
//       ],
//     },
//     { column_id: 'col_done', checkbox: false },
//   ],
// });

// 4. Lists 項目更新（公式 cells 配列。row_id + column_id + 型別プロパティ）
// await slack.updateListItem({
//   list_id: 'L12345678',
//   cells: [
//     { row_id: 'row_1', column_id: 'col_done', checkbox: true },
//   ],
// });
```

---

## CLI 利用方法

プロセス一覧（`ps`）による機密情報の漏洩を防ぐため、認証情報は環境変数からのみ読み込みます。本フォルダから直接実行する場合は `node dist/cli/bin.js` を使用します。

```bash
# ヘルプ表示
node dist/cli/bin.js --help

# 認証確認
node dist/cli/bin.js auth-test

# チャンネル一覧
node dist/cli/bin.js list-channels --types public_channel,private_channel --limit 30

# 会話履歴
node dist/cli/bin.js history --channel C12345678 --limit 20

# スレッド返信取得
node dist/cli/bin.js replies --channel C12345678 --ts 1700000000.123456

# 検索
node dist/cli/bin.js search --query "リリース作業"

# メッセージ送信（--write が必須）
node dist/cli/bin.js send-message --channel C12345678 --text "デプロイ完了" --write

# Lists 項目作成（--write が必須、公式 initial-fields 配列: checkbox や rich_text ブロック構造を使用）
node dist/cli/bin.js create-list-item --list-id L12345678 --initial-fields '[{"column_id":"c1","checkbox":true}]' --write

# Lists 項目更新（--write が必須、公式 cells 配列: row_id + column_id + 値）
node dist/cli/bin.js update-list-item --list-id L12345678 --cells '[{"row_id":"r1","column_id":"c1","checkbox":false}]' --write

# Canvas 追記（--write が必須）
node dist/cli/bin.js append-canvas --canvas-id F12345678 --markdown "## ログ追記\n- 正常終了" --write

# 実験的機能: 保存済みアイテム（--experimental が必須、ブラウザセッション専用）
node dist/cli/bin.js list-saved --experimental
```

---

## MCP サーバー (stdio)

AI アシスタント（Claude Desktop, Cursor, Gemini CLI 等）から Slack をツールとして利用するための Model Context Protocol (MCP) stdio サーバーです。

### セキュリティ方針
- **既定は読み取り専用**: 書き込みツール（`send_message`, `create_list_item`, `update_list_item`, `append_canvas`）は登録されません。
- **明示的オプトイン**: 環境変数 `SLACK_ALLOW_WRITE=true` を指定した場合のみ書き込みツールが MCP クライアントに公開されます。
- **stdio の安全性**: 標準出力（stdout）は MCP JSON-RPC 通信用に保護され、ログは stderr に出力されます。
- **危険ツールの排除**: 任意 API、シェル実行、ファイルアクセスツールは公開しません。

### Claude Desktop 等での設定例 (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "slack": {
      "command": "node",
      "args": ["/absolute/path/to/slack-session-kit/dist/mcp/bin.js"],
      "env": {
        "SLACK_SESSION_TOKEN": "xoxc-...",
        "SLACK_COOKIE_D": "xoxd-...",
        "SLACK_ALLOW_WRITE": "false"
      }
    }
  }
}
```

---

## ページングとチャンネル types

- **ページング**: Slack API の仕様に準拠し、`cursor` パラメータとレスポンスの `response_metadata.next_cursor` を明示的に扱います。無制限な全件自動巡回やキャッシュは行いません。
- **チャンネル types**: `conversations.list` ではカンマ区切りで `public_channel,private_channel,mpim,im` を指定できます。

---

## エラーハンドリング仕様

| エラークラス | code | 説明 |
| :--- | :--- | :--- |
| `SlackSessionKitError` | `SLACK_SESSION_KIT_ERROR` | 基底エラークラス。メッセージや詳細内のトークン等はマスク処理されます。 |
| `WriteNotAllowedError` | `WRITE_NOT_ALLOWED` | 書き込み操作がオプトインなしで実行された場合。 |
| `WriteResultUnknownError` | `WRITE_RESULT_UNKNOWN` | 書き込み中にタイムアウト・切断・5xx・レスポンス破損が発生し、結果が不明な場合（再試行禁止）。 |
| `SlackRateLimitError` | `RATE_LIMIT_EXCEEDED` | HTTP 429 発生時。`retryAfterSeconds` プロパティを保持。 |
| `SlackTimeoutError` | `TIMEOUT` | 読み取り操作がタイムアウトした場合。 |
| `SlackApiError` | `SLACK_API_ERROR` | Slack が `ok: false` を返した場合。`error`, `needed`, `provided` を保持。 |
| `CapabilityError` | `CAPABILITY_UNSUPPORTED` | Bot トークンでの検索など、非対応な操作を実行した場合。 |
| `RedirectRefusedError` | `REDIRECT_REFUSED` | Slack API 以外へのリダイレクトや 3xx を検知して遮断した場合。 |

---

## 開発と検証コマンド

```bash
# 型チェック
npm run check

# ビルド (dist/ 生成)
npm run build

# テスト実行 (ユニット、モックHTTP SDK、CLIプロセス、MCPクライアント)
npm test

# パッケージ作成 (tgz 成果物生成)
npm pack
```

---

## ライセンス

MIT
