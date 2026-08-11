"""DTM ETL: source raster -> bbox-clipped EPSG:3826 GeoTIFF + source record.

Pipeline order is chosen so the cheapest, most operator-fixable failures come
first: parameters, then contracts, then attribution, then the download, then
the raster itself. Nothing is written until all of those have passed.

The nodata policy is the part worth reading twice; see `NODATA_POLICY` and
`scene-pipeline/src/scene_pipeline/etl/dtm/README.md`.
"""

from __future__ import annotations

import datetime as dt
import json
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
import rasterio.errors
from rasterio.crs import CRS
from rasterio.warp import Resampling, reproject, transform_bounds

from .area import CONTRACT_CRS, Area, load_area, load_tile_size_m
from .errors import DtmCoverageError, DtmOutputError, DtmSourceError
from .grid import DEFAULT_RESOLUTION_M, AlignedGrid, align_bbox, check_tile_alignment
from .source import (
    DEFAULT_TIMEOUT_S,
    SourceRef,
    build_source_ref,
    download_source,
    is_url,
    load_source_meta,
    sha256_file,
)

#: RFC D2: the ETL emits one CRS, whatever came in.
OUTPUT_CRS = CONTRACT_CRS

#: Sentinel written for every pixel this stage refuses to claim a height for.
#: Far outside any plausible TWVD2001 orthometric height, so it cannot collide
#: with real ground the way 0 or -999 could.
OUTPUT_NODATA = -9999.0

OUTPUT_DTYPE = "float32"

#: See README: voids are neither filled nor allowed to bleed into neighbours.
NODATA_POLICY = "no-fill-no-contaminate/v1"

#: Schema version of the `.source.json` record.
RECORD_VERSION = "0.1.0"

TOOL_NAME = "scene_pipeline.etl.dtm"

RESAMPLING_METHODS = {
    "nearest": Resampling.nearest,
    "bilinear": Resampling.bilinear,
    "cubic": Resampling.cubic,
    "average": Resampling.average,
}

# A pixel counts as valid only if the resampled validity mask says its whole
# kernel was valid, i.e. the surviving weights sum to exactly 1.
#
# The comparison is two-sided, and that matters: cubic kernels carry negative
# weights, so dropping an *invalid* neighbour that happened to hold a negative
# weight pushes the surviving sum ABOVE 1 (measured here: 1.035156 with one
# void pixel and a half-pixel shift). A one-sided ">= 1 - eps" test waves those
# pixels through as fully valid while their value is missing a contributor —
# contamination, arriving by the one route the guard exists to close.
# The epsilon absorbs float noise in the warp, nothing more.
_MASK_TOLERANCE = 1e-6


@dataclass(frozen=True)
class DtmEtlResult:
    output_path: Path
    provenance_path: Path
    grid: AlignedGrid
    valid_fraction: float
    source: SourceRef


def run_dtm_etl(
    *,
    source: str | Path,
    out: str | Path,
    area_path: Path | None = None,
    resolution_m: float = DEFAULT_RESOLUTION_M,
    resampling: str = "bilinear",
    source_meta_path: Path | None = None,
    source_overrides: dict | None = None,
    extra_nodata: tuple[float, ...] = (),
    timeout_s: float = DEFAULT_TIMEOUT_S,
    download_dir: Path | None = None,
) -> DtmEtlResult:
    """Run the whole DTM ETL. See the module README for the rules it applies."""
    if resampling not in RESAMPLING_METHODS:
        raise DtmSourceError(
            f"unknown resampling method {resampling!r}; choose one of "
            + ", ".join(sorted(RESAMPLING_METHODS))
        )

    area = load_area(area_path)
    check_tile_alignment(resolution_m, load_tile_size_m())
    grid = align_bbox(area.bbox, resolution_m)

    out_path = Path(out)
    provenance_path = out_path.with_name(f"{out_path.stem}.source.json")

    # Attribution is settled before anything is fetched or written: a run that
    # cannot be attributed must not cost a download, let alone produce a file.
    source_text = str(source)
    downloading = is_url(source_text)
    meta = load_source_meta(source_meta_path, source_overrides)
    if downloading:
        meta.setdefault("url", source_text)
    source_ref = build_source_ref(
        meta,
        downloaded_on=_utc_date() if downloading else None,
    )

    if downloading:
        target_dir = Path(download_dir) if download_dir else out_path.parent / "_source"
        local_source = download_source(
            source_text, target_dir / Path(source_text.split("?")[0]).name, timeout=timeout_s
        )
    else:
        local_source = Path(source_text)
        if not local_source.exists():
            raise DtmSourceError(f"source raster not found: {local_source}")

    read = _read_source(local_source, extra_nodata)
    _check_overlap(read, grid, local_source)
    data, valid_fraction = _resample_onto(read, grid, RESAMPLING_METHODS[resampling])

    if valid_fraction <= 0.0:
        raise DtmCoverageError(
            f"{local_source} produced no valid pixels over {area.bbox}: every pixel is void "
            "after the nodata policy was applied, so there is nothing to hand downstream"
        )

    record = _build_record(
        area=area,
        area_path=area_path,
        grid=grid,
        source_ref=source_ref,
        local_source=local_source,
        read=read,
        resampling=resampling,
        valid_fraction=valid_fraction,
        out_path=out_path,
    )
    _publish(out_path, provenance_path, data, grid, record)

    return DtmEtlResult(
        output_path=out_path,
        provenance_path=provenance_path,
        grid=grid,
        valid_fraction=valid_fraction,
        source=source_ref,
    )


@dataclass(frozen=True)
class _SourceRead:
    values: np.ndarray
    valid: np.ndarray
    transform: object
    crs: CRS
    resolution: tuple[float, float]
    bounds: tuple[float, float, float, float]
    sentinels: list[float]


def _read_source(path: Path, extra_nodata: tuple[float, ...]) -> _SourceRead:
    """Read band 1 and work out which pixels are real measurements."""
    try:
        with rasterio.open(path) as src:
            if src.crs is None:
                raise DtmSourceError(
                    f"source raster {path} declares no CRS; refusing to assume one, because "
                    "guessing wrong (TWD67 or WGS84 read as EPSG:3826) would misplace the "
                    "whole city silently. Re-tag the file, e.g. gdal_edit.py -a_srs EPSG:3826"
                )
            values = src.read(1).astype("float32")
            src_crs = src.crs
            src_transform = src.transform
            src_res = (float(src.res[0]), float(src.res[1]))
            src_bounds = tuple(float(v) for v in src.bounds)
            declared = src.nodata
    except (rasterio.errors.RasterioError, OSError) as exc:
        raise DtmSourceError(f"cannot read source raster {path}: {exc}") from exc

    # NaN is always a void; declared and operator-supplied sentinels join it.
    valid = np.isfinite(values)
    sentinels: list[float] = []
    if declared is not None and np.isfinite(declared):
        sentinels.append(float(declared))
    sentinels.extend(float(v) for v in extra_nodata)
    for sentinel in sentinels:
        valid &= values != sentinel

    return _SourceRead(
        values=values,
        valid=valid,
        transform=src_transform,
        crs=src_crs,
        resolution=src_res,
        bounds=src_bounds,
        sentinels=sentinels,
    )


def _check_overlap(read: _SourceRead, grid: AlignedGrid, path: Path) -> None:
    """Fail loudly when handed the wrong DTM sheet."""
    left, bottom, right, top = transform_bounds(read.crs, OUTPUT_CRS, *read.bounds, densify_pts=21)
    if left >= grid.e_max or right <= grid.e_min or bottom >= grid.n_max or top <= grid.n_min:
        raise DtmCoverageError(
            f"source raster {path} does not overlap the requested bbox: source covers "
            f"({left:.1f}, {bottom:.1f})..({right:.1f}, {top:.1f}) in {OUTPUT_CRS}, "
            f"bbox is ({grid.e_min}, {grid.n_min})..({grid.e_max}, {grid.n_max})"
        )


def _resample_onto(
    read: _SourceRead, grid: AlignedGrid, method: Resampling
) -> tuple[np.ndarray, float]:
    """Warp onto the output grid, containing voids instead of interpolating them.

    Two warps with the same kernel: one over the values, one over a 1/0
    validity mask. The mask warp comes back as the fraction of each output
    pixel's kernel that was valid, so requiring 1.0 keeps exactly the pixels
    whose every contributor was a real measurement.

    Void pixels are zeroed before the value warp so a -999 sentinel cannot
    dominate a kernel; those pixels are discarded by the mask anyway, but a
    sentinel smeared across neighbouring values would survive as a plausible
    number if the threshold were ever loosened.
    """
    shape = (grid.height, grid.width)
    warp = {
        "src_transform": read.transform,
        "src_crs": read.crs,
        "dst_transform": grid.transform,
        "dst_crs": CRS.from_string(OUTPUT_CRS),
        "resampling": method,
    }

    values = np.zeros(shape, dtype="float32")
    reproject(
        np.where(read.valid, read.values, 0.0).astype("float32"),
        values,
        src_nodata=None,
        dst_nodata=None,
        **warp,
    )

    mask = np.zeros(shape, dtype="float32")
    reproject(
        read.valid.astype("float32"),
        mask,
        src_nodata=None,
        dst_nodata=0.0,
        init_dest_nodata=True,
        **warp,
    )

    keep = np.abs(mask - 1.0) <= _MASK_TOLERANCE
    out = np.where(keep, values, OUTPUT_NODATA).astype("float32")
    return out, float(keep.sum()) / float(keep.size)


def _build_record(
    *,
    area: Area,
    area_path: Path | None,
    grid: AlignedGrid,
    source_ref: SourceRef,
    local_source: Path,
    read: _SourceRead,
    resampling: str,
    valid_fraction: float,
    out_path: Path,
) -> dict:
    return {
        "record_version": RECORD_VERSION,
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tool": {"name": TOOL_NAME, "version": _tool_version()},
        "source": {
            **source_ref.to_dict(),
            "path": str(local_source),
            "sha256": sha256_file(local_source),
            "crs": read.crs.to_string(),
            "resolution_m": list(read.resolution),
            "bounds": list(read.bounds),
        },
        "area": {
            "contract": str(area_path) if area_path else "contracts/constants/m1_area.json",
            "spec_version": area.spec_version,
            "crs": area.crs,
            "bbox": [area.bbox.e_min, area.bbox.n_min, area.bbox.e_max, area.bbox.n_max],
        },
        "output": {
            "path": out_path.name,
            "crs": OUTPUT_CRS,
            "resolution_m": grid.resolution_m,
            "width": grid.width,
            "height": grid.height,
            "bounds": list(grid.bounds),
            "dtype": OUTPUT_DTYPE,
            "resampling": resampling,
            "alignment": "pixel edges on multiples of resolution_m, anchored at the "
                         f"{OUTPUT_CRS} origin; bbox snapped outward",
        },
        "nodata": {
            "policy": NODATA_POLICY,
            "output_nodata": OUTPUT_NODATA,
            "fill": False,
            "source_nodata": read.sentinels,
        },
        "valid_fraction": valid_fraction,
    }


def _publish(
    out_path: Path, provenance_path: Path, data: np.ndarray, grid: AlignedGrid, record: dict
) -> None:
    """Write both artefacts to temporaries, then move them into place.

    A half-written GeoTIFF at the real path is the failure this guards: the
    next stage would open it and find a perfectly valid header over truncated
    elevations. The record is placed first so a published GeoTIFF always has
    one; the GeoTIFF is the artefact of record, and a failed run leaves none.

    That order alone is not enough. If the record lands and the raster then
    does not — a downstream reader holding the old `dtm.tif` open is exactly
    the case temp-then-replace exists for, and on Windows it makes os.replace
    fail — the disk is left holding the previous GeoTIFF beside a record
    describing the one that was never published: wrong name, url, licence,
    sha256, valid_fraction, and nothing about it looks unusual. So the record
    that is published now is snapshotted first and put back if the raster does
    not follow. Both guarantees then hold at once: a published GeoTIFF has a
    record, and a failed run changes nothing that was already there.
    """
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise DtmOutputError(f"cannot create output directory {out_path.parent}: {exc}") from exc

    tmp_raster = out_path.with_name(out_path.name + ".tmp")
    tmp_record = provenance_path.with_name(provenance_path.name + ".tmp")
    try:
        previous_record = provenance_path.read_bytes() if provenance_path.is_file() else None
    except OSError as exc:
        raise DtmOutputError(
            f"cannot read the source record already at {provenance_path}: {exc}; refusing to "
            "publish, because a failed publish could then not put it back"
        ) from exc

    try:
        with rasterio.open(
            tmp_raster,
            "w",
            driver="GTiff",
            width=grid.width,
            height=grid.height,
            count=1,
            dtype=OUTPUT_DTYPE,
            crs=CRS.from_string(OUTPUT_CRS),
            transform=grid.transform,
            nodata=OUTPUT_NODATA,
            compress="deflate",
            tiled=True,
        ) as dst:
            dst.write(data, 1)
        tmp_record.write_text(
            json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(tmp_record, provenance_path)
        os.replace(tmp_raster, out_path)
    except (rasterio.errors.RasterioError, OSError) as exc:
        for leftover in (tmp_raster, tmp_record):
            try:
                leftover.unlink(missing_ok=True)
            except OSError:  # pragma: no cover - best effort cleanup
                pass
        note = _restore_record(provenance_path, previous_record)
        raise DtmOutputError(f"cannot write output to {out_path}: {exc}{note}") from exc


def _restore_record(provenance_path: Path, previous: bytes | None) -> str:
    """Undo a record that landed while its raster did not.

    Returns "" when the record is (or has been put back) as it was found, and
    a warning to append to the error otherwise.

    Driven by comparing the file with the snapshot rather than by a "the
    replace ran" flag: a flag is blind to a record damaged *before* the
    replace, and `Path.write_text` truncates its target the moment it opens,
    so a write that dies partway has already destroyed the record a flag would
    say was untouched.

    When the restore itself fails, the caller's error says so. Downgrading the
    guarantee silently would leave behind the one artefact this whole module
    is arranged to prevent: a provenance record that reads as normal while
    describing a dataset that was never published.

    Assumes one publisher per output path, as this ETL always has: a second
    run writing the same `--out` concurrently would have its record undone by
    the first run's restore.
    """
    try:
        current = provenance_path.read_bytes() if provenance_path.is_file() else None
        if current == previous:
            return ""
        if previous is None:
            provenance_path.unlink(missing_ok=True)
        else:
            provenance_path.write_bytes(previous)
    except OSError as exc:
        return (
            f"; and the previous source record at {provenance_path} could not be put back "
            f"({exc}) — it now describes a raster that was never published, while the "
            "elevations beside it are the previous run's. Delete it or re-run before "
            "anything downstream reads it"
        )
    return ""


def _utc_date() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def _tool_version() -> str:
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("scene-pipeline")
    except PackageNotFoundError:  # pragma: no cover - only outside an install
        return "unknown"
