"""OSM ETL: Taipei extract -> drivable road topology, in an ODbL-isolated directory.

RFC 模組 1 / D10 (topology follows OSM) / D2 (EPSG:3826 throughout).
See README.md in this package for the clipping rules and the output format.
"""

from __future__ import annotations

from .bbox import BBox, ClippedRun, clip_polyline
from .cli import main
from .errors import BBoxError, OsmDownloadError, OsmEtlError, OsmReadError, OsmSourceError
from .pipeline import OsmEtlResult, run_osm_etl
from .read import OsmExtract, OsmNode, OsmWay, read_extract
from .sources import ODBL_URL, OSM_ATTRIBUTION, SourceRecord, acquire_extract, write_attribution
from .tags import HIGHWAY_CLASSES, RoadAttributes, road_attributes
from .topology import (
    PlacedNode,
    PlacedWay,
    RoadTopology,
    TopologyNode,
    TopologyQa,
    build_topology,
)

__all__ = [
    "HIGHWAY_CLASSES",
    "ODBL_URL",
    "OSM_ATTRIBUTION",
    "BBox",
    "BBoxError",
    "ClippedRun",
    "OsmDownloadError",
    "OsmEtlError",
    "OsmEtlResult",
    "OsmExtract",
    "OsmNode",
    "OsmReadError",
    "OsmSourceError",
    "OsmWay",
    "PlacedNode",
    "PlacedWay",
    "RoadAttributes",
    "RoadTopology",
    "SourceRecord",
    "TopologyNode",
    "TopologyQa",
    "acquire_extract",
    "build_topology",
    "clip_polyline",
    "main",
    "read_extract",
    "road_attributes",
    "run_osm_etl",
    "write_attribution",
]
