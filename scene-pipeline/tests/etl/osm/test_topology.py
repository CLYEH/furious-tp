"""Exam: road topology extraction (FTP-29).

Covers AC3 (節點度數 + way 屬性完整保留) and the `斷鏈偵測` half of AC5.

Definitions this exam pins down, because RFC D10 makes OSM the authority for
topology and everything downstream trusts these numbers:

* **degree** = number of incident segments, not incident ways. A node in the
  middle of one way has degree 2; a T-junction has degree 3.
* **dangling node** = degree 1 and not a bbox cut — a genuine dead end in the
  source (cul-de-sac, or a real gap in OSM). Reported, never silently fixed.
* **incomplete way** = references a node the extract does not contain, the
  signature of a truncated or badly cropped extract. Dropped and reported.
* **components** = connected pieces of the drivable graph. More than one means
  the area's road network is split — the chain is broken somewhere.
"""

from __future__ import annotations

import pytest

from scene_pipeline.etl.osm import PlacedNode, PlacedWay, build_topology, road_attributes

ATTRS = road_attributes({"highway": "residential"})
assert ATTRS is not None


def node(node_id: int, e: float = 0.0, n: float = 0.0, *, boundary: bool = False) -> PlacedNode:
    return PlacedNode(id=node_id, e=e, n=n, boundary=boundary)


def way(osm_id: int, node_ids: list[int], *, part: int = 0, attrs=ATTRS) -> PlacedWay:
    return PlacedWay(osm_id=osm_id, part=part, node_ids=tuple(node_ids), attributes=attrs)


# --- degrees ---------------------------------------------------------------


def test_straight_way_degrees() -> None:
    topo = build_topology([node(1), node(2), node(3)], [way(10, [1, 2, 3])])
    assert topo.nodes[1].degree == 1
    assert topo.nodes[2].degree == 2  # mid-way node, two incident segments
    assert topo.nodes[3].degree == 1


def test_t_junction_degree_is_three() -> None:
    topo = build_topology(
        [node(1), node(2), node(3), node(4)],
        [way(10, [1, 2, 3]), way(11, [2, 4])],
    )
    assert topo.nodes[2].degree == 3


def test_crossroad_degree_is_four() -> None:
    topo = build_topology(
        [node(i) for i in range(1, 6)],
        [way(10, [1, 5, 2]), way(11, [3, 5, 4])],
    )
    assert topo.nodes[5].degree == 4


def test_two_ways_sharing_an_endpoint_are_one_chain() -> None:
    topo = build_topology(
        [node(1), node(2), node(3)],
        [way(10, [1, 2]), way(11, [2, 3])],
    )
    assert topo.nodes[2].degree == 2
    assert topo.qa.component_count == 1


def test_node_visited_twice_by_one_way_counts_both_visits() -> None:
    # A way that touches itself (common where a road loops back onto a junction)
    # contributes to the degree once per incident segment, not once per way.
    topo = build_topology(
        [node(i) for i in range(1, 5)],
        [way(10, [1, 2, 3, 2, 4])],
    )
    assert topo.nodes[2].degree == 4


def test_closed_loop_has_no_ends() -> None:
    topo = build_topology(
        [node(1), node(2), node(3)],
        [way(10, [1, 2, 3, 1])],
    )
    assert [topo.nodes[i].degree for i in (1, 2, 3)] == [2, 2, 2]
    assert topo.qa.dangling_node_ids == ()


def test_degree_counts_segments_not_ways() -> None:
    # Guards the specific mutation of counting each way's endpoints only: here
    # node 2 is interior to way 10, so an endpoints-only count would read 0.
    topo = build_topology([node(1), node(2), node(3)], [way(10, [1, 2, 3])])
    assert topo.nodes[2].degree == 2
    assert sum(n.degree for n in topo.nodes.values()) == 4  # 2 segments x 2 ends


# --- dangling / broken chains ----------------------------------------------


def test_dangling_nodes_are_the_real_dead_ends() -> None:
    topo = build_topology([node(1), node(2), node(3)], [way(10, [1, 2, 3])])
    assert topo.qa.dangling_node_ids == (1, 3)


def test_boundary_cut_nodes_are_not_dangling() -> None:
    # WHY: every clipped way ends on the bbox edge. If cuts counted as dead
    # ends, the QA signal would be swamped by boundary noise and a genuine gap
    # in the middle of the area would be invisible.
    topo = build_topology(
        [node(1, boundary=True), node(2), node(3, boundary=True)],
        [way(10, [1, 2, 3])],
    )
    assert topo.qa.dangling_node_ids == ()


def test_mixed_ends_report_only_the_real_one() -> None:
    topo = build_topology(
        [node(1, boundary=True), node(2), node(3)],
        [way(10, [1, 2, 3])],
    )
    assert topo.qa.dangling_node_ids == (3,)


def test_dangling_ids_are_sorted() -> None:
    topo = build_topology(
        [node(9), node(2), node(5)],
        [way(10, [9, 5]), way(11, [5, 2])],
    )
    assert topo.qa.dangling_node_ids == (2, 9)


# --- connectivity ----------------------------------------------------------


def test_disconnected_ways_are_separate_components() -> None:
    topo = build_topology(
        [node(i) for i in range(1, 5)],
        [way(10, [1, 2]), way(11, [3, 4])],
    )
    assert topo.qa.component_count == 2
    assert topo.qa.component_sizes == (2, 2)


def test_component_sizes_are_descending() -> None:
    topo = build_topology(
        [node(i) for i in range(1, 6)],
        [way(10, [1, 2, 3]), way(11, [4, 5])],
    )
    assert topo.qa.component_count == 2
    assert topo.qa.component_sizes == (3, 2)


def test_single_connected_network() -> None:
    topo = build_topology(
        [node(i) for i in range(1, 5)],
        [way(10, [1, 2]), way(11, [2, 3]), way(12, [3, 4])],
    )
    assert topo.qa.component_count == 1
    assert topo.qa.component_sizes == (4,)


# --- incomplete ways / unreferenced nodes ----------------------------------


def test_way_referencing_a_missing_node_is_dropped_and_reported() -> None:
    # WHY: this is what a truncated extract looks like from the inside. Keeping
    # the way would hand the road compiler a node id with no coordinates.
    topo = build_topology([node(1), node(2)], [way(10, [1, 2]), way(11, [2, 999])])
    assert [w.way_id for w in topo.ways] == ["10#0"]
    assert topo.qa.incomplete_way_ids == ("11#0",)


def test_dropping_an_incomplete_way_does_not_leave_its_degree_behind() -> None:
    topo = build_topology([node(1), node(2)], [way(10, [1, 2]), way(11, [2, 999])])
    assert topo.nodes[2].degree == 1


def test_unreferenced_nodes_are_not_emitted() -> None:
    # The extract carries nodes for ways we filtered out; they are not part of
    # the road graph and must not inflate the node table.
    topo = build_topology([node(1), node(2), node(77)], [way(10, [1, 2])])
    assert set(topo.nodes) == {1, 2}


def test_way_too_short_to_have_a_segment_is_incomplete() -> None:
    topo = build_topology([node(1)], [way(10, [1])])
    assert topo.ways == ()
    assert topo.qa.incomplete_way_ids == ("10#0",)


# --- attribute pass-through / identity -------------------------------------


def test_way_attributes_survive_topology_building() -> None:
    attrs = road_attributes(
        {"highway": "secondary", "name": "基隆路車行地下道", "oneway": "yes",
         "layer": "-1", "tunnel": "yes"}
    )
    assert attrs is not None
    topo = build_topology([node(1), node(2)], [way(10, [1, 2], attrs=attrs)])
    kept = topo.ways[0].attributes
    assert (kept.highway, kept.name, kept.oneway, kept.layer, kept.tunnel) == (
        "secondary",
        "基隆路車行地下道",
        1,
        -1,
        True,
    )


def test_way_id_encodes_the_osm_id_and_the_clipped_part() -> None:
    # A way cut into pieces keeps its provenance: D10 conflation matches against
    # OSM ids, so the piece index must not overwrite the original id.
    topo = build_topology(
        [node(1), node(2), node(3), node(4)],
        [way(10, [1, 2], part=0), way(10, [3, 4], part=1)],
    )
    assert [w.way_id for w in topo.ways] == ["10#0", "10#1"]
    assert {w.osm_id for w in topo.ways} == {10}


def test_node_coordinates_are_carried_through_unchanged() -> None:
    topo = build_topology(
        [node(1, 306628.4, 2769511.5), node(2, 307976.6, 2770516.8)],
        [way(10, [1, 2])],
    )
    assert (topo.nodes[1].e, topo.nodes[1].n) == (306628.4, 2769511.5)
    assert (topo.nodes[2].e, topo.nodes[2].n) == (307976.6, 2770516.8)


def test_boundary_flag_is_carried_through() -> None:
    topo = build_topology([node(1, boundary=True), node(2)], [way(10, [1, 2])])
    assert topo.nodes[1].boundary is True
    assert topo.nodes[2].boundary is False


# --- empty ------------------------------------------------------------------


def test_empty_input_is_an_empty_topology() -> None:
    topo = build_topology([], [])
    assert topo.nodes == {}
    assert topo.ways == ()
    assert topo.qa.component_count == 0
    assert topo.qa.component_sizes == ()
    assert topo.qa.dangling_node_ids == ()
    assert topo.qa.incomplete_way_ids == ()


def test_topology_ways_are_immutable() -> None:
    topo = build_topology([node(1), node(2)], [way(10, [1, 2])])
    assert isinstance(topo.ways, tuple)
    with pytest.raises(Exception):
        topo.ways[0].osm_id = 5  # type: ignore[misc]
