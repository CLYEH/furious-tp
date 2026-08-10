"""End-to-end DTM ETL: extent, CRS, provenance, failure modes.

Covers FTP-28 AC1 (one command, source -> clipped GeoTIFF), AC2 (resolution
and extent), AC4 (source/version record) and AC5 (EPSG:3826 round trip).
"""

from __future__ import annotations

import json
import os

import numpy as np
import pytest
import rasterio
from pyproj import Transformer

from scene_pipeline.etl.dtm.errors import (
    DtmCoverageError,
    DtmOutputError,
    DtmSourceError,
    DtmSourceMetadataError,
)
from scene_pipeline.etl.dtm.etl import OUTPUT_CRS, OUTPUT_NODATA, run_dtm_etl

from .conftest import (
    M1_E_MAX,
    M1_E_MIN,
    M1_N_MAX,
    M1_N_MIN,
    RESOLUTION_M,
    SOURCE_NORTH,
    SOURCE_WEST,
    SOURCE_WINDOW,
    linear_elevation,
    pixel_centres,
    read_band,
    write_raster,
)

# ---------------------------------------------------------------- happy path


def test_one_call_turns_a_source_into_a_clipped_geotiff(aligned_source, run_etl):
    result = run_etl(aligned_source)
    assert result.output_path.exists()
    assert result.output_path.suffix == ".tif"
    with rasterio.open(result.output_path) as out:
        assert out.count == 1
        assert out.driver == "GTiff"


def test_output_covers_exactly_the_contract_bbox(aligned_source, run_etl):
    result = run_etl(aligned_source)
    with rasterio.open(result.output_path) as out:
        assert (out.width, out.height) == (175, 175)
        assert out.bounds.left == M1_E_MIN
        assert out.bounds.bottom == M1_N_MIN
        assert out.bounds.right == M1_E_MAX
        assert out.bounds.top == M1_N_MAX
        assert out.res == (RESOLUTION_M, RESOLUTION_M)


def test_output_is_written_in_epsg_3826(aligned_source, run_etl):
    with rasterio.open(run_etl(aligned_source).output_path) as out:
        assert out.crs.to_string() == OUTPUT_CRS


def test_aligned_source_values_survive_bit_exactly(aligned_source, source_array, run_etl):
    """Same CRS, same resolution, same phase: clipping must not resample."""
    data, _ = read_band(run_etl(aligned_source).output_path)
    np.testing.assert_array_equal(data, source_array[SOURCE_WINDOW])


def test_output_dtype_is_float32(aligned_source, run_etl):
    _, profile = read_band(run_etl(aligned_source).output_path)
    assert profile["dtype"] == "float32"


def test_result_reports_where_everything_landed(aligned_source, run_etl):
    result = run_etl(aligned_source)
    assert result.output_path.exists()
    assert result.provenance_path.exists()
    assert result.grid.width == 175
    assert 0.0 < result.valid_fraction <= 1.0
    assert result.source.name


def test_output_parent_directory_is_created(tmp_path, aligned_source, run_etl):
    out = tmp_path / "deep" / "nested" / "dtm.tif"
    assert run_etl(aligned_source, out=out).output_path == out
    assert out.exists()


# ------------------------------------------------------- reprojection / CRS


@pytest.fixture
def wgs84_source(tmp_path):
    """A finer-than-target source in EPSG:4326 covering the bbox with margin."""
    step = 0.0002
    lon = np.arange(121.54, 121.60, step)
    lat = np.arange(25.06, 25.00, -step)
    ll, tt = np.meshgrid(lon, lat)
    to_3826 = Transformer.from_crs("EPSG:4326", "EPSG:3826", always_xy=True)
    e, n = to_3826.transform(ll, tt)
    array = linear_elevation(e, n).astype("float32")
    return write_raster(tmp_path / "src" / "wgs84.tif", array, west=lon[0] - step / 2,
                        north=lat[0] + step / 2, resolution_m=step, crs="EPSG:4326")


def test_a_wgs84_source_is_reprojected_to_the_contract_crs(wgs84_source, run_etl):
    """RFC D2: whatever comes in, EPSG:3826 goes out."""
    result = run_etl(wgs84_source)
    with rasterio.open(result.output_path) as out:
        assert out.crs.to_string() == OUTPUT_CRS
        assert out.bounds.left == M1_E_MIN
        assert out.bounds.top == M1_N_MAX
        assert (out.width, out.height) == (175, 175)


def test_reprojected_elevations_match_the_analytic_surface(wgs84_source, run_etl):
    """The plane is defined in EPSG:3826, so recovering it after a round trip
    through EPSG:4326 is a check on the projection, not just on plumbing."""
    result = run_etl(wgs84_source)
    data, _ = read_band(result.output_path)
    ee, nn = pixel_centres(result.grid.e_min, result.grid.n_max, RESOLUTION_M,
                           result.grid.width, result.grid.height)
    expected = linear_elevation(ee, nn)
    valid = data != OUTPUT_NODATA
    assert valid.all(), "the source has >1 km of margin; nothing should be void"
    np.testing.assert_allclose(data[valid], expected[valid], rtol=0, atol=1e-2)


@pytest.mark.parametrize("corner", [(M1_E_MIN, M1_N_MIN), (M1_E_MAX, M1_N_MAX),
                                    (M1_E_MIN, M1_N_MAX), (M1_E_MAX, M1_N_MIN)])
def test_epsg3826_round_trip_returns_the_same_point(corner):
    fwd = Transformer.from_crs(OUTPUT_CRS, "EPSG:4326", always_xy=True)
    back = Transformer.from_crs("EPSG:4326", OUTPUT_CRS, always_xy=True)
    lon, lat = fwd.transform(*corner)
    e, n = back.transform(lon, lat)
    assert e == pytest.approx(corner[0], abs=1e-6)
    assert n == pytest.approx(corner[1], abs=1e-6)


def test_contract_anchors_agree_with_their_wgs84_twins(m1_area_doc):
    """Catches a TM2-zone mix-up (EPSG:3825/3828) that a round trip alone
    would happily pass: both representations must name the same ground."""
    tolerance = float(m1_area_doc["anchor_tolerance_m"])
    fwd = Transformer.from_crs(OUTPUT_CRS, "EPSG:4326", always_xy=True)
    back = Transformer.from_crs("EPSG:4326", OUTPUT_CRS, always_xy=True)
    for anchor in m1_area_doc["anchors"]:
        expected_e, expected_n = back.transform(*anchor["approx_wgs84"])
        got_e, got_n = anchor["epsg3826"]
        assert np.hypot(got_e - expected_e, got_n - expected_n) <= tolerance, anchor["name"]
        lon, lat = fwd.transform(got_e, got_n)
        assert abs(lon - anchor["approx_wgs84"][0]) < 0.001, anchor["name"]


# ------------------------------------------------------------------ coverage


def test_a_source_that_misses_the_bbox_is_an_error(tmp_path, source_array, run_etl):
    """Handing the ETL the wrong DTM sheet must say so, not emit an empty tile.

    Asserting on the *distinguishing* wording, not merely on the exception
    type: without the geometric check the run still fails, but as "no valid
    pixels", which reads like a void-ridden sheet rather than the wrong sheet.
    The operator needs to know which, so the message has to place the source.
    """
    far = write_raster(tmp_path / "src" / "far.tif", source_array, west=400000.0,
                       north=2900000.0)
    with pytest.raises(DtmCoverageError, match="does not overlap") as excinfo:
        run_etl(far)
    assert "400000" in str(excinfo.value), "the message must report where the source is"


def test_partial_coverage_still_spans_the_bbox_and_reports_the_gap(tmp_path, run_etl):
    """The output extent is the bbox regardless; the shortfall is recorded,
    not hidden by quietly shrinking the raster to the data."""
    e, n = pixel_centres(SOURCE_WEST, SOURCE_NORTH, RESOLUTION_M, 100, 200)
    array = linear_elevation(e, n).astype("float32")
    half = write_raster(tmp_path / "src" / "half.tif", array, west=SOURCE_WEST,
                        north=SOURCE_NORTH)
    result = run_etl(half)
    with rasterio.open(result.output_path) as out:
        assert out.bounds.right == M1_E_MAX
        assert (out.width, out.height) == (175, 175)
    assert result.valid_fraction == pytest.approx(1500.0 / 3500.0, abs=0.01)


# -------------------------------------------------------------- source input


def test_a_missing_source_file_names_the_path(tmp_path, run_etl):
    missing = tmp_path / "no-such-dtm.tif"
    with pytest.raises(DtmSourceError, match="no-such-dtm.tif"):
        run_etl(missing)


def test_a_corrupt_source_fails_with_our_error_not_a_raw_gdal_one(tmp_path, run_etl):
    """"來源檔缺損 → 明確錯誤訊息、非靜默": the operator must learn which file."""
    broken = tmp_path / "broken.tif"
    broken.write_bytes(b"II*\x00 not really a tiff")
    with pytest.raises(DtmSourceError, match="broken.tif"):
        run_etl(broken)


def test_a_truncated_source_is_refused(tmp_path, aligned_source, run_etl):
    truncated = tmp_path / "truncated.tif"
    truncated.write_bytes(aligned_source.read_bytes()[:400])
    with pytest.raises(DtmSourceError, match="truncated.tif"):
        run_etl(truncated)


def test_a_source_without_a_crs_is_refused(tmp_path, source_array, run_etl):
    """Assuming EPSG:3826 for an untagged raster would silently misplace the
    whole city if the file were in TWD67 or WGS84."""
    path = write_raster(tmp_path / "src" / "nocrs.tif", source_array, west=SOURCE_WEST,
                        north=SOURCE_NORTH, crs=None)
    with pytest.raises(DtmSourceError, match="(?i)crs"):
        run_etl(path)


def test_an_unknown_resampling_name_is_refused(aligned_source, run_etl):
    with pytest.raises(DtmSourceError, match="(?i)resampling"):
        run_etl(aligned_source, resampling="telepathy")


# ---------------------------------------------------------------- provenance


def test_provenance_sits_next_to_the_output(aligned_source, run_etl):
    result = run_etl(aligned_source)
    assert result.provenance_path.parent == result.output_path.parent
    assert result.provenance_path.name == "dtm_20m_epsg3826.source.json"


def test_provenance_carries_the_four_required_attribution_fields(aligned_source, run_etl,
                                                                 attribution):
    record = json.loads(run_etl(aligned_source).provenance_path.read_text(encoding="utf-8"))
    assert record["source"]["name"] == attribution["name"]
    assert record["source"]["url"] == attribution["url"]
    assert record["source"]["license"] == attribution["license"]
    assert record["source"]["retrieved"] == attribution["retrieved"]


def test_provenance_pins_the_exact_bytes_that_were_read(aligned_source, run_etl):
    import hashlib

    record = json.loads(run_etl(aligned_source).provenance_path.read_text(encoding="utf-8"))
    assert record["source"]["sha256"] == hashlib.sha256(aligned_source.read_bytes()).hexdigest()


def test_provenance_describes_both_grids_and_the_contract(aligned_source, run_etl, m1_area_doc):
    record = json.loads(run_etl(aligned_source).provenance_path.read_text(encoding="utf-8"))
    assert record["source"]["crs"] == "EPSG:3826"
    assert record["output"]["crs"] == OUTPUT_CRS
    assert record["output"]["resolution_m"] == RESOLUTION_M
    assert record["output"]["width"] == 175
    assert record["output"]["height"] == 175
    assert record["output"]["bounds"] == [M1_E_MIN, M1_N_MIN, M1_E_MAX, M1_N_MAX]
    assert record["output"]["resampling"] == "bilinear"
    assert record["area"]["spec_version"] == m1_area_doc["spec_version"]
    assert record["generated_at"].endswith("Z")
    assert record["tool"]["name"] == "scene_pipeline.etl.dtm"


def test_a_local_source_needs_an_explicit_retrieval_date(aligned_source, tmp_path, attribution):
    """Only a download witnesses a date.

    `build_source_ref` is told the download date solely when this run fetched
    the file; wiring it up unconditionally would stamp "today" on a file
    obtained years ago, which is a provenance claim nobody checked. That is
    the failure the record exists to prevent, so it is pinned here at the ETL
    level and not only on the helper.
    """
    meta = {k: v for k, v in attribution.items() if k != "retrieved"}
    out = tmp_path / "out" / "dtm.tif"
    with pytest.raises(DtmSourceMetadataError, match="retrieved"):
        run_dtm_etl(source=aligned_source, out=out, source_overrides=meta)
    assert not out.exists()


def test_a_downloaded_source_may_be_dated_by_the_run(tmp_path, aligned_source, attribution,
                                                     monkeypatch):
    """The other half of the same rule, so the fix cannot be "always refuse"."""
    import datetime as dt

    import requests

    class _Response:
        def raise_for_status(self):
            return None

        def iter_content(self, chunk_size=1):
            yield aligned_source.read_bytes()

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(requests, "get", lambda *a, **k: _Response())
    meta = {k: v for k, v in attribution.items() if k != "retrieved"}
    result = run_dtm_etl(source="https://example.invalid/dtm.tif", out=tmp_path / "o" / "d.tif",
                         source_overrides=meta, download_dir=tmp_path / "dl")
    assert result.source.retrieved == dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def test_no_output_is_produced_without_attribution(aligned_source, tmp_path):
    """PRD §4 made mechanical: no source record, no artefact."""
    out = tmp_path / "out" / "dtm_20m_epsg3826.tif"
    with pytest.raises(DtmSourceMetadataError):
        run_dtm_etl(source=aligned_source, out=out, source_overrides={"name": "only a name"})
    assert not out.exists()
    assert not out.parent.exists() or list(out.parent.iterdir()) == []


# ------------------------------------------------- publishing / partial state


def test_a_failure_while_publishing_leaves_nothing_behind(aligned_source, tmp_path,
                                                          attribution, monkeypatch):
    """The hazard this ETL actually has is not two writers, it is one writer
    dying mid-write and leaving a plausible-looking GeoTIFF for the next stage
    to consume. Publishing is therefore temp-then-replace."""
    out = tmp_path / "out" / "dtm_20m_epsg3826.tif"

    def boom(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(DtmOutputError):
        run_dtm_etl(source=aligned_source, out=out, source_overrides=attribution)
    assert not out.exists()
    assert list(out.parent.glob("*.tmp")) == []


def test_a_successful_run_leaves_no_temporary_files(aligned_source, run_etl):
    result = run_etl(aligned_source)
    assert list(result.output_path.parent.glob("*.tmp")) == []


def test_rerunning_replaces_the_previous_output(tmp_path, aligned_source, source_array, run_etl):
    out = tmp_path / "out" / "dtm.tif"
    run_etl(aligned_source, out=out)
    shifted = write_raster(tmp_path / "src" / "shifted.tif", source_array + 50.0,
                           west=SOURCE_WEST, north=SOURCE_NORTH)
    run_etl(shifted, out=out)
    data, _ = read_band(out)
    np.testing.assert_array_equal(data, (source_array + 50.0)[SOURCE_WINDOW])


def test_an_unusable_output_destination_is_reported(tmp_path, aligned_source, run_etl):
    blocker = tmp_path / "blocker"
    blocker.write_text("I am a file, not a directory", encoding="utf-8")
    with pytest.raises(DtmOutputError, match="blocker"):
        run_etl(aligned_source, out=blocker / "dtm.tif")
