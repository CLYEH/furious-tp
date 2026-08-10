# 發布與 post-release 門檻

M0 定案(FTP-18,human `[approve]` 2026-08-10)。`/release` 的 post-release check 消費本檔數字;觀察窗未以零觸發收場不得關閉發布窗。

## R-tier 門檻

| 項目 | 值 |
|---|---|
| 觀察窗 | 發布後 **30 分鐘** |
| 錯誤率 | 超過七日基線 **2×** 且持續 **5 分鐘** → 觸發 |
| 新錯誤簽名 | 任何未見過的 client error 簽名 → 觸發 |
| 延遲(首屏) | 首屏可互動 p95 ≤ **5s**(reference 網路) |
| 延遲(tile) | tile 首批載入 p95 ≤ **3s** |

任何觸發 → 加 `needs-human` 標籤 + 評估 revert;零觸發滿 30 分鐘 = 發布窗關閉。

## 發布機制(development-workflow §4)

- Milestone 驗收(Gate 3)由 human 於 test 環境完成;核准即發布指令。
- 發布 = `main` merge 至 **pinned commit**(milestone 最後一張票通過驗證當下的 test 狀態),不是 test tip。
- Pin 記錄兩處:git tag `milestone/<slug>` + Linear milestone note。
- Web 單段發布;發布後執行本檔的 post-release check。

## 現況備註

第一版為靜態站(GitHub Pages = test;正式環境於 M4 定案)。錯誤率與錯誤簽名的量測來源(client error 回報機制)於 M1 web-client 加入 console/error 蒐集後生效;在那之前 post-release check 以延遲兩項 + 手動 smoke 為準。
