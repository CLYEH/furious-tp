"""FTP-69 ground-colouring probe — throwaway measurement script.

**Not a pipeline module.** It lives in `docs/spikes/` because its only job is to
produce the numbers in `ground-colouring.md` reproducibly. Nothing imports it.

Why Python and not the `.mjs` shape Spike R1 used: the headline number is the
area of a *union of polygons clipped to a rectangle*, with inner rings and
invalid geometry to survive. Hand-rolling that is how a spike ends up reporting
a number nobody can trust. shapely does it, and the interpreter that already
has shapely is the pipeline's own venv.

Measurement CRS is **EPSG:3826** throughout, so an area in m^2 is an area in
m^2. The M1 bbox is read from `contracts/constants/m1_area.json` — the contract
is the one home for it (mirroring `etl/osm/bbox.py::from_area_file`), so this
script cannot drift from the pipeline by keeping a second copy.

Discipline, enforced by `ground-probe.selftest.py`:

* **No upstream response body is ever recorded or printed.** Availability
  samples carry a status, a byte count and a body *class* — never bytes, never
  a decoded fragment, never an exception message (a message can quote a body).
* **Every zero this script can report has a control** in the self-test.

Sub-commands
------------
  osm       fetch M1-bbox landuse/natural/leisure/waterway + highways (Overpass)
  measure   measure a saved fetch: coverage, classes, holes, edges, two methods
  zoning    measure a local land-use-zoning file (GeoJSON) the same way
  avail     availability sampling of a tile/imagery endpoint
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import Polygon, box, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree
from shapely.validation import make_valid

# --- geometry primitives ---------------------------------------------------


@dataclass(frozen=True)
class BBox:
    """Clip area in EPSG:3826 metres (same field order as etl/osm/bbox.py)."""

    e_min: float
    n_min: float
    e_max: float
    n_max: float

    @classmethod
    def from_area_file(cls, path: str | Path) -> "BBox":
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        b = payload["bbox"]
        return cls(
            float(b["e_min"]), float(b["n_min"]), float(b["e_max"]), float(b["n_max"])
        )

    @property
    def area_m2(self) -> float:
        return (self.e_max - self.e_min) * (self.n_max - self.n_min)

    def polygon(self) -> Polygon:
        return box(self.e_min, self.n_min, self.e_max, self.n_max)


@dataclass(frozen=True)
class Feature:
    key: str
    value: str
    outer: tuple[tuple[float, float], ...]
    inners: tuple[tuple[tuple[float, float], ...], ...] = ()
    source: str = ""

    @property
    def cls(self) -> str:
        return f"{self.key}={self.value}"


def feature(key, value, outer, inners=(), source="") -> Feature:
    return Feature(
        key=key,
        value=value,
        outer=tuple((float(x), float(y)) for x, y in outer),
        inners=tuple(tuple((float(x), float(y)) for x, y in ring) for ring in inners),
        source=source,
    )


#: A ring needs 4 positions to close a triangle; fewer cannot bound an area.
MIN_RING_POSITIONS = 4


@dataclass
class Built:
    """Geometries built from features, with the two rejection counts."""

    geoms: list[BaseGeometry] = field(default_factory=list)
    classes: list[str] = field(default_factory=list)
    skipped: int = 0
    invalid: int = 0


def build(features) -> Built:
    """Turn features into valid polygonal geometries, counting what failed.

    Two failure classes, kept apart because they mean different things about
    the upstream data: `skipped` is "this could never have been an area",
    `invalid` is "this is an area, drawn wrongly" (self-intersection etc.),
    which is repaired and counted rather than dropped or trusted.
    """
    out = Built()
    for feat in features:
        if len(feat.outer) < MIN_RING_POSITIONS:
            out.skipped += 1
            continue
        rings = [r for r in feat.inners if len(r) >= MIN_RING_POSITIONS]
        try:
            geom: BaseGeometry = Polygon(feat.outer, rings)
        except Exception:
            out.skipped += 1
            continue
        if geom.is_empty:
            out.skipped += 1
            continue
        if not geom.is_valid:
            out.invalid += 1
            geom = make_valid(geom)
            geom = _polygonal_part(geom)
            if geom is None or geom.is_empty:
                continue
        out.geoms.append(geom)
        out.classes.append(feat.cls)
    return out


def _polygonal_part(geom: BaseGeometry):
    """Keep only the 2-D part of a repaired geometry.

    `make_valid` on a bow-tie can hand back a collection holding stray lines;
    a line has zero area but is not nothing, and letting it into a union makes
    later predicates behave in ways nobody reading an area number would expect.
    """
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    if hasattr(geom, "geoms"):
        parts = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        if parts:
            return unary_union(parts)
    return None


@dataclass
class CoverageResult:
    covered_m2: float
    fraction: float
    skipped: int
    invalid: int
    used: int


def coverage(features, bbox: BBox) -> CoverageResult:
    """Union of every feature, clipped to the bbox. Overlaps count once."""
    built = build(features)
    if not built.geoms:
        return CoverageResult(0.0, 0.0, built.skipped, built.invalid, 0)
    union = unary_union(built.geoms).intersection(bbox.polygon())
    area = float(union.area)
    return CoverageResult(
        covered_m2=area,
        fraction=area / bbox.area_m2,
        skipped=built.skipped,
        invalid=built.invalid,
        used=len(built.geoms),
    )


def class_areas(features, bbox: BBox) -> dict[str, float]:
    """Per-class clipped union area.

    Unioned **within** each class, so a class cannot inflate itself by mapping
    the same ground twice — but NOT deduplicated across classes, so the values
    can sum past the overall coverage where classes overlap. That is a real
    property of the data and the report says so rather than hiding it.
    """
    built = build(features)
    clip = bbox.polygon()
    grouped: dict[str, list[BaseGeometry]] = {}
    for geom, cls in zip(built.geoms, built.classes):
        grouped.setdefault(cls, []).append(geom)
    areas = {}
    for cls, geoms in grouped.items():
        area = float(unary_union(geoms).intersection(clip).area)
        if area > 0:
            areas[cls] = area
    return dict(sorted(areas.items(), key=lambda kv: -kv[1]))


@dataclass
class Hole:
    area_m2: float
    centroid_e: float
    centroid_n: float


def holes(features, bbox: BBox, min_area_m2: float) -> list[Hole]:
    """Uncovered pieces of the bbox, largest first, smaller than the filter dropped."""
    built = build(features)
    clip = bbox.polygon()
    if built.geoms:
        gap = clip.difference(unary_union(built.geoms))
    else:
        gap = clip
    parts = list(gap.geoms) if hasattr(gap, "geoms") else ([gap] if not gap.is_empty else [])
    found = [
        Hole(float(p.area), float(p.centroid.x), float(p.centroid.y))
        for p in parts
        if p.area >= min_area_m2
    ]
    return sorted(found, key=lambda h: -h.area_m2)


@dataclass
class GridResult:
    fraction: float
    hits: int
    total: int
    step_m: float


def grid_coverage(features, bbox: BBox, step_m: float) -> GridResult:
    """Coverage by point sampling — the independent control for `coverage`.

    Cell centres, so a sample never lands exactly on a boundary where the
    answer depends on a tie-break rather than on the data.
    """
    built = build(features)
    if not built.geoms:
        cols = max(1, int(math.floor((bbox.e_max - bbox.e_min) / step_m)))
        rows = max(1, int(math.floor((bbox.n_max - bbox.n_min) / step_m)))
        return GridResult(0.0, 0, cols * rows, step_m)

    tree = STRtree(built.geoms)
    prepared = [prep(g) for g in built.geoms]

    cols = max(1, int(math.floor((bbox.e_max - bbox.e_min) / step_m)))
    rows = max(1, int(math.floor((bbox.n_max - bbox.n_min) / step_m)))
    hits = 0
    from shapely.geometry import Point

    for j in range(rows):
        n = bbox.n_min + (j + 0.5) * step_m
        for i in range(cols):
            e = bbox.e_min + (i + 0.5) * step_m
            pt = Point(e, n)
            for idx in tree.query(pt):
                if prepared[idx].contains(pt):
                    hits += 1
                    break
    return GridResult(hits / (cols * rows), hits, cols * rows, step_m)


def edge_stats(features, bbox: BBox) -> dict[str, int]:
    """How features sit relative to the bbox edge — the boundary question."""
    built = build(features)
    clip = bbox.polygon()
    stats = {"inside": 0, "clipped": 0, "outside": 0}
    for geom in built.geoms:
        if geom.within(clip):
            stats["inside"] += 1
        elif geom.intersects(clip) and geom.intersection(clip).area > 0:
            stats["clipped"] += 1
        else:
            stats["outside"] += 1
    return stats


def source_split(features, bbox: BBox) -> dict:
    """Clipped area carried by ways vs by relations.

    The reuse question — "can FTP-29's clipper do this?" — is decided by AREA,
    not by element count. `etl/osm/read.py` walks `osmium.osm.WAY` only, so
    whatever share sits in relations is invisible to it, and a handful of
    relations can hold most of the ground.
    """
    clip = bbox.polygon()
    out = {}
    for name in ("way", "relation"):
        built = build([f for f in features if f.source == name])
        area = (
            float(unary_union(built.geoms).intersection(clip).area)
            if built.geoms
            else 0.0
        )
        out[f"{name}_features"] = len(built.geoms)
        out[f"{name}_m2"] = area
    total = out["way_m2"] + out["relation_m2"]
    out["relation_share_of_area"] = (
        round(out["relation_m2"] / total, 4) if total else None
    )
    return out


def edge_band(features, bbox: BBox, width_m: float) -> dict:
    """Coverage in a band along the bbox edge vs the interior.

    The boundary worry is "does clipping leave a blank rim?". Counting clipped
    features cannot answer it — only comparing how well the rim is covered
    against how well the middle is can. Equal fractions mean no rim.
    """
    clip = bbox.polygon()
    inner = clip.buffer(-width_m)
    band = clip.difference(inner)
    built = build(features)
    union = unary_union(built.geoms).intersection(clip) if built.geoms else Polygon()
    band_area = float(band.area)
    inner_area = float(inner.area)
    return {
        "width_m": width_m,
        "band_fraction": round(float(union.intersection(band).area) / band_area, 6)
        if band_area
        else None,
        "interior_fraction": round(float(union.intersection(inner).area) / inner_area, 6)
        if inner_area
        else None,
    }


def size_distribution(features, bbox: BBox) -> dict:
    """Clipped per-feature areas — the granularity question, as numbers.

    "Is a whole city block one colour?" is answered by how big the individual
    polygons are, not by what the dataset is called.
    """
    built = build(features)
    clip = bbox.polygon()
    areas = sorted(
        float(g.intersection(clip).area)
        for g in built.geoms
        if g.intersects(clip) and g.intersection(clip).area > 0
    )
    if not areas:
        return {"count": 0}

    def pct(p):
        return areas[min(len(areas) - 1, int(p * len(areas)))]

    return {
        "count": len(areas),
        "min_m2": areas[0],
        "p25_m2": pct(0.25),
        "median_m2": pct(0.5),
        "p75_m2": pct(0.75),
        "p95_m2": pct(0.95),
        "max_m2": areas[-1],
        "mean_m2": sum(areas) / len(areas),
    }


# --- availability sampling -------------------------------------------------

_JPEG = b"\xff\xd8\xff"
_PNG = b"\x89PNG"


def _body_class(payload: bytes) -> str:
    """Classify a body WITHOUT reproducing it.

    `all_nul` is its own class on purpose: Spike R1 watched 16 endpoints answer
    HTTP 200 with nothing but NUL bytes for ~40 minutes. A sampler that counts
    that as success measures the wrong thing.
    """
    if not payload:
        return "empty"
    if payload.count(0) == len(payload):
        return "all_nul"
    if payload.startswith(_JPEG):
        return "jpeg"
    if payload.startswith(_PNG):
        return "png"
    head = payload[:1].lstrip()
    if head in (b"{", b"["):
        return "json_like"
    if payload[:5].lower().startswith(b"<?xml") or payload[:1] == b"<":
        return "xml_like"
    return "other"


def sample_availability(url, samples=20, session=None, delay_s=3.0, timeout=20.0) -> dict:
    """Sample `url` `samples` times; record class, size and timing only.

    Deliberately serial and slow by default: this is a courtesy measurement of
    somebody else's public service, not a load test.
    """
    if session is None:
        import requests

        session = requests.Session()
        session.headers["User-Agent"] = USER_AGENT

    records = []
    ok = errors = 0
    for i in range(samples):
        if i and delay_s:
            time.sleep(delay_s)
        started = time.monotonic()
        stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        try:
            response = session.get(url, timeout=timeout)
        except Exception as exc:  # noqa: BLE001
            errors += 1
            # The TYPE, never the message: an exception message can quote the
            # very upstream bytes this probe refuses to restate.
            records.append(
                {
                    "at": stamp,
                    "status": "error",
                    "error_class": type(exc).__name__,
                    "ms": round((time.monotonic() - started) * 1000),
                }
            )
            continue
        payload = response.content or b""
        klass = _body_class(payload)
        entry = {
            "at": stamp,
            "status": response.status_code,
            "bytes": len(payload),
            "body_class": klass,
            "content_type": str(response.headers.get("Content-Type", ""))[:64],
            "ms": round((time.monotonic() - started) * 1000),
        }
        records.append(entry)
        if response.status_code == 200 and klass not in ("all_nul", "empty"):
            ok += 1

    durations = sorted(r["ms"] for r in records if "ms" in r and r["status"] != "error")
    summary = {
        "url": url,
        "samples": records,
        "n": len(records),
        "ok": ok,
        "error": errors,
        "p50_ms": durations[len(durations) // 2] if durations else None,
        "p95_ms": durations[min(len(durations) - 1, int(0.95 * len(durations)))]
        if durations
        else None,
    }
    return summary


# --- OSM acquisition (Overpass, bbox-scoped) -------------------------------

OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)

#: Measured, not assumed: overpass-api.de answers the default `python-requests`
#: User-Agent with **406** on an otherwise identical, valid query, and **200**
#: with this one. Same query, same second, only the header differs. Without
#: this line the probe reports a dead source that is in fact alive — the exact
#: shape of false red this spike is supposed to avoid.
USER_AGENT = "furious-tp-spike/FTP-69 (engineering due diligence; contact via repo)"

AREA_TAGS = ("landuse", "natural", "leisure", "waterway", "amenity", "place")


def overpass_query(south, west, north, east, tags=AREA_TAGS) -> str:
    bbox = f"{south},{west},{north},{east}"
    parts = []
    for tag in tags:
        parts.append(f'  way["{tag}"]({bbox});')
        parts.append(f'  relation["{tag}"]({bbox});')
    body = "\n".join(parts)
    return f"[out:json][timeout:180];\n(\n{body}\n);\nout geom;\n"


def highway_query(south, west, north, east) -> str:
    bbox = f"{south},{west},{north},{east}"
    return f'[out:json][timeout:180];\n(\n  way["highway"]({bbox});\n);\nout geom;\n'


def fetch_overpass(
    query: str, out_path: Path, session=None, timeout=300, attempts=4, backoff=45.0
) -> dict:
    """POST `query` to the mirrors in turn, retrying on 429.

    EVERY attempt is recorded, not just the last one. A fetch that succeeded on
    the third try after two 429s is a different fact about the source than a
    fetch that worked first time, and the report needs to be able to say which
    happened — Overpass's rate limit is part of what candidate B costs.
    """
    if session is None:
        import requests

        session = requests.Session()
        session.headers["User-Agent"] = USER_AGENT
    log: list[dict] = []
    for round_index in range(attempts):
        for url in OVERPASS_URLS:
            started = time.monotonic()
            stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
            try:
                response = session.post(url, data={"data": query}, timeout=timeout)
            except Exception as exc:  # noqa: BLE001
                log.append(
                    {
                        "at": stamp,
                        "endpoint": url,
                        "status": "error",
                        "error_class": type(exc).__name__,
                    }
                )
                continue
            payload = response.content or b""
            record = {
                "at": stamp,
                "endpoint": url,
                "status": response.status_code,
                "bytes": len(payload),
                "body_class": _body_class(payload),
                "ms": round((time.monotonic() - started) * 1000),
            }
            log.append(record)
            if response.status_code == 200 and record["body_class"] == "json_like":
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_bytes(payload)
                return {"saved": str(out_path), "attempts": log}
        if round_index < attempts - 1:
            time.sleep(backoff * (round_index + 1))
    return {"saved": None, "attempts": log}


# --- OSM element -> Feature ------------------------------------------------

_TO_3826 = Transformer.from_crs("EPSG:4326", "EPSG:3826", always_xy=True)


def _project(coords):
    return [_TO_3826.transform(c["lon"], c["lat"]) for c in coords]


def _classify(tags: dict) -> tuple[str, str] | None:
    """First area-bearing tag wins, in a fixed order.

    Fixed so the class breakdown is reproducible: an element tagged both
    `leisure=park` and `landuse=grass` must land in the same bucket on every
    run, not wherever dict order put it.
    """
    for key in AREA_TAGS:
        if key in tags:
            return key, tags[key]
    return None


#: `amenity`/`place` carry a lot of non-ground values; only these paint ground.
GROUND_AMENITY = {"parking", "school", "university", "hospital", "college", "kindergarten"}
GROUND_PLACE = {"square"}


def _paints_ground(key: str, value: str) -> bool:
    if key == "amenity":
        return value in GROUND_AMENITY
    if key == "place":
        return value in GROUND_PLACE
    if key == "waterway":
        return value in {"riverbank", "dock"}
    return True


def _rings_from_members(members, role: str) -> list[list[tuple[float, float]]]:
    """Stitch member ways of one role into closed rings.

    Overpass hands multipolygon members back as separate open ways; a river
    bank or a park boundary is routinely several of them. Ways that cannot be
    closed into a ring are dropped, and the caller counts the drop.
    """
    segments = [
        _project(m["geometry"])
        for m in members
        if m.get("role") == role and m.get("type") == "way" and m.get("geometry")
    ]
    rings = []
    pending = [s for s in segments if len(s) >= 2]
    while pending:
        current = pending.pop(0)
        changed = True
        while changed and current[0] != current[-1]:
            changed = False
            for i, seg in enumerate(pending):
                if _close(current[-1], seg[0]):
                    current = current + seg[1:]
                    pending.pop(i)
                    changed = True
                    break
                if _close(current[-1], seg[-1]):
                    current = current + seg[::-1][1:]
                    pending.pop(i)
                    changed = True
                    break
                if _close(current[0], seg[-1]):
                    current = seg[:-1] + current
                    pending.pop(i)
                    changed = True
                    break
                if _close(current[0], seg[0]):
                    current = seg[::-1][:-1] + current
                    pending.pop(i)
                    changed = True
                    break
        if len(current) >= MIN_RING_POSITIONS and _close(current[0], current[-1]):
            rings.append(current)
    return rings


def _close(a, b, tol=0.05) -> bool:
    return abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol


def features_from_overpass(payload: dict) -> tuple[list[Feature], dict]:
    """Convert an Overpass `out geom` payload into projected features."""
    stats = {
        "elements": 0,
        "way_features": 0,
        "relation_features": 0,
        "unclosed_ways": 0,
        "relation_unbuilt": 0,
        "not_ground": 0,
        "untagged": 0,
    }
    features: list[Feature] = []
    for element in payload.get("elements", []):
        stats["elements"] += 1
        tags = element.get("tags") or {}
        found = _classify(tags)
        if not found:
            stats["untagged"] += 1
            continue
        key, value = found
        if not _paints_ground(key, value):
            stats["not_ground"] += 1
            continue

        if element["type"] == "way":
            geometry = element.get("geometry") or []
            ring = _project(geometry)
            if len(ring) < MIN_RING_POSITIONS or not _close(ring[0], ring[-1]):
                stats["unclosed_ways"] += 1
                continue
            features.append(feature(key, value, ring, source="way"))
            stats["way_features"] += 1
        elif element["type"] == "relation":
            members = element.get("members") or []
            outers = _rings_from_members(members, "outer")
            inners = _rings_from_members(members, "inner")
            if not outers:
                stats["relation_unbuilt"] += 1
                continue
            for outer in outers:
                features.append(feature(key, value, outer, inners, source="relation"))
            stats["relation_features"] += len(outers)
    return features, stats


def highways_from_overpass(payload: dict) -> list[list[tuple[float, float]]]:
    lines = []
    for element in payload.get("elements", []):
        if element.get("type") != "way":
            continue
        geometry = element.get("geometry") or []
        if len(geometry) >= 2:
            lines.append(_project(geometry))
    return lines


# --- commands --------------------------------------------------------------


def _wgs84_bbox(bbox: BBox, margin=0.0005):
    to_wgs = Transformer.from_crs("EPSG:3826", "EPSG:4326", always_xy=True)
    corners = [
        to_wgs.transform(bbox.e_min, bbox.n_min),
        to_wgs.transform(bbox.e_max, bbox.n_min),
        to_wgs.transform(bbox.e_max, bbox.n_max),
        to_wgs.transform(bbox.e_min, bbox.n_max),
    ]
    lons = [c[0] for c in corners]
    lats = [c[1] for c in corners]
    return (
        min(lats) - margin,
        min(lons) - margin,
        max(lats) + margin,
        max(lons) + margin,
    )


def cmd_osm(args) -> int:
    bbox = BBox.from_area_file(args.area)
    south, west, north, east = _wgs84_bbox(bbox)
    out = Path(args.out)
    record = {
        "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "wgs84_bbox": [south, west, north, east],
        "epsg3826_bbox": [bbox.e_min, bbox.n_min, bbox.e_max, bbox.n_max],
    }
    record["areas"] = fetch_overpass(
        overpass_query(south, west, north, east), out / "osm-areas.json"
    )
    time.sleep(args.delay)
    record["highways"] = fetch_overpass(
        highway_query(south, west, north, east), out / "osm-highways.json"
    )
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


def _ring_is_outer(ring) -> bool:
    """ESRI shapefile rule: an outer ring is clockwise, a hole is anticlockwise.

    Decided by the sign of the shoelace sum rather than by ring order, because
    a shape's parts arrive in file order and a hole is not required to follow
    the ring it punches.
    """
    total = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
        total += (x1 - x0) * (y1 + y0)
    return total > 0  # clockwise in a Y-up frame


def features_from_shapefile(path, class_field, class_key, encoding="cp950"):
    """Read a polygon shapefile into the same Feature shape as the OSM path.

    Same downstream code measures both candidates; a comparison where each
    side went through its own union/clip logic would be comparing the scripts
    as much as the data.
    """
    import shapefile  # pyshp; only this branch needs it

    reader = shapefile.Reader(str(path), encoding=encoding)
    names = [f[0] for f in reader.fields[1:]]
    features: list[Feature] = []
    stats = {
        "elements": 0,
        "way_features": 0,
        "relation_features": 0,
        "rings_total": 0,
        "shapes_multi_ring": 0,
        "clockwise_rings": 0,
        "anticlockwise_rings": 0,
        "orphan_inner_rings": 0,
        "shapes_no_clockwise_ring": 0,
    }
    for shape_record in reader.iterShapeRecords():
        stats["elements"] += 1
        geom = shape_record.shape
        if not geom.points:
            continue
        record = dict(zip(names, shape_record.record))
        value = str(record.get(class_field, "?")).strip() or "(blank)"

        bounds = list(geom.parts) + [len(geom.points)]
        rings = [
            [(float(x), float(y)) for x, y in geom.points[bounds[i] : bounds[i + 1]]]
            for i in range(len(bounds) - 1)
        ]
        rings = [r for r in rings if len(r) >= MIN_RING_POSITIONS]
        stats["rings_total"] += len(rings)
        if len(rings) > 1:
            stats["shapes_multi_ring"] += 1
        outers = [r for r in rings if _ring_is_outer(r)]
        inners = [r for r in rings if not _ring_is_outer(r)]
        stats["clockwise_rings"] += len(outers)
        stats["anticlockwise_rings"] += len(inners)
        if not outers:
            # Every ring anticlockwise. Either the shape is a hole with no
            # body — impossible — or the file does not follow the ESRI
            # orientation rule. Treat them all as outers rather than dropping
            # real ground, and COUNT it, because if this fires often the
            # orientation signal is not carrying information and any hole this
            # reader reports from it is unreliable. The report says so.
            outers, inners = rings, []
            stats["shapes_no_clockwise_ring"] += 1

        outer_polys = [Polygon(r) for r in outers]
        assigned: dict[int, list] = {i: [] for i in range(len(outers))}
        for inner in inners:
            point = Polygon(inner).representative_point()
            for i, poly in enumerate(outer_polys):
                if poly.is_valid and poly.contains(point):
                    assigned[i].append(inner)
                    break
            else:
                stats["orphan_inner_rings"] += 1
        for i, outer in enumerate(outers):
            features.append(
                feature(class_key, value, outer, assigned[i], source="way")
            )
            stats["way_features"] += 1
    return features, stats


def _exclude(features, values):
    """Drop whole classes by value, e.g. a plan-extent polygon.

    Kept as an explicit flag whose argument is echoed into the report, so a
    coverage number can never quietly depend on a filter nobody can see.
    """
    if not values:
        return features, []
    dropped = sorted({f.value for f in features if f.value in values})
    return [f for f in features if f.value not in values], dropped


def _load_features(args, bbox: BBox):
    if args.source == "osm":
        payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
        return features_from_overpass(payload)
    if args.source == "shp":
        return features_from_shapefile(
            args.input, args.class_field or "分區簡稱", args.class_key, args.encoding
        )
    geojson = json.loads(Path(args.input).read_text(encoding="utf-8"))
    features: list[Feature] = []
    stats = {"elements": 0, "way_features": 0, "relation_features": 0, "untagged": 0}
    for entry in geojson.get("features", []):
        stats["elements"] += 1
        props = entry.get("properties") or {}
        value = str(props.get(args.class_field, "?")) if args.class_field else "?"
        geom = shape(entry["geometry"])
        for poly in geom.geoms if hasattr(geom, "geoms") else [geom]:
            if poly.geom_type != "Polygon":
                continue
            features.append(
                feature(
                    args.class_key,
                    value,
                    list(poly.exterior.coords),
                    [list(r.coords) for r in poly.interiors],
                    source="file",
                )
            )
            stats["way_features"] += 1
    return features, stats


def cmd_measure(args) -> int:
    bbox = BBox.from_area_file(args.area)
    features, stats = _load_features(args, bbox)
    features, dropped = _exclude(features, set(args.exclude_class or ()))

    result = coverage(features, bbox)
    report = {
        "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "input": str(args.input),
        "bbox_area_m2": bbox.area_m2,
        "excluded_classes": dropped,
        "parse_stats": stats,
        "coverage": {
            "covered_m2": round(result.covered_m2, 1),
            "fraction": round(result.fraction, 6),
            "used_features": result.used,
            "skipped": result.skipped,
            "invalid_repaired": result.invalid,
        },
        "class_areas_m2": {
            k: round(v, 1) for k, v in class_areas(features, bbox).items()
        },
        "edge": edge_stats(features, bbox),
        "source_split": {
            k: (round(v, 1) if isinstance(v, float) else v)
            for k, v in source_split(features, bbox).items()
        },
        "edge_band": edge_band(features, bbox, args.edge_band),
        "size_distribution_m2": {
            k: (round(v, 1) if isinstance(v, float) else v)
            for k, v in size_distribution(features, bbox).items()
        },
    }
    found = holes(features, bbox, args.min_hole)
    report["holes"] = {
        "min_area_m2": args.min_hole,
        "count": len(found),
        "total_m2": round(sum(h.area_m2 for h in found), 1),
        "largest_m2": [round(h.area_m2, 1) for h in found[:10]],
    }
    if args.grid_step:
        grid = grid_coverage(features, bbox, args.grid_step)
        report["grid_control"] = {
            "step_m": grid.step_m,
            "hits": grid.hits,
            "total": grid.total,
            "fraction": round(grid.fraction, 6),
            "delta_vs_exact": round(grid.fraction - result.fraction, 6),
        }
    if args.highways:
        payload = json.loads(Path(args.highways).read_text(encoding="utf-8"))
        lines = highways_from_overpass(payload)
        from shapely.geometry import LineString

        corridor = unary_union(
            [LineString(line).buffer(args.road_halfwidth) for line in lines if len(line) >= 2]
        )
        built = build(features)
        covered = (
            unary_union(built.geoms).intersection(bbox.polygon())
            if built.geoms
            else Polygon()
        )
        gap = bbox.polygon().difference(covered)
        in_road = gap.intersection(corridor)
        report["uncovered_composition"] = {
            "road_halfwidth_m": args.road_halfwidth,
            "highway_ways": len(lines),
            "uncovered_m2": round(gap.area, 1),
            "uncovered_road_corridor_m2": round(in_road.area, 1),
            "uncovered_other_m2": round(gap.area - in_road.area, 1),
            "road_share_of_uncovered": round(in_road.area / gap.area, 4)
            if gap.area
            else None,
        }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def cmd_combine(args) -> int:
    """Measure OSM and zoning together — the hybrid question, as one number.

    Answers "does A fill B's holes?" by measuring the union of the two rather
    than adding their coverages, which would double-count every square metre
    both of them describe.
    """
    bbox = BBox.from_area_file(args.area)
    osm_payload = json.loads(Path(args.osm).read_text(encoding="utf-8"))
    osm_features, _ = features_from_overpass(osm_payload)
    zoning_features, _ = features_from_shapefile(
        args.shp, args.class_field or "分區簡稱", "zone", args.encoding
    )
    zoning_features, dropped = _exclude(zoning_features, set(args.exclude_class or ()))

    only_osm = coverage(osm_features, bbox)
    only_zoning = coverage(zoning_features, bbox)
    both = coverage(list(osm_features) + list(zoning_features), bbox)

    osm_built = build(osm_features)
    zoning_built = build(zoning_features)
    clip = bbox.polygon()
    osm_union = unary_union(osm_built.geoms).intersection(clip)
    zoning_union = unary_union(zoning_built.geoms).intersection(clip)
    osm_gap = clip.difference(osm_union)
    filled = osm_gap.intersection(zoning_union)

    report = {
        "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "bbox_area_m2": bbox.area_m2,
        "excluded_classes": dropped,
        "osm_fraction": round(only_osm.fraction, 6),
        "zoning_fraction": round(only_zoning.fraction, 6),
        "union_fraction": round(both.fraction, 6),
        "osm_gap_m2": round(osm_gap.area, 1),
        "zoning_fills_of_osm_gap_m2": round(filled.area, 1),
        "zoning_fills_share_of_osm_gap": round(filled.area / osm_gap.area, 4)
        if osm_gap.area
        else None,
        "still_uncovered_m2": round(clip.difference(unary_union([osm_union, zoning_union])).area, 1),
    }
    if args.highways:
        from shapely.geometry import LineString

        payload = json.loads(Path(args.highways).read_text(encoding="utf-8"))
        corridor = unary_union(
            [
                LineString(line).buffer(args.road_halfwidth)
                for line in highways_from_overpass(payload)
                if len(line) >= 2
            ]
        )
        rest = clip.difference(unary_union([osm_union, zoning_union]))
        report["still_uncovered_road_corridor_m2"] = round(
            rest.intersection(corridor).area, 1
        )
        report["still_uncovered_other_m2"] = round(
            rest.area - rest.intersection(corridor).area, 1
        )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def cmd_avail(args) -> int:
    report = sample_availability(
        args.url, samples=args.samples, delay_s=args.delay, timeout=args.timeout
    )
    classes: dict[str, int] = {}
    for entry in report["samples"]:
        key = entry.get("body_class") or entry.get("error_class") or "?"
        classes[key] = classes.get(key, 0) + 1
    report["class_counts"] = classes
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="ground-probe", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_osm = sub.add_parser("osm", help="fetch M1-bbox OSM areas + highways")
    p_osm.add_argument("--area", required=True)
    p_osm.add_argument("--out", required=True)
    p_osm.add_argument("--delay", type=float, default=5.0)
    p_osm.set_defaults(func=cmd_osm)

    p_m = sub.add_parser("measure", help="measure a saved fetch")
    p_m.add_argument("--area", required=True)
    p_m.add_argument("--input", required=True)
    p_m.add_argument("--source", choices=("osm", "geojson", "shp"), default="osm")
    p_m.add_argument("--encoding", default="cp950", help="dbf encoding for --source shp")
    p_m.add_argument("--class-key", default="zone")
    p_m.add_argument("--class-field", default=None)
    p_m.add_argument("--min-hole", type=float, default=100.0)
    p_m.add_argument("--grid-step", type=float, default=None)
    p_m.add_argument("--highways", default=None)
    p_m.add_argument("--road-halfwidth", type=float, default=8.0)
    p_m.add_argument("--edge-band", type=float, default=50.0)
    p_m.add_argument(
        "--exclude-class",
        action="append",
        help="drop every feature with this class value; echoed into the output",
    )
    p_m.set_defaults(func=cmd_measure)

    p_c = sub.add_parser("combine", help="measure OSM and zoning as one union")
    p_c.add_argument("--area", required=True)
    p_c.add_argument("--osm", required=True)
    p_c.add_argument("--shp", required=True)
    p_c.add_argument("--class-field", default=None)
    p_c.add_argument("--encoding", default="cp950")
    p_c.add_argument("--exclude-class", action="append")
    p_c.add_argument("--highways", default=None)
    p_c.add_argument("--road-halfwidth", type=float, default=8.0)
    p_c.set_defaults(func=cmd_combine)

    p_a = sub.add_parser("avail", help="availability sampling")
    p_a.add_argument("--url", required=True)
    p_a.add_argument("--samples", type=int, default=20)
    p_a.add_argument("--delay", type=float, default=3.0)
    p_a.add_argument("--timeout", type=float, default=20.0)
    p_a.set_defaults(func=cmd_avail)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
