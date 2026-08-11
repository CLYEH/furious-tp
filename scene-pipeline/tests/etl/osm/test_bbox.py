"""Exam: bbox containment and the cross-boundary cutting rule (FTP-29).

Covers AC4 (bbox 裁切:跨界 way 之切斷規則) and the `裁切邊界` half of AC5.

The containment convention is not free choice — `contracts/spec/grid.md`
§邊界歸屬 fixes it as **min-inclusive / max-exclusive** so that a point on a
shared edge belongs to exactly one tile. The M1 bbox is the union of 7×7 such
tiles, so it inherits the same convention; getting it wrong duplicates or drops
geometry at every area seam.

Cut points are snapped to the exact boundary value on the axis being crossed
(the other axis is interpolated). That exactness is **not** what makes two
neighbours agree with each other — they do that for free, whether or not the
snap is there (Layer 2 review, round 2, S5; the reason previously written here
was measured and found false). It is what makes the cut equal the boundary
*constant*, which is what `BBox.contains` compares against and what the tile
stage quantises on. `test_every_edge_pins_its_own_axis_exactly` carries the
measurements.
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
    # The collapse also decides WHOSE identity survives, and this assertion is
    # the only thing that says so: of two coincident real vertices the FIRST
    # one is kept (README rule 7). Asserting the points alone let a mutant that
    # keeps the second one through, which silently renames the node the D10
    # conflation stage will try to match on.
    assert runs[0].indices == (0, 2)


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


def test_cut_is_snapped_not_merely_interpolated() -> None:
    # Added after mutation testing: removing the snap from `_snap` survived the
    # rest of this exam, because for Taipei-scale segments `p + ((h-p)/d)*d`
    # happens to return exactly `h` in double precision — the two implementations
    # are indistinguishable on realistic data, so every other case here passed.
    #
    # These absurd coordinates are a *witness*: a span of ~2.2e7 m where naive
    # interpolation lands on 307500.00000000093 instead of 307500.0. The
    # guarantee has to be unconditional rather than usually-true, because the
    # same clipper is reused at 500 m tile granularity by the tile tickets and
    # the value they key on is the boundary constant. It is NOT about clause 1 —
    # neighbours agree with each other for free; see
    # `test_every_edge_pins_its_own_axis_exactly` for the measurement.
    bbox = BBox(e_min=307000.0, n_min=2769000.0, e_max=307500.0, n_max=2770000.0)
    p = (-5495889.486020419, 2769600.0)
    q = (16578436.147616692, 2769600.0)

    dx = q[0] - p[0]
    naive = p[0] + ((bbox.e_max - p[0]) / dx) * dx
    assert naive != bbox.e_max  # the witness really does distinguish the two

    runs = clip_polyline([p, q], bbox)
    assert len(runs) == 1
    assert runs[0].points[-1][0] == bbox.e_max  # exact, by snapping
    assert runs[0].points[0][0] == bbox.e_min


@pytest.mark.parametrize(
    ("edge", "p", "q", "axis", "naive"),
    [
        # Each polyline is a witness for exactly ONE edge: the naive value below
        # is what `p + t * d` returns for that crossing, and it is exact on the
        # other three. So one case per edge is the minimum, not padding.
        (
            "e_min",
            (-24500933.51382203, 2769600.0),
            (20284809.476359554, 2769600.0),
            0,
            307000.0000000037,
        ),
        (
            "n_min",
            (307200.0, -22038933.51382203),
            (307200.0, 22746809.476359554),
            1,
            2769000.0000000037,
        ),
        (
            "n_max",
            (307200.0, -22037933.51382203),
            (307200.0, 22747809.476359554),
            1,
            2770000.0000000037,
        ),
    ],
)
def test_every_edge_pins_its_own_axis_exactly(edge, p, q, axis, naive) -> None:
    # Found by a third mutation pass. `test_cut_is_snapped_not_merely_
    # interpolated` above is a witness for ONE of the four pins — e_max — and
    # deleting any of the other three left the whole exam green, because on
    # every other input in it `p + t * d` happens to land on the boundary
    # constant anyway. "The crossed axis is exact" was therefore proven for a
    # quarter of the rule.
    #
    # Each case below is the same idea aimed at a different edge: a span wide
    # enough that the division and the multiplication do not cancel, so the
    # naive value misses the constant by ~4e-9 m.
    #
    # WHY that matters — corrected in round 3, because the reason this exam gave
    # before was false (Layer 2 review, round 2, S5). It is NOT clause 1 of
    # grid.md §接縫規則. Two neighbours agree with each other for free: they
    # compute the same crossing from exactly negated operands, and IEEE 754
    # returns the same quotient for `(-a)/(-b)` as for `a/b`. Measured over
    # 800,000 crossings in four magnitude bands (origin, M1, 1e10, 1e16): zero
    # differences in `t` and zero in the shared vertex, snap or no snap.
    #
    # It matters because the cut has to equal the boundary CONSTANT. That is the
    # value `BBox.contains` compares against and the value the tile stage
    # quantises and indexes on, and missing it is not merely cosmetic: measured
    # at M1 scale over 200,000 wide crossings per edge, plain interpolation
    # misses the constant 17,627 times, of which 8,675 land strictly BELOW
    # `e_min` — outside the very box the clipper had just assigned them to —
    # and 8,952 land strictly above `e_max`.
    bbox = BBox(e_min=307000.0, n_min=2769000.0, e_max=307500.0, n_max=2770000.0)
    boundary = getattr(bbox, edge)

    assert naive != boundary  # the witness really does distinguish the two

    runs = clip_polyline([p, q], bbox)
    assert len(runs) == 1
    values = {point[axis] for point in runs[0].points}
    assert boundary in values, f"{edge} was interpolated, not pinned"
    assert naive not in values


def test_uncut_endpoint_is_handed_back_verbatim_not_recomputed() -> None:
    # The sibling of the case above, found by a second mutation pass: deleting
    # the `t == 1.0 -> return q` passthrough in `_snap` also survived the exam,
    # for the same reason — on Taipei-scale segments `p + 1.0 * (q - p)` returns
    # `q` exactly, so recomputing an endpoint that was never cut is invisible.
    #
    # Witness: with p far enough away that `q - p` cannot be represented
    # exactly, the round trip lands a whole metre off. The endpoint that was
    # NOT clipped must come back bit-for-bit, because it is an interior vertex
    # of the road: it also appears as the start of the next segment, and the two
    # copies have to compare equal or `_finish` stops collapsing them and the
    # node is emitted twice.
    bbox = BBox(e_min=307000.0, n_min=2769000.0, e_max=307500.0, n_max=2770000.0)
    p = (1e16, 2769600.0)  # absurdly far east; only the entry gets cut
    q = (307201.0, 2769600.0)  # inside, and an odd metre: the parity is the point

    naive = p[0] + 1.0 * (q[0] - p[0])
    assert naive == 307200.0  # the witness really does distinguish the two
    assert naive != q[0]

    runs = clip_polyline([p, q], bbox)
    assert len(runs) == 1
    assert runs[0].points == ((bbox.e_max, 2769600.0), q)  # q verbatim
    assert runs[0].indices == (None, 1)


def test_vertex_starting_on_the_max_edge_is_a_cut_not_an_original_vertex() -> None:
    # Mirror of test_vertex_exactly_on_the_max_edge_becomes_a_cut_vertex, which
    # only covered the max-edge vertex as a segment END. A mutant that decides
    # the run's identity from `t0 == 0.0` alone — dropping the containment
    # check — survived that test but is wrong here: the max edge is not ours, so
    # a way beginning exactly on it begins with a boundary cut. Getting this
    # wrong hands the node a real id, and it then shows up in the dangling-node
    # QA report as if the source data had a dead end there.
    runs = clip_polyline([(100.0, 50.0), (50.0, 50.0)], BOX)
    assert len(runs) == 1
    assert runs[0].points == ((100.0, 50.0), (50.0, 50.0))
    assert runs[0].indices == (None, 1)
    assert runs[0].cut_start is True


# --- the endpoint-identity family ------------------------------------------
#
# Four README rules meet on the vertices below and nothing used to exercise the
# meeting point (Layer 2 review, round 1, B1):
#
#   rule 1 — containment is min-INCLUSIVE, so a vertex on the min edge is ours;
#   rule 4 — a synthetic cut vertex gets a NEGATIVE id flagged boundary=true;
#   rule 6 — coincident vertices are collapsed to one;
#   rule 7 — and the collapse decides WHOSE identity survives.
#
# When a way arrives from outside and its first real vertex sits exactly on the
# min edge, the cut point computed for the previous segment lands on that same
# coordinate — so rule 6 fires, and rule 7 alone decides whether what survives
# is the real vertex or the synthetic one. `_place` branches on exactly that:
# `index is None` becomes a negative boundary id, anything else keeps the OSM
# id. Losing the promotion therefore does not move the geometry by a
# millimetre; it swaps a real OSM node for a synthetic one, which D10
# conflation (it matches on OSM ids) can no longer see and which
# `qa.dangling_node_ids` stops considering.
#
# Rare on today's raw OSM input, routine once this same clipper is re-run at
# 500 m granularity over already-clipped geometry — which is the argument this
# ticket itself uses for why the family matters.


def test_vertex_on_the_min_edge_keeps_its_identity_when_it_coincides_with_the_cut() -> None:
    # Enters from the west; vertex 1 sits exactly on the min E edge, which is
    # ours, so it must come back as vertex 1 and not as a boundary cut.
    runs = clip_polyline([(-50.0, 50.0), (0.0, 50.0), (50.0, 50.0)], BOX)
    assert len(runs) == 1
    run = runs[0]
    assert run.points == ((0.0, 50.0), (50.0, 50.0))
    assert run.indices == (1, 2)  # NOT (None, 2): the real node keeps its id
    assert run.cut_start is False  # so the piece is not marked as cut here


def test_vertex_on_the_min_edge_keeps_its_identity_when_the_way_leaves() -> None:
    # The mirror direction. Here the collapse sees a REAL index first and a
    # synthetic one second, so the promotion must NOT fire; a mutant that
    # assigns unconditionally destroys the identity in this direction instead.
    runs = clip_polyline([(50.0, 50.0), (0.0, 50.0), (-50.0, 50.0)], BOX)
    assert len(runs) == 1
    run = runs[0]
    assert run.points == ((50.0, 50.0), (0.0, 50.0))
    assert run.indices == (0, 1)
    assert run.cut_end is False


def test_vertex_on_the_min_corner_keeps_its_identity_when_it_coincides_with_the_cut() -> None:
    # The two-axis version: at the corner both edges are crossed at the same t,
    # so the cut point is pinned on one axis and interpolated on the other, and
    # it still has to compare equal to the real vertex for the collapse to fire.
    runs = clip_polyline([(-50.0, -50.0), (0.0, 0.0), (50.0, 50.0)], BOX)
    assert len(runs) == 1
    assert runs[0].points == ((0.0, 0.0), (50.0, 50.0))
    assert runs[0].indices == (1, 2)


def test_two_coincident_vertices_on_the_min_edge_keep_the_first_identity() -> None:
    # Cut point, then TWO real vertices at the same coordinate. The promotion
    # must fire once (synthetic -> first real vertex) and then stop, rather than
    # walking forward to the last duplicate.
    runs = clip_polyline([(-50.0, 50.0), (0.0, 50.0), (0.0, 50.0), (50.0, 50.0)], BOX)
    assert len(runs) == 1
    assert runs[0].points == ((0.0, 50.0), (50.0, 50.0))
    assert runs[0].indices == (1, 3)


def test_vertex_on_the_max_edge_stays_synthetic_when_it_coincides_with_the_cut() -> None:
    # The guard on the case above: the same geometry against the MAX edge must
    # NOT promote, because that edge belongs to the neighbouring area. A fix
    # for the min-edge case that promoted unconditionally would hand a real OSM
    # id to a node this area does not own, and both areas would then claim it.
    runs = clip_polyline([(50.0, 50.0), (100.0, 50.0), (150.0, 50.0)], BOX)
    assert len(runs) == 1
    assert runs[0].points == ((50.0, 50.0), (100.0, 50.0))
    assert runs[0].indices == (0, None)
    assert runs[0].cut_end is True


def test_uncut_endpoint_on_a_boundary_edge_is_still_handed_back_verbatim() -> None:
    # Layer 2 review, round 1, S1. `_snap` hands an untouched endpoint back
    # bit-for-bit only while `edge` is None — and `_clip_segment` sets `edge1`
    # from `if t < t1`, which is false at t == t1 == 1.0. Loosen that one
    # character to `<=` and the endpoint stops being untouched: the crossed
    # axis is pinned (to the value it already had) and the OTHER axis is
    # interpolated instead of returned.
    #
    # The witness below is the whole point: the vertex sits exactly on the min E
    # seam, so it is both a real node of ours (min-inclusive) and a point the
    # neighbouring area must reproduce bit-for-bit (grid.md §接縫規則 clause 1).
    # Interpolating its northing moves it a full metre.
    bbox = BBox(e_min=307000.0, n_min=2769000.0, e_max=307500.0, n_max=2770000.0)
    p = (1e16, 1e16)  # absurdly far away, so `q - p` cannot be represented
    q = (307000.0, 2769601.0)  # exactly on the min E edge, an odd metre north

    assert p[1] + 1.0 * (q[1] - p[1]) == 2769600.0  # the witness distinguishes them
    assert q[1] == 2769601.0

    runs = clip_polyline([p, q], bbox)
    assert len(runs) == 1
    run = runs[0]
    assert run.points[-1] == q  # verbatim, both components
    assert run.points[-1][1] == 2769601.0  # not 2769600.0
    assert run.indices == (None, 1)  # and it is still one of our nodes


@pytest.mark.xfail(
    strict=False,
    reason=(
        "KNOWN GAP, found by differential fuzzing in round 2 and deliberately "
        "NOT fixed here — the fix changes clipping semantics, which is a "
        "reviewer decision, not a worker one. Recorded as a failing case rather "
        "than only as a review comment so it cannot be lost. Remove the marker "
        "with the fix."
    ),
)
def test_a_way_that_only_touches_a_corner_from_outside_yields_nothing() -> None:
    # Every point of this polyline is outside the area: it starts on the
    # min-E/max-N corner (outside, because the max edge is not ours), runs
    # south-west — where E is immediately negative — and comes back. There is no
    # road here for us to emit.
    #
    # HEAD emits a 2.8e-14 m run of TWO synthetic boundary nodes. `_snap` pins
    # the crossed axis and interpolates the other, and at this particular slope
    # the two axes' t values round apart just far enough that the segment
    # appears to dip 3e-14 m inside, which is enough for the midpoint check in
    # `_finish` to keep it.
    #
    # Why it is worth recording rather than shrugging at: the trigger is a
    # vertex sitting EXACTLY on a grid corner. Projected OSM nodes never do
    # that — but the output of this very clipper does, on every boundary cut,
    # which is precisely the input the 500 m re-clip will be handed. The cost is
    # a spurious one-segment component in a QA block whose whole job is to say
    # whether the network is connected.
    bbox = BBox(e_min=0.0, n_min=0.0, e_max=100.0, n_max=100.0)
    corner = (0.0, 100.0)
    outside = (-172.02840816546544, -162.11734482294904)
    assert bbox.contains(*corner) is False
    assert bbox.contains(*outside) is False

    assert clip_polyline([corner, outside], bbox) == []  # holds today
    assert clip_polyline([corner, outside, corner], bbox) == []  # does not


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
