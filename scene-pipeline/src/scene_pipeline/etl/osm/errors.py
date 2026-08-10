"""Error types for the OSM ETL.

One root type so the CLI can turn any expected failure into a single line
instead of a traceback; the leaves exist because the operator's next action
differs — retry a mirror, fix a path, or fix the area file.
"""

from __future__ import annotations


class OsmEtlError(Exception):
    """Base class for every expected OSM ETL failure."""


class OsmSourceError(OsmEtlError):
    """The extract could not be acquired (missing file, unusable name)."""


class OsmDownloadError(OsmSourceError):
    """The extract could not be downloaded, or arrived damaged."""


class OsmReadError(OsmEtlError):
    """The extract could not be parsed."""


class BBoxError(OsmEtlError):
    """The clip area is missing, malformed or degenerate."""
