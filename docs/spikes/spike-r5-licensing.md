# Spike R5:衍生 tiles 散布授權相容性(ODbL × 政府開放授權)

> **狀態**:完成 — 結論:**可散布(附條件)**,不觸發 escalate
> **Ticket**:FTP-6(RFC v2 R5,阻擋性)
> **性質**:工程盡職調查(engineering due diligence),**非正式法律意見**。
> **Out of scope**:NLSC 服務條款(屬 Spike R1 / FTP-5)。
> **產物**:本報告 + repo 根目錄 [`LICENSING.md`](../../LICENSING.md) 草案。

## 查證清單(exam;declaration commit 凍結)

每一項完成的標準:附**條文原文引用**與**出處連結**。未達標不得勾選。

### AC1 — ODbL 義務清單

- [x] 「Database」「Derivative Database」「Produced Work」「Collective Database」定義:引用 ODbL 1.0 §1 原文 + 出處連結
- [x] Attribution / notice 義務:引用 §4.2、§4.3 原文
- [x] Share-alike 義務:引用 §4.4 原文
- [x] Derivative Database 存取義務(machine-readable copy / diff):引用 §4.6 原文
- [x] Conflation(OSM ↔ 北市道路 GIS)構成 Derivative Database 或 Collective Database 之判定:引用 OSMF community guideline(Collective Database Guideline)

### AC2 — 政府資料開放授權義務清單

- [x] 政府資料開放授權條款第1版:顯名標示義務條文引用 + 出處連結
- [x] 政府資料開放授權條款第1版:與 CC BY 4.0 相容性條文引用
- [x] data.taipei:平臺適用授權之依據 + 出處連結
- [x] 內政部 20m DTM:資料集授權依據 + 出處連結
- [x] NLSC 開放資料(建物 / 通用電子地圖):授權依據 + 出處連結(服務條款除外 → FTP-5)

### AC3 — 疊加結論

- [x] 散布方案表:tile 類型(road / terrain / props)× 來源資料 × 來源授權 × 產物授權
- [x] 可否散布結論明確:「可 / 不可 / 附條件可」三擇一,附推理
- [x] Attribution 文字草案:含 `(c) OpenStreetMap contributors` 與各政府機關顯名標示

### AC4 — LICENSING.md 草案

- [x] `LICENSING.md` 存在於 repo 根目錄,明確標注「工程盡職調查、非法律意見」
- [x] `LICENSING.md` 內每項義務附出處連結(ticket Verification Step)
- [x] 若結論為「不能散布」:已發 `[escalate]` + `needs-human`(結論為可散布,此項 N/A)

## 查證結果

以下引文均於 2026-08-10 自來源網站取回核對。

### AC1 — ODbL 1.0 義務清單

出處:[Open Data Commons Open Database License (ODbL) v1.0](https://opendatacommons.org/licenses/odbl/1-0/)。OpenStreetMap 資料依 ODbL 釋出([OSM copyright](https://www.openstreetmap.org/copyright))。

#### 定義(§1)

- **Derivative Database**:
  > "Derivative Database" – Means a database based upon the Database, and includes any translation, adaptation, arrangement, modification, or any other alteration of the Database or of a Substantial part of the Contents.
- **Produced Work**:
  > "Produced Work" – a work (such as an image, audiovisual material, text, or sounds) resulting from using the whole or a Substantial part of the Contents (via a search or other query) from this Database, a Derivative Database, or this Database as part of a Collective Database.
- **Collective Database**:
  > "Collective Database" – Means this Database in unmodified form as part of a collection of independent databases in themselves that together are assembled into a collective whole. A work that constitutes a Collective Database will not be considered a Derivative Database.

#### Attribution / notices(§4.2、§4.3)

- §4.2(散布 Database / Derivative Database 時):
  > 4.2 Notices. If You Publicly Convey this Database, any Derivative Database, or the Database as part of a Collective Database, then You must: a. Do so only under the terms of this License …; b. Include a copy of this License … or its Uniform Resource Identifier (URI) with the Database or Derivative Database …; c. Keep intact any copyright or Database Right notices and notices that refer to this License.
- §4.3(公開使用 Produced Work 時):
  > … if you Publicly Use a Produced Work, You must include a notice associated with the Produced Work reasonably calculated to make any Person that uses, views, accesses, interacts with, or is otherwise exposed to the Produced Work aware that Content was obtained from the Database … and that it is available under this License.

#### Share-alike(§4.4)與其界限(§4.5)

- §4.4:
  > 4.4 Share alike. a. Any Derivative Database that You Publicly Use must be only under the terms of: i. This License; ii. A later version …; or iii. A compatible license. … d. … You must not add Contents to Derivative Databases under Section 4.4 a that are incompatible with the rights granted under this License.
- §4.5(share-alike 不適用之情形):
  > a. … You are not required to license Collective Databases under this License if You incorporate this Database or a Derivative Database in the collection …; b. Using this Database … to create a Produced Work does not create a Derivative Database for purposes of Section 4.4 …

#### Derivative Database 存取義務(§4.6)

> 4.6 Access to Derivative Databases. If You Publicly Use a Derivative Database or a Produced Work from a Derivative Database, You must also offer to recipients of the Derivative Database or Produced Work a copy in a machine readable form of: a. The entire Derivative Database; or b. A file containing all of the alterations made to the Database or the method of making the alterations …. The Derivative Database (under a.) or alteration file (under b.) must be … free of charge if distributed over the internet.

#### Conflation 判定(OSMF Collective Database Guideline)

出處:[OSMF Licence/Community Guidelines](https://osmfoundation.org/wiki/Licence/Community_Guidelines) → [Collective Database Guideline](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline_Guideline)。

> An OSM dataset and a non-OSM dataset combined in a single database will be considered independent (and thus form a Collective Database rather than a Derivative Database) so long as the data used for a particular data type is either all OSM or all non-OSM within the same regional cut.

且該 guideline 明定「參照(reference)」即破壞 independence:

> Technically a reference between non-OSM and OSM data can be by a database key or any other method of identifying a specific OSM or non-OSM element that may be used with a database join.

**判定**:RFC D10 conflation 在**同一資料型別(道路)**內混用 OSM 幾何與北市道路 GIS 屬性/幾何,且以逐 feature 匹配(即互相 reference)。不符合「單一型別全 OSM 或全非 OSM」的 independence 條件 → 融合後的道路資料庫是 **Derivative Database**,share-alike(§4.4)與存取義務(§4.6)適用。

### AC2 — 政府資料開放授權條款第1版 義務清單

出處:[政府資料開放授權條款-第1版](https://data.gov.tw/license)(中華民國104年7月27日訂定)。

#### 授與權利(第二點)

> 二、授與權利 (一)各機關所提供之開放資料,授權使用者不限目的、時間及地域、非專屬、不可撤回、免授權金進行利用,利用之方式包括重製、散布、公開傳輸……編輯、改作,包括但不限於開發各種產品或服務型態之衍生物。 (二)使用者得再轉授權他人為前項之利用。

→ 允許改作、散布與**再轉授權**:將政府資料納入 ODbL 衍生資料庫再以 ODbL 條款釋出,屬第二點授權範圍內之利用。

#### 顯名標示義務(第三點(二);含失權效果)

> 三、課予義務 (二)使用者利用依本條款提供之開放資料,及後續之衍生物,應以符合附件所示「顯名聲明」要求之方式,明確標示原資料提供機關之相關聲明;**未盡顯名標示義務者,視為自始未取得開放資料之授權。**

附件顯名聲明格式:

> 提供機關/單位 [年份] [開放資料釋出名稱與版本號] 此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出……政府資料開放授權條款:https://data.gov.tw/license

#### CC BY 4.0 相容(第四點(二))

> 四、(二)本條款與「創用CC授權 姓名標示 4.0 國際版本」相容,使用者依本條款利用開放資料,如後續以「創用CC授權 姓名標示 4.0 國際版本」規定之方式利用,視為符合本條款之規定。

#### 各來源之授權依據

| 來源 | 授權依據 | 出處 |
|---|---|---|
| data.taipei(北市道路 GIS 等) | 政府資料開放授權條款-第1版(平臺授權頁全文採用) | [data.taipei 授權條款頁](https://data.taipei/rule) |
| 內政部 20m DTM | 政府資料開放授權條款-第1版(資料集頁「授權方式」;API `license` 欄位驗證) | [data.gov.tw dataset 35430「內政部20公尺網格數值地形模型資料」](https://data.gov.tw/dataset/35430) |
| NLSC(國土測繪中心) | NLSC 於 data.gov.tw 釋出之資料集帶政府資料開放授權條款-第1版標示(API `license` 欄位驗證;驗證例為**非圖資**資料集,僅證明 NLSC 以本條款釋出開放資料);**3D 建物圖資實際適用之授權與服務條款屬 FTP-5**,此處為條件式結論 | [data.gov.tw NLSC 資料集驗證例](https://data.gov.tw/dataset/39082);服務條款 → Spike R1 |

風險備註(轉交 FTP-5):data.gov.tw 民眾需求區 [「3D建物模型」](https://data.gov.tw/suggests/136485) 顯示臺北市轄內 3D 建物模型未由 NLSC 提供、臺北市政府亦未另行開放——信義區建物來源可用性須由 FTP-5 確認。

### AC3 — 疊加結論

#### 散布方案表

| tile 類型 | 來源資料 | 來源授權 | ODbL 定位 | 產物授權(方案) |
|---|---|---|---|---|
| road | OSM 道路 ⊕ 北市道路 GIS(D10 conflation) | ODbL 1.0 ⊕ OGDL v1 | **Derivative Database**(見 AC1 判定) | **ODbL 1.0**(§4.4a),附 OGDL 顯名聲明 |
| terrain | 內政部 20m DTM | OGDL v1 | 非 OSM 衍生物(與 ODbL 無涉) | OGDL 衍生物,附顯名聲明 |
| props(建物等) | NLSC 3D 建物 / data.taipei 設施 | OGDL v1(NLSC 服務條款 → FTP-5) | 非 OSM 衍生物 | OGDL 衍生物,附顯名聲明;NLSC 部分以 FTP-5 為條件 |
| 整體場景(多圖層集合) | 上列全部 | — | **Collective Database**(圖層各自獨立、road 以外不含 OSM 資料) | 各圖層維持各自授權(§4.5a) |

#### 推理

1. **road tiles 必須以 ODbL 散布**:conflation 產生 Derivative Database(AC1 判定),§4.4a 要求以 ODbL(或相容授權)公開使用。
2. **OGDL 資料可以合法納入 ODbL Derivative Database**:OGDL 第二點(一)(二)授權改作、散布、再轉授權且不可撤回、免授權金;其唯一實質義務為顯名標示(第三點(二)),與 ODbL §4.2c「keep intact any copyright … notices」直接相容——顯名聲明隨 tiles 與本文件保留即同時滿足兩者。OGDL 並明文與 CC BY 4.0 相容(第四點(二)),屬 attribution 型授權,無與 share-alike 衝突之限制,不牴觸 ODbL §4.4d(禁止加入與 ODbL 授權不相容之內容)。
3. **share-alike 不感染 terrain/props**:整體場景以獨立圖層組成,road 以外圖層完全不含 OSM 資料,符合 Collective Database Guideline 的 independence 條件與 ODbL §4.5a——集合物不需整體採 ODbL。
4. **§4.6 存取義務的滿足方式**:road tiles 本身即為機器可讀之 Derivative Database 全量副本,經網際網路免費散布即滿足 §4.6a;另於發布流程保留 conflation 輸出之來源資料庫副本作為備援(FTP-51 落實)。
5. **義務皆為可執行之工程動作**(標示、附授權連結、保留聲明、免費提供),無不可滿足條款 → **結論:可散布(附條件)**,不觸發「不能散布」之 escalate 條件。

#### Attribution 文字草案

完整版(LICENSING.md / 關於頁):

> 道路資料 (c) OpenStreetMap contributors,依 [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 提供;road tiles 為 OSM 與臺北市政府道路資料之衍生資料庫,依 ODbL 1.0 散布。
> 臺北市政府 [年份] [資料集名稱與版本]:此開放資料依[政府資料開放授權條款-第1版](https://data.gov.tw/license)進行公眾釋出。
> 內政部 [年份] 內政部20公尺網格數值地形模型資料:此開放資料依[政府資料開放授權條款-第1版](https://data.gov.tw/license)進行公眾釋出。
> 內政部國土測繪中心 [年份] [圖資名稱與版本]:此開放資料依[政府資料開放授權條款-第1版](https://data.gov.tw/license)進行公眾釋出。(以 FTP-5 確認之供應方式為準)

HUD 短版(FTP-46 使用;點擊導向完整版):

> © OpenStreetMap contributors (ODbL) | 資料:臺北市政府、內政部、國土測繪中心(政府資料開放授權條款第1版)

## 結論

**可散布(附條件)。** road tiles 以 ODbL 1.0 散布(share-alike + §4.2 notices + §4.6 免費全量提供);terrain / props tiles 依 OGDL v1 附顯名聲明散布;整體場景為 Collective Database,share-alike 不外溢。條件:(1) 顯名標示為失權要件,attribution 必須隨產物與展示介面共同交付(FTP-46/FTP-51);(2) NLSC 3D 建物供應方式與服務條款由 FTP-5 確認後,LICENSING.md 之 NLSC 條目才能定稿。方案細節見 [`LICENSING.md`](../../LICENSING.md)。
