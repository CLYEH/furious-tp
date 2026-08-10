# Spike R1:NLSC 三維國家底圖 3D Tiles 服務可行性實測與條款查證

> **狀態**:完成 — 結論:**直串不可行,且 Plan B(caching proxy)無法補救**(缺陷在來源端)。已觸發 `[escalate]` + `needs-human`。
> **Ticket**:FTP-5(RFC v2 R1,阻擋性)
> **性質**:工程盡職調查(engineering due diligence),**非正式法律意見**。
> **實測日期**:2026-08-10(所有 header / payload 皆為當日取回)
> **產物**:本報告 + 可重跑量測 script [`nlsc-probe.mjs`](nlsc-probe.mjs)(實驗用,不進正式模組;自我測試 [`nlsc-probe.selftest.mjs`](nlsc-probe.selftest.mjs))
> **關聯**:結論決定 `LICENSING.md`(FTP-6)的 NLSC 條目、FTP-39(client 串流)、FTP-51(hosting)

## 查證清單(exam;declaration commit 凍結)

每一項完成的標準:附**一手出處**(條文原文引用/實測 response header/script 輸出),
未達標者標記 `unverified` 並寫明原因。**推論不得充當證據。**

### AC1 — 條款查證(商用許可、轉載/快取限制、標示要求)

- [x] 找出治理 3D Tiles 服務之條款文件本身,附取得方式與時間
- [x] **商用許可**:引用條文原文;若條款未規範,明確記為 `unverified` 並說明「無明文允許亦無明文禁止」之區別 → **結果:`unverified`**
- [x] **轉載/快取限制**:引用條文原文(含「自行快取/代理/再散布」是否落入禁止範圍)→ **結果:條款未規範,`unverified`**
- [x] **標示要求**:引用條文原文 + 標示格式來源
- [x] **限流條款**:引用機關保留限制次數/資料量/頻寬之條文(影響 AC3 詮釋)
- [x] 資料來源之第三方權利(臺北市建物模型之來源機關)查證,附出處

### AC2 — CORS 實測

- [x] `tileset.json`:preflight(OPTIONS + `Origin` + `Access-Control-Request-*`)完整 response header
- [x] `tileset.json`:實際 GET(帶 `Origin`)完整 response header
- [x] **真實 tile payload**(非 JSON):實際 GET 完整 response header + payload magic 驗證
- [x] 判定:瀏覽器跨域直接載入是否成立,含 preflight 觸發條件與 credentials 模式之界限
- [x] **未執行項目誠實揭露**:本 session 無 browser 工具,瀏覽器實際渲染確認由誰補做

### AC3 — 限流/吞吐實測(模擬駕駛存取模式)

- [x] 可重跑 script 存在,`--help` 可用,輸出為固定 schema 之 JSON
- [x] script **內建保守 rate limit**(預設值 + 硬上限),且 header 說明此設計理由
- [x] script 遇 429 / 錯誤率上升**立即中止**並在輸出標記中止原因
- [x] 實測結果:延遲統計(p50/p95)、狀態碼分佈、是否觸發限流/封鎖
- [x] 樣本不足時輸出 `insufficientSamples` 而非假統計
- [x] script 自我測試(local fake server,不打真實服務)全綠,並記錄輸出

### AC4 — tileset 改版偵測(RFC D5)

- [x] 實測 `ETag` / `Last-Modified` / `Cache-Control` 是否可用作版本指紋(附 header 證據)
- [x] 服務端是否另有版本欄位可用(附證據)
- [x] 圖資更新頻率之官方說明(附條文出處)
- [x] 指紋機制建議:資料來源、比對方式、告警條件、誤報風險

### AC5 — 三擇一結論

- [x] 結論明確落在「直串可行 / 需 caching proxy(Plan B)/ 不可行」其一,附推理
- [x] 建議事項可執行(對應到後續 ticket)
- [x] 若結論為「不可行」:已發 `[escalate]` + `needs-human`
- [x] `[progress]` 摘要已 post 於 FTP-5

## 0. 服務端點定位(一手出處)

NLSC 的服務網址規則不在靜態頁面上,而由平臺 CMS 內容 API 供給。取得方式(可重跑):

```sh
curl -sS -X POST -H "Content-Length: 0" \
  "https://3dmaps.nlsc.gov.tw/NLSC/API/SearchFromSQL?type=GetAllCard&tabidx=10&query=true"
```

該筆內容(標題「三維服務介接說明」)原文節錄:

> 平臺以政府開放資料「2020年全臺灣及部分離島20公尺網格DEM資料」基礎,發布符合OGC I3S與3DTiles之三維建物及三維道路服務⋯⋯
>
> 3D Tiles服務清單網址:`https://3dtiles.nlsc.gov.tw/tiles3d/Service`
>
> (二) 3D Tiles服務網址規則:`https://3dtiles.nlsc.gov.tw/building/tiles3d/建物服務代碼/tileset.json`
>
> (三) 服務代碼⋯⋯臺北市 **0**

道路服務同規則:`.../road/tiles3d/<代碼>/tileset.json`(原始成果版)、`.../road2nd/tiles3d/<代碼>/tileset.json`(地形貼合版);表中臺北市(代碼 0)**未列為灰色**(灰色 = 暫無成果範圍),即官方宣告臺北市有成果。

服務清單 `https://3dtiles.nlsc.gov.tw/tiles3d/Service`(200,13,176 bytes,可正常解析)確實列出:

```json
{"Name": "臺北市建物模型 ( Taipei City Building Model )",
 "Url": "https://3dtiles.nlsc.gov.tw/building/tiles3d/0/tileset.json"}
```

清單另含 24 個建物圖層、22 個道路圖層(×2 版本)與 2 個試辦地形圖層
(`Terrain20M`,正射影像/電子地圖)。

## 1. AC1 — 條款查證

### 1.1 治理文件本身

3D Tiles 服務由 `3dmaps.nlsc.gov.tw` 平臺的**「服務使用條款」**治理;該條款第一點明文把 OGC 服務納入適用範圍。條款同樣存放於 CMS(`tabidx=2`),取得方式:

```sh
curl -sS -X POST -H "Content-Length: 0" \
  "https://3dmaps.nlsc.gov.tw/NLSC/API/SearchFromSQL?type=GetAllCard&tabidx=2&query=true"
```

原文(2026-08-10 取回,逐條引用):

> 內政部國土測繪中心(以下簡稱本中心)多維度國家空間資訊服務平臺(以下簡稱本服務),系統網址為 `https://3dmaps.nlsc.gov.tw`,當您使用本服務時即代表無條件同意本使用條款。
>
> 一、本服務係指下列事項:(一)本系統提供的二維圖資及三維圖資瀏覽、查詢及操作成果顯示。**(二)OGC I3S、OGC 3D Tiles服務。**
>
> 二、本中心對於本服務的可用性、即時性、安全性或可靠性不需承擔任何責任⋯⋯本中心亦有權在未事前通知您的情況下,隨時修改、暫停或終止本服務,本中心並不需承擔任何責任。
>
> 三、本服務將會不斷更新,因此,您也可能需要配合適時適度修改您的網頁⋯⋯
>
> 五、本服務是不可移轉的,並且只能用在宣傳或是表示您使用的是本系統的服務⋯⋯
>
> 六、本服務所提供的地圖、影像或其他內容中可能包含本中心或相關識別資料或版權、著作權聲明等註記或符號,**您不得以任何方式改變、移除或遮蔽這些識別資料或版權聲明。**
>
> 九、**本中心可以隨時根據本系統設定來限制您使用本服務的次數、資料量或網路頻寬等而無須事先聲明。**
>
> 十、本使用條款若有疑義或不詳處,以本中心解釋為準。

平臺另有「多維度國家空間資訊服務平臺隱私權及服務條款」(首頁 `Entrance.aspx` 內嵌),其「一.服務調整 2.」為第九點的同義條文:

> 本中心可以隨時根據本系統設定來限制您使用本服務的次數、資料量、網路頻寬或帳號使用權限等而無須事先聲明。

### 1.2 商用許可 — **`unverified`**

**服務使用條款全文十點中,沒有任何一點提及商業/營利使用**,既未明文允許,也未明文禁止。平臺 FAQ 僅說明**無需申請**即可介接:

> Q:請問3D Tiles是什麼?該如何使用?
> A:本系統發布3D Tiles服務為符合OGC國際標準之3D網路圖資服務,**使用者無需申請**,即可利用符合OGC 3D Tiles軟體介接本系統圖資套疊⋯⋯

(取得方式:`SearchFromSQL?type=Quest&query=true`)

**「無需申請」是存取程序的敘述,不是授權範圍的授與。** 本專案為公開免登入服務,商用與否的界線需要肯定性授權依據,而條款未提供。

可查到的**肯定性**授權依據只有兩處,且**都不直接涵蓋線上 3D Tiles 服務的建物圖資**:

1. 平臺所採用的地形基礎是政府開放資料 —
   [data.gov.tw dataset 138563「2020年版全臺灣及部分離島20公尺網格數值地形模型DTM資料」](https://data.gov.tw/dataset/138563),
   該頁「授權方式」欄為**政府資料開放授權條款-第1版**、「計費方式」為**免費**、提供機關為地政司。
   OGDL v1 第二點(一)明文「**不限目的**⋯⋯進行利用」,即涵蓋商用([政府資料開放授權條款-第1版](https://data.gov.tw/license))。
   → 只證明**地形基礎**可商用,不及於建物模型。
2. 實體(離線)資料供應管道的授權說明(`tabidx=7`):
   > (五)其他事項 1.圖資授權之各項使用行為應適當以「顯名聲明」方式標示資料來源為內政部國土測繪中心。

   → 證明 NLSC 對三維圖資採「顯名聲明」型授權(與 OGDL v1 附件同一機制),但這是**公文離線申請**管道的條件,不是線上服務條款。

**結論:線上 3D Tiles 服務之商用許可,無法由一手來源確立,標記 `unverified`。** 若要公開發布商用/準商用產品,建議以正式函詢取得 NLSC 書面確認(見建議 R4)。

### 1.3 轉載 / 快取限制 — **條款未規範(`unverified`)**

服務使用條款**沒有任何條文**規範使用者端快取、代理(proxy)、鏡像或再散布 tile 內容。既無禁止,也無許可。與此相關的只有兩條間接條文:

- 第五點「本服務是不可移轉的(non-transferable)」— 文義指向**服務本身**(存取權)不得移轉,而非產出資料不得再散布;逐字解讀無法支撐「禁止快取」的結論。
- 第三點「本服務將會不斷更新,因此,您也可能需要配合適時適度修改您的網頁」— 隱含**要求跟隨最新版本**,對長期快取構成規範上的張力(快取愈久,愈偏離「不斷更新」的前提)。

**重要脈絡(對 Plan B 具決定性)**:臺北市的三維建物模型是 NLSC **整合自臺北市既有成果**,而非 NLSC 自行產製:

> (108年度)2. 整合臺北市及桃園市完整區域與新北市及高雄市部分區域之既有三維建物模型(LOD1)。
> (109年度)2. 整合臺北市完整區域更新之既有三維建物模型(LOD1)。(`tabidx=3`)

因此在實體資料供應章節,NLSC 明文將臺北市排除:

> 資料範圍:全國(**臺北市不供應;請逕洽臺北市政府資訊局**)(`tabidx=7`,離線與線上申請兩處皆同)

→ NLSC **不以任何離線管道供應臺北市建物資料**,並將需求導向臺北市政府資訊局。任何「自行取得副本並自託管」的路線,對臺北市而言不能經由 NLSC 取得授權,必須另尋臺北市政府之來源與授權。此點同時解釋了 FTP-6 記錄的 [data.gov.tw 民眾需求 136485](https://data.gov.tw/suggests/136485) 之陳情內容。

### 1.4 標示要求

- **服務條款第六點(拘束線上服務)**:「本服務所提供的地圖、影像或其他內容中可能包含本中心或相關識別資料或版權、著作權聲明等註記或符號,您不得以任何方式改變、移除或遮蔽這些識別資料或版權聲明。」
  → 這是**保留既有聲明**的義務(不得移除/遮蔽),對 client 端的意義:不得裁掉 tile 內嵌的來源註記,也不得以 UI 遮蔽。
- **圖資授權之顯名標示(離線管道原文)**:「圖資授權之各項使用行為應適當以『顯名聲明』方式標示資料來源為內政部國土測繪中心。」
  → 顯名聲明之格式依 [政府資料開放授權條款-第1版](https://data.gov.tw/license) 附件;FTP-6 的 `LICENSING.md` 已採該附件全文格式。
- 服務條款**未**規定線上服務的具體標示字樣或版位。

### 1.5 限流條款(AC3 的詮釋前提)

服務使用條款第九點賦予 NLSC **無須事先聲明**即限制「次數、資料量或網路頻寬」的權利。因此:

- 本 spike 量到的吞吐**不是承諾值**,是當日行為觀測;
- 「今日未被限流」不得寫入架構假設,任何依賴穩定吞吐的設計都缺乏條款支撐;
- 反過來,這也是量測必須克制的規範理由(script 內建 2 req/s 硬上限、遇 429 立即中止)。

## 2. AC2 — CORS 實測

**本 session 沒有 browser 工具,以下全部為 `curl` 取得的一手 response header。**

### 2.1 preflight(`OPTIONS`)— 失敗(405)

```sh
curl -X OPTIONS -H "Origin: https://furious-tp.example" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: content-type" \
  https://3dtiles.nlsc.gov.tw/building/tiles3d/0/tileset.json
```

```text
HTTP/1.1 405 Method Not Allowed
allow: GET
access-control-allow-origin: *
access-control-allow-headers: *
access-control-allow-methods: *
access-control-allow-credentials: true
```

真實 tile payload(`.../Terrain20M/tiles3d/電子地圖/0/0/0/tile.b3dm`)的 preflight 結果完全相同(405 + `allow: GET`)。

**判定**:依 Fetch 規範,preflight 必須回 ok-status(200–299)才算通過;405 **不通過**,即使帶了 `Access-Control-Allow-*`。→ **任何會觸發 preflight 的跨域請求都會被瀏覽器擋下**(自訂 header、非簡單方法等)。3D Tiles client 的預設請求是 simple GET,不觸發 preflight,故此限制在預設路徑上不致命,但**排除了任何需要自訂 header 的用法**。

### 2.2 實際 GET(帶 `Origin`)— 允許跨域

`tileset.json`:

```text
HTTP/1.1 200 OK
cache-control: no-cache,no-store
content-type: application/json; charset=utf-8
content-encoding: gzip
set-cookie: session-id=9996984d-1f13-41b7-b2bc-193f27e35f8c
access-control-allow-origin: *
access-control-allow-headers: *
access-control-allow-methods: *
access-control-allow-credentials: true
```

真實 tile payload `tile.b3dm`(98,056 bytes,magic 驗證為 `b3dm`):

```text
HTTP/1.1 200 OK
content-type: application/octet-stream; charset=utf-8
content-length: 98056
cache-control: no-cache,no-store
access-control-allow-origin: *
access-control-allow-credentials: true
```

### 2.3 判定與界限

1. **跨域讀取本身成立**:`ACAO: *` 出現在 tileset 與 tile payload 的實際 GET 上,無 `Vary: Origin`。
2. **不得使用 credentials 模式**:`ACAO: *` 與 `access-control-allow-credentials: true` 併存;瀏覽器在 `credentials: "include"` 時會拒絕萬用字元來源。Cesium 預設不送 credentials → 可用,但 client 設定中**不得**開啟 `withCredentials`。
3. **不得觸發 preflight**(見 2.1)。
4. 服務對**每個** response 下 `set-cookie: session-id=...`(無 `SameSite`/`Secure`),跨站 subresource 情境下瀏覽器不會採用;對 client 無影響,但顯示服務端維持每請求 session 狀態。

### 2.4 未執行事項(誠實揭露)

**我沒有在真實瀏覽器中載入過這個 tileset,也不宣稱做過。** 上述為 HTTP 層證據。仍需補做、且應由**能操作瀏覽器的人**執行的項目:

- 於 Chrome DevTools 實際以 `fetch()`/CesiumJS 跨域載入,確認無 console CORS 錯誤;
- 確認 §2.1 的 preflight 限制在 CesiumJS 實際請求路徑上未被觸發。

**指派建議**:由 operator(human)在 FTP-39 動工前執行,或併入 FTP-39 的第一項驗收(該票本就要求「建物顯示截圖」)。**但在第 3 節的缺陷修復前,這件事無法完成**——沒有可解析的 tileset.json,瀏覽器連載入都無從開始。

## 3. 阻擋性發現:`tileset.json` 回應無法解碼

### 3.1 現象

```sh
node --use-system-ca docs/spikes/nlsc-probe.mjs --mode=integrity \
  --url=https://3dtiles.nlsc.gov.tw/building/tiles3d/0/tileset.json --samples=2 --rps=1
```

輸出(節錄,exit code 4):

```json
{
  "integrity": { "attempts": 2, "decodable": 0,
    "defects": [{ "kind": "corrupt_content_encoding", "declared": "gzip",
                  "detail": "incorrect header check", "rawNulByteRatio": 1 }] },
  "versionSignals": { "etag": null, "lastModified": null,
                      "cacheControl": "no-cache,no-store" }
}
```

- 臺北市建物 `building/tiles3d/0/tileset.json`:HTTP 200、`content-length: 2775617`、`content-encoding: gzip`,body **100% 為 NUL bytes**(`rawNulByteRatio: 1.0`),兩次取樣 `sha256` 相同。
- 臺北市道路 `road2nd/tiles3d/0/tileset.json`:HTTP 200、`content-length: 418458` 固定,body **~99% NUL**,且 4 次取樣出現**兩種不同的 sha256**(內容逐次變動而長度不變,型態近似未初始化緩衝區)。
- 臺中市(代碼 1,13,440,439 bytes)、新北市(代碼 5,6,597,984 bytes)同樣為全 NUL body → **非臺北市專屬**。

### 3.2 排除本機/本網路因素(此為結論可靠性的關鍵)

| 檢驗 | 結果 |
|---|---|
| curl 8.10 (Schannel, HTTP/1.1) | `curl: (61) unknown compression method`;raw body 全 NUL |
| Node 24 `fetch`(undici, HTTP/1.1) | `Z_DATA_ERROR: incorrect header check` |
| Node 24 `http2`(ALPN h2) | 同樣收到 2,775,617 個 NUL bytes |
| 對照組:npm registry `/express`(gzip) | 正常,magic `1f8b0800` |
| 對照組:`data.gov.tw/license`(gzip) | 正常,magic `1f8b0800` |
| **不同網路的第三方抓取服務**(`r.jina.ai`) | 取同一 URL 回 `Failed to access ... Unrecognized or bad HTTP Content or Transfer-Encoding`(CURLE 61)——**與本機同因** |
| `r.jina.ai` 取同主機**未壓縮**的小 tileset | **成功**,回傳正常 JSON |

→ 三個獨立 HTTP 實作 + 一個獨立網路路徑一致失敗;同主機未壓縮回應在同一路徑上成功。**缺陷在服務端,不在本機。**

### 3.3 已嘗試且無效的繞道

`Accept-Encoding: identity`(服務仍回 gzip)、`Range: bytes=0-2047`(忽略 Range,回完整 body)、query string cache-bust、瀏覽器 User-Agent、`Origin`/`Referer` 偽裝、HTTP/2、重複請求(5 次,均失敗且內容不同)。

### 3.4 缺陷邊界

| 端點 | 是否 gzip | 結果 |
|---|---|---|
| `3dtiles.../tiles3d/Service`(服務清單) | 否 | **正常** |
| `3dtiles.../Terrain20M/.../0/0/0/tileset.json`(987 bytes) | 否 | **正常** |
| `3dtiles.../Terrain20M/.../tile.b3dm`(98 KB 二進位) | 否 | **正常**(magic `b3dm`) |
| `3dtiles.../building/tiles3d/{0,1,5}/tileset.json` | 是 | **損毀** |
| `3dtiles.../road2nd/tiles3d/0/tileset.json` | 是 | **損毀** |
| `i3s.nlsc.gov.tw/building/i3s/SceneServer/layers/0` | 是 | **正常**(不同主機) |

缺陷精確落在 `3dtiles.nlsc.gov.tw` 上**被壓縮的 `tileset.json`**。同一份資料經 I3S 主機供應時完好,顯示**資料存在、是 3D Tiles 的傳遞環節壞掉**。

### 3.5 資料本身存在(反證「臺北市無資料」的可能解釋)

```sh
curl -sS https://i3s.nlsc.gov.tw/building/i3s/SceneServer/layers/0   # 200, 2107 bytes, gzip 正常
```

解出的圖層文件:`name: "臺北市"`、`store.extent: [121.4489, 24.9451, 121.6737, 25.2236]`(涵蓋信義區
121.56–121.58 / 25.02–25.04)、`version: "646e7c8c-44f5-4ad5-83fd-4df03e7173f3"`、`capabilities: ["View","Query"]`。

## 4. AC3 — 限流 / 吞吐實測

### 4.1 量測倫理與 script 的內建克制

這是公開政府服務,且條款第九點允許機關隨時限流。[`nlsc-probe.mjs`](nlsc-probe.mjs) 因此把克制寫進程式,而非交給操作者自律:

- **序列請求**,無並行選項(`concurrency: 1`,自我測試以 fake server 的 `maxInFlight` 驗證);
- **硬上限 2 req/s**,`--rps` 超過即**夾住**(不是遵從),且夾住事實寫入輸出 `findings`;預設 1 req/s;
- **單一 429 立即中止**整輪(`abortReason: "rate_limited"`,exit 3),不重試、不硬闖,並記錄 `Retry-After`;
- 錯誤率超過 20%(且已達 5 次請求)即中止(`abortReason: "error_rate"`);
- `--max-requests` 預設 120,**涵蓋 tileset 探索與 tile 抓取兩階段**;
- 不送 cookie/authorization(匿名存取正是受測的存取模式)。

### 4.2 實測結果(信義區駕駛路線)

`tileset.json` 損毀使建物/道路圖層**無法量測**(連 tile URL 都取不到)。因此吞吐量測對象為**同一主機上唯一可解碼的 3D Tiles 服務** `Terrain20M`(電子地圖),路線為 script 預設的信義區行車取樣點(101 → 市府 → 松壽路),自 root 依 bounding volume 逐層下降至 depth 12 後,依路線順序循環抓取 tile。

| 執行 | rps | 請求數 | 狀態碼 | p50 | p95 | max | 429 |
|---|---|---|---|---|---|---|---|
| A | 1 | 60 | 60× 200 | 51 ms | 86 ms | 424 ms | 0 |
| B | 2 | 80 | 80× 200 | 42 ms | 82 ms | 403 ms | 0 |

兩輪皆 `aborted: false`、`findings: []`;探索到 17 個 tileset 節點與 17 個 tile。B 輪耗時 40.3 秒。

**判讀**:

- 傳遞基礎設施本身健康且低延遲(p95 < 90 ms),**未觀察到任何限流跡象**。
- 但這只證明 **≤2 req/s、≤80 requests** 這個量級不觸發限流。**本測試刻意不探測限流門檻**——探測門檻等同對公開服務施壓,且條款第九點已明示機關可隨時無預警調整。因此「限流門檻為何」標記為**不測定**,這是選擇,不是缺口。
- 量測對象是地形圖層而非建物圖層。**建物圖層的吞吐特性未經量測**,不得外推。

### 4.3 可重跑性

同一指令重跑產生同型 JSON(`schemaVersion: 1`,欄位固定),A/B 兩輪即為同型數據的實例。script 自我測試(12 項,local fake server,不打真實服務):

```sh
node --test docs/spikes/nlsc-probe.selftest.mjs   # tests 12 / pass 12 / fail 0
```

## 5. AC4 — tileset 改版偵測(RFC D5)

### 5.1 實測到的版本訊號

| 訊號 | `3dtiles` tileset.json | 說明 |
|---|---|---|
| `ETag` | **無** | 兩個端點、多次取樣皆未出現 |
| `Last-Modified` | **無** | 同上 |
| `Cache-Control` | `no-cache,no-store` | 明示不得快取,亦無版本語意 |
| `Expires` | `-1,0`(格式異常) | 無法作為訊號 |
| `asset.version`(tileset 內) | 無法讀取 | 因 §3 缺陷;Terrain20M 為 `"1.0"`,是 3D Tiles 規格版本,非資料版本 |
| I3S `version`(`i3s` 主機) | `646e7c8c-44f5-4ad5-83fd-4df03e7173f3` | **GUID,唯一可用的服務端版本識別** |

**HTTP 層沒有任何可用的版本指紋。**

### 5.2 官方更新頻率(決定輪詢節奏)

> 1.使用臺灣通用電子地圖建物框產製三維建物模型區域,**更新頻率為2年**⋯⋯
> 2.使用104年以後更新之1/1,000地形圖建物框產製三維建物模型區域,則俟有更新1/1,000地形圖時,再予更新(**更新頻率未定**)。(`tabidx=3`)

→ 變更**罕見但無排程**。這排除了「按時程重編」的做法,指向**低頻輪詢 + 內容比對**。

### 5.3 建議機制(D5)

1. **指紋來源:解碼後的 `tileset.json` 全文 sha256**,而非 raw body。
   **理由(本次實測直接證得)**:目前 raw body 是全 NUL 且**逐次穩定**,對 raw bytes 取雜湊會得到「穩定」的假象——指紋會忠實地追蹤損毀內容。
   `nlsc-probe.mjs` 已據此區分 `rawSha256` 與 `decodedSha256`,且在無任何可解碼樣本時輸出
   `bodyStableAcrossSamples: null`(不是 `true`)。
2. **輔助訊號:I3S 圖層文件的 `version` GUID**(`i3s.nlsc.gov.tw/building/i3s/SceneServer/layers/0`)。
   由**不同主機**供應,可在 3D Tiles 端損毀時仍偵測到資料改版;兩者不一致本身即為值得告警的訊號。
3. **輪詢節奏**:每日一次(對照 2 年更新頻率已極寬鬆),失敗採指數退避,**不得重試風暴**。
4. **告警條件**:
   - `decodedSha256` 變動 → 「tileset 改版」,觸發重新驗證流程(FTP-39/FTP-51);
   - 無法解碼(即今日狀態)→ 「服務缺陷」告警,**與改版分開**,否則缺陷會被誤報成改版;
   - I3S `version` 變動但 3D Tiles 指紋未動(或反之)→ 「來源不一致」告警。
5. **誤報風險**:tileset.json 若含 session/時間戳等易變欄位,會造成每次比對都不同。**本次無法驗證**(內容取不到);FTP-39 實作時必須先取得一份可解碼樣本,確認欄位穩定後再定案雜湊範圍(必要時排除易變欄位)。

## 6. 結論(三擇一)

> ### **不可行 — 且 Plan B(caching proxy)無法補救。**

推理:

1. **直串不可行**:`https://3dtiles.nlsc.gov.tw/building/tiles3d/0/tileset.json` 回 HTTP 200 但 body 不是其宣告的 gzip 資料流(100% NUL)。3D Tiles client 的第一個請求就是 tileset.json;取不到 root tileset,CesiumJS 連場景都無從開始。道路圖層同樣損毀。
2. **Plan B 無法補救**:caching proxy 的上游就是同一個端點,取到的是同一份壞位元組。proxy 只能快取它拿得到的東西;此處拿不到。
3. **「自行取得副本自託管」對臺北市不成立**:NLSC 明文「臺北市不供應;請逕洽臺北市政府資訊局」,線上與離線申請兩個管道皆排除臺北市。
4. **但問題不在資料**:同一份臺北市建物資料經 I3S 主機供應時**完整可解碼**,extent 涵蓋信義區。這是**傳遞環節的伺服器缺陷**,不是資料不存在,也不是政策封鎖。
5. **授權面另有未決事項**:線上服務之**商用許可**與**快取/再散布**在條款中皆無規範(§1.2、§1.3),即使缺陷修好,這兩點仍需肯定性答覆才能支撐公開產品。

依 ticket 規定,結論為「不可行」→ 已發 `[escalate]` + `needs-human`。**架構前提(永久串官方 + 無動態後端)在此缺陷修復前不成立**,FTP-39 / FTP-51 不應在此前提上動工。

## 7. 建議(可執行,對應後續 ticket)

| # | 建議 | 對應 |
|---|---|---|
| R1 | **向 NLSC 回報缺陷**(客服信箱 `23207@mail.nlsc.gov.tw`,「線上瀏覽及服務介接相關問題」之官方窗口)。附本報告 §3 的重現方式與 `nlsc-probe.mjs`。此為**唯一能解除阻擋的動作**,且只有 human 能發函。 | 新票(human-only) |
| R2 | **評估 I3S 路線**:CesiumJS 具 `I3SDataProvider`。本 spike **僅驗證 I3S 圖層文件可解碼**,未驗證 node pages/geometry 抓取、效能、與 D5 指紋整合。需獨立 spike,不得直接當成既定路線。 | 新 spike 票 |
| R3 | **查證臺北市政府資訊局的 3D 建物來源**(NLSC 官方指向的窗口),作為完全獨立於 NLSC 的來源選項。 | 新 spike 票 |
| R4 | **函詢 NLSC 確認線上服務之商用許可與快取/再散布界線**(§1.2、§1.3 為 `unverified`)。 | 新票(human-only) |
| R5 | **FTP-39 暫緩**:AC「本地 dev server 於信義 bbox 顯示 NLSC 建物」在缺陷修復前不可能達成。該票的「NLSC URL 設定集中於單一設定檔」仍應保留,並擴充為可切換 3D Tiles / I3S / 替代來源。 | FTP-39 |
| R6 | **`LICENSING.md` 的 NLSC 條目暫不能定稿**(見 §8)。 | FTP-6 後續 |
| R7 | **不要探測限流門檻**。條款第九點允許機關隨時無預警限流;門檻資訊對架構的價值低於施壓公開服務的代價。 | 本報告立場 |

## 8. 對 `LICENSING.md`(FTP-6)的影響

FTP-6 已將 NLSC 條目標為「待 FTP-5 定稿」。**本 spike 的結論是:仍不能定稿**,但可以把待決事項寫得更精確(本票不修改 `LICENSING.md`,屬 FTP-6 / 後續票的 Scope):

- **不能**寫成「NLSC 3D 建物依 OGDL v1 釋出」。本次查證未找到涵蓋線上 3D 建物服務的 OGDL 標示;data.gov.tw 上找到的 OGDL 依據是**20m DTM**(dataset 138563),那是平臺採用的地形基礎,不是建物。
- **可以**寫入的已證事實:(a) 線上服務由平臺「服務使用條款」治理,該條款**未規範商用與快取/再散布**;(b) 條款第六點課予「不得改變、移除或遮蔽既有版權/識別聲明」之義務;(c) NLSC 對三維圖資之授權採「顯名聲明」標示資料來源為內政部國土測繪中心(離線管道原文);(d) **臺北市建物模型係整合自臺北市既有成果,NLSC 不供應臺北市實體資料,並指向臺北市政府資訊局** — 這代表 props 圖層若採臺北市建物,授權來源機關可能是**臺北市政府而非 NLSC**,顯名聲明的對象要跟著改。
- 待 R1/R4 有答覆後,才能決定 NLSC 條目寫成「可散布 + 顯名聲明」或「不得自託管散布」。

## 9. 未查證 / 未執行事項彙總(不以推論充數)

| 項目 | 狀態 | 原因 |
|---|---|---|
| 瀏覽器實際渲染 / DevTools CORS 確認 | **未執行** | 本 session 無 browser 工具;且缺陷未修復前無法完成(§2.4) |
| 線上服務商用許可 | `unverified` | 條款無規範(§1.2) |
| 快取 / 再散布界線 | `unverified` | 條款無規範(§1.3) |
| 建物圖層吞吐特性 | **無法量測** | tileset 損毀,取不到 tile URL(§4.2) |
| 限流門檻 | **不測定** | 刻意不探測(§4.2、R7) |
| tileset.json 欄位穩定性(D5 誤報風險) | **未驗證** | 內容取不到(§5.3) |
| I3S 完整路線可行性 | **未驗證** | 僅驗證圖層文件可解碼(§3.5、R2) |
| 缺陷是否為間歇性 | **部分** | 當日對 4 個受損端點共 20 次以上請求、3 種 HTTP 實作、2 個網路路徑均失敗;未做跨日觀測 |
