# Bench reference rig 規格(RFC D6)

D6 的效能預算 —— `p95 ≤ 16.6ms`、`p99 ≤ 33ms`、以及 D1「Cesium 基礎開銷 > 6ms 就改走
Three.js」的翻案門檻 —— **沒有指定機器就沒有意義**。同一份場景在獨顯桌機與內顯筆電上
可以差 5–10 倍,任何一個數字都要先講清楚它是在哪一台機器、哪一種機器狀態下量出來的。

這份文件記錄那台機器,以及**如何確認跑 bench 的當下它真的處在規格內**。

每一項規格都附取得它的指令。這不是格式潔癖:一份沒有人能複核的規格,幾個月後就只是
一段沒人敢動也沒人信的文字。**規格與檢查一起寫,才是規格。**

- **Reference rig** = owner 開發機(owner 於 FTP-47 裁定:「就是這台機器」)。
  所有 60 FPS 判定以此為準,`npm run bench` 在這台本機跑(CI runner 無獨顯)。
- **Floor rig** = 每 milestone 抽查一次的下限機。**實體機器尚未指定**,見第 5 節。

## 1. 硬體與軟體規格

實測日期 **2026-08-11**,由 FTP-47 於該機器讀出。「取得指令」欄的輸出是這些值的來源,
不是事後補的註腳 —— 值與指令對不上時,**以指令輸出為準**,並更新本表(見第 6 節)。

| 欄位 | 值 | 取得指令(PowerShell) |
| --- | --- | --- |
| CPU | 13th Gen Intel Core i7-13620H(10 核 / 16 執行緒) | `Get-CimInstance Win32_Processor \| Select-Object Name,NumberOfCores,NumberOfLogicalProcessors` |
| RAM | 31.71 GB | `"{0:N2} GB" -f ((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)` |
| 獨顯(bench 用) | NVIDIA GeForce RTX 4060 Laptop GPU | `nvidia-smi --query-gpu=name --format=csv,noheader` |
| 獨顯 VRAM | 8 GB(8188 MiB) | `nvidia-smi --query-gpu=memory.total --format=csv,noheader` |
| 內顯(**不得**用於 bench) | Intel UHD Graphics | `Get-CimInstance Win32_VideoController \| Select-Object Name` |
| GPU 驅動(NVIDIA 版號) | `566.14` | `nvidia-smi --query-gpu=driver_version --format=csv,noheader` |
| GPU 驅動(Windows 版號) | `32.0.15.6614` —— 與上一列是同一顆驅動的兩種寫法 | `Get-CimInstance Win32_VideoController \| Where-Object { $_.Name -match 'NVIDIA' } \| Select-Object DriverVersion` |
| OS | Windows 11 Home,10.0.26200(Build 26200),64-bit | `Get-CimInstance Win32_OperatingSystem \| Select-Object Caption,Version,BuildNumber,OSArchitecture` |
| 螢幕 | 1920 x 1080 @ 144 Hz | `Get-CimInstance Win32_VideoController \| Where-Object CurrentHorizontalResolution \| Select-Object CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate` |
| Chrome | 151.0.7922.76(2026-08-11 當日) | `@("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") \| Where-Object { Test-Path $_ } \| ForEach-Object { (Get-Item $_).VersionInfo.ProductVersion }`(涵蓋全機與 per-user 兩種安裝位置) |
| Node | v24.14.1(2026-08-11 當日) | `node --version` |

**Chrome 與 Node 的版號是快照,會過期,而且應該過期。** D6 要求的是「Chrome 最新穩定版」,
不是某一個版號;釘死版號只會製造一條每次 Chrome 自動更新就亮紅燈的假檢查。因此這兩列
**標日期、不做斷言**,只在報告中記錄當次實際版本。硬體列則相反:它們變了就是換機器,
要走第 6 節。

### 兩個不要相信的數字

- **不要用 WMI `Win32_VideoController.AdapterRAM` 讀 VRAM。** 那是 32 位元欄位,對
  8 GB 的 4060 回報 4.0 GB —— 截斷後的假值。VRAM 一律以 `nvidia-smi` 為準。
- **不要用 `powercfg /getactivescheme` 判斷電源模式。** 理由見 2.1。

## 2. 量測條件(RFC D6)

D6 列的條件:1920×1080、Chrome 最新穩定版、乾淨 profile、**強制獨顯**、**高效能電源**、
無其他 GPU 負載;冷/熱快取分開記錄。

其中**強制獨顯**與**高效能電源**是機器狀態,不是文件敘述。**這台機器的預設狀態不滿足
「強制獨顯」**(見 2.2),所以這兩條各自配一個會擋人的檢查,而不是一句應然。

### 2.1 開跑前:機器狀態檢查(preflight)

跑 bench 前執行。**exit code = 不符項數;全通過為 0。**

直接整段貼進 PowerShell 視窗即可。若要存成 `.ps1`,**請存成 UTF-8 with BOM** —— Windows
PowerShell 5.1 會把不帶 BOM 的 zh-TW 字面值當 ANSI 讀,直接爆字串未結束的解析錯誤。

```powershell
$fail = 0
function Check($name, $ok, $detail) {
  $tag = if ($ok) { 'PASS' } else { $script:fail++; 'FAIL' }
  Write-Output ("{0}  {1} — {2}" -f $tag, $name, $detail)
}

# 1. 電源:必須插電,且 AC 電源模式為 Max Performance overlay。
$batt = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
$onAc = ($null -eq $batt) -or ($batt.BatteryStatus -eq 2)
$ov = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes').ActiveOverlayAcPowerScheme
Check '插電' $onAc "BatteryStatus=$($batt.BatteryStatus) (2=AC)"
Check 'AC 電源模式' ($ov -eq 'ded574b5-45a0-4f42-8737-46345c09c238') "ActiveOverlayAcPowerScheme=$ov"

# 2. 獨顯存在且 VRAM 為真值(nvidia-smi,不是 WMI AdapterRAM)。
$smi = (nvidia-smi --query-gpu=name,memory.total --format=csv,noheader) 2>$null
Check '獨顯 + VRAM' ($LASTEXITCODE -eq 0 -and $smi -match 'RTX 4060' -and [int](($smi -split ',')[1] -replace '\D') -ge 8000) "nvidia-smi: $smi"

# 3. 顯示模式:必須「只有一台顯示器」且為 1920x1080 @ 144Hz。
#    不可只取第一筆:Win32_VideoController 的列舉順序沒有保證,接上外接螢幕後
#    「取第一筆」是擲硬幣 —— 排到內建面板就會在 4K 螢幕接著的狀態下 PASS。
$modes = @(Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution })
$dispOk = $modes.Count -eq 1 -and $modes[0].CurrentHorizontalResolution -eq 1920 -and $modes[0].CurrentVerticalResolution -eq 1080 -and $modes[0].CurrentRefreshRate -eq 144
$dispTxt = (@($modes | ForEach-Object { "$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution) @ $($_.CurrentRefreshRate)Hz" }) -join '; ')
Check '顯示模式' $dispOk "$(@($modes).Count) display(s): $dispTxt"

# 4. 無其他 GPU 負載。
#    只排除 dwm.exe(桌面視窗管理員):它開機起常駐、關不掉,是清單裡唯一的永久成員。
#    先取 PID 再用 Get-Process 解名字,而不是吞掉 nvidia-smi 的 [Insufficient Permissions]
#    —— 後者會把真正不明的高權限 GPU 佔用者一起藏掉。
#    chrome 不豁免:preflight 跑在 bench 之前,那時 bench 的 Chrome 還不存在,豁免它
#    只會放行日常瀏覽器對 GPU 的佔用。
$util = [int]((nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader) -replace '\D')
$gpuPids = @(nvidia-smi --query-compute-apps=pid --format=csv,noheader) | Where-Object { $_ }
$apps = @($gpuPids | ForEach-Object { (Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue).ProcessName }) |
  Where-Object { $_ -and $_ -ne 'dwm' }
Check 'GPU 閒置' ($util -le 5 -and $apps.Count -eq 0) "utilization=$util%; 其他佔用 GPU 的行程: $(if ($apps.Count) { $apps -join '; ' } else { '(無)' })"

# 5. 版本記錄(不做斷言,理由見第 1 節)。
$chromeExe = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
Write-Output ("INFO  Chrome = {0}" -f $(if ($chromeExe) { (Get-Item $chromeExe).VersionInfo.ProductVersion } else { '(找不到 chrome.exe)' }))
Write-Output ("INFO  Node   = {0}" -f (node --version))

Write-Output ''
Write-Output $(if ($fail -eq 0) { '全部通過:機器處於 RIG.md 規格內。' } else { "$fail 項不符 —— 此時量到的數字不得用於 D6 判定。" })
exit $fail
```

**這條檢查不是橡皮圖章。** 2026-08-12 於這台機器實際執行,當時背景開著 Brave 與 Acrobat:

```text
PASS  插電 — BatteryStatus=2 (2=AC)
PASS  AC 電源模式 — ActiveOverlayAcPowerScheme=ded574b5-45a0-4f42-8737-46345c09c238
PASS  獨顯 + VRAM — nvidia-smi: NVIDIA GeForce RTX 4060 Laptop GPU, 8188 MiB
PASS  顯示模式 — 1 display(s): 1920x1080 @ 144Hz
FAIL  GPU 閒置 — utilization=0%; 其他佔用 GPU 的行程: brave; brave; Acrobat
INFO  Chrome = 151.0.7922.76
INFO  Node   = v24.14.1

1 項不符 —— 此時量到的數字不得用於 D6 判定。
```

同一時刻 `nvidia-smi` 吐出的**完整**清單如下(四筆,沒有省略):

```text
21032, C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe
24204, C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe
2000, [Insufficient Permissions]
22936, C:\Program Files\Adobe\Acrobat DC\Acrobat\Acrobat.exe
```

**第三筆 PID 2000 就是 `dwm.exe`** —— 它是高權限行程,非提權的 `nvidia-smi` 解不出名字,
只吐 `[Insufficient Permissions]`,但 `Get-Process -Id 2000` 不提權就解得出 `dwm`。它開機
後即常駐、整個 session 都在,**是這份清單裡唯一關不掉的成員**。這就是檢查必須指名排除
它、而且必須用 PID 反查名字的原因:若照名字字串過濾,它會永遠留在清單裡,`GPU 閒置`
就變成一條**沒有任何機器狀態能通過**的檢查 —— 正是本節下面要說的那種「比沒有檢查更糟」。

### 每一條檢查的兩個方向

一條檢查要能用,得同時成立兩件事:**不符時真的會擋**,而且**符合時真的通得過**。這是兩
個獨立的證明 —— 只證明前者,可能得到一條永遠亮紅燈、因而被當雜訊略過的檢查。

| 檢查 | 不符時會回報什麼 | 通得過的狀態 |
| --- | --- | --- |
| 插電 | 拔掉電源線 → FAIL,印出 `BatteryStatus=1` | 插電時 PASS(上面的實跑) |
| AC 電源模式 | 調離「最佳效能」→ FAIL,印出實際 overlay(`961cc777-…` = Better Battery-life,或 `00000000-…` = 無 overlay) | AC overlay 為 `ded574b5-…` 時 PASS(上面的實跑) |
| 獨顯 + VRAM | `nvidia-smi` 不存在、獨顯被停用、或卡對但 VRAM 不足 → FAIL,印出實際 `nvidia-smi` 回應 | 4060 + 8188 MiB 時 PASS(上面的實跑) |
| 顯示模式 | 接上第二台顯示器 → FAIL(**不論列舉順序**);解析度或更新率不對 → FAIL。訊息印出顯示器數量與**每一台**的實際模式 | 單一 1920x1080@144 面板時 PASS(上面的實跑) |
| GPU 閒置 | 任何非 dwm 的行程佔著 GPU、或 utilization > 5% → FAIL,並**列出行程名** | 關掉那些行程後 PASS,整份 exit=0 |

最後一列是這份文件修過的一個實際缺陷:早先的版本只用名字字串排除 `chrome.exe`,`dwm`
於是永遠留在清單裡,`GPU 閒置` 恆 FAIL、exit code 恆 ≥ 1,而本節開頭卻寫著「全通過為
0」—— 一個不可達的宣稱。**一個永遠回報「不符」的檢查,幾週後就會被當成雜訊略過,那比
沒有檢查更糟。**

順帶一提,`chrome` **不在**豁免名單裡是刻意的:preflight 跑在 bench **之前**,那時 bench
的 Chrome 還不存在,豁免它只會放行你日常開著的瀏覽器對 GPU 的佔用。

#### 為什麼電源檢查讀的是 overlay,不是 `powercfg /getactivescheme`

D6 寫「高效能電源」,直覺會去讀電源計畫。**在這台機器上那樣讀會得到錯的答案。**
`powercfg` 只列得出一個電源計畫:

```text
> powercfg /list
Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced) *
```

(經典的 High performance 計畫 `8c5e7fda-…` 沒有被列出;它的 registry key 仍在,用 GUID
仍可 `/setactive` 啟用 —— 只是不出現在清單裡,所以照清單看會以為沒有這個選項。)

照這個讀,結論會是「這台機器是 Balanced,不符合 D6」。**但那是讀錯了旋鈕。** Windows 11
真正的「電源模式」是 **overlay**,`getactivescheme` 根本不報告它:

```text
> Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'
ActiveOverlayAcPowerScheme : ded574b5-45a0-4f42-8737-46345c09c238
ActiveOverlayDcPowerScheme : 00000000-0000-0000-0000-000000000000
```

GUID 的意義由 OS 自己解(不是查表猜的):

```text
> Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes\ded574b5-45a0-4f42-8737-46345c09c238'
FriendlyName : @C:\WINDOWS\system32\powrprof.dll,-1403,Max Performance Overlay
```

所以這台機器**插電時**確實處於 Max Performance,符合 D6;**拔電時**的 overlay 是
`00000000`(無 overlay),不符合。這就是為什麼檢查同時看電源來源與 AC overlay,而
「這台機器是 Balanced 所以不符 D6」是讀錯了旋鈕。

一個永遠回報「不符」的檢查,幾週後就會被當成雜訊略過 —— 那比沒有檢查更糟。

### 2.2 強制獨顯:預期的 renderer 字串

這是雙顯卡筆電。**Chrome 實際跑在哪一顆,文件擋不住,只有斷言擋得住。**

唯一可信的來源是 WebGL 的 `WEBGL_debug_renderer_info` → `UNMASKED_RENDERER_WEBGL`
(`gl.RENDERER` 被 Chrome 遮成 `WebKit WebGL`,不能用)。在 bench 用的 Chrome 分頁的
DevTools console 執行:

```js
const gl = document.createElement("canvas").getContext("webgl2");
const ext = gl.getExtension("WEBGL_debug_renderer_info");
gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
```

**合格值(bench 唯一可接受的 renderer):**

```text
ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028A0) Direct3D11 vs_5_0 ps_5_0, D3D11)
```

**不合格時實際會看到的值** —— 這不是假設,這是這台機器**預設**會給的答案:

```text
ANGLE (Intel, Intel(R) UHD Graphics (0x0000A7A8) Direct3D11 vs_5_0 ps_5_0, D3D11)
```

判定用 `UNMASKED_RENDERER_WEBGL` 是否含 `NVIDIA GeForce RTX 4060` 即可;字串尾端的
ANGLE/D3D 細節會隨 Chrome 與驅動改版而變,不要整串比對。

#### 預設啟動的 Chrome 會用內顯 —— 必須加旗標

2026-08-11 實測(headed Google Chrome、乾淨 profile):

| Chrome 啟動方式 | `UNMASKED_RENDERER_WEBGL` | 可用於 bench |
| --- | --- | --- |
| 預設 | `ANGLE (Intel, Intel(R) UHD Graphics …)` | 否 |
| 加 `--force-high-performance-gpu` | `ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU …)` | 是 |

成因是 Windows 的 per-app GPU 偏好把 chrome.exe 設為「讓 Windows 決定」:

```powershell
(Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\DirectX\UserGpuPreferences').'C:\Program Files\Google\Chrome\Application\chrome.exe'
# GpuPreference=0;   ← 0 = 系統決定、1 = 省電、2 = 高效能
```

因此:

- **harness 必須以 `--force-high-performance-gpu` 啟動 Chrome。** 這是 bench 自己能保證
  的路徑,不依賴機器設定,也不依賴任何人記得去調。
- 手動開 Chrome 量測時,同一個旗標要自己帶;或把上面那個登錄值改成 `GpuPreference=2;`
  (Windows 設定 → 顯示 → 圖形 → chrome.exe → 高效能)。
- **兩者都沒做時,量到的是內顯。** 此時整份報告是**無效**,不是「偏慢」—— 一份看起來
  正常、其實來自別顆 GPU 的報告,會讓 D6 的 16.6ms 預算與 D1 的翻案門檻被拿錯的硬體
  判定,比沒有報告更糟。

harness 讀到的 renderer 必須寫進報告最上層,不符即把整份標為 invalid。本節的合格字串
就是那個斷言比對的對象:**文件寫預期值,harness 執行檢查,兩邊指向同一個字串。**

### 2.3 其餘 D6 條件

| 條件 | 落實方式 |
| --- | --- |
| 1920×1080 | preflight 第 3 項要求**只有一台顯示器**且模式為 1920x1080@144(接了第二台就 FAIL,不論列舉順序);bench 視窗尺寸另由 harness 固定,兩者都要成立 |
| Chrome 最新穩定版 | 不釘版號(理由見第 1 節);每次 run 記錄實際版本進報告 |
| 乾淨 profile | 每次 run 用全新的暫時 user-data-dir,不沿用日常 profile(擴充套件、既有快取都會污染數字) |
| 強制獨顯 | 2.2 的旗標 + 斷言 |
| 高效能電源 | 2.1 的 preflight |
| 無其他 GPU 負載 | 2.1 的 preflight;bench 執行期間不要開其他瀏覽器/影片/遊戲 |

## 3. 冷/熱快取

D6 要求冷、熱快取**分開記錄**,不可混為一個數字。

- **冷快取**:全新 profile、未載入過任何 tile 的第一趟。反映首次到訪的體驗,也是 NLSC
  串流延遲最吃重的情況。
- **熱快取**:同一 profile 已跑過同一路線之後的重跑。

兩者的 pass/fail 各自對 D6 門檻判定,不互相取代。冷快取數字天然較差,拿熱快取數字宣稱
「符合 60 FPS」是把最惡劣路徑藏起來。

## 4. 量測協定(D6 摘要)

> **這一節是 RFC D6 數字的副本,只為閱讀方便而存在。任何一項與 D6 原文不一致時,以
> D6 原文為準**,並回頭修正本節 —— 副本天生會漂,不要拿它去推翻 RFC。

- 每次 **3 runs 取中位**;JSON 報告入 repo artifact。
- 回歸判定:對前版基線 **p95 劣化 > 10% 即 fail**。
- 指標:frame time p50/p95/p99 + 1% low;**pass = p95 ≤ 16.6ms 且 p99 ≤ 33ms 且無 > 100ms
  hitch**(不採平均 FPS)。
- 記憶體:15 分鐘循環後,JS heap(強制 GC 後)與 GPU memory 成長 **< 10%**。
- Cesium 基礎開銷單獨輸出 —— D1 翻案檢查點(> 6ms 即改走 Three.js + 3d-tiles-renderer)。

## 5. Floor rig — 定義已記載,實體機器尚未指定

D6 是**兩台制**。Floor rig 的定義與頻率照 D6 原文記載:

- **規格級別**:6GB VRAM 級,RTX 3060 / 2060 同級。
- **抽查頻率**:**每 milestone 抽查一次**,**不做逐 PR 門檻**(逐 PR 門檻只在 reference
  rig 上跑)。

> **實體機器尚未指定。** owner 目前只提供了 reference rig。**首次 milestone 抽查前需由
> owner 提供 floor rig 機器規格**,屆時在本節補上與第 1 節同規格的表(含取得指令),
> 並補一份對應的 preflight —— 那台機器的電源與獨顯狀態同樣需要檢查,且很可能不是這台
> 的那組 GUID 與字串。
>
> 在此之前:**floor rig 沒有任何實測數字,任何「已在下限機驗證」的宣稱都不成立。**

## 6. 這份文件什麼時候要改

- **換機器、換顯卡、加減記憶體、換螢幕** → 第 1 節整表重讀一次(用該列的取得指令),
  並在此註明變更日期;既有基線數字**不可跨機器沿用**,要重建基線。
- **顯卡驅動更新** → 更新驅動版號並註明日期;若 p95 有明顯位移,在報告中標注驅動變更,
  不要默默併入同一條基線。
- **Chrome / Node 更新** → 不必改本文件(不釘版號),報告會記錄當次版本。
- **owner 指定 floor rig** → 補完第 5 節。
- **第 2.2 節的合格 renderer 字串變了**(換卡或 ANGLE 改格式)→ 本文件與 harness 的
  斷言**同一個 PR 一起改**;只改一邊,就回到了「文件寫一套、實際跑另一套」的狀態,
  而那正是這一節存在的原因。
