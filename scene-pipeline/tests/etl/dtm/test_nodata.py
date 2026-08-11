"""nodata policy (FTP-28 AC3).

The policy under exam, in one sentence: **a void stays a void, and a void
never leaks into its neighbours.**

Two halves, both load-bearing:

* **N1 no fill** — this stage invents no elevations. Void filling is a
  downstream terrain decision (D9), made where the road corridor is known;
  doing it here would launder a guess into the intermediate product that every
  later stage treats as measured ground.
* **N2 no contamination** — an output pixel is valid only if *every* source
  pixel in its resampling kernel was valid. This is deliberately stricter than
  GDAL's own `src_nodata` handling, which renormalises the kernel over the
  surviving neighbours and thereby extrapolates ground across the hole. That
  behaviour is measured, not assumed: on a synthetic plane with a single void
  pixel, GDAL's default emits values that are metres off the plane. For a DTM
  that feeds D3 road elevation and D8 physics, a hole you can see beats a
  plausible number you cannot.
"""

from __future__ import annotations

import numpy as np
import pytest
import rasterio

from scene_pipeline.etl.dtm.errors import DtmCoverageError
from scene_pipeline.etl.dtm.etl import OUTPUT_NODATA

from .conftest import (
    RESOLUTION_M,
    SOURCE_NORTH,
    SOURCE_WEST,
    SOURCE_WINDOW,
    linear_elevation,
    pixel_centres,
    read_band,
    write_raster,
)

SENTINEL = -999.0

# A void block placed well inside the M1 bbox, in source pixel coordinates.
VOID = (slice(80, 83), slice(80, 83))

# Source grid offset by half a pixel from the 20 m grid, which forces real
# resampling (the aligned case is a pure copy and cannot show contamination).
OFFSET_WEST = 304810.0
OFFSET_NORTH = 2771810.0
OFFSET_SIZE = 220


@pytest.fixture
def voided_aligned_source(tmp_path, source_array):
    array = source_array.copy()
    array[VOID] = SENTINEL
    return write_raster(tmp_path / "src" / "void.tif", array, west=SOURCE_WEST,
                        north=SOURCE_NORTH, nodata=SENTINEL)


@pytest.fixture
def offset_source_array():
    e, n = pixel_centres(OFFSET_WEST, OFFSET_NORTH, RESOLUTION_M, OFFSET_SIZE, OFFSET_SIZE)
    return linear_elevation(e, n).astype("float32")


@pytest.fixture
def voided_offset_source(tmp_path, offset_source_array):
    array = offset_source_array.copy()
    array[VOID] = SENTINEL
    return write_raster(tmp_path / "src" / "void_offset.tif", array, west=OFFSET_WEST,
                        north=OFFSET_NORTH, nodata=SENTINEL)


def test_source_nodata_becomes_the_output_nodata(voided_aligned_source, run_etl):
    result = run_etl(voided_aligned_source)
    data, profile = read_band(result.output_path)
    assert profile["nodata"] == OUTPUT_NODATA
    assert (data == OUTPUT_NODATA).any()


def test_the_sentinel_value_never_survives_into_the_output(voided_aligned_source, run_etl):
    """-999 must not be readable downstream as an elevation of -999 m."""
    data, _ = read_band(run_etl(voided_aligned_source).output_path)
    assert not (data == SENTINEL).any()


def test_voids_are_preserved_rather_than_filled(voided_aligned_source, run_etl):
    """N1: the hole is still a hole, and exactly the size it was."""
    data, _ = read_band(run_etl(voided_aligned_source).output_path)
    void_rows = VOID[0].stop - VOID[0].start
    void_cols = VOID[1].stop - VOID[1].start
    assert int((data == OUTPUT_NODATA).sum()) == void_rows * void_cols


def test_valid_pixels_are_untouched_on_the_aligned_path(voided_aligned_source, source_array,
                                                        run_etl):
    data, _ = read_band(run_etl(voided_aligned_source).output_path)
    expected = source_array[SOURCE_WINDOW]
    valid = data != OUTPUT_NODATA
    np.testing.assert_array_equal(data[valid], expected[valid])


def test_reprojection_never_emits_a_contaminated_elevation(voided_offset_source, run_etl):
    """N2, stated as a measurable property.

    The source is a plane, so every honestly-resampled value must land back on
    that plane. A pixel whose kernel touched the void cannot: whether the void
    is substituted or the kernel is renormalised over the survivors, the result
    leaves the plane. So "every valid output pixel is on the plane" is exactly
    the no-contamination claim.
    """
    result = run_etl(voided_offset_source)
    data, _ = read_band(result.output_path)
    cols = np.arange(result.grid.width)
    rows = np.arange(result.grid.height)
    e = result.grid.e_min + (cols + 0.5) * RESOLUTION_M
    n = result.grid.n_max - (rows + 0.5) * RESOLUTION_M
    ee, nn = np.meshgrid(e, n)
    expected = linear_elevation(ee, nn)

    valid = data != OUTPUT_NODATA
    assert valid.any(), "the guard must not blank the whole raster"
    np.testing.assert_allclose(data[valid], expected[valid], rtol=0, atol=1e-2)


@pytest.mark.parametrize("method", ["bilinear", "cubic", "average"])
def test_no_kernel_lets_a_void_contaminate_its_neighbours(voided_offset_source, run_etl, method):
    """The same property as above, held against every interpolating kernel.

    Not redundant with the bilinear case: cubic weights can be negative, so
    excluding an invalid neighbour can make the surviving weights sum to more
    than 1 (measured: 1.035). A containment test written as "mask >= 1 - eps"
    passes bilinear and average and still admits contaminated cubic pixels,
    which is precisely the bug this case exists to catch. Nearest is excluded
    because it cannot mix pixels at all, so it has nothing to contaminate with.
    """
    result = run_etl(voided_offset_source, resampling=method)
    data, _ = read_band(result.output_path)
    ee, nn = pixel_centres(result.grid.e_min, result.grid.n_max, RESOLUTION_M,
                           result.grid.width, result.grid.height)
    expected = linear_elevation(ee, nn)
    valid = data != OUTPUT_NODATA
    assert valid.any()
    np.testing.assert_allclose(data[valid], expected[valid], rtol=0, atol=1e-2)


def test_the_void_grows_by_the_kernel_footprint_when_resampling(voided_offset_source, run_etl):
    """A half-pixel-shifted kernel touches the void from outside it, so the
    invalid region must be strictly larger than the void's own footprint."""
    data, _ = read_band(run_etl(voided_offset_source).output_path)
    invalid = int((data == OUTPUT_NODATA).sum())
    void_area_m2 = (VOID[0].stop - VOID[0].start) * (VOID[1].stop - VOID[1].start)
    assert invalid > void_area_m2


def test_far_from_the_void_everything_stays_valid(voided_offset_source, run_etl):
    data, _ = read_band(run_etl(voided_offset_source).output_path)
    assert data[0, 0] != OUTPUT_NODATA
    assert data[-1, -1] != OUTPUT_NODATA


def test_an_undeclared_sentinel_can_be_declared_on_the_command(tmp_path, source_array, run_etl):
    """ASCII-grid DTMs often carry -999 with no nodata tag at all."""
    array = source_array.copy()
    array[VOID] = SENTINEL
    untagged = write_raster(tmp_path / "src" / "untagged.tif", array, west=SOURCE_WEST,
                            north=SOURCE_NORTH, nodata=None)
    data, _ = read_band(run_etl(untagged, extra_nodata=(SENTINEL,)).output_path)
    assert not (data == SENTINEL).any()
    assert (data == OUTPUT_NODATA).any()


def test_an_undeclared_sentinel_is_not_guessed(tmp_path, source_array, run_etl):
    """Without a declaration the value is data, not a void: guessing which
    negative numbers are sentinels would silently delete real bathymetry."""
    array = source_array.copy()
    array[VOID] = SENTINEL
    untagged = write_raster(tmp_path / "src" / "untagged2.tif", array, west=SOURCE_WEST,
                            north=SOURCE_NORTH, nodata=None)
    data, _ = read_band(run_etl(untagged).output_path)
    assert (data == SENTINEL).any()


def test_nan_in_the_source_is_treated_as_a_void(tmp_path, source_array, run_etl):
    array = source_array.copy()
    array[VOID] = np.nan
    path = write_raster(tmp_path / "src" / "nan.tif", array, west=SOURCE_WEST, north=SOURCE_NORTH)
    data, _ = read_band(run_etl(path).output_path)
    assert not np.isnan(data).any()
    assert (data == OUTPUT_NODATA).any()


def test_an_entirely_void_source_is_an_error_not_an_empty_raster(tmp_path, source_array, run_etl):
    """N4, asserted on the disk — which is the half this test's name promises.

    Raising is the cheap half. The claim in the name is "not an empty raster",
    and an exception says nothing about that: move the `valid_fraction <= 0`
    rejection below `_publish` and the run still raises `DtmCoverageError`
    with the same message, while the output directory now holds a complete
    175 x 175 all-nodata GeoTIFF beside a record announcing
    `valid_fraction: 0.0`. The run reports failure and ships the artefact
    anyway — README N4 exactly inverted, and every assertion still green.

    So the observable is the output directory, not the exception: a rejected
    run leaves nothing at all for the next stage to pick up.
    """
    array = np.full_like(source_array, SENTINEL)
    path = write_raster(tmp_path / "src" / "allvoid.tif", array, west=SOURCE_WEST,
                        north=SOURCE_NORTH, nodata=SENTINEL)
    out = tmp_path / "out" / "dtm.tif"
    with pytest.raises(DtmCoverageError, match="no valid pixels"):
        run_etl(path, out=out)

    assert not out.exists()
    assert not (out.parent / "dtm.source.json").exists()
    # Nothing whatsoever, so a temp file or a stray record cannot slip through.
    assert not out.parent.exists() or list(out.parent.iterdir()) == []


def test_valid_fraction_is_measured_and_reported(voided_aligned_source, run_etl):
    result = run_etl(voided_aligned_source)
    voids = (VOID[0].stop - VOID[0].start) * (VOID[1].stop - VOID[1].start)
    expected = 1.0 - voids / (result.grid.width * result.grid.height)
    assert result.valid_fraction == pytest.approx(expected, abs=1e-9)


def test_a_clean_source_reports_full_coverage(aligned_source, run_etl):
    assert run_etl(aligned_source).valid_fraction == pytest.approx(1.0)


def test_the_policy_is_named_in_the_provenance_record(voided_aligned_source, run_etl):
    import json

    result = run_etl(voided_aligned_source)
    record = json.loads(result.provenance_path.read_text(encoding="utf-8"))
    assert record["nodata"]["policy"]
    assert record["nodata"]["output_nodata"] == OUTPUT_NODATA
    assert record["nodata"]["fill"] is False
    assert record["valid_fraction"] == pytest.approx(result.valid_fraction)


# ------------------------------------------------- the sentinel value itself
#
# Everything above compares against `OUTPUT_NODATA` imported from the module
# under test, which makes all of it true for whatever value the constant
# happens to hold. Move the constant to 0.0 and every assertion above stays
# green while each downstream consumer begins reading real sea-level ground as
# void. The cases below are the ones that hold the value still: they spell the
# number out, and they exercise the elevation that a sentinel of 0.0 would eat.

# Taipei's DTM carries genuine ground at (and slightly below) 0 m along the
# Tamsui and Keelung river mouths; Taiwan's ceiling is Yushan at 3952 m. A
# sentinel anywhere inside this band is indistinguishable from a measurement.
PLAUSIBLE_ELEVATION_RANGE_M = (-50.0, 4000.0)

# Real ground at exactly 0.0 m, in source pixel coordinates.
SEA_LEVEL = (slice(100, 105), slice(100, 105))


def sea_level_block_in_output() -> tuple[slice, slice]:
    """Where `SEA_LEVEL` lands in the clipped output."""
    rows, cols = SOURCE_WINDOW
    return (
        slice(SEA_LEVEL[0].start - rows.start, SEA_LEVEL[0].stop - rows.start),
        slice(SEA_LEVEL[1].start - cols.start, SEA_LEVEL[1].stop - cols.start),
    )


@pytest.fixture
def coastal_source(tmp_path, source_array):
    """A source holding real, measured ground at exactly 0.0 m."""
    array = source_array.copy()
    array[SEA_LEVEL] = 0.0
    return write_raster(tmp_path / "src" / "coastal.tif", array, west=SOURCE_WEST,
                        north=SOURCE_NORTH)


def test_the_output_void_sentinel_is_pinned_to_minus_9999():
    """The literal, on purpose — this is the assertion the constant cannot slip past.

    Written as a bare value rather than against anything imported, because the
    thing being guarded *is* the import. -9999.0 is not arbitrary: it is the
    value the module's own comment and README both justify, and the value every
    downstream stage will mask on.
    """
    assert OUTPUT_NODATA == -9999.0


def test_the_sentinel_cannot_be_mistaken_for_an_elevation_taiwan_can_produce():
    """The reason for the number, stated as a property rather than a constant.

    Pinning -9999.0 alone would be satisfied by any future edit that changed
    both the constant and the test together. This is the rule that edit would
    still have to answer to: a sentinel is only a sentinel if no real
    measurement can collide with it.
    """
    low, high = PLAUSIBLE_ELEVATION_RANGE_M
    assert not (low <= OUTPUT_NODATA <= high)


def test_the_published_raster_declares_the_pinned_sentinel(aligned_source, run_etl):
    """The GeoTIFF tag is what a consumer masks on, so it is pinned by value."""
    _, profile = read_band(run_etl(aligned_source).output_path)
    assert profile["nodata"] == -9999.0


def test_the_record_pins_the_sentinel_and_agrees_with_the_raster(voided_aligned_source, run_etl):
    """Two claims, both load-bearing.

    A consumer that reads the JSON rather than the GeoTIFF tag learns from
    `nodata.output_nodata` which value means "no measurement", so that value is
    pinned literally here. And it must be the value actually written into the
    band: a record naming a different sentinel than the raster beside it is the
    same falsified pair this module is arranged to prevent, only quieter — the
    numbers would look like elevations and nothing would complain.
    """
    import json

    result = run_etl(voided_aligned_source)
    record = json.loads(result.provenance_path.read_text(encoding="utf-8"))
    _, profile = read_band(result.output_path)
    assert record["nodata"]["output_nodata"] == -9999.0
    assert record["nodata"]["output_nodata"] == profile["nodata"]


def test_ground_at_exactly_zero_metres_is_published_as_measured_ground(coastal_source, run_etl):
    """The boundary the choice of sentinel is actually about.

    A sentinel of 0.0 does not break anything visibly: the ETL still runs, still
    reports its `valid_fraction`, still writes a plausible raster. What changes
    is that every consumer masking on the declared nodata silently deletes the
    river-mouth and coastal ground this case stands for.

    So the observation is made the way a consumer makes it — `masked=True`
    applies the file's own nodata tag — and not by comparing against the
    constant, because the constant is precisely what would have moved.
    """
    result = run_etl(coastal_source)
    block = sea_level_block_in_output()

    with rasterio.open(result.output_path) as src:
        published = src.read(1, masked=True)

    assert not np.ma.getmaskarray(published)[block].any(), (
        "ground measured at exactly 0 m was masked away as void"
    )
    assert (published.data[block] == 0.0).all()
    assert result.valid_fraction == pytest.approx(1.0)
