# Polygon Middleman

A full-featured desktop web application for uploading and managing competitive programming problems on **Codeforces Polygon** via the Polygon API.

## Features

- **Problem Management**: Create, edit, and manage problems from a single dashboard
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
3. Use **Upload Wizard** or click a problem to manage it

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
│   │   ├── tabs/            # 10 problem detail tabs
│   │   ├── wizard/          # 8-step wizard
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
