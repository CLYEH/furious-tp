"""The single command (FTP-28 AC1).

`python -m scene_pipeline.etl.dtm` is the whole ETL: a source path or URL in,
a clipped EPSG:3826 GeoTIFF plus its source record out. The command lives in
this package rather than in `cli/` because `cli/` belongs to another ticket.
"""

from __future__ import annotations

import datetime as dt
import json
import subprocess
import sys

import pytest
import rasterio
import requests

from scene_pipeline.etl.dtm.__main__ import main

from .conftest import M1_E_MAX, M1_E_MIN, M1_N_MAX, M1_N_MIN


def attribution_argv(attribution):
    return [
        "--source-name", attribution["name"],
        "--source-url", attribution["url"],
        "--license", attribution["license"],
        "--retrieved", attribution["retrieved"],
    ]


def test_one_command_produces_the_geotiff_and_its_record(tmp_path, aligned_source, attribution):
    out = tmp_path / "out" / "dtm_20m_epsg3826.tif"
    code = main(["--source", str(aligned_source), "--out", str(out),
                 *attribution_argv(attribution)])
    assert code == 0
    assert out.exists()
    assert (out.parent / "dtm_20m_epsg3826.source.json").exists()


def test_the_command_defaults_to_the_contract_bbox(tmp_path, aligned_source, attribution):
    out = tmp_path / "out" / "dtm.tif"
    assert main(["--source", str(aligned_source), "--out", str(out),
                 *attribution_argv(attribution)]) == 0
    with rasterio.open(out) as ds:
        assert ds.bounds.left == M1_E_MIN
        assert ds.bounds.bottom == M1_N_MIN
        assert ds.bounds.right == M1_E_MAX
        assert ds.bounds.top == M1_N_MAX


def test_an_explicit_area_file_overrides_the_default(tmp_path, aligned_source, attribution,
                                                     m1_area_doc):
    doc = json.loads(json.dumps(m1_area_doc))
    doc["bbox"] = {"e_min": 306000, "e_max": 306500, "n_min": 2768000, "n_max": 2768500}
    area = tmp_path / "small.json"
    area.write_text(json.dumps(doc), encoding="utf-8")
    out = tmp_path / "out" / "dtm.tif"
    assert main(["--source", str(aligned_source), "--out", str(out), "--area", str(area),
                 *attribution_argv(attribution)]) == 0
    with rasterio.open(out) as ds:
        assert (ds.width, ds.height) == (25, 25)


def test_attribution_flags_reach_the_record(tmp_path, aligned_source, attribution):
    out = tmp_path / "out" / "dtm.tif"
    main(["--source", str(aligned_source), "--out", str(out), *attribution_argv(attribution)])
    record = json.loads((out.parent / "dtm.source.json").read_text(encoding="utf-8"))
    assert record["source"]["license"] == attribution["license"]


def test_a_metadata_file_can_stand_in_for_the_flags(tmp_path, aligned_source, attribution_file,
                                                    attribution):
    out = tmp_path / "out" / "dtm.tif"
    assert main(["--source", str(aligned_source), "--out", str(out),
                 "--source-meta", str(attribution_file)]) == 0
    record = json.loads((out.parent / "dtm.source.json").read_text(encoding="utf-8"))
    assert record["source"]["name"] == attribution["name"]


def test_a_flag_overrides_the_metadata_file(tmp_path, aligned_source, attribution_file):
    out = tmp_path / "out" / "dtm.tif"
    main(["--source", str(aligned_source), "--out", str(out), "--source-meta",
          str(attribution_file), "--source-name", "flag wins"])
    record = json.loads((out.parent / "dtm.source.json").read_text(encoding="utf-8"))
    assert record["source"]["name"] == "flag wins"


@pytest.mark.parametrize("argv", [[], ["--source", "x.tif"], ["--out", "y.tif"]])
def test_missing_required_arguments_is_a_usage_error(argv):
    with pytest.raises(SystemExit) as excinfo:
        main(argv)
    assert excinfo.value.code == 2


def test_a_missing_source_is_reported_as_a_message_not_a_traceback(tmp_path, attribution, capsys):
    missing = tmp_path / "absent.tif"
    code = main(["--source", str(missing), "--out", str(tmp_path / "out" / "d.tif"),
                 *attribution_argv(attribution)])
    assert code != 0
    err = capsys.readouterr().err
    assert "absent.tif" in err
    assert "Traceback" not in err


def test_incomplete_attribution_is_reported_by_field(tmp_path, aligned_source, attribution,
                                                     capsys):
    code = main(["--source", str(aligned_source), "--out", str(tmp_path / "out" / "d.tif"),
                 "--source-name", attribution["name"], "--source-url", attribution["url"],
                 "--retrieved", attribution["retrieved"]])
    assert code != 0
    assert "license" in capsys.readouterr().err


@pytest.mark.parametrize("resolution", ["0", "-20"])
def test_a_non_positive_resolution_is_rejected(tmp_path, aligned_source, attribution, resolution,
                                               capsys):
    code = main(["--source", str(aligned_source), "--out", str(tmp_path / "out" / "d.tif"),
                 "--resolution", resolution, *attribution_argv(attribution)])
    assert code != 0
    assert "resolution" in capsys.readouterr().err


def test_a_resolution_that_does_not_divide_the_tile_is_rejected(tmp_path, aligned_source,
                                                                attribution, capsys):
    code = main(["--source", str(aligned_source), "--out", str(tmp_path / "out" / "d.tif"),
                 "--resolution", "30", *attribution_argv(attribution)])
    assert code != 0
    assert "tile" in capsys.readouterr().err


def test_a_declared_sentinel_reaches_the_reader(tmp_path, source_array, attribution):
    from .conftest import SOURCE_NORTH, SOURCE_WEST, write_raster

    array = source_array.copy()
    array[80:83, 80:83] = -999.0
    src = write_raster(tmp_path / "src" / "untagged.tif", array, west=SOURCE_WEST,
                       north=SOURCE_NORTH, nodata=None)
    out = tmp_path / "out" / "dtm.tif"
    assert main(["--source", str(src), "--out", str(out), "--source-nodata", "-999",
                 *attribution_argv(attribution)]) == 0
    record = json.loads((out.parent / "dtm.source.json").read_text(encoding="utf-8"))
    assert -999.0 in record["nodata"]["source_nodata"]
    assert record["valid_fraction"] < 1.0


def test_a_url_source_is_downloaded_and_dated(tmp_path, aligned_source, attribution, monkeypatch):
    payload = aligned_source.read_bytes()

    class _Response:
        status_code = 200

        def raise_for_status(self):
            return None

        def iter_content(self, chunk_size=1):
            yield payload

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(requests, "get", lambda *a, **k: _Response())
    out = tmp_path / "out" / "dtm.tif"
    code = main(["--source", "https://example.invalid/dtm.tif", "--out", str(out),
                 "--download-dir", str(tmp_path / "dl"),
                 "--source-name", attribution["name"], "--license", attribution["license"]])
    assert code == 0
    record = json.loads((out.parent / "dtm.source.json").read_text(encoding="utf-8"))
    assert record["source"]["url"] == "https://example.invalid/dtm.tif"
    assert record["source"]["retrieved"] == dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def test_a_download_failure_is_reported_without_a_traceback(tmp_path, attribution, monkeypatch,
                                                            capsys):
    def boom(*a, **k):
        raise requests.ConnectionError("no route to host")

    monkeypatch.setattr(requests, "get", boom)
    code = main(["--source", "https://example.invalid/dtm.tif", "--out",
                 str(tmp_path / "out" / "d.tif"), "--download-dir", str(tmp_path / "dl"),
                 "--source-name", attribution["name"], "--license", attribution["license"]])
    assert code != 0
    err = capsys.readouterr().err
    assert "example.invalid" in err
    assert "Traceback" not in err


def test_the_module_is_runnable_with_dash_m():
    """AC1 says "single command": prove the entry point exists as advertised."""
    completed = subprocess.run([sys.executable, "-m", "scene_pipeline.etl.dtm", "--help"],
                               capture_output=True, text=True)
    assert completed.returncode == 0
    assert "--source" in completed.stdout
