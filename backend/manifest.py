"""
Optional set-manifest support for the headless import surface.

A `MANIFEST.json` (the authoring set descriptor — see Maestro's MANIFEST_SPEC) may
be uploaded alongside the problem archive(s). It is EXTERNAL to the archives (it
records each archive's own sha256/bytes, so it can't live inside them), and it is
always optional: absent, the import behaves exactly as before.

When present it does two things (both approved in docs/maestro/FROM_MAESTRO.md):
  1. Integrity — verify each uploaded archive's sha256/size against the manifest,
     a second gate independent of Maestro's own gate-time hash.
  2. Limits — supply per-slug time/memory limits so the authored value is applied
     when the caller doesn't send an explicit form field (form field still wins).
     The response reports `limitsSource` (form | manifest | default) so a
     manifest fallback can never be mistaken for an explicit value.

We pin to `schema_version` (the shape of the file), NOT `contract_version`.
"""
from __future__ import annotations

import hashlib
import json
from typing import Dict, Optional

SUPPORTED_SCHEMA = "1.0"


class ManifestError(ValueError):
    pass


def looks_like_manifest(filename: Optional[str], content: bytes) -> bool:
    """A file is the manifest if it's named MANIFEST.json, or (fallback) it is JSON
    carrying `schema_version` + `problems`. Archives are ZIPs (start with 'PK')."""
    base = (filename or "").rsplit("/", 1)[-1].rsplit("\\", 1)[-1].lower()
    if base == "manifest.json":
        return True
    if content[:2] == b"PK":            # a ZIP — definitely not the manifest
        return False
    try:
        data = json.loads(content.decode("utf-8", errors="strict"))
    except Exception:
        return False
    return isinstance(data, dict) and "schema_version" in data and "problems" in data


def parse_manifest(content: bytes) -> Dict:
    """Parse a MANIFEST.json into the shape the endpoints need. Raises
    ManifestError on unreadable JSON or an unsupported schema version."""
    try:
        data = json.loads(content.decode("utf-8", errors="replace"))
    except Exception as e:
        raise ManifestError(f"not valid JSON: {e}")
    if not isinstance(data, dict):
        raise ManifestError("top level is not an object")
    version = str(data.get("schema_version", ""))
    if version != SUPPORTED_SCHEMA:
        raise ManifestError(f"unsupported schema_version {version!r} (expected {SUPPORTED_SCHEMA})")

    def _ms(seconds) -> Optional[int]:
        return int(round(seconds * 1000)) if isinstance(seconds, (int, float)) else None

    def _norm_checker(chk) -> Optional[dict]:
        # Manifest checker: {kind: native|custom, name, polygon_id}. Normalize to the
        # same shape characteristics.py uses: native → standard (+ polygonId).
        if not isinstance(chk, dict):
            return None
        kind = (chk.get("kind") or "").lower()
        if kind in ("native", "standard"):
            pid = chk.get("polygon_id") or (f"std::{chk.get('name')}.cpp" if chk.get("name") else None)
            return {"kind": "standard", "name": chk.get("name"), "polygonId": pid}
        if kind == "custom":
            return {"kind": "custom", "name": None, "polygonId": None}
        return None

    problems: Dict[str, dict] = {}
    by_filename: Dict[str, dict] = {}
    for p in data.get("problems", []) or []:
        slug = p.get("slug")
        if not slug:
            continue
        lim = p.get("limits") or {}
        entry = {
            "slug": slug,
            "timeLimit": _ms(lim.get("time_limit_s")),          # ms, to match the API
            "memoryLimit": lim.get("memory_limit_mb"),           # MB
            "measuredWorstMs": _ms(lim.get("measured_worst_s")),
            "checker": _norm_checker(p.get("checker")),          # {kind,name,polygonId}|None
        }
        problems[slug] = entry
        # archive + optional tests pack → filename -> integrity record
        for role, spec in (("archive", p.get("archive")), ("tests", p.get("tests_archive"))):
            if isinstance(spec, dict) and spec.get("filename"):
                by_filename[spec["filename"]] = {
                    "slug": slug, "role": role,
                    "sha256": spec.get("sha256"), "bytes": spec.get("bytes"),
                }
    return {"schemaVersion": version, "problems": problems, "byFilename": by_filename}


def verify_archive(manifest: Dict, filename: Optional[str], content: bytes) -> Optional[str]:
    """If the manifest describes `filename`, verify its sha256 and byte size. Return
    an error string on mismatch, or None if it matches / the manifest doesn't
    describe this file (nothing to verify)."""
    entry = manifest["byFilename"].get((filename or "").rsplit("/", 1)[-1].rsplit("\\", 1)[-1])
    if not entry:
        return None
    want_sha = entry.get("sha256")
    if want_sha:
        got = hashlib.sha256(content).hexdigest()
        if got.lower() != str(want_sha).lower():
            return f"sha256 mismatch (manifest {str(want_sha)[:12]}…, got {got[:12]}…)"
    want_bytes = entry.get("bytes")
    if isinstance(want_bytes, int) and len(content) != want_bytes:
        return f"size mismatch (manifest {want_bytes} bytes, got {len(content)})"
    return None


def archive_verified(manifest: Optional[Dict], filename: Optional[str], content: bytes) -> Optional[bool]:
    """True/False if the manifest describes this file (matched or not), None if it
    doesn't describe it (or there's no manifest)."""
    if not manifest:
        return None
    base = (filename or "").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if base not in manifest["byFilename"]:
        return None
    return verify_archive(manifest, filename, content) is None


def limits_for(manifest: Optional[Dict], slug: str) -> Optional[dict]:
    """The manifest's per-slug entry ({timeLimit, memoryLimit, measuredWorstMs, checker}),
    or None if there's no manifest or it doesn't describe this slug."""
    if not manifest:
        return None
    return manifest["problems"].get(slug)


def checker_for(manifest: Optional[Dict], slug: str) -> Optional[dict]:
    """The manifest's per-slug checker directive ({kind,name,polygonId}) or None."""
    entry = limits_for(manifest, slug)
    return entry.get("checker") if entry else None


def resolve_limit(form_val: Optional[int], manifest_val: Optional[int], default_val: int):
    """Precedence: explicit form field > manifest > server default. Returns
    (value, source) where source ∈ {form, manifest, default}."""
    if form_val is not None:
        return form_val, "form"
    if manifest_val is not None:
        return manifest_val, "manifest"
    return default_val, "default"


def resolve_limit_chain(candidates, default_val):
    """Generalized precedence: `candidates` is an ordered list of (value, source);
    the first non-None value wins, else `default_val` with source 'default'. Used to
    resolve form > manifest > characteristics > default."""
    for value, source in candidates:
        if value is not None:
            return value, source
    return default_val, "default"
