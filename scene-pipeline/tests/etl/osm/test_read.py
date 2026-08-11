"""Exam: reading an OSM extract into plain records (FTP-29).

This is the only layer allowed to touch osmium, so it is also the only place a
malformed or truncated extract can be caught with a message that names the file.

The reader is two-pass on purpose (ways first, then only the nodes those ways
reference). A Taipei-wide extract holds millions of nodes of which the drivable
network needs a small fraction; keeping them all would trade a working pipeline
for an out-of-memory error on the real input.
"""

from __future__ import annotations

import pytest

from scene_pipeline.etl.osm import OsmReadError, read_extract

from .conftest import write_osm

NODES = [(1, 121.5650, 25.0350), (2, 121.5660, 25.0360), (3, 121.5670, 25.0370)]


def test_reads_nodes_and_ways(tmp_path) -> None:
    path = write_osm(
        tmp_path / "in.osm",
        NODES,
        [(10, [1, 2, 3], {"highway": "residential", "name": "松勇路"})],
    )
    extract = read_extract(path)

    assert [w.id for w in extract.ways] == [10]
    assert extract.ways[0].node_ids == (1, 2, 3)
    assert extract.ways[0].tags["name"] == "松勇路"
    assert set(extract.nodes) == {1, 2, 3}
    assert extract.nodes[1].lon == pytest.approx(121.5650)
    assert extract.nodes[1].lat == pytest.approx(25.0350)


def test_ways_without_a_highway_tag_are_skipped_by_default(tmp_path) -> None:
    path = write_osm(
        tmp_path / "in.osm",
        NODES,
        [(10, [1, 2], {"highway": "service"}), (11, [2, 3], {"building": "yes"})],
    )
    extract = read_extract(path)
    assert [w.id for w in extract.ways] == [10]


def test_only_nodes_referenced_by_kept_ways_are_loaded(tmp_path) -> None:
    # The memory guarantee, asserted rather than assumed: node 3 belongs solely
    # to the building way and must never enter the node table.
    path = write_osm(
        tmp_path / "in.osm",
        NODES,
        [(10, [1, 2], {"highway": "service"}), (11, [2, 3], {"building": "yes"})],
    )
    extract = read_extract(path)
    assert set(extract.nodes) == {1, 2}


def test_custom_way_filter_is_honoured(tmp_path) -> None:
    path = write_osm(
        tmp_path / "in.osm",
        NODES,
        [(10, [1, 2], {"highway": "service"}), (11, [2, 3], {"waterway": "stream"})],
    )
    extract = read_extract(path, keep_way=lambda tags: "waterway" in tags)
    assert [w.id for w in extract.ways] == [11]


def test_way_order_is_preserved(tmp_path) -> None:
    # Output ordering must be a function of the input, not of dict iteration:
    # the intermediate file is diffed between runs during incremental rebuilds.
    path = write_osm(
        tmp_path / "in.osm",
        NODES,
        [(30, [1, 2], {"highway": "service"}), (20, [2, 3], {"highway": "service"})],
    )
    assert [w.id for w in read_extract(path).ways] == [30, 20]


def test_tags_are_read_verbatim(tmp_path) -> None:
    tags = {"highway": "secondary", "oneway": "-1", "layer": "-1", "tunnel": "yes"}
    path = write_osm(tmp_path / "in.osm", NODES, [(10, [1, 2], tags)])
    assert dict(read_extract(path).ways[0].tags) == tags


def test_empty_extract_reads_as_empty(tmp_path) -> None:
    path = write_osm(tmp_path / "in.osm", [], [])
    extract = read_extract(path)
    assert extract.ways == ()
    assert extract.nodes == {}


def test_missing_file_names_the_path(tmp_path) -> None:
    missing = tmp_path / "absent.osm"
    with pytest.raises(OsmReadError) as excinfo:
        read_extract(missing)
    assert str(missing) in str(excinfo.value)


def test_corrupt_file_names_the_path(tmp_path) -> None:
    # WHY: this is the downstream face of a truncated download. Without the
    # file name in the message the operator gets an osmium error about bytes.
    path = tmp_path / "broken.osm"
    path.write_text("<osm><way id='1'><nd ref=", encoding="utf-8")
    with pytest.raises(OsmReadError) as excinfo:
        read_extract(path)
    assert str(path) in str(excinfo.value)


def test_truncated_pbf_is_reported_as_a_read_error(tmp_path) -> None:
    path = tmp_path / "truncated.osm.pbf"
    path.write_bytes(b"\x00\x00\x00\x0dnot really a pbf")
    with pytest.raises(OsmReadError) as excinfo:
        read_extract(path)
    assert str(path) in str(excinfo.value)


def test_unsupported_extension_is_rejected(tmp_path) -> None:
    path = tmp_path / "extract.txt"
    path.write_text("whatever", encoding="utf-8")
    with pytest.raises(OsmReadError) as excinfo:
        read_extract(path)
    assert ".osm.pbf" in str(excinfo.value)


# --- the frozen real extract ------------------------------------------------


def test_real_extract_counts(real_extract) -> None:
    # Counted independently from the fixture with ElementTree before this exam
    # was written: 491 of the 493 ways carry a highway tag, and those ways
    # reference 1612 of the 1757 nodes.
    extract = read_extract(real_extract)
    assert len(extract.ways) == 491
    assert len(extract.nodes) == 1612


def test_real_extract_keeps_multi_valued_tag_soup(real_extract) -> None:
    extract = read_extract(real_extract)
    tunnels = [w for w in extract.ways if w.tags.get("tunnel") == "building_passage"]
    assert len(tunnels) == 18  # real data, counted independently
