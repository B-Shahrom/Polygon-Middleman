"""Generate PDF editorial for Polygon Middleman project."""

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    HRFlowable, ListFlowable, ListItem, KeepTogether,
)

# ── Colors ──────────────────────────────────────────────────────────────────

DARK_BG = HexColor("#1a1714")
AMBER = HexColor("#f59e0b")
AMBER_DARK = HexColor("#b97a08")
SURFACE = HexColor("#211e1a")
BORDER = HexColor("#362f28")
CODE_BG = HexColor("#f5f5f0")
LIGHT_GRAY = HexColor("#666666")
SECTION_BG = HexColor("#fef3c7")

# ── Styles ──────────────────────────────────────────────────────────────────

styles = getSampleStyleSheet()

styles.add(ParagraphStyle(
    "CoverTitle", parent=styles["Title"],
    fontSize=32, leading=40, textColor=HexColor("#1a1714"),
    alignment=TA_CENTER, spaceAfter=8,
))
styles.add(ParagraphStyle(
    "CoverSub", parent=styles["Normal"],
    fontSize=14, leading=20, textColor=LIGHT_GRAY,
    alignment=TA_CENTER, spaceAfter=4,
))
styles.add(ParagraphStyle(
    "SectionHead", parent=styles["Heading1"],
    fontSize=20, leading=26, textColor=HexColor("#92400e"),
    spaceBefore=24, spaceAfter=10,
    borderWidth=0, borderColor=AMBER, borderPadding=0,
))
styles.add(ParagraphStyle(
    "SubHead", parent=styles["Heading2"],
    fontSize=14, leading=18, textColor=HexColor("#78350f"),
    spaceBefore=14, spaceAfter=6,
))
styles.add(ParagraphStyle(
    "SubHead3", parent=styles["Heading3"],
    fontSize=12, leading=16, textColor=HexColor("#92400e"),
    spaceBefore=10, spaceAfter=4,
))
styles.add(ParagraphStyle(
    "Body", parent=styles["Normal"],
    fontSize=10, leading=15, textColor=HexColor("#1f1f1f"),
    alignment=TA_JUSTIFY, spaceAfter=6,
))
styles.add(ParagraphStyle(
    "CodeBlock", parent=styles["Normal"],
    fontName="Courier", fontSize=8.5, leading=12,
    textColor=HexColor("#1a1714"), backColor=CODE_BG,
    borderWidth=0.5, borderColor=HexColor("#d4d4d4"), borderPadding=6,
    spaceBefore=4, spaceAfter=8,
))
styles.add(ParagraphStyle(
    "CodeInline", parent=styles["Normal"],
    fontName="Courier", fontSize=9.5, textColor=HexColor("#92400e"),
))
styles.add(ParagraphStyle(
    "BulletBody", parent=styles["Normal"],
    fontSize=10, leading=14, textColor=HexColor("#1f1f1f"),
    leftIndent=20, bulletIndent=8, spaceAfter=3,
))
styles.add(ParagraphStyle(
    "TableHeader", parent=styles["Normal"],
    fontName="Helvetica-Bold", fontSize=9, leading=12,
    textColor=white, alignment=TA_CENTER,
))
styles.add(ParagraphStyle(
    "TableCell", parent=styles["Normal"],
    fontSize=9, leading=12, alignment=TA_LEFT,
))
styles.add(ParagraphStyle(
    "Callout", parent=styles["Normal"],
    fontSize=10, leading=14, textColor=HexColor("#78350f"),
    backColor=SECTION_BG, borderWidth=0.5, borderColor=AMBER,
    borderPadding=8, spaceBefore=6, spaceAfter=8,
))
styles.add(ParagraphStyle(
    "FooterStyle", parent=styles["Normal"],
    fontSize=8, textColor=LIGHT_GRAY, alignment=TA_CENTER,
))
styles.add(ParagraphStyle(
    "TOCEntry", parent=styles["Normal"],
    fontSize=11, leading=18, textColor=HexColor("#1a1714"),
    leftIndent=12, spaceAfter=2,
))
styles.add(ParagraphStyle(
    "TOCSub", parent=styles["Normal"],
    fontSize=10, leading=16, textColor=LIGHT_GRAY,
    leftIndent=30, spaceAfter=1,
))

# ── Helpers ─────────────────────────────────────────────────────────────────

def hr():
    return HRFlowable(width="100%", thickness=0.5, color=BORDER, spaceAfter=8, spaceBefore=4)

def bullet_list(items):
    return [Paragraph(f"<bullet>&bull;</bullet> {item}", styles["BulletBody"]) for item in items]

def code_block(text):
    escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return Paragraph(escaped.replace("\n", "<br/>"), styles["CodeBlock"])

def callout(text):
    return Paragraph(text, styles["Callout"])

def make_table(headers, rows, col_widths=None):
    data = [[Paragraph(h, styles["TableHeader"]) for h in headers]]
    for row in rows:
        data.append([Paragraph(str(c), styles["TableCell"]) for c in row])
    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HexColor("#92400e")),
        ("TEXTCOLOR", (0, 0), (-1, 0), white),
        ("ALIGN", (0, 0), (-1, 0), "CENTER"),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 8),
        ("TOPPADDING", (0, 0), (-1, 0), 8),
        ("BACKGROUND", (0, 1), (-1, -1), white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, HexColor("#fef9ee")]),
        ("GRID", (0, 0), (-1, -1), 0.5, HexColor("#d4c4a8")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 1), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 5),
    ]))
    return t

# ── Build Document ──────────────────────────────────────────────────────────

doc = SimpleDocTemplate(
    "Polygon_Middleman_Documentation.pdf",
    pagesize=letter,
    leftMargin=0.85 * inch,
    rightMargin=0.85 * inch,
    topMargin=0.75 * inch,
    bottomMargin=0.75 * inch,
)

story = []

# ────────────────── COVER PAGE ──────────────────

story.append(Spacer(1, 1.8 * inch))
story.append(Paragraph("Polygon Middleman", styles["CoverTitle"]))
story.append(Spacer(1, 6))
story.append(Paragraph("Developer Documentation", styles["CoverSub"]))
story.append(Spacer(1, 16))
story.append(HRFlowable(width="40%", thickness=2, color=AMBER, spaceAfter=16))
story.append(Paragraph("A full-featured desktop web application for managing<br/>Codeforces Polygon problems via the Polygon API", styles["CoverSub"]))
story.append(Spacer(1, 40))
story.append(Paragraph("Version 1.0 &mdash; April 2026", styles["CoverSub"]))
story.append(Paragraph("Stack: Python FastAPI + React 18 + TypeScript + Tailwind CSS", styles["CoverSub"]))

story.append(PageBreak())

# ────────────────── TABLE OF CONTENTS ──────────────────

story.append(Paragraph("Table of Contents", styles["SectionHead"]))
story.append(hr())
toc_sections = [
    ("1.", "Project Overview"),
    ("2.", "Architecture"),
    ("3.", "Getting Started"),
    ("4.", "Backend Deep Dive"),
    ("5.", "Frontend Deep Dive"),
    ("6.", "Upload Wizard (8-Step Flow)"),
    ("7.", "Polygon API Coverage"),
    ("8.", "Key Features &amp; Implementation Notes"),
    ("9.", "Theme &amp; Design System"),
    ("10.", "File Structure Reference"),
]
for num, title in toc_sections:
    story.append(Paragraph(f"<b>{num}</b>&nbsp;&nbsp;{title}", styles["TOCEntry"]))
story.append(PageBreak())

# ────────────────── 1. PROJECT OVERVIEW ──────────────────

story.append(Paragraph("1. Project Overview", styles["SectionHead"]))
story.append(hr())
story.append(Paragraph(
    "Polygon Middleman is a desktop web application that provides a modern, "
    "user-friendly interface for uploading and managing competitive programming problems "
    "on Codeforces Polygon. Instead of manually navigating Polygon's web UI for each "
    "field, this tool lets you manage everything from a single dashboard &mdash; "
    "statements, tests, solutions, checkers, validators, packages, and more.",
    styles["Body"],
))
story.append(Paragraph(
    "The app runs locally: a Python FastAPI backend acts as a secure proxy that handles "
    "Polygon's SHA-512 API authentication, while a React + TypeScript frontend provides "
    "the UI. Credentials never leave your machine.",
    styles["Body"],
))
story.append(Paragraph("Why this exists:", styles["SubHead"]))
story.extend(bullet_list([
    "<b>Speed</b> &mdash; Batch-upload tests from ZIP/folders, paste solutions, set groups/points inline.",
    "<b>Safety</b> &mdash; API signing is handled server-side; no secrets in the browser.",
    "<b>Completeness</b> &mdash; Every Polygon API method is implemented (30+ endpoints).",
    "<b>Workflow</b> &mdash; An 8-step Upload Wizard guides you from problem creation to commit.",
]))
story.append(Spacer(1, 8))

# ────────────────── 2. ARCHITECTURE ──────────────────

story.append(Paragraph("2. Architecture", styles["SectionHead"]))
story.append(hr())

story.append(Paragraph("High-Level Data Flow", styles["SubHead"]))
story.append(code_block(
    "Browser (React)  --HTTP-->  FastAPI Proxy (:8000)  --HTTPS-->  Polygon API\n"
    "   port 5173                   signs requests              polygon.codeforces.com\n"
    "                              with SHA-512"
))
story.append(Paragraph(
    "The frontend never talks to Polygon directly. Every API call goes through the "
    "FastAPI proxy, which attaches the <font name='Courier'>apiKey</font>, "
    "<font name='Courier'>time</font>, and <font name='Courier'>apiSig</font> "
    "(SHA-512 HMAC) before forwarding.",
    styles["Body"],
))

story.append(Paragraph("Backend (Python)", styles["SubHead"]))
story.extend(bullet_list([
    "<b>FastAPI</b> &mdash; async web framework, handles CORS, form parsing, file uploads.",
    "<b>polygon_api.py</b> &mdash; core signing module. Builds the signature string as "
    "<font name='Courier'>rand/method?sorted_params#secret</font>, hashes with SHA-512.",
    "<b>config.json</b> &mdash; stores API key and secret locally (never committed to git).",
    "<b>httpx</b> &mdash; async HTTP client for non-file requests.",
    "<b>requests</b> &mdash; sync HTTP client for multipart file uploads (file content is included in signature).",
]))

story.append(Paragraph("Frontend (TypeScript)", styles["SubHead"]))
story.extend(bullet_list([
    "<b>React 18</b> with functional components and hooks.",
    "<b>Vite</b> &mdash; fast dev server with HMR at port 5173.",
    "<b>Tailwind CSS</b> &mdash; utility-first styling with custom 'Sunset Ember' theme.",
    "<b>React Router v6</b> &mdash; SPA routing (Problems list, Problem detail, Settings).",
    "<b>Lucide React</b> &mdash; icon library.",
    "<b>JSZip</b> &mdash; client-side ZIP parsing for batch test upload.",
]))

story.append(PageBreak())

# ────────────────── 3. GETTING STARTED ──────────────────

story.append(Paragraph("3. Getting Started", styles["SectionHead"]))
story.append(hr())

story.append(Paragraph("Prerequisites", styles["SubHead"]))
story.extend(bullet_list([
    "Python 3.10+ with pip",
    "Node.js 18+ with npm",
    "A Polygon API key and secret (from polygon.codeforces.com &rarr; API keys)",
]))

story.append(Paragraph("Setup", styles["SubHead"]))
story.append(Paragraph("<b>Backend:</b>", styles["Body"]))
story.append(code_block(
    "cd backend\n"
    "python -m venv venv\n"
    "venv\\Scripts\\activate        # Windows\n"
    "# source venv/bin/activate   # macOS/Linux\n"
    "pip install -r requirements.txt"
))
story.append(Paragraph("<b>Frontend:</b>", styles["Body"]))
story.append(code_block(
    "cd frontend\n"
    "npm install"
))

story.append(Paragraph("Running", styles["SubHead"]))
story.append(Paragraph(
    "Use the provided batch files, or start each service manually:",
    styles["Body"],
))
story.append(code_block(
    "# Terminal 1 &mdash; Backend\n"
    "cd backend && uvicorn main:app --reload --port 8000\n\n"
    "# Terminal 2 &mdash; Frontend\n"
    "cd frontend && npm run dev"
))
story.append(Paragraph(
    "Or simply run <font name='Courier'>start.bat</font> (Windows) to launch both.",
    styles["Body"],
))

story.append(Paragraph("First Use", styles["SubHead"]))
story.extend(bullet_list([
    "Open <font name='Courier'>http://localhost:5173</font> in your browser.",
    "Go to <b>Settings</b> and enter your Polygon API key, secret, and username.",
    "Return to <b>Problems</b> &mdash; your problem list loads automatically.",
    "Click any problem to manage it, or use the <b>Upload Wizard</b> for a guided flow.",
]))

story.append(PageBreak())

# ────────────────── 4. BACKEND DEEP DIVE ──────────────────

story.append(Paragraph("4. Backend Deep Dive", styles["SectionHead"]))
story.append(hr())

story.append(Paragraph("API Signature (polygon_api.py)", styles["SubHead"]))
story.append(Paragraph(
    "Polygon requires every request to be signed. The signature is computed as:",
    styles["Body"],
))
story.append(code_block(
    "hash_input = f\"{rand_6_chars}/{method}?{sorted_key=value_pairs}#{secret}\"\n"
    "apiSig = rand_6_chars + sha512(hash_input.encode('utf-8')).hexdigest()"
))
story.append(callout(
    "<b>Critical:</b> For file uploads, the file content (decoded as UTF-8) is included "
    "in the params dict <i>before</i> computing the signature. All params are then sent via "
    "<font name='Courier'>requests.post(url, files=all_parts)</font> &mdash; matching the "
    "approach used by the official polygon-cli tool."
))

story.append(Paragraph("Proxy Pattern (main.py)", styles["SubHead"]))
story.append(Paragraph(
    "Every endpoint in <font name='Courier'>main.py</font> follows the same pattern:",
    styles["Body"],
))
story.append(code_block(
    "@app.post(\"/api/problem.saveSolution\")\n"
    "async def problem_save_solution(problemId: int = Form(...), ...):\n"
    "    params = {\"problemId\": problemId, ...}\n"
    "    content = await file.read()\n"
    "    return await proxy(method, params, {\"file\": (name, content, mime)})"
))
story.append(Paragraph(
    "The <font name='Courier'>proxy()</font> function loads credentials, calls "
    "<font name='Courier'>call_polygon()</font>, and returns the raw Polygon response. "
    "Structured logging with timestamps and emoji indicators makes debugging easy.",
    styles["Body"],
))

story.append(Paragraph("Logging Format", styles["SubHead"]))
story.append(code_block(
    "=> [14:23:01] problem.saveSolution\n"
    "   params: problemId=523063, name=sol.cpp  | files: file (sol.cpp)\n"
    "OK [14:23:02] problem.saveSolution -> OK"
))

story.append(PageBreak())

# ────────────────── 5. FRONTEND DEEP DIVE ──────────────────

story.append(Paragraph("5. Frontend Deep Dive", styles["SectionHead"]))
story.append(hr())

story.append(Paragraph("Routing &amp; Pages", styles["SubHead"]))
story.append(make_table(
    ["Route", "Component", "Description"],
    [
        ["/", "ProblemsPage", "Problem list with search, filter, create"],
        ["/problem/:id", "ProblemPage", "Problem detail with 10 tabbed sections"],
        ["/settings", "SettingsPage", "API credentials configuration"],
        ["/wizard", "UploadWizard", "8-step guided problem upload"],
    ],
    col_widths=[1.6 * inch, 1.5 * inch, 3.2 * inch],
))

story.append(Paragraph("ProblemPage Tabs", styles["SubHead"]))
story.append(make_table(
    ["Tab", "File", "Key Features"],
    [
        ["Info", "InfoTab.tsx", "Time/memory limits, I/O files, interactive toggle"],
        ["Statement", "StatementTab.tsx", "LaTeX editor, Parse/Convert tool, View HTML preview"],
        ["Checker/Validator", "CheckerValidatorTab.tsx", "Standard checkers dropdown, custom file upload"],
        ["Solutions", "SolutionsTab.tsx", "Upload/paste/view/delete, 12 tag types"],
        ["Tests", "TestsTab.tsx", "Add/edit/ZIP upload, inline group/points, bulk ops"],
        ["Files", "FilesTab.tsx", "Source/resource/aux file management"],
        ["Script", "ScriptTab.tsx", "Generator script editor"],
        ["Packages", "PackagesTab.tsx", "Build &amp; download packages"],
        ["Tutorial", "TutorialTab.tsx", "General description &amp; tutorial editor"],
    ],
    col_widths=[1.2 * inch, 1.8 * inch, 3.3 * inch],
))

story.append(Paragraph("API Client (api/client.ts)", styles["SubHead"]))
story.append(Paragraph(
    "A typed client module wraps all backend endpoints. It uses "
    "<font name='Courier'>fetch()</font> with three helpers: "
    "<font name='Courier'>get()</font> for query-string requests, "
    "<font name='Courier'>post()</font> for JSON bodies, and "
    "<font name='Courier'>postForm()</font> for multipart file uploads. "
    "All responses go through <font name='Courier'>handleResponse()</font> which "
    "parses JSON, detects Polygon FAILED status, and throws typed "
    "<font name='Courier'>ApiError</font> exceptions.",
    styles["Body"],
))

story.append(Paragraph("UI Component Library", styles["SubHead"]))
story.append(Paragraph(
    "Reusable components live in <font name='Courier'>components/ui/</font>:",
    styles["Body"],
))
story.extend(bullet_list([
    "<b>Button</b> &mdash; primary/secondary/ghost/danger variants, loading state, icon support.",
    "<b>Card</b> &mdash; titled container with optional action buttons in header.",
    "<b>Modal</b> &mdash; animated overlay with customizable footer.",
    "<b>Input / Select / Textarea</b> &mdash; styled form controls with labels and helpers.",
    "<b>Badge</b> &mdash; status indicators, solution tag badges (MA, OK, RJ, etc.).",
    "<b>ToastContainer</b> &mdash; success/error/warning notifications.",
    "<b>Tabs</b> &mdash; horizontal tab navigation with lazy-mounting.",
]))

story.append(PageBreak())

# ────────────────── 6. UPLOAD WIZARD ──────────────────

story.append(Paragraph("6. Upload Wizard (8-Step Flow)", styles["SectionHead"]))
story.append(hr())
story.append(Paragraph(
    "The Upload Wizard (<font name='Courier'>wizard/UploadWizard.tsx</font>) guides users "
    "through creating and fully configuring a problem in one session:",
    styles["Body"],
))

wizard_steps = [
    ["1. Select/Create", "Choose an existing problem or create a new one by name."],
    ["2. Problem Info", "Set time limit, memory limit, I/O files, interactive flag."],
    ["3. Statement", "Fill in all LaTeX sections: legend, input, output, scoring, notes."],
    ["4. Checker", "Select a standard checker (wcmp, fcmp, etc.) or upload a custom .cpp file."],
    ["5. Validator", "Upload a custom validator (optional)."],
    ["6. Solutions", "Upload solution files with tags (MA, OK, RJ, TL, WA, etc.)."],
    ["7. Tests", "Batch upload from ZIP with auto-parsed groups and indices."],
    ["8. Review &amp; Commit", "Review all settings and commit changes to Polygon."],
]
story.append(make_table(
    ["Step", "Description"],
    wizard_steps,
    col_widths=[1.5 * inch, 4.8 * inch],
))

story.append(Spacer(1, 12))

# ────────────────── 7. API COVERAGE ──────────────────

story.append(Paragraph("7. Polygon API Coverage", styles["SectionHead"]))
story.append(hr())
story.append(Paragraph(
    "All Polygon API methods are implemented in the backend proxy. Here's the complete mapping:",
    styles["Body"],
))

api_methods = [
    ["Problems", "problems.list, problem.create"],
    ["Problem Config", "problem.info, updateInfo, commitChanges, updateWorkingCopy, discardWorkingCopy"],
    ["Statements", "problem.statements, saveStatement, statementResources, saveStatementResource"],
    ["Files", "problem.files, saveFile, viewFile"],
    ["Solutions", "problem.solutions, saveSolution, viewSolution, editSolutionExtraTags"],
    ["Tests", "problem.tests, saveTest, testInput, testAnswer, setTestGroup, enableGroups, enablePoints"],
    ["Test Groups", "problem.viewTestGroup, saveTestGroup"],
    ["Checker/Validator", "problem.checker, validator, interactor, setChecker, setValidator, setInteractor"],
    ["CV Tests", "problem.validatorTests, checkerTests, saveValidatorTest, saveCheckerTest"],
    ["Script", "problem.script, saveScript"],
    ["Tags", "problem.viewTags, saveTags"],
    ["Tutorial", "problem.viewGeneralDescription, viewGeneralTutorial, saveGeneralDescription, saveGeneralTutorial"],
    ["Packages", "problem.packages, buildPackage, package (download)"],
    ["Contest", "contest.problems"],
]
story.append(make_table(
    ["Category", "Methods"],
    api_methods,
    col_widths=[1.5 * inch, 4.8 * inch],
))

story.append(PageBreak())

# ────────────────── 8. KEY FEATURES ──────────────────

story.append(Paragraph("8. Key Features &amp; Implementation Notes", styles["SectionHead"]))
story.append(hr())

story.append(Paragraph("ZIP Test Upload with Auto-Parsing", styles["SubHead"]))
story.append(Paragraph(
    "Tests can be uploaded from ZIP files, individual files, or folders. The parser:",
    styles["Body"],
))
story.extend(bullet_list([
    "Extracts group numbers from filenames: <font name='Courier'>input_s2_003.txt</font> &rarr; group 2",
    "Extracts test indices: <font name='Courier'>test-001.txt</font> &rarr; index 1",
    "Skips answer/output files automatically",
    "Re-numbers tests sequentially starting after existing tests",
    "Auto-sets <font name='Courier'>useInStatements=true</font> for group 0 (sample tests)",
    "Detects duplicate test content and reports skipped tests with a warning toast",
]))

story.append(Paragraph("Inline Test Editing", styles["SubHead"]))
story.append(Paragraph(
    "Group and points columns in the test table support click-to-edit. Changes are saved "
    "to Polygon immediately and update local state without a full reload.",
    styles["Body"],
))

story.append(Paragraph("Test Groups &amp; Subtask Management", styles["SubHead"]))
story.extend(bullet_list([
    "Groups and points are <b>auto-enabled</b> on Polygon when the Tests tab loads.",
    "Points policy is auto-corrected to <b>COMPLETE_GROUP</b> when loading groups.",
    "<b>Derive Dependencies</b> &mdash; parses the Scoring section of the statement to auto-fill group dependencies from a LaTeX tabular or plain text format.",
    "<b>Derive Points</b> &mdash; parses the Scoring section to extract group &rarr; points mapping and sets points on the first test of each group.",
]))

story.append(Paragraph("Statement HTML Preview", styles["SubHead"]))
story.append(Paragraph(
    "The <b>View HTML</b> button in the Statement tab converts the LaTeX statement into "
    "a styled HTML page with MathJax rendering, opens it in a new tab. If sample tests "
    "(group 0) exist, they are included. If a main correct solution (MA) is uploaded, "
    "sample outputs are fetched and displayed alongside inputs.",
    styles["Body"],
))

story.append(Paragraph("File Upload Signing", styles["SubHead"]))
story.append(callout(
    "File uploads (solutions, checker, images) include file content in the SHA-512 signature "
    "hash and send all parameters via <font name='Courier'>files=</font> in the multipart "
    "request. This matches the polygon-cli approach and is <i>required</i> for Polygon to "
    "accept the signature."
))

story.append(Paragraph("Solution Management", styles["SubHead"]))
story.extend(bullet_list([
    "Upload via file picker or paste code directly with filename.",
    "12 tag types matching Polygon's dropdown: MA, OK, RJ, TL, TO, TM, WA, PE, ML, RE, NR, FL.",
    "View solution source in a modal.",
    "Delete by overwriting with an empty file (Polygon has no native delete endpoint).",
    "11 standard checkers matching Polygon: fcmp, hcmp, lcmp, ncmp, nyesno, rcmp4/6/9, wcmp, yesno.",
]))

story.append(PageBreak())

# ────────────────── 9. THEME ──────────────────

story.append(Paragraph("9. Theme &amp; Design System", styles["SectionHead"]))
story.append(hr())
story.append(Paragraph(
    "The app uses a custom <b>Sunset Ember</b> dark theme with warm tones:",
    styles["Body"],
))

theme_colors = [
    ["Background (#110f0d)", "Main page background"],
    ["Surface (#1e1b17)", "Card and panel backgrounds"],
    ["Deep surface (#1a1714)", "Input fields, dropdowns"],
    ["Border (#362f28)", "Dividers, outlines"],
    ["Accent (#f59e0b)", "Primary amber accent for actions, highlights"],
    ["Accent hover (#fbbf24)", "Lighter amber for hover states"],
    ["Accent muted (#4a3520)", "Subtle amber backgrounds"],
]
story.append(make_table(
    ["Token", "Usage"],
    theme_colors,
    col_widths=[2.5 * inch, 3.8 * inch],
))

story.append(Spacer(1, 8))
story.append(Paragraph("Typography &amp; Animations", styles["SubHead"]))
story.extend(bullet_list([
    "<b>Inter</b> for UI text, <b>JetBrains Mono</b> for code and monospace fields.",
    "CSS animations: fadeInUp, fadeIn, scaleIn, slideInLeft, slideUp, stagger-children.",
    "Active button scale effect: <font name='Courier'>active:scale-[0.97]</font>.",
    "Amber scrollbar and focus ring styling.",
]))

story.append(Spacer(1, 12))

# ────────────────── 10. FILE STRUCTURE ──────────────────

story.append(Paragraph("10. File Structure Reference", styles["SectionHead"]))
story.append(hr())

story.append(Paragraph("Backend", styles["SubHead"]))
story.append(code_block(
    "backend/\n"
    "  main.py              # FastAPI app, all proxy endpoints, logging\n"
    "  polygon_api.py       # SHA-512 signing, call_polygon()\n"
    "  config.json          # API key &amp; secret (gitignored)\n"
    "  requirements.txt     # Python dependencies"
))

story.append(Paragraph("Frontend", styles["SubHead"]))
story.append(code_block(
    "frontend/src/\n"
    "  App.tsx              # Router setup\n"
    "  api/client.ts        # Typed API client (get/post/postForm)\n"
    "  context/AppContext.tsx  # Global state (problems, toasts)\n"
    "  types/polygon.ts     # TypeScript interfaces\n"
    "  pages/\n"
    "    ProblemsPage.tsx    # Problem list + search\n"
    "    ProblemPage.tsx     # Problem detail (10 tabs)\n"
    "    SettingsPage.tsx    # Credentials config\n"
    "  tabs/\n"
    "    InfoTab.tsx, StatementTab.tsx, CheckerValidatorTab.tsx,\n"
    "    SolutionsTab.tsx, TestsTab.tsx, FilesTab.tsx,\n"
    "    ScriptTab.tsx, PackagesTab.tsx, TutorialTab.tsx\n"
    "  wizard/\n"
    "    UploadWizard.tsx    # 8-step guided upload\n"
    "  components/\n"
    "    Sidebar.tsx         # Navigation sidebar\n"
    "    ui/                 # Button, Card, Modal, Input, Badge, etc."
))

story.append(Paragraph("Startup Scripts", styles["SubHead"]))
story.extend(bullet_list([
    "<font name='Courier'>start.bat</font> &mdash; launches both backend and frontend.",
    "<font name='Courier'>start_backend.bat</font> &mdash; backend only.",
    "<font name='Courier'>start_frontend.bat</font> &mdash; frontend only.",
]))

story.append(Spacer(1, 24))
story.append(HRFlowable(width="60%", thickness=1, color=AMBER, spaceAfter=12))
story.append(Paragraph(
    "Polygon Middleman &mdash; Built with FastAPI + React + TypeScript",
    styles["FooterStyle"],
))

# ── Generate PDF ────────────────────────────────────────────────────────────

doc.build(story)
print("Generated: Polygon_Middleman_Documentation.pdf")
