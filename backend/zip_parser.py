"""
ZIP parsing + multi-archive merge — a Python port of
frontend/src/wizard/zipImport/parseZip.ts and merge.ts, so the backend can parse
problem archives for the headless (API-driven) import. Behavior mirrors the
frontend importer, including the strict component lookup, test grouping,
tests-only detection and the multi-archive merge.
"""
from __future__ import annotations

import io
import re
import zipfile
from typing import Dict, List, Optional

from statement_parser import (
    convert_mdx_to_latex, split_multi_language, split_multi_language_raw,
    parse_latex_statement, extract_group_from_filename,
    derive_dependencies_from_scoring, derive_points_from_scoring,
)

SOLUTION_TAG_PREFIXES = [
    (r"^(wa|wrong)", "WA"),
    (r"^(tle|tl|slow)", "TL"),
    (r"^(mle|ml)", "ML"),
    (r"^(rte|re|runtime)", "RE"),
    (r"^(pe|presentation)", "PE"),
    (r"^(to)", "TO"),
    (r"^(tm)", "TM"),
    (r"^(ok|ac|correct|accepted|brute|bf)", "OK"),
]


def _base_name(p: str) -> str:
    return (p.split("/")[-1] or "").lower()


def _detect_solution_tag(base: str) -> Optional[str]:
    name = re.sub(r"\.(cpp|cc|cxx)$", "", base, flags=re.I)
    for pat, tag in SOLUTION_TAG_PREFIXES:
        if re.match(pat, name):
            return tag
    return None


def _root_from_path(p: str) -> str:
    segs = p.split("/")
    edu_idx = next((i for i, s in enumerate(segs) if re.match(r"^edu[-_]", s, re.I)), -1)
    if edu_idx >= 0:
        return "/".join(segs[: edu_idx + 1]) + "/"
    return segs[0] + "/" if len(segs) > 1 else ""


def base_problem_slug(slug: str) -> str:
    """Strip a trailing -tests / -test (optionally numbered) so a tests-only pack
    named <slug>-tests targets the base problem <slug>."""
    return re.sub(r"[-_]tests?(?:[-_]?\d+)?$", "", slug, flags=re.I) or slug


def global_index_from_filename(filename: str) -> int:
    m = re.search(r"idx(\d+)", filename, re.I) or re.search(r"(\d+)", filename)
    return int(m.group(1)) if m else 2 ** 53


def parse_zip(zip_bytes: bytes) -> Dict:
    zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    infos = [info for info in zf.infolist() if not info.is_dir()]
    file_paths = [info.filename for info in infos]

    def read(path: str) -> str:
        return zf.read(path).decode("utf-8", errors="replace")

    def find_by_name(*names: str) -> Optional[str]:
        wanted = [n.lower() for n in names]
        matches = [p for p in file_paths if _base_name(p) in wanted]
        matches.sort(key=lambda p: len(p.split("/")))
        return matches[0] if matches else None

    stmt_path = find_by_name("problem_statement.mdx", "problem_statement.tex")
    tutorial_path = find_by_name("tutorial.mdx", "tutorial.tex")
    checker_path = find_by_name("checker.cpp")
    solution_path = find_by_name("solution.cpp")
    validator_path = find_by_name("validator.cpp")

    ref_path = stmt_path or checker_path or solution_path or (file_paths[0] if file_paths else "")
    root_prefix = _root_from_path(ref_path)

    folder_name = root_prefix.rstrip("/") or "imported-problem"
    problem_name = folder_name
    display_name = re.sub(
        r"\b\w", lambda m: m.group().upper(),
        re.sub(r"[-_]", " ", re.sub(r"^edu[-_]", "", folder_name)),
    )

    # Statement
    languages: Dict[str, Dict[str, str]] = {}
    if stmt_path:
        raw = read(stmt_path)
        latex = raw if stmt_path.lower().endswith(".tex") else convert_mdx_to_latex(raw)
        languages = split_multi_language(latex)
        if not languages:
            languages = {"english": parse_latex_statement(latex)}

    # Tutorial (raw per-language)
    tutorials: Dict[str, str] = {}
    if tutorial_path:
        raw = read(tutorial_path)
        latex = raw if tutorial_path.lower().endswith(".tex") else convert_mdx_to_latex(raw)
        tutorials = split_multi_language_raw(latex)
        if not tutorials and latex.strip():
            tutorials = {"english": latex.strip()}

    checker_code = read(checker_path) if checker_path else None
    validator_code = read(validator_path) if validator_path else None
    solution_code = read(solution_path) if solution_path else None

    # Extra solutions — tagged *.cpp under the slug root, deduped by basename.
    core_cpp = {"checker.cpp", "solution.cpp", "validator.cpp"}
    extra_solutions: List[Dict] = []
    seen_names = set()
    for p in file_paths:
        if root_prefix and not p.startswith(root_prefix):
            continue
        b = _base_name(p)
        if not b.endswith(".cpp") or b in core_cpp or b in seen_names:
            continue
        tag = _detect_solution_tag(b)
        if not tag:
            continue
        seen_names.add(b)
        extra_solutions.append({"filename": b, "code": read(p), "tag": tag})

    # Tests — input*.txt inside testset/ (tesset/ typo accepted) under the root.
    def is_test(p: str) -> bool:
        if root_prefix and not p.startswith(root_prefix):
            return False
        segs = p.lower().split("/")
        in_testset = "testset" in segs or "tesset" in segs
        return in_testset and re.match(r"^input.*\.txt$", _base_name(p)) is not None

    raw_tests = []
    for p in [p for p in file_paths if is_test(p)]:
        filename = p.split("/")[-1] or p
        content = read(p)
        group = extract_group_from_filename(filename) or "0"
        m = re.search(r"idx(\d+)", filename, re.I) or re.search(r"(\d+)", filename)
        sort_key = int(m.group(1)) if m else len(raw_tests)
        raw_tests.append({"input": content, "group": group, "sortKey": sort_key, "filename": filename})

    raw_tests.sort(key=lambda t: (int(t["group"]), t["sortKey"]))
    tests = [
        {"index": i + 1, "input": t["input"], "group": t["group"], "filename": t["filename"]}
        for i, t in enumerate(raw_tests)
    ]

    scoring_text = (
        (languages.get("english", {}).get("scoring") or "").strip()
        or next((s["scoring"].strip() for s in languages.values() if s.get("scoring", "").strip()), "")
    )
    has_scoring = len(scoring_text) > 0

    # Pre-flight warnings (advisory)
    warnings: List[str] = []
    if not languages:
        warnings.append("No statement languages parsed")
    if not checker_code:
        warnings.append("No checker.cpp found")
    if not solution_code:
        warnings.append("No solution.cpp (main) found")
    if not tests:
        warnings.append("No tests found in testset/")

    group_nums = sorted({int(t["group"]) for t in tests})
    if group_nums:
        missing = [g for g in range(group_nums[-1] + 1) if g not in group_nums]
        if missing:
            warnings.append(f"Non-contiguous groups — missing {', '.join(map(str, missing))}")

    tests_only = (
        len(languages) == 0 and not checker_code and not solution_code
        and not validator_code and len(extra_solutions) == 0 and len(tests) > 0
    )
    if tests_only:
        warnings.append(
            f'Tests-only archive ({len(tests)} tests) — appends to problem "{base_problem_slug(problem_name)}"'
        )

    return {
        "problemName": problem_name,
        "displayName": display_name,
        "languages": languages,
        "tutorials": tutorials,
        "checkerCode": checker_code,
        "validatorCode": validator_code,
        "solutionCode": solution_code,
        "extraSolutions": extra_solutions,
        "tests": tests,
        "hasScoring": has_scoring,
        "scoringText": scoring_text,
        "warnings": warnings,
        "testsOnly": tests_only,
    }


def merge_parsed_group(parsed_list: List[Dict]) -> Dict:
    """Merge several archives of the same problem (main + test packs) into one."""
    if len(parsed_list) == 1:
        return parsed_list[0]

    main = next(
        (p for p in parsed_list if p["languages"] or p["checkerCode"] or p["solutionCode"] or p["validatorCode"]),
        parsed_list[0],
    )

    pooled = [t for p in parsed_list for t in p["tests"]]
    pooled.sort(key=lambda t: (int(t["group"]), global_index_from_filename(t["filename"])))
    tests = [
        {"index": i + 1, "input": t["input"], "group": t["group"], "filename": t["filename"]}
        for i, t in enumerate(pooled)
    ]

    tests_only = (
        len(main["languages"]) == 0 and not main["checkerCode"] and not main["solutionCode"]
        and not main["validatorCode"] and len(main["extraSolutions"]) == 0
    )

    warnings = [f"Merged {len(parsed_list)} archives → {len(tests)} tests total"]
    for p in parsed_list:
        warnings.extend(p["warnings"])

    return {
        "problemName": main["problemName"],
        "displayName": main["displayName"],
        "languages": main["languages"],
        "tutorials": main["tutorials"],
        "checkerCode": main["checkerCode"],
        "validatorCode": main["validatorCode"],
        "solutionCode": main["solutionCode"],
        "extraSolutions": main["extraSolutions"],
        "tests": tests,
        "hasScoring": main["hasScoring"],
        "scoringText": main["scoringText"],
        "warnings": warnings,
        "testsOnly": tests_only,
    }
