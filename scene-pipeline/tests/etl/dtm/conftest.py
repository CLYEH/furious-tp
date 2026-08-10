"""Shared fixtures for the DTM ETL exam.

Every raster used by these tests is synthesised locally: the exam must never
reach the network, and must not depend on a copy of the real 20 m DTM being
present on the machine running it.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

REPO_ROOT = Path(__file__).resolve().parents[4]
CONTRACTS_DIR = REPO_ROOT / "contracts"

# M1 bbox, frozen by contracts/constants/m1_area.json (FTP-22).
M1_E_MIN = 305500.0
M1_E_MAX = 309000.0
M1_N_MIN = 2767500.0
M1_N_MAX = 2771000.0

RESOLUTION_M = 20.0

# The source rasters below start 500 m west of / north of the bbox and are
# 200 x 200 px, so they cover the whole bbox with a 25 px margin on each side.
SOURCE_WEST = 305000.0
SOURCE_NORTH = 2771500.0
SOURCE_SIZE = 200
# Window of the source that the M1 bbox corresponds to.
SOURCE_WINDOW = (slice(25, 200), slice(25, 200))


def linear_elevation(e: float | np.ndarray, n: float | np.ndarray):
    """A plane in EPSG:3826 space.

    Linear on purpose: bilinear resampling reproduces a plane exactly, so a
    reprojected result can be checked against the analytic value with a tight
    tolerance instead of a hand-waved one.
    """
    return 100.0 + 0.001 * (e - M1_E_MIN) + 0.002 * (n - M1_N_MIN)


def pixel_centres(west: float, north: float, resolution_m: float, width: int, height: int):
    """(E, N) of every pixel centre of a north-up grid, as 2-D arrays."""
    cols = np.arange(width, dtype="float64")
    rows = np.arange(height, dtype="float64")
    e = west + (cols + 0.5) * resolution_m
    n = north - (rows + 0.5) * resolution_m
    return np.meshgrid(e, n)


def write_raster(
    path: Path,
    array: np.ndarray,
    *,
    west: float,
    north: float,
    resolution_m: float = RESOLUTION_M,
    crs: str | None = "EPSG:3826",
    nodata: float | None = None,
) -> Path:
    """Write a north-up single-band GeoTIFF."""
    path.parent.mkdir(parents=True, exist_ok=True)
    array = np.asarray(array, dtype="float32")
    profile = {
        "driver": "GTiff",
        "width": array.shape[1],
        "height": array.shape[0],
        "count": 1,
        "dtype": "float32",
        "transform": from_origin(west, north, resolution_m, resolution_m),
    }
    if crs is not None:
        profile["crs"] = CRS.from_string(crs)
    if nodata is not None:
        profile["nodata"] = nodata
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(array, 1)
    return path


@pytest.fixture
def source_array() -> np.ndarray:
    """Plane elevation over the source extent, aligned to the 20 m grid."""
    e, n = pixel_centres(SOURCE_WEST, SOURCE_NORTH, RESOLUTION_M, SOURCE_SIZE, SOURCE_SIZE)
    return linear_elevation(e, n).astype("float32")


@pytest.fixture
def aligned_source(tmp_path: Path, source_array: np.ndarray) -> Path:
    """EPSG:3826, 20 m, grid-aligned source fully covering the M1 bbox."""
    return write_raster(tmp_path / "src" / "dtm.tif", source_array, west=SOURCE_WEST,
                        north=SOURCE_NORTH)


@pytest.fixture
def attribution() -> dict:
    """A complete source-and-version record (PRD §4 attribution)."""
    return {
        "name": "內政部 20 公尺網格數值地形模型",
        "url": "https://example.invalid/dtm/20m.tif",
        "license": "政府資料開放授權條款-第1版",
        "retrieved": "2026-08-10",
    }


@pytest.fixture
def attribution_file(tmp_path: Path, attribution: dict) -> Path:
    path = tmp_path / "source-meta.json"
    path.write_text(json.dumps(attribution, ensure_ascii=False), encoding="utf-8")
    return path


@pytest.fixture
def run_etl(tmp_path, attribution):
    """Run the ETL with attribution already supplied and a default output path."""

    def _run(source, **kwargs):
        from scene_pipeline.etl.dtm.etl import run_dtm_etl

        kwargs.setdefault("source_overrides", attribution)
        out = kwargs.pop("out", tmp_path / "out" / "dtm_20m_epsg3826.tif")
        return run_dtm_etl(source=source, out=out, **kwargs)

    return _run


def read_band(path: Path):
    with rasterio.open(path) as src:
        return src.read(1), src.profile


@pytest.fixture
def m1_area_doc() -> dict:
    return json.loads((CONTRACTS_DIR / "constants" / "m1_area.json").read_text(encoding="utf-8"))


@pytest.fixture
def grid_doc() -> dict:
    return json.loads((CONTRACTS_DIR / "constants" / "grid.json").read_text(encoding="utf-8"))
