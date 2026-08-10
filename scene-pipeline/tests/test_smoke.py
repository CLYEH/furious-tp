"""Skeleton smoke tests (FTP-27).

Declaration exam for the scene-pipeline project skeleton:
- every subpackage required by the ticket AC is importable
- every runtime dependency declared in pyproject.toml is importable

Boundary / error-path / permissions / concurrency categories are N/A for
this ticket (pure scaffold, no behavioral logic) as declared in the ticket.
"""

import importlib

import pytest

# AC: src/scene_pipeline/ subpackage layout, frozen here so that deleting
# any subpackage (or its __init__.py) fails exactly one test case.
SUBPACKAGES = [
    "scene_pipeline",
    "scene_pipeline.etl",
    "scene_pipeline.etl.dtm",
    "scene_pipeline.etl.osm",
    "scene_pipeline.etl.taipei",
    "scene_pipeline.compile",
    "scene_pipeline.compile.conflation",
    "scene_pipeline.compile.elevation",
    "scene_pipeline.compile.roads",
    "scene_pipeline.compile.terrain",
    "scene_pipeline.compile.props",
    "scene_pipeline.compile.physics",
    "scene_pipeline.qa",
    "scene_pipeline.cli",
]

# AC: runtime dependencies (import names; pyosmium imports as "osmium").
RUNTIME_DEPS = [
    "rasterio",
    "shapely",
    "pyproj",
    "osmium",
    "requests",
]


@pytest.mark.parametrize("module", SUBPACKAGES)
def test_subpackage_importable(module: str) -> None:
    importlib.import_module(module)


@pytest.mark.parametrize("module", RUNTIME_DEPS)
def test_runtime_dependency_importable(module: str) -> None:
    importlib.import_module(module)
