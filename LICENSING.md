# LICENSING(草案)

本文件說明本專案**編譯產物(tiles)**的資料授權與散布義務。

> **注意**:本文件為**工程盡職調查**結論(Spike R5 / FTP-6,詳
> [docs/spikes/spike-r5-licensing.md](docs/spikes/spike-r5-licensing.md)),
> **非正式法律意見**。程式碼本身的授權另行處理,不在本文件範圍。

## 總結

衍生 tiles **可公開散布**,條件如下:

| 產物 | 來源 | 產物授權 | 主要義務 |
|---|---|---|---|
| road tiles | OSM ⊕ 臺北市道路 GIS(conflation) | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | share-alike、attribution、免費提供全量資料庫 |
| terrain tiles | 內政部 20m DTM | 衍生物,依 [OGDL v1](https://data.gov.tw/license) 散布 | 顯名標示 |
| props tiles(建物等) | NLSC 3D 建物、data.taipei 設施 | 衍生物,依 [OGDL v1](https://data.gov.tw/license) 散布 | 顯名標示;**NLSC 條目待 FTP-5 定稿** |
| 整體場景 | 上列全部 | Collective Database:各圖層維持各自授權 | 同上並列標示 |

> **前提條件(工程約束,對 pipeline 具拘束力)**:road 以外的圖層(terrain / props)**不得混入任何 OSM 來源資料**。
> 例如 props 若改用 OSM 建物輪廓,該圖層即成為 ODbL Derivative Database,share-alike 外溢、整體場景不再構成
> Collective Database([ODbL §4.5a](https://opendatacommons.org/licenses/odbl/1-0/))。變更資料來源前必須回頭修訂本文件(FTP-31)。

## 義務清單

每項義務附出處;逐條原文引用見 [spike 報告](docs/spikes/spike-r5-licensing.md)。

### road tiles(ODbL 1.0)

conflation 後的道路資料庫為 ODbL「Derivative Database」(判定依
[OSMF Collective Database Guideline](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline_Guideline))。

1. **以 ODbL 1.0 散布**,並隨附授權全文或 URI —
   [ODbL §4.4a、§4.2b](https://opendatacommons.org/licenses/odbl/1-0/)。
2. **attribution**:展示介面與產物須標示 `(c) OpenStreetMap contributors` 並註明資料依 ODbL 提供 —
   [ODbL §4.3](https://opendatacommons.org/licenses/odbl/1-0/)、[OSM copyright](https://www.openstreetmap.org/copyright);
   該字樣之權威依據為 [OSMF Attribution Guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)
   (明列 `© OpenStreetMap contributors` 為可接受形式)。
   依同 guideline 之 **Databases safe harbour**,attribution 與 ODbL 連結**必須隨資料庫本體交付**
   (tileset metadata 或同目錄 readme),僅有 HUD 標示不足。
3. **保留既有聲明**(含臺北市政府顯名聲明)—
   [ODbL §4.2c](https://opendatacommons.org/licenses/odbl/1-0/)。
4. **免費提供機器可讀之全量衍生資料庫**:road tiles 本身即為全量副本,經網際網路免費散布即滿足;發布流程另保留 conflation 來源資料庫副本(FTP-51)—
   [ODbL §4.6](https://opendatacommons.org/licenses/odbl/1-0/)。

### terrain / props tiles(OGDL v1)

1. **顯名標示**(依附件「顯名聲明」格式,見下方 attribution 文字):**未盡顯名標示義務視為自始未取得授權**,屬失權要件 —
   [政府資料開放授權條款第1版 第三點(二)與附件](https://data.gov.tw/license)。
2. 改作、散布、再轉授權均在授權範圍內,免授權金、不可撤回 —
   [同條款 第二點(一)(二)](https://data.gov.tw/license)。
3. 各來源之授權依據:
   - data.taipei:[平臺授權條款頁](https://data.taipei/rule)(全文採 OGDL v1)。
   - 內政部 20m DTM:[data.gov.tw dataset 35430](https://data.gov.tw/dataset/35430)。
   - NLSC:NLSC 於 data.gov.tw 釋出之資料集帶 OGDL v1 授權標示(驗證例:[dataset 39082](https://data.gov.tw/dataset/39082),非圖資資料集,僅證明 NLSC 以本條款釋出開放資料);本專案建物來源實際適用之授權與**服務條款**由 Spike R1(FTP-5)確認後,本節 NLSC 條目才能定稿。

## Attribution 文字(草案)

完整版(關於頁 / 本文件):

> 道路資料 (c) OpenStreetMap contributors,依 [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 提供;road tiles 為 OSM 與臺北市政府道路資料之衍生資料庫,依 ODbL 1.0 散布。
>
> 臺北市政府 [年份] [資料集名稱與版本] 此開放資料依[政府資料開放授權條款-第1版](https://data.gov.tw/license)進行公眾釋出,使用者於遵守本條款各項規定之前提下,得利用之。
>
> 內政部 [年份] 內政部20公尺網格數值地形模型資料 此開放資料依[政府資料開放授權條款-第1版](https://data.gov.tw/license)進行公眾釋出,使用者於遵守本條款各項規定之前提下,得利用之。
>
> 內政部國土測繪中心 [年份] [圖資名稱與版本] 此開放資料依[政府資料開放授權條款-第1版](https://data.gov.tw/license)進行公眾釋出,使用者於遵守本條款各項規定之前提下,得利用之。(以 FTP-5 確認之供應方式為準)

政府資料部分刻意採[附件「顯名聲明」](https://data.gov.tw/license)**全文格式**(不節略末句):顯名標示為失權要件,節略有風險。

HUD 短版(FTP-46;點擊導向完整版):

> © OpenStreetMap contributors (ODbL) | 資料:臺北市政府、內政部、國土測繪中心(政府資料開放授權條款第1版)

## 待辦(依賴)

- FTP-5:NLSC 3D 建物供應方式與服務條款 → 定稿本文件 NLSC 條目。
- FTP-46:HUD 實作上方短版 attribution。
- FTP-51:發布流程落實 ODbL §4.6(免費全量提供 + 來源資料庫副本保留)。
