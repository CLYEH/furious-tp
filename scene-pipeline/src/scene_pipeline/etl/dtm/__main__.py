"""`python -m scene_pipeline.etl.dtm` — the single-command DTM ETL.

The entry point lives in this package rather than in `scene_pipeline.cli`
because the CLI package belongs to a different ticket; `-m` on the module is a
first-class command either way, and moving it later costs one line.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .errors import DtmEtlError
from .etl import RESAMPLING_METHODS, run_dtm_etl
from .grid import DEFAULT_RESOLUTION_M
from .source import DEFAULT_TIMEOUT_S


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m scene_pipeline.etl.dtm",
        description=(
            "Clip the MOI 20 m DTM to the M1 bbox in EPSG:3826 and write a GeoTIFF "
            "plus its source/version record."
        ),
    )
    parser.add_argument("--source", required=True,
                        help="path to a source raster, or an http(s) URL to download")
    parser.add_argument("--out", required=True, type=Path,
                        help="output GeoTIFF path; the record is written beside it "
                             "as <stem>.source.json")
    parser.add_argument("--area", type=Path, default=None,
                        help="area contract (default: contracts/constants/m1_area.json)")
    parser.add_argument("--resolution", type=float, default=DEFAULT_RESOLUTION_M,
                        help=f"output resolution in metres (default: {DEFAULT_RESOLUTION_M})")
    parser.add_argument("--resampling", default="bilinear", choices=sorted(RESAMPLING_METHODS),
                        help="resampling kernel used when the source needs warping")
    parser.add_argument("--source-nodata", type=float, action="append", metavar="VALUE",
                        help="extra sentinel value to treat as void; repeatable. Needed for "
                             "sources that carry e.g. -999 without tagging it")
    parser.add_argument("--source-meta", type=Path, default=None,
                        help="JSON file holding name/url/license/retrieved")
    parser.add_argument("--source-name", default=None, help="source dataset name")
    parser.add_argument("--source-url", default=None,
                        help="source URL (defaults to --source when that is a URL)")
    parser.add_argument("--license", default=None, help="source licence, as published")
    parser.add_argument("--retrieved", default=None,
                        help="acquisition date, YYYY-MM-DD (filled in automatically when "
                             "this run downloads the source)")
    parser.add_argument("--download-dir", type=Path, default=None,
                        help="where to put a downloaded source (default: <out dir>/_source)")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S,
                        help=f"download timeout in seconds (default: {DEFAULT_TIMEOUT_S})")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        result = run_dtm_etl(
            source=args.source,
            out=args.out,
            area_path=args.area,
            resolution_m=args.resolution,
            resampling=args.resampling,
            source_meta_path=args.source_meta,
            source_overrides={
                "name": args.source_name,
                "url": args.source_url,
                "license": args.license,
                "retrieved": args.retrieved,
            },
            extra_nodata=tuple(args.source_nodata or ()),
            timeout_s=args.timeout,
            download_dir=args.download_dir,
        )
    except DtmEtlError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(
        f"{result.output_path}: {result.grid.width} x {result.grid.height} px "
        f"@ {result.grid.resolution_m} m, {result.valid_fraction:.4%} valid; "
        f"record {result.provenance_path.name}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
