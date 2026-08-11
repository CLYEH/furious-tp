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

PROBE = Path(__file__).with_name("ground-probe.py")


def load_probe():
    spec = importlib.util.spec_from_file_location("ground_probe", PROBE)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load probe module: {PROBE}")
    module = importlib.util.module_from_spec(spec)
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


def test_self_intersecting_polygon_yields_finite_area_and_is_flagged():
    """A bow-tie is invalid geometry. Report it; do not raise, do not NaN."""
    bowtie = gp.feature(
        "landuse", "industrial", [(0, 0), (50, 50), (50, 0), (0, 50), (0, 0)]
    )
    result = gp.coverage([bowtie], BBOX)
    assert result.invalid == 1, result.invalid
    assert 0.0 <= result.covered_m2 < 10000.0
    assert result.covered_m2 == result.covered_m2  # not NaN


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


# --- runner ----------------------------------------------------------------


def main() -> int:
    cases = [
        (name, fn)
        for name, fn in sorted(globals().items())
        if name.startswith("test_") and callable(fn)
    ]
    failed = 0
    for name, fn in cases:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 — a self-test reports, not raises
            failed += 1
            print(f"  FAIL {name}: {type(exc).__name__}: {exc}")
        else:
            print(f"  ok   {name}")
    print(f"\n{len(cases) - failed}/{len(cases)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
