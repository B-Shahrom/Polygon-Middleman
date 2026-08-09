"""
characteristics.md → per-batch time/memory limits.

A `characteristics.md` accompanies a batch of problems (see the authoring template).
Its **General** table has one row per problem with `slug`, `TL` and `ML` columns:

    | idx | slug | title | languages | group | tests | subtasks | checker | TL | ML |
    | 1 | edu-dp-knapsack-school-bag | School Bag | EN | easy | 29 (2+27) | none | ncmp (native) | 1 s | 256 MB |

`derive_limits_from_characteristics(md)` reads that table and returns per-slug limits
NORMALIZED to the manifest's units — `{slug: {"timeLimit": <ms>, "memoryLimit": <mb>}}`
— so a characteristics-derived limit is directly comparable to `MANIFEST.json`'s
`time_limit_s`/`memory_limit_mb` (a second, independent authored source of the same fact).

Parsing is by column HEADER, not position: the template allows a column to be dropped
for a subset delivery, so `slug`/`TL`/`ML` are located by name. `N/A` (or a missing
column) yields `None` for that dimension rather than a wrong number. Content inside
fenced code blocks (the template's own examples) is ignored.
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional

# Header aliases → the two limit dimensions (all matched case-insensitively).
_TL_HEADERS = ("tl", "time", "time limit", "timelimit")
_ML_HEADERS = ("ml", "memory", "memory limit", "memorylimit")


def _split_row(line: str) -> List[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _is_separator(line: str) -> bool:
    s = line.strip()
    if not s.startswith("|"):
        return False
    cells = _split_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{1,}:?", c) for c in cells)


def parse_general_table(md_text: str) -> List[Dict[str, str]]:
    """Return the General table's data rows as dicts keyed by lowercased header
    (e.g. row["slug"], row["tl"]). Picks the first pipe table that has a `slug`
    column and a time-limit column; ignores tables inside ``` code fences."""
    lines = md_text.splitlines()
    in_fence = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("```"):
            in_fence = not in_fence
            i += 1
            continue
        if (not in_fence and line.lstrip().startswith("|")
                and i + 1 < len(lines) and _is_separator(lines[i + 1])):
            header = _split_row(line)
            low = [h.lower() for h in header]
            if "slug" in low and any(h in low for h in _TL_HEADERS):
                hmap = {h.lower(): idx for idx, h in enumerate(header)}
                rows: List[Dict[str, str]] = []
                j = i + 2
                while j < len(lines) and lines[j].lstrip().startswith("|"):
                    cells = _split_row(lines[j])
                    rows.append({name: (cells[idx] if idx < len(cells) else "")
                                 for name, idx in hmap.items()})
                    j += 1
                return rows
            i += 2
            continue
        i += 1
    return []


def _first(row: Dict[str, str], names) -> Optional[str]:
    for n in names:
        if row.get(n):
            return row[n]
    return None


def parse_time_ms(value: Optional[str]) -> Optional[int]:
    """'1 s' → 1000, '2000 ms' → 2000, '1.5 s' → 1500, 'N/A'/blank → None. A bare
    number is read as seconds (the template's unit for TL)."""
    if not value or "n/a" in value.lower():
        return None
    m = re.search(r"([\d]+(?:\.[\d]+)?)\s*(ms|s|sec|secs|second|seconds|min)?", value, re.I)
    if not m:
        return None
    num, unit = float(m.group(1)), (m.group(2) or "s").lower()
    if unit == "ms":
        ms = num
    elif unit == "min":
        ms = num * 60000
    else:                       # s / sec / second(s) / bare number
        ms = num * 1000
    return int(round(ms))


def parse_memory_mb(value: Optional[str]) -> Optional[int]:
    """'256 MB' → 256, '1 GB' → 1024, '64 MB' → 64, 'N/A'/blank → None. A bare
    number is read as MB (the template's unit for ML)."""
    if not value or "n/a" in value.lower():
        return None
    m = re.search(r"([\d]+(?:\.[\d]+)?)\s*(gb|gib|mb|mib|kb)?", value, re.I)
    if not m:
        return None
    num, unit = float(m.group(1)), (m.group(2) or "mb").lower()
    if unit in ("gb", "gib"):
        mb = num * 1024
    elif unit == "kb":
        mb = num / 1024
    else:                       # mb / mib / bare number
        mb = num
    return int(round(mb))


def derive_limits_from_characteristics(md_text: str) -> Dict[str, Dict[str, Optional[int]]]:
    """Per-slug limits from a characteristics.md, one entry per General-table row:
    `{slug: {"timeLimit": <ms|None>, "memoryLimit": <mb|None>}}`. Units are
    normalized (TL seconds → ms, ML → MB) to match `MANIFEST.json`. Rows without a
    slug are skipped; a missing/`N/A` TL or ML gives `None` for that dimension."""
    out: Dict[str, Dict[str, Optional[int]]] = {}
    for row in parse_general_table(md_text):
        slug = (row.get("slug") or "").strip()
        if not slug:
            continue
        out[slug] = {
            "timeLimit": parse_time_ms(_first(row, _TL_HEADERS)),
            "memoryLimit": parse_memory_mb(_first(row, _ML_HEADERS)),
        }
    return out
