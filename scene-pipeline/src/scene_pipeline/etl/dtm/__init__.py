"""MOI 20 m DTM ETL: download/read, reproject to EPSG:3826, clip, record source.

See README.md in this package for the pixel-alignment rule and the nodata
policy, both of which downstream stages depend on.
"""

from .area import Area, Bbox, load_area, load_tile_size_m
from .errors import (
    DtmContractError,
    DtmCoverageError,
    DtmEtlError,
    DtmGridError,
    DtmOutputError,
    DtmSourceError,
    DtmSourceMetadataError,
)
from .etl import NODATA_POLICY, OUTPUT_CRS, OUTPUT_NODATA, DtmEtlResult, run_dtm_etl
from .grid import DEFAULT_RESOLUTION_M, AlignedGrid, align_bbox, check_tile_alignment
from .source import REQUIRED_SOURCE_FIELDS, SourceRef

__all__ = [
    "DEFAULT_RESOLUTION_M",
    "NODATA_POLICY",
    "OUTPUT_CRS",
    "OUTPUT_NODATA",
    "REQUIRED_SOURCE_FIELDS",
    "AlignedGrid",
    "Area",
    "Bbox",
    "DtmContractError",
    "DtmCoverageError",
    "DtmEtlError",
    "DtmEtlResult",
    "DtmGridError",
    "DtmOutputError",
    "DtmSourceError",
    "DtmSourceMetadataError",
    "SourceRef",
    "align_bbox",
    "check_tile_alignment",
    "load_area",
    "load_tile_size_m",
    "run_dtm_etl",
]
