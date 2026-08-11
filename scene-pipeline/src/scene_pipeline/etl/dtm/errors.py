"""Failure modes of the DTM ETL.

One class per thing the operator would have to do differently, because the
error type is the only part of a failure a caller can branch on. Every one of
them carries the offending path, URL or field name in its message: a DTM run
that dies without saying which file it choked on has failed twice.
"""

from __future__ import annotations


class DtmEtlError(Exception):
    """Base class for every DTM ETL failure."""


class DtmContractError(DtmEtlError):
    """The area / grid contract under `contracts/` is missing or unusable."""


class DtmSourceError(DtmEtlError):
    """The source raster could not be fetched, opened or understood."""


class DtmSourceMetadataError(DtmEtlError):
    """The source/version record is incomplete — PRD §4 attribution."""


class DtmGridError(DtmEtlError):
    """The requested bbox / resolution cannot produce a valid output grid."""


class DtmCoverageError(DtmEtlError):
    """The source does not actually cover the requested area."""


class DtmOutputError(DtmEtlError):
    """The output could not be written where it was asked to go."""
