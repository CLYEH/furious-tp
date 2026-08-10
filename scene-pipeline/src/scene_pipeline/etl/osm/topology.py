"""Road topology: node degrees, connectivity and broken-chain detection.

RFC D10 makes OSM the authority for topology, so these numbers are what every
later stage trusts. Definitions:

* **degree** — incident segments, not incident ways.
* **dangling node** — degree 1 and not a bbox cut: a genuine dead end in the
  source. Reported, never silently repaired.
* **incomplete way** — references a node the extract does not contain, the
  signature of a truncated or badly cropped extract. Dropped and reported.
* **components** — connected pieces of the drivable graph; more than one means
  the chain is broken somewhere inside the area.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass

from .tags import RoadAttributes


@dataclass(frozen=True)
class PlacedNode:
    """A node already projected into EPSG:3826."""

    id: int
    e: float
    n: float
    boundary: bool = False


@dataclass(frozen=True)
class PlacedWay:
    """One clipped piece of an OSM way, in EPSG:3826 node order."""

    osm_id: int
    part: int
    node_ids: tuple[int, ...]
    attributes: RoadAttributes

    @property
    def way_id(self) -> str:
        """``<osm id>#<part>`` — D10 conflation matches on the OSM id, so the
        piece index must not overwrite it."""
        return f"{self.osm_id}#{self.part}"


@dataclass(frozen=True)
class TopologyNode:
    id: int
    e: float
    n: float
    degree: int
    boundary: bool


@dataclass(frozen=True)
class TopologyQa:
    dangling_node_ids: tuple[int, ...] = ()
    incomplete_way_ids: tuple[str, ...] = ()
    component_count: int = 0
    component_sizes: tuple[int, ...] = ()


@dataclass(frozen=True)
class RoadTopology:
    nodes: dict[int, TopologyNode]
    ways: tuple[PlacedWay, ...]
    qa: TopologyQa


def _components(
    referenced: list[int], adjacency: dict[int, set[int]]
) -> tuple[int, ...]:
    seen: set[int] = set()
    sizes: list[int] = []
    for start in referenced:  # sorted input keeps the walk deterministic
        if start in seen:
            continue
        size = 0
        stack = [start]
        seen.add(start)
        while stack:
            current = stack.pop()
            size += 1
            for neighbour in adjacency[current]:
                if neighbour not in seen:
                    seen.add(neighbour)
                    stack.append(neighbour)
        sizes.append(size)
    return tuple(sorted(sizes, reverse=True))


def build_topology(
    nodes: Iterable[PlacedNode], ways: Iterable[PlacedWay]
) -> RoadTopology:
    """Assemble the road graph, dropping and reporting unusable ways."""
    node_map = {node.id: node for node in nodes}

    kept: list[PlacedWay] = []
    incomplete: list[str] = []
    for way in ways:
        if len(way.node_ids) < 2 or any(ref not in node_map for ref in way.node_ids):
            incomplete.append(way.way_id)
            continue
        kept.append(way)

    degree: dict[int, int] = defaultdict(int)
    adjacency: dict[int, set[int]] = defaultdict(set)
    for way in kept:
        for a, b in zip(way.node_ids, way.node_ids[1:]):
            degree[a] += 1
            degree[b] += 1
            adjacency[a].add(b)
            adjacency[b].add(a)

    referenced = sorted({ref for way in kept for ref in way.node_ids})
    topology_nodes = {
        node_id: TopologyNode(
            id=node_id,
            e=node_map[node_id].e,
            n=node_map[node_id].n,
            degree=degree[node_id],
            boundary=node_map[node_id].boundary,
        )
        for node_id in referenced
    }

    dangling = tuple(
        node_id
        for node_id in referenced
        if degree[node_id] == 1 and not node_map[node_id].boundary
    )
    sizes = _components(referenced, adjacency)

    return RoadTopology(
        nodes=topology_nodes,
        ways=tuple(kept),
        qa=TopologyQa(
            dangling_node_ids=dangling,
            incomplete_way_ids=tuple(incomplete),
            component_count=len(sizes),
            component_sizes=sizes,
        ),
    )
