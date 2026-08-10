# DESIGN.md — furious-tp 視覺設計規範

> 狀態:草案(FTP-16)。本檔為 design tickets 的 rubric:Design Critic 依此審查、UIUX Designer 依此產出。修改本檔 = 治理變更,僅 human 可 merge(CODEOWNERS)。

## 1. 產品視覺定位

駕駛視角的城市數位孿生。UI 是**覆蓋在 3D 場景上的儀表層**,永遠讓場景當主角:

- UI 佔螢幕面積 ≤ 15%(教學與選單全屏狀態除外)。
- 場景永遠可見:選單用半透明遮罩(不做不透明全屏,除首頁/載入)。
- 資訊密度低:駕駛中同時可見的文字元素 ≤ 5 個。

## 2. 色彩 tokens

深色為主(夜間駕駛儀表慣例;3D 場景亮暗都壓得住):

| Token | 值 | 用途 |
|---|---|---|
| `--bg-hud` | `rgba(10, 14, 20, 0.72)` | HUD 卡片底 |
| `--bg-overlay` | `rgba(6, 8, 12, 0.85)` | 選單遮罩 |
| `--fg-primary` | `#F2F5F8` | 主要文字/數字 |
| `--fg-secondary` | `#9AA7B4` | 次要文字、單位 |
| `--accent` | `#3DDC97` | 速度、確認、正常狀態 |
| `--warning` | `#FFB454` | 降級提示、連線警告 |
| `--danger` | `#FF5D5D` | 錯誤、不可用 |
| `--stroke` | `rgba(255,255,255,0.12)` | 卡片邊線 |

規則:accent 一次只出現在一個語意上;純白 `#FFF` 不用(過亮搶場景)。

## 3. 字體與尺寸

- 字體:系統堆疊 `system-ui, "Noto Sans TC", sans-serif`;數字(速度)用 `font-variant-numeric: tabular-nums`。
- 尺寸階:12 / 14 / 16 / 20 / 28 / 44(px @1080p);速度數字固定 44,街名 20,其餘 UI 14–16。
- 駕駛中可讀性:HUD 文字對 `--bg-hud` 對比 ≥ 4.5:1。

## 4. 版面與間距

- 間距單位 8px;卡片圓角 12px;HUD 距螢幕邊緣 24px。
- HUD 佈局:左下=速度;右下=小地圖;上中=街名/行政區;右上=連線狀態(僅異常時出現)。
- 安全區:中央 60% 視野永遠無 UI(駕駛視線)。

## 5. 元件清單(基礎可重用元件)

1. **HudCard** — 半透明卡片容器(bg-hud + stroke + 12px 圓角)
2. **SpeedReadout** — 速度數字 + 單位(tabular nums)
3. **StreetLabel** — 街名/行政區(超長截斷,fade 進出 200ms)
4. **MiniMap 容器** — 圓角方形,含玩家箭頭層
5. **StatusPill** — 連線/降級狀態(accent/warning/danger 三態)
6. **MenuPanel** — 全屏半透明選單(標題 + 項目列 + 關閉)
7. **Toggle / Slider / Button** — 選單內表單元件(僅此三種)
8. **AttributionBar** — 資料來源標示(常駐左下角小字,點開展開完整授權)

## 6. 動態與回饋

- 過場一律 ≤ 200ms ease-out;駕駛中不做會動的裝飾動畫。
- 降級狀態(tile 逾時)出現/消失要漸變,不閃爍。
- 任何 UI 動畫不得掉 frame:動畫只用 transform/opacity。

## 7. 狀態覆蓋(每個 screen 的 design ticket 必交付)

每張 design ticket 至少涵蓋:default / loading / error(降級)/ empty(資料缺)/ 極端內容(超長街名、螢幕縮放 1280px 寬)。

## 8. 無障礙

- 全 UI 可鍵盤操作(選單 Tab 循環;Esc 關閉)。
- 對比:正文 ≥ 4.5:1,大字(≥20px)≥ 3:1。
- 不以顏色為唯一資訊管道(狀態 pill 附文字)。

## 9. 明確不做

- 淺色主題(第一版單一深色;PRD 桌機 only)
- 響應式手機版面(PRD out of scope)
- 自訂字體載入(效能預算優先)
- 裝飾性粒子/光暈效果
