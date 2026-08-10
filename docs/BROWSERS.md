# 瀏覽器/裝置支援矩陣

M0 定案(FTP-17,human `[approve]` 2026-08-10)。桌機 only(PRD out of scope:手機)。

| 瀏覽器 | 承諾等級 | 說明 |
|---|---|---|
| Chrome 最新穩定版 | **主要支援** | 效能承諾基準:bench(60 FPS 判定)只在 Chrome 上量 |
| Edge 最新穩定版 | 抽查 | 同 Blink 引擎,每個 milestone 驗收抽查 smoke |
| Firefox 最新穩定版 | 相容性抽查 | WebGL2 能跑、功能可用;**無效能承諾** |
| Safari | 不承諾 | 桌機市佔低 + WebGL2 行為差異大;M4(公開發布)前重新評估 |

- 最低 API:WebGL 2;不支援時顯示系統需求頁(PRD §6)。
- 最小視窗寬度:1280px(DESIGN.md Layout)。
- M-tier(milestone 驗收)執行方式:Playwright smoke 以 chromium + firefox 各跑一次;Edge 以 channel=msedge 抽查。webkit 不在矩陣內。
