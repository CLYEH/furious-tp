# scene-pipeline — 離線場景編譯(RFC 模組 1)

臺北開放資料 3D 數位孿生的離線資料管線:ETL(DTM / OSM / data.taipei)→ 編譯(conflation、elevation、roads、terrain、props、physics)→ QA → CLI。本目錄目前為專案骨架,不含資料下載或處理邏輯。

## 目錄結構

```
scene-pipeline/
├── pyproject.toml          # 依賴與工具設定(ruff / pytest)
├── src/scene_pipeline/
│   ├── etl/                # 資料擷取與正規化
│   │   ├── dtm/            # 內政部 20m DTM
│   │   ├── osm/            # OSM extract、道路拓樸
│   │   └── taipei/         # data.taipei(道路 GIS / 路樹 / 路燈 / 建物輪廓)
│   ├── compile/            # tile 編譯
│   │   ├── conflation/     # 來源套合(RFC D10)
│   │   ├── elevation/      # 高程處理
│   │   ├── roads/          # 道路編譯(RFC D3)
│   │   ├── terrain/        # 地形(RFC D9 沿路廊變形)
│   │   ├── props/          # 街道物件
│   │   └── physics/        # physics tiles
│   ├── qa/                 # QA gate 指標
│   └── cli/                # 指令入口
└── tests/                  # 對應 src 結構
```

## 環境需求

- Python **3.11 以上**(以 3.12 驗證)
- pip 24 以上(舊版 pip 可能無法解析部分 wheel;venv 建立後先升級)

## 環境建置

以下指令皆在 `scene-pipeline/` 目錄下執行。

### 1. 建立虛擬環境

```bash
python -m venv .venv
```

### 2. 啟用虛擬環境

- **Windows(PowerShell / cmd)**:

  ```
  .venv\Scripts\activate
  ```

- **Windows(Git Bash)**:

  ```bash
  source .venv/Scripts/activate
  ```

- **macOS / Linux**:

  ```bash
  source .venv/bin/activate
  ```

### 3. 升級 pip 並安裝(含 dev 工具)

```bash
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
```

### Windows 之 GDAL / rasterio 安裝註記

- `rasterio` 的 PyPI wheel **已內建 GDAL 執行檔與資料**,在受支援的 Python 版本(含 3.11 / 3.12 的 win_amd64)直接 `pip install` 即可,**不需**另裝 GDAL。
- 若 pip 顯示正在編譯原始碼(出現 `Building wheel for rasterio` 且要求 GDAL headers),代表你的 Python 版本沒有對應 wheel:改用受支援的 Python 版本,或先透過 [OSGeo4W](https://trac.osgeo.org/osgeo4w/) 安裝 GDAL 並設定 `GDAL_CONFIG`,或改用 conda-forge(`conda install -c conda-forge rasterio`)。
- `pyosmium`、`shapely`、`pyproj` 同樣提供 win_amd64 wheel,無須本機編譯。

## 驗證

在 `scene-pipeline/` 目錄、venv 啟用狀態下:

```bash
ruff check .
pytest
```

兩者皆須通過(pytest 至少包含 skeleton import smoke tests)。
