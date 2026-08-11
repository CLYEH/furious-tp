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

**所有參數都必須是具名旗標;位置參數一律拒絕**(靠 `node:util` `parseArgs` 的 `strict` 預設 —— 本 repo 並未顯式設定 `allowPositionals`,行為相同但選項字面不存在,先前的寫法是錯的)。

這條在實務上擋掉的東西很具體:PowerShell 的呼叫運算子會吃掉 `--` 分隔符,`npm run bench -- --routes offroad-south --cache warm --label X` 到 node 手上可能變成 `bench/run.ts offroad-south warm X`。**若 CLI 接受位置參數,那次呼叫會產出一份看起來完全正常、但配置是預設值的報告** —— 路線可能對、快取模式卻不是你要的,而報告上沒有任何地方看得出來。

寧可 exit 2 吵一聲,也不要一份沒有人會發現有問題的報告。同理,路線檔解析失敗**整個跑中止**,不會略過那條路線繼續跑。

**但位置參數檢查擋不到另一種形狀,而它在本票真的發生過:** 少打 `--` 分隔符時(`npm run bench --cache cold`),**npm 會自己把 `--cache cold` 吃掉**(並建立一個 `./cold` 目錄當它的 cache),旗標**從來沒有到達 `run.ts`** —— run.ts 收到一組合法的預設值,產出一份完全正常的報告,而配置不是你要的那組,**且沒有任何位置參數可供偵測**。

因此報告會**原樣記錄解析後的設定**(`config`:routes / cacheStates / memoryMinutes / warmupFrames / viewport / gpuPreference / headless)。「同一版本量兩次」必須包含「同一組設定」,而一份無法自證設定的報告支撐不了那句話。**請務必寫 `npm run bench -- --cache cold`。**

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

代價要講清楚:**模擬速度與 wall-clock 速度脫鉤**。各路線實際速度為 `xinyi-dense` 51.12、`expressway-straight` 83.07、`offroad-south` 73.47 m/s;以 offroad-south 為例,若每幀真的花 130 ms,相機在真實時間裡只前進約 9 m/s。**因此本 harness 對串流的壓力低於「真實時間以同樣速度駕駛」**。這是為了 AC1 的可重現性刻意付的代價,D6 也明確要求可重現性。

### 冷/熱快取的實際意義比字面小

冷 = 全新 browser profile(HTTP cache 空);熱 = 重用同一個 profile。但 **FTP-5 實測 NLSC 服務禁止快取其 tileset**,所以「熱」只熱在 bundle、Cesium 資產與服務允許快取的部分,**不是整個場景**。

## ⚠ 這個 harness 檢查「哪一顆 GPU」,**不檢查「那顆 GPU 上還有誰」**

兩件事常被當成同一件:

| 問題 | 誰負責 | 性質 |
| --- | --- | --- |
| 這次跑在**哪一顆** GPU 上? | **本 harness**(`src/rig.ts`) | 自動;每次跑都檢查;不符即 invalid 並在量測前中止 |
| 那顆 GPU 上**還有誰**? | `RIG.md` 的 preflight(FTP-47) | **人工程序** |

D6 的七項量測條件裡有「**無其他 GPU 負載**」。**本 harness 擋不到它** —— 它讀 `UNMASKED_RENDERER_WEBGL`,那個字串只說明是哪張卡,**不說明卡上還跑著什麼**。

**這是兩份文件之間沒有人自動負責的一格**,而且不是假想:本票的 r1–r4 期間,owner 的 Brave × 2 與 Acrobat 確實**常駐**於同一顆 GPU。

**但「常駐」就是能講的全部,不要多講一個字。** 實測(60 樣本):**那三個程式閒置、沒有 bench 在跑時,GPU 利用率是平的 0%。** 量測進行中所看到的起伏(40 樣本,0–54%)**是本 harness 自己的 Chrome 在算圖** —— 消費級顯卡的 nvidia-smi **沒有 per-process 利用率**,總利用率在我們自己正在算圖時取樣,**主要來源就是我們自己**。

因此本 harness **不主張、也不允許主張**「重跑之間的離散來自這些程式」。`externalGpuLoad` 記錄的是**有誰在場**,不是它們吃掉多少。

> 這一段本身有前科:同一個主張在 round 1 被撤回(從 PR body 與 `gpuload.ts` 移除),卻換了一個數字活在這份 README 裡,一路出貨,**由 verifier 在 merge 之後才抓到**。現在它被 `src/retractions.test.ts` 當成可執行的不變式守著,而不是靠記得。

報告的 `environment.externalGpuLoad` 因此記錄:量測起訖時的 GPU 利用率,以及**排除 dwm 與本 harness 自己的 chrome 之後**仍佔用該 GPU 的行程清單。

**只記錄,不據此中止。** 中止會丟掉已完成的資料,而本專案的原則是**標記,不丟棄**;判定「這批能不能用」屬於讀報告的人與 FTP-49,不屬於 harness。

## 靜止相機實測:成本來自 frustum,不是來自移動

用同一個量測頁面、同一組啟動旗標、同一個 headless 設定,**相機完全靜止**跑五個相位(NLSC 回應數由 Playwright response 事件計):

| 相位 | 相機 | NLSC 回應 / bytes | render p50 |
| --- | --- | --- | --- |
| A 空 frustum(太平洋上空、俯角 −90),**尚未載入任何 tile** | 靜止 ×400 | 1 / 3.18 MB | **1.90 ms** |
| B **`offroad-south` 第 0 幀位姿**,靜止不動 | 靜止 ×900 | 301 / **98.03 MB** | **230.30 ms**(後半段 229.20) |
| C `offroad-south` 最後一幀位姿,靜止 | 靜止 ×900 | 132 / 14.86 MB | 60.20 ms |
| D 同 B 的位置,但改看正下方(俯角 −90) | 靜止 ×400 | 51 / 20.74 MB | 27.00 ms |
| E 空 frustum,**在載完 130 MB 之後** | 靜止 ×400 | 0 / 0 MB | **11.20 ms** |

三件事同時成立:

1. **這個 harness 量得出「快」。** A 相位 p50 = 1.90 ms —— **反方向的對照存在而且通過**,計時沒有 30 ms 的地板。
2. **229 ms 是穩態,不是串流暫態。** B 相位相機不動四分鐘,後半段仍是 229.2 ms。
3. **成本由 frustum 裡有多少城市決定。** 同一位置只把俯角從 −8 改成 −90,230 ms → 27 ms。

**因此本 repo 目前沒有任何一條路線量的是 D1 所謂的「空場景」。**

而且「空」本身有歧義。**同一個空 frustum**,在 tileset 常駐與否之下成本不同 —— 重複相位以排除 session 老化後的區間:

| 狀態 | 觀測 |
| --- | --- |
| 未載入任何 tile | **1.50 – 1.90 ms**(A1 1.90 / A2 1.50) |
| 常駐約 98 MB tileset | **6.90 – 8.00 ms**(E1 6.90 / E2 8.00) |
| 常駐約 130 MB(單一觀測) | 11.20 ms |

**台階是真的,而它跨在 D1 的 6 ms 兩側。** 未載入時遠低於 6 ms,常駐後 6.9–8.0 已經超過,130 MB 那一筆更明顯超過 —— **但 11.20 只是單一觀測,不足以撐起一個會決定翻不翻案的門檻**,故此處給區間並註明常駐量。

**結論:D1 的 6 ms 必須先定義「空」是哪一種空**(冷啟動的空?還是跑了一段路之後、tileset 已常駐的空?),否則同一個門檻會落在台階的兩側,給出相反的答案。

## ⚠ 本輸出**不能**用來判定 D1 的 6 ms 翻案條款

D1 的翻案觸發器是「**空場景 + NLSC tiles 的基礎 frame 開銷 > 6 ms** → 立刻改走 Three.js + 3d-tiles-renderer」。把上面兩個限制擺在一起,結論是硬的:

- **主序列高估那個量** —— frame time **含** tile streaming 與 tileset traversal 的主執行緒成本(`Cesium3DTileset.update()` 就在 `scene.render()` 裡面)。**歸因要正確:這不是「因為相機一直在動」** —— 相機**完全凍結** 900 幀,成本依然是 **229 ms 的穩態**。成本由 **frustum 裡有多少城市**決定,不是由相機是否移動、也不是由相機底下有什麼決定。
- **主序列同時低估那個量** —— 主序列**不含** GPU 的非同步執行時間,瀏覽器沒有介面可讀。

**一個同時高估又低估目標量的數字,不能拿去跟 6 ms 比。**

這與「跑在內顯上卻標成 RTX」是**同一個形狀**的錯誤:標籤寫著「renderer 開銷」,內容其實來自別的東西 —— 上次是 iGPU,這次是網路與一個缺口。差別在於**這一個會導致「把整個渲染引擎換掉」的決定**,所以寧可明說判不了。

**結論:本 harness 目前的輸出不足以支持、也不足以反對 D1 的翻案。** 需要 FTP-49 重述,建議方向:

1. **本機 tile fixture** —— 把網路移出量測迴圈。D1 問的是渲染器的成本,把網路留在迴圈裡就是答非所問。**這是最正解的一條**,而且是上表 A/B/E 三個相位唯一沒有推翻的方向。
2. ~~靜止相機的穩態視窗~~ —— **已實測推翻,不要走這條。** 相機凍結 900 幀,後 450 幀 p50 仍是 **229.2 ms**,期間持續拉 tile。停住相機**不會**把串流移出迴圈,它量到的就是那個 frustum 的穩態成本。
3. **GPU 側計時**(如 `EXT_disjoint_timer_query_webgl2`)補上非同步缺口,或明確承認缺口、只用 CPU 側預算來談 16.6 ms 分配表。

在那之前,`frameTimesMs` 的**低百分位**(min / p05)是「這一幀幾乎沒有 tile 進來」的下界**提示** —— **是提示,不是判定**。

## ⚠ 已知限制(讀數字前請先讀)

這兩條也寫在**每一份報告的 `limitations` 欄位**裡,因為讀報告的人未必看得到這份 README。

### 1. `foreignProcessesPresent: false` 在這台 rig 上**從未被觀測過**

owner 的 Brave × 2 與 Acrobat 常駐於同一顆 GPU。單元測試涵蓋 `false` 這條路徑(dwm 以 PID 反查排除後即為 `false`),**但實機上沒有人看過它**,因為那需要關掉 owner 正在用的程式。

因此讀到 `true` 時請理解它的確切含意:**偵測到常駐行程**,不是「本次量測受到干擾」。消費級顯卡的 nvidia-smi 沒有 per-process 利用率,**它們吃掉多少並未被量到**。

### 2. 真實 console Ctrl-C 是否觸發 handler,**未在本平台驗證**

已端到端驗證的是:`--max-seconds` 觸發 abort → 報告寫出 → `valid: false` → 保留部分資料 → exit 1,且路線在一個 `POSE_BATCH` 內停下(以 60 s 與 200 s 兩個中止點分別得到 300 與 600 幀,**確認是批次的整數倍而非固定常數**)。

**未驗證的是 handler 本身的接線** —— Windows 上 `kill` 與 Node 的 `child.kill("SIGINT")` 都對應 `TerminateProcess`,handler 不會執行、行程 0.1 秒就死,**兩者都無法用來驗證這件事**。需要人真的按 Ctrl-C。

## 這台機器上量到了什麼(交付時的實測結果)

這一節存在的理由很具體:以下數字先前**只活在 PR body 裡**,而 PR body 會被 squash 進 commit message —— **讀這個目錄的人看不到它**。

### AC1a 可重播:**成立**

三條路線的每一幀位姿,在**兩個獨立建構的 autopilot** 之間 bitwise 相同(第二個較晚建構、逆序走訪、中間插入 busy-wait),mismatch 為 0。相機路徑是 `frameIndex` 的純函數,不吃 wall clock。

### AC1b「同版本重跑兩次 p95 差 < 1 ms」:**未達**

`offroad-south`、同一版本、冷快取四次:

| run | p50 | **p95** | p99 | 1% low | hitches |
| --- | --- | --- | --- | --- | --- |
| r1 | 116.00 | **351.60** | 671.20 | 1009.50 | 1146 |
| r2 | 118.30 | **369.50** | 720.40 | 1027.11 | 1154 |
| r3 | 127.70 | **398.30** | 698.30 | 1074.86 | 1213 |
| r4 | 127.70 | **432.30** | 728.90 | 1097.26 | 1193 |

**p95 全距 80.70 ms(中位數的 21.84%),六組配對全部未達。** 熱快取三次:349.50 / 386.90 / 397.50,全距 48.00 ms,同樣未達。

**沒有任何限定條件。** 不主張這與其他程式的 GPU 佔用有關(見上一節:那三個程式閒置時利用率為 0)。

**為什麼這條無法在本票判定**:它量的不是 harness,而是「場景 + 網路 + 機器熱狀態」的合成離散,**而 harness 已證明它自己給出的輸入是 bitwise 確定的**(AC1a)。報告目前**沒有任何欄位能區分**那些成因,所以:

> **跨 run 的 p95 漂移,目前不能拿來當 FTP-49 的回歸基線。** 同版本四次之間就已經出現 21.84% 的位移,而「p95 劣化 10% 即 fail」會把它讀成程式碼回歸。

依裁決,AC1b 的重述移交 **FTP-49**(需補的欄位見下方交接段)。

### 記憶體:本專案第一次量到成長(路線 `xinyi-dense`)

**注意:以下數字全部來自 `xinyi-dense`,不是上面那四筆 `offroad-south`。** 兩組路線相鄰卻不同源 —— `RIG.md` 的規則是每個數字都要能追到產生它的條件,路線就是條件之一。

來源:一次完整的 48 分鐘跑(`valid: true`,含 15 分鐘記憶體循環),報告檔名尾碼 `-fullcw`。

```
路線 xinyi-dense,15 分鐘記憶體循環
126.6 MB → 510.5 MB    +303.21%    歷時 15.3 分鐘,樣本數 3
```

**D6 的門檻是 < 10%。** 判定屬 FTP-49(已另開 **FTP-72** 追);數字先記在這裡。**保留:15 分鐘只裝得下 3 個樣本**,以三點推成長率偏薄,**且尚未排除 `heapBytes()` 本身的可信度** —— 先判定它是不是真的洩漏,再談修。

同一次跑、同樣是 **`xinyi-dense`** 的另一個觀察:**warm 的 p95(687.90)比 cold(664.70)慢** —— 與「NLSC 服務禁止快取其 tileset」相符,「熱」並沒有讓場景變快。

## 三條路線(RFC D6 的 M1 三型)

| 檔案 | id | 型 | 今天量到什麼 |
| --- | --- | --- | --- |
| `routes/01-xinyi-dense.json` | `xinyi-dense` | 高密度建物 | NLSC 建物最密的一段,D1 的 6 ms 問題主要是在問這條 |
| `routes/02-expressway-straight.json` | `expressway-straight` | 高速長直線 | 直線橫越整個 M1 切片,壓的是串流路徑 |
| `routes/03-offroad.json` | `offroad-south` | off-road | **本 repo 目前最重的視角之一,不是最輕的。** 140–170 m、俯角 −6…−9°,frustum 直達地平線、裝進整個臺北盆地;**相機凍結**在第 0 幀位姿仍穩定在 **229 ms/幀**,並拉進 301 個 NLSC 回應 / 98 MB。**它不是「近空場景基線」,不得如此閱讀。** 地形(FTP-40)改變的是腳下,不是它真正在付錢的天際線 |

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
  "schemaVersion": 2,
  "config": { /* 本次實際使用的設定:routes / cacheStates / memoryMinutes / warmupFrames / viewport / gpuPreference / headless / maxSeconds */ },
  "limitations": [ /* 隨數字一起出貨的已知限制,見「已知限制」一節 */ ],
  "environment": { /* CPU / GPU / 瀏覽器 / 啟動旗標 / 螢幕 / 電源 / headless / externalGpuLoad */ },
  "routes": [ {
    "valid": …, "frameTimesMs": [...], "summary": {...}, "drift": {...},
    "presentIntervalsMs": [...],
    // 與 frameTimesMs 等長;跨批次邊界的樣本索引記在這裡並排除於 presentSummary 之外
    "presentIntervalBoundaryIndices": [300, 600],
    "presentSummary": {...}
  } ],
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

瀏覽器是唯一無法在考卷裡涵蓋的部分。排程、冷熱順序、中斷處理、失敗處理、**批次規劃**與 **GPU 佔用判讀**都已抽到可檢驗的模組(`session.ts` / `batching.ts` / `gpuload.ts`),可以不用 GPU 就完整檢驗 —— AC5 的中斷是靠**注入式 abort** 確定性釘住的,不是靠「剛好中斷一次」。

### ⚠ 考卷到不了的範圍:**`src/driver.ts` 與 `page/main.ts` 整個檔案**

先前的文件只點名 `driver.ts`,**那個範圍是錯的**。`page/main.ts` **完全沒有 runtime 覆蓋**(`driver.ts` 對它只有 `import type`,執行期會被抹除),而它握著:

| 在 `page/main.ts` 裡 | 為什麼要緊 |
| --- | --- |
| 逐幀計時迴圈(`performance.now()` 包住 `widget.render()`) | **AC2 主序列的唯一來源** |
| `readGpu()` | `gpuRenderer` / `gpuAccepted` 的唯一來源,**rig 閘門與負向對照全靠它** |
| `measurePresentInterval()` / `frameRateLimitDefeated` | 呈現節奏與「上限是否解除」的判定 |
| `heapBytes()` | 頁面側記憶體讀數的後備 |

**已實測的後果**:把 `readGpu()` 換成回傳寫死的 RTX 字串、完全不碰 WebGL —— **lint、typecheck、全部測試皆過,`--gpu auto` 仍回報 `gpuAccepted: true`**。負向對照被完全擊敗而沒有任何閘門察覺。

**所以 `gpuAccepted` 與 AC2 主序列的可信度,都懸在同一個沒有任何測試到得了的檔案上。** 這是本 harness 目前最大的單一缺口,**不是** `driver.ts`。
