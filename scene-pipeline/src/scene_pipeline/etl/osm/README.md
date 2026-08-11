# OSM ETL(RFC 模組 1)

臺北 OSM extract → 可駕駛道路網拓樸,輸出至**來源隔離**目錄。
RFC D2(全程 EPSG:3826)、D10(拓樸以 OSM 為準)、PRD §4 與 `LICENSING.md`(ODbL 義務)。

## 單一指令

```bash
python -m scene_pipeline.etl.osm \
  --source https://download.geofabrik.de/asia/taiwan-latest.osm.pbf \
  --out data/osm \
  --area contracts/constants/m1_area.json
```

| 參數 | 說明 |
| --- | --- |
| `--source` | `http(s)` URL 或本機檔路徑。副檔名須為 `.osm.pbf` / `.osm.bz2` / `.osm.gz` / `.osm.xml` / `.osm` / `.pbf`(osmium 由檔名判斷格式,無法判斷時**立即**失敗,而不是留到解析階段) |
| `--out` | 輸出目錄,**只**存放 OSM 衍生物 |
| `--area` | 由 contracts 區域檔讀 bbox(與 `--bbox` 二擇一) |
| `--bbox` | `E_MIN N_MIN E_MAX N_MAX`,EPSG:3826 公尺 |
| `--sha256` | 預期雜湊;不符即失敗 |

離開碼:`0` 成功;`2` 任何可預期的失敗(下載、解析、bbox、來源檔複製),訊息單行寫入 stderr,不吐 traceback。

> `--source` **不能**指向本次 `--out/source/` 內既有的那份 extract(來源與目的地同一個檔)。
> 這是想省下重新下載時最自然的做法,所以它以離開碼 `2` 加一行訊息回絕,而不是拋出 `SameFileError`。
> 要重跑請改指原始檔或另一個 `--out`。

## 來源隔離與授權(AC2)

```text
<out>/
├── ATTRIBUTION.md                    # ODbL 標示 + 來源紀錄(每次執行重寫)
├── source/<extract>                  # 取得的 extract,逐位元原樣保存
└── intermediate/roads.topology.json  # 本階段輸出
```

`ATTRIBUTION.md` 在 extract **落地當下**就寫出,早於任何會因內容而失敗的步驟。
執行若死在解析階段,`source/` 裡仍留著已取得的位元組;若標示要等拓樸成功才寫,
那個目錄就會是「裝著 OSM 位元組、卻沒有任何授權標示」的狀態 —— 而那正是本節論證要防止的。

ODbL 的 share-alike **跟著資料走**,所以隔離的是「一個可以指得出來的目錄」,而非命名慣例:
本目錄不得與內政部 DTM、data.taipei 等其他來源的產物混放。
依 `LICENSING.md`(road tiles 第 2 條,OSMF Attribution Guidelines 的 *Databases safe harbour*),
attribution 與 ODbL 連結必須**隨資料庫本體交付** —— 故除了 `ATTRIBUTION.md`,
輸出 JSON 本身也帶 `license` 區塊。

## 過濾規則

只保留**可駕駛**道路(`HIGHWAY_CLASSES`:motorway / trunk / primary / secondary / tertiary /
unclassified / residential / living\_street / service 及各 `_link`)。
人行設施(footway、steps、cycleway、path、pedestrian)一律排除 —— 把人行道接進道路網,
會造出車輛永遠走不了的連通,使 QA 的連通性指標看起來健康、實則失真。

屬性正規化(下游只看正規化後的值):

| 屬性 | 規則 |
| --- | --- |
| `oneway` | `yes`/`true`/`1` → `1`;`no`/`false`/`0`/未標 → `0`;**`-1`/`reverse` → 反轉幾何節點順序並記為 `oneway=1, reversed=true`**;無法辨識的值 → `0` 並記入 `qa.tag_warnings` |
| `layer` | 帶正負號整數;無法解析(如 `1;2`)→ `0` 並記入 `qa.tag_warnings`(不因單一髒 tag 中止整份 extract,但也不靜默) |
| `bridge` / `tunnel` | 只有未標與 `no`/`false`/`0` 為 false;其餘皆 true(`bridge=viaduct`、`tunnel=building_passage` 都算) |
| `class` / `name` | 原樣保留 |

## 跨界 way 之切斷規則(AC4)

1. **歸屬**:點的內外判定為 **min 邊含、max 邊不含**,直接沿用
   [`contracts/spec/grid.md`](../../../../../contracts/spec/grid.md) §邊界歸屬。M1 bbox 是 7×7 個 tile 的聯集,
   故繼承同一慣例;判反了會在每一道區域接縫上重複或漏掉幾何。
2. **切斷**:以 Liang–Barsky 對**閉**盒裁切,逐段處理。
3. **切點精確性**:切點在**被跨越的那一軸**取邊界的精確值,另一軸才線性內插。
   這是為了讓 grid.md §接縫規則條款 1(相鄰兩側共用邊界頂點必須位元級一致)日後成立 ——
   兩軸都內插則兩側只會「近似相等」。
4. **合成節點**:切點是我們造出來的節點,`id` 取**負數**(OSM id 恆為正,兩個 id 空間不重疊,
   真實路口不會與邊界切點意外合併),並標記 `boundary=true`。
5. **切成多段**:一條 way 進出區域 N 次就切成 N 段,輸出 id 為 `<osm_id>#<part>`;
   屬性與方向逐段完整複製。串成一段會憑空造出穿越區域外的捷徑,只留第一段則會刪掉真實道路。
6. **丟棄條件**:相鄰重複點先合併;合併後不足 2 點的段落丟棄(零長度段落無法定義方向,
   下游道路編譯器會除以零);所有 segment 中點都不在區域內的段落丟棄 ——
   即完全躺在 max 邊上的段落,它屬於隔壁區域,留著會讓同一條路被輸出兩次。
7. **合併時身分歸誰**(條款 1、4、6 的交會點):合併決定的不只是座標,還有**節點身分**。
   一個真實節點恰好落在 **min 邊**上時,由條款 1 它是我們的,而前一段的切點會落在同一座標上 ——
   這一對以「(合成, 真實)」的順序進到合併。此時**真實 index 覆蓋合成 index**;
   反之(真實在前、合成在後)**不覆蓋**;兩個都是真實的則**取先出現者**。
   留下合成的那一個會讓真實 OSM 節點換成帶 `boundary=true` 的負 id ——
   以 OSM id 比對的 D10 conflation 從此看不見它,`qa.dangling_node_ids` 也不再考慮它,
   而幾何連一公釐都沒有動。max 邊上的同一個幾何則**必須維持合成**,因為那個點不是我們的。
   這在今天的原始 OSM 輸入上罕見,但當同一個裁切器以 500 m 粒度重跑在**已裁切**的幾何上時會成為常態。
8. **邊界切點不是斷鏈**:`boundary=true` 的節點即使度數為 1,也**不**列入
   `qa.dangling_node_ids`。否則邊界雜訊會淹沒真正的資料缺陷。

## 拓樸輸出(AC3)

* **degree**:相接的 **segment** 數,不是 way 數。way 中間的節點為 2、T 字路口為 3。
* **dangling**:度數 1 且非邊界切點 —— 來源資料裡真正的斷頭(死巷或 OSM 的缺漏)。只回報,不自動修補。
* **incomplete way**:參照到 extract 內不存在的節點(截斷或裁切不當的 extract 的典型症狀)→ 丟棄並列入 `qa.incomplete_way_ids`。
* **components**:可駕駛圖的連通分量;大於 1 表示區域內道路網被切斷。

## 輸出格式 `scene-pipeline/osm-road-topology` v0.1.0

pipeline 內部的中間格式(不是 client 契約;client 面向的 tile 格式在 `contracts/`)。

```jsonc
{
  "format": "scene-pipeline/osm-road-topology",
  "format_version": "0.1.0",
  "crs": "EPSG:3826",
  "bbox": { "e_min": 0, "n_min": 0, "e_max": 0, "n_max": 0 },
  "license": { "name": "ODbL 1.0", "url": "…", "attribution": "© OpenStreetMap contributors" },
  "source": { "source": "…", "file": "…", "sha256": "…", "size_bytes": 0, "retrieved_at": "…" },
  "nodes": [{ "id": 1, "e": 0.0, "n": 0.0, "degree": 2, "boundary": false }],
  "ways": [{
    "id": "123#0", "osm_id": 123, "class": "secondary", "name": "信義路五段",
    "oneway": 1, "reversed": false, "layer": -1, "bridge": false, "tunnel": true,
    "cut_start": false, "cut_end": true, "nodes": [1, 2]
  }],
  "qa": {
    "node_count": 0, "way_count": 0, "component_count": 1, "component_sizes": [0],
    "dangling_node_ids": [], "incomplete_way_ids": [], "tag_warnings": []
  }
}
```

座標**不做四捨五入**:切點在邊界軸上的精確值是條款 3 的重點,量化留給 tile 格式階段。
同一輸入重跑輸出內容一致(節點與 way 的順序皆為輸入的函數),以支援增量重編譯的 diff。

## 不在本模組範圍

* conflation(D10,FTP-31):與北市道路 GIS 的套合。
* 高架分層幾何(M2):本階段只保留 `layer`/`bridge`/`tunnel` tag,不做分層幾何。
