"""Exam: highway filtering and way-attribute normalisation (FTP-29).

Covers AC3 (way 屬性 class / oneway / layer / bridge / tunnel 完整保留) and the
`tag 過濾` half of AC5.

Why these assertions matter: everything downstream of the ETL — D10 conflation,
the D3 road compiler, physics tiles — consumes only what this layer emits. A tag
dropped here is not recoverable later, and a mis-normalised `oneway` silently
produces a drivable twin where traffic runs backwards.
"""

from __future__ import annotations

import pytest

from scene_pipeline.etl.osm import HIGHWAY_CLASSES, road_attributes

# --- class filter ----------------------------------------------------------

# Drivable classes: the twin is a driving simulator, so the road graph is the
# drivable network. Pedestrian ways are excluded on purpose (see below).
EXPECTED_DRIVABLE = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "motorway_link",
    "trunk_link",
    "primary_link",
    "secondary_link",
    "tertiary_link",
}


def test_highway_classes_is_the_declared_drivable_set() -> None:
    # Frozen so that widening the allowlist is a deliberate, reviewed edit
    # rather than a drive-by change that silently reshapes the road graph.
    assert set(HIGHWAY_CLASSES) == EXPECTED_DRIVABLE


@pytest.mark.parametrize("highway", sorted(EXPECTED_DRIVABLE))
def test_drivable_class_is_kept(highway: str) -> None:
    attrs = road_attributes({"highway": highway})
    assert attrs is not None
    assert attrs.highway == highway


@pytest.mark.parametrize(
    "highway",
    ["footway", "steps", "cycleway", "path", "pedestrian", "corridor", "construction", "proposed"],
)
def test_non_drivable_class_is_dropped(highway: str) -> None:
    # WHY: a footway joined into the road graph creates a connection a car can
    # never take; the QA connectivity metric would then read as healthy while
    # the drivable network is actually broken.
    assert road_attributes({"highway": highway}) is None


def test_way_without_highway_tag_is_dropped() -> None:
    assert road_attributes({"building": "yes", "name": "台北101"}) is None


def test_empty_tags_are_dropped() -> None:
    assert road_attributes({}) is None


# --- oneway ----------------------------------------------------------------


@pytest.mark.parametrize("value", ["yes", "true", "1"])
def test_oneway_forward_variants(value: str) -> None:
    attrs = road_attributes({"highway": "primary", "oneway": value})
    assert attrs is not None
    assert (attrs.oneway, attrs.reversed) == (1, False)


@pytest.mark.parametrize("value", ["no", "false", "0"])
def test_oneway_bidirectional_variants(value: str) -> None:
    attrs = road_attributes({"highway": "primary", "oneway": value})
    assert attrs is not None
    assert (attrs.oneway, attrs.reversed) == (0, False)


def test_oneway_absent_is_bidirectional() -> None:
    attrs = road_attributes({"highway": "residential"})
    assert attrs is not None
    assert (attrs.oneway, attrs.reversed) == (0, False)


@pytest.mark.parametrize("value", ["-1", "reverse"])
def test_oneway_reverse_is_normalised_to_forward_plus_reversed_flag(value: str) -> None:
    # WHY: `oneway=-1` means "one way, against the node order". Downstream only
    # understands 0/1, so the ETL must normalise by reversing the geometry and
    # recording that it did. Dropping the flag (or the reversal) points the
    # traffic direction of every such way backwards.
    attrs = road_attributes({"highway": "secondary", "oneway": value})
    assert attrs is not None
    assert (attrs.oneway, attrs.reversed) == (1, True)


@pytest.mark.parametrize("value", ["alternating", "reversible", "garbage"])
def test_unknown_oneway_value_is_bidirectional_and_warns(value: str) -> None:
    # Unknown values must not be guessed into a direction; they degrade to
    # bidirectional and say so, rather than failing the whole extract.
    attrs = road_attributes({"highway": "secondary", "oneway": value})
    assert attrs is not None
    assert (attrs.oneway, attrs.reversed) == (0, False)
    assert any("oneway" in w and value in w for w in attrs.warnings)


# --- layer -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"), [("0", 0), ("1", 1), ("-1", -1), ("-2", -2), ("3", 3)]
)
def test_layer_is_parsed_as_signed_int(value: str, expected: int) -> None:
    attrs = road_attributes({"highway": "primary", "layer": value})
    assert attrs is not None
    assert attrs.layer == expected


def test_layer_absent_defaults_to_zero() -> None:
    attrs = road_attributes({"highway": "primary"})
    assert attrs is not None
    assert attrs.layer == 0


@pytest.mark.parametrize("value", ["1;2", "", "up", "1.5"])
def test_unparseable_layer_degrades_to_zero_and_warns(value: str) -> None:
    # WHY: real OSM carries junk in `layer`. Aborting the whole extract over one
    # bad tag is worse than degrading, but degrading silently would hide a real
    # grade-separation error from M2 — so it must be reported.
    attrs = road_attributes({"highway": "primary", "layer": value})
    assert attrs is not None
    assert attrs.layer == 0
    assert any("layer" in w for w in attrs.warnings)


# --- bridge / tunnel -------------------------------------------------------


@pytest.mark.parametrize("value", ["yes", "viaduct", "boardwalk", "true", "1"])
def test_bridge_truthy_values(value: str) -> None:
    attrs = road_attributes({"highway": "primary", "bridge": value})
    assert attrs is not None
    assert attrs.bridge is True


@pytest.mark.parametrize("value", ["no", "false", "0"])
def test_bridge_falsy_values(value: str) -> None:
    attrs = road_attributes({"highway": "primary", "bridge": value})
    assert attrs is not None
    assert attrs.bridge is False


def test_bridge_absent_is_false() -> None:
    attrs = road_attributes({"highway": "primary"})
    assert attrs is not None
    assert attrs.bridge is False


@pytest.mark.parametrize("value", ["yes", "building_passage", "culvert", "true", "1"])
def test_tunnel_truthy_values(value: str) -> None:
    # `tunnel=building_passage` is 18x in the frozen real fixture alone: a road
    # passing under a building. It is covered geometry and must not read as
    # open sky, or D9's terrain deformation will pull the ground through it.
    attrs = road_attributes({"highway": "primary", "tunnel": value})
    assert attrs is not None
    assert attrs.tunnel is True


@pytest.mark.parametrize("value", ["no", "false", "0"])
def test_tunnel_falsy_values(value: str) -> None:
    attrs = road_attributes({"highway": "primary", "tunnel": value})
    assert attrs is not None
    assert attrs.tunnel is False


def test_tunnel_absent_is_false() -> None:
    attrs = road_attributes({"highway": "primary"})
    assert attrs is not None
    assert attrs.tunnel is False


# --- name / combination ----------------------------------------------------


def test_name_is_preserved_verbatim() -> None:
    attrs = road_attributes({"highway": "secondary", "name": "信義路五段"})
    assert attrs is not None
    assert attrs.name == "信義路五段"


def test_name_absent_is_none() -> None:
    attrs = road_attributes({"highway": "secondary"})
    assert attrs is not None
    assert attrs.name is None


def test_all_attributes_survive_together() -> None:
    # The real 基隆路車行地下道 tag set (tunnel + layer=-1 + oneway) — one call,
    # every field, so a mutation that clobbers one field while wiring another
    # cannot hide behind the single-field cases above.
    attrs = road_attributes(
        {
            "highway": "secondary",
            "name": "基隆路車行地下道",
            "oneway": "yes",
            "layer": "-1",
            "tunnel": "yes",
            "bridge": "no",
        }
    )
    assert attrs is not None
    assert (attrs.highway, attrs.name, attrs.oneway, attrs.layer, attrs.tunnel, attrs.bridge) == (
        "secondary",
        "基隆路車行地下道",
        1,
        -1,
        True,
        False,
    )
    assert attrs.warnings == ()


def test_attributes_are_immutable() -> None:
    # Downstream stages share these objects; accidental mutation would rewrite
    # history for every other consumer.
    attrs = road_attributes({"highway": "primary"})
    assert attrs is not None
    with pytest.raises(Exception):
        attrs.layer = 5  # type: ignore[misc]
