---
version: alpha
name: furious-tp
description: 臺北開放資料 3D 數位孿生 — 駕駛視角 HUD 覆蓋層設計系統
colors:
  background: "#05080C"
  surface: "rgba(10, 14, 20, 0.72)"
  overlay: "rgba(6, 8, 12, 0.85)"
  on-surface: "#F2F5F8"
  on-surface-muted: "#9AA7B4"
  primary: "#3DDC97"
  primary-hover: "#5FE7AC"
  warning: "#FFB454"
  error: "#FF5D5D"
  stroke: "rgba(255, 255, 255, 0.12)"
typography:
  speed-display:
    fontFamily: 'system-ui, "Noto Sans TC", sans-serif'
    fontSize: "44px"
    fontWeight: 700
    lineHeight: 1
    fontFeature: "tnum"
  title-lg:
    fontFamily: 'system-ui, "Noto Sans TC", sans-serif'
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.25
  headline-md:
    fontFamily: 'system-ui, "Noto Sans TC", sans-serif'
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
  label-md:
    fontFamily: 'system-ui, "Noto Sans TC", sans-serif'
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.4
  body-md:
    fontFamily: 'system-ui, "Noto Sans TC", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label-sm:
    fontFamily: 'system-ui, "Noto Sans TC", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: "8px"
  md: "12px"
  full: "999px"
spacing:
  xs: "8px"
  sm: "16px"
  md: "24px"
components:
  hud-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: "16px"
  speed-readout:
    typography: "{typography.speed-display}"
    textColor: "{colors.primary}"
  street-label:
    typography: "{typography.headline-md}"
    textColor: "{colors.on-surface}"
  minimap:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    size: "200px"
  status-pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: "8px"
  status-pill-warning:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.warning}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: "8px"
  status-pill-error:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.error}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: "8px"
  menu-panel:
    backgroundColor: "{colors.overlay}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: "24px"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.background}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: "12px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.background}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: "12px"
  attribution-bar:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.label-sm}"
---

## Overview

furious-tp 是駕駛視角的臺北城市數位孿生(桌機瀏覽器、公開免登入)。UI 是**覆蓋在 3D 場景上的儀表層**,永遠讓場景當主角:冷靜、精確、低干擾,像夜間駕駛儀表——資訊在需要時清楚存在,不需要時近乎隱形。情緒基調:專注、可信賴、有一點未來感,但不炫技。

- UI 佔螢幕面積 ≤ 15%(教學與選單全屏狀態除外)。
- 場景永遠可見:選單用半透明遮罩,不做不透明全屏(首頁/載入除外)。
- 資訊密度低:駕駛中同時可見的文字元素 ≤ 5 個。

## Colors

深色為主(夜間駕駛儀表慣例;3D 場景亮暗都壓得住)。`background`(#05080C)只用於全屏底與按鈕反白文字;HUD 卡片一律 `surface`(半透明深藍黑),選單遮罩用更深的 `overlay`。文字兩階:`on-surface`(#F2F5F8)主要、`on-surface-muted`(#9AA7B4)次要與單位。語意色三支:`primary`(#3DDC97)= 速度、確認、正常;`warning`(#FFB454)= 降級提示、連線警告;`error`(#FF5D5D)= 錯誤、不可用。規則:**primary 一次只出現在一個語意上**;純白 #FFFFFF 不用(過亮搶場景);`stroke` 是卡片唯一的邊界手段。

## Typography

單一系統字族 `system-ui, "Noto Sans TC", sans-serif`,不載入自訂字體(效能預算優先)。型階六級:`speed-display`(44px/700,`tnum` 等寬數字,僅速度)、`title-lg`(28px,選單標題)、`headline-md`(20px,街名/行政區)、`label-md`(16px,控制項)、`body-md`(14px,正文)、`label-sm`(12px,單位、來源標示)。駕駛中可讀性:HUD 文字對 `surface` 對比 ≥ 4.5:1;數字一律 tabular。

## Layout

間距單位 8px(`spacing.xs`),節奏 8/16/24。HUD 距螢幕邊緣 24px(`spacing.md`)。固定佈局區:左下=速度;右下=小地圖;上中=街名/行政區;右上=連線狀態(僅異常時出現);左下角最底=資料來源標示。**安全區:中央 60% 視野永遠無 UI**(駕駛視線)。桌機 only,最小支援寬度 1280px;不做手機響應式。

## Elevation & Depth

不用陰影堆疊——深度由**半透明層**表達:場景(0)→ `surface` HUD 卡(1)→ `overlay` 選單遮罩(2)。卡片邊界用 1px `stroke`,不用 drop shadow;避免 backdrop blur(GPU 預算留給場景)。

## Shapes

卡片與面板 12px(`rounded.md`);表單控制 8px(`rounded.sm`);狀態 pill 全圓(`rounded.full`)。無銳角裝飾、無斜切;小地圖為圓角方形。

## Components

基礎可重用元件(YAML `components` 為 normative):

1. **hud-card** — 所有 HUD 資訊的容器。
2. **speed-readout** — 速度數字 + 單位;數字 `speed-display`,單位 `label-sm` muted。
3. **street-label** — 街名/行政區;超長截斷,fade 進出 200ms。
4. **minimap** — 圓角方形容器,含玩家箭頭層。
5. **status-pill** — 連線/降級狀態;normal/warning/error 三態(見變體 token),狀態一律「色 + 文字」雙通道。
6. **menu-panel** — 全屏半透明選單(標題 `title-lg` + 項目列 + 關閉);Esc 關閉、Tab 循環。
7. **button-primary** — 主要動作;hover 亮一階(`button-primary-hover`);表單控制僅 Button/Toggle/Slider 三種。
8. **attribution-bar** — 常駐左下角來源標示,點開展開完整授權文字。

每張 design ticket 至少交付:default / loading / error(降級)/ empty(資料缺)/ 極端內容(超長街名、1280px 寬)。

## Do's and Don'ts

- Do:過場一律 ≤ 200ms ease-out;動畫只用 transform/opacity(不觸發 layout/paint)。
- Do:降級狀態(tile 逾時)出現/消失用漸變,絕不閃爍。
- Do:全 UI 可鍵盤操作;對比正文 ≥ 4.5:1、大字(≥20px)≥ 3:1。
- Do:狀態一律附文字,不以顏色為唯一資訊管道。
- Don't:淺色主題(第一版單一深色)。
- Don't:手機響應式版面(PRD out of scope)。
- Don't:自訂字體載入、裝飾性粒子、光暈、backdrop blur。
- Don't:駕駛中出現任何會動的裝飾動畫。
