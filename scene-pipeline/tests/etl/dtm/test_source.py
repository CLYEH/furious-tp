"""Source acquisition and the source/version record (FTP-28 AC4).

PRD §4 requires attribution on everything shipped. The rule under exam: an
output with an incomplete source record is not produced at all. Attribution
that is merely *encouraged* is attribution that goes missing.
"""

from __future__ import annotations

import hashlib
import json
import os

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


def test_a_download_that_cannot_be_written_leaves_no_part_file(tmp_path, monkeypatch):
    """The `except OSError` arm of `download_source` had never been executed.

    Every other download-failure case here fails inside `requests`. The branch
    that handles the *local* write failing had no witness at all — not "no test
    could tell the difference", but never reached: deleting its `_discard` left
    the suite green, and so did a `raise RuntimeError` planted in the same
    place, which is the signature of code the exam never runs.

    It is also the likeliest way this download dies in the field. A nationwide
    20 m DTM is gigabytes; the disk filling up part-way through is a normal
    Tuesday, and it must not leave a `.part` behind, nor cost the operator the
    copy they already had.
    """

    def full_disk(*a, **k):
        def chunks():
            yield b"abc"
            raise OSError(28, "No space left on device")

        return _FakeResponse(chunks())

    monkeypatch.setattr(requests, "get", full_disk)
    dest = tmp_path / "dtm.tif"
    dest.write_bytes(b"the-raster-downloaded-last-week")
    with pytest.raises(DtmSourceError, match="(?i)no space"):
        download_source("https://example.invalid/dtm.tif", dest, timeout=30.0)
    assert list(tmp_path.glob("*.part")) == []
    assert dest.read_bytes() == b"the-raster-downloaded-last-week"


def test_a_download_whose_final_move_fails_leaves_no_part_file(tmp_path, monkeypatch):
    """The last step of the download had no witness either.

    Found the same way as the case above and worth recording as such: the
    mutant that deletes this branch's `_discard` survived, and so did a
    `raise RuntimeError` planted in the same place — nothing in the suite ever
    reached the failure path of the move that puts a completed download in
    place. A rejected rename there (the destination held open by a reader, the
    usual cause) would otherwise leave a fully downloaded `.part` sitting next
    to the file it failed to become, gigabytes of it, with the operator told
    only that the download failed.
    """
    monkeypatch.setattr(requests, "get", lambda *a, **k: _FakeResponse((b"abc",)))

    def refuse(src, dst):
        raise PermissionError(13, "the file is open in another process", str(dst))

    monkeypatch.setattr(os, "replace", refuse)
    dest = tmp_path / "dtm.tif"
    dest.write_bytes(b"the-raster-downloaded-last-week")
    with pytest.raises(DtmSourceError, match="into place"):
        download_source("https://example.invalid/dtm.tif", dest, timeout=30.0)
    assert list(tmp_path.glob("*.part")) == []
    assert dest.read_bytes() == b"the-raster-downloaded-last-week"


def test_a_timeout_part_way_through_the_body_leaves_no_part_file(tmp_path, monkeypatch):
    """A read timeout arrives mid-stream, where the existing case cannot see it.

    `test_download_timeout_is_reported_as_a_timeout` raises from `requests.get`
    itself, so no `.part` was ever created and its `_discard` is unobservable.
    Real read timeouts arrive while the body is streaming — the connection
    stalls after some megabytes — and that is the only shape in which this
    branch has anything to clean up.
    """

    def stall_mid_body(*a, **k):
        def chunks():
            yield b"abc"
            raise requests.ReadTimeout("the connection stalled")

        return _FakeResponse(chunks())

    monkeypatch.setattr(requests, "get", stall_mid_body)
    dest = tmp_path / "dtm.tif"
    with pytest.raises(DtmSourceError, match="(?i)time"):
        download_source("https://example.invalid/dtm.tif", dest, timeout=30.0)
    assert not dest.exists()
    assert list(tmp_path.glob("*.part")) == []


def test_an_interrupted_download_leaves_no_part_file(tmp_path, monkeypatch):
    """Ctrl-C is not an `OSError` here either, and this is the longest step.

    `_publish` grew an `except BaseException` for exactly this reason; without
    the same clause here the module ships half a policy, and the half that is
    missing covers the step an interrupt is *most* likely to land in. A
    nationwide 20 m DTM is gigabytes, and downloading it takes longer than
    everything else this ETL does put together — pressing Ctrl-C during it is
    not an exotic case, it is the normal way an operator changes their mind.

    The invariant is the one this function's own docstring states, "leaving
    nothing behind if it fails", and it does not have an exception-type
    clause: an interrupt that leaves a gigabyte-sized `.part` in the download
    directory violates it just as squarely as a dropped connection would, and
    unlike the error paths nothing would ever come back to tidy it.
    """

    def interrupted_mid_body(*a, **k):
        def chunks():
            yield b"abc"
            raise KeyboardInterrupt()

        return _FakeResponse(chunks())

    monkeypatch.setattr(requests, "get", interrupted_mid_body)
    dest = tmp_path / "dtm.tif"
    dest.write_bytes(b"the-raster-downloaded-last-week")
    with pytest.raises(KeyboardInterrupt):
        download_source("https://example.invalid/dtm.tif", dest, timeout=30.0)
    assert list(tmp_path.glob("*.part")) == []
    assert dest.read_bytes() == b"the-raster-downloaded-last-week"


def test_an_interrupt_at_the_final_move_leaves_no_part_file(tmp_path, monkeypatch):
    """The download's last step sits in a *second* try, and it was left out.

    Adding the clause above to the streaming block only would repeat, one
    level down, the very defect it fixes: `_publish` keeps both of its renames
    inside the one `except BaseException`, while here the move that puts a
    completed download into place has its own try with `except OSError` alone.
    An interrupt raised in the handful of bytecodes before that rename runs
    therefore escapes with the `.part` still on disk — and at that point the
    `.part` is the *whole* download, gigabytes of it, one rename away from
    being the file the operator wanted.

    Narrow, but not narrower than the code is careful about elsewhere, and the
    clause that closes it is three lines with nothing to weigh against it.
    """
    monkeypatch.setattr(requests, "get", lambda *a, **k: _FakeResponse((b"abcdef",)))

    def interrupted(src, dst):
        raise KeyboardInterrupt()

    monkeypatch.setattr(os, "replace", interrupted)
    dest = tmp_path / "dtm.tif"
    dest.write_bytes(b"the-raster-downloaded-last-week")
    with pytest.raises(KeyboardInterrupt):
        download_source("https://example.invalid/dtm.tif", dest, timeout=30.0)
    assert list(tmp_path.glob("*.part")) == []
    assert dest.read_bytes() == b"the-raster-downloaded-last-week"


def test_a_failed_download_does_not_destroy_the_copy_already_on_disk(tmp_path, monkeypatch):
    """The `.part` hop guards what is already there, not just tidiness.

    Streaming straight to `dest` truncates a good local copy the instant the
    body starts arriving, and the cleanup that follows removes the remains —
    so the test above still passes while the operator's existing source has
    been destroyed by a dropped connection. Re-running a download must never
    be able to leave them with less than they started with.
    """

    def half_then_die(*a, **k):
        def chunks():
            yield b"abc"
            raise requests.ConnectionError("dropped")

        return _FakeResponse(chunks())

    monkeypatch.setattr(requests, "get", half_then_die)
    dest = tmp_path / "dtm.tif"
    dest.write_bytes(b"the-raster-downloaded-last-week")
    with pytest.raises(DtmSourceError):
        download_source("https://example.invalid/dtm.tif", dest, timeout=30.0)
    assert dest.read_bytes() == b"the-raster-downloaded-last-week"
    assert list(tmp_path.glob("*.part")) == []
