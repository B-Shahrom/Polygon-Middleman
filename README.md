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

### Setup

**Backend:**
```bash
cd backend
python -m venv venv
venv\Scripts\activate        # Windows
pip install -r requirements.txt
```

**Frontend:**
```bash
cd frontend
npm install
```

### Running

```bash
# Windows
start.bat

# Or manually:
# Terminal 1
cd backend && uvicorn main:app --reload --port 8000

# Terminal 2
cd frontend && npm run dev
```

Then open [http://localhost:5173](http://localhost:5173)

### First Use

1. Go to **Settings** and enter your Polygon API credentials
2. Return to **Problems** — list loads automatically
3. Use **Import ZIP** for one-click batch import, **Upload Wizard** for a guided flow, or click a problem to manage it

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
edu-problem-name/
├── problem_statement.mdx   # 4-language statement (\textbf{English} … markers)
├── checker.cpp
├── solution.cpp
└── testset/                # also accepts the "tesset/" spelling
    ├── input_s0_idx0.txt    # group 0 = samples (useInStatements)
    ├── input_s1_idx0.txt    # group N from the _sN_ in the filename
    └── ...
```

For every problem the importer runs an isolated pipeline:

1. Creates the problem using the **full folder name as the slug** (the `edu-` prefix is kept)
2. Sets defaults — 1000 ms time limit, 256 MB memory, `stdin`/`stdout`
3. Saves a statement per detected language
4. Uploads `checker.cpp` and sets it as the checker
5. Uploads `solution.cpp` tagged `MA` (main correct)
6. Enables groups and points, then uploads grouped tests
7. Sets every group's points policy to `COMPLETE_GROUP`, makes the **last group depend on all other groups**, and — if the statement has no scoring section — assigns **100 points** to the last group
8. **Commits** the changes and requests **verification** via `buildPackage(verify=true)`, which invokes every solution on every test (and the checker on stress tests) to confirm the tags are valid

> The commit is required because the Polygon API can only verify a *committed* revision — the web UI's working-copy "Verify" button is not exposed as an API method.

Imports are **fault-isolated**: a failing step is logged in red and the pipeline continues; a failing problem is skipped and the rest of the batch keeps going. A per-problem summary is shown at the end.

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
