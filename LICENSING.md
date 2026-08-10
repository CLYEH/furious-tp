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
| terrain tiles | 內政部 20m DTM ⊕ **D9 路廊帶道路求解高程**(源自 D10 conflation,含 OSM 衍生成分) | 非路廊帶部分:衍生物,依 [OGDL v1](https://data.gov.tw/license) 散布;**路廊帶部分之 ODbL 定位未裁定**(見下方未決事項) | 顯名標示;ODbL 義務待裁定 |
| props tiles(路樹/路燈)、建物 physics proxy tiles | data.taipei 路樹/路燈設施(FTP-35);北市建物輪廓圖資 footprint extrusion(**D5** / FTP-36) | 衍生物,依 [OGDL v1](https://data.gov.tw/license) 散布 | 顯名標示 |
| 整體場景 | 上列全部 | Collective Database(**前提未裁定**,見下方未決事項):各圖層維持各自授權 | 同上並列標示 |

> **NLSC 3D Tiles 不在本表內**:依 RFC **D5**(「NLSC tiles 永不進物理,proxy collider 來源指定為北市建物輪廓圖資」)與 **FTP-36 Out of Scope**(「NLSC 任何資料(D5 禁止)」),NLSC 資料**不進入本專案編譯產物**;
> 它是 **client 端串流**(FTP-39),不在本文件自述的適用範圍(編譯產物 tiles)內。其服務條款由 FTP-5 處理,不影響本表。
>
> **未決事項(不是已解決的約束)**:terrain tiles 依 RFC **D9**(一級決策)於路廊帶內採用道路求解高程、外緣漸變,而道路來自 OSM ⊕ 北市道路 GIS 的 conflation
> (**D10**:拓樸以 OSM 為準、配對失敗段落退回 OSM 中心線);FTP-34 的 AC 亦寫明「路廊帶內地形高程 = 道路高程(容差)」。因此 **terrain 並非零 OSM 衍生**。
> 該圖層的 ODbL 定位於 FTP-6 **未裁定**,依該票 `[decision]` 延後(PoC 階段尚未散布)。**任何編譯產物公開散布前,必須先回頭裁定本項**,不得以本文件現況推定為已解決。
>
> **仍然成立的工程約束(對 pipeline 具拘束力)**:**props / 建物 physics proxy 圖層不得引入 OSM 來源資料**——例如改用 OSM 建物輪廓,該圖層即成為 ODbL Derivative Database、share-alike 外溢
> ([ODbL §4.5a](https://opendatacommons.org/licenses/odbl/1-0/))。實作對象為 **FTP-35 / FTP-36**(props / physics 票);變更資料來源前必須回頭修訂本文件。

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

### terrain / props tiles(OGDL v1;terrain 路廊帶之 ODbL 定位未裁定,見「未決事項」)

1. **顯名標示**(依附件「顯名聲明」格式,見下方 attribution 文字):**未盡顯名標示義務視為自始未取得授權**,屬失權要件 —
   [政府資料開放授權條款第1版 第三點(二)與附件](https://data.gov.tw/license)。
2. 改作、散布、再轉授權均在授權範圍內,免授權金、不可撤回 —
   [同條款 第二點(一)(二)](https://data.gov.tw/license)。
3. 各來源之授權依據:
   - data.taipei(北市道路 GIS、**建物輪廓圖資**、路樹/路燈設施):[平臺授權條款頁](https://data.taipei/rule)(全文採 OGDL v1)。
   - 內政部 20m DTM:[data.gov.tw dataset 35430](https://data.gov.tw/dataset/35430)。
   - NLSC(國土測繪中心):**不是本專案編譯產物的來源**(D5 / FTP-36 Out of Scope),故本節不對其圖資授權作結論;NLSC 3D Tiles 為 client 端串流(FTP-39),授權與服務條款屬 Spike R1(FTP-5)。既有的 [dataset 39082](https://data.gov.tw/dataset/39082)(「內政部國土測繪中心各售圖站」)為**非圖資**資料集,不足以證明 NLSC 圖資之授權依據,不作為本文件任何主張之依據。

## Attribution 文字(草案)

完整版(關於頁 / 本文件):

> 道路資料 (c) OpenStreetMap contributors,依 [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 提供;road tiles 為 OSM 與臺北市政府道路資料之衍生資料庫,依 ODbL 1.0 散布。
>
> 臺北市政府 [年份] [資料集名稱與版本] 此開放資料依[政府資料開放授權條款-第1版](https://data.gov.tw/license)進行公眾釋出,使用者於遵守本條款各項規定之前提下,得利用之。
>
> 內政部 [年份] 內政部20公尺網格數值地形模型資料 此開放資料依[政府資料開放授權條款-第1版](https://data.gov.tw/license)進行公眾釋出,使用者於遵守本條款各項規定之前提下,得利用之。
>
> 內政部國土測繪中心 [年份] [圖資名稱與版本] 此開放資料依[政府資料開放授權條款-第1版](https://data.gov.tw/license)進行公眾釋出,使用者於遵守本條款各項規定之前提下,得利用之。(此列對應 **client 端串流之 NLSC 3D Tiles**,非編譯產物來源;措辭以 FTP-5 確認之供應方式與服務條款為準)

政府資料部分刻意採[附件「顯名聲明」](https://data.gov.tw/license)**全文格式**(不節略末句):顯名標示為失權要件,節略有風險。

HUD 短版(FTP-46;點擊導向完整版):

> © OpenStreetMap contributors (ODbL) | 資料:臺北市政府、內政部、國土測繪中心(政府資料開放授權條款第1版)

## 待辦(依賴)

- **任何編譯產物公開散布前**:裁定上方「未決事項」所列 terrain 之 ODbL 定位(FTP-6 `[decision]` 延後項,非已解決)。
- FTP-5:NLSC 3D Tiles(**client 端串流**,FTP-39)之供應方式與服務條款 → 定稿本文件之 NLSC **顯名標示措辭**。本文件已無待定稿之 NLSC **來源**條目(D5:NLSC 不進編譯產物)。
- FTP-46:HUD 實作上方短版 attribution。
- FTP-51:發布流程落實 ODbL §4.6(免費全量提供 + 來源資料庫副本保留)。
