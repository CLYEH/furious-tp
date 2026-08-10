"""The clip area and the cross-boundary cutting rule (EPSG:3826).

Containment follows `contracts/spec/grid.md` §邊界歸屬 — **min-inclusive,
max-exclusive** — so a point on a shared edge belongs to exactly one area.

Cutting is Liang-Barsky against the *closed* box, with the crossed axis snapped
to the exact boundary value. The snap is what makes the seam rule
(`contracts/spec/grid.md` §接縫規則 clause 1: neighbours must agree bit-for-bit
on shared boundary vertices) reachable; interpolating both axes would leave the
two sides differing in the last bits.

The full rule set is documented in this package's README.md.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from .errors import BBoxError

Point = tuple[float, float]

_E_MIN, _E_MAX, _N_MIN, _N_MAX = "e_min", "e_max", "n_min", "n_max"


@dataclass(frozen=True)
class BBox:
    """An axis-aligned clip area in EPSG:3826 metres."""

    e_min: float
    n_min: float
    e_max: float
    n_max: float

    def __post_init__(self) -> None:
        for name, value in (
            (_E_MIN, self.e_min),
            (_N_MIN, self.n_min),
            (_E_MAX, self.e_max),
            (_N_MAX, self.n_max),
        ):
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                raise BBoxError(f"bbox {name} must be a finite number, got {value!r}")
        if self.e_min >= self.e_max:
            raise BBoxError(
                f"bbox e_min must be less than e_max, got e_min={self.e_min}, e_max={self.e_max}"
            )
        if self.n_min >= self.n_max:
            raise BBoxError(
                f"bbox n_min must be less than n_max, got n_min={self.n_min}, n_max={self.n_max}"
            )

    @classmethod
    def from_area_file(cls, path: str | Path) -> BBox:
        """Load the canonical bbox from a `contracts/constants/*.json` area file.

        The bbox has exactly one home; the pipeline reads it rather than keeping
        a second copy that could drift from the finalized contract.
        """
        path = Path(path)
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise BBoxError(f"area file could not be read: {path} ({exc})") from exc
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise BBoxError(f"area file is not valid JSON: {path} ({exc})") from exc

        block = payload.get("bbox") if isinstance(payload, dict) else None
        if not isinstance(block, dict):
            raise BBoxError(f"area file {path} has no 'bbox' block")

        values: dict[str, float] = {}
        for key in (_E_MIN, _N_MIN, _E_MAX, _N_MAX):
            if key not in block:
                raise BBoxError(f"area file {path} bbox is missing '{key}'")
            try:
                values[key] = float(block[key])
            except (TypeError, ValueError) as exc:
                raise BBoxError(
                    f"area file {path} bbox '{key}' is not a number: {block[key]!r}"
                ) from exc
        return cls(**values)

    def contains(self, e: float, n: float) -> bool:
        """min-inclusive / max-exclusive containment (grid.md §邊界歸屬)."""
        return self.e_min <= e < self.e_max and self.n_min <= n < self.n_max


@dataclass(frozen=True)
class ClippedRun:
    """One contiguous piece of a polyline that survived clipping.

    ``indices`` maps each point back to its position in the input polyline;
    ``None`` marks a synthetic vertex invented on the boundary.
    """

    points: tuple[Point, ...]
    indices: tuple[int | None, ...]

    @property
    def cut_start(self) -> bool:
        return self.indices[0] is None

    @property
    def cut_end(self) -> bool:
        return self.indices[-1] is None


def _clip_segment(
    p: Point, q: Point, bbox: BBox
) -> tuple[float, Point, float, Point] | None:
    """Liang-Barsky against the closed box.

    Returns ``(t0, entry_point, t1, exit_point)`` or ``None`` when the segment
    misses the box entirely.
    """
    dx = q[0] - p[0]
    dy = q[1] - p[1]
    t0, t1 = 0.0, 1.0
    edge0: str | None = None
    edge1: str | None = None

    for delta, start, low, high, low_name, high_name in (
        (dx, p[0], bbox.e_min, bbox.e_max, _E_MIN, _E_MAX),
        (dy, p[1], bbox.n_min, bbox.n_max, _N_MIN, _N_MAX),
    ):
        for numerator, denominator, name in (
            (start - low, -delta, low_name),
            (high - start, delta, high_name),
        ):
            if denominator == 0.0:
                if numerator < 0.0:
                    return None  # parallel to this edge and outside it
                continue
            t = numerator / denominator
            if denominator < 0.0:
                if t > t1:
                    return None
                if t > t0:
                    t0, edge0 = t, name
            else:
                if t < t0:
                    return None
                if t < t1:
                    t1, edge1 = t, name

    return t0, _snap(p, dx, dy, t0, edge0, q, bbox), t1, _snap(p, dx, dy, t1, edge1, q, bbox)


def _snap(
    p: Point, dx: float, dy: float, t: float, edge: str | None, q: Point, bbox: BBox
) -> Point:
    """Interpolate at ``t``, pinning the crossed axis to the exact boundary."""
    if edge is None:
        # Untouched endpoint: hand back the original vertex bit-for-bit rather
        # than a value that merely rounds to it.
        if t == 0.0:
            return p
        if t == 1.0:
            return q
    e = p[0] + t * dx
    n = p[1] + t * dy
    if edge == _E_MIN:
        e = bbox.e_min
    elif edge == _E_MAX:
        e = bbox.e_max
    elif edge == _N_MIN:
        n = bbox.n_min
    elif edge == _N_MAX:
        n = bbox.n_max
    return (e, n)


def _finish(
    points: list[Point], indices: list[int | None], bbox: BBox
) -> ClippedRun | None:
    """Collapse duplicates and reject runs that carry no road."""
    kept_points: list[Point] = []
    kept_indices: list[int | None] = []
    for point, index in zip(points, indices):
        if kept_points and kept_points[-1] == point:
            if kept_indices[-1] is None:
                kept_indices[-1] = index
            continue
        kept_points.append(point)
        kept_indices.append(index)

    if len(kept_points) < 2:
        return None
    # A run whose every segment midpoint is outside — i.e. one lying along a max
    # edge — belongs to the neighbouring area, not to us.
    inside = any(
        bbox.contains((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
        for a, b in zip(kept_points, kept_points[1:])
    )
    if not inside:
        return None
    return ClippedRun(points=tuple(kept_points), indices=tuple(kept_indices))


def clip_polyline(points: Sequence[Point], bbox: BBox) -> list[ClippedRun]:
    """Clip a polyline to ``bbox``, splitting it wherever it leaves the area."""
    vertices = [(float(e), float(n)) for e, n in points]
    if len(vertices) < 2:
        return []

    runs: list[ClippedRun] = []
    current_points: list[Point] = []
    current_indices: list[int | None] = []
    open_at: int | None = None

    def flush() -> None:
        nonlocal current_points, current_indices, open_at
        if current_points:
            run = _finish(current_points, current_indices, bbox)
            if run is not None:
                runs.append(run)
        current_points, current_indices, open_at = [], [], None

    for i in range(len(vertices) - 1):
        p, q = vertices[i], vertices[i + 1]
        clipped = _clip_segment(p, q, bbox)
        if clipped is None:
            flush()
            continue

        t0, entry, t1, exit_point = clipped
        start_index = i if (t0 == 0.0 and bbox.contains(*p)) else None
        end_index = (i + 1) if (t1 == 1.0 and bbox.contains(*q)) else None

        if open_at is not None and start_index == open_at:
            current_points.append(exit_point)
            current_indices.append(end_index)
        else:
            flush()
            current_points = [entry, exit_point]
            current_indices = [start_index, end_index]

        open_at = end_index
        if end_index is None:
            flush()  # the polyline left the area here

    flush()
    return runs
