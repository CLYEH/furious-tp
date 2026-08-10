"""Extract acquisition, source isolation and the ODbL attribution record.

Everything OSM-derived lands under one directory (RFC 模組 1 / PRD §4). That is
not tidiness: ODbL share-alike follows the data, so the perimeter has to be a
directory somebody can point at.

`LICENSING.md` (road tiles, obligation 2) applies the OSMF Attribution
Guidelines' *Databases safe harbour* — the attribution and the ODbL link must be
delivered **with the database body**, not only in a HUD. `ATTRIBUTION.md`, written
next to the data, is that delivery.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import shutil
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import requests

from .errors import OsmDownloadError, OsmSourceError
from .read import has_supported_suffix, supported_suffix_hint

ODBL_URL = "https://opendatacommons.org/licenses/odbl/1-0/"
OSM_ATTRIBUTION = "© OpenStreetMap contributors"
ATTRIBUTION_FILENAME = "ATTRIBUTION.md"

_CHUNK_BYTES = 1 << 20
_DEFAULT_TIMEOUT = 60


@dataclass(frozen=True)
class SourceRecord:
    """Provenance for one acquired extract."""

    source: str
    path: Path
    sha256: str
    size_bytes: int
    retrieved_at: str


def _is_url(source: str) -> bool:
    return source.startswith(("http://", "https://"))


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _digest(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK_BYTES):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _filename_from_url(url: str) -> str:
    name = Path(urlsplit(url).path).name
    if not has_supported_suffix(name):
        raise OsmSourceError(
            f"cannot tell the OSM format from the URL {url!r}; "
            f"expected a file name ending in one of {supported_suffix_hint()}"
        )
    return name


def _download(url: str, target: Path, session: object | None, timeout: float) -> None:
    http = session if session is not None else requests
    try:
        with http.get(url, stream=True, timeout=timeout) as response:  # type: ignore[union-attr]
            response.raise_for_status()
            declared = response.headers.get("Content-Length")
            written = 0
            with target.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=_CHUNK_BYTES):
                    if chunk:
                        handle.write(chunk)
                        written += len(chunk)
    except Exception as exc:
        target.unlink(missing_ok=True)
        raise OsmDownloadError(f"failed to download {url}: {exc}") from exc

    if declared is not None and str(declared).strip().isdigit():
        expected = int(declared)
        if expected != written:
            target.unlink(missing_ok=True)
            raise OsmDownloadError(
                f"truncated download from {url}: Content-Length declared {expected} bytes, "
                f"got {written} bytes"
            )


def acquire_extract(
    source: str,
    dest_dir: str | Path,
    *,
    session: object | None = None,
    expected_sha256: str | None = None,
    timeout: float = _DEFAULT_TIMEOUT,
) -> SourceRecord:
    """Put ``source`` inside ``dest_dir`` and return its provenance.

    ``source`` is either an ``http(s)`` URL or a local path; a local extract is
    copied rather than referenced, so the isolated directory is self-contained.
    """
    dest_dir = Path(dest_dir)

    if _is_url(source):
        name = _filename_from_url(source)
        dest_dir.mkdir(parents=True, exist_ok=True)
        target = dest_dir / name
        _download(source, target, session, timeout)
    else:
        origin = Path(source)
        if not origin.is_file():
            raise OsmSourceError(f"OSM source file not found: {origin}")
        if not has_supported_suffix(origin.name):
            raise OsmSourceError(
                f"unsupported extract format: {origin} "
                f"(expected one of {supported_suffix_hint()})"
            )
        dest_dir.mkdir(parents=True, exist_ok=True)
        target = dest_dir / origin.name
        shutil.copyfile(origin, target)

    digest, size = _digest(target)
    if expected_sha256 is not None and digest != expected_sha256:
        target.unlink(missing_ok=True)
        error = OsmDownloadError if _is_url(source) else OsmSourceError
        raise error(
            f"checksum mismatch for {source}: expected {expected_sha256}, got {digest}"
        )

    return SourceRecord(
        source=source,
        path=target,
        sha256=digest,
        size_bytes=size,
        retrieved_at=_now(),
    )


def write_attribution(out_dir: str | Path, record: SourceRecord) -> Path:
    """Write the ODbL notice and provenance beside the data it describes."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / ATTRIBUTION_FILENAME
    path.write_text(
        f"""# OSM 來源隔離目錄

本目錄下的所有檔案皆衍生自 OpenStreetMap,與其他來源的資料分開存放。

## 授權

> {OSM_ATTRIBUTION},依 [Open Database License (ODbL) 1.0]({ODBL_URL}) 提供。

ODbL 為 share-alike 授權:由本目錄資料衍生的資料庫同受其拘束,散布時必須一併提供
本標示與授權連結,並免費提供機器可讀的全量衍生資料庫。詳見專案 `LICENSING.md`
(road tiles 一節)與 [ODbL 全文]({ODBL_URL})。

**本目錄與其他來源(內政部 DTM、data.taipei)之產物不得混放** —— share-alike 的
範圍跟著資料走,混放會讓非 OSM 來源的產物落入不必要的授權外溢風險。

## 來源紀錄

| 欄位 | 值 |
| --- | --- |
| source | `{record.source}` |
| file | `{record.path.name}` |
| sha256 | `{record.sha256}` |
| size_bytes | {record.size_bytes} |
| retrieved_at | {record.retrieved_at} |

此檔由 `scene_pipeline.etl.osm` 於每次執行時重寫,內容即當次執行的來源事實。
""",
        encoding="utf-8",
        newline="\n",
    )
    return path
