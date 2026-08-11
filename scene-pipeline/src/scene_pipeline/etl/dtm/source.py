"""Getting the source raster, and recording where it came from.

PRD §4 requires the twin to say what it is built from. That requirement is
enforced here rather than documented: `build_source_ref` refuses incomplete
attribution, and `run_dtm_etl` calls it before it writes anything. Attribution
that is merely encouraged is attribution that goes missing.

Deliberately absent: a registry of "known" sources with the NLSC dataset id
and URL baked in. Convenient, but the values would be my recollection of a
data.gov.tw listing rather than something checked, and a wrong licence string
shipped under an official-looking constant is worse than no constant at all.
The operator passes the values from the page they actually downloaded from,
once, in a `--source-meta` file that can then be reused.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlparse

import requests

from .errors import DtmSourceError, DtmSourceMetadataError

#: The four things a source record must carry (FTP-28 AC4).
REQUIRED_SOURCE_FIELDS = ("name", "url", "license", "retrieved")

DEFAULT_TIMEOUT_S = 300.0

_DOWNLOAD_CHUNK_BYTES = 1 << 20


@dataclass(frozen=True)
class SourceRef:
    """A complete source-and-version record."""

    name: str
    url: str
    license: str
    retrieved: str

    def to_dict(self) -> dict:
        return asdict(self)


def is_url(value: str) -> bool:
    return urlparse(str(value)).scheme in {"http", "https"}


def _clean(value) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def load_source_meta(path: Path | None, overrides: dict | None) -> dict:
    """Merge a `--source-meta` JSON file with command-line overrides."""
    meta: dict = {}
    if path is not None:
        path = Path(path)
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise DtmSourceMetadataError(f"cannot read source metadata {path}: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise DtmSourceMetadataError(
                f"source metadata {path} is not valid JSON: {exc}"
            ) from exc
        if not isinstance(doc, dict):
            raise DtmSourceMetadataError(
                f"source metadata {path} must be a JSON object mapping "
                f"{', '.join(REQUIRED_SOURCE_FIELDS)} to strings"
            )
        meta.update(doc)

    for key, value in (overrides or {}).items():
        if value is not None:
            meta[key] = value
    return meta


def build_source_ref(meta: dict, *, downloaded_on: str | None = None) -> SourceRef:
    """Validate attribution and freeze it into a `SourceRef`.

    `downloaded_on` fills in `retrieved` only when this run did the fetching —
    that is the one case where the date is witnessed rather than asserted. For
    a file already on disk the operator must say when they obtained it;

    guessing "today" there would be a fabricated provenance date.
    """
    values = {key: _clean(meta.get(key)) for key in REQUIRED_SOURCE_FIELDS}

    if values["retrieved"] is None and downloaded_on is not None:
        values["retrieved"] = downloaded_on

    missing = [key for key in REQUIRED_SOURCE_FIELDS if values[key] is None]
    if missing:
        raise DtmSourceMetadataError(
            "the source record is incomplete: missing "
            + ", ".join(missing)
            + ". PRD §4 requires the published twin to name its sources, so no output "
            "is written without them (pass --source-meta or the --source-name / "
            "--source-url / --license / --retrieved flags)"
        )

    try:
        dt.date.fromisoformat(values["retrieved"])
    except ValueError as exc:
        raise DtmSourceMetadataError(
            f"retrieved must be an ISO date (YYYY-MM-DD), got {values['retrieved']!r}: {exc}"
        ) from exc

    return SourceRef(**values)


def sha256_file(path: Path) -> str:
    """Hash a file so the record pins the exact bytes that were read."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(_DOWNLOAD_CHUNK_BYTES), b""):
            digest.update(block)
    return digest.hexdigest()


def download_source(url: str, dest: Path, *, timeout: float = DEFAULT_TIMEOUT_S) -> Path:
    """Stream `url` to `dest`, leaving nothing behind if it fails.

    The download lands on a `.part` file first: a truncated GeoTIFF at the
    real path would be opened by the next run as if it were the whole dataset.
    """
    dest = Path(dest)
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise DtmSourceError(f"cannot create download directory {dest.parent}: {exc}") from exc

    part = dest.with_name(dest.name + ".part")
    try:
        with requests.get(url, stream=True, timeout=timeout) as response:
            response.raise_for_status()
            with open(part, "wb") as handle:
                for chunk in response.iter_content(chunk_size=_DOWNLOAD_CHUNK_BYTES):
                    if chunk:
                        handle.write(chunk)
    except requests.Timeout as exc:
        _discard(part)
        raise DtmSourceError(f"download of {url} timed out after {timeout} s: {exc}") from exc
    except requests.HTTPError as exc:
        _discard(part)
        status = getattr(getattr(exc, "response", None), "status_code", "?")
        raise DtmSourceError(f"download of {url} failed with HTTP {status}: {exc}") from exc
    except requests.RequestException as exc:
        _discard(part)
        raise DtmSourceError(f"download of {url} failed: {exc}") from exc
    except OSError as exc:
        _discard(part)
        raise DtmSourceError(f"cannot write download of {url} to {part}: {exc}") from exc
    except BaseException:
        # Ctrl-C is not an OSError either, and this is the longest step of the
        # run: a nationwide DTM is gigabytes, so an interrupt lands here more
        # often than anywhere else. `_publish` grew the same clause; without it
        # here the module keeps half a policy, and the `.part` this function
        # promises never to leave behind is left behind, at full size.
        _discard(part)
        raise

    try:
        os.replace(part, dest)
    except OSError as exc:
        _discard(part)
        raise DtmSourceError(f"cannot move downloaded {url} into place at {dest}: {exc}") from exc
    except BaseException:
        # `_publish` keeps both of its renames under one such clause; this
        # function's rename is in a try of its own, so it needs its own or the
        # policy stops one statement short of the end. An interrupt landing
        # here abandons the completed download — the whole file, one rename
        # from being the one that was wanted.
        _discard(part)
        raise
    return dest


def _discard(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:  # pragma: no cover - best effort cleanup
        pass
