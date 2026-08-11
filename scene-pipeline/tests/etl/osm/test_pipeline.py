"""Exam: the OSM ETL end to end (FTP-29).

Covers AC1 (單一指令執行完整 OSM ETL), AC2 (來源隔離 + attribution 紀錄檔) and
the happy-path verification step (信義 bbox 輸出含預期主要道路,固定抽樣清單).

Test-coverage categories for this ticket:

* happy — the frozen real Xinyi extract through the whole ETL, plus the same
  run driven as a real subprocess (`python -m scene_pipeline.etl.osm`).
* boundary — empty extract, an area containing no data, a real 500 m tile that
  12 real ways cross, and a way re-entering the area.
* error — unreadable source, unusable bbox, contradictory flags: asserted on
  the operator-visible stderr and exit code, not on the exception type.
* permissions — **N/A**, as declared on the ticket: this is an offline batch
  tool with no authorisation model. Its only privilege interaction is ordinary
  filesystem permission on `--out`, which the OS reports directly.
* concurrency — **N/A**, as declared on the ticket: one process, one output
  directory, no shared mutable state. The related risk that *is* real —
  non-deterministic output between runs — is covered by
  `test_repeated_runs_produce_identical_content`.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from scene_pipeline.etl.osm import BBox, main, run_osm_etl
from scene_pipeline.etl.osm.read import read_extract
from scene_pipeline.etl.osm.sources import ATTRIBUTION_FILENAME, ODBL_URL, OSM_ATTRIBUTION

from .conftest import (
    M1_E_MAX,
    M1_E_MIN,
    M1_N_MAX,
    M1_N_MIN,
    TILE_E_MAX,
    TILE_E_MIN,
    TILE_N_MAX,
    TILE_N_MIN,
    FakeResponse,
    FakeSession,
    to_easting_northing,
    write_osm,
    write_projected_osm,
)

M1 = BBox(e_min=M1_E_MIN, n_min=M1_N_MIN, e_max=M1_E_MAX, n_max=M1_N_MAX)
TILE = BBox(e_min=TILE_E_MIN, n_min=TILE_N_MIN, e_max=TILE_E_MAX, n_max=TILE_N_MAX)

# The fixed sample list from the ticket's happy-path verification step: major
# named roads that must survive the whole ETL for the信義 bbox.
SAMPLE_ROADS = [
    "信義路五段",
    "基隆路一段",
    "市府路",
    "松高路",
    "松仁路",
    "松壽路",
    "松智路",
    "仁愛路四段",
]


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture
def m1_run(tmp_path, real_extract):
    result = run_osm_etl(str(real_extract), tmp_path / "osm", M1)
    return result, load(result.output_path)


# --- happy path on real data ------------------------------------------------


def test_sample_roads_all_survive(m1_run) -> None:
    _result, doc = m1_run
    names = {w["name"] for w in doc["ways"] if w.get("name")}
    assert set(SAMPLE_ROADS) <= names


def test_way_and_node_counts_match_the_frozen_fixture(m1_run) -> None:
    # Counted independently from the fixture before this exam existed: 144 of
    # the 491 highway ways are drivable, and they reference 593 nodes. Exact
    # numbers, so that a filter quietly widening or narrowing is a failure.
    _result, doc = m1_run
    assert len(doc["ways"]) == 144
    assert len(doc["nodes"]) == 593


def test_pedestrian_ways_are_absent(m1_run) -> None:
    _result, doc = m1_run
    classes = {w["class"] for w in doc["ways"]}
    assert classes.isdisjoint({"footway", "steps", "cycleway", "path", "pedestrian", "corridor"})


def test_building_ways_are_absent(m1_run) -> None:
    # The two building ways kept in the fixture as negative controls.
    _result, doc = m1_run
    assert {137077752, 137077760}.isdisjoint({w["osm_id"] for w in doc["ways"]})


def test_real_tunnel_keeps_its_tunnel_and_layer(m1_run) -> None:
    # 基隆路車行地下道 is tunnel=yes, layer=-1 in the real extract. M2 needs the
    # layer to separate grade-crossing roads, and D9 needs the tunnel flag to
    # keep terrain off the roadway.
    _result, doc = m1_run
    tunnels = [w for w in doc["ways"] if w.get("name") == "基隆路車行地下道"]
    assert tunnels
    assert any(w["tunnel"] and w["layer"] == -1 for w in tunnels)


def test_every_bridge_in_the_fixture_is_pedestrian_and_therefore_absent(m1_run) -> None:
    # Ground truth, recounted from the frozen fixture: all 23 `bridge` ways in
    # it are footway/steps — pedestrian overpasses — so the drivable network
    # correctly contains none. (The exam first asserted the opposite, from the
    # all-highway count; the count was wrong, not the filter.) The end-to-end
    # proof that a drivable bridge does survive is the staged case below.
    _result, doc = m1_run
    assert not any(w["bridge"] for w in doc["ways"])


def test_bridge_and_tunnel_flags_survive_the_whole_etl(tmp_path) -> None:
    # AC3 for `bridge`, staged because the frozen fixture has no drivable
    # bridge: a viaduct on layer 1 must arrive with both facts intact, or M2's
    # grade separation has nothing to separate on.
    path = write_projected_osm(
        tmp_path / "bridge.osm",
        [(1, 307100.0, 2769600.0), (2, 307200.0, 2769600.0), (3, 307300.0, 2769650.0)],
        [
            (10, [1, 2], {"highway": "primary", "bridge": "viaduct", "layer": "1"}),
            (11, [2, 3], {"highway": "primary", "tunnel": "building_passage", "layer": "-1"}),
        ],
    )
    result = run_osm_etl(str(path), tmp_path / "osm", TILE)
    ways = {w["osm_id"]: w for w in load(result.output_path)["ways"]}
    assert (ways[10]["bridge"], ways[10]["tunnel"], ways[10]["layer"]) == (True, False, 1)
    assert (ways[11]["bridge"], ways[11]["tunnel"], ways[11]["layer"]) == (False, True, -1)


def test_oneway_values_are_normalised(m1_run) -> None:
    _result, doc = m1_run
    assert {w["oneway"] for w in doc["ways"]} <= {0, 1}
    assert any(w["oneway"] == 1 for w in doc["ways"])
    assert any(w["oneway"] == 0 for w in doc["ways"])


def test_nodes_carry_degrees_consistent_with_the_ways(m1_run) -> None:
    _result, doc = m1_run
    segments = sum(len(w["nodes"]) - 1 for w in doc["ways"])
    assert sum(n["degree"] for n in doc["nodes"]) == 2 * segments


def test_every_way_node_exists_in_the_node_table(m1_run) -> None:
    # A dangling reference here is what the road compiler would crash on.
    _result, doc = m1_run
    known = {n["id"] for n in doc["nodes"]}
    for way in doc["ways"]:
        assert set(way["nodes"]) <= known


def test_all_coordinates_are_projected_to_epsg3826(m1_run) -> None:
    # RFC D2: ETL is EPSG:3826 throughout. Leaking WGS84 degrees would show up
    # as coordinates around 121 / 25 instead of metres.
    _result, doc = m1_run
    assert doc["crs"] == "EPSG:3826"
    for node in doc["nodes"]:
        assert M1_E_MIN <= node["e"] <= M1_E_MAX
        assert M1_N_MIN <= node["n"] <= M1_N_MAX


def test_qa_block_reports_connectivity(m1_run) -> None:
    _result, doc = m1_run
    qa = doc["qa"]
    assert qa["component_count"] >= 1
    assert sum(qa["component_sizes"]) == len(doc["nodes"])
    assert qa["way_count"] == len(doc["ways"])
    assert qa["node_count"] == len(doc["nodes"])


# --- AC2: source isolation and attribution ----------------------------------


def test_isolated_directory_layout(tmp_path, real_extract) -> None:
    out = tmp_path / "osm"
    result = run_osm_etl(str(real_extract), out, M1)
    written = sorted(
        str(p.relative_to(out)).replace("\\", "/") for p in out.rglob("*") if p.is_file()
    )
    assert written == [
        "ATTRIBUTION.md",
        "intermediate/roads.topology.json",
        "source/xinyi_highways.osm",
    ]
    assert result.output_path == out / "intermediate" / "roads.topology.json"
    assert result.attribution_path == out / "ATTRIBUTION.md"


def test_nothing_is_written_outside_the_isolated_directory(tmp_path, real_extract) -> None:
    # AC2 exists because ODbL share-alike follows the data: if OSM-derived
    # intermediates leak into a shared directory, the perimeter is no longer a
    # directory anyone can point at.
    out = tmp_path / "osm"
    neighbour = tmp_path / "taipei-gis"
    neighbour.mkdir()
    run_osm_etl(str(real_extract), out, M1)
    assert list(neighbour.iterdir()) == []
    assert sorted(p.name for p in tmp_path.iterdir()) == ["osm", "taipei-gis"]


def test_source_extract_is_kept_verbatim(tmp_path, real_extract) -> None:
    out = tmp_path / "osm"
    run_osm_etl(str(real_extract), out, M1)
    assert (out / "source" / "xinyi_highways.osm").read_bytes() == real_extract.read_bytes()


def test_attribution_file_is_written(tmp_path, real_extract) -> None:
    out = tmp_path / "osm"
    result = run_osm_etl(str(real_extract), out, M1)
    text = result.attribution_path.read_text(encoding="utf-8")
    assert "OpenStreetMap contributors" in text
    assert "opendatacommons.org/licenses/odbl" in text


def test_output_document_carries_licence_and_provenance(m1_run) -> None:
    # LICENSING.md, road tiles obligation 2 (Databases safe harbour): the notice
    # travels with the database body — which includes this intermediate file,
    # not only the human-readable sidecar.
    result, doc = m1_run
    assert "OpenStreetMap contributors" in doc["license"]["attribution"]
    assert "odbl" in doc["license"]["url"].lower()
    assert doc["source"]["sha256"] == result.source.sha256
    assert doc["source"]["size_bytes"] == result.source.size_bytes
    assert doc["source"]["retrieved_at"] == result.source.retrieved_at
    assert doc["bbox"] == {
        "e_min": M1_E_MIN,
        "n_min": M1_N_MIN,
        "e_max": M1_E_MAX,
        "n_max": M1_N_MAX,
    }


# --- boundary: clipping against a real 500 m tile ---------------------------


@pytest.fixture
def tile_run(tmp_path, real_extract):
    result = run_osm_etl(str(real_extract), tmp_path / "osm", TILE)
    return result, load(result.output_path)


def test_clipped_output_stays_within_the_area(tile_run) -> None:
    _result, doc = tile_run
    for node in doc["nodes"]:
        assert TILE_E_MIN <= node["e"] <= TILE_E_MAX
        assert TILE_N_MIN <= node["n"] <= TILE_N_MAX


def test_boundary_nodes_sit_exactly_on_an_edge(tile_run) -> None:
    # Exactness, not tolerance: contracts/spec/grid.md §接縫規則 clause 1 requires
    # boundary vertices shared by neighbouring areas to agree bit-for-bit, which
    # only holds if the cut snaps the crossed axis to the boundary value.
    _result, doc = tile_run
    boundary = [n for n in doc["nodes"] if n["boundary"]]
    assert boundary
    for node in boundary:
        assert (
            node["e"] in (TILE_E_MIN, TILE_E_MAX) or node["n"] in (TILE_N_MIN, TILE_N_MAX)
        ), node


def test_the_twelve_crossing_ways_are_cut(tile_run) -> None:
    # Counted independently from the fixture: exactly 12 drivable ways have
    # nodes on both sides of this tile's edges.
    _result, doc = tile_run
    cut_osm_ids = {w["osm_id"] for w in doc["ways"] if w["cut_start"] or w["cut_end"]}
    assert len(cut_osm_ids) >= 12


def test_interior_ways_are_not_marked_as_cut(tile_run) -> None:
    _result, doc = tile_run
    assert any(not w["cut_start"] and not w["cut_end"] for w in doc["ways"])


def test_boundary_cuts_do_not_show_up_as_dangling(tile_run) -> None:
    _result, doc = tile_run
    boundary_ids = {n["id"] for n in doc["nodes"] if n["boundary"]}
    assert boundary_ids  # the tile really is crossed
    assert boundary_ids.isdisjoint(set(doc["qa"]["dangling_node_ids"]))


def test_synthetic_node_ids_cannot_collide_with_osm_ids(tile_run) -> None:
    # OSM ids are positive; cut nodes are invented by us. Overlapping id spaces
    # would silently merge a real junction with a boundary cut.
    _result, doc = tile_run
    for node in doc["nodes"]:
        assert (node["id"] < 0) == node["boundary"]


def test_way_re_entering_the_area_is_split_into_parts(tmp_path) -> None:
    # No real way in the frozen fixture re-enters this tile, so the case is
    # staged: out -> in -> out -> in -> out, which must yield two parts of the
    # same OSM way rather than one way short-cutting across the outside.
    path = write_projected_osm(
        tmp_path / "reenter.osm",
        [
            (1, TILE_E_MIN - 100, 2769600.0),
            (2, TILE_E_MIN + 100, 2769600.0),
            (3, TILE_E_MIN - 100, 2769700.0),
            (4, TILE_E_MIN + 100, 2769800.0),
            (5, TILE_E_MIN - 100, 2769900.0),
        ],
        [(10, [1, 2, 3, 4, 5], {"highway": "residential", "name": "折返路"})],
    )
    result = run_osm_etl(str(path), tmp_path / "osm", TILE)
    doc = load(result.output_path)
    parts = [w for w in doc["ways"] if w["osm_id"] == 10]
    assert len(parts) == 2
    assert {w["id"] for w in parts} == {"10#0", "10#1"}
    assert all(w["name"] == "折返路" for w in parts)  # attributes ride along


def test_a_real_node_on_the_min_edge_keeps_its_osm_id(tmp_path) -> None:
    # Layer 2 review, round 1, B1 — the same rule as
    # test_vertex_on_the_min_edge_keeps_its_identity_when_it_coincides_with_the_cut
    # in test_bbox.py, but asserted at the layer that *consumes* the decision,
    # because that is where the damage is visible: `_place` turns index None
    # into a synthetic NEGATIVE id flagged boundary=true, and D10 conflation
    # (FTP-31) matches on OSM ids, so a node that loses its id becomes invisible
    # to it. `qa.dangling_node_ids` also stops considering it, which is the
    # difference between "the source data has a dead end here" and silence.
    #
    # The bbox is derived from the node instead of the other way round: OSM
    # stores coordinates as 1e-7 degrees, so a node authored at a round E value
    # comes back ~1 cm off and never lands exactly on the edge. Deriving the
    # edge from the projected node is exact by construction — and it is also
    # what the re-clip case looks like in practice, where the geometry being
    # clipped was produced by an earlier pass of this very clipper.
    lon_edge, lat = 121.5670000, 25.0330000  # authored on OSM's 1e-7 lattice
    lon_west, lon_in = 121.5650000, 121.5690000
    path = write_osm(
        tmp_path / "edge.osm",
        [(1001, lon_west, lat), (1002, lon_edge, lat), (1003, lon_in, lat)],
        [(10, [1001, 1002, 1003], {"highway": "residential", "name": "邊界路"})],
    )
    extract = read_extract(path)
    edge_e, edge_n = to_easting_northing(extract.nodes[1002].lon, extract.nodes[1002].lat)
    bbox = BBox(e_min=edge_e, n_min=edge_n - 500.0, e_max=edge_e + 500.0, n_max=edge_n + 500.0)

    result = run_osm_etl(str(path), tmp_path / "osm", bbox)
    doc = load(result.output_path)

    node_ids = {n["id"] for n in doc["nodes"]}
    assert 1002 in node_ids, "the node on the min edge lost its OSM identity"
    assert not any(n["id"] < 0 for n in doc["nodes"]), "it was replaced by a synthetic cut"
    node = next(n for n in doc["nodes"] if n["id"] == 1002)
    assert node["boundary"] is False
    assert node["e"] == bbox.e_min  # it really is on the edge, not merely near it
    way = doc["ways"][0]
    assert way["nodes"][0] == 1002
    assert way["cut_start"] is False
    # The QA consequence, stated as its own assertion: a degree-1 real node is a
    # dangling end and must be reported as one.
    assert 1002 in doc["qa"]["dangling_node_ids"]


def test_oneway_reverse_reverses_the_geometry(tmp_path) -> None:
    # oneway=-1 has no instance in the frozen fixture, so it is staged here:
    # the node order must come out reversed and the flag normalised to 1.
    path = write_projected_osm(
        tmp_path / "reverse.osm",
        [(1, 307100.0, 2769600.0), (2, 307200.0, 2769600.0), (3, 307300.0, 2769600.0)],
        [(10, [1, 2, 3], {"highway": "secondary", "oneway": "-1"})],
    )
    result = run_osm_etl(str(path), tmp_path / "osm", TILE)
    doc = load(result.output_path)
    way = doc["ways"][0]
    assert way["oneway"] == 1
    assert way["reversed"] is True
    emitted = [next(n for n in doc["nodes"] if n["id"] == i)["e"] for i in way["nodes"]]
    assert emitted == sorted(emitted, reverse=True)  # runs east -> west now


# --- boundary: empty inputs -------------------------------------------------


def test_extract_without_ways_produces_an_empty_but_valid_document(tmp_path) -> None:
    path = write_projected_osm(tmp_path / "empty.osm", [], [])
    result = run_osm_etl(str(path), tmp_path / "osm", TILE)
    doc = load(result.output_path)
    assert doc["ways"] == []
    assert doc["nodes"] == []
    assert doc["qa"]["component_count"] == 0


def test_area_with_no_data_is_an_empty_result_not_a_failure(tmp_path, real_extract) -> None:
    # WHY: "no roads here" and "the ETL fell over" must not look the same to the
    # operator, or an accidentally empty tile ships as if it were fine.
    far_away = BBox(e_min=200000.0, n_min=2500000.0, e_max=200500.0, n_max=2500500.0)
    result = run_osm_etl(str(real_extract), tmp_path / "osm", far_away)
    doc = load(result.output_path)
    assert doc["ways"] == []
    assert result.attribution_path.is_file()  # obligations still discharged


def test_repeated_runs_produce_identical_content(tmp_path, real_extract) -> None:
    # Incremental rebuilds (Story FTP-8) diff this file; iteration order leaking
    # into it would make every tile look changed on every run.
    first = load(run_osm_etl(str(real_extract), tmp_path / "a", M1).output_path)
    second = load(run_osm_etl(str(real_extract), tmp_path / "b", M1).output_path)
    for section in ("nodes", "ways", "qa", "bbox"):
        assert first[section] == second[section]


# --- AC1: one command -------------------------------------------------------


def test_module_is_runnable_as_a_single_command(tmp_path, real_extract) -> None:
    # AC1 in its literal form: a real subprocess, no in-process shortcuts.
    out = tmp_path / "osm"
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "scene_pipeline.etl.osm",
            "--source",
            str(real_extract),
            "--out",
            str(out),
            "--bbox",
            str(M1_E_MIN),
            str(M1_N_MIN),
            str(M1_E_MAX),
            str(M1_N_MAX),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert proc.returncode == 0, proc.stderr
    assert (out / "intermediate" / "roads.topology.json").is_file()
    assert (out / "ATTRIBUTION.md").is_file()


def test_cli_accepts_the_contracts_area_file(tmp_path, real_extract, m1_area_file) -> None:
    # The M1 bbox is not retyped on the command line; it is read from the
    # contract that froze it.
    out = tmp_path / "osm"
    args = ["--source", str(real_extract), "--out", str(out), "--area", str(m1_area_file)]
    assert main(args) == 0
    doc = load(out / "intermediate" / "roads.topology.json")
    assert doc["bbox"]["e_min"] == M1_E_MIN
    assert len(doc["ways"]) == 144


def test_cli_reports_a_summary_on_success(tmp_path, real_extract, capsys) -> None:
    out = tmp_path / "osm"
    exit_code = main(
        [
            "--source", str(real_extract),
            "--out", str(out),
            "--bbox", str(M1_E_MIN), str(M1_N_MIN), str(M1_E_MAX), str(M1_N_MAX),
        ]
    )
    assert exit_code == 0
    printed = capsys.readouterr().out
    assert str(out) in printed
    assert "144" in printed  # ways written


def test_cli_downloads_when_the_source_is_a_url(tmp_path, real_extract) -> None:
    # The full one-command path including acquisition, with the network faked
    # at the session seam.
    session = FakeSession(FakeResponse([real_extract.read_bytes()]))
    out = tmp_path / "osm"
    result = run_osm_etl(
        "https://download.geofabrik.de/asia/taiwan-latest.osm", out, M1, session=session
    )
    assert session.calls  # it really went through the downloader
    assert len(load(result.output_path)["ways"]) == 144
    assert (out / "source" / "taiwan-latest.osm").is_file()


# --- error paths: what the operator sees ------------------------------------


def run_cli(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "scene_pipeline.etl.osm", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def test_missing_source_exits_with_a_clean_message(tmp_path) -> None:
    proc = run_cli(
        ["--source", str(tmp_path / "absent.osm"), "--out", str(tmp_path / "osm"),
         "--bbox", "0", "0", "100", "100"]
    )
    assert proc.returncode == 2
    assert "absent.osm" in proc.stderr
    assert "Traceback" not in proc.stderr  # a stack trace is not a user message


def test_corrupt_source_exits_with_a_clean_message(tmp_path) -> None:
    bad = tmp_path / "broken.osm"
    bad.write_text("<osm><way id='1'><nd ref=", encoding="utf-8")
    proc = run_cli(
        ["--source", str(bad), "--out", str(tmp_path / "osm"), "--bbox", "0", "0", "100", "100"]
    )
    assert proc.returncode == 2
    assert "broken.osm" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_inverted_bbox_exits_with_a_clean_message(tmp_path, real_extract) -> None:
    proc = run_cli(
        ["--source", str(real_extract), "--out", str(tmp_path / "osm"),
         "--bbox", "100", "0", "0", "100"]
    )
    assert proc.returncode == 2
    assert "bbox" in proc.stderr.lower()
    assert "Traceback" not in proc.stderr


def test_area_and_bbox_are_mutually_exclusive(tmp_path, real_extract, m1_area_file) -> None:
    proc = run_cli(
        ["--source", str(real_extract), "--out", str(tmp_path / "osm"),
         "--area", str(m1_area_file), "--bbox", "0", "0", "100", "100"]
    )
    assert proc.returncode == 2


def test_area_or_bbox_is_required(tmp_path, real_extract) -> None:
    proc = run_cli(["--source", str(real_extract), "--out", str(tmp_path / "osm")])
    assert proc.returncode == 2
    assert "--area" in proc.stderr and "--bbox" in proc.stderr


def test_download_failure_exits_with_a_clean_message(tmp_path) -> None:
    # `.invalid` never resolves (RFC 2606), so this fails the same way with or
    # without a network: an unreachable mirror must read as one line, not as a
    # requests stack trace.
    proc = run_cli(
        ["--source", "https://mirror.invalid/taiwan.osm.pbf", "--out", str(tmp_path / "osm"),
         "--bbox", "0", "0", "100", "100"]
    )
    assert proc.returncode == 2
    assert "mirror.invalid" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_no_output_is_written_when_the_run_fails(tmp_path) -> None:
    # A failed run must not leave a half-built intermediate that the next stage
    # would happily consume.
    out = tmp_path / "osm"
    bad = tmp_path / "broken.osm"
    bad.write_text("<osm><way id='1'><nd ref=", encoding="utf-8")
    run_cli(["--source", str(bad), "--out", str(out), "--bbox", "0", "0", "100", "100"])
    assert not (out / "intermediate" / "roads.topology.json").exists()


def test_a_run_that_dies_while_parsing_still_leaves_the_attribution(tmp_path) -> None:
    # Layer 2 review, round 1, S4. The failed run above DOES leave the extract
    # in <out>/source/ — that is deliberate, it is the acquired bytes. AC2's
    # whole argument is that source isolation means a directory you can point
    # at; a directory holding OSM bytes and no licence notice is precisely the
    # state that argument exists to prevent. So the notice has to be written as
    # soon as the bytes land, not after the topology succeeds.
    out = tmp_path / "osm"
    bad = tmp_path / "broken.osm"
    bad.write_text("<osm><way id='1'><nd ref=", encoding="utf-8")
    proc = run_cli(
        ["--source", str(bad), "--out", str(out), "--bbox", "0", "0", "100", "100"]
    )
    assert proc.returncode == 2
    assert (out / "source" / "broken.osm").exists()  # the bytes are on disk...
    attribution = out / ATTRIBUTION_FILENAME
    assert attribution.exists(), "OSM bytes on disk with no ODbL notice beside them"
    text = attribution.read_text(encoding="utf-8")
    assert OSM_ATTRIBUTION in text
    assert ODBL_URL in text
    assert "broken.osm" in text  # and it describes THESE bytes


def test_re_running_against_the_extract_the_last_run_preserved(tmp_path) -> None:
    # Layer 2 review, round 1, S2. Pointing --source at <out>/source/<extract>
    # is the obvious way to re-clip without re-downloading 325 MB, and it makes
    # copyfile's source and destination the same path. That raised a raw
    # shutil.SameFileError: exit code 1 and a traceback, against a README that
    # promises exit 2 and a single line. The contract is what is under test —
    # whether the re-run is supported is a separate question; what must never
    # happen is the operator getting a stack trace for it.
    out = tmp_path / "osm"
    source = tmp_path / "seed.osm"
    write_projected_osm(
        source,
        [(1, 307100.0, 2769600.0), (2, 307200.0, 2769600.0)],
        [(10, [1, 2], {"highway": "residential"})],
    )
    first = run_cli(
        ["--source", str(source), "--out", str(out), "--bbox", "0", "0", "100", "100"]
    )
    assert first.returncode == 0
    preserved = out / "source" / "seed.osm"
    assert preserved.is_file()

    again = run_cli(
        ["--source", str(preserved), "--out", str(out), "--bbox", "0", "0", "100", "100"]
    )
    assert again.returncode == 2, again.stderr
    assert "Traceback" not in again.stderr
    assert "seed.osm" in again.stderr  # it names the file the operator gave it
    assert again.stderr.strip().startswith("error:")
