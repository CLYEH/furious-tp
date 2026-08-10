"""Shared exam scaffolding for the OSM ETL (FTP-29).

Two kinds of input appear in this exam:

* the frozen **real** extract (`fixtures/xinyi_highways.osm`) — proves the ETL
  survives genuine OSM tag soup and genuine geometry;
* **synthetic** `.osm` XML built by :func:`write_osm` — proves individual rules
  at coordinates chosen to hit an exact boundary, which real data never does.

Synthetic fixtures are authored in EPSG:3826 and converted to WGS84 by
:func:`to_lonlat`, because every rule under test (containment, clipping) is
defined in EPSG:3826 (RFC D2 / `contracts/spec/grid.md`).
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from xml.sax.saxutils import escape

import pytest
from pyproj import Transformer

# --- paths -----------------------------------------------------------------

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
REAL_EXTRACT = FIXTURE_DIR / "xinyi_highways.osm"
# tests/etl/osm -> tests/etl -> tests -> scene-pipeline -> repo root
REPO_ROOT = Path(__file__).resolve().parents[4]
M1_AREA_FILE = REPO_ROOT / "contracts" / "constants" / "m1_area.json"

# M1 bbox, duplicated here ONLY so the exam can catch the production loader
# silently drifting from the contract (contracts/constants/m1_area.json is the
# canonical source; production code must never hardcode these).
M1_E_MIN, M1_N_MIN, M1_E_MAX, M1_N_MAX = 305500.0, 2767500.0, 309000.0, 2771000.0

# A single 500 m tile fully inside the real fixture's footprint, used for the
# crossing-way tests: tile (614, 5539) per contracts/spec/grid.md indexing.
TILE_E_MIN, TILE_N_MIN, TILE_E_MAX, TILE_N_MAX = 307000.0, 2769500.0, 307500.0, 2770000.0

_TO_LONLAT = Transformer.from_crs("EPSG:3826", "EPSG:4326", always_xy=True)


def to_lonlat(e: float, n: float) -> tuple[float, float]:
    """EPSG:3826 -> (lon, lat), for authoring synthetic fixtures."""
    return _TO_LONLAT.transform(e, n)


# --- synthetic .osm XML ----------------------------------------------------


def osm_xml(
    nodes: Iterable[tuple[int, float, float]],
    ways: Iterable[tuple[int, Sequence[int], Mapping[str, str]]],
) -> str:
    """Build an .osm XML document. Nodes are ``(id, lon, lat)``."""
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<osm version="0.6" generator="ftp-29-exam">',
    ]
    for node_id, lon, lat in nodes:
        parts.append(f'  <node id="{node_id}" lat="{lat!r}" lon="{lon!r}"/>')
    for way_id, refs, tags in ways:
        parts.append(f'  <way id="{way_id}">')
        parts.extend(f'    <nd ref="{ref}"/>' for ref in refs)
        parts.extend(
            f'    <tag k="{escape(k, {chr(34): "&quot;"})}" v="{escape(v, {chr(34): "&quot;"})}"/>'
            for k, v in tags.items()
        )
        parts.append("  </way>")
    parts.append("</osm>")
    return "\n".join(parts) + "\n"


def write_osm(
    path: Path,
    nodes: Iterable[tuple[int, float, float]],
    ways: Iterable[tuple[int, Sequence[int], Mapping[str, str]]],
) -> Path:
    path.write_text(osm_xml(nodes, ways), encoding="utf-8")
    return path


def write_projected_osm(
    path: Path,
    nodes: Iterable[tuple[int, float, float]],
    ways: Iterable[tuple[int, Sequence[int], Mapping[str, str]]],
) -> Path:
    """Same as :func:`write_osm` but nodes are ``(id, E, N)`` in EPSG:3826."""
    converted = [(node_id, *to_lonlat(e, n)) for node_id, e, n in nodes]
    return write_osm(path, converted, ways)


# --- HTTP doubles ----------------------------------------------------------


class FakeResponse:
    """Minimal stand-in for ``requests.Response`` used as a context manager.

    Only the surface the downloader is allowed to rely on: ``headers``,
    ``raise_for_status`` and ``iter_content``.
    """

    def __init__(
        self,
        chunks: Sequence[bytes],
        *,
        headers: Mapping[str, str] | None = None,
        error: Exception | None = None,
    ) -> None:
        self._chunks = list(chunks)
        self.headers = dict(headers or {})
        self._error = error
        self.closed = False

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *exc: object) -> None:
        self.closed = True

    def raise_for_status(self) -> None:
        if self._error is not None:
            raise self._error

    def iter_content(self, chunk_size: int = 1) -> Iterable[bytes]:
        yield from self._chunks


class FakeSession:
    """Records the calls the downloader makes and returns a queued response."""

    def __init__(self, response: FakeResponse | Exception) -> None:
        self._response = response
        self.calls: list[tuple[str, dict[str, object]]] = []

    def get(self, url: str, **kwargs: object) -> FakeResponse:
        self.calls.append((url, kwargs))
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --- pytest fixtures -------------------------------------------------------


@pytest.fixture
def real_extract() -> Path:
    assert REAL_EXTRACT.is_file(), f"frozen fixture missing: {REAL_EXTRACT}"
    return REAL_EXTRACT


@pytest.fixture
def m1_area_file() -> Path:
    assert M1_AREA_FILE.is_file(), f"contracts constant missing: {M1_AREA_FILE}"
    return M1_AREA_FILE
