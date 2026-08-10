# Spike R1:NLSC 三維國家底圖 3D Tiles 服務可行性實測與條款查證

> **狀態**:進行中(declaration commit — 查證清單已凍結,結果尚未填入)
> **Ticket**:FTP-5(RFC v2 R1,阻擋性)
> **性質**:工程盡職調查(engineering due diligence),**非正式法律意見**。
> **產物**:本報告 + 可重跑量測 script(`nlsc-probe.mjs`,實驗用,不進正式模組)。
> **關聯**:結論決定 `LICENSING.md`(FTP-6)的 NLSC 條目、FTP-39(client 串流)、FTP-51(hosting)。

## 查證清單(exam;declaration commit 凍結)

每一項完成的標準:附**一手出處**(條文原文引用/實測 response header/script 輸出),
未達標者標記 `unverified` 並寫明原因。**推論不得充當證據。**

### AC1 — 條款查證(商用許可、轉載/快取限制、標示要求)

- [ ] 找出治理 3D Tiles 服務之條款文件本身,附取得方式與時間
- [ ] **商用許可**:引用條文原文;若條款未規範,明確記為 `unverified` 並說明「無明文允許亦無明文禁止」之區別
- [ ] **轉載/快取限制**:引用條文原文(含「自行快取/代理/再散布」是否落入禁止範圍)
- [ ] **標示要求**:引用條文原文 + 標示格式來源
- [ ] **限流條款**:引用機關保留限制次數/資料量/頻寬之條文(影響 AC3 詮釋)
- [ ] 資料來源之第三方權利(臺北市建物模型之來源機關)查證,附出處

### AC2 — CORS 實測

- [ ] `tileset.json`:preflight(OPTIONS + `Origin` + `Access-Control-Request-*`)完整 response header
- [ ] `tileset.json`:實際 GET(帶 `Origin`)完整 response header
- [ ] **真實 tile payload**(非 JSON):實際 GET 完整 response header + payload magic 驗證
- [ ] 判定:瀏覽器跨域直接載入是否成立,含 preflight 觸發條件與 credentials 模式之界限
- [ ] **未執行項目誠實揭露**:本 session 無 browser 工具,瀏覽器實際渲染確認由誰補做

### AC3 — 限流/吞吐實測(模擬駕駛存取模式)

- [ ] 可重跑 script 存在,`--help` 可用,輸出為固定 schema 之 JSON
- [ ] script **內建保守 rate limit**(預設值 + 硬上限),且 header 說明此設計理由
- [ ] script 遇 429 / 錯誤率上升**立即中止**並在輸出標記中止原因
- [ ] 實測結果:延遲統計(p50/p95)、狀態碼分佈、是否觸發限流/封鎖
- [ ] 樣本不足時輸出 `insufficientSamples` 而非假統計
- [ ] script 自我測試(local fake server,不打真實服務)全綠,並記錄輸出

### AC4 — tileset 改版偵測(RFC D5)

- [ ] 實測 `ETag` / `Last-Modified` / `Cache-Control` 是否可用作版本指紋(附 header 證據)
- [ ] 服務端是否另有版本欄位可用(附證據)
- [ ] 圖資更新頻率之官方說明(附條文出處)
- [ ] 指紋機制建議:資料來源、比對方式、告警條件、誤報風險

### AC5 — 三擇一結論

- [ ] 結論明確落在「直串可行 / 需 caching proxy(Plan B)/ 不可行」其一,附推理
- [ ] 建議事項可執行(對應到後續 ticket)
- [ ] 若結論為「不可行」:已發 `[escalate]` + `needs-human`
- [ ] `[progress]` 摘要已 post 於 FTP-5

## 查證結果

_(declaration commit:尚未填入。)_

## 結論

_(declaration commit:尚未填入。)_
