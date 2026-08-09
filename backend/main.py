import json
import os
import time as _time
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, HTMLResponse, PlainTextResponse

from polygon_api import call_polygon
import activity_log as alog

app = FastAPI(title="Polygon Middleman", version="1.0.0")
alog.install_logging()
alog.record("server", "server", "Backend started")


@app.on_event("startup")
async def _restore_jobs():
    """Reload persisted import jobs so verify-status / download-package survive a
    restart (jobs mid-flight when we died are marked INTERRUPTED → resubmit)."""
    try:
        import import_jobs
        n = import_jobs.load_persisted()
        if n:
            alog.record("server", "server", f"Restored {n} import job(s) from disk")
    except Exception as e:
        alog.record("error", "server", f"Job restore failed: {e}")


# ── Pretty Logging ────────────────────────────────────────────────────────────

def _log_request(method: str, params: dict, files: dict | None = None):
    """Log an outgoing Polygon API call in a readable format."""
    ts = _time.strftime("%H:%M:%S")
    file_info = ""
    if files:
        file_names = [f"{k} ({fn})" for k, (fn, _, _) in files.items()]
        file_info = f"  files: {', '.join(file_names)}"
    # Filter out noisy/internal params (also drops the signing key/secret).
    display = {k: v for k, v in params.items() if k not in ("apiKey", "apiSig", "time")}
    param_str = ", ".join(f"{k}={v}" for k, v in display.items()) if display else "(none)"
    print(f"\n>> [{ts}] {method}")
    print(f"   params: {param_str}{file_info}")
    alog.record("api", method, f"call · {param_str}{file_info}")


def _log_response(method: str, body: bytes, content_type: str):
    """Log a Polygon API response in a readable format."""
    ts = _time.strftime("%H:%M:%S")
    try:
        data = json.loads(body)
        status = data.get("status", "?")
        if status == "OK":
            result = data.get("result")
            if isinstance(result, list):
                summary = f"OK ({len(result)} items)"
            elif isinstance(result, dict):
                summary = "OK (object)"
            elif result is not None:
                summary = f"OK: {str(result)[:120]}"
            else:
                summary = "OK"
            print(f"OK [{ts}] {method} -> {summary}")
            alog.record("ok", method, summary)
        else:
            comment = data.get("comment", "Unknown error")
            print(f"ERR [{ts}] {method} -> FAILED: {comment}")
            alog.record("error", method, f"FAILED: {comment}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        # Binary response (e.g. file download, package)
        size = len(body)
        human = f"{size / 1024:.1f} KB" if size > 1024 else f"{size} bytes"
        print(f"BIN [{ts}] {method} -> {human} ({content_type})")
        alog.record("api", method, f"{human} ({content_type})")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Paths that would spam the log (the log page and its own polling) — never record.
_LOG_QUIET = ("/", "/health", "/favicon.ico")


@app.middleware("http")
async def _activity_middleware(request: Request, call_next):
    """Record every incoming request's method/path/status/duration. Bodies are
    never touched, so credentials in POST payloads are never logged."""
    path = request.url.path
    start = _time.perf_counter()
    try:
        response = await call_next(request)
    except Exception as e:
        import traceback as _tb
        alog.record("error", "http", f"{request.method} {path} → unhandled {type(e).__name__}: {e}\n{_tb.format_exc()}")
        raise
    if path not in _LOG_QUIET and not path.startswith("/api/logs"):
        dur = (_time.perf_counter() - start) * 1000
        code = response.status_code
        level = "error" if code >= 500 else "warn" if code >= 400 else "req"
        alog.record(level, "http", f"{request.method} {path} → {code} ({dur:.0f}ms)")
    return response


def _server_status() -> dict:
    st = alog.stats()
    return {
        "version": app.version,
        "uptime_s": st["uptime_s"],
        "log_count": st["count"],
        "error_count": st["errors"],
        "credentials_set": bool(_config.get("api_key") and _config.get("api_secret")),
        "cf_login_set": bool(_config.get("cf_login") and _config.get("cf_password")),
    }


@app.get("/", response_class=HTMLResponse)
def activity_page():
    """The live, human-readable backend log (watch it; copy it into a bug report)."""
    return HTMLResponse(alog.PAGE_HTML)


@app.get("/api/logs")
def api_logs(since: int = 0):
    return {"entries": alog.snapshot(since), "server": _server_status()}


@app.get("/api/logs.txt", response_class=PlainTextResponse)
def api_logs_text(download: int = 0):
    s = _server_status()
    header = alog.report_header({
        "backend version": s["version"],
        "API credentials": "set" if s["credentials_set"] else "NOT set",
        "CF web login": "set" if s["cf_login_set"] else "NOT set",
    })
    body = header + "\n" + alog.as_text()
    headers = {"Content-Disposition": "attachment; filename=polygon-middleman-log.txt"} if download else None
    return PlainTextResponse(body, headers=headers)


@app.post("/api/logs/clear")
def api_logs_clear():
    alog.clear()
    alog.record("server", "server", "Log cleared")
    return {"status": "ok"}

CONFIG_FILE = os.path.join(os.path.dirname(__file__), "config.json")


def load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            return json.load(f)
    return {"api_key": "", "api_secret": ""}


def save_config(cfg: dict):
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f)


_config = load_config()


def get_creds() -> tuple[str, str]:
    if not _config.get("api_key") or not _config.get("api_secret"):
        raise HTTPException(status_code=401, detail="API credentials not configured. Go to Settings.")
    return _config["api_key"], _config["api_secret"]


async def proxy(method: str, params: dict, files: dict | None = None) -> Response:
    api_key, api_secret = get_creds()
    _log_request(method, params, files)
    body, content_type = await call_polygon(method, api_key, api_secret, params, files)
    _log_response(method, body, content_type)
    return Response(content=body, media_type=content_type)


# ── Credentials ──────────────────────────────────────────────────────────────

@app.get("/credentials")
def get_credentials():
    # Secrets (api_secret, cf_password) are write-only — never returned.
    return {
        "api_key": _config.get("api_key", ""),
        "has_secret": bool(_config.get("api_secret", "")),
        "username": _config.get("username", ""),
        "cf_login": _config.get("cf_login", ""),
        "has_cf_password": bool(_config.get("cf_password", "")),
    }


@app.post("/credentials")
async def set_credentials(request: Request):
    global _config
    data = await request.json()
    # Merge-only: a partial save (e.g. just the CF login) must not wipe the API
    # key. Each field is written only when its key is present in the payload.
    if "api_key" in data:
        _config["api_key"] = data.get("api_key", "")
    if "api_secret" in data:
        _config["api_secret"] = data.get("api_secret", "")
    if "username" in data:
        _config["username"] = data["username"]
    if "cf_login" in data:
        _config["cf_login"] = data.get("cf_login", "")
    # Password is only overwritten when a non-empty value is sent.
    if data.get("cf_password"):
        _config["cf_password"] = data["cf_password"]
    save_config(_config)
    return {"status": "ok"}


@app.get("/health")
def health():
    return {"status": "ok"}


# ── Default Problem Settings ─────────────────────────────────────────────────

DEFAULT_SETTINGS = {
    "enable_groups": True,
    "enable_points": True,
    # Defaults used by the ZIP importer (overridable per-batch in the UI).
    "checker_source_type": "cpp.gcc14-64-msys2-g++23",
    "solution_source_type": "cpp.g++17",
    "default_time_limit": 1000,
    "default_memory_limit": 256,
}


@app.get("/settings")
def get_settings():
    settings = dict(DEFAULT_SETTINGS)
    stored = _config.get("default_settings", {})
    settings.update(stored)
    return settings


@app.post("/settings")
async def update_settings(request: Request):
    global _config
    data = await request.json()
    if "default_settings" not in _config:
        _config["default_settings"] = dict(DEFAULT_SETTINGS)
    _config["default_settings"].update(data)
    save_config(_config)
    return {"status": "ok"}


# ── Debug ─────────────────────────────────────────────────────────────────────

@app.get("/api/debug/problems")
async def debug_problems():
    """Visit http://localhost:8000/api/debug/problems in your browser to see raw Polygon response."""
    api_key, api_secret = get_creds()
    body, content_type = await call_polygon("problems.list", api_key, api_secret, {})
    raw = body.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(raw)
        return {"content_type": content_type, "parsed": parsed, "first_500_chars": raw[:500]}
    except Exception:
        return {"content_type": content_type, "raw_text": raw[:2000]}


# ── problems.list / problem.create ──────────────────────────────────────────

@app.get("/api/problems.list")
async def problems_list(
    showDeleted: bool = False,
    id: Optional[int] = None,
    name: Optional[str] = None,
    owner: Optional[str] = None,
):
    params: dict = {"showDeleted": showDeleted}
    if id is not None:
        params["id"] = id
    if name:
        params["name"] = name
    if owner:
        params["owner"] = owner
    return await proxy("problems.list", params)


@app.post("/api/problem.create")
async def problem_create(request: Request):
    data = await request.json()
    return await proxy("problem.create", {"name": data["name"]})


# ── problem.info / updateInfo / working copy / commit ────────────────────────

@app.get("/api/problem.info")
async def problem_info(problemId: int):
    return await proxy("problem.info", {"problemId": problemId})


@app.post("/api/problem.updateInfo")
async def problem_update_info(request: Request):
    data = await request.json()
    params = {"problemId": data["problemId"]}
    for k in ["inputFile", "outputFile", "interactive", "timeLimit", "memoryLimit"]:
        if k in data:
            params[k] = data[k]
    return await proxy("problem.updateInfo", params)


@app.post("/api/problem.updateWorkingCopy")
async def problem_update_working_copy(request: Request):
    data = await request.json()
    return await proxy("problem.updateWorkingCopy", {"problemId": data["problemId"]})


@app.post("/api/problem.discardWorkingCopy")
async def problem_discard_working_copy(request: Request):
    data = await request.json()
    return await proxy("problem.discardWorkingCopy", {"problemId": data["problemId"]})


@app.post("/api/problem.commitChanges")
async def problem_commit_changes(request: Request):
    data = await request.json()
    params: dict = {"problemId": data["problemId"]}
    if "minorChanges" in data:
        params["minorChanges"] = data["minorChanges"]
    if "message" in data:
        params["message"] = data["message"]
    return await proxy("problem.commitChanges", params)


# ── Statements ───────────────────────────────────────────────────────────────

@app.get("/api/problem.statements")
async def problem_statements(problemId: int):
    return await proxy("problem.statements", {"problemId": problemId})


@app.post("/api/problem.saveStatement")
async def problem_save_statement(request: Request):
    data = await request.json()
    params: dict = {"problemId": data["problemId"], "lang": data["lang"]}
    for k in ["encoding", "name", "legend", "input", "output", "scoring", "interaction", "notes", "tutorial"]:
        if k in data:
            params[k] = data[k]
    return await proxy("problem.saveStatement", params)


@app.get("/api/problem.statementResources")
async def problem_statement_resources(problemId: int):
    return await proxy("problem.statementResources", {"problemId": problemId})


@app.post("/api/problem.saveStatementResource")
async def problem_save_statement_resource(
    problemId: int = Form(...),
    name: str = Form(...),
    file: UploadFile = File(...),
    checkExisting: Optional[bool] = Form(None),
):
    params: dict = {"problemId": problemId, "name": name}
    if checkExisting is not None:
        params["checkExisting"] = checkExisting
    content = await file.read()
    return await proxy("problem.saveStatementResource", params, {"file": (name, content, "application/octet-stream")})


# ── Checker / Validator / Interactor ─────────────────────────────────────────

@app.get("/api/problem.checker")
async def problem_checker(problemId: int):
    return await proxy("problem.checker", {"problemId": problemId})


@app.get("/api/problem.validator")
async def problem_validator(problemId: int):
    return await proxy("problem.validator", {"problemId": problemId})


@app.get("/api/problem.extraValidators")
async def problem_extra_validators(problemId: int):
    return await proxy("problem.extraValidators", {"problemId": problemId})


@app.get("/api/problem.interactor")
async def problem_interactor(problemId: int):
    return await proxy("problem.interactor", {"problemId": problemId})


@app.post("/api/problem.setChecker")
async def problem_set_checker(request: Request):
    data = await request.json()
    return await proxy("problem.setChecker", {"problemId": data["problemId"], "checker": data["checker"]})


@app.post("/api/problem.setValidator")
async def problem_set_validator(request: Request):
    data = await request.json()
    return await proxy("problem.setValidator", {"problemId": data["problemId"], "validator": data["validator"]})


@app.post("/api/problem.setInteractor")
async def problem_set_interactor(request: Request):
    data = await request.json()
    return await proxy("problem.setInteractor", {"problemId": data["problemId"], "interactor": data["interactor"]})


# ── Validator / Checker tests ────────────────────────────────────────────────

@app.get("/api/problem.validatorTests")
async def problem_validator_tests(problemId: int):
    return await proxy("problem.validatorTests", {"problemId": problemId})


@app.post("/api/problem.saveValidatorTest")
async def problem_save_validator_test(request: Request):
    data = await request.json()
    params: dict = {
        "problemId": data["problemId"],
        "testIndex": data["testIndex"],
        "testInput": data["testInput"],
        "testVerdict": data["testVerdict"],
    }
    for k in ["checkExisting", "testGroup", "testset"]:
        if k in data:
            params[k] = data[k]
    return await proxy("problem.saveValidatorTest", params)


@app.get("/api/problem.checkerTests")
async def problem_checker_tests(problemId: int):
    return await proxy("problem.checkerTests", {"problemId": problemId})


@app.post("/api/problem.saveCheckerTest")
async def problem_save_checker_test(request: Request):
    data = await request.json()
    params: dict = {
        "problemId": data["problemId"],
        "testIndex": data["testIndex"],
        "testInput": data["testInput"],
        "testOutput": data["testOutput"],
        "testAnswer": data["testAnswer"],
        "testVerdict": data["testVerdict"],
    }
    if "checkExisting" in data:
        params["checkExisting"] = data["checkExisting"]
    return await proxy("problem.saveCheckerTest", params)


# ── Files ─────────────────────────────────────────────────────────────────────

@app.get("/api/problem.files")
async def problem_files(problemId: int):
    return await proxy("problem.files", {"problemId": problemId})


@app.post("/api/problem.saveFile")
async def problem_save_file(
    problemId: int = Form(...),
    type: str = Form(...),
    name: str = Form(...),
    file: UploadFile = File(...),
    sourceType: Optional[str] = Form(None),
    checkExisting: Optional[bool] = Form(None),
    forTypes: Optional[str] = Form(None),
    stages: Optional[str] = Form(None),
    assets: Optional[str] = Form(None),
):
    params: dict = {"problemId": problemId, "type": type, "name": name}
    if sourceType:
        params["sourceType"] = sourceType
    if checkExisting is not None:
        params["checkExisting"] = checkExisting
    if forTypes is not None:
        params["forTypes"] = forTypes
    if stages:
        params["stages"] = stages
    if assets:
        params["assets"] = assets
    content = await file.read()
    return await proxy("problem.saveFile", params, {"file": (name, content, "application/octet-stream")})


@app.get("/api/problem.viewFile")
async def problem_view_file(problemId: int, type: str, name: str):
    return await proxy("problem.viewFile", {"problemId": problemId, "type": type, "name": name})


# ── Solutions ─────────────────────────────────────────────────────────────────

@app.get("/api/problem.solutions")
async def problem_solutions(problemId: int):
    return await proxy("problem.solutions", {"problemId": problemId})


@app.post("/api/problem.saveSolution")
async def problem_save_solution(
    problemId: int = Form(...),
    name: str = Form(...),
    file: UploadFile = File(...),
    sourceType: Optional[str] = Form(None),
    tag: Optional[str] = Form(None),
    checkExisting: Optional[bool] = Form(None),
):
    params: dict = {"problemId": problemId, "name": name}
    if sourceType:
        params["sourceType"] = sourceType
    if tag:
        params["tag"] = tag
    if checkExisting is not None:
        params["checkExisting"] = checkExisting
    content = await file.read()
    return await proxy("problem.saveSolution", params, {"file": (name, content, "application/octet-stream")})


@app.get("/api/problem.viewSolution")
async def problem_view_solution(problemId: int, name: str):
    return await proxy("problem.viewSolution", {"problemId": problemId, "name": name})


@app.post("/api/problem.editSolutionExtraTags")
async def problem_edit_solution_extra_tags(request: Request):
    data = await request.json()
    params: dict = {"problemId": data["problemId"], "remove": data["remove"], "name": data["name"]}
    for k in ["testset", "testGroup", "tag"]:
        if k in data:
            params[k] = data[k]
    return await proxy("problem.editSolutionExtraTags", params)


# ── Tests ─────────────────────────────────────────────────────────────────────

@app.get("/api/problem.tests")
async def problem_tests(problemId: int, testset: str = "tests", noInputs: bool = False):
    params: dict = {"problemId": problemId, "testset": testset}
    if noInputs:
        params["noInputs"] = noInputs
    return await proxy("problem.tests", params)


@app.post("/api/problem.saveTest")
async def problem_save_test(request: Request):
    data = await request.json()
    params: dict = {
        "problemId": data["problemId"],
        "testset": data.get("testset", "tests"),
        "testIndex": data["testIndex"],
        "testInput": data["testInput"],
    }
    for k in ["testGroup", "testPoints", "testDescription", "testUseInStatements",
              "testInputForStatements", "testOutputForStatements",
              "verifyInputOutputForStatements", "checkExisting"]:
        if k in data:
            params[k] = data[k]
    return await proxy("problem.saveTest", params)


@app.get("/api/problem.testInput")
async def problem_test_input(problemId: int, testset: str, testIndex: int):
    return await proxy("problem.testInput", {"problemId": problemId, "testset": testset, "testIndex": testIndex})


@app.get("/api/problem.testAnswer")
async def problem_test_answer(problemId: int, testset: str, testIndex: int):
    return await proxy("problem.testAnswer", {"problemId": problemId, "testset": testset, "testIndex": testIndex})


@app.post("/api/problem.setTestGroup")
async def problem_set_test_group(request: Request):
    data = await request.json()
    params: dict = {
        "problemId": data["problemId"],
        "testset": data["testset"],
        "testGroup": data["testGroup"],
    }
    if "testIndex" in data:
        params["testIndex"] = data["testIndex"]
    if "testIndices" in data:
        params["testIndices"] = data["testIndices"]
    return await proxy("problem.setTestGroup", params)


@app.post("/api/problem.enableGroups")
async def problem_enable_groups(request: Request):
    data = await request.json()
    return await proxy("problem.enableGroups", {
        "problemId": data["problemId"],
        "testset": data["testset"],
        "enable": data["enable"],
    })


@app.post("/api/problem.enablePoints")
async def problem_enable_points(request: Request):
    data = await request.json()
    return await proxy("problem.enablePoints", {
        "problemId": data["problemId"],
        "enable": data["enable"],
    })


# ── Test Groups ───────────────────────────────────────────────────────────────

@app.get("/api/problem.viewTestGroup")
async def problem_view_test_group(problemId: int, testset: str, group: Optional[str] = None):
    params: dict = {"problemId": problemId, "testset": testset}
    if group:
        params["group"] = group
    return await proxy("problem.viewTestGroup", params)


@app.post("/api/problem.saveTestGroup")
async def problem_save_test_group(request: Request):
    data = await request.json()
    params: dict = {"problemId": data["problemId"], "testset": data["testset"], "group": data["group"]}
    for k in ["pointsPolicy", "feedbackPolicy", "dependencies"]:
        if k in data:
            params[k] = data[k]
    return await proxy("problem.saveTestGroup", params)


# ── Script ────────────────────────────────────────────────────────────────────

@app.get("/api/problem.script")
async def problem_script(problemId: int, testset: str = "tests"):
    return await proxy("problem.script", {"problemId": problemId, "testset": testset})


@app.post("/api/problem.saveScript")
async def problem_save_script(request: Request):
    data = await request.json()
    return await proxy("problem.saveScript", {
        "problemId": data["problemId"],
        "testset": data.get("testset", "tests"),
        "source": data["source"],
    })


# ── Tags ──────────────────────────────────────────────────────────────────────

@app.get("/api/problem.viewTags")
async def problem_view_tags(problemId: int):
    return await proxy("problem.viewTags", {"problemId": problemId})


@app.post("/api/problem.saveTags")
async def problem_save_tags(request: Request):
    data = await request.json()
    return await proxy("problem.saveTags", {"problemId": data["problemId"], "tags": data["tags"]})


# ── General Description / Tutorial ───────────────────────────────────────────

@app.get("/api/problem.viewGeneralDescription")
async def problem_view_general_description(problemId: int):
    return await proxy("problem.viewGeneralDescription", {"problemId": problemId})


@app.post("/api/problem.saveGeneralDescription")
async def problem_save_general_description(request: Request):
    data = await request.json()
    return await proxy("problem.saveGeneralDescription", {
        "problemId": data["problemId"],
        "description": data.get("description", ""),
    })


@app.get("/api/problem.viewGeneralTutorial")
async def problem_view_general_tutorial(problemId: int):
    return await proxy("problem.viewGeneralTutorial", {"problemId": problemId})


@app.post("/api/problem.saveGeneralTutorial")
async def problem_save_general_tutorial(request: Request):
    data = await request.json()
    return await proxy("problem.saveGeneralTutorial", {
        "problemId": data["problemId"],
        "tutorial": data.get("tutorial", ""),
    })


# ── Packages ──────────────────────────────────────────────────────────────────

@app.get("/api/problem.packages")
async def problem_packages(problemId: int):
    return await proxy("problem.packages", {"problemId": problemId})


@app.post("/api/problem.buildPackage")
async def problem_build_package(request: Request):
    data = await request.json()
    return await proxy("problem.buildPackage", {
        "problemId": data["problemId"],
        "full": data.get("full", False),
        "verify": data.get("verify", False),
    })


@app.get("/api/problem.package")
async def problem_package(problemId: int, packageId: int, type: Optional[str] = None):
    params: dict = {"problemId": problemId, "packageId": packageId}
    if type:
        params["type"] = type
    return await proxy("problem.package", params)


# ── Headless import (API-driven — the whole pipeline server-side, for Maestro) ─
# The full import pipeline is also implemented in the frontend (browser-driven);
# these endpoints run the SAME pipeline server-side so any client (the Maestro
# orchestrator, scripts) can import a problem from a ZIP without a browser.

def _import_defaults() -> dict:
    s = dict(DEFAULT_SETTINGS)
    s.update(_config.get("default_settings", {}))
    return s


def _resolve_preview(mlim: Optional[dict], clim: Optional[dict], settings: dict) -> dict:
    """The effective limits + checker an import WOULD apply from a manifest and/or
    characteristics, absent an explicit form field: limits manifest > characteristics
    > default; checker manifest > characteristics (null → upload the archive's
    checker.cpp). Used by /api/parse to preview the decision."""
    import manifest as mf
    mlim, clim = mlim or {}, clim or {}
    tl, tl_src = mf.resolve_limit_chain(
        [(mlim.get("timeLimit"), "manifest"), (clim.get("timeLimit"), "characteristics")],
        settings["default_time_limit"])
    ml, ml_src = mf.resolve_limit_chain(
        [(mlim.get("memoryLimit"), "manifest"), (clim.get("memoryLimit"), "characteristics")],
        settings["default_memory_limit"])
    return {
        "timeLimit": tl, "memoryLimit": ml,
        "limitsSource": tl_src if tl_src == ml_src else "mixed",
        "checker": mlim.get("checker") or clim.get("checker"),   # {kind,name,polygonId}|None
    }


async def _packages(problemId: int) -> list:
    api_key, api_secret = get_creds()
    body, _ = await call_polygon("problem.packages", api_key, api_secret, {"problemId": problemId})
    data = json.loads(body.decode("utf-8", errors="replace"))
    if data.get("status") == "FAILED":
        raise HTTPException(status_code=400, detail=data.get("comment", "problem.packages failed"))
    return data.get("result") or []


@app.post("/api/parse")
async def parse_archives(files: List[UploadFile] = File(...)):
    """DRY RUN. Parse + group one or more problem ZIP(s) exactly the way
    /api/import-problem would, but import nothing and touch Polygon not at all —
    returns the authoritative {slug, name, testsOnly, testCount, …} for each
    resulting problem plus any per-file parseErrors. Lets an orchestrator (or the
    UI) validate a folder and preview what WILL import from the single source of
    truth (the backend parser), instead of a separate client-side guess. No
    credentials required.

    Note on limits: the problem-ARCHIVE format carries NO time/memory limits, so
    `timeLimit`/`memoryLimit` stay `null` — the archive declares nothing, and `null`
    means 'archive is silent', which is the signal a pre-flight limit-check needs.
    If an optional `MANIFEST.json` is uploaded with the archives, each problem it
    describes also gets a `manifest` object: the authored `timeLimit`/`memoryLimit`
    (ms / MB), the authored `measuredWorstMs`, and `archiveVerified` (whether the
    archive's sha256/size matched). Absent a manifest, `manifest` is `null`."""
    import zip_parser as zp
    from statement_parser import iso_639_1
    import manifest as mf
    import characteristics as ch

    settings = _import_defaults()
    try:
        # Optional MANIFEST.json / characteristics.md may travel with the archives.
        manifest = None
        chars: dict = {}       # slug -> {timeLimit, memoryLimit, checker}
        archives = []          # (filename, content)
        parse_errors = []
        for f in files:
            content = await f.read()
            if mf.looks_like_manifest(f.filename, content):
                try:
                    manifest = mf.parse_manifest(content)
                except mf.ManifestError as e:
                    parse_errors.append({"file": f.filename, "error": f"manifest: {e}"})
                continue
            if ch.looks_like_characteristics(f.filename, content):
                try:
                    chars = ch.derive_from_characteristics(content.decode("utf-8", errors="replace"))
                except Exception as e:
                    parse_errors.append({"file": f.filename, "error": f"characteristics: {e}"})
                continue
            archives.append((f.filename, content))

        parsed_items = []
        for fname, content in archives:
            try:
                p = zp.parse_zip(content)
            except Exception as e:
                parse_errors.append({"file": fname, "error": str(e)})
                continue
            # None = manifest doesn't describe this file; True/False = matched or not.
            p["_verified"] = mf.archive_verified(manifest, fname, content)
            parsed_items.append(p)

        # Same grouping as the import: tests-only packs key by base slug so they
        # merge with / append to their base problem.
        grouped: dict = {}
        for p in parsed_items:
            key = zp.base_problem_slug(p["problemName"]) if p["testsOnly"] else p["problemName"]
            grouped.setdefault(key, []).append(p)

        problems = []
        for slug, items in grouped.items():
            m = zp.merge_parsed_group(items)
            groups = sorted({t["group"] for t in m["tests"]}, key=lambda g: int(g)) if m["tests"] else []
            lang_names = list(m["languages"].keys())
            # Manifest reading for this slug (declared limits + authored worst-case),
            # and archive integrity across the group: False if any described archive
            # mismatched, True if any matched, None if the manifest describes none.
            mlim = mf.limits_for(manifest, slug)
            vers = [it.get("_verified") for it in items]
            archive_verified = False if any(v is False for v in vers) else \
                (True if any(v is True for v in vers) else None)
            problems.append({
                "slug": slug,
                "name": m.get("displayName") or slug,
                "testsOnly": m.get("testsOnly", False),
                "testCount": len(m["tests"]),
                "languages": lang_names,
                # Canonical ISO 639-1 codes (EN/RU/...) for the parsed languages, so a
                # consumer whose manifest uses codes can compare directly. Unmapped
                # languages are omitted here (present in `languages`), so a length
                # mismatch between the two flags an unrecognised language.
                "languageCodes": [c for c in (iso_639_1(n) for n in lang_names) if c],
                "hasChecker": bool(m["checkerCode"]),
                "hasValidator": bool(m["validatorCode"]),
                "hasSolution": bool(m["solutionCode"]),
                "extraSolutionCount": len(m["extraSolutions"]),
                "hasScoring": m["hasScoring"],
                "groups": groups,
                "archiveCount": len(items),
                # The ARCHIVE declares no limits; these stay null (archive is silent).
                "timeLimit": None,
                "memoryLimit": None,
                # Present only when an uploaded MANIFEST.json describes this slug: the
                # authored limits (ms / MB) + the authored worst-case runtime, plus
                # whether the archive's sha256/size matched the manifest.
                "manifest": ({
                    "timeLimit": mlim["timeLimit"],
                    "memoryLimit": mlim["memoryLimit"],
                    "measuredWorstMs": mlim["measuredWorstMs"],
                    "archiveVerified": archive_verified,
                } if mlim else None),
                # Present only when a characteristics.md describes this slug.
                "characteristics": chars.get(slug),
                # The effective decision the import WOULD make (no form field here):
                # limits manifest > characteristics > default; checker manifest >
                # characteristics; `checker` null → upload the archive's checker.cpp.
                "resolved": _resolve_preview(mlim, chars.get(slug), settings),
            })
    except Exception as e:
        import traceback
        alog.record("error", "import", f"parse dry-run crashed: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Parse failed ({type(e).__name__}): {e}")
    alog.record("api", "import", f"parse dry-run · {len(problems)} problem(s), {len(parse_errors)} parse error(s)")
    return {"problems": problems, "parseErrors": parse_errors}


@app.post("/api/import-problem", status_code=202)
async def import_problem(
    files: List[UploadFile] = File(...),
    timeLimit: Optional[int] = Form(None),
    memoryLimit: Optional[int] = Form(None),
    onExists: str = Form("fill"),
    checkerType: Optional[str] = Form(None),
    solutionType: Optional[str] = Form(None),
):
    """ASYNC import. Parse one or more problem ZIPs, start the full pipeline
    (create → statements → checker → solution → tests → groups → commit →
    build+verify) in the BACKGROUND, and return a `jobId` immediately — it never
    blocks for the minutes an import can take. Poll `GET /api/verify-status/{jobId}`.

    Same-slug archives (a main archive + '<slug>-tests' packs) merge into one
    problem; a lone tests-only pack appends to the base. Every Polygon-side failure
    is folded into the job's per-problem `errorCode`/`clientAction` — this endpoint
    does NOT return a bare HTTP error for a Polygon failure. (Reminder: the raw
    `/api/problem.*` proxy endpoints instead pass Polygon `FAILED` through as HTTP
    200 with `status:"FAILED"` in the body — read the body there, not the code.)"""
    import zip_parser as zp
    import import_jobs
    import manifest as mf
    import characteristics as ch

    api_key, api_secret = get_creds()
    settings = _import_defaults()
    opts_common = {
        "timeLimit": timeLimit if timeLimit is not None else settings["default_time_limit"],
        "memoryLimit": memoryLimit if memoryLimit is not None else settings["default_memory_limit"],
        "onExists": onExists if onExists in ("fill", "reset") else "fill",
        "checkerType": checkerType or settings["checker_source_type"],
        "solutionType": solutionType or settings["solution_source_type"],
    }

    # Never let setup (parse / group / merge / job-start) return a bare 500 — that
    # would give Maestro an opaque error. Any crash is logged with a full traceback
    # to the activity log and returned as a readable 500 detail.
    try:
        # Optional MANIFEST.json / characteristics.md may travel with the archives.
        manifest = None
        chars: dict = {}       # slug -> {timeLimit, memoryLimit, checker}
        archives = []          # (filename, content)
        parse_errors = []
        for f in files:
            content = await f.read()
            if mf.looks_like_manifest(f.filename, content):
                try:
                    manifest = mf.parse_manifest(content)
                except mf.ManifestError as e:
                    parse_errors.append({"file": f.filename, "error": f"manifest: {e}"})
                    alog.record("error", "import", f"manifest parse failed: {f.filename} — {e}")
                continue
            if ch.looks_like_characteristics(f.filename, content):
                try:
                    chars = ch.derive_from_characteristics(content.decode("utf-8", errors="replace"))
                except Exception as e:
                    parse_errors.append({"file": f.filename, "error": f"characteristics: {e}"})
                    alog.record("error", "import", f"characteristics parse failed: {f.filename} — {e}")
                continue
            archives.append((f.filename, content))

        parsed_items = []
        for fname, content in archives:
            # Integrity gate: if the manifest describes this archive and the hash or
            # size disagrees, refuse it — a corrupt/rebuilt archive must not import.
            if manifest is not None:
                err = mf.verify_archive(manifest, fname, content)
                if err:
                    parse_errors.append({"file": fname, "error": f"integrity: {err}"})
                    alog.record("error", "import", f"integrity: {fname} — {err}")
                    continue
            try:
                parsed_items.append(zp.parse_zip(content))
            except Exception as e:
                parse_errors.append({"file": fname, "error": str(e)})
                alog.record("error", "import", f"parse failed: {fname} — {e}")

        # Group by slug; tests-only packs key by base slug so they merge / append.
        grouped: dict = {}
        for p in parsed_items:
            key = zp.base_problem_slug(p["problemName"]) if p["testsOnly"] else p["problemName"]
            grouped.setdefault(key, []).append(p)
        groups = [(slug, zp.merge_parsed_group(items)) for slug, items in grouped.items()]

        # Resolve per-slug limits: form field > manifest > characteristics > default.
        # `limitsSource` (form|manifest|characteristics|default|mixed) travels on the
        # job so a fallback can never be mistaken for an explicit value. The checker
        # directive (manifest > characteristics) tells the pipeline to set a STANDARD
        # checker by name instead of uploading the archive's checker.cpp.
        d_tl, d_ml = settings["default_time_limit"], settings["default_memory_limit"]
        limits_by_slug: dict = {}
        checker_by_slug: dict = {}
        for slug, _merged in groups:
            mlim = mf.limits_for(manifest, slug) or {}
            clim = chars.get(slug) or {}
            tl, tl_src = mf.resolve_limit_chain(
                [(timeLimit, "form"), (mlim.get("timeLimit"), "manifest"), (clim.get("timeLimit"), "characteristics")], d_tl)
            ml, ml_src = mf.resolve_limit_chain(
                [(memoryLimit, "form"), (mlim.get("memoryLimit"), "manifest"), (clim.get("memoryLimit"), "characteristics")], d_ml)
            limits_by_slug[slug] = {
                "timeLimit": tl, "memoryLimit": ml,
                "source": tl_src if tl_src == ml_src else "mixed",
            }
            directive = mlim.get("checker") or clim.get("checker")
            if directive:
                checker_by_slug[slug] = directive

        job = import_jobs.create_job(groups, opts_common, parse_errors, api_key, api_secret,
                                     limits_by_slug=limits_by_slug, checker_by_slug=checker_by_slug)
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        alog.record("error", "import", f"import-problem setup crashed: {e}\n{tb}")
        raise HTTPException(status_code=500, detail=f"Import setup failed ({type(e).__name__}): {e}")
    alog.record("api", "import", f"job {job['jobId']} started · {len(groups)} problem(s), {len(parse_errors)} parse error(s)")
    return {
        "jobId": job["jobId"],
        "state": job["state"],
        "problems": [{"slug": p["slug"], "name": p["name"], "testsOnly": p["testsOnly"],
                      "testCount": p["testCount"], "importState": p["importState"]} for p in job["problems"]],
        "parseErrors": parse_errors,
    }


@app.get("/api/verify-status/{jobId}")
async def verify_status(jobId: str):
    """Poll an import job. Returns per-problem import state + the LIVE build/verify
    state, each with a machine-readable `errorCode` and `clientAction`
    (proceed | success | retry | wait | halt). `alreadyVerified` /
    `IMPORTED_ALREADY_VERIFIED` (clientAction `success`) means the revision already
    had a verified package — usable now, NOT a failure."""
    import import_jobs
    api_key, api_secret = get_creds()
    status = await import_jobs.verify_status(jobId, api_key, api_secret)
    if status is None:
        raise HTTPException(status_code=404, detail=f"Unknown jobId: {jobId}")
    return status


@app.post("/api/import-cancel/{jobId}")
async def import_cancel(jobId: str):
    """Stop a running import mid-flight. The background task is cancelled at its next
    await (including during a retry backoff or a Polygon upload), and whatever hadn't
    finished is marked `cancelled` (errorCode `CANCELLED`). Nothing is committed to
    Polygon, so a later re-import (fill) is clean. `404` if the job is unknown."""
    import import_jobs
    if import_jobs.get_job(jobId) is None:
        raise HTTPException(status_code=404, detail=f"Unknown jobId: {jobId}")
    cancelled = import_jobs.cancel_job(jobId)
    alog.record("api", "import", f"cancel {jobId}: {'cancelled' if cancelled else 'nothing running'}")
    return {"jobId": jobId, "cancelled": cancelled}


@app.post("/api/import-cancel-all")
async def import_cancel_all():
    """Stop every running import at once (a global Stop). Returns how many live jobs
    were cancelled."""
    import import_jobs
    n = import_jobs.cancel_all()
    alog.record("api", "import", f"cancel-all: {n} job(s) cancelled")
    return {"cancelled": n}


@app.get("/api/download-package/{jobId}")
async def download_package(jobId: str, problemId: Optional[int] = None, type: Optional[str] = None):
    """Download the latest READY package for a job's problem. If the job produced
    more than one problem, pass `?problemId=` (it must belong to the job)."""
    import import_jobs
    api_key, api_secret = get_creds()
    if import_jobs.get_job(jobId) is None:
        raise HTTPException(status_code=404, detail=f"Unknown jobId: {jobId}")
    ids = import_jobs.job_problem_ids(jobId)
    if problemId is not None:
        if problemId not in ids:
            raise HTTPException(status_code=400, detail="problemId does not belong to this job.")
        target = problemId
    elif len(ids) == 1:
        target = ids[0]
    elif not ids:
        raise HTTPException(status_code=404, detail="Job has no imported problem yet.")
    else:
        raise HTTPException(status_code=400, detail=f"Job produced {len(ids)} problems; pass ?problemId= (one of {ids}).")

    ready = [p for p in await _packages(target) if p.get("state") == "READY"]
    if not ready:
        raise HTTPException(status_code=404, detail="No READY package for this problem yet.")
    latest = max(ready, key=lambda p: (p.get("revision", 0), p.get("id", 0)))
    pkg_type = type or latest.get("type") or "standard"
    pkg_body, _ = await call_polygon(
        "problem.package", api_key, api_secret,
        {"problemId": target, "packageId": latest["id"], "type": pkg_type},
    )
    filename = f"{target}-r{latest.get('revision')}-{pkg_type}.zip"
    return Response(content=pkg_body, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ── Contest ───────────────────────────────────────────────────────────────────

@app.get("/api/contest.problems")
async def contest_problems(contestId: str):
    return await proxy("contest.problems", {"contestId": contestId})


def _cf_web_creds() -> tuple[str, str]:
    login = _config.get("cf_login", "")
    password = _config.get("cf_password", "")
    if not login or not password:
        raise HTTPException(status_code=400, detail="Codeforces web login not set. Add it in Settings.")
    return login, password


def _log_collector():
    lines: list[dict] = []
    def collect(message: str, status: str):
        lines.append({"text": message, "status": status})
        print(f"   [contest] {status.upper()}: {message}")
        level = "error" if status == "error" else "ok" if status == "done" else "contest"
        alog.record(level, "contest", message)
    return lines, collect


async def _run_automation(coro_factory, lines: list[dict]) -> dict:
    """Run a Playwright coroutine off the server's event loop and never 500.

    Playwright needs a subprocess-capable loop (ProactorEventLoop on Windows),
    which the server's loop is not — so contest_automation.run_sync spins one up
    in a worker thread via run_in_threadpool. Any exception is caught and folded
    into the JSON body so the response still carries CORS headers (a bare 500
    from the error middleware would be blocked by the browser as a CORS error).
    """
    from fastapi.concurrency import run_in_threadpool
    import contest_automation as ca
    try:
        result = await run_in_threadpool(ca.run_sync, coro_factory)
    except Exception as e:  # noqa: BLE001 — surface the real error to the client
        import traceback
        tb = traceback.format_exc()
        print(tb)
        alog.record("error", "contest", f"Automation crashed: {e}\n{tb.rstrip()}")
        lines.append({"text": f"Automation crashed: {e}", "status": "error"})
        return {"ok": False, "error": str(e), "log": lines}
    return {**result, "log": lines}


@app.post("/api/automation/contest/list")
async def automation_contest_list(request: Request):
    """Browser automation: scrape the Polygon contests page."""
    import contest_automation as ca
    data = await request.json()
    login, password = _cf_web_creds()
    lines, collect = _log_collector()
    headful = bool(data.get("headful", False))
    return await _run_automation(lambda: ca.list_contests(login, password, headful, collect), lines)


@app.post("/api/automation/contest/create")
async def automation_contest_create(request: Request):
    """Browser automation: create a new Polygon contest."""
    import contest_automation as ca
    data = await request.json()
    name = (data.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Contest name is required.")
    login, password = _cf_web_creds()
    lines, collect = _log_collector()
    headful = bool(data.get("headful", True))
    return await _run_automation(lambda: ca.create_contest(name, login, password, headful, collect), lines)


@app.post("/api/automation/contest/add")
async def automation_contest_add(request: Request):
    """Browser automation: add problem slugs to an existing Polygon contest."""
    import contest_automation as ca
    data = await request.json()
    contest_id = str(data.get("contestId") or "").strip()
    slugs = [s for s in (data.get("slugs") or []) if s]
    if not contest_id or not slugs:
        raise HTTPException(status_code=400, detail="Contest id and at least one slug are required.")
    login, password = _cf_web_creds()
    lines, collect = _log_collector()
    headful = bool(data.get("headful", True))
    return await _run_automation(lambda: ca.add_problems(contest_id, slugs, login, password, headful, collect), lines)
