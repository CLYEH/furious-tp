"""Exam: extract acquisition, source isolation and ODbL attribution (FTP-29).

Covers AC2 (來源隔離:OSM 中間產物獨立目錄 + ODbL attribution 紀錄檔) and the
`下載失敗 / 檔案截斷 → 明確錯誤` verification step.

No test here touches the network: the downloader takes an injected session, so
the exam can stage exactly the failures a real mirror produces (500s, silently
short bodies, a wrong file) and assert on **what the operator sees**.
"""

from __future__ import annotations

import datetime as dt

import pytest

from scene_pipeline.etl.osm import (
    ODBL_URL,
    OsmDownloadError,
    OsmEtlError,
    OsmSourceError,
    acquire_extract,
    write_attribution,
)

from .conftest import FakeResponse, FakeSession, sha256_of

PAYLOAD = b"<?xml version='1.0'?><osm version='0.6'></osm>"
URL = "https://download.geofabrik.de/asia/taiwan-latest.osm.pbf"


def response(chunks=(PAYLOAD,), **kwargs) -> FakeResponse:
    return FakeResponse(list(chunks), **kwargs)


# --- error hierarchy --------------------------------------------------------


def test_error_hierarchy() -> None:
    # The CLI catches one type to turn any ETL failure into a clean message
    # instead of a traceback, so the hierarchy is load-bearing.
    assert issubclass(OsmSourceError, OsmEtlError)
    assert issubclass(OsmDownloadError, OsmSourceError)


# --- happy download ---------------------------------------------------------


def test_download_writes_the_extract_into_the_isolated_dir(tmp_path) -> None:
    dest = tmp_path / "osm"
    session = FakeSession(response(headers={"Content-Length": str(len(PAYLOAD))}))

    record = acquire_extract(URL, dest, session=session)

    assert record.path.parent == dest
    assert record.path.name == "taiwan-latest.osm.pbf"
    assert record.path.read_bytes() == PAYLOAD
    assert record.source == URL
    assert record.sha256 == sha256_of(PAYLOAD)
    assert record.size_bytes == len(PAYLOAD)


def test_download_creates_the_destination_dir(tmp_path) -> None:
    dest = tmp_path / "does" / "not" / "exist"
    acquire_extract(URL, dest, session=FakeSession(response()))
    assert dest.is_dir()


def test_download_writes_nothing_outside_the_destination_dir(tmp_path) -> None:
    # AC2 source isolation: OSM bytes land in the OSM directory and nowhere
    # else, so the ODbL share-alike perimeter stays a directory you can point at.
    dest = tmp_path / "osm"
    neighbour = tmp_path / "not-osm"
    neighbour.mkdir()
    acquire_extract(URL, dest, session=FakeSession(response()))
    assert list(neighbour.iterdir()) == []
    assert {p.name for p in tmp_path.iterdir()} == {"osm", "not-osm"}


def test_retrieved_at_is_an_iso_utc_timestamp(tmp_path) -> None:
    record = acquire_extract(URL, tmp_path, session=FakeSession(response()))
    parsed = dt.datetime.fromisoformat(record.retrieved_at)
    assert parsed.tzinfo is not None  # provenance without a timezone is a guess


def test_download_streams_with_a_timeout(tmp_path) -> None:
    # WHY: requests blocks forever by default. An offline pipeline run that
    # hangs on a wedged mirror looks identical to one that is merely slow.
    session = FakeSession(response())
    acquire_extract(URL, tmp_path, session=session)
    (_url, kwargs), = session.calls
    assert kwargs.get("stream") is True
    assert kwargs.get("timeout") is not None


def test_multi_chunk_body_is_reassembled(tmp_path) -> None:
    chunks = [PAYLOAD[:10], PAYLOAD[10:30], PAYLOAD[30:]]
    record = acquire_extract(
        URL, tmp_path, session=FakeSession(response(chunks, headers={
            "Content-Length": str(len(PAYLOAD))
        }))
    )
    assert record.path.read_bytes() == PAYLOAD


# --- download failures ------------------------------------------------------


def test_http_error_is_reported_with_the_url(tmp_path) -> None:
    session = FakeSession(response(error=RuntimeError("500 Server Error")))
    with pytest.raises(OsmDownloadError) as excinfo:
        acquire_extract(URL, tmp_path, session=session)
    message = str(excinfo.value)
    assert URL in message
    assert "500 Server Error" in message  # the upstream cause, not swallowed


def test_transport_error_is_reported_with_the_url(tmp_path) -> None:
    session = FakeSession(OSError("connection reset"))
    with pytest.raises(OsmDownloadError) as excinfo:
        acquire_extract(URL, tmp_path, session=session)
    assert URL in str(excinfo.value)
    assert "connection reset" in str(excinfo.value)


def test_failed_download_leaves_no_partial_file(tmp_path) -> None:
    # WHY: a half-written .osm.pbf on disk is worse than none — the next run
    # would either parse garbage or be told the file already exists.
    session = FakeSession(response(error=RuntimeError("boom")))
    with pytest.raises(OsmDownloadError):
        acquire_extract(URL, tmp_path, session=session)
    assert list(tmp_path.glob("*.pbf")) == []


def test_truncated_body_is_rejected(tmp_path) -> None:
    # The failure this exam exists for: mirrors do return short bodies, and
    # osmium's complaint about the resulting file points at the parser, not at
    # the download.
    session = FakeSession(response(headers={"Content-Length": str(len(PAYLOAD) + 100)}))
    with pytest.raises(OsmDownloadError) as excinfo:
        acquire_extract(URL, tmp_path, session=session)
    message = str(excinfo.value)
    assert "truncated" in message.lower()
    assert str(len(PAYLOAD) + 100) in message  # expected
    assert str(len(PAYLOAD)) in message  # actual


def test_truncated_download_leaves_no_partial_file(tmp_path) -> None:
    session = FakeSession(response(headers={"Content-Length": str(len(PAYLOAD) + 100)}))
    with pytest.raises(OsmDownloadError):
        acquire_extract(URL, tmp_path, session=session)
    assert list(tmp_path.glob("*.pbf")) == []


def test_overlong_body_is_also_rejected(tmp_path) -> None:
    session = FakeSession(response(headers={"Content-Length": str(len(PAYLOAD) - 5)}))
    with pytest.raises(OsmDownloadError):
        acquire_extract(URL, tmp_path, session=session)


def test_missing_content_length_is_accepted(tmp_path) -> None:
    # Some mirrors omit it under chunked encoding; that is not an error, it just
    # means the length check cannot run.
    record = acquire_extract(URL, tmp_path, session=FakeSession(response()))
    assert record.size_bytes == len(PAYLOAD)


def test_checksum_mismatch_is_rejected_with_both_hashes(tmp_path) -> None:
    wrong = "0" * 64
    with pytest.raises(OsmDownloadError) as excinfo:
        acquire_extract(URL, tmp_path, session=FakeSession(response()), expected_sha256=wrong)
    message = str(excinfo.value)
    assert wrong in message
    assert sha256_of(PAYLOAD) in message


def test_checksum_mismatch_leaves_no_file(tmp_path) -> None:
    with pytest.raises(OsmDownloadError):
        acquire_extract(URL, tmp_path, session=FakeSession(response()), expected_sha256="0" * 64)
    assert list(tmp_path.glob("*.pbf")) == []


def test_matching_checksum_is_accepted(tmp_path) -> None:
    record = acquire_extract(
        URL, tmp_path, session=FakeSession(response()), expected_sha256=sha256_of(PAYLOAD)
    )
    assert record.sha256 == sha256_of(PAYLOAD)


@pytest.mark.parametrize(
    "url",
    [
        "https://example.org/api/map?bbox=1,2,3,4",
        "https://example.org/taiwan-latest.zip",
        "https://example.org/",
    ],
)
def test_url_without_a_recognised_osm_extension_is_rejected(tmp_path, url: str) -> None:
    # WHY: osmium infers the format from the file name. Saving `map?bbox=...` as
    # a file produces an unreadable extract and a parser error three stages
    # later; refuse up front and say which extensions work.
    with pytest.raises(OsmSourceError) as excinfo:
        acquire_extract(url, tmp_path, session=FakeSession(response()))
    assert ".osm.pbf" in str(excinfo.value)


@pytest.mark.parametrize(
    "name", ["taiwan-latest.osm.pbf", "taipei.osm", "taipei.osm.bz2", "taipei.osm.gz"]
)
def test_recognised_extensions_are_accepted(tmp_path, name: str) -> None:
    record = acquire_extract(
        f"https://example.org/{name}", tmp_path, session=FakeSession(response())
    )
    assert record.path.name == name


# --- local sources ----------------------------------------------------------


def test_local_file_is_copied_into_the_isolated_dir(tmp_path) -> None:
    src = tmp_path / "input" / "taipei.osm"
    src.parent.mkdir()
    src.write_bytes(PAYLOAD)
    dest = tmp_path / "osm"

    record = acquire_extract(str(src), dest, session=FakeSession(response()))

    assert record.path == dest / "taipei.osm"
    assert record.path.read_bytes() == PAYLOAD
    assert src.read_bytes() == PAYLOAD  # original untouched
    assert record.sha256 == sha256_of(PAYLOAD)
    assert record.source == str(src)


def test_missing_local_file_is_reported_with_its_path(tmp_path) -> None:
    missing = tmp_path / "input" / "absent.osm"
    with pytest.raises(OsmSourceError) as excinfo:
        acquire_extract(str(missing), tmp_path / "osm")
    assert str(missing) in str(excinfo.value)


def test_local_source_does_not_need_a_session(tmp_path) -> None:
    src = tmp_path / "taipei.osm"
    src.write_bytes(PAYLOAD)
    record = acquire_extract(str(src), tmp_path / "osm")
    assert record.path.read_bytes() == PAYLOAD


def test_local_checksum_is_verified(tmp_path) -> None:
    src = tmp_path / "taipei.osm"
    src.write_bytes(PAYLOAD)
    with pytest.raises(OsmSourceError) as excinfo:
        acquire_extract(str(src), tmp_path / "osm", expected_sha256="0" * 64)
    assert sha256_of(PAYLOAD) in str(excinfo.value)


# --- attribution record -----------------------------------------------------


def test_attribution_file_carries_the_odbl_notice(tmp_path) -> None:
    # WHY, verbatim from LICENSING.md (road tiles, obligation 2): attribution
    # and the ODbL link must ship WITH the database body, not only in a HUD.
    # This file is that delivery, so its contents are an acceptance criterion.
    record = acquire_extract(URL, tmp_path / "osm", session=FakeSession(response()))
    path = write_attribution(tmp_path / "osm", record)

    text = path.read_text(encoding="utf-8")
    assert path.parent == tmp_path / "osm"
    assert "OpenStreetMap contributors" in text
    assert ODBL_URL in text


def test_attribution_file_records_the_provenance(tmp_path) -> None:
    record = acquire_extract(URL, tmp_path / "osm", session=FakeSession(response()))
    text = write_attribution(tmp_path / "osm", record).read_text(encoding="utf-8")
    assert record.source in text
    assert record.sha256 in text
    assert record.retrieved_at in text
    assert str(record.size_bytes) in text


def test_attribution_file_states_the_share_alike_obligation(tmp_path) -> None:
    # A reader of the isolated directory must be able to learn, from the
    # directory alone, that everything in it is ODbL and why it is kept apart.
    record = acquire_extract(URL, tmp_path / "osm", session=FakeSession(response()))
    text = write_attribution(tmp_path / "osm", record).read_text(encoding="utf-8")
    assert "ODbL" in text
    assert "share-alike" in text.lower()


def test_attribution_is_rewritten_not_appended(tmp_path) -> None:
    record = acquire_extract(URL, tmp_path / "osm", session=FakeSession(response()))
    first = write_attribution(tmp_path / "osm", record).read_text(encoding="utf-8")
    second = write_attribution(tmp_path / "osm", record).read_text(encoding="utf-8")
    assert first == second  # re-running the ETL must not grow the file
