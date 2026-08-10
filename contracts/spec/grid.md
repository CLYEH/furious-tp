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

**local origin**:tile 的 min 角落 `(tx · tile_size_m, ty · tile_size_m, h0)`。`h0` 為該 tile 宣告的高度基準(欄位位置由 tile 格式票定義),**必須是 `z_step_m` 的整數倍**。

**軸向**:local X = E − E0(向東)、local Y = N − N0(向北)、local Z = h − h0(向上)。

**XY 量化**:`xy_quant_max = 65535`(16-bit)。量化值 q ∈ [0, 65535] 對應 local 座標 [0, tile_size_m]:

```text
還原:x = q · tile_size_m / xy_quant_max
量化:q = round(x / tile_size_m · xy_quant_max)   （round half up）
```

解析度 ≈ 500 / 65535 ≈ 7.63 mm。q = 0 與 q = 65535 精確對應 tile 的 min / max 邊界(無捨入)。

**Z 量化**:全域固定步長 `z_step_m = 1/256`(= 0.00390625 m,2^-8,double 可精確表示)、`z_quant_max = 65535`:

```text
還原:h = h0 + q_z · z_step_m
```

單一 tile 高度跨距 (65535 + 1) × 1/256 = 256 m。M1 範圍地形起伏(象山約 20–180 m)遠低於此上限。步長為全域常數而非 per-tile 縮放,是接縫規則(見下)得以成立的前提。

## ECEF 轉換慣例(D2)

Runtime(CesiumJS / Rapier)以地心座標 ECEF 放置幾何。規範性轉換鏈:

```text
(E, N)  --[逆橫麥卡托,GRS80,參數同上]-->  (φ, λ)
h_ellip = h + geoid_offset_m
(φ, λ, h_ellip)  --[geodetic → geocentric,GRS80]-->  (X, Y, Z)
```

- **高程慣例(v0.1)**:tile 內高度 h 為來源資料公布值(內政部 DTM 為 TWVD2001 正高)。`geoid_offset_m` 定義於 `constants/m1_area.json`,**v0.1 定值 0.0**,即暫以正高視同橢球高。已知限制:大地起伏在臺北約十餘公尺,與 NLSC 3D Tiles(橢球框架)的絕對高程對位誤差將由 M1 pipeline QA 實測,於後續 minor 版本修正此常數,**不影響 tile 格式本身**。
- **frame 相容性**:TWD97 對齊 ITRF94,與 WGS84 現行 frame 差異為公分—分米級,本專案視為 WGS84 相容(直接餵給 CesiumJS)。
- **橢球**:一律 GRS80(a = 6378137,1/f = 298.257222101)。

**數值範例**(正典機器可讀來源:[`constants/ecef_examples.json`](../constants/ecef_examples.json);兩端單元測試以 `tolerance_m = 0.001` 逐軸比對):

| 名稱 | EPSG:3826 (E, N, h) | ECEF (X, Y, Z) |
| --- | --- | --- |
| M1 bbox SW corner, h=0 | (305500, 2767500, 0) | (-3026076.1241, 4928469.3296, 2680533.5128) |
| M1 bbox NE corner, h=100 | (309000, 2771000, 100) | (-3028346.2997, 4925449.9962, 2683734.0173) |
| near Taipei 101, h=5 | (307000, 2769650, 5) | (-3026889.6546, 4926910.7147, 2682478.3150) |

## 接縫規則

相鄰 tile 的邊界幾何必須無縫:

1. **剖切與複製**:跨越 tile 邊界的幾何在邊界處剖切;邊界頂點在相鄰兩 tile 中各自出現,且還原後的**世界座標必須完全一致**(位元級,無容差)。
2. **XY 一致性**:共享邊上,一側 q = xy_quant_max 與另一側 q = 0 都精確還原為同一邊界座標;沿邊方向兩側 tile 的該軸 local origin 相同、步長相同,相同 q 還原為相同世界座標。
3. **Z 一致性**:落在 tile 邊界上的頂點,其世界高度 h **必須為 `z_step_m` 的整數倍**(pipeline 於剖切時 snap)。因兩側 `h0` 皆為 `z_step_m` 整數倍,該高度在兩側都能以整數 q_z 精確表示。tile 內部頂點不受此限。
4. **驗證**:邊界一致性由 contracts 驗證器(FTP-23 起)機械檢查;違反即 tile 不合規。
