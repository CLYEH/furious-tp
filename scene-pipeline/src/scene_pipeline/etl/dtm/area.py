"""Reading the area / grid contracts.

The bbox and the tile size are contract values (`contracts/`, FTP-22), not
pipeline values. This module reads them; it never carries a second copy of the
numbers, because a second copy is a second thing to drift.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .errors import DtmContractError

#: RFC D2 fixes one projected CRS for the whole ETL.
CONTRACT_CRS = "EPSG:3826"

_BBOX_KEYS = ("e_min", "n_min", "e_max", "n_max")


@dataclass(frozen=True)
class Bbox:
    """An axis-aligned box in `CONTRACT_CRS` metres."""

    e_min: float
    n_min: float
    e_max: float
    n_max: float


@dataclass(frozen=True)
class Area:
    """The area contract: which box, in which CRS, at which spec version."""

    crs: str
    bbox: Bbox
    spec_version: str


def find_contracts_dir(start: Path | None = None) -> Path:
    """Walk up from `start` (default: this file) to the repo's `contracts/`."""
    here = (start or Path(__file__)).resolve()
    for candidate in here.parents:
        contracts = candidate / "contracts"
        if (contracts / "constants" / "m1_area.json").is_file():
            return contracts
    raise DtmContractError(
        f"could not locate contracts/constants/m1_area.json above {here}; "
        "run from a checkout of the repository or pass an explicit --area"
    )


def default_area_path() -> Path:
    return find_contracts_dir() / "constants" / "m1_area.json"


def default_grid_path() -> Path:
    return find_contracts_dir() / "constants" / "grid.json"


def _read_json(path: Path, what: str) -> dict:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise DtmContractError(f"cannot read {what} contract {path}: {exc}") from exc
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as exc:
        raise DtmContractError(f"{what} contract {path} is not valid JSON: {exc}") from exc
    if not isinstance(doc, dict):
        raise DtmContractError(f"{what} contract {path} must be a JSON object")
    return doc


def _number(doc: dict, key: str, path: Path) -> float:
    if key not in doc:
        raise DtmContractError(f"area contract {path} is missing bbox.{key}")
    value = doc[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DtmContractError(
            f"area contract {path}: bbox.{key} must be a number, got {value!r}"
        )
    return float(value)


def load_area(path: Path | None = None) -> Area:
    """Load the area contract, refusing anything that is not `CONTRACT_CRS`."""
    path = Path(path) if path is not None else default_area_path()
    doc = _read_json(path, "area")

    crs = doc.get("crs")
    if crs != CONTRACT_CRS:
        raise DtmContractError(
            f"area contract {path} declares crs {crs!r}; this ETL only produces "
            f"{CONTRACT_CRS} (RFC D2), so honouring another CRS here would put every "
            "downstream tile in the wrong frame"
        )

    bbox_doc = doc.get("bbox")
    if not isinstance(bbox_doc, dict):
        raise DtmContractError(f"area contract {path} is missing a bbox object")
    bounds = {key: _number(bbox_doc, key, path) for key in _BBOX_KEYS}

    return Area(crs=crs, bbox=Bbox(**bounds), spec_version=str(doc.get("spec_version", "")))


def load_tile_size_m(path: Path | None = None) -> float:
    """Load `tile_size_m` from the grid contract."""
    path = Path(path) if path is not None else default_grid_path()
    doc = _read_json(path, "grid")
    value = doc.get("tile_size_m")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DtmContractError(
            f"grid contract {path}: tile_size_m must be a number, got {value!r}"
        )
    return float(value)
