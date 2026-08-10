# contracts — pipeline ↔ client tile 契約層

`contracts/` 是 `scene-pipeline/`(Python 離線編譯)與 `web-client/`(CesiumJS + Rapier)之間唯一的介面定義來源(RFC D7)。契約為 renderer 中立:任何一端只依賴本目錄的 spec 與常數,不依賴對方的實作。

## 定位

- **spec/** — 規範性文件。`spec/grid.md` 定義 EPSG:3826 tile 網格、per-tile 座標框架與量化、ECEF 轉換慣例(RFC D2)、接縫規則。
- **constants/** — 機器可讀常數,為數值的**單一正典來源**(single source of truth);spec 文件內出現的數字皆引自此處。兩端單元測試直接讀取這些 JSON:
  - `constants/grid.json` — tile 網格與量化參數
  - `constants/m1_area.json` — M1 信義計畫區 bbox 定案與選定理由
  - `constants/ecef_examples.json` — EPSG:3826 → ECEF 轉換測試向量
- **tests/** — 契約自檢(`node contracts/tests/check_spec.mjs`):驗證 spec 與常數的內部一致性,並以獨立實作重算 ECEF 向量。
- manifest schema 與各 binary tile 格式(terrain / road / props / physics)由後續票補入(FTP-23 起),不在本版範圍。

## 版本策略

- 每份常數與 spec 標示 `spec_version`(semver)。目前為 **0.1.0**(pre-1.0)。
- tile 產物與 manifest 必須宣告其遵循的 contract 版本(欄位由 manifest schema 票定義)。
- pre-1.0:**minor** 版本遞增可變更數值或語意(例如 `geoid_offset_m` 定值);**patch** 僅限訂正文字、不改變任何數值與語意。
- 1.0 之後:破壞性變更一律 **major**,並保留舊版 spec 檔供既有產物比對。
- 任何版本變更都是一張新 ticket、一次新 merge;不存在「順手改契約」。

## merge = finalized

本目錄採 **merge = finalized** 條款(專案 CLAUDE.md):PR 合併進 `develop` 即視為該 `spec_version` 定稿。合併後不得原地修改既有版本的數值或語意;唯一的修改途徑是依上述版本策略開新版本。兩端(pipeline / client)自合併時刻起即可依本契約平行開工。
