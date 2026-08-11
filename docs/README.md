# Docs 索引

專案文件的入口。新增任何文件時,同一個 PR 必須更新本索引。

## 環境與流程

- [TEST-ENV.md](TEST-ENV.md) — test 環境:URL、部署流程、前置條件、本機 e2e
- [RELEASE.md](RELEASE.md) — 發布機制與 post-release 門檻(R-tier)
- [SECRETS.md](SECRETS.md) — secrets 結構與命名慣例(值不進 repo)

## 支援範圍

- [BROWSERS.md](BROWSERS.md) — 瀏覽器/裝置支援矩陣(Chrome 主測)
- [`web-client/bench/RIG.md`](../web-client/bench/RIG.md) — bench reference rig 規格、量測條件與開跑前檢查(RFC D6;效能判定所依據的機器)

## 調查(spikes)

- `spikes/` — 動工前查證報告(NLSC 服務、授權相容性;隨 FTP-5/FTP-6 產出)
  - [spikes/nlsc.md](spikes/nlsc.md) — Spike R1:NLSC 三維國家底圖 3D Tiles 服務可行性與條款查證
  - `spikes/nlsc-probe.mjs` — R1 可重跑量測 script(實驗用,不進正式模組);自我測試 `spikes/nlsc-probe.selftest.mjs`
  - [spikes/spike-r5-licensing.md](spikes/spike-r5-licensing.md) — Spike R5:衍生 tiles 散布授權相容性(ODbL × 政府開放授權)

## Repo 根目錄的治理檔

- [`CLAUDE.md`](../CLAUDE.md) — 專案指示與 agent 工作規則
- [`DESIGN.md`](../DESIGN.md) — 視覺設計規範(canonical design.md 格式)
- [`LICENSING.md`](../LICENSING.md) — 編譯產物(tiles)之資料授權與散布義務(草案;Spike R5 產出)
- 需求與架構(PRD/RFC):Linear 專案「臺北開放資料 3D 數位孿生城市」文件
