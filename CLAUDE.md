# furious-tp — 臺北開放資料 3D 數位孿生

臺北市全域可駕駛 3D 數位孿生:純臺灣開放資料(NLSC 3D Tiles 建物、內政部 20m DTM、data.taipei、OSM),桌機瀏覽器、公開免登入。PRD 與 RFC(架構決策 D1–D10)在 Linear 專案文件;工作流程遵循 yclaude-force(Linear team key: FTP)。

## Modules

- `web-client/` — TypeScript;CesiumJS + Rapier WASM(RFC D1/D8)。目前為 scaffold。
- `scene-pipeline/` — Python 離線場景編譯(尚未建立;RFC 模組 1)。
- `contracts/` — pipeline↔client 的 tile 格式契約(尚未建立;RFC D7)。merge = finalized,不在 CODEOWNERS 管轄。

## Commands (web-client)

```bash
cd web-client
npm run lint / typecheck / build / test
```

## Workflow rules (agents)

- Branch model:feature → `develop`(PR + 兩層 review)→ `test` 自動部署 → `main` 只在 human 明確指示時 merge。
- Branch 命名:`<type>/FTP-<n>-<slug>`;squash merge 標題 `FTP-<n>: <summary>`。
- PR body 用 `Refs FTP-<n>`,禁止 auto-close 關鍵字(ticket 由 Verifier 關,不由 merge 關)。
- 一張 PR 對一張 ticket;不在 ticket Scope 外改檔案。
- 治理檔(本檔、.github/workflows/、DESIGN.md、CODEOWNERS)只有 human 能 merge。

## Language

Tickets、文件、面向 owner 的溝通:繁體中文(zh-TW)。程式碼與註解:英文。
