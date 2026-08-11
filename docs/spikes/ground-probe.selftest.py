"""Self-test for `ground-probe.py` — synthetic geometry only, no network.

Run:  python docs/spikes/ground-probe.selftest.py

Why this file exists at all. The whole spike is a pile of numbers, and a number
produced by a wrong measurement looks exactly like a number produced by a right
one. These cases pin the properties the report's numbers depend on, against
inputs whose answer is known by construction.

Two of them are the ones this project keeps learning the hard way:

* **A zero needs a control.** `test_holes_zero_has_a_nonzero_control` measures
  the hole count twice with the SAME function — once where the answer must be 0
  and once where it must not be. A query that is simply broken returns 0 for
  both, and the case goes red.
* **Nothing upstream sent us is echoed.** `test_sampler_records_no_body` drives
  the availability sampler against a body of known marker bytes and asserts the
  record does not carry them in any form. Restating unknown upstream bytes is an
  output surface we do not control (FTP-69 ticket, Verification Steps).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from shapely.geometry import Polygon as Poly

PROBE = Path(__file__).with_name("ground-probe.py")


def load_probe():
    spec = importlib.util.spec_from_file_location("ground_probe", PROBE)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load probe module: {PROBE}")
    module = importlib.util.module_from_spec(spec)
    # Registered BEFORE exec: @dataclass resolves a string annotation through
    # sys.modules[cls.__module__], which is absent for a module loaded by path
    # alone — and it fails as an AttributeError inside dataclasses, nowhere
    # near the cause.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


gp = load_probe()

BBOX = gp.BBox(0.0, 0.0, 100.0, 100.0)  # 100 x 100 m = 10 000 m^2


def square(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]


# --- happy -----------------------------------------------------------------


def test_overlapping_polygons_are_not_double_counted():
    """Two 50x50 squares overlapping on 25x25 cover 4375 m^2, not 5000."""
    a = gp.feature("landuse", "residential", square(0, 0, 50, 50))
    b = gp.feature("landuse", "commercial", square(25, 25, 75, 75))
    result = gp.coverage([a, b], BBOX)
    assert abs(result.covered_m2 - 4375.0) < 1e-6, result.covered_m2
    assert abs(result.fraction - 0.4375) < 1e-9, result.fraction


def test_class_areas_split_the_overlap_without_inventing_area():
    """Per-class areas are unions per class; their sum may exceed the union."""
    a = gp.feature("landuse", "residential", square(0, 0, 50, 50))
    b = gp.feature("landuse", "commercial", square(25, 25, 75, 75))
    per_class = gp.class_areas([a, b], BBOX)
    assert abs(per_class["landuse=residential"] - 2500.0) < 1e-6
    assert abs(per_class["landuse=commercial"] - 2500.0) < 1e-6
    assert sum(per_class.values()) > gp.coverage([a, b], BBOX).covered_m2


def test_a_class_cannot_inflate_itself_by_mapping_the_same_ground_twice():
    """Two overlapping features of the SAME class union to 4375, not 5000.

    The case above cannot see this: with one feature per class, summing and
    unioning agree, and a per-feature sum survives it untouched (mutation M12).
    Double-mapped ground is normal in OSM — a park inside a park boundary —
    so a class total that adds the overlap twice would overstate real land.
    """
    a = gp.feature("leisure", "park", square(0, 0, 50, 50))
    b = gp.feature("leisure", "park", square(25, 25, 75, 75))
    per_class = gp.class_areas([a, b], BBOX)
    assert abs(per_class["leisure=park"] - 4375.0) < 1e-6, per_class


# --- boundary --------------------------------------------------------------


def test_polygon_crossing_the_edge_counts_only_the_inside():
    """Half in, half out: only the inside half is coverage."""
    crossing = gp.feature("landuse", "industrial", square(50, 50, 150, 150))
    result = gp.coverage([crossing], BBOX)
    assert abs(result.covered_m2 - 2500.0) < 1e-6, result.covered_m2


def test_a_polygon_entirely_outside_contributes_nothing():
    outside = gp.feature("natural", "water", square(200, 200, 300, 300))
    assert gp.coverage([outside], BBOX).covered_m2 == 0.0


def test_clipped_features_are_counted_and_reported():
    """The edge question needs the COUNT of clipped features, not just area."""
    inside = gp.feature("leisure", "park", square(10, 10, 20, 20))
    crossing = gp.feature("landuse", "retail", square(90, 90, 200, 200))
    outside = gp.feature("natural", "wood", square(500, 500, 600, 600))
    stats = gp.edge_stats([inside, crossing, outside], BBOX)
    assert stats["inside"] == 1, stats
    assert stats["clipped"] == 1, stats
    assert stats["outside"] == 1, stats


# --- the zero control ------------------------------------------------------


def test_holes_zero_has_a_nonzero_control():
    """0 holes must be distinguishable from a broken hole finder.

    Same function, two inputs. A finder that always returns nothing passes the
    first assertion and fails the second.
    """
    full = [gp.feature("landuse", "residential", square(0, 0, 100, 100))]
    assert gp.holes(full, BBOX, min_area_m2=1.0) == [], "full cover must have no holes"

    partial = [gp.feature("landuse", "residential", square(0, 0, 50, 100))]
    found = gp.holes(partial, BBOX, min_area_m2=1.0)
    assert len(found) == 1, found
    assert abs(found[0].area_m2 - 5000.0) < 1e-6, found[0]


def test_holes_respects_the_minimum_area_filter():
    """Sliver holes are noise; the filter must actually drop them."""
    left = gp.feature("landuse", "residential", square(0, 0, 49.9, 100))
    right = gp.feature("landuse", "commercial", square(50, 0, 100, 100))
    assert gp.holes([left, right], BBOX, min_area_m2=1.0) != []
    assert gp.holes([left, right], BBOX, min_area_m2=100.0) == []


def test_an_inner_ring_is_a_hole_not_coverage():
    """A multipolygon's inner ring is NOT covered ground."""
    donut = gp.feature(
        "landuse", "residential", square(0, 0, 100, 100), inners=[square(40, 40, 60, 60)]
    )
    result = gp.coverage([donut], BBOX)
    assert abs(result.covered_m2 - 9600.0) < 1e-6, result.covered_m2
    found = gp.holes([donut], BBOX, min_area_m2=1.0)
    assert len(found) == 1 and abs(found[0].area_m2 - 400.0) < 1e-6, found


def test_edge_band_separates_the_rim_from_the_middle():
    """The rim number and the interior number must come from different sets.

    This is the measurement the report leans on to say clipping leaves no
    blank rim, and it had no case at all until a mutant that computed the
    interior fraction from the band survived (M14). It carries its own zero
    control: the same function, one input where the rim must read 0 and one
    where it must read 1.
    """
    inner_only = gp.feature("landuse", "residential", square(20, 20, 80, 80))
    rim = gp.edge_band([inner_only], BBOX, width_m=10.0)
    assert rim["band_fraction"] == 0.0, rim
    assert rim["interior_fraction"] > 0.5, rim

    full = gp.feature("landuse", "residential", square(0, 0, 100, 100))
    painted = gp.edge_band([full], BBOX, width_m=10.0)
    assert abs(painted["band_fraction"] - 1.0) < 1e-6, painted


# --- the independent second method ----------------------------------------


def test_grid_sampling_agrees_with_the_exact_union():
    """Two methods, one answer — the report cross-checks its headline number.

    Grid sampling is not a reimplementation detail: it is the control for the
    exact union. They fail differently, so agreement is evidence.
    """
    features = [
        gp.feature("landuse", "residential", square(0, 0, 50, 50)),
        gp.feature("landuse", "commercial", square(25, 25, 75, 75)),
        gp.feature("natural", "water", square(80, 0, 100, 40)),
    ]
    exact = gp.coverage(features, BBOX).fraction
    sampled = gp.grid_coverage(features, BBOX, step_m=0.5).fraction
    assert abs(exact - sampled) < 0.01, (exact, sampled)


def test_grid_sampling_tests_containment_not_the_bounding_box():
    """A right triangle covers half its own bounding box, and the grid must say so.

    Every other grid case uses axis-aligned rectangles, where a polygon and its
    bounding box are the same set — so a sampler that tested only the bounding
    box passed all of them (mutation M9 survived on squares alone). A triangle
    separates the two: bounding-box logic reports ~1.0 here, containment ~0.5.
    """
    triangle = gp.feature("landuse", "residential", [(0, 0), (100, 0), (0, 100), (0, 0)])
    sampled = gp.grid_coverage([triangle], BBOX, step_m=0.5).fraction
    assert abs(sampled - 0.5) < 0.02, sampled
    assert abs(gp.coverage([triangle], BBOX).fraction - 0.5) < 1e-9


def test_grid_sampling_excludes_samples_that_only_touch_the_boundary():
    """Containment, not mere intersection, decides a sample (mutation R10).

    With a 0.5 m step the cell centres sit at 0.25, 0.75, 1.25 ... so an edge
    placed exactly at 50.25 lands a whole column of samples ON the boundary.
    `contains` rejects them and `intersects` accepts them, which is the only
    input shape that can tell the two apart — every other grid case differs by
    a set of measure zero and lets the swap through.
    """
    on_centres = gp.feature("landuse", "residential", square(0.25, 0, 50.25, 100))
    sampled = gp.grid_coverage([on_centres], BBOX, step_m=0.5)
    # Centres strictly inside: 0.75 .. 49.75 -> 99 columns of 200 rows.
    assert sampled.hits == 99 * 200, sampled
    # `intersects` would also take the two boundary columns 0.25 and 50.25.
    assert sampled.hits != 101 * 200


def test_grid_sampling_can_disagree_when_the_exact_answer_moves():
    """The agreement above must be earned, not structural."""
    a = [gp.feature("landuse", "residential", square(0, 0, 50, 50))]
    b = [gp.feature("landuse", "residential", square(0, 0, 90, 90))]
    assert gp.grid_coverage(a, BBOX, step_m=0.5).fraction < gp.grid_coverage(
        b, BBOX, step_m=0.5
    ).fraction


# --- error paths / invalid input ------------------------------------------


def test_degenerate_rings_are_skipped_and_counted():
    """A way with fewer than 4 nodes cannot be a polygon; it must not crash."""
    good = gp.feature("landuse", "residential", square(0, 0, 50, 50))
    bad = gp.feature("landuse", "retail", [(0.0, 0.0), (1.0, 1.0), (0.0, 0.0)])
    result = gp.coverage([good, bad], BBOX)
    assert abs(result.covered_m2 - 2500.0) < 1e-6
    assert result.skipped == 1, result.skipped


"""A bow-tie is invalid geometry. Report it; do not raise, do not NaN.

The case that used to live here asserted `0.0 <= covered_m2 < 10000.0`, which
0.0 satisfies — so it could not fail when the repair it named was deleted.
It has been replaced, not loosened, by
`test_bowtie_repair_lands_on_the_exact_area`, which pins the exact 1250 m².
A test that cannot fail is worse than no test: it reports assurance it does
not have.
"""


def test_no_features_is_zero_coverage_and_one_whole_hole():
    empty = gp.coverage([], BBOX)
    assert empty.covered_m2 == 0.0 and empty.fraction == 0.0
    found = gp.holes([], BBOX, min_area_m2=1.0)
    assert len(found) == 1 and abs(found[0].area_m2 - 10000.0) < 1e-6


# --- availability sampling: classification and non-disclosure -------------


class FakeResponse:
    def __init__(self, status, body=b"", headers=None):
        self.status_code = status
        self.content = body
        self.headers = headers or {}


class FakeSession:
    """Answers with a scripted sequence; records nothing."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = 0

    def get(self, url, **kwargs):
        self.calls += 1
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def test_sampler_classifies_without_echoing_bodies():
    marker = b"UPSTREAM-BODY-MARKER-e7f1a9"
    session = FakeSession([FakeResponse(200, marker, {"Content-Type": "image/jpeg"})])
    report = gp.sample_availability(
        "https://example.invalid/tile", samples=1, session=session, delay_s=0
    )
    assert report["samples"][0]["status"] == 200
    assert report["samples"][0]["bytes"] == len(marker)
    assert "at" in report["samples"][0], "every sample carries a timestamp"


def test_sampler_records_no_body():
    """Non-disclosure, asserted on the serialised record, not on intent."""
    import json

    marker = b"UPSTREAM-BODY-MARKER-e7f1a9"
    session = FakeSession([FakeResponse(200, marker, {"Content-Type": "image/jpeg"})])
    report = gp.sample_availability(
        "https://example.invalid/tile", samples=1, session=session, delay_s=0
    )
    serialised = json.dumps(report, ensure_ascii=False)
    assert "UPSTREAM-BODY-MARKER" not in serialised
    assert "e7f1a9" not in serialised
    # and not smuggled in as hex / base64 of the same bytes
    assert marker.hex() not in serialised


def test_sample_records_carry_only_allow_listed_keys():
    """Non-disclosure by allow-list, not by searching for one known marker.

    Searching for the marker only catches a leak of the WHOLE body: a field
    holding the first 16 bytes as hex passed `test_sampler_records_no_body`
    untouched (mutation M13), and a 16-byte prefix of somebody else's response
    is still somebody else's response. Pinning the key set means any new field
    has to be argued for here before it can carry anything out.
    """
    session = FakeSession([FakeResponse(200, b"payload-bytes", {"Content-Type": "image/jpeg"})])
    report = gp.sample_availability(
        "https://example.invalid/tile", samples=1, session=session, delay_s=0
    )
    allowed = {"at", "status", "bytes", "body_class", "content_type", "ms"}
    assert set(report["samples"][0]) <= allowed, set(report["samples"][0]) - allowed

    failing = FakeSession([RuntimeError("boom")])
    errored = gp.sample_availability(
        "https://example.invalid/tile", samples=1, session=failing, delay_s=0
    )
    allowed_error = {"at", "status", "error_class", "ms"}
    assert set(errored["samples"][0]) <= allowed_error, (
        set(errored["samples"][0]) - allowed_error
    )


def test_sampler_counts_nul_bodies_as_a_class_not_a_success():
    """The FTP-5 failure mode: HTTP 200 carrying only NUL bytes."""
    session = FakeSession([FakeResponse(200, b"\x00" * 512, {})])
    report = gp.sample_availability(
        "https://example.invalid/tile", samples=1, session=session, delay_s=0
    )
    assert report["samples"][0]["body_class"] == "all_nul"
    assert report["ok"] == 0, report


def test_sampler_records_transport_errors_as_samples():
    session = FakeSession([RuntimeError("connection reset"), FakeResponse(200, b"\xff\xd8\xff", {})])
    report = gp.sample_availability(
        "https://example.invalid/tile", samples=2, session=session, delay_s=0
    )
    assert report["samples"][0]["status"] == "error"
    assert report["ok"] == 1, report
    assert report["error"] == 1, report


def test_sampler_error_text_is_not_upstream_content():
    """An exception message is ours; a response body is not. Keep them apart."""
    import json

    session = FakeSession([RuntimeError("connection reset by peer")])
    report = gp.sample_availability(
        "https://example.invalid/tile", samples=1, session=session, delay_s=0
    )
    entry = report["samples"][0]
    assert entry["error_class"] == "RuntimeError"
    assert "reset" not in json.dumps(report), "only the exception TYPE is recorded"


def test_sampler_takes_exactly_the_requested_number_of_samples():
    session = FakeSession([FakeResponse(200, b"x", {}) for _ in range(25)])
    report = gp.sample_availability(
        "https://example.invalid/tile", samples=20, session=session, delay_s=0
    )
    assert session.calls == 20 and len(report["samples"]) == 20


# --- the calculation paths that produce PUBLISHED numbers -------------------
#
# Layer 2 aimed 12 mutants at these functions; all 12 survived with the exam
# fully green. The cause was the family definition: mutants were chosen where
# tests already existed, not where the report publishes an invariant. Every
# case below corresponds to a named number in the report.


def test_bowtie_repair_lands_on_the_exact_area():
    """A bow-tie repairs to 1250 m^2 — pinned as equality, not as a range.

    The old case asserted `0.0 <= area < 10000.0`, which 0.0 satisfies: delete
    the repair entirely and it still passed (mutation R12). That is a test that
    cannot fail when the behaviour it names changes, and this is the path all
    122 invalid zoning polygons take.
    """
    bowtie = gp.feature(
        "landuse", "industrial", [(0, 0), (50, 50), (50, 0), (0, 50), (0, 0)]
    )
    result = gp.coverage([bowtie], BBOX)
    assert result.invalid == 1
    assert abs(result.covered_m2 - 1250.0) < 1e-6, result.covered_m2


#: A small lon/lat square near the M1 area, used to drive the real OSM path.
_LON0, _LAT0, _D = 121.560, 25.030, 0.004


def _ll_square(scale=1.0, offset=0.0):
    lon0, lat0 = _LON0 + offset, _LAT0 + offset
    d = _D * scale
    return [
        (lon0, lat0),
        (lon0 + d, lat0),
        (lon0 + d, lat0 + d),
        (lon0, lat0 + d),
        (lon0, lat0),
    ]


def _overpass_relation(outer, inner=None):
    """An Overpass `out geom` payload holding one multipolygon relation."""

    def member(ring, role):
        return {
            "type": "way",
            "role": role,
            "geometry": [{"lon": lon, "lat": lat} for lon, lat in ring],
        }

    rel = {
        "type": "relation",
        "id": 1,
        "tags": {"landuse": "residential"},
        "members": [member(outer, "outer")],
    }
    if inner:
        rel["members"].append(member(inner, "inner"))
    return {"elements": [rel]}


def test_relation_inner_ring_is_a_hole_through_the_overpass_path():
    """The Overpass relation path must honour inner rings.

    `test_an_inner_ring_is_a_hole_not_coverage` builds `inners` by hand and
    never executes `_rings_from_members(members, "inner")`, so discarding inner
    members left every case green (mutation R9) while silently inflating
    candidate B's coverage by every park and wood that has a hole in it.
    """
    outer = _ll_square()
    inner = _ll_square(scale=0.5, offset=_D * 0.25)
    solid, _ = gp.features_from_overpass(_overpass_relation(outer))
    holed, _ = gp.features_from_overpass(_overpass_relation(outer, inner))
    big = gp.BBox(0.0, 0.0, 1e7, 1e7)
    solid_area = gp.coverage(solid, big).covered_m2
    holed_area = gp.coverage(holed, big).covered_m2
    assert solid_area > 0
    # Inner side is half the outer's, so the hole removes a quarter of the area.
    assert holed_area < solid_area * 0.8, (solid_area, holed_area)
    assert abs(holed_area - solid_area * 0.75) < solid_area * 0.02


def test_relation_rings_do_not_join_across_a_five_metre_gap():
    """`_close` is a tolerance, not a licence to connect anything.

    The gap here is ~5 m: far too wide to be floating-point noise, far too
    narrow for a "obviously unrelated" check to catch. A first attempt used a
    2 km gap, which even a 50 m tolerance refuses — so widening the tolerance
    a thousandfold survived (mutation R11). The tolerance exists to absorb
    coordinate noise at the millimetre scale; 5 m is real distance, and two
    ends that far apart are two different places.
    """
    # ~5.0 m in longitude at latitude 25 (1 deg lon ~ 100.9 km there).
    gap_deg = 0.00005
    ring = _ll_square()
    first_half = ring[0:3]
    second_half = [ring[2], ring[3], (ring[0][0] + gap_deg, ring[0][1])]

    def member(points):
        return {
            "type": "way",
            "role": "outer",
            "geometry": [{"lon": lon, "lat": lat} for lon, lat in points],
        }

    payload = {
        "elements": [
            {
                "type": "relation",
                "id": 1,
                "tags": {"landuse": "residential"},
                "members": [member(first_half), member(second_half)],
            }
        ]
    }
    _features, stats = gp.features_from_overpass(payload)
    assert stats["relation_features"] == 0, stats
    assert stats["relation_unbuilt"] == 1, stats


def test_ring_orientation_reads_the_shapefile_convention():
    """Clockwise is outer; inverting the sign test inverts every hole (R3)."""
    clockwise = [(0, 0), (0, 10), (10, 10), (10, 0), (0, 0)]
    assert gp._ring_is_outer(clockwise) is True
    assert gp._ring_is_outer(list(reversed(clockwise))) is False


def test_source_split_reports_the_ratio_and_is_not_a_partition():
    """The function that produced the 60.0% / 58.51% unit bug, finally pinned.

    way 2500, relation 2500, union 4375. The relation share of way+relation is
    exactly 0.5, and the two must sum PAST the union — the property the report
    leans on when it says the split is not a partition (mutation R1).
    """
    way = gp.feature("landuse", "residential", square(0, 0, 50, 50), source="way")
    rel = gp.feature("natural", "wood", square(25, 25, 75, 75), source="relation")
    split = gp.source_split([way, rel], BBOX)
    assert abs(split["way_m2"] - 2500.0) < 1e-6, split
    assert abs(split["relation_m2"] - 2500.0) < 1e-6, split
    assert abs(split["relation_share_of_area"] - 0.5) < 1e-4, split
    union = gp.coverage([way, rel], BBOX).covered_m2
    assert split["way_m2"] + split["relation_m2"] > union


def test_size_distribution_median_is_the_middle_value():
    """Median, not the midrange (mutation R2).

    §4.4 compares 8,809 / 2,568 / 338 m² medians across three datasets; a
    median that was really a midrange would reorder that table.
    """
    feats = [
        gp.feature("landuse", "residential", square(0, 0, 1, 1)),
        gp.feature("landuse", "residential", square(10, 10, 12, 12)),
        gp.feature("landuse", "residential", square(20, 20, 30, 30)),
    ]
    dist = gp.size_distribution(feats, BBOX)
    assert dist["count"] == 3
    assert abs(dist["median_m2"] - 4.0) < 1e-6, dist  # midrange would be 50.5


def test_classify_prefers_landuse_over_later_keys():
    """Tag precedence is fixed so the class breakdown is reproducible (R8)."""
    assert gp._classify({"landuse": "grass", "leisure": "park"}) == ("landuse", "grass")
    assert gp._classify({"leisure": "park"}) == ("leisure", "park")
    assert gp._classify({"building": "yes"}) is None


def test_paints_ground_keeps_the_whitelist_meaningful():
    """A whitelist that accepts everything is not a whitelist (R5)."""
    assert gp._paints_ground("amenity", "parking") is True
    assert gp._paints_ground("amenity", "restaurant") is False
    assert gp._paints_ground("waterway", "riverbank") is True
    assert gp._paints_ground("waterway", "stream") is False
    assert gp._paints_ground("landuse", "anything") is True


def test_body_class_recognises_each_family_it_reports():
    """`_body_class` had no case at all; its JPEG magic could break (R4)."""
    assert gp._body_class(bytes([0xFF, 0xD8, 0xFF, 0xE0]) + b"rest") == "jpeg"
    assert gp._body_class(b"\x89PNG\r\n") == "png"
    assert gp._body_class(b'{"a":1}') == "json_like"
    assert gp._body_class(b"<?xml version") == "xml_like"
    assert gp._body_class(b"") == "empty"
    assert gp._body_class(bytes(3)) == "all_nul"
    assert gp._body_class(b"plain text") == "other"


def test_blank_split_is_order_independent_and_names_the_overlap():
    """The S2 defect, pinned: every figure is measured against the gap itself.

    Corridor and buildings deliberately overlap. `gap_in_buildings_m2` must be
    the FULL intersection with the gap — not the remainder after the corridor
    was removed — and the overlap must be reported, so the three numbers cannot
    be misread as a partition.
    """
    bbox = gp.BBox(0.0, 0.0, 100.0, 100.0)
    covered = Poly(square(0, 0, 100, 50))
    corridor = Poly(square(0, 50, 100, 70))
    buildings = Poly(square(0, 60, 100, 80))
    split = gp.blank_split(covered, corridor, buildings, bbox)
    assert abs(split["gap_m2"] - 5000.0) < 1e-6, split
    assert abs(split["gap_in_corridor_m2"] - 2000.0) < 1e-6, split
    assert abs(split["gap_in_buildings_m2"] - 2000.0) < 1e-6, split
    assert abs(split["gap_in_both_m2"] - 1000.0) < 1e-6, split
    assert abs(split["true_blank_m2"] - 2000.0) < 1e-6, split
    total = (
        split["gap_in_corridor_m2"]
        + split["gap_in_buildings_m2"]
        + split["true_blank_m2"]
    )
    assert total > split["gap_m2"], (total, split["gap_m2"])


def test_blank_split_reports_what_the_building_term_removed():
    """The building term is a PROXY, so its size must be published (S8-5).

    §7 turns the NLSC/OSM ratio uncertainty into an interval by scaling this
    figure; reporting it as 0 would silently collapse that interval to a point.
    Buildings here remove 2000 m^2 of blank, and nothing else does.
    """
    bbox = gp.BBox(0.0, 0.0, 100.0, 100.0)
    covered = Poly(square(0, 0, 100, 50))
    corridor = Poly(square(0, 50, 100, 70))
    buildings = Poly(square(0, 70, 100, 90))
    split = gp.blank_split(covered, corridor, buildings, bbox)
    assert abs(split["true_blank_m2"] - 1000.0) < 1e-6, split
    assert abs(split["building_contribution_m2"] - 2000.0) < 1e-6, split


def test_blank_envelope_carries_both_uncertainties_and_stays_asymmetric():
    """The published interval's arithmetic, graded (S11 / S12).

    Round 4 found both of these living inline in `cmd_blank`, where nothing
    could reach them: a mutant collapsing the carriageway range to a point
    survived, and so did one replacing the measured asymmetric proxy span with
    a symmetric +/-15%.

    Worked by hand: blank 1000, credited 500, building contribution 200.
      lowest  = 1000 + 0.1978*500 + (1-1.150)*200 = 1068.9
      highest = 1000 + 0.2892*500 + (1-0.824)*200 = 1179.8
    """
    low, high = gp.blank_envelope(1000.0, 500.0, 200.0, (0.1978, 0.2892), (0.824, 1.150))
    assert abs(low - 1068.9) < 1e-6, low
    assert abs(high - 1179.8) < 1e-6, high

    # A point carriageway share must NOT produce the same interval as a range.
    point_low, point_high = gp.blank_envelope(
        1000.0, 500.0, 200.0, (0.2892, 0.2892), (0.824, 1.150)
    )
    assert (point_low, point_high) != (low, high)

    # The measured span is not symmetric: 0.824 is 17.6% below 1, 1.150 is
    # 15.0% above. The distances from the un-propagated value must differ.
    base = 1000.0 + 0.2892 * 500.0
    assert abs((point_high - base) - (base - point_low)) > 1.0, (point_low, point_high)


def test_surveyed_road_credit_excludes_what_buildings_already_cover():
    """The carriageway share applies to surveyed road only, minus buildings.

    Counting ground that a building already occupies would let the sidewalk
    adjustment add area twice (S8-6). Surveyed road spans y 50..80, buildings
    y 70..90, so the credit is the 50..70 band: 2000 m^2, not 3000.
    """
    bbox = gp.BBox(0.0, 0.0, 100.0, 100.0)
    covered = Poly(square(0, 0, 100, 50))
    surveyed = Poly(square(0, 50, 100, 80))
    buildings = Poly(square(0, 70, 100, 90))
    split = gp.blank_split(covered, surveyed, buildings, bbox, surveyed)
    assert abs(split["blank_credited_to_surveyed_road_m2"] - 2000.0) < 1e-6, split


def test_corridor_keeps_measured_surface_and_assumed_buffer_separable():
    """A zero half-width must yield ONLY the measured surface (R6).

    The report distinguishes the surveyed part of the corridor from the part
    this probe assumed; if the buffer leaked in at half-width 0, that
    distinction would be cosmetic.
    """
    city = [Poly(square(0, 0, 10, 10))]
    lines = {"residential": [[(50.0, 0.0), (50.0, 100.0)]]}
    measured_only = gp.corridor_from(lines, 0.0, city)
    assert abs(measured_only.area - 100.0) < 1e-6, measured_only.area
    assert gp.corridor_from(lines, 3.0, city).area > measured_only.area + 500


#: Temp dirs holding generated shapefile fixtures, kept alive for the process.
_FIXTURE_DIRS = []


def _write_shapefile(name, shapes, fields=(), records=()):
    """Write a throwaway shapefile with pyshp and return its base path."""
    import tempfile

    try:
        import shapefile as pyshp
    except ImportError as exc:  # pyshp is only needed by the shapefile cases
        raise Unavailable(f"needs pyshp to build a shapefile fixture ({exc})") from exc

    tmp = tempfile.TemporaryDirectory()
    _FIXTURE_DIRS.append(tmp)
    base = Path(tmp.name) / name
    writer = pyshp.Writer(str(base), shapeType=pyshp.POLYGON)
    for field in fields:
        writer.field(field, "N", decimal=2)
    if not fields:
        writer.field("ID", "C", size=4)
    for i, shape in enumerate(shapes):
        writer.poly(shape)
        writer.record(*(records[i] if records else ("x",)))
    writer.close()
    return base


def _fixture_road_shapefile():
    """Two records, one of them straddling the bbox edge.

    Inside: 10x10 with 20 sidewalk + 5 ditch.
    Straddling: 20x10 spanning x 90..110, so exactly half lies in a 0..100
    bbox, carrying 20 sidewalk of which only 10 may be counted. Without the
    straddling record the pro-rating is a no-op and a mutant that drops it
    survives (S8-3).
    """
    inside = [[(0.0, 0.0), (0.0, 10.0), (10.0, 10.0), (10.0, 0.0), (0.0, 0.0)]]
    straddling = [
        [(90.0, 0.0), (90.0, 10.0), (110.0, 10.0), (110.0, 0.0), (90.0, 0.0)]
    ]
    # EVERY column carries a distinct non-zero value, so dropping any one of
    # them changes the total. The first version left CEN_MEDIAN and CAR_MEDIAN
    # at zero, and a mutant that shortened the column list to two stayed green
    # (N9) — the field selection is a semantic choice, and §13.5's second
    # criterion is exactly about semantic choices, so it has to be pinned.
    return _write_shapefile(
        "roads",
        [inside, straddling],
        fields=gp.NON_CARRIAGEWAY_COLUMNS,
        records=[(20.0, 5.0, 3.0, 1.0), (20.0, 0.0, 0.0, 0.0)],
    )


#: Temp dir holding the JSON fixtures the end-to-end cases drive `main()` with.
_JSON_FIXTURES = []


def _fixture_dir():
    import tempfile

    if not _JSON_FIXTURES:
        tmp = tempfile.TemporaryDirectory()
        _JSON_FIXTURES.append(tmp)
    return Path(_JSON_FIXTURES[0].name)


def _write_json(name, payload):
    import json as _json

    path = _fixture_dir() / name
    path.write_text(_json.dumps(payload), encoding="utf-8")
    return path


def _fixture_area_file():
    """A 100 x 100 m area file in the shape `BBox.from_area_file` expects."""
    return _write_json(
        "area.json",
        {"bbox": {"e_min": 305500, "n_min": 2767500, "e_max": 305600, "n_max": 2767600}},
    )


#: The fixture bbox in EPSG:3826, matching `_fixture_area_file`.
_FIX_E0, _FIX_N0 = 305500.0, 2767500.0


def _ll_offset(east_m, north_m):
    """Exact EPSG:3826 -> WGS84, so a fixture's area is the area we intend.

    The first version approximated degrees per metre, which put a "half the
    bbox" polygon at 0.4972 instead of 0.5 — and that 0.6% slop then justified
    a +/-0.02 tolerance in the end-to-end case, wide enough for a mutant that
    multiplied the answer by 1.03 to survive (S6). Projecting properly costs
    nothing and lets the tolerance be tight enough to mean something.
    """
    from pyproj import Transformer

    global _TO_WGS
    try:
        transformer = _TO_WGS
    except NameError:
        transformer = _TO_WGS = Transformer.from_crs(
            "EPSG:3826", "EPSG:4326", always_xy=True
        )
    return transformer.transform(_FIX_E0 + east_m, _FIX_N0 + north_m)


def _fixture_osm_areas():
    """One landuse polygon covering the southern half of the fixture bbox."""
    ring = [
        _ll_offset(-20, -20),
        _ll_offset(120, -20),
        _ll_offset(120, 50),
        _ll_offset(-20, 50),
        _ll_offset(-20, -20),
    ]
    return _write_json(
        "osm-areas.json",
        {
            "elements": [
                {
                    "type": "way",
                    "id": 1,
                    "tags": {"landuse": "residential"},
                    "geometry": [{"lon": lon, "lat": lat} for lon, lat in ring],
                }
            ]
        },
    )


def _fixture_osm_highways():
    """A highway far outside the fixture bbox: a corridor that covers nothing."""
    return _write_json(
        "osm-highways.json",
        {
            "elements": [
                {
                    "type": "way",
                    "id": 2,
                    "tags": {"highway": "residential"},
                    "geometry": [
                        {"lon": lon, "lat": lat}
                        for lon, lat in (_ll_offset(5000, 5000), _ll_offset(5100, 5000))
                    ],
                }
            ]
        },
    )


def _fixture_osm_buildings():
    """A real building INSIDE the bbox, under already-painted ground.

    Inside matters: `building_input` is now decided by the area that reaches
    the computation, so a fixture whose buildings all fall outside the bbox is
    — correctly — indistinguishable from an empty file. Placing it in the
    landuse-covered southern half keeps the blank fraction at exactly 0.5 while
    still licensing the envelope.
    """
    ring = [
        _ll_offset(70, 10),
        _ll_offset(90, 10),
        _ll_offset(90, 30),
        _ll_offset(70, 30),
        _ll_offset(70, 10),
    ]
    return _write_json(
        "osm-buildings.json",
        {
            "elements": [
                {
                    "type": "way",
                    "id": 3,
                    "tags": {"building": "yes"},
                    "geometry": [{"lon": lon, "lat": lat} for lon, lat in ring],
                }
            ]
        },
    )


def test_city_road_reader_keeps_every_ring_of_a_multi_ring_shape():
    """Two disjoint rings in one shape are two polygons, not one.

    Today's real file holds a single multi-ring shape, so a reader that dropped
    the extra rings moved the result by 0.0 pp — latent, not absent (S8). A
    fixture pins it independently of what today's download happens to contain.
    """
    shape = [
        [(0.0, 0.0), (0.0, 10.0), (10.0, 10.0), (10.0, 0.0), (0.0, 0.0)],
        [(20.0, 0.0), (20.0, 10.0), (30.0, 10.0), (30.0, 0.0), (20.0, 0.0)],
    ]
    polys = gp.polygons_from_shapefile(_write_shapefile("multi", [shape]))
    assert len(polys) == 2, [p.area for p in polys]
    assert abs(sum(p.area for p in polys) - 200.0) < 1e-6, [p.area for p in polys]


def test_corridor_width_is_pinned_by_area_not_by_an_inequality():
    """Doubling the half-width must FAIL this case, not merely widen it.

    The corridor was pinned only by `>`, so a mutant that doubled the buffer
    survived (S8). That is B1's lesson one level down: the value was corrected,
    but nothing could catch it being changed again. A straight 100 m line
    buffered by h is 200h plus a half-disc cap at each end — an exact area.
    """
    import math

    lines = {"residential": [[(0.0, 50.0), (100.0, 50.0)]]}
    for halfwidth in (3.0, 6.0):
        corridor = gp.corridor_from(lines, halfwidth, None)
        expected = 100.0 * 2 * halfwidth + math.pi * halfwidth**2
        assert abs(corridor.area - expected) / expected < 0.001, (
            halfwidth,
            corridor.area,
            expected,
        )


def test_road_attribute_shares_prorates_and_reports_a_fraction():
    """The carriageway share drives §7, so its arithmetic is pinned.

    One 100 m^2 record fully inside the bbox with 20 m^2 of sidewalk and
    5 m^2 of ditch is a 25% non-carriageway share. A reader that ignored the
    columns, or summed them without pro-rating, lands somewhere else.
    """
    shares = gp.road_attribute_shares(
        _fixture_road_shapefile(), gp.BBox(0.0, 0.0, 100.0, 100.0), encoding="utf-8"
    )
    assert shares["records"] == 2, shares
    # 100 fully inside + 100 of the 200 straddling one.
    assert abs(shares["road_union_m2"] - 200.0) < 1e-6, shares
    # Sidewalk: 20 whole + 20 * 0.5 pro-rated = 30; not 40.
    assert abs(shares["per_column_m2"]["SWALK_AREA"] - 30.0) < 1e-6, shares
    # Every column is counted: 30 + 5 + 3 + 1 = 39. Dropping any one moves it.
    for column, expected in (("DITCH_AREA", 5.0), ("CEN_MEDIAN", 3.0), ("CAR_MEDIAN", 1.0)):
        assert abs(shares["per_column_m2"][column] - expected) < 1e-6, (column, shares)
    assert abs(shares["non_carriageway_m2"] - 39.0) < 1e-6, shares
    assert abs(shares["non_carriageway_share"] - 0.195) < 1e-4, shares
    assert set(gp.NON_CARRIAGEWAY_COLUMNS) == {
        "SWALK_AREA",
        "DITCH_AREA",
        "CEN_MEDIAN",
        "CAR_MEDIAN",
    }, gp.NON_CARRIAGEWAY_COLUMNS


def test_drivable_classes_come_from_the_pipeline_not_a_copy():
    """Parsed from `tags.py`, so the probe cannot drift from the pipeline.

    This is the one case that reads outside `docs/spikes/`, so it carries an
    explicit location dependency. Run from a copy of this directory alone it
    reports SKIP rather than dying of `FileNotFoundError` — a red that would
    say nothing about the probe.
    """
    tags = (
        Path(__file__).resolve().parents[2]
        / "scene-pipeline/src/scene_pipeline/etl/osm/tags.py"
    )
    if not tags.is_file():
        raise Unavailable(f"needs the pipeline checkout at {tags}")
    classes = gp.load_drivable_classes(tags)
    assert "residential" in classes and "service" in classes
    # The whole of B1: pedestrian ways are NOT drivable and must not be paved.
    for pedestrian in ("footway", "steps", "path", "cycleway", "pedestrian"):
        assert pedestrian not in classes, pedestrian


def test_drivable_classes_refuse_a_module_without_the_set():
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        bad = Path(tmp) / "tags.py"
        bad.write_text("OTHER = frozenset({'a'})\n", encoding="utf-8")
        try:
            gp.load_drivable_classes(bad)
        except ValueError:
            return
        raise AssertionError("a module with no HIGHWAY_CLASSES must not pass silently")


def test_highways_by_class_filters_to_the_requested_set():
    def way(klass):
        return {
            "type": "way",
            "tags": {"highway": klass},
            "geometry": [
                {"lon": _LON0, "lat": _LAT0},
                {"lon": _LON0 + 0.001, "lat": _LAT0},
            ],
        }

    payload = {"elements": [way("residential"), way("footway")]}
    assert set(gp.highways_by_class(payload)) == {"residential", "footway"}
    assert set(gp.highways_by_class(payload, {"residential"})) == {"residential"}


# --- the report's own commands must still run -------------------------------


def _documented_invocations():
    """Every `ground-probe` command line printed in the report, as argv lists.

    Joins shell line continuations and drops the interpreter and script path,
    so what is left is exactly what argparse must accept.
    """
    report = PROBE.with_name("ground-colouring.md")
    if not report.is_file():
        raise Unavailable(f"needs the report beside the probe at {report}")
    joined = report.read_text(encoding="utf-8").replace("\\\n", " ")
    found = []
    for line in joined.splitlines():
        stripped = line.strip()
        if stripped.startswith("python docs/spikes/ground-probe.py"):
            found.append(stripped.split()[2:])  # drop "python" and the script
    return found


def test_every_documented_command_is_still_accepted_by_the_cli():
    """The report's own commands are parsed against the real parser.

    Round 3 removed `--road-halfwidth` and `--highways` from `measure` and left
    two documented commands dying with "unrecognized arguments" — one of which
    produces candidate A's headline numbers and the answer to AC3. AC2 requires
    every number to carry the command that made it, so a command that cannot
    run is a missing number.

    This checks the CLI CONTRACT, not the measurement: argparse validates flags
    and types without touching the filesystem, so the report's placeholder
    paths (`<解壓目錄>/細計-面`) are fine exactly as written.
    """
    import contextlib
    import io

    invocations = _documented_invocations()
    assert invocations, "no ground-probe commands found in the report"
    parser = gp.build_parser()
    broken = []
    for tokens in invocations:
        buffer = io.StringIO()
        try:
            with contextlib.redirect_stderr(buffer):
                parser.parse_args(tokens)
        except SystemExit:
            broken.append((" ".join(tokens)[:80], buffer.getvalue().strip()[-80:]))
    assert not broken, broken


def test_the_documented_command_check_can_actually_fail():
    """Control for the case above: a bad flag must be rejected.

    Without it, a parser that accepted anything — or an extractor that found
    nothing — would be indistinguishable from a clean report.
    """
    import contextlib
    import io

    parser = gp.build_parser()
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            parser.parse_args(
                ["measure", "--area", "a", "--input", "b", "--no-such-flag", "x"]
            )
        except SystemExit:
            return
    raise AssertionError("the parser accepted a flag that does not exist")


# --- fix1: the command -> number link, which nothing was checking ------------
#
# The round-4 guard pins "argv is accepted by the parser". It is a real guard —
# pushed four ways, it goes red four ways. But the invariant it pins is not the
# invariant AC2 needs, and the gap let a defect through that no reviewer hit:
# every Layer 2 round recomputed with its own fetcher, so nobody ever walked
# the documented path. A verifier did, and §7.4's numbers moved by 9.7-13.4 pp
# because `osm-buildings.json` is required by a documented command and produced
# by none of them.
#
# The family boundary is the guarantee boundary — fourth occurrence, this time
# on the link between a command and the number it is said to produce.


def _documented_output_paths():
    """Files the report's own commands WRITE (`--out` directories aside)."""
    produced = set()
    for tokens in _documented_invocations():
        for i, token in enumerate(tokens):
            if token == "--out" and i + 1 < len(tokens):
                produced.add(tokens[i + 1])
    return produced


def test_every_input_a_documented_command_needs_is_documented_too():
    """A documented command may only consume what a documented command makes.

    This is the invariant AC2 actually needs: "every number carries the command
    that produced it" is worthless if that command needs an input no command
    creates. `--buildings <osm-buildings.json>` appears in §7.4; nothing in the
    report ever wrote that file, and `blank` treated its absence as "no
    buildings" rather than as a missing input.
    """
    fetched = gp.OSM_FETCHES  # name -> output file written by `osm`
    written = {spec["filename"] for spec in fetched.values()}
    needed = set()
    for tokens in _documented_invocations():
        for i, token in enumerate(tokens):
            if token in ("--osm", "--highways", "--buildings") and i + 1 < len(tokens):
                needed.add(Path(tokens[i + 1].strip("<>")).name)
    missing = {n for n in needed if n not in written}
    assert not missing, (
        f"documented commands consume {sorted(missing)}, "
        f"but the documented fetch only writes {sorted(written)}"
    )


def test_osm_fetch_covers_every_layer_the_report_measures():
    """`osm` must fetch areas, highways AND buildings.

    Buildings carry the whole §7.5 building term; fetching two of three layers
    is what made the third silently default to empty.
    """
    assert set(gp.OSM_FETCHES) == {"areas", "highways", "buildings"}, gp.OSM_FETCHES
    building_query = gp.OSM_FETCHES["buildings"]["query"](25.0, 121.5, 25.1, 121.6)
    assert '"building"' in building_query, building_query
    assert "relation" in building_query, "multipolygon buildings must be fetched too"


def test_osm_command_actually_fetches_every_layer_in_the_table():
    """The table being complete is not the same as the command using it.

    `test_osm_fetch_covers_every_layer_the_report_measures` asserts on
    OSM_FETCHES; a `cmd_osm` that iterated only the first entry passed it
    untouched (mutation F5). This drives the command with the network stubbed
    out and checks which files it asked for.
    """
    import contextlib
    import io
    import tempfile

    requested = []

    def fake_fetch(query, out_path, **kwargs):
        requested.append(Path(out_path).name)
        return {"saved": str(out_path), "attempts": []}

    real_fetch = gp.fetch_overpass
    gp.fetch_overpass = fake_fetch
    try:
        with tempfile.TemporaryDirectory() as tmp:
            with contextlib.redirect_stdout(io.StringIO()):
                gp.main(
                    [
                        "osm",
                        "--area", str(_fixture_area_file()),
                        "--out", tmp,
                        "--delay", "0",
                    ]
                )
    finally:
        gp.fetch_overpass = real_fetch

    expected = {spec["filename"] for spec in gp.OSM_FETCHES.values()}
    assert set(requested) == expected, (requested, expected)


def test_blank_refuses_to_publish_an_envelope_without_the_building_input():
    """Missing proxy input must be loud, not a silently different answer.

    Run without `--buildings`, `blank` used to exit 0 with an empty stderr and
    an envelope that looked exactly like the real one — B's band read 29.3-37.1%
    where the report says 16.2-27.5%. A missing input must either stop the run
    or mark the affected figures, never quietly produce a second set of numbers
    wearing the first set's label.
    """
    import contextlib
    import io
    import json as _json

    out = io.StringIO()
    err = io.StringIO()
    argv = [
        "blank",
        "--area", str(_fixture_area_file()),
        "--osm", str(_fixture_osm_areas()),
        "--highways", str(_fixture_osm_highways()),
    ]
    code = None
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = gp.main(argv)
    except SystemExit as exc:
        code = exc.code

    if code not in (0, None):
        assert "building" in err.getvalue().lower(), err.getvalue()
        return

    payload = _json.loads(out.getvalue())
    for row in payload["results"]:
        assert "envelope_frac" not in row, (
            "an envelope was published without the building input it depends on"
        )
        assert row.get("building_input") == "absent", row


def test_blank_publishes_the_envelope_when_the_building_input_is_present():
    """Control for the case above: with the input, the envelope IS published."""
    import contextlib
    import io
    import json as _json

    out = io.StringIO()
    argv = [
        "blank",
        "--area", str(_fixture_area_file()),
        "--osm", str(_fixture_osm_areas()),
        "--highways", str(_fixture_osm_highways()),
        "--buildings", str(_fixture_osm_buildings()),
    ]
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        gp.main(argv)
    payload = _json.loads(out.getvalue())
    assert payload["results"], payload
    for row in payload["results"]:
        assert "envelope_frac" in row, row
        assert row.get("building_input") == "present", row


def _fixture_city_roads():
    """A surveyed road strip inside the bbox but under already-painted ground.

    It has to intersect the clip or the city rules never appear; it sits in the
    landuse-covered southern half so it brings the carriageway machinery and
    the surveyed-road credit into the run without moving the blank fraction,
    which keeps the end-to-end expectation hand-computable.
    """
    ring = [
        [
            (_FIX_E0 + 10, _FIX_N0 + 10),
            (_FIX_E0 + 60, _FIX_N0 + 10),
            (_FIX_E0 + 60, _FIX_N0 + 30),
            (_FIX_E0 + 10, _FIX_N0 + 30),
            (_FIX_E0 + 10, _FIX_N0 + 10),
        ]
    ]
    return _write_shapefile(
        "city-roads",
        [ring],
        fields=gp.NON_CARRIAGEWAY_COLUMNS,
        records=[(200.0, 50.0, 30.0, 10.0)],
    )


def _fixture_zoning():
    """A zoning polygon covering the fixture bbox's western half."""
    ring = [
        [
            (_FIX_E0, _FIX_N0),
            (_FIX_E0 + 50, _FIX_N0),
            (_FIX_E0 + 50, _FIX_N0 + 100),
            (_FIX_E0, _FIX_N0 + 100),
            (_FIX_E0, _FIX_N0),
        ]
    ]
    return _write_shapefile(
        "zoning", [ring], fields=("ZONE",), records=[(3.0,)]
    )


def _fixture_osm_buildings_timed_out():
    """What Overpass returns when a query times out: 200, valid JSON, no data.

    `remark` plus an empty `elements` array. `fetch_overpass` accepts any 200
    with a json-like body, so this lands on disk as a successful fetch — and
    buildings is the heaviest of the three layers, so it is the one that times
    out.
    """
    return _write_json(
        "osm-buildings-timeout.json",
        {
            "version": 0.6,
            "generator": "Overpass API",
            "remark": "runtime error: Query timed out",
            "elements": [],
        },
    )


def _run_blank(extra_args):
    """Drive `blank` through `main()` and return (exit code, payload, stderr)."""
    import contextlib
    import io
    import json as _json

    out, err = io.StringIO(), io.StringIO()
    argv = [
        "blank",
        "--area", str(_fixture_area_file()),
        "--osm", str(_fixture_osm_areas()),
        "--highways", str(_fixture_osm_highways()),
        *extra_args,
    ]
    code = None
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = gp.main(argv)
    except SystemExit as exc:
        code = exc.code
    text = out.getvalue()
    payload = _json.loads(text) if text.strip() else None
    return code, payload, err.getvalue()


def test_building_input_is_decided_by_the_computation_not_by_the_flag():
    """A file that contributes nothing is not a present input.

    `building_input` was set from whether `--buildings` appeared in argv, so a
    timed-out Overpass response — 200, valid JSON, zero elements — was stamped
    `present` while `buildings_m2` sat at 0.0, and the run reproduced the
    verify-fail numbers exactly. The label made the wrong answer MORE credible
    than the unlabelled version had been.

    A field that describes the input must be decided by what reached the
    computation, never by the command line.
    """
    code, payload, err = _run_blank(
        ["--buildings", str(_fixture_osm_buildings_timed_out())]
    )
    if code not in (0, None):
        assert "building" in err.lower(), err
        return
    assert payload["building_input"] != "present", payload["building_input"]
    assert payload["buildings_m2"] == 0.0, payload["buildings_m2"]
    for row in payload["results"]:
        assert "envelope_frac" not in row, (
            "an envelope was published from a buildings file that carried no buildings"
        )


def _fixture_osm_buildings_truncated(count=2):
    """A timed-out fetch that still returned SOME buildings.

    This is the shape that matters: Overpass reports a partial result as
    HTTP 200 with a `remark` and whatever it managed to collect. Two buildings
    out of nine thousand is 0.02% of the layer, and an "area > 0" threshold
    calls that a present input.
    """
    payload = {"version": 0.6, "remark": "runtime error: Query timed out", "elements": []}
    for i in range(count):
        east = 70 + (i % 8) * 2
        north = 10 + (i // 8) * 2
        ring = [
            _ll_offset(east, north),
            _ll_offset(east + 1, north),
            _ll_offset(east + 1, north + 1),
            _ll_offset(east, north + 1),
            _ll_offset(east, north),
        ]
        payload["elements"].append(
            {
                "type": "way",
                "id": 100 + i,
                "tags": {"building": "yes"},
                "geometry": [{"lon": lon, "lat": lat} for lon, lat in ring],
            }
        )
    return _write_json(f"osm-buildings-truncated-{count}.json", payload)


def test_a_remark_bearing_buildings_file_never_licenses_the_envelope():
    """The signal was computed, reported, and then not acted on.

    `building_source_remark: true` was already written into the very JSON whose
    envelope figures the remark invalidates. An "area > 0" test let 2 buildings
    out of 9,360 — 0.02% of the layer — republish an envelope matching the
    verify-fail numbers to 0.01 pp, at exit 0 with a silent stderr, while the
    report carried the evidence that the fetch had failed.

    A wrong threshold is a misjudgement; a signal computed and then ignored is
    leaving the proof of your own invalidity in the output. `remark` is exact,
    so no threshold has to be guessed.
    """
    for count in (2, 200):
        code, payload, err = _run_blank(
            ["--buildings", str(_fixture_osm_buildings_truncated(count))]
        )
        if code not in (0, None):
            assert "building" in err.lower(), err
            continue
        assert payload["building_input"] != "present", (count, payload["building_input"])
        assert payload.get("building_source_remark") is True, payload
        assert err.strip(), "a partial fetch must be announced on stderr"
        for row in payload["results"]:
            assert "envelope_frac" not in row, (
                f"{count} buildings from a timed-out fetch republished an envelope"
            )


def test_fetch_overpass_does_not_bank_a_remark_as_a_successful_fetch():
    """The acquisition layer has to refuse it too.

    Otherwise `osm` writes the truncated file, prints `status: 200`, exits 0,
    and the user never learns the fetch failed — the withholding downstream
    would be the only hint, one command too late.
    """
    import json as _json
    import tempfile

    class _Resp:
        status_code = 200
        headers: dict = {}

        def __init__(self, body):
            self.content = body

    class _Session:
        def __init__(self, bodies):
            self.bodies = list(bodies)

        def post(self, url, **kwargs):
            return _Resp(self.bodies.pop(0) if self.bodies else b"{}")

    remark_body = _json.dumps(
        {"version": 0.6, "remark": "runtime error: Query timed out", "elements": []}
    ).encode()

    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "out.json"
        record = gp.fetch_overpass(
            "[out:json];out;",
            target,
            session=_Session([remark_body]),
            attempts=1,
            backoff=0,
        )
        assert not target.exists(), "a remark-bearing body was written to disk"
    assert not record.get("saved"), record
    assert any(a.get("remark") for a in record["attempts"]), record


def test_building_input_needs_area_not_merely_elements():
    """S11: "decided by area, not element count", finally pinned.

    The claim lived only in a comment. Every buildings fixture sits inside the
    bbox, so `building_features > 0` behaved identically to `area > 0` and a
    mutant swapping them survived. This file has real elements whose geometry
    falls entirely outside the measured area.
    """
    ring = [
        _ll_offset(5000, 5000),
        _ll_offset(5050, 5000),
        _ll_offset(5050, 5050),
        _ll_offset(5000, 5050),
        _ll_offset(5000, 5000),
    ]
    outside = _write_json(
        "osm-buildings-outside.json",
        {
            "elements": [
                {
                    "type": "way",
                    "id": 7,
                    "tags": {"building": "yes"},
                    "geometry": [{"lon": lon, "lat": lat} for lon, lat in ring],
                }
            ]
        },
    )
    _code, payload, _err = _run_blank(["--buildings", str(outside)])
    assert payload["building_features"] >= 1, payload
    assert payload["buildings_m2"] == 0.0, payload
    assert payload["building_input"] == "empty", payload["building_input"]


def test_an_empty_buildings_file_is_reported_distinctly_from_a_missing_one():
    """Both withhold, but they are different facts and must read differently."""
    _, absent, _ = _run_blank([])
    _, empty, _ = _run_blank(
        ["--buildings", str(_fixture_osm_buildings_timed_out())]
    )
    assert absent["building_input"] == "absent", absent["building_input"]
    assert empty["building_input"] not in ("absent", "present"), empty["building_input"]


def test_withholding_is_loud_on_stderr_and_drops_the_dependent_figures():
    """S2: the "loud" half of the guard had nothing pinning it.

    Deleting the stderr warning kept the exam green, and so did deleting the
    line that removes the carriageway range — the parts that make a withheld
    run visible were the parts nothing checked.
    """
    _, payload, err = _run_blank([])
    assert "building" in err.lower(), repr(err)
    assert err.strip(), "a withheld run must say so on stderr"
    for row in payload["results"]:
        assert "carriageway_adjusted_frac_range" not in row, row
        assert row.get("withheld"), row


def test_building_query_asks_for_ways_and_relations_separately():
    """S3: `'"building"' in query` is satisfied by the relation clause alone.

    Breaking the way clause to `way["buildingz"]` left the exam green, so both
    clauses are now named.
    """
    query = gp.OSM_FETCHES["buildings"]["query"](25.0, 121.5, 25.1, 121.6)
    assert 'way["building"](' in query, query
    assert 'relation["building"](' in query, query


def test_every_fetched_layer_is_consumed_by_a_documented_command():
    """S1: the invariant only ran one way.

    `needed <= written` is satisfied by shrinking `needed`, so deleting
    `--buildings` from §7.4 passed 52/52 — and B1 is the extreme form of that
    same direction: the flag is present but what it points at is empty. Both
    ends are now asserted, so a layer cannot be quietly dropped from either
    the producing side or the consuming side.
    """
    consumed = set()
    for tokens in _documented_invocations():
        for i, token in enumerate(tokens):
            if token in ("--osm", "--highways", "--buildings") and i + 1 < len(tokens):
                consumed.add(Path(tokens[i + 1].strip("<>")).name)
    fetched = {spec["filename"] for spec in gp.OSM_FETCHES.values()}
    unused = fetched - consumed
    assert not unused, (
        f"{sorted(unused)} is fetched by the documented `osm` command but no "
        f"documented command consumes it — the report would not depend on it"
    )


def test_a_documented_shaped_command_reproduces_a_known_number_end_to_end():
    """argv all the way to a published figure, on synthetic inputs.

    The round-4 guard stops at "the parser accepts this". This one runs a real
    command through `main()` and checks the number that comes out, which is the
    link AC2 is actually about. Network-free and fixture-sized, so it can live
    in the exam; it does not re-measure Taipei, and §2.6 says so.

    Geometry: a 100x100 m area, one 100x50 landuse polygon, no corridor and no
    buildings inside, so exactly half the area is blank.

    Three things this case got wrong and now does not (S6):

    * it checked `true_blank_frac_of_bbox`, while §7.4 publishes
      `envelope_frac` — the published figure is now the asserted one;
    * the tolerance was +/-0.02 against 0.4972, which is 3.5% of relative
      slack, enough for a mutant multiplying the result by 1.03 to live. The
      fixtures project exactly now, so the tolerance is 1e-4;
    * it ran 2 of the 11 rules and 1 of the 3 sources, so `blank_envelope`,
      the carriageway adjustment and the surveyed-road credit never executed.
      City roads and zoning are supplied, which brings all of them in.
    """
    code, payload, _err = _run_blank(
        [
            "--buildings", str(_fixture_osm_buildings()),
            "--city-roads", str(_fixture_city_roads()),
            "--shp", str(_fixture_zoning()),
            "--class-field", "ZONE",
        ]
    )
    assert code in (0, None), code
    assert payload["building_input"] == "present", payload

    rules = {r["rule"] for r in payload["results"]}
    sources = {r["source"] for r in payload["results"]}
    assert sources == {"B_osm", "A_zoning", "A_union_B"}, sources
    # The city rule is what pulls `blank_envelope`, the carriageway adjustment
    # and the surveyed-road credit into the run. Drivable rules need `--tags`,
    # i.e. the pipeline checkout, so they are covered by their own case rather
    # than made a precondition of this one.
    assert any("city road surface only" in r for r in rules), rules

    row = next(
        r
        for r in payload["results"]
        if r["source"] == "B_osm" and r["rule"] == "city road surface only (measured)"
    )
    # Exactly half the fixture area is unpainted, and neither the fixture's
    # roads nor its buildings sit inside it.
    assert abs(row["true_blank_frac_of_bbox"] - 0.5) < 1e-4, row

    # The two ranges are asserted against EXPECTED CONSTANTS, not read back
    # from the same output and fed in again (S10). Reading them back made the
    # check a tautology: mutants collapsing the proxy span to 1.0/1.0 or the
    # carriageway high end to 0.0 both survived, and those are the second and
    # third of §7.5's three named dimensions.
    #
    # The fixture road is 50 x 20 = 1000 m^2 with 200 + 50 + 30 + 10 = 290 m^2
    # of non-carriageway, so the share range is 250/1000 .. 290/1000. The proxy
    # span is the measured 0.824 .. 1.150 (§7.3), which is also the CLI default.
    assert payload["non_carriageway_share_range"] == [0.25, 0.29], payload[
        "non_carriageway_share_range"
    ]
    assert payload["building_proxy_ratio_range"] == [0.824, 1.150], payload[
        "building_proxy_ratio_range"
    ]

    # The PUBLISHED figure, from the graded function applied to this row's own
    # components and those constants — that pins the wiring, not just the value.
    low, high = gp.blank_envelope(
        row["true_blank_m2"],
        row.get("blank_credited_to_surveyed_road_m2", 0.0),
        row["building_contribution_m2"],
        [0.25, 0.29],
        [0.824, 1.150],
    )
    area = payload["bbox_area_m2"]
    assert abs(row["envelope_frac"][0] - low / area) < 1e-6, row
    assert abs(row["envelope_frac"][1] - high / area) < 1e-6, row


def test_narrow_carriageway_column_set_is_pinned_too():
    """S16: the NARROW set is half of the published range's definition.

    §7.2 reports 19.78% - 28.92%; the low end comes from this tuple. The wide
    set was pinned in round 4 and this one was not, so a mutant could move the
    published low end without a single case going red.
    """
    assert set(gp.NARROW_NON_CARRIAGEWAY_COLUMNS) == {"SWALK_AREA", "DITCH_AREA"}, (
        gp.NARROW_NON_CARRIAGEWAY_COLUMNS
    )
    assert set(gp.NARROW_NON_CARRIAGEWAY_COLUMNS) < set(gp.NON_CARRIAGEWAY_COLUMNS)
    shares = gp.road_attribute_shares(
        _fixture_road_shapefile(),
        gp.BBox(0.0, 0.0, 100.0, 100.0),
        encoding="utf-8",
        columns=gp.NARROW_NON_CARRIAGEWAY_COLUMNS,
    )
    # 30 sidewalk + 5 ditch over a 200 m^2 union; the medians must NOT appear.
    assert abs(shares["non_carriageway_m2"] - 35.0) < 1e-6, shares
    assert set(shares["per_column_m2"]) == {"SWALK_AREA", "DITCH_AREA"}, shares


# --- runner ----------------------------------------------------------------


class Unavailable(Exception):
    """The case needs something this checkout does not have.

    Distinct from a failure AND from silence. One case reads the pipeline's
    `tags.py`, so outside a repo checkout it died as `FileNotFoundError` and
    took the baseline from 40/40 to 39/40 — a red that says nothing about the
    probe. Reporting it as a counted SKIP keeps the missing coverage visible
    instead of trading a false red for a false green.
    """


def main() -> int:
    cases = [
        (name, fn)
        for name, fn in sorted(globals().items())
        if name.startswith("test_") and callable(fn)
    ]
    failed = skipped = 0
    for name, fn in cases:
        try:
            fn()
        except Unavailable as exc:
            skipped += 1
            print(f"  SKIP {name}: {exc}")
        except Exception as exc:  # noqa: BLE001 — a self-test reports, not raises
            failed += 1
            print(f"  FAIL {name}: {type(exc).__name__}: {exc}")
        else:
            print(f"  ok   {name}")
    passed = len(cases) - failed - skipped
    print(f"\n{passed}/{len(cases)} passed, {skipped} skipped, {failed} failed")
    if skipped:
        print("NOTE: a skip is missing coverage, not a pass.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
