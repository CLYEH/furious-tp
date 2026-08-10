"""Reading the M1 area / grid contracts (RFC D2, FTP-22 output).

The ETL must take its bbox from `contracts/constants/m1_area.json` rather than
carrying its own copy of the numbers — a second copy is a second thing to drift.
"""

from __future__ import annotations

import json

import pytest
from scene_pipeline.etl.dtm.area import (
    default_area_path,
    default_grid_path,
    find_contracts_dir,
    load_area,
    load_tile_size_m,
)
from scene_pipeline.etl.dtm.errors import DtmContractError

from .conftest import CONTRACTS_DIR, M1_E_MAX, M1_E_MIN, M1_N_MAX, M1_N_MIN


def test_contracts_dir_is_discovered_from_the_installed_package():
    assert find_contracts_dir() == CONTRACTS_DIR


def test_default_paths_point_at_the_contract_files():
    assert default_area_path() == CONTRACTS_DIR / "constants" / "m1_area.json"
    assert default_grid_path() == CONTRACTS_DIR / "constants" / "grid.json"


def test_load_area_returns_the_frozen_m1_bbox():
    area = load_area()
    assert area.crs == "EPSG:3826"
    assert area.bbox.e_min == M1_E_MIN
    assert area.bbox.e_max == M1_E_MAX
    assert area.bbox.n_min == M1_N_MIN
    assert area.bbox.n_max == M1_N_MAX


def test_load_area_carries_the_contract_spec_version(m1_area_doc):
    assert load_area().spec_version == m1_area_doc["spec_version"]


def test_load_tile_size_comes_from_the_grid_contract(grid_doc):
    assert load_tile_size_m() == float(grid_doc["tile_size_m"])


def test_area_in_another_crs_is_refused(tmp_path, m1_area_doc):
    """RFC D2 fixes EPSG:3826 for the whole ETL; silently honouring another
    CRS here would put every downstream tile in the wrong frame."""
    doc = dict(m1_area_doc, crs="EPSG:4326")
    path = tmp_path / "area.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(DtmContractError, match="EPSG:3826"):
        load_area(path)


def test_missing_area_file_names_the_path(tmp_path):
    missing = tmp_path / "nope" / "m1_area.json"
    with pytest.raises(DtmContractError, match="m1_area.json"):
        load_area(missing)


def test_malformed_area_json_names_the_path(tmp_path):
    path = tmp_path / "area.json"
    path.write_text("{ this is not json", encoding="utf-8")
    with pytest.raises(DtmContractError, match="area.json"):
        load_area(path)


@pytest.mark.parametrize("missing_key", ["e_min", "e_max", "n_min", "n_max"])
def test_area_missing_a_bbox_bound_is_refused(tmp_path, m1_area_doc, missing_key):
    doc = json.loads(json.dumps(m1_area_doc))
    del doc["bbox"][missing_key]
    path = tmp_path / "area.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(DtmContractError, match=missing_key):
        load_area(path)


def test_area_with_non_numeric_bound_is_refused(tmp_path, m1_area_doc):
    doc = json.loads(json.dumps(m1_area_doc))
    doc["bbox"]["e_min"] = "305500"
    path = tmp_path / "area.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(DtmContractError):
        load_area(path)
