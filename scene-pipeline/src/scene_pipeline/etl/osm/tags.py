"""Highway filtering and way-attribute normalisation.

The twin is a driving simulator, so the road graph is the *drivable* network:
pedestrian ways are excluded on purpose. Attributes are normalised here and
nowhere else, so that downstream stages (D10 conflation, the D3 road compiler)
see one representation instead of OSM's several.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

#: Drivable highway classes. Widening this set reshapes the whole road graph,
#: so it is asserted verbatim by the exam rather than left implicit.
HIGHWAY_CLASSES = frozenset(
    {
        "motorway",
        "trunk",
        "primary",
        "secondary",
        "tertiary",
        "unclassified",
        "residential",
        "living_street",
        "service",
        "motorway_link",
        "trunk_link",
        "primary_link",
        "secondary_link",
        "tertiary_link",
    }
)

_FALSY = frozenset({"", "no", "false", "0"})
_ONEWAY_FORWARD = frozenset({"yes", "true", "1"})
_ONEWAY_REVERSE = frozenset({"-1", "reverse"})


@dataclass(frozen=True)
class RoadAttributes:
    """The normalised attributes of one drivable way."""

    highway: str
    name: str | None = None
    #: 0 = bidirectional, 1 = one way along the (possibly reversed) node order.
    oneway: int = 0
    #: True when the source said ``oneway=-1`` and the geometry was reversed.
    reversed: bool = False
    layer: int = 0
    bridge: bool = False
    tunnel: bool = False
    #: Tag values that could not be interpreted; surfaced in the QA block
    #: rather than silently dropped.
    warnings: tuple[str, ...] = field(default_factory=tuple)


def _flag(value: str | None) -> bool:
    """OSM boolean-ish tag: anything that is not explicitly false is true.

    ``bridge=viaduct`` and ``tunnel=building_passage`` are still a bridge and a
    tunnel, so the allowlist has to be on the false side, not the true side.
    """
    if value is None:
        return False
    return value.strip().lower() not in _FALSY


def road_attributes(tags: Mapping[str, str]) -> RoadAttributes | None:
    """Normalise one way's tags, or return ``None`` if it is not a drivable road."""
    highway = tags.get("highway")
    if highway is None or highway not in HIGHWAY_CLASSES:
        return None

    warnings: list[str] = []

    raw_oneway = tags.get("oneway")
    oneway, reverse = 0, False
    if raw_oneway is not None:
        normalised = raw_oneway.strip().lower()
        if normalised in _ONEWAY_FORWARD:
            oneway = 1
        elif normalised in _ONEWAY_REVERSE:
            # Normalise away the negative direction: the caller reverses the
            # geometry so that oneway is always "along the node order".
            oneway, reverse = 1, True
        elif normalised not in _FALSY:
            warnings.append(
                f"oneway={raw_oneway!r} is not a recognised value; treated as bidirectional"
            )

    raw_layer = tags.get("layer")
    layer = 0
    if raw_layer is not None:
        try:
            layer = int(raw_layer.strip())
        except ValueError:
            warnings.append(f"layer={raw_layer!r} is not an integer; treated as 0")

    return RoadAttributes(
        highway=highway,
        name=tags.get("name"),
        oneway=oneway,
        reversed=reverse,
        layer=layer,
        bridge=_flag(tags.get("bridge")),
        tunnel=_flag(tags.get("tunnel")),
        warnings=tuple(warnings),
    )
