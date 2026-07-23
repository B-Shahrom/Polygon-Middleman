import json
import os
import time as _time
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from polygon_api import call_polygon

app = FastAPI(title="Polygon Middleman", version="1.0.0")


# ── Pretty Logging ────────────────────────────────────────────────────────────

def _log_request(method: str, params: dict, files: dict | None = None):
    """Log an outgoing Polygon API call in a readable format."""
    ts = _time.strftime("%H:%M:%S")
    file_info = ""
    if files:
        file_names = [f"{k} ({fn})" for k, (fn, _, _) in files.items()]
        file_info = f"  files: {', '.join(file_names)}"
    # Filter out noisy/internal params
    display = {k: v for k, v in params.items() if k not in ("apiKey", "apiSig", "time")}
    param_str = ", ".join(f"{k}={v}" for k, v in display.items()) if display else "(none)"
    print(f"\n>> [{ts}] {method}")
    print(f"   params: {param_str}{file_info}")


def _log_response(method: str, body: bytes, content_type: str):
    """Log a Polygon API response in a readable format."""
    ts = _time.strftime("%H:%M:%S")
    try:
        data = json.loads(body)
        status = data.get("status", "?")
        if status == "OK":
            result = data.get("result")
            if isinstance(result, list):
                print(f"OK [{ts}] {method} -> OK ({len(result)} items)")
            elif isinstance(result, dict):
                print(f"OK [{ts}] {method} -> OK (object)")
            elif result is not None:
                print(f"OK [{ts}] {method} -> OK: {str(result)[:120]}")
            else:
                print(f"OK [{ts}] {method} -> OK")
        else:
            comment = data.get("comment", "Unknown error")
            print(f"ERR [{ts}] {method} -> FAILED: {comment}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        # Binary response (e.g. file download, package)
        size = len(body)
        if size > 1024:
            print(f"BIN [{ts}] {method} -> {size / 1024:.1f} KB ({content_type})")
        else:
            print(f"BIN [{ts}] {method} -> {size} bytes ({content_type})")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
        traceback.print_exc()
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
