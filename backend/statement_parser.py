"""
Statement / test parsing — a Python port of frontend/src/utils/statementParser.ts
and testParser.ts, so the backend can parse problem archives headlessly (for the
API-driven import used by the Maestro orchestrator). Behavior mirrors the
frontend so browser and API imports produce identical Polygon problems.
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional

SECTION_KEYS = ("name", "legend", "input", "output", "scoring", "notes", "interaction")

LANG_NAME_MAP: Dict[str, str] = {
    "english": "english", "russian": "russian", "tajik": "tajik", "uzbek": "uzbek",
    "arabic": "arabic", "chinese": "chinese", "french": "french", "georgian": "georgian",
    "hungarian": "hungarian", "japanese": "japanese", "korean": "korean", "persian": "persian",
    "polish": "polish", "portuguese": "portuguese", "spanish": "spanish", "turkish": "turkish",
    "ukrainian": "ukrainian", "vietnamese": "vietnamese",
}

# Polygon's statement-language identifiers are these full lowercase names. Their
# canonical ISO 639-1 codes (uppercased) — this is the standard mapping, not an
# invented one, so a consumer using EN/RU/... can compare against parsed languages
# directly instead of only by count.
ISO_639_1: Dict[str, str] = {
    "english": "EN", "russian": "RU", "tajik": "TG", "uzbek": "UZ",
    "arabic": "AR", "chinese": "ZH", "french": "FR", "georgian": "KA",
    "hungarian": "HU", "japanese": "JA", "korean": "KO", "persian": "FA",
    "polish": "PL", "portuguese": "PT", "spanish": "ES", "turkish": "TR",
    "ukrainian": "UK", "vietnamese": "VI",
}


def iso_639_1(language: str) -> Optional[str]:
    """ISO 639-1 code for a Polygon statement language, or None if unmapped."""
    return ISO_639_1.get((language or "").lower())


def _empty_sections() -> Dict[str, str]:
    return {k: "" for k in SECTION_KEYS}


def parse_latex_statement(raw: str) -> Dict[str, str]:
    sections = _empty_sections()
    text = raw.replace("\r\n", "\n")

    markers = [
        ("input", r"\\textbf\{Input(?:\s+format)?\}|\\section\*?\{Input(?:\s+format)?\}|\\InputFile"),
        ("output", r"\\textbf\{Output(?:\s+format)?\}|\\section\*?\{Output(?:\s+format)?\}|\\OutputFile"),
        ("scoring", r"\\textbf\{Scoring\}|\\textbf\{Subtasks\}|\\section\*?\{Scoring\}|\\section\*?\{Subtasks\}|\\Scoring"),
        ("notes", r"\\textbf\{Notes?\}|\\section\*?\{Notes?\}|\\Note"),
        ("interaction", r"\\textbf\{Interaction\}|\\section\*?\{Interaction\}"),
    ]
    name_re = re.compile(r"\\textbf\{Problem Name\}|\\section\*?\{Problem Name\}", re.I)
    legend_re = re.compile(r"\\textbf\{(?:Legend|Description)\}|\\section\*?\{(?:Legend|Description)\}", re.I)

    splits: List[dict] = []
    name_match = name_re.search(text)
    if name_match:
        splits.append({"pos": name_match.start(), "end": name_match.end(), "key": "name"})
    legend_match = legend_re.search(text)
    if legend_match:
        splits.append({"pos": legend_match.start(), "end": legend_match.end(), "key": "legend"})
    for key, pat in markers:
        m = re.search(pat, text, re.I)
        if m:
            splits.append({"pos": m.start(), "end": m.end(), "key": key})

    splits.sort(key=lambda s: s["pos"])

    if not splits:
        sections["legend"] = text.strip()
        return sections

    before_first = text[: splits[0]["pos"]].strip()
    if before_first and splits[0]["key"] != "name":
        sections["legend"] = before_first

    for i, sp in enumerate(splits):
        end_pos = splits[i + 1]["pos"] if i + 1 < len(splits) else len(text)
        sections[sp["key"]] = text[sp["end"]:end_pos].strip()

    if not sections["legend"] and not legend_match:
        first_non_name = next((s for s in splits if s["key"] != "name"), None)
        if first_non_name:
            name_split = next((s for s in splits if s["key"] == "name"), None)
            start = name_split["end"] if name_split else 0
            chunk = text[start:first_non_name["pos"]].strip()
            if chunk:
                sections["legend"] = chunk

    return sections


def convert_inline(text: str) -> str:
    text = re.sub(r"\*\*(.+?)\*\*", r"\\textbf{\1}", text)
    text = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"\\textit{\1}", text)
    text = re.sub(r"`([^`]+)`", r"\\texttt{\1}", text)
    return text


def convert_mdx_to_latex(mdx: str) -> str:
    lines = mdx.replace("\r\n", "\n").split("\n")
    out: List[str] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        m = re.match(r"^## (.+)", line)
        if m:
            out.append(f"\\subsection*{{{m.group(1).strip()}}}")
            i += 1
            continue
        m = re.match(r"^# (.+)", line)
        if m:
            out.append(f"\\section*{{{m.group(1).strip()}}}")
            i += 1
            continue
        if re.match(r"^- (.+)", line):
            out.append("\\begin{itemize}")
            while i < n and re.match(r"^- (.+)", lines[i]):
                mm = re.match(r"^- (.+)", lines[i])
                out.append(f"\\item {convert_inline(mm.group(1))}")
                i += 1
            out.append("\\end{itemize}")
            continue
        if re.match(r"^\d+\.\s+(.+)", line):
            out.append("\\begin{enumerate}")
            while i < n and re.match(r"^\d+\.\s+(.+)", lines[i]):
                mm = re.match(r"^\d+\.\s+(.+)", lines[i])
                out.append(f"\\item {convert_inline(mm.group(1))}")
                i += 1
            out.append("\\end{enumerate}")
            continue
        if line.strip() == "":
            out.append("")
            i += 1
            continue
        out.append(convert_inline(line))
        i += 1
    return "\n".join(out)


def split_multi_language_raw(raw: str) -> Dict[str, str]:
    text = raw.replace("\r\n", "\n")
    result: Dict[str, str] = {}
    lang_names = "|".join(LANG_NAME_MAP.keys())
    pattern = re.compile(r"\\textbf\s*\{\s*(" + lang_names + r")\s*\}", re.I)

    positions = []
    for m in pattern.finditer(text):
        code = LANG_NAME_MAP.get(m.group(1).lower())
        if code:
            positions.append({"code": code, "pos": m.start(), "end": m.end()})

    if not positions:
        return result

    for i, p in enumerate(positions):
        start = p["end"]
        end = positions[i + 1]["pos"] if i + 1 < len(positions) else len(text)
        result[p["code"]] = text[start:end].strip()
    return result


def split_multi_language(raw: str) -> Dict[str, Dict[str, str]]:
    return {code: parse_latex_statement(content) for code, content in split_multi_language_raw(raw).items()}


def derive_dependencies_from_scoring(scoring: str) -> Dict[str, List[str]]:
    dep_map: Dict[str, List[str]] = {}
    lines = scoring.split("\n")
    found_tabular = False
    for line in lines:
        cells = [re.sub(r"\\\\", "", c).strip() for c in line.split("&")]
        if len(cells) >= 3:
            gm = re.search(r"(\d+)", cells[0])
            if not gm:
                continue
            group_num = gm.group(1)
            last_cell = cells[-1]
            if re.search(r"subtask|group|dependencies|required", cells[0], re.I) and re.search(r"constraint|points|dep", cells[1], re.I):
                continue
            if re.match(r"^[-—\s]*$", last_cell) or last_cell == "":
                continue
            dep_nums = re.findall(r"\d+", last_cell)
            if dep_nums:
                dep_map[group_num] = [n.strip() for n in dep_nums]
                found_tabular = True

    if not found_tabular:
        for line in lines:
            sm = re.search(r"(?:subtask|group)\s+(\d+)", line, re.I)
            if not sm:
                continue
            group_num = sm.group(1)
            dm = re.search(r"depends?\s+on\s+(?:subtasks?\s+)?(.+?)(?:\.|$)", line, re.I)
            if dm:
                dep_nums = re.findall(r"\d+", dm.group(1))
                if dep_nums:
                    dep_map[group_num] = dep_nums
    return dep_map


def derive_points_from_scoring(scoring: str) -> Dict[str, int]:
    points_map: Dict[str, int] = {}
    lines = scoring.split("\n")
    found_tabular = False
    for line in lines:
        cells = [re.sub(r"\\\\", "", c).strip() for c in line.split("&")]
        if len(cells) >= 3:
            gm = re.search(r"(\d+)", cells[0])
            if not gm:
                continue
            group_num = gm.group(1)
            if re.search(r"subtask|group|dependencies|required", cells[0], re.I) and re.search(r"constraint|points|dep", cells[1], re.I):
                continue
            points_val: Optional[int] = None
            for ci in range(1, len(cells)):
                cell = re.sub(r"[$ \\]", "", cells[ci]).strip()
                if re.match(r"^\d+$", cell) and not re.search(r"[<>=]", cells[ci]):
                    points_val = int(cell)
                    break
            if points_val is not None:
                points_map[group_num] = points_val
                found_tabular = True

    if not found_tabular:
        for line in lines:
            m = re.search(r"(?:subtask|group)\s+(\d+)\s*.*?(\d+)\s*(?:points?|баллов|очков)", line, re.I)
            if m:
                points_map[m.group(1)] = int(m.group(2))
    return points_map


# ── testParser.ts ───────────────────────────────────────────────────────────

def extract_group_from_filename(filename: str) -> Optional[str]:
    m = re.search(r"_s(\d+)[_\-.]", filename, re.I)
    return m.group(1) if m else None


def extract_index_from_filename(filename: str) -> Optional[int]:
    m = re.search(r"[_\-]?(\d+)[_\-.]", filename) or re.match(r"^(\d+)", filename)
    return int(m.group(1)) if m else None
