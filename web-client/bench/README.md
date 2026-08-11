# bench — D6 效能量測 harness

RFC D6 的 **reference rig 本地 harness**。產出 frame time 原始序列與摘要統計 JSON。

**這裡不做判定。** D6 的門檻(p95 ≤ 16.6 ms、p99 ≤ 33 ms、無 >100 ms hitch、15 分鐘記憶體成長 <10%)與基線回歸屬 **FTP-49**。本 harness 只回答「量到什麼」,不回答「夠不夠快」。

rig 規格見 `RIG.md`(FTP-47)。本 harness 負責**檢查**跑測時真的在那台機器的那顆 GPU 上。

## 跑

```bash
cd web-client
npm run bench                                   # 三條路線 x 冷/熱 + 15 分鐘記憶體循環
npm run bench -- --routes xinyi-dense --cache cold --memory-minutes 0
npm run bench -- --gpu auto                     # 負向對照(見下)
```

**`npm run bench` 需要 Node ≥ 22.18(或 ≥ 23.6)** —— 它直接跑 `.ts`,靠 Node 內建的 type stripping。CI 用 Node 20,但 **CI 不跑 bench**(D6:CI runner 無獨顯,bench 是 rig 本地 harness),`lint`/`typecheck`/`test` 在 Node 20 下都正常涵蓋 `bench/`。

### 旗標打錯時,這個 CLI 會拒絕而不是猜

**所有參數都必須是具名旗標;位置參數一律拒絕(`allowPositionals: false`)。**

這條在實務上擋掉的東西很具體:PowerShell 的呼叫運算子會吃掉 `--` 分隔符,`npm run bench -- --routes offroad-south --cache warm --label X` 到 node 手上可能變成 `bench/run.ts offroad-south warm X`。**若 CLI 接受位置參數,那次呼叫會產出一份看起來完全正常、但配置是預設值的報告** —— 路線可能對、快取模式卻不是你要的,而報告上沒有任何地方看得出來。

寧可 exit 2 吵一聲,也不要一份沒有人會發現有問題的報告。同理,路線檔解析失敗**整個跑中止**,不會略過那條路線繼續跑。

| 旗標 | 預設 | 說明 |
| --- | --- | --- |
| `--routes a,b` | 全部 | 只跑指定路線 id |
| `--cache cold\|warm\|both` | `both` | 冷快取 = 全新瀏覽器 profile;熱 = 重用同一個 |
| `--memory-minutes N` | `15` | 記憶體循環長度;`0` 跳過 |
| `--warmup N` | `0` | 每條路線前面幾幀只算暖機、不列入統計(會記進報告) |
| `--viewport WxH` | `1920x1080` | D6 量測條件 |
| `--headed` | 否 | 開有頭瀏覽器 |
| `--gpu high-performance\|auto` | `high-performance` | 見「哪顆 GPU」 |
| `--out DIR` / `--label S` | `bench/reports` | 報告輸出位置與檔名標籤 |

離開碼:`0` = 報告 valid,`1` = 報告 **invalid**(跑沒跑完 / GPU 不對),`2` = 參數或路線檔錯誤。
**`1` 不代表「太慢」** —— 它代表「這些數字不能拿來判定」。

## 哪顆 GPU —— 本 harness 最重要的一條

reference rig 是**雙顯卡筆電**(RTX 4060 + Intel UHD)。實測:`chrome.exe` 的 GpuPreference 交給 Windows 決定,而 **Windows 預設會選 Intel UHD**。

這不是精度問題,是**判準會反過來**的問題:D1 的翻案條件是「Cesium 基礎開銷 > 6 ms 就換掉 renderer」。拿內顯的數字去判,那個條件會成立,於是專案會因為一顆**根本不該參與量測的 GPU** 而丟掉整個渲染引擎。

所以:

1. 預設帶 `--force-high-performance-gpu`,且**實際使用的完整旗標會寫進報告**(`environment.launchArgs`)。
2. 每次跑都讀 `UNMASKED_RENDERER_WEBGL`,寫在報告**最上層**(`gpuRenderer`、`gpuAccepted`,就在 `valid` 旁邊)。
3. **不符 rig 的 GPU → 整份報告 invalid**,而且**在量測開始前就中止**(不浪費 20 分鐘產生注定被拒絕的數字)。
4. `--gpu auto` 是**負向對照**:它故意不帶旗標,在這台機器上真的會落到 Intel UHD,用來證明上面那條斷言擋得住這台機器**實際會發生**的失敗 —— 這比用假字串測強。

## 量到的到底是什麼(請先讀完再看數字)

### 主序列 `frameTimesMs` = `widget.render()` 的主執行緒耗時

harness **自己驅動 render loop**(`useDefaultRenderLoop = false`),逐幀計時 `widget.render()`。

為什麼不用 rAF 間隔:rAF 由呈現節奏決定,實測在這台機器上被鎖在 ~17 ms(有頭)/ ~31 ms(無頭)。用它當 frame time 的話,**任何「夠快」的場景都會回報那個上限**,和「剛好花 16.6 ms」無法區分,D1 的「基礎開銷是否 > 6 ms」永遠不可能被回答。這正是 `src/scene/boot.ts` 檔頭警告的同一個陷阱。

**它不含什麼:GPU 的非同步執行時間。** 瀏覽器沒有提供讀取的介面。主序列是「主執行緒產生一幀的成本」,不是完整的 frame time。**這是一個已知缺口,不要當成完整值使用。**

### 次序列 `presentIntervalsMs` = 相鄰呈現幀的間隔

留著是為了讓「呈現節奏是否主導」看得見,而不是被靜默當成 frame time。`environment.frameRateLimitDefeated` 是**實測**的(閒置時 rAF 中位數 < 4 ms 才算解除),不是「因為帶了旗標就宣稱解除」。

**無頭模式沒有螢幕**,所以 `screen.presentCadenceHz` 是 headless compositor 的合成節奏,**不是面板的更新率**。`environment.headless` 記在旁邊就是為了不讓人誤讀。

### frame time 裡包含 tile streaming

`render()` 內部會處理當幀送達的 tile(traversal、GPU 上傳、shader 編譯)。所以串流成本**算在** frame time 裡。這對 D6 是對的(使用者確實看到那一幀變慢),但也表示:**路線前段的數字被串流主導,而不是穩態渲染成本。** 報告的 `drift` 欄位會顯示這個下降趨勢。

### 固定模擬步長 ⇒ 可重播,但串流壓力低於真實速度

autopilot 的位姿是 **frameIndex 的純函數**,不吃 wall clock。這是 AC1「可重播」能成立的原因:兩次跑走過**完全相同**的相機位置。

代價要講清楚:**模擬速度與 wall-clock 速度脫鉤**。路線宣告 80 m/s,但若每幀真的花 130 ms,相機在真實時間裡只前進約 9 m/s。**因此本 harness 對串流的壓力低於「真實時間以同樣速度駕駛」**。這是為了 AC1 的可重現性刻意付的代價,D6 也明確要求可重現性。

### 冷/熱快取的實際意義比字面小

冷 = 全新 browser profile(HTTP cache 空);熱 = 重用同一個 profile。但 **FTP-5 實測 NLSC 服務禁止快取其 tileset**,所以「熱」只熱在 bundle、Cesium 資產與服務允許快取的部分,**不是整個場景**。

## ⚠ 這個 harness 檢查「哪一顆 GPU」,**不檢查「那顆 GPU 上還有誰」**

兩件事常被當成同一件:

| 問題 | 誰負責 | 性質 |
| --- | --- | --- |
| 這次跑在**哪一顆** GPU 上? | **本 harness**(`src/rig.ts`) | 自動;每次跑都檢查;不符即 invalid 並在量測前中止 |
| 那顆 GPU 上**還有誰**? | `RIG.md` 的 preflight(FTP-47) | **人工程序** |

D6 的七項量測條件裡有「**無其他 GPU 負載**」。**本 harness 擋不到它** —— 它讀 `UNMASKED_RENDERER_WEBGL`,那個字串只說明是哪張卡,**不說明卡上還跑著什麼**。

**這是兩份文件之間沒有人自動負責的一格**,而且不是假想:本票的 r1–r4 就是在 Brave × 2 與 Acrobat 同時佔用同一顆 GPU 的狀態下取得的(利用率在數秒內於 7%–55% 間擺盪)。

為什麼這一格特別會咬人:**外來 GPU 負載的起伏本身就會造成重跑之間的離散。** 於是「p95 重現不了」會有兩個**無法區分**的解釋 —— NLSC 串流的本質變異,或別的程式在各次 run 之間負載不同。**兩者產生一模一樣的觀測。** 因此「在受污染條件下 AC1 做不到」與「AC1 在這台機器上做不到」是**兩個不同的命題**,前者不能當後者用。

報告的 `environment.externalGpuLoad` 因此記錄:量測起訖時的 GPU 利用率,以及**排除 dwm 與本 harness 自己的 chrome 之後**仍佔用該 GPU 的行程清單。

**只記錄,不據此中止。** 中止會丟掉已完成的資料,而本專案的原則是**標記,不丟棄**;判定「這批能不能用」屬於讀報告的人與 FTP-49,不屬於 harness。

## ⚠ 本輸出**不能**用來判定 D1 的 6 ms 翻案條款

D1 的翻案觸發器是「**空場景 + NLSC tiles 的基礎 frame 開銷 > 6 ms** → 立刻改走 Three.js + 3d-tiles-renderer」。把上面兩個限制擺在一起,結論是硬的:

- **主序列高估那個量** —— frame time **含** tile streaming 的主執行緒成本。相機一直在移動,tile 就一直在進來,量到的是**串流節奏**而不是穩態渲染成本。
- **主序列同時低估那個量** —— 主序列**不含** GPU 的非同步執行時間,瀏覽器沒有介面可讀。

**一個同時高估又低估目標量的數字,不能拿去跟 6 ms 比。**

這與「跑在內顯上卻標成 RTX」是**同一個形狀**的錯誤:標籤寫著「renderer 開銷」,內容其實來自別的東西 —— 上次是 iGPU,這次是網路與一個缺口。差別在於**這一個會導致「把整個渲染引擎換掉」的決定**,所以寧可明說判不了。

**結論:本 harness 目前的輸出不足以支持、也不足以反對 D1 的翻案。** 需要 FTP-49 重述,建議方向:

1. **本機 tile fixture** —— 把網路移出量測迴圈。D1 問的是渲染器的成本,把網路留在迴圈裡就是答非所問。這是最正解的一條。
2. **靜止相機的穩態視窗** —— 相機停住、等 tile 收斂後才開始取樣,量到的才是「這個場景一幀多貴」。
3. **GPU 側計時**(如 `EXT_disjoint_timer_query_webgl2`)補上非同步缺口,或明確承認缺口、只用 CPU 側預算來談 16.6 ms 分配表。

在那之前,`frameTimesMs` 的**低百分位**(min / p05)是「這一幀幾乎沒有 tile 進來」的下界**提示** —— **是提示,不是判定**。

## 三條路線(RFC D6 的 M1 三型)

| 檔案 | id | 型 | 今天量到什麼 |
| --- | --- | --- | --- |
| `routes/01-xinyi-dense.json` | `xinyi-dense` | 高密度建物 | NLSC 建物最密的一段,D1 的 6 ms 問題主要是在問這條 |
| `routes/02-expressway-straight.json` | `expressway-straight` | 高速長直線 | 直線橫越整個 M1 切片,壓的是串流路徑 |
| `routes/03-offroad.json` | `offroad-south` | off-road | **地形(FTP-40)還不存在**,底下是灰色橢球殼,只有邊緣有零星建物。**今天它是「近空場景基線」,不是 off-road 駕駛量測。** FTP-40 進來後意義會變,**前後數字不可比較** |

路線定義是資料:spline 走 centripetal Catmull-Rom,並**以弧長重參數化**,所以「固定速度」是固定的**公尺/幀**,而不是固定的參數步進 —— 否則 waypoint 排得密的地方相機用爬的,frame time 會變成在描述作者怎麼排檔案。

## 報告

寫到 `bench/reports/bench-<時間>[-label].json`(內容不進版控)。

頂層鍵的順序是刻意的:

```jsonc
{
  "valid": false,              // 第一個鍵。讀者先遇到它,才遇到任何數字
  "invalidReason": "…",
  "gpuRenderer": "ANGLE (NVIDIA, … RTX 4060 …)",   // 哪顆 GPU 畫的
  "gpuAccepted": true,
  "schemaVersion": 1,
  "environment": { /* CPU / GPU / 瀏覽器 / 啟動旗標 / 螢幕 / 電源 / headless */ },
  "routes": [ { "valid": …, "frameTimesMs": [...], "summary": {...}, "drift": {...} } ],
  "memory": { "growthRatio": …, "gpuBytes": null, "power": {...} }
}
```

規則:**標記,不丟棄**。跑到一半被中斷、GPU 不對、路線只跑完一半 —— 資料都留著,但報告在最上層說自己不可信。反過來說,**沒有任何情況會產生「看起來正常、其實只有半條路線」的 JSON**。

幾個刻意的 `null`:

- `memory.gpuBytes` 永遠是 `null` 加一段說明。D6 要求 GPU 記憶體成長,但頁面讀不到。**寫 `0` 會被讀成「沒有成長」,那是最漂亮的謊。**
- `routes[].drift` 為 `null` 表示「序列太短、量不出來」,不是「沒有漂移」。

### 統計定義(寫死,不靠預設)

- 百分位 = **nearest-rank**,`P(q) = sorted[ceil(q*n)-1]`。不插值,所以回報的每個值都是**真的發生過的**一幀。
- **1% low** = 最慢 `ceil(n/100)` 幀的平均(至少 1 幀)。
- **hitch** = **嚴格大於** 100 ms。剛好 100 ms 不算。
- **drift** = 前 1/4 與後 1/4 的**中位數**比值;> 1.1 標為疑似熱節流。用中位數而非平均,是因為後段一次 900 ms 卡頓會把平均拉過門檻,報出一個沒發生過的熱事件。這是**診斷**,不是判定。

## 這台機器上的已知事實

- 這是**筆電**:15 分鐘循環足以進熱節流,插電與電池結果不同。報告記錄循環的起訖時間與電源狀態(`memory.power`),`drift` 顯示是否有系統性上升。
- 無頭 Chrome 仍然拿得到獨顯(已實測 ANGLE/D3D11 NVIDIA),所以預設用無頭 —— 它給到精確的 1920×1080 drawing buffer,沒有視窗邊框干擾。

## 開發

```bash
npm run lint / typecheck / test    # 三者都已涵蓋 bench/
```

`bench/` 有自己的 `tsconfig.json` 與 `vitest.config.ts`,因為根層的 include 清單不在 FTP-48 的 Scope 內;`package.json` 的三個 script 都會跑到這裡,讓 harness 與其他程式受同一組閘門管。

瀏覽器是唯一無法在考卷裡涵蓋的部分,所以它被隔離在 `src/driver.ts` 後面(`BenchDriver` 介面)。排程、冷熱順序、中斷處理、失敗處理全部在 `src/session.ts`,可以不用 GPU 就完整檢驗 —— AC5 的中斷就是靠**注入式 abort** 確定性地釘住的,不是靠「剛好中斷一次」。
