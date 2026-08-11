"""Single-command entry point: ``python -m scene_pipeline.etl.osm``."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .bbox import BBox
from .errors import OsmEtlError
from .pipeline import run_osm_etl


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m scene_pipeline.etl.osm",
        description=(
            "Download or copy an OSM extract, filter the drivable network, clip it to an "
            "area and write the road topology, all inside one ODbL-isolated directory."
        ),
    )
    parser.add_argument(
        "--source",
        required=True,
        help="http(s) URL of an OSM extract, or a path to a local one",
    )
    parser.add_argument(
        "--out",
        required=True,
        type=Path,
        help="output directory; holds ONLY OSM-derived artefacts",
    )
    area = parser.add_mutually_exclusive_group(required=True)
    area.add_argument(
        "--area",
        type=Path,
        help="contracts area file to read the bbox from, e.g. contracts/constants/m1_area.json",
    )
    area.add_argument(
        "--bbox",
        nargs=4,
        type=float,
        metavar=("E_MIN", "N_MIN", "E_MAX", "N_MAX"),
        help="clip area in EPSG:3826 metres",
    )
    parser.add_argument(
        "--sha256",
        help="expected SHA-256 of the extract; the run fails if it does not match",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    # A path or a road name outside the console's code page must not turn a
    # finished run into a UnicodeEncodeError on the last line.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    try:
        bbox = BBox.from_area_file(args.area) if args.area else BBox(*args.bbox)
        result = run_osm_etl(
            args.source, args.out, bbox, expected_sha256=args.sha256
        )
    except OsmEtlError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    qa = result.topology.qa
    print(f"OSM ETL done -> {result.output_path}")
    print(f"  ways={len(result.topology.ways)} nodes={len(result.topology.nodes)}")
    print(
        f"  components={qa.component_count} dangling={len(qa.dangling_node_ids)} "
        f"incomplete={len(qa.incomplete_way_ids)}"
    )
    print(f"  attribution -> {result.attribution_path}")
    return 0
