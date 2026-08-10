# tile 網格與座標框架 spec

`spec_version = 0.1.0` · 常數正典來源:[`constants/grid.json`](../constants/grid.json) · 自檢:`node contracts/tests/check_spec.mjs`

## Tile 網格(EPSG:3826)

**CRS**:EPSG:3826(TWD97 / TM2 zone 121)。橫麥卡托投影:中央經線 121°E、尺度因子 k0 = 0.9999、假東距 250 000 m、假北距 0 m、橢球 GRS80。單位:公尺。ETL 全程統一使用本 CRS(RFC D2)。

**tile 尺寸**:`tile_size_m = 500`。選定理由:為內政部 20 m DTM 網格的整數倍(每邊 25 格,地形頂點可與 tile 邊界對齊)、串流粒度適合車速移動、且 500 在 IEEE-754 double 下可精確表示,tile 邊界座標(500 的整數倍)無捨入誤差。

**網格原點**:EPSG:3826 座標原點 (0, 0)。全網格為單一層級(LOD 於後續版本另訂)。

**索引規則**(座標 → tile id):

```text
tx = floor(E / tile_size_m)
ty = floor(N / tile_size_m)
```

tile id 以整數對 `(tx, ty)` 表示;文字形式為 `{tx}_{ty}`(例:`611_5535`)。

**tile id → 座標範圍**:

```text
E ∈ [tx · tile_size_m, (tx + 1) · tile_size_m)
N ∈ [ty · tile_size_m, (ty + 1) · tile_size_m)
```

**邊界歸屬**:min 邊**含**、max 邊**不含**(min-inclusive / max-exclusive)。恰落在共享邊界上的點屬於索引較大的 tile。例:點 (309000, 2771000) 屬於 tile (618, 5542),不屬於 (617, 5541)。

**M1 驗算基準**(引 [`constants/m1_area.json`](../constants/m1_area.json)):bbox E [305500, 309000] × N [2767500, 2771000] 覆蓋 7 × 7 = 49 tiles;四角 tile 依上式為 SW (611, 5535)、SE (617, 5535)、NW (611, 5541)、NE (617, 5541)。

## Per-tile 座標框架與量化

**local origin**:tile 的 min 角落 `(tx · tile_size_m, ty · tile_size_m, h0)`。`h0` 為該 tile 宣告的高度基準,欄位位置由 tile 格式票定義。

**`h0` 選取規則**:令 `h_min` 為該 tile **閉區間**(含四條邊界)內所有頂點的最小高度,則

```text
h0 = floor(h_min / z_step_m) × z_step_m
```

依此規則 `h0` **必須是 `z_step_m` 的整數倍**(接縫規則條款 3 的前提),且 `h0 <= h_min`,故 tile 內所有頂點的 `q_z >= 0`。pipeline 不得自行選用其他基準。

**軸向**:local X = E − E0(向東)、local Y = N − N0(向北)、local Z = h − h0(向上)。

**XY 量化**:`xy_quant_max = 65535`(16-bit)。量化值 q ∈ [0, 65535] 對應 local 座標 [0, tile_size_m]:

```text
還原:x = q · tile_size_m / xy_quant_max
量化:q = round(x / tile_size_m · xy_quant_max)   （round half up）
```

解析度 ≈ 500 / 65535 ≈ 7.63 mm。q = 0 與 q = 65535 精確對應 tile 的 min / max 邊界(無捨入)。

**Z 量化**:全域固定步長 `z_step_m = 1/64`(= 0.015625 m,2^-6,double 可精確表示)、`z_quant_max` = 65535(16-bit):

```text
還原:h = h0 + q_z · z_step_m          q_z ∈ [0, z_quant_max]
量化:q_z = round((h - h0) / z_step_m)   （round half up）
```

`h0` 之上的**可編碼跨距**為 `65535 × 1/64 = 1023.984375` m。注意此值是 `z_quant_max × z_step_m`;`(z_quant_max + 1) × z_step_m` 是可表示值的**個數**乘以步長,不是跨距,以該式編碼會在上界溢位 16-bit。垂直解析度 15.625 mm。步長為全域常數而非 per-tile 縮放,是接縫規則(見下)得以成立的前提。

**合規條件**:令 `h_max` 為該 tile 閉區間內所有頂點的最大高度,則

```text
h_max - h0 <= z_quant_max × z_step_m
```

超出者為**不合規 tile**:pipeline 必須失敗並回報,不得截斷或改用 per-tile 縮放。機械檢查由 contracts 驗證器(FTP-23 起)執行。

**M1 預算檢核**(實測值凍結於 [`constants/m1_area.json`](../constants/m1_area.json) 的 `z_budget`):

| 項目 | 實測最壞 tile | 跨距 | 佔可編碼跨距 |
| --- | --- | --- | --- |
| 地形起伏 | (617, 5536) | 241.0 m(ASTER30m 交叉檢核 251.0 m) | 23.5% |
| 含地表以上幾何 | (613, 5539) | 508.0 m(台北101,該 tile 地面約 3 m) | 49.6% |

兩列各自獨立成立:即使建物**外觀**由 NLSC 3D Tiles 直接串流(RFC D1)而不進本格式,自建物輪廓擠出的 physics collider 仍是 per-tile 荷載,故第二列有效;而縱使不計任何地表以上幾何,第一列的地形起伏也已用掉舊 255.99609375 m 預算的 94%(SRTM30m)至 98%(ASTER30m)。

參數即由此選定:16-bit × 1/64 m 的 1023.984375 m 跨距,對實測最壞 tile 有 2.02 倍餘裕,滿足契約自訂的 `required_margin_factor` >= 1.5;而 15.625 mm 垂直解析度仍比來源資料(20 m DTM,公尺級垂直精度)精細兩個數量級 —— 在 16-bit 預算下,餘裕比解析度值得買。作為對照,1/256 m 步長只有 255.99609375 m 跨距:對 (613, 5539) 短少一半以上,對地形最壞 tile 也只剩約 15 m,不可行。實測值為**下界**(30 m DEM 會低估真實起伏,本專案實際使用解析度更高的 20 m DTM),故 `required_margin_factor` 不得低於 1.5。

## ECEF 轉換慣例(D2)

Runtime(CesiumJS / Rapier)以地心座標 ECEF 放置幾何。規範性轉換鏈:

```text
(E, N)  --[逆橫麥卡托,GRS80,參數同上]-->  (φ, λ)
h_ellip = h + geoid_offset_m
(φ, λ, h_ellip)  --[geodetic → geocentric,GRS80]-->  (X, Y, Z)
```

**逐頂點施加(規範性)**:上述轉換鏈必須**逐頂點**(per-vertex)施加;**不得以 per-tile 剛體變換代替** —— 例如把 tile 原點轉成 ECEF 後,將 local X/Y 當作該點 ENU 切平面上的位移量再旋轉擺放整塊 tile(CesiumJS 的慣用做法)。

理由(實測值凍結於 `constants/m1_area.json` 的 `frame_survey`,該區塊四個數字皆為本 bbox 的全域極值並向外取整):本 bbox 的子午線收斂角(格網北與真北的夾角)為 0.2325–0.2476 度,在 500 m 邊長上即產生公尺級的旋轉差。以 per-tile 剛體 ENU 變換擺放時,tile 角落與逐頂點鏈最大相差 3.03 m;相鄰兩 tile 各自這樣擺放同一條共用邊上的點,最大裂縫 2.142 m。兩種讀法若都合法,接縫規則就形同虛設,故此處擇一寫死。

- **高程慣例(v0.1)**:tile 內高度 h 為來源資料公布值(內政部 DTM 為 TWVD2001 正高)。`geoid_offset_m` 定義於 `constants/m1_area.json`(大地起伏是區域性量,故隨區域檔走;轉換慣例本身在此定義),**v0.1 定值 0.0**,即暫以正高視同橢球高。**本版未實測臺北的大地起伏值,契約不提供估計值**;與 NLSC 3D Tiles(橢球框架)的絕對高程對位誤差為**待辦實測項**,由 M1 pipeline QA 量測後以 minor 版本定值,**不影響 tile 格式本身**。在該常數被實測定值之前,兩端不得將 `geoid_offset_m` 視為已知量,亦不得把此誤差與 Z 預算餘裕相抵。
- **frame 相容性**:TWD97 對齊 ITRF94,與 WGS84 現行 frame 差異為公分—分米級,本專案視為 WGS84 相容(直接餵給 CesiumJS)。
- **橢球**:一律 GRS80(a = 6378137,1/f = 298.257222101)。

**數值範例**(正典機器可讀來源:[`constants/ecef_examples.json`](../constants/ecef_examples.json);兩端單元測試以 `tolerance_m = 0.001` 逐軸比對)。下表的 h 為**橢球高**(= 正高 + `geoid_offset_m`,v0.1 兩者相等);若日後 `geoid_offset_m` 被實測定值,這三組向量的輸入語意會隨之改變,必須同版重算:

| 名稱 | EPSG:3826 (E, N, h) | ECEF (X, Y, Z) |
| --- | --- | --- |
| M1 bbox SW corner, h=0 | (305500, 2767500, 0) | (-3026076.1241, 4928469.3296, 2680533.5128) |
| M1 bbox NE corner, h=100 | (309000, 2771000, 100) | (-3028346.2997, 4925449.9962, 2683734.0173) |
| near Taipei 101, h=5 | (307000, 2769650, 5) | (-3026889.6546, 4926910.7147, 2682478.3150) |

## 接縫規則

相鄰 tile 的邊界幾何必須無縫。**本節保證的空間是 ECEF**(runtime 實際放置幾何的空間);投影座標只是達成該保證的中間量:

1. **剖切與複製**:跨越 tile 邊界的幾何在邊界處剖切;邊界頂點在相鄰兩 tile 中各自出現,且兩側還原出的 `(E, N, h)` **必須完全一致**(位元級,無容差)。由於 ECEF 轉換鏈是 `(E, N, h)` 的確定性純函數且**逐頂點**施加(見上節),位元級一致的 `(E, N, h)` 即蘊含位元級一致的 ECEF —— 這正是條款 1 保證 ECEF 無縫的機制,也是上節禁止 per-tile 剛體擺放的原因。
2. **XY 一致性**:共享邊上,一側 q = xy_quant_max 與另一側 q = 0 都精確還原為同一邊界座標;沿邊方向兩側 tile 的該軸 local origin 相同、步長相同,相同 q 還原為相同世界座標。
3. **Z 一致性**:落在 tile 邊界上的頂點,其世界高度 h **必須為 `z_step_m` 的整數倍**(pipeline 於剖切時 snap;snap 採 round half up,與 XY 量化同一慣例,使兩側由同一輸入得到同一結果)。因兩側 `h0` 皆為 `z_step_m` 整數倍,該高度在兩側都能以整數 q_z 精確表示。tile 內部頂點不受此限。
4. **驗證**:邊界一致性由 contracts 驗證器(FTP-23 起)機械檢查;違反即 tile 不合規。
