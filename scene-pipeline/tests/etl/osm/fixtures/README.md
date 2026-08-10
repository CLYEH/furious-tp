# OSM ETL 測試 fixture

## `xinyi_highways.osm`

**內容**:信義計畫區核心的真實 OSM 資料子集,供 FTP-29 的 happy path 與跨界裁切測試使用。
使用真實資料而非手造幾何,是因為考卷要驗證的正是「真實 OSM 的 tag 組合與幾何」能否被正確處理
——`tunnel=building_passage`、`layer=-1`、同名道路拆成多條 way 這類情況,手造 fixture 想不到。

| 項目 | 值 |
| --- | --- |
| 來源 | OpenStreetMap API 0.6 `/map` endpoint |
| 查詢範圍 | `bbox=121.5630,25.0330,121.5720,25.0400`(WGS84) |
| 擷取日期 | 2026-08-10 |
| 裁修方式 | 只保留帶 `highway` tag 的 way(491 條)+ 兩條 `building` way(非道路的反例)+ 這些 way 參照到的 node(1757 個);node 只留 `id`/`lat`/`lon` 與 tags,移除 `version`/`timestamp`/`changeset`/`uid`/`user` |
| EPSG:3826 範圍 | E [306628.4, 307976.6] × N [2769511.5, 2770516.8](tile 613–615 × 5539–5541,全部落在 M1 bbox 內) |

**為何是這個範圍**:涵蓋 `contracts/constants/m1_area.json` 的 M1 bbox 之核心街廓,且真實含有考卷需要的
tag 組合:`bridge=yes`(23)、`tunnel=yes`(7)、`tunnel=building_passage`(18)、`layer` 取值 −2/−1/0/1、
`oneway` 取值 yes/no/未標。唯一缺的是 `oneway=-1`(此範圍內無實例),該案例由 `conftest.py` 的合成 XML 覆蓋。

**fixture 是凍結的**:重新擷取會因 OSM 是活資料而改變內容,使考卷斷言漂移。需要更新時,連同本檔的
擷取日期與統計數字一併更新,並在 ticket 上說明。

## 授權

本檔為 OpenStreetMap 資料的衍生物:

> © OpenStreetMap contributors,依 [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 提供。

依 `LICENSING.md`(road tiles 第 2 條,ODbL Attribution Guidelines 的 Databases safe harbour),
attribution 與 ODbL 連結必須隨資料庫本體交付,故本檔與 fixture 同目錄。原始 XML 根元素亦保留了
上游的 `copyright` / `attribution` / `license` 屬性,未經改寫。
