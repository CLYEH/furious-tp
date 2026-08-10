"""Output grid geometry and the pixel-alignment rule.

The rule, in full:

* The grid is anchored at the **EPSG:3826 origin**, so every pixel *edge* sits
  on a multiple of the resolution. Nothing about the requested bbox moves the
  phase of the grid.
* The bbox is snapped **outward** — `floor` on the min side, `ceil` on the max
  side — so the output always covers the requested area. Rounding to the
  nearest edge would be smaller on average and would quietly shave a strip off
  the edge of the area the rest of M1 assumes it has.
* The snap is minimal: never more than one pixel is added on any side.

Anchoring at the origin is what ties this raster to the tile grid.
`contracts/spec/grid.md` picks `tile_size_m = 500` partly because it is 25
cells of the 20 m DTM, so terrain vertices can land on tile boundaries; that
only holds if both grids are phased to the same origin, which is why
`check_tile_alignment` is a hard check rather than a comment.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from affine import Affine

from .area import Bbox
from .errors import DtmGridError

#: Native resolution of the MOI 20 m DTM, and the default output resolution.
DEFAULT_RESOLUTION_M = 20.0

#: Refuse to allocate more than this many output pixels (~400 MB as float32).
#: A bbox in degrees instead of metres, or a whole-Taiwan bbox, is a typo that
#: should fail in a sentence rather than after eating all the memory.
MAX_OUTPUT_PIXELS = 100_000_000


@dataclass(frozen=True)
class AlignedGrid:
    """A north-up output grid, snapped outward onto the resolution lattice."""

    e_min: float
    n_min: float
    e_max: float
    n_max: float
    resolution_m: float
    width: int
    height: int

    @property
    def transform(self) -> Affine:
        return Affine(self.resolution_m, 0.0, self.e_min, 0.0, -self.resolution_m, self.n_max)

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return (self.e_min, self.n_min, self.e_max, self.n_max)


def align_bbox(bbox: Bbox, resolution_m: float) -> AlignedGrid:
    """Snap `bbox` outward onto the origin-anchored `resolution_m` lattice."""
    if not math.isfinite(resolution_m) or resolution_m <= 0:
        raise DtmGridError(f"resolution must be a positive number of metres, got {resolution_m!r}")

    for name, low, high in (("east", bbox.e_min, bbox.e_max), ("north", bbox.n_min, bbox.n_max)):
        if not (math.isfinite(low) and math.isfinite(high)):
            raise DtmGridError(f"bbox {name} bounds must be finite, got {low!r}..{high!r}")
        if high <= low:
            raise DtmGridError(
                f"bbox is degenerate on the {name} axis: {name}_min {low} must be "
                f"strictly less than {name}_max {high}"
            )

    # Integer lattice indices: exact, and the only place floor/ceil appear.
    col_min = math.floor(bbox.e_min / resolution_m)
    col_max = math.ceil(bbox.e_max / resolution_m)
    row_min = math.floor(bbox.n_min / resolution_m)
    row_max = math.ceil(bbox.n_max / resolution_m)

    width = col_max - col_min
    height = row_max - row_min
    if width * height > MAX_OUTPUT_PIXELS:
        raise DtmGridError(
            f"requested grid is too large: {width} x {height} = {width * height} pixels "
            f"exceeds the {MAX_OUTPUT_PIXELS} pixel budget; check that the bbox is in "
            "metres (EPSG:3826) and that the resolution is right"
        )

    return AlignedGrid(
        e_min=col_min * resolution_m,
        n_min=row_min * resolution_m,
        e_max=col_max * resolution_m,
        n_max=row_max * resolution_m,
        resolution_m=float(resolution_m),
        width=width,
        height=height,
    )


def check_tile_alignment(resolution_m: float, tile_size_m: float) -> None:
    """Refuse a resolution that would put tile boundaries mid-pixel."""
    if not math.isfinite(resolution_m) or resolution_m <= 0:
        raise DtmGridError(f"resolution must be a positive number of metres, got {resolution_m!r}")

    cells = tile_size_m / resolution_m
    if abs(cells - round(cells)) > 1e-9 * max(1.0, abs(cells)):
        raise DtmGridError(
            f"resolution {resolution_m} m does not divide the {tile_size_m} m tile "
            f"({cells} cells per side); contracts/spec/grid.md requires tile boundaries "
            "to fall on pixel edges so terrain vertices can be shared across tiles"
        )
