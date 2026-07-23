# Polygon Middleman

A full-featured desktop web application for uploading and managing competitive programming problems on **Codeforces Polygon** via the Polygon API.

## Features

- **Problem Management**: Create, edit, and manage problems from a single dashboard
- **One-Click ZIP Import**: Import one or many fully-structured problem ZIPs in a single batch — auto-creates the problem, uploads the statement, checker, solution, and grouped tests, and configures subtask policies
- **Batch Test Upload**: Upload tests from ZIP files with auto-parsing of groups and indices
- **Multi-Language Statements**: Split a single LaTeX block into English, Russian, Tajik, and Uzbek
- **Solution Management**: Upload, view, delete with 12 tag types
- **Test Groups & Subtasks**: Inline editing, derive dependencies and points from statement
- **Checker/Validator**: Standard checkers or custom C++ files
- **Statement Preview**: View compiled HTML preview with MathJax
- **8-Step Upload Wizard**: Guided flow from problem creation to commit
- **Complete API Coverage**: All 30+ Polygon API methods implemented
- **Dark Theme**: Sunset Ember color scheme with animations

## Stack

- **Backend**: Python 3.10+, FastAPI, Uvicorn
- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS
- **HTTP**: httpx (async), requests (multipart)
- **Icons**: Lucide React

## Getting Started

### Prerequisites

- Python 3.10+ with pip
- Node.js 18+ with npm
- Polygon API key and secret

Works on **Windows, macOS, and Linux** — the app itself is fully cross-platform; only the convenience launchers differ per OS.

### Setup

**Backend:**
```bash
cd backend
python -m venv venv

# Windows
venv\Scripts\activate
# macOS / Linux
source venv/bin/activate

pip install -r requirements.txt
```

> **Credentials** live in `backend/config.json`, which is **gitignored and never committed** — your API key/secret never reach GitHub. A `config.example.json` shows the shape; the real file is created locally when you save credentials in **Settings**. On a new device/clone you re-enter them once.

**Frontend:**
```bash
cd frontend
npm install
```

### Running

```bash
# Windows
start.bat

# macOS / Linux (first run: chmod +x start.sh)
./start.sh
```

Each launcher creates the venv, installs deps, starts both servers, and opens the browser. Or run the two servers manually:

```bash
# Terminal 1
cd backend && uvicorn main:app --reload --port 8000

# Terminal 2
cd frontend && npm run dev
```

Then open [http://localhost:5173](http://localhost:5173)

> On macOS/Linux you can also use `./start_backend.sh` and `./start_frontend.sh` to run each server separately (the `.bat` equivalents are for Windows).

### First Use

1. Go to **Settings** and enter your Polygon API credentials
2. Return to **Problems** — list loads automatically
3. Use **Import ZIP** for one-click batch import, **Upload Wizard** for a guided flow, or click a problem to manage it

## Add problems to a contest (browser automation)

Polygon exposes **no API** for creating contests or adding problems to them (only read-only `contest.problems` / `contest.xml`). So the **Add to contest** bulk action drives the Polygon website with a headless/headful browser: log in → create the contest → add each selected problem by slug.

Setup (one-time):
```bash
cd backend
pip install -r requirements.txt   # installs playwright
playwright install chromium       # downloads the browser (~150 MB)
```

Then set your **Codeforces web login** in **Settings** (the Polygon API key can't drive the website). Select problems on the Problems page → **Add to contest** → name it, keep **Show the browser** on the first time so you can watch it and log in if prompted.

> ⚠️ This is inherently **fragile** — it depends on Polygon's page markup, so selectors may need tuning when Polygon changes its UI. Run it headful to see where it stops. The Codeforces password is stored in plaintext in the gitignored `backend/config.json` and is never returned by the app once saved — use an account you're comfortable scripting.

## Develop in the Cloud (GitHub Codespaces)

This repo ships a [`.devcontainer`](.devcontainer/devcontainer.json) so you can work from any device with zero local setup. On GitHub, click **Code → Codespaces → Create codespace on main**. The container installs Python deps (into `backend/venv`) and `npm install`s the frontend automatically.

Inside the Codespace (Linux — `start.bat` is Windows-only, so run the servers directly):

```bash
# Terminal 1 — backend
backend/venv/bin/uvicorn main:app --reload --port 8000 --app-dir backend

# Terminal 2 — frontend
npm --prefix frontend run dev
```

Port **5173** opens a preview automatically; **8000** is forwarded for the API. Because `backend/config.json` is gitignored, re-enter your Polygon credentials in **Settings** the first time (each Codespace is a fresh environment).

## Project Structure

```
Polygon_Middleman/
├── backend/
│   ├── main.py              # FastAPI app
│   ├── polygon_api.py       # API client (SHA-512 signing)
│   ├── config.json          # Credentials (gitignored)
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── pages/           # Main pages
│   │   ├── tabs/            # Problem detail tabs
│   │   ├── wizard/          # Upload Wizard + ZIP Import
│   │   ├── utils/           # Statement & test parsers
│   │   ├── components/ui/   # UI components
│   │   └── api/client.ts    # Typed API client
│   └── package.json
├── .gitignore
└── README.md
```

## API Coverage

**Problems**: list, create  
**Config**: info, updateInfo, commitChanges, updateWorkingCopy, discardWorkingCopy  
**Statements**: statements, saveStatement, statementResources, saveStatementResource  
**Files**: files, saveFile, viewFile  
**Solutions**: solutions, saveSolution, viewSolution, editSolutionExtraTags  
**Tests**: tests, saveTest, testInput, testAnswer, setTestGroup, enableGroups, enablePoints  
**Checker/Validator**: checker, validator, interactor, setChecker, setValidator, setInteractor  
**And more**: Script, Tags, Tutorial, Packages, Contest

## Key Features

### ZIP Import (Batch)

Click **Import ZIP** on the Problems page and select one or more `.zip` files. Each ZIP holds a single problem:

```
edu-problem-name/           # the folder name becomes the Polygon slug
├── problem_statement.mdx   # multi-language statement (\textbf{English} … markers)
├── tutorial.mdx            # optional editorial, same languages as the statement
├── checker.cpp
├── solution.cpp            # main correct → tagged MA
├── validator.cpp           # optional → set as validator
├── wa_*.cpp / tle_*.cpp    # optional extra solutions, tagged by prefix
└── testset/                # also accepts the "tesset/" spelling
    ├── input_s0_idx0.txt    # group 0 = samples (useInStatements)
    ├── input_s1_idx0.txt    # group N from the _sN_ in the filename
    └── ...
```

**Strict reading** — the importer only reads these components: `problem_statement.mdx` (or `.tex`), an optional `tutorial.mdx` (or `.tex`), `checker.cpp`, `solution.cpp`, an optional `validator.cpp`, optional extra solutions (`.cpp` whose name starts with a tag prefix — `wa`, `tle`/`tl`/`slow`, `mle`/`ml`, `re`/`rte`, `pe`, `to`, `tm`, `ok`/`ac`/`brute`), and `input*.txt` files inside `testset/`. Everything else (generators, `.DS_Store`, answer files, etc.) is ignored.

**Editorials** — `tutorial.mdx` holds a LaTeX editorial split by the **same `\textbf{English}` / `\textbf{Russian}` language markers as the statement**. Each language's editorial is saved into that language's Polygon statement `tutorial` field, so the tutorial languages mirror the statement languages. The preview warns if a language is missing from (or extra in) the tutorial.

**Pre-flight validation** — the preview screen flags problems before upload: missing checker/solution/tests/languages, **non-contiguous test groups** (e.g. 0,1,3 — missing 2), and scoring tables that reference groups without tests. You can also **edit the slug, time limit and memory limit per ZIP** right in the preview. A local **import history** (with Polygon links and copyable slugs) persists across sessions.

**Handling a slug that already exists** — each ZIP has an **If exists** policy:

| Policy | Behavior |
|--------|----------|
| **Skip** | Leave the existing problem untouched. |
| **Fill / update** *(default)* | Upload the archive into the existing problem — adds what's missing and overwrites what changed. This is also what **Retry** uses. |
| **Reset & overwrite** | Discard the problem's working copy first, then upload. |

> ⚠️ The Polygon API has **no delete-problem method** (deletion is UI-only), so *Reset* discards the **working copy** and re-uploads. It fully resets a problem that was never committed, but it can't remove already-committed surplus tests — for that, delete the problem in the Polygon UI first, then import.

For every problem the importer runs an isolated pipeline:

1. Creates the problem using the **full folder name as the slug** (the `edu-` prefix is kept), or a per-ZIP override
2. Sets limits — 1000 ms / 256 MB by default, or per-ZIP overrides — with `stdin`/`stdout`
3. Saves a statement per detected language, attaching each language's editorial from `tutorial.mdx`
4. Uploads `checker.cpp` (and `validator.cpp` if present) and sets them
5. Uploads `solution.cpp` tagged `MA`, plus any extra solutions with their prefix-detected tags (`WA`, `TL`, …)
6. Enables groups and points, then uploads grouped tests (each test retried; duplicate-content tests still written so the `1..N` enumeration never gaps)
7. Sets every group's points policy to `COMPLETE_GROUP`, then:
   - **If the statement has a scoring section** — auto-runs **Derive Dependencies** and **Derive Points**, parsing the scoring table for per-group dependencies and points.
   - **Otherwise** — makes the **last group depend on all other groups** and assigns **100 points** to the last group.
8. **Commits** the changes and requests **verification** via `buildPackage(verify=true)`, which invokes every solution on every test (and the checker on stress tests) to confirm the tags are valid

> The commit is required because the Polygon API can only verify a *committed* revision — the web UI's working-copy "Verify" button is not exposed as an API method.

Imports are **fault-isolated**: a failing step is logged in red and the pipeline continues; a failing problem is skipped and the rest of the batch keeps going. If any test fails to upload after retries, commit + verify are skipped so the problem stays clean for a re-import. A per-problem summary is shown at the end.

### Queue & parallel agents

Imports run through a **persistent queue** processed by a bounded worker pool — you can keep adding ZIP batches while others are still processing, and the queue keeps running in the background if you close the modal. **Parallel agents** (1–6, default 2) controls how many problems import at once; jobs targeting the **same slug are always serialized**, since Polygon edits one working copy per problem.

Lowering the agent count never cancels running jobs — the pool simply stops launching new ones and drains to the new limit. Raising it takes effect immediately.

> **Origin sharding** — browsers cap ~6 concurrent HTTP/1.1 connections *per origin*. The client can round-robin across several loopback origins (`localhost`, `127.0.0.1`, `127.0.0.2`, …) — each its own connection pool — for ~6 → ~24 usable connections. **This requires the backend to answer on those alternate addresses, which only happens when it's bound to `0.0.0.0`.** By default the backend binds **`127.0.0.1`** (loopback only) so it isn't reachable from your LAN, so sharding degrades to one origin (~6 connections). At ≤6 agents that's plenty; the queue view shows the active connection budget. To go wider safely, run several backend instances on different ports (all on `127.0.0.1`) rather than exposing `0.0.0.0`.

> **Security** — the backend has no authentication, so it binds `127.0.0.1` (loopback only). Do **not** change it to `0.0.0.0` or expose the port publicly without adding an auth layer first — anyone who can reach it can operate your Polygon account. For remote access, use a private mesh VPN (Tailscale/WireGuard) rather than a public tunnel.

### Multi-Language Splitting

Paste a single LaTeX block with language markers (`\textbf{English}`, `\textbf{Russian}`, etc.) and click **Split Languages** to automatically parse and save to all languages.

### 8-Step Upload Wizard

1. Select/Create Problem
2. Problem Info
3. Statement
4. Checker
5. Validator
6. Solutions
7. Tests
8. Review & Commit

### Test Groups & Subtasks

- Auto-enable groups and points
- Derive dependencies from Scoring section
- Derive points from Scoring section
- Inline edit group and points
- Auto-mark group 0 as samples

## License

MIT License — see [LICENSE](LICENSE)

## Author

Built by B.Shahrom

---

**Polygon Middleman** — Manage competitive programming problems faster. 🚀
