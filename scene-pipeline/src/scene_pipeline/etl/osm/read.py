"""Reading an OSM extract into plain records.

The only module that touches osmium, so it is also the only place a damaged
extract can be reported with the file name attached.

The read is two-pass — ways first, then only the nodes those ways reference.
A Taipei-wide extract holds millions of nodes of which the drivable network
needs a small fraction; loading them all trades a working pipeline for an
out-of-memory error on the real input.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType

import osmium

from .errors import OsmReadError

#: Extract formats osmium can infer from a file name.
SUPPORTED_SUFFIXES = (".osm.pbf", ".osm.bz2", ".osm.gz", ".osm.xml", ".osm", ".pbf")


@dataclass(frozen=True)
class OsmNode:
    id: int
    lon: float
    lat: float


@dataclass(frozen=True)
class OsmWay:
    id: int
    node_ids: tuple[int, ...]
    tags: Mapping[str, str]


@dataclass(frozen=True)
class OsmExtract:
    nodes: dict[int, OsmNode]
    ways: tuple[OsmWay, ...]


def has_supported_suffix(name: str) -> bool:
    return name.lower().endswith(SUPPORTED_SUFFIXES)


def supported_suffix_hint() -> str:
    return ", ".join(SUPPORTED_SUFFIXES)


def _is_highway(tags: Mapping[str, str]) -> bool:
    return "highway" in tags


def read_extract(
    path: str | Path,
    *,
    keep_way: Callable[[Mapping[str, str]], bool] | None = None,
) -> OsmExtract:
    """Read ``path``, keeping the ways ``keep_way`` accepts and their nodes."""
    path = Path(path)
    keep = keep_way or _is_highway

    if not path.is_file():
        raise OsmReadError(f"OSM extract not found: {path}")
    if not has_supported_suffix(path.name):
        raise OsmReadError(
            f"unsupported extract format: {path} (expected one of {supported_suffix_hint()})"
        )

    ways: list[OsmWay] = []
    try:
        for way in osmium.FileProcessor(str(path), osmium.osm.WAY):
            tags = {tag.k: tag.v for tag in way.tags}
            if keep(tags):
                ways.append(
                    OsmWay(
                        id=way.id,
                        node_ids=tuple(ref.ref for ref in way.nodes),
                        tags=MappingProxyType(tags),
                    )
                )
    except Exception as exc:  # osmium raises assorted runtime errors
        raise OsmReadError(f"failed to read ways from {path}: {exc}") from exc

    needed = {node_id for way in ways for node_id in way.node_ids}
    nodes: dict[int, OsmNode] = {}
    if needed:
        try:
            for node in osmium.FileProcessor(str(path), osmium.osm.NODE):
                if node.id in needed and node.location.valid():
                    nodes[node.id] = OsmNode(
                        id=node.id, lon=node.location.lon, lat=node.location.lat
                    )
        except Exception as exc:
            raise OsmReadError(f"failed to read nodes from {path}: {exc}") from exc

    return OsmExtract(nodes=nodes, ways=tuple(ways))
