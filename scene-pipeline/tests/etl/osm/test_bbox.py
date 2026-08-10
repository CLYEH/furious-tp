"""Exam: bbox containment and the cross-boundary cutting rule (FTP-29).

Covers AC4 (bbox 裁切:跨界 way 之切斷規則) and the `裁切邊界` half of AC5.

The containment convention is not free choice — `contracts/spec/grid.md`
§邊界歸屬 fixes it as **min-inclusive / max-exclusive** so that a point on a
shared edge belongs to exactly one tile. The M1 bbox is the union of 7×7 such
tiles, so it inherits the same convention; getting it wrong duplicates or drops
geometry at every area seam.

Cut points are snapped to the exact boundary value on the axis being crossed
(the other axis is interpolated). That exactness is what later lets
`contracts/spec/grid.md` §接縫規則 clause 1 hold — boundary vertices shared by
neighbours must agree bit-for-bit, which interpolating both axes cannot promise.
"""

from __future__ import annotations

import json

import pytest

from scene_pipeline.etl.osm import BBox, BBoxError, clip_polyline

from .conftest import M1_E_MAX, M1_E_MIN, M1_N_MAX, M1_N_MIN

# A unit-test box; the rules under test are scale-free.
BOX = BBox(e_min=0.0, n_min=0.0, e_max=100.0, n_max=100.0)


# --- construction / validation ---------------------------------------------


@pytest.mark.parametrize(
    ("e_min", "n_min", "e_max", "n_max"),
    [
        (100.0, 0.0, 100.0, 100.0),  # zero width
        (0.0, 100.0, 100.0, 100.0),  # zero height
        (200.0, 0.0, 100.0, 100.0),  # inverted E
        (0.0, 200.0, 100.0, 100.0),  # inverted N
    ],
)
def test_degenerate_or_inverted_bbox_is_rejected(
    e_min: float, n_min: float, e_max: float, n_max: float
) -> None:
    # WHY: an inverted bbox silently clips everything away, and an empty output
    # looks exactly like "this area has no roads". Fail at construction instead.
    with pytest.raises(BBoxError) as excinfo:
        BBox(e_min=e_min, n_min=n_min, e_max=e_max, n_max=n_max)
    assert "bbox" in str(excinfo.value).lower()


def test_valid_bbox_exposes_its_bounds() -> None:
    assert (BOX.e_min, BOX.n_min, BOX.e_max, BOX.n_max) == (0.0, 0.0, 100.0, 100.0)


# --- containment: min-inclusive / max-exclusive ----------------------------


@pytest.mark.parametrize(
    ("e", "n"),
    [
        (50.0, 50.0),  # interior
        (0.0, 50.0),  # min E edge - inclusive
        (50.0, 0.0),  # min N edge - inclusive
        (0.0, 0.0),  # min corner - inclusive
        (99.999999, 99.999999),  # just inside the max corner
    ],
)
def test_points_inside(e: float, n: float) -> None:
    assert BOX.contains(e, n) is True


@pytest.mark.parametrize(
    ("e", "n"),
    [
        (100.0, 50.0),  # max E edge - EXCLUSIVE
        (50.0, 100.0),  # max N edge - EXCLUSIVE
        (100.0, 100.0),  # max corner - EXCLUSIVE
        (0.0, 100.0),  # min E on the max N edge
        (-0.000001, 50.0),  # just outside min E
        (150.0, 50.0),
        (50.0, -10.0),
    ],
)
def test_points_outside(e: float, n: float) -> None:
    assert BOX.contains(e, n) is False


def test_max_edge_belongs_to_the_neighbour_not_to_us() -> None:
    # The worked example from contracts/spec/grid.md §邊界歸屬, lifted to the M1
    # bbox: (309000, 2771000) is tile (618, 5542)'s, not ours.
    m1 = BBox(e_min=M1_E_MIN, n_min=M1_N_MIN, e_max=M1_E_MAX, n_max=M1_N_MAX)
    assert m1.contains(M1_E_MAX, M1_N_MAX) is False
    assert m1.contains(M1_E_MIN, M1_N_MIN) is True


# --- loading the canonical bbox from contracts ------------------------------


def test_from_area_file_matches_the_contract(m1_area_file) -> None:
    # WHY: the M1 bbox has exactly one canonical home
    # (contracts/constants/m1_area.json). A second copy inside the pipeline
    # would drift, and contracts is merge = finalized — the pipeline follows it.
    bbox = BBox.from_area_file(m1_area_file)
    assert (bbox.e_min, bbox.n_min, bbox.e_max, bbox.n_max) == (
        M1_E_MIN,
        M1_N_MIN,
        M1_E_MAX,
        M1_N_MAX,
    )


def test_from_area_file_rejects_a_missing_file(tmp_path) -> None:
    missing = tmp_path / "nope.json"
    with pytest.raises(BBoxError) as excinfo:
        BBox.from_area_file(missing)
    assert str(missing) in str(excinfo.value)


def test_from_area_file_rejects_malformed_json(tmp_path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(BBoxError) as excinfo:
        BBox.from_area_file(bad)
    assert str(bad) in str(excinfo.value)


@pytest.mark.parametrize("missing_key", ["e_min", "e_max", "n_min", "n_max"])
def test_from_area_file_names_the_missing_key(tmp_path, m1_area_file, missing_key: str) -> None:
    payload = json.loads(m1_area_file.read_text(encoding="utf-8"))
    del payload["bbox"][missing_key]
    partial = tmp_path / "partial.json"
    partial.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(BBoxError) as excinfo:
        BBox.from_area_file(partial)
    assert missing_key in str(excinfo.value)


def test_from_area_file_rejects_a_file_without_a_bbox_block(tmp_path) -> None:
    other = tmp_path / "other.json"
    other.write_text(json.dumps({"crs": "EPSG:3826"}), encoding="utf-8")
    with pytest.raises(BBoxError) as excinfo:
        BBox.from_area_file(other)
    assert "bbox" in str(excinfo.value)


# --- clipping: degenerate inputs -------------------------------------------


@pytest.mark.parametrize("points", [[], [(50.0, 50.0)]])
def test_polyline_shorter_than_a_segment_yields_nothing(points) -> None:
    assert clip_polyline(points, BOX) == []


def test_zero_length_polyline_inside_is_dropped() -> None:
    # WHY: a duplicated node gives a zero-length way. The road compiler derives
    # a direction from each segment, which is a division by zero here.
    assert clip_polyline([(50.0, 50.0), (50.0, 50.0)], BOX) == []


def test_duplicate_consecutive_points_are_collapsed_not_dropped() -> None:
    runs = clip_polyline([(10.0, 10.0), (10.0, 10.0), (20.0, 20.0)], BOX)
    assert len(runs) == 1
    assert runs[0].points == ((10.0, 10.0), (20.0, 20.0))


def test_polyline_entirely_outside_yields_nothing() -> None:
    assert clip_polyline([(150.0, 150.0), (200.0, 200.0)], BOX) == []


def test_polyline_grazing_a_corner_yields_nothing() -> None:
    # Touches (100, 100) only, which is outside by the max-exclusive rule.
    assert clip_polyline([(150.0, 50.0), (50.0, 150.0)], BOX) == []


def test_run_lying_on_the_max_edge_is_dropped() -> None:
    # WHY: the max edge belongs to the neighbouring area. Keeping this run would
    # emit the same road twice — once here, once next door.
    assert clip_polyline([(100.0, 20.0), (100.0, 80.0)], BOX) == []


def test_run_lying_on_the_min_edge_is_kept() -> None:
    # The mirror case: the min edge is ours, so this must NOT be dropped.
    runs = clip_polyline([(0.0, 20.0), (0.0, 80.0)], BOX)
    assert len(runs) == 1
    assert runs[0].points == ((0.0, 20.0), (0.0, 80.0))
    assert runs[0].indices == (0, 1)


# --- clipping: the main rules ----------------------------------------------


def test_polyline_entirely_inside_is_returned_untouched() -> None:
    points = [(10.0, 10.0), (50.0, 20.0), (90.0, 99.0)]
    runs = clip_polyline(points, BOX)
    assert len(runs) == 1
    run = runs[0]
    assert run.points == tuple(points)  # bit-identical: no re-interpolation
    assert run.indices == (0, 1, 2)
    assert (run.cut_start, run.cut_end) == (False, False)


def test_way_leaving_the_box_is_cut_exactly_on_the_crossed_edge() -> None:
    runs = clip_polyline([(50.0, 50.0), (150.0, 90.0)], BOX)
    assert len(runs) == 1
    run = runs[0]
    # t = 0.5 at E = 100 -> N = 50 + 0.5 * 40 = 70. E is exact by snapping.
    assert run.points == ((50.0, 50.0), (100.0, 70.0))
    assert run.points[1][0] == BOX.e_max  # exact, not merely close
    assert run.indices == (0, None)  # None marks a synthetic cut vertex
    assert (run.cut_start, run.cut_end) == (False, True)


def test_way_entering_the_box_is_cut_exactly_on_the_crossed_edge() -> None:
    runs = clip_polyline([(-50.0, 20.0), (50.0, 20.0)], BOX)
    assert len(runs) == 1
    run = runs[0]
    assert run.points == ((0.0, 20.0), (50.0, 20.0))
    assert run.indices == (None, 1)
    assert (run.cut_start, run.cut_end) == (True, False)


def test_way_crossing_straight_through_keeps_only_the_inside_part() -> None:
    # Both endpoints outside, yet the segment crosses the whole box: dropping it
    # would erase a road that visibly runs through the area.
    runs = clip_polyline([(-50.0, 50.0), (150.0, 50.0)], BOX)
    assert len(runs) == 1
    run = runs[0]
    assert run.points == ((0.0, 50.0), (100.0, 50.0))
    assert run.indices == (None, None)
    assert (run.cut_start, run.cut_end) == (True, True)


def test_vertex_exactly_on_the_min_edge_stays_an_original_vertex() -> None:
    runs = clip_polyline([(0.0, 50.0), (50.0, 50.0)], BOX)
    assert len(runs) == 1
    assert runs[0].points == ((0.0, 50.0), (50.0, 50.0))
    assert runs[0].indices == (0, 1)  # kept its identity: it is inside


def test_vertex_exactly_on_the_max_edge_becomes_a_cut_vertex() -> None:
    # Same coordinate either way, but the identity differs: the max edge is not
    # ours, so this is a boundary cut (index None), not one of our nodes. That
    # distinction is what keeps it out of the dangling-node QA report.
    runs = clip_polyline([(50.0, 50.0), (100.0, 50.0)], BOX)
    assert len(runs) == 1
    assert runs[0].points == ((50.0, 50.0), (100.0, 50.0))
    assert runs[0].indices == (0, None)
    assert runs[0].cut_end is True


def test_way_re_entering_the_box_is_split_into_separate_runs() -> None:
    # WHY: a way that leaves and comes back is two separate pieces of road in
    # this area. Joining them would invent a straight-line shortcut across the
    # outside; keeping only the first would delete real road.
    points = [(-10.0, 50.0), (50.0, 50.0), (150.0, 50.0), (150.0, 10.0), (50.0, 10.0)]
    runs = clip_polyline(points, BOX)
    assert len(runs) == 2
    first, second = runs
    assert first.points == ((0.0, 50.0), (50.0, 50.0), (100.0, 50.0))
    assert first.indices == (None, 1, None)
    assert (first.cut_start, first.cut_end) == (True, True)
    assert second.points == ((100.0, 10.0), (50.0, 10.0))
    assert second.indices == (None, 4)
    assert (second.cut_start, second.cut_end) == (True, False)


def test_cut_on_the_n_axis_snaps_that_axis() -> None:
    runs = clip_polyline([(20.0, 50.0), (60.0, 150.0)], BOX)
    assert len(runs) == 1
    # t = 0.5 at N = 100 -> E = 20 + 0.5 * 40 = 40.
    assert runs[0].points == ((20.0, 50.0), (40.0, 100.0))
    assert runs[0].points[1][1] == BOX.n_max  # exact on the crossed axis


def test_many_crossings_are_all_preserved() -> None:
    # Oversized input: 100 excursions in and out. Nothing may be silently
    # coalesced or truncated.
    points: list[tuple[float, float]] = []
    for k in range(100):
        points.append((50.0, float(k)))
        points.append((150.0, float(k)))
    runs = clip_polyline(points, BOX)
    assert len(runs) == 100
    for run in runs:
        assert len(run.points) >= 2
        for e, n in run.points:
            assert BOX.e_min <= e <= BOX.e_max
            assert BOX.n_min <= n <= BOX.n_max


def test_clipping_does_not_mutate_the_input() -> None:
    points = [(-10.0, 50.0), (50.0, 50.0)]
    snapshot = list(points)
    clip_polyline(points, BOX)
    assert points == snapshot
