"""Pixel-alignment rules (FTP-28 AC2).

The rule under exam: the output grid is anchored at the EPSG:3826 origin, so
every pixel EDGE sits on a multiple of the resolution, and the requested bbox
is snapped OUTWARD (floor on the min side, ceil on the max side). Outward
snapping is what makes "covers the bbox" true by construction; anything else
can shave a strip off the edge of the area the rest of M1 assumes it has.
"""

from __future__ import annotations

import pytest
from scene_pipeline.etl.dtm.area import Bbox
from scene_pipeline.etl.dtm.errors import DtmGridError
from scene_pipeline.etl.dtm.grid import (
    DEFAULT_RESOLUTION_M,
    MAX_OUTPUT_PIXELS,
    align_bbox,
    check_tile_alignment,
)

from .conftest import M1_E_MAX, M1_E_MIN, M1_N_MAX, M1_N_MIN, RESOLUTION_M

M1_BBOX = Bbox(M1_E_MIN, M1_N_MIN, M1_E_MAX, M1_N_MAX)


def test_default_resolution_is_the_20m_dtm_resolution():
    assert DEFAULT_RESOLUTION_M == 20.0


def test_m1_bbox_is_already_grid_aligned_so_output_is_exact():
    """M1's bbox corners are multiples of 20, so snapping must be a no-op."""
    grid = align_bbox(M1_BBOX, RESOLUTION_M)
    assert (grid.e_min, grid.n_min, grid.e_max, grid.n_max) == (
        M1_E_MIN, M1_N_MIN, M1_E_MAX, M1_N_MAX)
    assert (grid.width, grid.height) == (175, 175)


def test_unaligned_bbox_snaps_outward():
    """A bbox 1 m inside the grid on every side must grow, never shrink."""
    bbox = Bbox(M1_E_MIN + 1.0, M1_N_MIN + 1.0, M1_E_MAX - 1.0, M1_N_MAX - 1.0)
    grid = align_bbox(bbox, RESOLUTION_M)
    assert grid.e_min == M1_E_MIN
    assert grid.n_min == M1_N_MIN
    assert grid.e_max == M1_E_MAX
    assert grid.n_max == M1_N_MAX


@pytest.mark.parametrize("shift", [0.0, 0.4, 1.0, 9.9, 10.0, 10.1, 19.0, 19.999])
def test_aligned_grid_always_contains_the_requested_bbox(shift):
    """The coverage guarantee, swept across a whole pixel of misalignment.

    `round`-style snapping passes at shift 0 and fails here: this is the case
    that makes floor/ceil load-bearing rather than decorative.
    """
    bbox = Bbox(M1_E_MIN + shift, M1_N_MIN + shift, M1_E_MAX + shift, M1_N_MAX + shift)
    grid = align_bbox(bbox, RESOLUTION_M)
    assert grid.e_min <= bbox.e_min
    assert grid.n_min <= bbox.n_min
    assert grid.e_max >= bbox.e_max
    assert grid.n_max >= bbox.n_max


@pytest.mark.parametrize("shift", [0.0, 0.4, 10.0, 19.999])
def test_pixel_edges_stay_on_multiples_of_the_resolution(shift):
    bbox = Bbox(M1_E_MIN + shift, M1_N_MIN + shift, M1_E_MAX + shift, M1_N_MAX + shift)
    grid = align_bbox(bbox, RESOLUTION_M)
    for edge in (grid.e_min, grid.n_min, grid.e_max, grid.n_max):
        assert edge % RESOLUTION_M == 0.0


def test_snapping_never_overshoots_by_a_whole_pixel():
    """Outward snapping must be minimal, not merely safe."""
    bbox = Bbox(M1_E_MIN + 0.5, M1_N_MIN + 0.5, M1_E_MAX + 0.5, M1_N_MAX + 0.5)
    grid = align_bbox(bbox, RESOLUTION_M)
    assert bbox.e_min - grid.e_min < RESOLUTION_M
    assert grid.e_max - bbox.e_max < RESOLUTION_M


def test_tile_boundaries_fall_on_pixel_edges(grid_doc):
    """contracts/spec/grid.md: 500 m tiles are 25 cells of 20 m DTM per side."""
    tile_size_m = float(grid_doc["tile_size_m"])
    grid = align_bbox(M1_BBOX, RESOLUTION_M)
    boundary = grid.e_min
    while boundary <= grid.e_max:
        if boundary % tile_size_m == 0.0:
            index = (boundary - grid.e_min) / grid.resolution_m
            assert index == int(index)
        boundary += RESOLUTION_M


def test_check_tile_alignment_accepts_the_contract_pair(grid_doc):
    check_tile_alignment(RESOLUTION_M, float(grid_doc["tile_size_m"]))


@pytest.mark.parametrize("resolution", [30.0, 7.0, 300.0, 500.1])
def test_check_tile_alignment_rejects_resolutions_that_do_not_divide_the_tile(resolution):
    with pytest.raises(DtmGridError, match="tile"):
        check_tile_alignment(resolution, 500.0)


@pytest.mark.parametrize("resolution", [0.0, -20.0])
def test_non_positive_resolution_is_rejected(resolution):
    with pytest.raises(DtmGridError, match="resolution"):
        align_bbox(M1_BBOX, resolution)


@pytest.mark.parametrize(
    "bbox",
    [
        Bbox(M1_E_MIN, M1_N_MIN, M1_E_MIN, M1_N_MAX),   # zero width
        Bbox(M1_E_MIN, M1_N_MIN, M1_E_MAX, M1_N_MIN),   # zero height
        Bbox(M1_E_MAX, M1_N_MIN, M1_E_MIN, M1_N_MAX),   # inverted east
        Bbox(M1_E_MIN, M1_N_MAX, M1_E_MAX, M1_N_MIN),   # inverted north
    ],
)
def test_degenerate_bbox_is_rejected(bbox):
    with pytest.raises(DtmGridError, match="bbox"):
        align_bbox(bbox, RESOLUTION_M)


def test_sub_pixel_bbox_still_yields_a_covering_pixel():
    bbox = Bbox(M1_E_MIN + 1.0, M1_N_MIN + 1.0, M1_E_MIN + 2.0, M1_N_MIN + 2.0)
    grid = align_bbox(bbox, RESOLUTION_M)
    assert (grid.width, grid.height) == (1, 1)
    assert grid.e_min <= bbox.e_min and grid.e_max >= bbox.e_max


def test_absurdly_large_bbox_is_refused_rather_than_allocated():
    """A degrees-instead-of-metres typo must fail loudly, not eat all the RAM."""
    bbox = Bbox(0.0, 0.0, 20_000_000.0, 20_000_000.0)
    with pytest.raises(DtmGridError, match="too large"):
        align_bbox(bbox, RESOLUTION_M)


def test_pixel_budget_boundary_is_inclusive():
    side = int(MAX_OUTPUT_PIXELS**0.5)
    bbox = Bbox(0.0, 0.0, side * RESOLUTION_M, side * RESOLUTION_M)
    grid = align_bbox(bbox, RESOLUTION_M)
    assert grid.width * grid.height <= MAX_OUTPUT_PIXELS


def test_transform_is_north_up_and_anchored_at_the_grid_corner():
    grid = align_bbox(M1_BBOX, RESOLUTION_M)
    transform = grid.transform
    assert transform.a == RESOLUTION_M
    assert transform.e == -RESOLUTION_M
    assert transform.b == 0.0 and transform.d == 0.0
    assert transform.c == grid.e_min
    assert transform.f == grid.n_max


def test_bounds_round_trip_through_width_and_height():
    grid = align_bbox(M1_BBOX, RESOLUTION_M)
    assert grid.e_min + grid.width * grid.resolution_m == grid.e_max
    assert grid.n_max - grid.height * grid.resolution_m == grid.n_min
