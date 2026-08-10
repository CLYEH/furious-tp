"""The OSM ETL: acquire -> read -> filter -> project -> clip -> topology -> write.

One run produces one self-contained, ODbL-isolated directory:

```text
<out>/
├── ATTRIBUTION.md                    # ODbL notice + provenance
├── source/<extract>                  # the acquired extract, byte-for-byte
└── intermediate/roads.topology.json  # this stage's output
```
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from pyproj import Transformer

from .bbox import BBox, clip_polyline
from .read import read_extract
from .sources import ODBL_URL, OSM_ATTRIBUTION, SourceRecord, acquire_extract, write_attribution
from .tags import road_attributes
from .topology import PlacedNode, PlacedWay, RoadTopology, build_topology

#: Identifier of the intermediate format written by this stage. This is a
#: pipeline-internal format; the client-facing tile formats live in contracts/.
OUTPUT_FORMAT = "scene-pipeline/osm-road-topology"
OUTPUT_FORMAT_VERSION = "0.1.0"
OUTPUT_FILENAME = "roads.topology.json"
SOURCE_DIRNAME = "source"
INTERMEDIATE_DIRNAME = "intermediate"

#: RFC D2: the ETL works in EPSG:3826 throughout; OSM publishes WGS84 degrees.
SOURCE_CRS = "EPSG:4326"
TARGET_CRS = "EPSG:3826"


@dataclass(frozen=True)
class OsmEtlResult:
    output_path: Path
    attribution_path: Path
    source: SourceRecord
    topology: RoadTopology


def _project(extract, transformer) -> dict[int, tuple[float, float]]:
    """Bulk-project every node once; per-point calls dominate on real extracts."""
    if not extract.nodes:
        return {}
    node_ids = list(extract.nodes)
    lons = [extract.nodes[i].lon for i in node_ids]
    lats = [extract.nodes[i].lat for i in node_ids]
    eastings, northings = transformer.transform(lons, lats)
    return {i: (float(e), float(n)) for i, e, n in zip(node_ids, eastings, northings)}


def _place(
    extract, bbox: BBox, projected: dict[int, tuple[float, float]]
) -> tuple[list[PlacedNode], list[PlacedWay], list[str]]:
    """Filter, orient, clip — producing the graph inputs plus tag warnings."""
    nodes: dict[int, PlacedNode] = {}
    ways: list[PlacedWay] = []
    warnings: list[str] = []
    next_boundary_id = -1

    for way in extract.ways:
        attributes = road_attributes(way.tags)
        if attributes is None:
            continue
        warnings.extend(f"way {way.id}: {warning}" for warning in attributes.warnings)

        node_ids = list(way.node_ids)
        if attributes.reversed:
            # oneway=-1 was normalised to 1; the geometry has to follow.
            node_ids.reverse()

        if any(ref not in projected for ref in node_ids):
            # A reference the extract does not carry: keep the way so that
            # build_topology reports it instead of silently losing the road.
            ways.append(
                PlacedWay(
                    osm_id=way.id, part=0, node_ids=tuple(node_ids), attributes=attributes
                )
            )
            continue

        for part, run in enumerate(clip_polyline([projected[i] for i in node_ids], bbox)):
            piece: list[int] = []
            for point, index in zip(run.points, run.indices):
                if index is None:
                    node_id = next_boundary_id
                    next_boundary_id -= 1
                    nodes[node_id] = PlacedNode(
                        id=node_id, e=point[0], n=point[1], boundary=True
                    )
                else:
                    node_id = node_ids[index]
                    if node_id not in nodes:
                        nodes[node_id] = PlacedNode(id=node_id, e=point[0], n=point[1])
                piece.append(node_id)
            ways.append(
                PlacedWay(
                    osm_id=way.id, part=part, node_ids=tuple(piece), attributes=attributes
                )
            )

    return list(nodes.values()), ways, warnings


def _document(
    topology: RoadTopology, bbox: BBox, record: SourceRecord, warnings: list[str]
) -> dict:
    nodes = [
        {
            "id": node.id,
            "e": node.e,
            "n": node.n,
            "degree": node.degree,
            "boundary": node.boundary,
        }
        for node in topology.nodes.values()
    ]
    ways = []
    for way in topology.ways:
        first = topology.nodes[way.node_ids[0]]
        last = topology.nodes[way.node_ids[-1]]
        ways.append(
            {
                "id": way.way_id,
                "osm_id": way.osm_id,
                "class": way.attributes.highway,
                "name": way.attributes.name,
                "oneway": way.attributes.oneway,
                "reversed": way.attributes.reversed,
                "layer": way.attributes.layer,
                "bridge": way.attributes.bridge,
                "tunnel": way.attributes.tunnel,
                "cut_start": first.boundary,
                "cut_end": last.boundary,
                "nodes": list(way.node_ids),
            }
        )
    return {
        "format": OUTPUT_FORMAT,
        "format_version": OUTPUT_FORMAT_VERSION,
        "crs": TARGET_CRS,
        "bbox": {
            "e_min": bbox.e_min,
            "n_min": bbox.n_min,
            "e_max": bbox.e_max,
            "n_max": bbox.n_max,
        },
        # The notice travels with the database body, not only in the sidecar.
        "license": {"name": "ODbL 1.0", "url": ODBL_URL, "attribution": OSM_ATTRIBUTION},
        "source": {
            "source": record.source,
            "file": record.path.name,
            "sha256": record.sha256,
            "size_bytes": record.size_bytes,
            "retrieved_at": record.retrieved_at,
        },
        "nodes": nodes,
        "ways": ways,
        "qa": {
            "node_count": len(nodes),
            "way_count": len(ways),
            "component_count": topology.qa.component_count,
            "component_sizes": list(topology.qa.component_sizes),
            "dangling_node_ids": list(topology.qa.dangling_node_ids),
            "incomplete_way_ids": list(topology.qa.incomplete_way_ids),
            "tag_warnings": warnings,
        },
    }


def run_osm_etl(
    source: str,
    out_dir: str | Path,
    bbox: BBox,
    *,
    session: object | None = None,
    expected_sha256: str | None = None,
) -> OsmEtlResult:
    """Run the whole OSM ETL into ``out_dir`` and return what it produced."""
    out_dir = Path(out_dir)

    record = acquire_extract(
        source,
        out_dir / SOURCE_DIRNAME,
        session=session,
        expected_sha256=expected_sha256,
    )
    extract = read_extract(record.path)

    transformer = Transformer.from_crs(SOURCE_CRS, TARGET_CRS, always_xy=True)
    projected = _project(extract, transformer)
    nodes, ways, warnings = _place(extract, bbox, projected)
    topology = build_topology(nodes, ways)

    attribution_path = write_attribution(out_dir, record)
    output_path = out_dir / INTERMEDIATE_DIRNAME / OUTPUT_FILENAME
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(_document(topology, bbox, record, warnings), ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
        newline="\n",
    )

    return OsmEtlResult(
        output_path=output_path,
        attribution_path=attribution_path,
        source=record,
        topology=topology,
    )
