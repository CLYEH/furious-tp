"""End-to-end DTM ETL: extent, CRS, provenance, failure modes.

Covers FTP-28 AC1 (one command, source -> clipped GeoTIFF), AC2 (resolution
and extent), AC4 (source/version record) and AC5 (EPSG:3826 round trip).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest
import rasterio
import rasterio.errors
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


@pytest.fixture
def phase_shifted_source(tmp_path):
    """A source offset half a pixel from the 20 m grid.

    On a grid-aligned source every kernel degenerates to a pure copy and all
    four produce bit-identical output, so a comparison between two kernels there
    proves nothing. Shifting the phase is what makes them genuinely disagree.
    """
    west, north, size = 304810.0, 2771810.0, 220
    e, n = pixel_centres(west, north, RESOLUTION_M, size, size)
    return write_raster(tmp_path / "src" / "shifted.tif", linear_elevation(e, n).astype("float32"),
                        west=west, north=north)


@pytest.mark.parametrize("method", ["nearest", "bilinear", "cubic", "average"])
def test_the_record_names_the_kernel_that_was_actually_used(aligned_source, run_etl, method):
    """Not covered by the default-only assertion above.

    A record that hard-codes "bilinear" agrees with every run that takes the
    default, which is every run the rest of this exam makes. Asking each kernel
    for its own name is what separates a reported value from a constant.
    """
    record = json.loads(
        run_etl(aligned_source, resampling=method).provenance_path.read_text(encoding="utf-8")
    )
    assert record["output"]["resampling"] == method


def test_the_recorded_kernel_distinguishes_rasters_that_really_differ(tmp_path, run_etl,
                                                                     phase_shifted_source):
    """Why the field has to track the argument: the kernel moves the elevations.

    The two runs below produce different ground — asserted, so this case cannot
    pass by comparing two identical rasters — and the record is the only thing a
    downstream consumer has to tell them apart. A hard-coded label would put the
    same provenance beside both, and the wrong one would look entirely normal.
    """
    def recorded_kernel(result):
        record = json.loads(result.provenance_path.read_text(encoding="utf-8"))
        return record["output"]["resampling"]

    near = run_etl(phase_shifted_source, out=tmp_path / "near" / "dtm.tif", resampling="nearest")
    bilin = run_etl(phase_shifted_source, out=tmp_path / "bilin" / "dtm.tif", resampling="bilinear")

    near_data, _ = read_band(near.output_path)
    bilin_data, _ = read_band(bilin.output_path)
    assert not np.array_equal(near_data, bilin_data), (
        "the two kernels produced identical rasters, so this case would pin nothing"
    )

    assert recorded_kernel(near) == "nearest"
    assert recorded_kernel(bilin) == "bilinear"


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


def test_attribution_is_settled_before_a_single_byte_is_downloaded(tmp_path, monkeypatch):
    """The order of the checks is itself a promise, so it is pinned here.

    `run_dtm_etl` validates attribution before it fetches anything, and both
    the module README and `source.py` say so. Nothing else notices if that
    call slides below the download: the run still fails, with the same error,
    on the same input — after spending a multi-gigabyte transfer of the
    nationwide DTM to learn something that was knowable from the arguments.
    A stub that fails the test when called is the only way to see it.
    """
    import requests

    calls = []

    def refuse(*args, **kwargs):
        calls.append(kwargs.get("url", args[0] if args else None))
        raise AssertionError("the download started before attribution was checked")

    monkeypatch.setattr(requests, "get", refuse)
    with pytest.raises(DtmSourceMetadataError, match="license"):
        run_dtm_etl(
            source="https://example.invalid/dtm_20m.tif",
            out=tmp_path / "out" / "dtm.tif",
            source_overrides={"name": "20 m DTM", "retrieved": "2026-08-01"},
            download_dir=tmp_path / "dl",
        )
    assert calls == []
    assert not (tmp_path / "dl").exists()


# ------------------------------------------------- publishing / partial state

# Two runs whose records differ in every field that matters, so a record left
# describing the wrong raster is unmistakable rather than a subtle diff.
V1_ATTRIBUTION = {
    "name": "PUBLISHED-v1",
    "url": "https://example.invalid/dtm/v1.tif",
    "license": "CC-BY-4.0",
    "retrieved": "2026-08-01",
}
V2_ATTRIBUTION = {
    "name": "ATTEMPTED-v2",
    "url": "https://example.invalid/dtm/v2.tif",
    "license": "ODbL-1.0",
    "retrieved": "2026-08-10",
}


def replace_failing_at(target):
    """`os.replace` that fails for one destination and really works for the rest.

    Failing *every* replace cannot tell the two publish steps apart, and the
    interesting states of this ETL are exactly the ones where one step landed
    and the other did not.
    """
    real = os.replace

    def _replace(src, dst):
        if Path(dst) == Path(target):
            raise PermissionError(13, "the file is open in another process", str(dst))
        return real(src, dst)

    return _replace


def replace_interrupted_at(target):
    """`os.replace` that takes a Ctrl-C on one destination, the rest working.

    `KeyboardInterrupt` derives from `BaseException`, so it is the one way to
    leave this ETL mid-publish without any of its recovery running. Injected
    here rather than signalled for real because the window being pinned is a
    few microseconds wide and a real SIGINT cannot be aimed at it.
    """
    real = os.replace

    def _replace(src, dst):
        if Path(dst) == Path(target):
            raise KeyboardInterrupt()
        return real(src, dst)

    return _replace


def writing_the_raster_raises(exc):
    """`rasterio.open` whose write-mode dataset fails from `write`.

    Every other publish-failure case in this file injects at `os.replace`, so
    the raster write — the long step, the one that actually fills the disk, and
    the only one that can raise `RasterioError` rather than `OSError` — has
    never been made to fail. The real dataset is opened first on purpose, so
    the temporary GeoTIFF genuinely exists when the failure arrives and the
    cleanup path has something to clean up.
    """
    real_open = rasterio.open

    class _FailsOnWrite:
        def __init__(self, dataset):
            self._dataset = dataset

        def __enter__(self):
            self._dataset.__enter__()
            return self

        def __exit__(self, *exc_info):
            return self._dataset.__exit__(*exc_info)

        def write(self, *args, **kwargs):
            raise exc

    def _open(*args, **kwargs):
        dataset = real_open(*args, **kwargs)
        if "w" in args[1:2] or kwargs.get("mode") == "w":
            return _FailsOnWrite(dataset)
        return dataset

    return _open


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
    assert not (out.parent / "dtm_20m_epsg3826.source.json").exists()
    assert list(out.parent.glob("*.tmp")) == []


def test_a_failed_first_publish_leaves_no_orphan_record(aligned_source, tmp_path,
                                                        attribution, monkeypatch):
    """"Nothing behind" has to include the record, and only this can see it.

    When the record lands and the raster does not, the run leaves a source
    record for a GeoTIFF that does not exist. The test above misses it because
    it fails both replaces, so the record never reaches its final path either.
    """
    out = tmp_path / "out" / "dtm.tif"
    record_path = out.parent / "dtm.source.json"

    monkeypatch.setattr(os, "replace", replace_failing_at(out))
    with pytest.raises(DtmOutputError):
        run_dtm_etl(source=aligned_source, out=out, source_overrides=attribution)

    assert not out.exists()
    assert not record_path.exists()
    assert list(out.parent.glob("*.tmp")) == []


def test_a_failed_publish_leaves_the_previous_record_byte_identical(tmp_path, aligned_source,
                                                                    source_array, monkeypatch):
    """A failed run must not falsify the record of the run that succeeded.

    The record is placed before the raster, so when the raster's replace fails
    the disk holds v1's GeoTIFF beside a record describing v2: different name,
    url, licence, sha256, valid_fraction. Every one of those is wrong about
    the file sitting next to it, and nothing about the record looks unusual —
    which is precisely why it is dangerous. Attribution mechanised (AC4, PRD
    §4) is worth nothing if a failed publish can rewrite it in place.

    Byte identity, not field-by-field: the whole record must be the one that
    was published, including the fields nobody thought to assert on.
    """
    out = tmp_path / "out" / "dtm.tif"
    record_path = out.parent / "dtm.source.json"
    run_dtm_etl(source=aligned_source, out=out, source_overrides=V1_ATTRIBUTION)
    published_record = record_path.read_bytes()
    published_raster, _ = read_band(out)

    v2 = write_raster(tmp_path / "src" / "v2.tif", source_array + 50.0,
                      west=SOURCE_WEST, north=SOURCE_NORTH)
    monkeypatch.setattr(os, "replace", replace_failing_at(out))
    with pytest.raises(DtmOutputError):
        run_dtm_etl(source=v2, out=out, source_overrides=V2_ATTRIBUTION)

    assert record_path.read_bytes() == published_record
    np.testing.assert_array_equal(read_band(out)[0], published_raster)
    assert list(out.parent.glob("*.tmp")) == []


@pytest.mark.skipif(os.name != "nt", reason="POSIX rename replaces an open file happily; "
                                            "holding the raster open only blocks os.replace "
                                            "on Windows")
def test_a_downstream_reader_holding_the_raster_cannot_falsify_the_record(tmp_path,
                                                                          aligned_source,
                                                                          source_array):
    """The same guarantee, under the real failure mode instead of an injected one.

    A downstream stage reading the published `dtm.tif` while the ETL re-runs is
    the reason temp-then-replace exists here, and on Windows an open handle
    makes `os.replace` fail for real: no monkeypatch, the OS refuses. If the
    record can be falsified by anything, it is by this.
    """
    out = tmp_path / "out" / "dtm.tif"
    record_path = out.parent / "dtm.source.json"
    run_dtm_etl(source=aligned_source, out=out, source_overrides=V1_ATTRIBUTION)
    published_record = record_path.read_bytes()
    published_raster, _ = read_band(out)

    v2 = write_raster(tmp_path / "src" / "v2.tif", source_array + 50.0,
                      west=SOURCE_WEST, north=SOURCE_NORTH)
    with open(out, "rb") as downstream_reader:
        assert downstream_reader.read(4) == b"II*\x00"  # a real reader, mid-read
        with pytest.raises(DtmOutputError):
            run_dtm_etl(source=v2, out=out, source_overrides=V2_ATTRIBUTION)
        assert record_path.read_bytes() == published_record

    np.testing.assert_array_equal(read_band(out)[0], published_raster)
    assert list(out.parent.glob("*.tmp")) == []


def test_a_new_raster_is_never_published_beside_the_old_record(tmp_path, aligned_source,
                                                               source_array, monkeypatch):
    """The publish order is load-bearing, so it is pinned rather than asserted in prose.

    `_publish` places the record first "so a published GeoTIFF always has one".
    Swap the two replaces and a failure in the second ships v2's elevations
    under v1's licence, url and sha256 — a raster whose record is not merely
    missing but wrong, and wrong in the direction that says "we are allowed to
    redistribute this".
    """
    out = tmp_path / "out" / "dtm.tif"
    record_path = out.parent / "dtm.source.json"
    run_dtm_etl(source=aligned_source, out=out, source_overrides=V1_ATTRIBUTION)
    published_record = record_path.read_bytes()
    published_raster, _ = read_band(out)

    v2 = write_raster(tmp_path / "src" / "v2.tif", source_array + 50.0,
                      west=SOURCE_WEST, north=SOURCE_NORTH)
    monkeypatch.setattr(os, "replace", replace_failing_at(record_path))
    with pytest.raises(DtmOutputError):
        run_dtm_etl(source=v2, out=out, source_overrides=V2_ATTRIBUTION)

    np.testing.assert_array_equal(read_band(out)[0], published_raster)
    assert record_path.read_bytes() == published_record
    record = json.loads(record_path.read_text(encoding="utf-8"))
    assert record["source"]["license"] == V1_ATTRIBUTION["license"]
    assert list(out.parent.glob("*.tmp")) == []


def test_the_published_record_is_never_seen_half_written(tmp_path, aligned_source,
                                                         source_array, monkeypatch):
    """Why the record goes through a temp file too, and not only the raster.

    Restoring the previous record on failure repairs the *end* state, so it
    hides the difference between writing the record to a temp file and writing
    it straight to its final path — every end-state assertion passes either
    way. What it cannot repair is the window in between: `open(path, "w")`
    empties its target the moment it opens, so a reader that looks at the
    record during a direct write sees an empty or half-written file rather
    than the record that is still published. The stand-in for that reader is
    the callback below, fired exactly where a real one would be unlucky.
    """
    out = tmp_path / "out" / "dtm.tif"
    record_path = out.parent / "dtm.source.json"
    run_dtm_etl(source=aligned_source, out=out, source_overrides=V1_ATTRIBUTION)
    published_record = record_path.read_bytes()

    v2 = write_raster(tmp_path / "src" / "v2.tif", source_array + 50.0,
                      west=SOURCE_WEST, north=SOURCE_NORTH)
    seen = []
    real_write_text = Path.write_text

    def truncate_then_write(self, data, **kwargs):
        with open(self, "w", encoding="utf-8"):
            pass  # what "w" does before a single byte is written
        seen.append(record_path.read_bytes() if record_path.is_file() else None)
        return real_write_text(self, data, **kwargs)

    monkeypatch.setattr(Path, "write_text", truncate_then_write)
    run_dtm_etl(source=v2, out=out, source_overrides=V2_ATTRIBUTION)

    assert seen == [published_record]
    assert json.loads(record_path.read_text(encoding="utf-8"))["source"]["name"] == "ATTEMPTED-v2"


def test_a_record_that_cannot_be_put_back_is_named_in_the_error(tmp_path, aligned_source,
                                                                source_array, monkeypatch):
    """When the guarantee degrades, it degrades out loud.

    Restoring the previous record can itself fail — the same open handle that
    blocked the raster can block the record. The one thing that must not happen
    then is silence: the operator has to be told, in the error they already
    get, that the record on disk now describes a raster that was never
    published. An unreported falsified record is the whole hazard, arriving
    through the code meant to prevent it.
    """
    out = tmp_path / "out" / "dtm.tif"
    record_path = out.parent / "dtm.source.json"
    run_dtm_etl(source=aligned_source, out=out, source_overrides=V1_ATTRIBUTION)

    v2 = write_raster(tmp_path / "src" / "v2.tif", source_array + 50.0,
                      west=SOURCE_WEST, north=SOURCE_NORTH)

    def unwritable(self, data):
        raise PermissionError(13, "the record is open in another process", str(self))

    monkeypatch.setattr(os, "replace", replace_failing_at(out))
    monkeypatch.setattr(Path, "write_bytes", unwritable)
    with pytest.raises(DtmOutputError) as excinfo:
        run_dtm_etl(source=v2, out=out, source_overrides=V2_ATTRIBUTION)

    message = str(excinfo.value)
    assert str(record_path) in message
    assert "could not be put back" in message
    assert "never published" in message


def test_a_record_that_cannot_be_snapshotted_stops_the_publish(tmp_path, aligned_source,
                                                                source_array, monkeypatch):
    """The snapshot guard is fail-closed, and nothing was holding it there.

    `_publish` reads the published record before it replaces it, so a failure
    later can put it back. When that read fails — the same exclusive handle
    that makes `os.replace` fail on Windows also blocks a read, and that is the
    scenario this whole mechanism exists for — the run must refuse to publish
    at all.

    Swallowing the read instead (`previous_record = None`) is the innocent
    looking alternative, and it turns the restore into a *deleter*: with no
    snapshot to compare against, `_restore_record` takes its "there was nothing
    here before" branch and unlinks the very record it could not read, leaving
    the previously published GeoTIFF with no provenance at all. Orphaning the
    shipped raster is a worse outcome than refusing to start, so the guard
    fails closed — and this is what says so.
    """
    out = tmp_path / "out" / "dtm.tif"
    record_path = out.parent / "dtm.source.json"
    run_dtm_etl(source=aligned_source, out=out, source_overrides=V1_ATTRIBUTION)
    published_record = record_path.read_bytes()
    published_raster, _ = read_band(out)

    v2 = write_raster(tmp_path / "src" / "v2.tif", source_array + 50.0,
                      west=SOURCE_WEST, north=SOURCE_NORTH)

    # Blocked only for the snapshot read: a handle held briefly, which is what
    # lets the swallowing variant reach the unlink instead of stopping there.
    real_read_bytes = Path.read_bytes
    blocked = {record_path}

    def blocked_once(self):
        if self in blocked:
            blocked.discard(self)
            raise PermissionError(13, "the record is open in another process", str(self))
        return real_read_bytes(self)

    monkeypatch.setattr(Path, "read_bytes", blocked_once)
    monkeypatch.setattr(os, "replace", replace_failing_at(out))
    with pytest.raises(DtmOutputError) as excinfo:
        run_dtm_etl(source=v2, out=out, source_overrides=V2_ATTRIBUTION)

    assert record_path.is_file(), "the published record was deleted by the run that failed"
    assert real_read_bytes(record_path) == published_record
    np.testing.assert_array_equal(read_band(out)[0], published_raster)
    assert list(out.parent.glob("*.tmp")) == []
    assert "cannot read the source record" in str(excinfo.value)


def test_an_interrupt_between_the_two_moves_does_not_falsify_the_record(tmp_path, aligned_source,
                                                                        source_array, monkeypatch):
    """Ctrl-C is not an `OSError`, and the atomicity boundary has to know that.

    `KeyboardInterrupt` derives from `BaseException`, so a clause catching
    `(RasterioError, OSError)` lets it straight through: no cleanup, no
    restore, no word to anyone. Landing between the two replaces leaves the
    disk in *exactly* the state a failed publish used to leave it in — the
    previous GeoTIFF beside a record describing the one that was never
    published — except that here nothing even tried to undo it.

    This is not the process-death window the README accepts. The process is
    alive and perfectly able to put the record back; it simply was not asked
    to. Interrupting is also the one failure an operator causes deliberately,
    so it is the likeliest of the lot.
    """
    out = tmp_path / "out" / "dtm.tif"
    record_path = out.parent / "dtm.source.json"
    run_dtm_etl(source=aligned_source, out=out, source_overrides=V1_ATTRIBUTION)
    published_record = record_path.read_bytes()
    published_raster, _ = read_band(out)

    v2 = write_raster(tmp_path / "src" / "v2.tif", source_array + 50.0,
                      west=SOURCE_WEST, north=SOURCE_NORTH)
    monkeypatch.setattr(os, "replace", replace_interrupted_at(out))
    with pytest.raises(KeyboardInterrupt):
        run_dtm_etl(source=v2, out=out, source_overrides=V2_ATTRIBUTION)

    assert record_path.read_bytes() == published_record
    np.testing.assert_array_equal(read_band(out)[0], published_raster)
    assert list(out.parent.glob("*.tmp")) == []


def test_an_interrupt_while_the_raster_is_being_written_leaves_no_temp(tmp_path, aligned_source,
                                                                       attribution, monkeypatch):
    """The same boundary, over the window that is actually wide.

    The gap between the two replaces is microseconds; the raster write is the
    whole cost of the run — minutes for a nationwide DTM. That is where a
    Ctrl-C lands in practice, and an uncaught one leaves `dtm.tif.tmp` sitting
    in the output directory for good: not dangerous the way a falsified record
    is, but a standing violation of the README's "a failed run leaves no
    temporary files", every single time.
    """
    out = tmp_path / "out" / "dtm.tif"

    monkeypatch.setattr(rasterio, "open", writing_the_raster_raises(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        run_dtm_etl(source=aligned_source, out=out, source_overrides=attribution)

    assert not out.exists()
    assert not (out.parent / "dtm.source.json").exists()
    assert list(out.parent.glob("*.tmp")) == []


def test_a_raster_write_that_fails_is_reported_and_changes_nothing(tmp_path, aligned_source,
                                                                    source_array, monkeypatch):
    """The other half of the same `except`, and it had no witness either.

    Every publish-failure case above injects at `os.replace`, so the failure
    the code most obviously guards against — the write of the GeoTIFF itself —
    had never been exercised. It matters because rasterio raises
    `RasterioError`, which is *not* an `OSError`: drop that name from the
    clause and the entire suite stays green while a genuine write failure
    escapes as a raw rasterio error, past the cleanup and past the restore.
    """
    out = tmp_path / "out" / "dtm.tif"
    record_path = out.parent / "dtm.source.json"
    run_dtm_etl(source=aligned_source, out=out, source_overrides=V1_ATTRIBUTION)
    published_record = record_path.read_bytes()
    published_raster, _ = read_band(out)

    v2 = write_raster(tmp_path / "src" / "v2.tif", source_array + 50.0,
                      west=SOURCE_WEST, north=SOURCE_NORTH)
    failure = rasterio.errors.RasterioError("the driver refused to write the block")
    monkeypatch.setattr(rasterio, "open", writing_the_raster_raises(failure))
    with pytest.raises(DtmOutputError, match="refused to write"):
        run_dtm_etl(source=v2, out=out, source_overrides=V2_ATTRIBUTION)

    assert record_path.read_bytes() == published_record
    np.testing.assert_array_equal(read_band(out)[0], published_raster)
    assert list(out.parent.glob("*.tmp")) == []


def test_a_failed_republish_leaves_the_previous_output_intact(tmp_path, aligned_source,
                                                              source_array, attribution,
                                                              monkeypatch):
    """Temp-then-replace has a second job, and only this test can see it.

    The assertion above ("nothing left behind") is satisfied even by a variant
    that writes the raster straight to its final path: the failure handler
    deletes the wreck it just made, so no litter remains either way. What that
    variant also does is destroy the *previous* output — a file downstream
    stages may already be reading — the moment the new write opens. Until the
    replace lands, the last good raster must still be the published one, so a
    failed re-run costs nothing.
    """
    out = tmp_path / "out" / "dtm.tif"
    run_dtm_etl(source=aligned_source, out=out, source_overrides=attribution)
    published, _ = read_band(out)

    shifted = write_raster(tmp_path / "src" / "shifted.tif", source_array + 50.0,
                           west=SOURCE_WEST, north=SOURCE_NORTH)

    def boom(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(DtmOutputError):
        run_dtm_etl(source=shifted, out=out, source_overrides=attribution)

    assert out.exists()
    np.testing.assert_array_equal(read_band(out)[0], published)
    assert list(out.parent.glob("*.tmp")) == []


def test_a_successful_run_leaves_no_temporary_files(aligned_source, run_etl):
    result = run_etl(aligned_source)
    assert list(result.output_path.parent.glob("*.tmp")) == []


def test_every_temporary_is_replaced_from_beside_its_destination(tmp_path, aligned_source,
                                                                 attribution, monkeypatch):
    """os.replace is only atomic within one filesystem, so the invariant is
    "the temporary is a sibling of its destination" -- not "it is tidy".

    A temporary under `tempfile.gettempdir()` is indistinguishable on a
    single-volume machine and silently degrades into a copy on a machine whose
    TMPDIR is another disk, reintroducing the half-written file at the real
    path this whole dance exists to prevent. That cannot be tested by
    provoking it portably, so it is tested where it is decided: every rename
    this module performs must have src.parent == dst.parent.
    """
    seen = []
    real = os.replace

    def recording(src, dst):
        seen.append((Path(src), Path(dst)))
        return real(src, dst)

    monkeypatch.setattr(os, "replace", recording)
    run_dtm_etl(source=aligned_source, out=tmp_path / "out" / "dtm.tif",
                source_overrides=attribution)

    assert seen, "no rename was observed; the publish path changed shape"
    for src, dst in seen:
        assert src.parent == dst.parent, (
            f"{src} is not beside {dst}: os.replace is not atomic across filesystems"
        )


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


DTM_README = (
    Path(__file__).resolve().parents[3] / "src" / "scene_pipeline" / "etl" / "dtm" / "README.md"
)


def readme_limitation_paragraph() -> str:
    """The single-publisher paragraph of the module README, or a loud failure.

    Returning "" when the anchor moves would make the assertions below
    vacuously true, which is the shape of false green this project has already
    shipped more than once. So the locator asserts it found exactly one.
    """
    paragraphs = [p for p in DTM_README.read_text(encoding="utf-8").split("\n\n")
                  if "使用限制" in p]
    assert len(paragraphs) == 1, (
        f"expected exactly one 使用限制 paragraph in {DTM_README.name}, found {len(paragraphs)}"
    )
    return paragraphs[0]


def test_the_documented_way_to_publish_in_parallel_is_one_that_actually_works(
    tmp_path, aligned_source, run_etl
):
    """The mitigation an operator is told to use has to be one that works.

    The record path is derived from the output *stem*, so two genuinely
    different `--out` values can still land on one record — measured below
    rather than argued: `dtm.tif` and `dtm.tiff` share `dtm.source.json`. An
    operator who parallelises by "give it a different `--out`" therefore still
    ends up with run B's provenance sitting beside run A's elevations, with no
    lock, no detection and nothing that looks wrong.

    The two halves are pinned together on purpose. If the record path is ever
    made to follow the whole filename, the collision below disappears and this
    case fails — which is exactly the moment the README paragraph has to be
    rewritten, rather than quietly becoming wrong in the other direction.
    """
    run_a = run_etl(aligned_source, out=tmp_path / "pub" / "dtm.tif")
    run_b = run_etl(aligned_source, out=tmp_path / "pub" / "dtm.tiff")

    assert run_a.output_path != run_b.output_path
    assert run_a.provenance_path == run_b.provenance_path, (
        "two different --out values no longer collide; the README mitigation can be widened"
    )
    survivor = json.loads(run_b.provenance_path.read_text(encoding="utf-8"))
    assert survivor["output"]["path"] == "dtm.tiff"

    limitation = readme_limitation_paragraph()
    assert "不同的 `--out`" not in limitation, (
        "the README still offers the mitigation the collision above disproves"
    )
    assert "stem" in limitation and "目錄" in limitation, (
        "the README must name what actually separates two publishers: directory or stem"
    )
