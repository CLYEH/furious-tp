"""Source acquisition and the source/version record (FTP-28 AC4).

PRD §4 requires attribution on everything shipped. The rule under exam: an
output with an incomplete source record is not produced at all. Attribution
that is merely *encouraged* is attribution that goes missing.
"""

from __future__ import annotations

import hashlib
import json

import pytest
import requests

from scene_pipeline.etl.dtm.errors import DtmSourceError, DtmSourceMetadataError
from scene_pipeline.etl.dtm.source import (
    REQUIRED_SOURCE_FIELDS,
    build_source_ref,
    download_source,
    load_source_meta,
    sha256_file,
)


class _FakeResponse:
    def __init__(self, chunks=(b"raster-bytes",), status=200, reason="OK"):
        self._chunks = chunks
        self.status_code = status
        self.reason = reason

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} {self.reason}", response=self)

    def iter_content(self, chunk_size=1):
        yield from self._chunks

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_required_fields_are_the_four_the_ticket_names():
    assert set(REQUIRED_SOURCE_FIELDS) == {"name", "url", "license", "retrieved"}


def test_complete_metadata_builds_a_source_ref(attribution):
    ref = build_source_ref(attribution)
    assert ref.name == attribution["name"]
    assert ref.url == attribution["url"]
    assert ref.license == attribution["license"]
    assert ref.retrieved == attribution["retrieved"]


@pytest.mark.parametrize("field", ["name", "url", "license", "retrieved"])
def test_each_missing_attribution_field_is_refused_by_name(attribution, field):
    meta = {k: v for k, v in attribution.items() if k != field}
    with pytest.raises(DtmSourceMetadataError, match=field):
        build_source_ref(meta)


@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
@pytest.mark.parametrize("field", ["name", "url", "license", "retrieved"])
def test_blank_attribution_field_is_refused(attribution, field, blank):
    meta = dict(attribution, **{field: blank})
    with pytest.raises(DtmSourceMetadataError, match=field):
        build_source_ref(meta)


def test_attribution_values_are_stripped(attribution):
    ref = build_source_ref(dict(attribution, name="  spaced name  "))
    assert ref.name == "spaced name"


@pytest.mark.parametrize("bad", ["not-a-date", "2026-13-01", "10/08/2026", "2026-08"])
def test_invalid_retrieved_date_is_refused(attribution, bad):
    with pytest.raises(DtmSourceMetadataError, match="retrieved"):
        build_source_ref(dict(attribution, retrieved=bad))


def test_retrieved_is_filled_in_when_this_run_did_the_download(attribution):
    meta = {k: v for k, v in attribution.items() if k != "retrieved"}
    ref = build_source_ref(meta, downloaded_on="2026-08-11")
    assert ref.retrieved == "2026-08-11"


def test_explicit_retrieved_wins_over_the_download_date(attribution):
    ref = build_source_ref(attribution, downloaded_on="2026-08-11")
    assert ref.retrieved == attribution["retrieved"]


def test_retrieved_is_required_for_a_local_file(attribution):
    """Nothing witnessed when a file on disk was obtained, so it must be told."""
    meta = {k: v for k, v in attribution.items() if k != "retrieved"}
    with pytest.raises(DtmSourceMetadataError, match="retrieved"):
        build_source_ref(meta)


def test_source_ref_serialises_every_required_field(attribution):
    payload = build_source_ref(attribution).to_dict()
    for field in REQUIRED_SOURCE_FIELDS:
        assert payload[field] == attribution[field].strip()


def test_load_source_meta_reads_a_json_file(attribution_file, attribution):
    assert load_source_meta(attribution_file, {}) == attribution


def test_overrides_beat_the_metadata_file(attribution_file, attribution):
    meta = load_source_meta(attribution_file, {"name": "override"})
    assert meta["name"] == "override"
    assert meta["url"] == attribution["url"]


def test_override_of_none_does_not_erase_the_file_value(attribution_file, attribution):
    meta = load_source_meta(attribution_file, {"name": None})
    assert meta["name"] == attribution["name"]


def test_load_source_meta_without_a_file_uses_overrides_only(attribution):
    assert load_source_meta(None, attribution) == attribution


def test_malformed_metadata_file_is_refused(tmp_path):
    path = tmp_path / "meta.json"
    path.write_text("nope", encoding="utf-8")
    with pytest.raises(DtmSourceMetadataError, match="meta.json"):
        load_source_meta(path, {})


def test_missing_metadata_file_is_refused(tmp_path):
    with pytest.raises(DtmSourceMetadataError, match="meta.json"):
        load_source_meta(tmp_path / "meta.json", {})


def test_metadata_file_holding_a_list_is_refused(tmp_path):
    path = tmp_path / "meta.json"
    path.write_text(json.dumps(["name"]), encoding="utf-8")
    with pytest.raises(DtmSourceMetadataError):
        load_source_meta(path, {})


def test_sha256_matches_hashlib(tmp_path):
    path = tmp_path / "blob.bin"
    payload = b"\x00\x01\x02" * 5000
    path.write_bytes(payload)
    assert sha256_file(path) == hashlib.sha256(payload).hexdigest()


def test_download_writes_the_body_to_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(requests, "get", lambda *a, **k: _FakeResponse((b"abc", b"def")))
    dest = tmp_path / "downloads" / "dtm.tif"
    result = download_source("https://example.invalid/dtm.tif", dest, timeout=30.0)
    assert result == dest
    assert dest.read_bytes() == b"abcdef"


def test_download_passes_the_timeout_through(tmp_path, monkeypatch):
    seen = {}

    def fake_get(url, **kwargs):
        seen.update(kwargs)
        return _FakeResponse()

    monkeypatch.setattr(requests, "get", fake_get)
    download_source("https://example.invalid/dtm.tif", tmp_path / "d.tif", timeout=12.5)
    assert seen["timeout"] == 12.5


def test_download_http_error_names_url_and_status(tmp_path, monkeypatch):
    monkeypatch.setattr(requests, "get",
                        lambda *a, **k: _FakeResponse(status=404, reason="Not Found"))
    with pytest.raises(DtmSourceError, match="404"):
        download_source("https://example.invalid/missing.tif", tmp_path / "d.tif", timeout=30.0)


def test_download_timeout_is_reported_as_a_timeout(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise requests.Timeout("timed out")

    monkeypatch.setattr(requests, "get", boom)
    with pytest.raises(DtmSourceError, match="(?i)time"):
        download_source("https://example.invalid/dtm.tif", tmp_path / "d.tif", timeout=0.001)


def test_download_connection_error_names_the_url(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("no route")

    monkeypatch.setattr(requests, "get", boom)
    with pytest.raises(DtmSourceError, match="example.invalid"):
        download_source("https://example.invalid/dtm.tif", tmp_path / "d.tif", timeout=30.0)


def test_failed_download_leaves_no_partial_file(tmp_path, monkeypatch):
    """A half-written download must not be mistaken for a usable source."""

    def half_then_die(*a, **k):
        def chunks():
            yield b"abc"
            raise requests.ConnectionError("dropped")

        return _FakeResponse(chunks())

    monkeypatch.setattr(requests, "get", half_then_die)
    dest = tmp_path / "dtm.tif"
    with pytest.raises(DtmSourceError):
        download_source("https://example.invalid/dtm.tif", dest, timeout=30.0)
    assert not dest.exists()
    assert list(tmp_path.glob("*.part")) == []
