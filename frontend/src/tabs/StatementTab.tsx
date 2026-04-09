import { useState, useEffect } from 'react';
import { Save, Plus, Upload, Trash2, FileText, Code2, Eye, Languages } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { Statement, PolygonFile, Solution, Test } from '../types/polygon';
import Button from '../components/ui/Button';
import { Textarea, Select } from '../components/ui/Input';
import { Input } from '../components/ui/Input';
import Card from '../components/ui/Card';
import Modal from '../components/ui/Modal';

// --------------- Parse Statement helpers ---------------

type ParseFormat = 'latex' | 'plain';

interface ParsedSections {
  name: string;
  legend: string;
  input: string;
  output: string;
  scoring: string;
  notes: string;
  interaction: string;
}

function parseLatexStatement(raw: string): ParsedSections {
  const sections: ParsedSections = { name: '', legend: '', input: '', output: '', scoring: '', notes: '', interaction: '' };

  // Normalise line endings
  const text = raw.replace(/\r\n/g, '\n');

  // Build ordered markers — first match wins
  const markers: { key: keyof ParsedSections; re: RegExp }[] = [
    { key: 'input',       re: /\\textbf\{Input(?:\s+format)?\}|\\section\*?\{Input(?:\s+format)?\}|\\InputFile/i },
    { key: 'output',      re: /\\textbf\{Output(?:\s+format)?\}|\\section\*?\{Output(?:\s+format)?\}|\\OutputFile/i },
    { key: 'scoring',     re: /\\textbf\{Scoring\}|\\textbf\{Subtasks\}|\\section\*?\{Scoring\}|\\section\*?\{Subtasks\}|\\Scoring/i },
    { key: 'notes',       re: /\\textbf\{Notes?\}|\\section\*?\{Notes?\}|\\Note/i },
    { key: 'interaction', re: /\\textbf\{Interaction\}|\\section\*?\{Interaction\}/i },
  ];

  // Name marker (optional, at the very top)
  const nameRe = /\\textbf\{Problem Name\}|\\section\*?\{Problem Name\}/i;

  // Legend marker (optional)
  const legendRe = /\\textbf\{(?:Legend|Description)\}|\\section\*?\{(?:Legend|Description)\}/i;

  // Collect all split positions
  interface SplitPoint { pos: number; end: number; key: keyof ParsedSections }
  const splits: SplitPoint[] = [];

  const nameMatch = nameRe.exec(text);
  if (nameMatch) splits.push({ pos: nameMatch.index, end: nameMatch.index + nameMatch[0].length, key: 'name' });

  const legendMatch = legendRe.exec(text);
  if (legendMatch) splits.push({ pos: legendMatch.index, end: legendMatch.index + legendMatch[0].length, key: 'legend' });

  for (const m of markers) {
    const match = m.re.exec(text);
    if (match) splits.push({ pos: match.index, end: match.index + match[0].length, key: m.key });
  }

  // Sort by position
  splits.sort((a, b) => a.pos - b.pos);

  if (splits.length === 0) {
    // No markers found — put everything in legend
    sections.legend = text.trim();
    return sections;
  }

  // Text before the first marker goes to legend (or name if the first marker IS legend)
  const beforeFirst = text.slice(0, splits[0].pos).trim();
  if (beforeFirst) {
    if (splits[0].key === 'name') {
      // nothing before name marker
    } else {
      sections.legend = beforeFirst;
    }
  }

  for (let i = 0; i < splits.length; i++) {
    const endPos = i + 1 < splits.length ? splits[i + 1].pos : text.length;
    const content = text.slice(splits[i].end, endPos).trim();
    sections[splits[i].key] = content;
  }

  // If legend is still empty and we have no legend marker, anything before the first non-name marker is legend
  if (!sections.legend && !legendMatch) {
    const firstNonName = splits.find((s) => s.key !== 'name');
    if (firstNonName) {
      const start = nameMatch ? splits.find((s) => s.key === 'name')!.end : 0;
      const chunk = text.slice(start, firstNonName.pos).trim();
      if (chunk) sections.legend = chunk;
    }
  }

  return sections;
}

function parsePlainTextStatement(raw: string): ParsedSections {
  const sections: ParsedSections = { name: '', legend: '', input: '', output: '', scoring: '', notes: '', interaction: '' };
  const text = raw.replace(/\r\n/g, '\n');

  const markers: { key: keyof ParsedSections; re: RegExp }[] = [
    { key: 'input',       re: /^(?:Input(?:\s+Format)?)\s*:?\s*$/im },
    { key: 'output',      re: /^(?:Output(?:\s+Format)?)\s*:?\s*$/im },
    { key: 'scoring',     re: /^(?:Scoring|Subtasks)\s*:?\s*$/im },
    { key: 'notes',       re: /^(?:Notes?|Examples?)\s*:?\s*$/im },
    { key: 'interaction', re: /^Interaction\s*:?\s*$/im },
  ];

  interface SplitPoint { pos: number; end: number; key: keyof ParsedSections }
  const splits: SplitPoint[] = [];

  for (const m of markers) {
    const match = m.re.exec(text);
    if (match) splits.push({ pos: match.index, end: match.index + match[0].length, key: m.key });
  }

  splits.sort((a, b) => a.pos - b.pos);

  if (splits.length === 0) {
    sections.legend = text.trim();
    return sections;
  }

  // Everything before the first marker: first line → name, rest → legend
  const before = text.slice(0, splits[0].pos).trim();
  if (before) {
    const lines = before.split('\n');
    sections.name = lines[0].trim();
    if (lines.length > 1) sections.legend = lines.slice(1).join('\n').trim();
  }

  for (let i = 0; i < splits.length; i++) {
    const endPos = i + 1 < splits.length ? splits[i + 1].pos : text.length;
    sections[splits[i].key] = text.slice(splits[i].end, endPos).trim();
  }

  return sections;
}

// --------------- MDX → LaTeX converter ---------------

function convertMdxToLatex(mdx: string): string {
  const lines = mdx.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Headings
    if (/^## (.+)/.test(line)) {
      const m = line.match(/^## (.+)/)!;
      out.push(`\\subsection*{${m[1].trim()}}`);
      i++;
      continue;
    }
    if (/^# (.+)/.test(line)) {
      const m = line.match(/^# (.+)/)!;
      out.push(`\\section*{${m[1].trim()}}`);
      i++;
      continue;
    }

    // Unordered list (consecutive - items)
    if (/^- (.+)/.test(line)) {
      out.push('\\begin{itemize}');
      while (i < lines.length && /^- (.+)/.test(lines[i])) {
        const m = lines[i].match(/^- (.+)/)!;
        out.push(`\\item ${convertInline(m[1])}`);
        i++;
      }
      out.push('\\end{itemize}');
      continue;
    }

    // Ordered list (consecutive 1. items)
    if (/^\d+\.\s+(.+)/.test(line)) {
      out.push('\\begin{enumerate}');
      while (i < lines.length && /^\d+\.\s+(.+)/.test(lines[i])) {
        const m = lines[i].match(/^\d+\.\s+(.+)/)!;
        out.push(`\\item ${convertInline(m[1])}`);
        i++;
      }
      out.push('\\end{enumerate}');
      continue;
    }

    // Blank line → paragraph break
    if (line.trim() === '') {
      out.push('');
      i++;
      continue;
    }

    // Normal line — convert inline formatting
    out.push(convertInline(line));
    i++;
  }

  return out.join('\n');
}

function convertInline(text: string): string {
  let result = text;
  // Bold **...**  (before italic)
  result = result.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}');
  // Italic *...*
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '\\textit{$1}');
  // Inline code `...` (but not $$ or $)
  result = result.replace(/`([^`]+)`/g, '\\texttt{$1}');
  // $$ and $ math are kept as-is — no transformation needed
  return result;
}

// --------------- LaTeX → HTML converter ---------------

function latexToHtml(tex: string): string {
  let html = tex;
  // Escape HTML entities first
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Display math $$...$$ → <div class="math">...</div>
  html = html.replace(/\$\$(.+?)\$\$/gs, '<div class="math">$$$$1$$</div>');
  // Inline math $...$ → <span class="math">...</span>
  html = html.replace(/\$(.+?)\$/g, '<span class="math">$$$1$$</span>');

  // \textbf{...} → <strong>
  html = html.replace(/\\textbf\{([^}]+)\}/g, '<strong>$1</strong>');
  // \textit{...} → <em>
  html = html.replace(/\\textit\{([^}]+)\}/g, '<em>$1</em>');
  // \texttt{...} → <code>
  html = html.replace(/\\texttt\{([^}]+)\}/g, '<code>$1</code>');
  // \emph{...} → <em>
  html = html.replace(/\\emph\{([^}]+)\}/g, '<em>$1</em>');

  // \section*{...} / \subsection*{...}
  html = html.replace(/\\section\*?\{([^}]+)\}/g, '<h2>$1</h2>');
  html = html.replace(/\\subsection\*?\{([^}]+)\}/g, '<h3>$1</h3>');

  // \begin{itemize}...\end{itemize}
  html = html.replace(/\\begin\{itemize\}/g, '<ul>');
  html = html.replace(/\\end\{itemize\}/g, '</ul>');
  html = html.replace(/\\begin\{enumerate\}/g, '<ol>');
  html = html.replace(/\\end\{enumerate\}/g, '</ol>');
  html = html.replace(/\\item\s*/g, '<li>');

  // \begin{center}...\end{center}
  html = html.replace(/\\begin\{center\}/g, '<div style="text-align:center">');
  html = html.replace(/\\end\{center\}/g, '</div>');

  // LaTeX tabular → HTML table (basic)
  html = html.replace(/\\begin\{tabular\}\{[^}]*\}/g, '<table class="subtask-table">');
  html = html.replace(/\\end\{tabular\}/g, '</table>');
  html = html.replace(/\\hline/g, '');

  // Convert tabular rows: "cell & cell & cell \\" → <tr><td>...</td>...</tr>
  html = html.replace(/^(.+?)\\\\$/gm, (_, row: string) => {
    if (row.includes('&amp;')) {
      const cells = row.split('&amp;').map((c: string) => `<td>${c.trim()}</td>`);
      return `<tr>${cells.join('')}</tr>`;
    }
    return row;
  });

  // \le, \ge, \ne, \ldots
  html = html.replace(/\\le\b/g, '≤');
  html = html.replace(/\\ge\b/g, '≥');
  html = html.replace(/\\ne\b/g, '≠');
  html = html.replace(/\\ldots/g, '…');
  html = html.replace(/\\cdots/g, '⋯');
  html = html.replace(/\\times/g, '×');
  html = html.replace(/\\cdot/g, '·');

  // \\ → <br> (remaining line breaks)
  html = html.replace(/\\\\/g, '<br>');
  // Double newlines → paragraph breaks
  html = html.replace(/\n\n+/g, '</p><p>');
  // Wrap in paragraph
  html = '<p>' + html + '</p>';
  // Clean empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');

  // Remove remaining LaTeX commands we don't handle
  html = html.replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1');
  html = html.replace(/\\[a-zA-Z]+/g, '');

  return html;
}

function buildStatementHtml(
  stmt: Statement,
  problemName: string,
  timeLimit: string,
  memoryLimit: string,
  samples: { input: string; output: string }[],
): string {
  const sections: string[] = [];

  if (stmt.legend) {
    sections.push(`<div class="section">${latexToHtml(stmt.legend)}</div>`);
  }
  if (stmt.input) {
    sections.push(`<div class="section"><h3>Input</h3>${latexToHtml(stmt.input)}</div>`);
  }
  if (stmt.output) {
    sections.push(`<div class="section"><h3>Output</h3>${latexToHtml(stmt.output)}</div>`);
  }
  if (stmt.scoring) {
    sections.push(`<div class="section"><h3>Scoring</h3>${latexToHtml(stmt.scoring)}</div>`);
  }
  if (stmt.interaction) {
    sections.push(`<div class="section"><h3>Interaction</h3>${latexToHtml(stmt.interaction)}</div>`);
  }
  if (samples.length > 0) {
    let samplesHtml = '<div class="section"><h3>Examples</h3>';
    samples.forEach((s, i) => {
      samplesHtml += `
        <div class="example">
          <div class="example-header">Example ${samples.length > 1 ? i + 1 : ''}</div>
          <div class="example-grid">
            <div class="example-col">
              <div class="example-label">Input</div>
              <pre class="example-data">${s.input.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
            </div>
            <div class="example-col">
              <div class="example-label">Output</div>
              <pre class="example-data">${s.output.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
            </div>
          </div>
        </div>`;
    });
    samplesHtml += '</div>';
    sections.push(samplesHtml);
  }
  if (stmt.notes) {
    sections.push(`<div class="section"><h3>Note</h3>${latexToHtml(stmt.notes)}</div>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${(stmt.name || problemName).replace(/</g, '&lt;')}</title>
<script>window.MathJax={tex:{inlineMath:[['$','$'],['\\\\(','\\\\)']],displayMath:[['$$','$$'],['\\\\[','\\\\]']]},svg:{fontCache:'global'}}</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js" async></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 2rem; line-height: 1.7; }
  .container { max-width: 800px; margin: 0 auto; }
  .header { border-bottom: 2px solid #f59e0b; padding-bottom: 1rem; margin-bottom: 2rem; }
  .header h1 { font-size: 1.5rem; color: #f59e0b; margin-bottom: 0.5rem; }
  .limits { font-size: 0.85rem; color: #888; }
  .limits span { margin-right: 1.5rem; }
  .section { margin-bottom: 1.5rem; }
  .section h2 { color: #f59e0b; font-size: 1.2rem; margin-bottom: 0.5rem; border-bottom: 1px solid #333; padding-bottom: 0.3rem; }
  .section h3 { color: #fbbf24; font-size: 1rem; margin-bottom: 0.5rem; }
  p { margin-bottom: 0.8rem; }
  code { background: #2a2a4a; padding: 0.15rem 0.4rem; border-radius: 3px; font-family: 'JetBrains Mono', monospace; font-size: 0.9em; }
  strong { color: #fff; }
  table.subtask-table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  table.subtask-table td, table.subtask-table th { border: 1px solid #444; padding: 0.5rem 0.8rem; text-align: center; }
  table.subtask-table tr:nth-child(even) { background: #1e1e3a; }
  .example { margin: 1rem 0; border: 1px solid #333; border-radius: 8px; overflow: hidden; }
  .example-header { background: #2a2a4a; padding: 0.4rem 1rem; font-size: 0.85rem; font-weight: 600; color: #fbbf24; }
  .example-grid { display: grid; grid-template-columns: 1fr 1fr; }
  .example-col { border-right: 1px solid #333; }
  .example-col:last-child { border-right: none; }
  .example-label { background: #222244; padding: 0.3rem 0.8rem; font-size: 0.75rem; text-transform: uppercase; color: #888; font-weight: 600; }
  .example-data { padding: 0.6rem 0.8rem; font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; white-space: pre; min-height: 2rem; background: #16162a; }
  ul, ol { padding-left: 1.5rem; margin: 0.5rem 0; }
  li { margin: 0.3rem 0; }
  .math { overflow-x: auto; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>${(stmt.name || problemName).replace(/</g, '&lt;')}</h1>
    <div class="limits">
      <span>⏱ Time limit: ${timeLimit}ms</span>
      <span>💾 Memory limit: ${memoryLimit}MB</span>
    </div>
  </div>
  ${sections.join('\n')}
</div>
</body>
</html>`;
}

// --------------- Multi-language splitter ---------------

/** Map of display names (as they appear in \textbf{...}) to Polygon language codes */
const LANG_NAME_MAP: Record<string, string> = {
  'english': 'english',
  'russian': 'russian',
  'tajik': 'tajik',
  'uzbek': 'uzbek',
  'arabic': 'arabic',
  'chinese': 'chinese',
  'french': 'french',
  'georgian': 'georgian',
  'hungarian': 'hungarian',
  'japanese': 'japanese',
  'korean': 'korean',
  'persian': 'persian',
  'polish': 'polish',
  'portuguese': 'portuguese',
  'spanish': 'spanish',
  'turkish': 'turkish',
  'ukrainian': 'ukrainian',
  'vietnamese': 'vietnamese',
};

/**
 * Split a multi-language LaTeX block into per-language statements.
 * Expects language markers like \textbf{English}, \textbf{Russian}, etc.
 * Within each language block, parses standard section markers.
 */
function splitMultiLanguage(raw: string): Record<string, ParsedSections> {
  const text = raw.replace(/\r\n/g, '\n');
  const result: Record<string, ParsedSections> = {};

  // Build regex that matches \textbf{LangName} for known languages
  const langNames = Object.keys(LANG_NAME_MAP);
  const langPattern = new RegExp(
    `\\\\textbf\\s*\\{\\s*(${langNames.join('|')})\\s*\\}`,
    'gi'
  );

  // Find all language marker positions
  interface LangPos { code: string; pos: number; end: number }
  const positions: LangPos[] = [];
  let match;
  while ((match = langPattern.exec(text)) !== null) {
    const displayName = match[1].toLowerCase();
    const code = LANG_NAME_MAP[displayName];
    if (code) {
      positions.push({ code, pos: match.index, end: match.index + match[0].length });
    }
  }

  if (positions.length === 0) return result;

  // Extract each language's content and parse its sections
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].end;
    const end = i + 1 < positions.length ? positions[i + 1].pos : text.length;
    const langContent = text.slice(start, end).trim();
    result[positions[i].code] = parseLatexStatement(langContent);
  }

  return result;
}

const LANGUAGES = [
  // Priority languages first
  { value: 'english', label: 'English' },
  { value: 'russian', label: 'Russian' },
  { value: 'tajik', label: 'Tajik' },
  { value: 'uzbek', label: 'Uzbek' },
  // Then the rest alphabetically
  { value: 'arabic', label: 'Arabic' },
  { value: 'chinese', label: 'Chinese' },
  { value: 'french', label: 'French' },
  { value: 'georgian', label: 'Georgian' },
  { value: 'hungarian', label: 'Hungarian' },
  { value: 'japanese', label: 'Japanese' },
  { value: 'korean', label: 'Korean' },
  { value: 'persian', label: 'Persian' },
  { value: 'polish', label: 'Polish' },
  { value: 'portuguese', label: 'Portuguese' },
  { value: 'spanish', label: 'Spanish' },
  { value: 'turkish', label: 'Turkish' },
  { value: 'ukrainian', label: 'Ukrainian' },
  { value: 'vietnamese', label: 'Vietnamese' },
];

const EMPTY_STATEMENT: Statement = {
  encoding: 'UTF-8',
  name: '',
  legend: '',
  input: '',
  output: '',
  scoring: '',
  interaction: '',
  notes: '',
  tutorial: '',
};

interface Props { problemId: number }

export default function StatementTab({ problemId }: Props) {
  const { toast } = useApp();
  const [lang, setLang] = useState('english');
  const [statements, setStatements] = useState<Record<string, Statement>>({});
  const [form, setForm] = useState<Statement>(EMPTY_STATEMENT);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  // Statement resources
  const [resources, setResources] = useState<PolygonFile[]>([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [resFile, setResFile] = useState<File | null>(null);

  // Unified Parse / Convert modal
  const [parseOpen, setParseOpen] = useState(false);
  const [parseRaw, setParseRaw] = useState('');
  const [parseFormat, setParseFormat] = useState<ParseFormat>('latex');
  const [parseMode, setParseMode] = useState<'parse' | 'mdx'>('parse');
  const [mdxOutput, setMdxOutput] = useState('');

  const loadStatements = async () => {
    setLoading(true);
    try {
      const res = await api.problem.statements(problemId) as { result: Record<string, Statement> };
      setStatements(res.result || {});
      if (res.result?.[lang]) setForm(res.result[lang]);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to load statements');
    } finally {
      setLoading(false);
    }
  };

  const loadResources = async () => {
    try {
      const res = await api.problem.statementResources(problemId) as { result: PolygonFile[] };
      setResources(res.result || []);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadStatements();
    loadResources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemId]);

  useEffect(() => {
    setForm(statements[lang] || EMPTY_STATEMENT);
  }, [lang, statements]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.problem.saveStatement({
        problemId,
        lang,
        ...form,
      });
      toast('success', `Statement (${lang}) saved!`);
      await loadStatements();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to save statement');
    } finally {
      setSaving(false);
    }
  };

  const handleUploadResource = async () => {
    if (!resFile) return;
    setUploading(true);
    try {
      await api.problem.saveStatementResource(problemId, resFile.name, resFile);
      toast('success', `${resFile.name} uploaded!`);
      setUploadOpen(false);
      setResFile(null);
      await loadResources();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleParseFill = () => {
    const parsed = parseFormat === 'latex'
      ? parseLatexStatement(parseRaw)
      : parsePlainTextStatement(parseRaw);

    const filled: (keyof ParsedSections)[] = [];
    const keys: (keyof ParsedSections)[] = ['name', 'legend', 'input', 'output', 'scoring', 'notes', 'interaction'];
    for (const k of keys) {
      if (parsed[k]) {
        update(k, parsed[k]);
        filled.push(k);
      }
    }

    setParseOpen(false);
    setParseRaw('');
    toast('success', `Parsed ${filled.length} section${filled.length !== 1 ? 's' : ''}: ${filled.join(', ')}`);
  };

  const handleMdxConvert = () => {
    setMdxOutput(convertMdxToLatex(parseRaw));
  };

  const handleMdxApply = () => {
    update('legend', mdxOutput);
    setParseOpen(false);
    setParseRaw('');
    setMdxOutput('');
    toast('success', 'Converted LaTeX applied to Legend');
  };

  // Split Languages modal
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitRaw, setSplitRaw] = useState('');
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitPreview, setSplitPreview] = useState<Record<string, ParsedSections> | null>(null);

  const handleSplitPreview = () => {
    const parsed = splitMultiLanguage(splitRaw);
    if (Object.keys(parsed).length === 0) {
      toast('error', 'No languages found. Use \\textbf{English}, \\textbf{Russian}, etc. as markers.');
      return;
    }
    setSplitPreview(parsed);
  };

  const handleSplitSave = async () => {
    if (!splitPreview) return;
    setSplitSaving(true);
    let saved = 0;
    const langs = Object.keys(splitPreview);
    for (const langCode of langs) {
      const sections = splitPreview[langCode];
      try {
        await api.problem.saveStatement({
          problemId,
          lang: langCode,
          encoding: 'UTF-8',
          name: sections.name,
          legend: sections.legend,
          input: sections.input,
          output: sections.output,
          scoring: sections.scoring,
          interaction: sections.interaction,
          notes: sections.notes,
        });
        saved++;
      } catch (e: unknown) {
        toast('error', `Failed to save ${langCode}: ${e instanceof Error ? e.message : 'Unknown error'}`);
      }
    }
    setSplitSaving(false);
    toast('success', `Saved ${saved}/${langs.length} language statements: ${langs.join(', ')}`);
    setSplitOpen(false);
    setSplitRaw('');
    setSplitPreview(null);
    await loadStatements();
  };

  const [viewingHtml, setViewingHtml] = useState(false);

  const handleViewHtml = async () => {
    setViewingHtml(true);
    try {
      // Fetch problem info for limits
      const infoRes = await api.problem.info(problemId) as { result: { timeLimit?: number; memoryLimit?: number } };
      const info = infoRes.result || {};
      const timeLimit = String(info.timeLimit || 1000);
      const memoryLimit = String((info.memoryLimit || 268435456) / (1024 * 1024));

      // Fetch sample tests (group "0" or useInStatements)
      let samples: { input: string; output: string }[] = [];
      try {
        const testsRes = await api.problem.tests(problemId, 'tests') as { result: Test[] };
        const allTests = testsRes.result || [];
        const sampleTests = allTests.filter(t => t.group === '0' || t.useInStatements);

        // Try to get main correct solution's outputs
        let hasMaSolution = false;
        try {
          const solRes = await api.problem.solutions(problemId) as { result: Solution[] };
          hasMaSolution = (solRes.result || []).some(s => s.tag === 'MA');
        } catch { /* ignore */ }

        for (const t of sampleTests) {
          let input = t.input || '';
          if (!input) {
            try {
              const inputRes = await api.problem.testInput(problemId, 'tests', t.index);
              input = typeof inputRes === 'string' ? inputRes : String(inputRes);
            } catch { input = '(could not load)'; }
          }
          let output = '';
          if (hasMaSolution) {
            try {
              const outputRes = await api.problem.testAnswer(problemId, 'tests', t.index);
              output = typeof outputRes === 'string' ? outputRes : String(outputRes);
            } catch { output = ''; }
          }
          samples.push({ input, output });
        }
      } catch { /* no tests yet */ }

      const html = buildStatementHtml(form, '', timeLimit, memoryLimit, samples);
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to build HTML preview');
    } finally {
      setViewingHtml(false);
    }
  };

  const update = (field: keyof Statement, val: string) =>
    setForm((f) => ({ ...f, [field]: val }));

  const availableLangs = Object.keys(statements);

  return (
    <div className="p-6 space-y-5">
      {/* Lang selector */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="w-48">
          <Select
            label="Language"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            options={LANGUAGES}
          />
        </div>
        {availableLangs.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap mt-4">
            {availableLangs.map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  l === lang
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                    : 'border-[#362f28] text-gray-500 hover:text-gray-300'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Statement form */}
      <Card title={`Statement — ${lang}`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" icon={<Languages className="w-3.5 h-3.5" />} onClick={() => { setSplitOpen(true); setSplitPreview(null); setSplitRaw(''); }}>
              Split Languages
            </Button>
            <Button variant="secondary" size="sm" icon={<Eye className="w-3.5 h-3.5" />} loading={viewingHtml} onClick={handleViewHtml}>
              View HTML
            </Button>
            <Button variant="secondary" size="sm" icon={<FileText className="w-3.5 h-3.5" />} onClick={() => { setParseMode('parse'); setParseOpen(true); }}>
              Parse / Convert
            </Button>
            <Button variant="primary" size="sm" icon={<Save className="w-3.5 h-3.5" />} loading={saving} onClick={handleSave}>
              Save
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input
            label="Problem Name (in this language)"
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder="A Plus B"
          />
          <Textarea
            label="Legend"
            value={form.legend}
            onChange={(e) => update('legend', e.target.value)}
            placeholder="Story and problem description using $math$ notation..."
            rows={6}
            mono
          />
          <Textarea
            label="Input Format"
            value={form.input}
            onChange={(e) => update('input', e.target.value)}
            placeholder="The first line contains..."
            rows={5}
            mono
          />
          <Textarea
            label="Output Format"
            value={form.output}
            onChange={(e) => update('output', e.target.value)}
            placeholder="Print..."
            rows={4}
            mono
          />
          <Textarea
            label="Scoring (Subtask table)"
            value={form.scoring}
            onChange={(e) => update('scoring', e.target.value)}
            placeholder="\begin{center}\begin{tabular}..."
            rows={6}
            mono
          />
          {form.interaction !== undefined && (
            <Textarea
              label="Interaction Protocol (interactive problems)"
              value={form.interaction}
              onChange={(e) => update('interaction', e.target.value)}
              placeholder="Describe the interaction protocol..."
              rows={4}
              mono
            />
          )}
          <Textarea
            label="Notes / Examples Explanation"
            value={form.notes}
            onChange={(e) => update('notes', e.target.value)}
            placeholder="Explain example inputs/outputs..."
            rows={4}
            mono
          />
          <Textarea
            label="Tutorial (hidden in statement)"
            value={form.tutorial}
            onChange={(e) => update('tutorial', e.target.value)}
            placeholder="Solution approach..."
            rows={4}
            mono
          />
        </div>
      </Card>

      {/* Statement Resources */}
      <Card
        title="Statement Resources"
        actions={
          <Button size="sm" variant="secondary" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => setUploadOpen(true)}>
            Upload
          </Button>
        }
      >
        {resources.length === 0 ? (
          <p className="text-gray-600 text-sm">No resources uploaded yet. Upload images, PDF attachments, etc.</p>
        ) : (
          <div className="space-y-1">
            {resources.map((f) => (
              <div key={f.name} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-[#2c2722] transition-colors">
                <span className="font-mono text-sm text-gray-300">{f.name}</span>
                <span className="text-xs text-gray-600">{(f.length / 1024).toFixed(1)} KB</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Upload resource modal */}
      <Modal
        open={uploadOpen}
        onClose={() => { setUploadOpen(false); setResFile(null); }}
        title="Upload Statement Resource"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={uploading} onClick={handleUploadResource} disabled={!resFile}>
              Upload
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-500">Upload images or other files referenced in the statement LaTeX.</p>
          <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-[#362f28] rounded-xl cursor-pointer hover:border-amber-500/50 transition-colors bg-[#1a1714]">
            <Upload className="w-6 h-6 text-gray-500 mb-2" />
            <span className="text-sm text-gray-500">{resFile ? resFile.name : 'Click to select file'}</span>
            <input type="file" className="sr-only" onChange={(e) => setResFile(e.target.files?.[0] || null)} />
          </label>
        </div>
      </Modal>

      {/* Unified Parse / Convert modal */}
      <Modal
        open={parseOpen}
        onClose={() => { setParseOpen(false); setParseRaw(''); setMdxOutput(''); }}
        title="Parse & Convert Statement"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setParseOpen(false); setParseRaw(''); setMdxOutput(''); }}>Cancel</Button>
            {parseMode === 'parse' ? (
              <Button variant="primary" onClick={handleParseFill} disabled={!parseRaw.trim()}>
                Parse & Fill Fields
              </Button>
            ) : (
              <>
                <Button variant="secondary" icon={<Code2 className="w-3.5 h-3.5" />} onClick={handleMdxConvert} disabled={!parseRaw.trim()}>
                  Convert
                </Button>
                {mdxOutput && (
                  <Button variant="primary" onClick={handleMdxApply}>
                    Apply to Legend
                  </Button>
                )}
              </>
            )}
          </>
        }
      >
        <div className="space-y-4">
          {/* Mode tabs */}
          <div className="flex border-b border-[#362f28]">
            <button
              onClick={() => { setParseMode('parse'); setMdxOutput(''); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                parseMode === 'parse'
                  ? 'border-amber-500 text-amber-300'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5" />
                Parse Statement
              </span>
            </button>
            <button
              onClick={() => { setParseMode('mdx'); setMdxOutput(''); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                parseMode === 'mdx'
                  ? 'border-amber-500 text-amber-300'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <Code2 className="w-3.5 h-3.5" />
                MDX to LaTeX
              </span>
            </button>
          </div>

          {parseMode === 'parse' ? (
            <>
              <p className="text-sm text-gray-400">
                Paste a complete problem statement and choose the format. The parser splits it into Polygon sections and fills the form fields.
              </p>

              {/* Format toggle */}
              <div className="flex items-center gap-4">
                <span className="text-sm text-gray-400">Format:</span>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="parseFormat"
                    checked={parseFormat === 'latex'}
                    onChange={() => setParseFormat('latex')}
                    className="accent-amber-500"
                  />
                  <span className={`text-sm ${parseFormat === 'latex' ? 'text-amber-300' : 'text-gray-500'}`}>LaTeX</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="parseFormat"
                    checked={parseFormat === 'plain'}
                    onChange={() => setParseFormat('plain')}
                    className="accent-amber-500"
                  />
                  <span className={`text-sm ${parseFormat === 'plain' ? 'text-amber-300' : 'text-gray-500'}`}>Plain Text</span>
                </label>
              </div>

              <Textarea
                label="Full Statement"
                value={parseRaw}
                onChange={(e) => setParseRaw(e.target.value)}
                placeholder={parseFormat === 'latex'
                  ? '\\textbf{Problem Name}\nA Plus B\n\n\\textbf{Legend}\nYou are given two integers...\n\n\\textbf{Input}\nThe first line contains...\n\n\\textbf{Output}\nPrint the sum...'
                  : 'A Plus B\nYou are given two integers...\n\nInput\nThe first line contains...\n\nOutput\nPrint the sum...'}
                rows={16}
                mono
              />

              <div className="text-xs text-gray-600 space-y-1">
                {parseFormat === 'latex' ? (
                  <>
                    <p><strong className="text-gray-400">Recognized LaTeX markers:</strong></p>
                    <p>{'\\textbf{Problem Name}, \\textbf{Legend}, \\textbf{Input}, \\InputFile, \\textbf{Output}, \\OutputFile, \\textbf{Scoring}, \\textbf{Subtasks}, \\textbf{Note}, \\textbf{Notes}, \\textbf{Interaction}'}</p>
                  </>
                ) : (
                  <>
                    <p><strong className="text-gray-400">Recognized plain text headers:</strong></p>
                    <p>Input, Output, Scoring, Subtasks, Note, Notes, Example, Interaction</p>
                    <p>First line before "Input" becomes problem name; rest becomes legend.</p>
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-400">
                Paste MDX / Markdown content and convert to LaTeX. Handles bold, italic, inline code, headings, and lists.
              </p>

              <Textarea
                label="MDX / Markdown Input"
                value={parseRaw}
                onChange={(e) => setParseRaw(e.target.value)}
                placeholder="## Problem\nYou are given **two** integers $a$ and $b$.\n\n- First item\n- Second item"
                rows={12}
                mono
              />

              {mdxOutput && (
                <Textarea
                  label="LaTeX Output (read-only)"
                  value={mdxOutput}
                  onChange={() => {}}
                  rows={12}
                  mono
                />
              )}
            </>
          )}
        </div>
      </Modal>

      {/* Split Languages modal */}
      <Modal
        open={splitOpen}
        onClose={() => { setSplitOpen(false); setSplitRaw(''); setSplitPreview(null); }}
        title="Split Multi-Language Statement"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setSplitOpen(false); setSplitRaw(''); setSplitPreview(null); }}>Cancel</Button>
            {!splitPreview ? (
              <Button variant="primary" onClick={handleSplitPreview} disabled={!splitRaw.trim()}>
                Preview Split
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setSplitPreview(null)}>
                  Back
                </Button>
                <Button variant="primary" loading={splitSaving} onClick={handleSplitSave}>
                  Save All Languages
                </Button>
              </>
            )}
          </>
        }
      >
        <div className="space-y-4">
          {!splitPreview ? (
            <>
              <p className="text-sm text-gray-400">
                Paste a single block containing all language versions. Each language should start with{' '}
                <code className="text-amber-400 bg-[#211e1a] px-1.5 py-0.5 rounded text-xs">{'\\textbf{English}'}</code>,{' '}
                <code className="text-amber-400 bg-[#211e1a] px-1.5 py-0.5 rounded text-xs">{'\\textbf{Russian}'}</code>, etc.
                Section titles (<code className="text-amber-400 bg-[#211e1a] px-1.5 py-0.5 rounded text-xs">{'\\textbf{Legend}'}</code>,{' '}
                <code className="text-amber-400 bg-[#211e1a] px-1.5 py-0.5 rounded text-xs">{'\\textbf{Input format}'}</code>, etc.) should remain the same across all languages.
              </p>
              <Textarea
                label="Full Multi-Language Statement"
                value={splitRaw}
                onChange={(e) => setSplitRaw(e.target.value)}
                placeholder={'\\textbf{English}\n\n\\textbf{Problem Name}\nLucky Seven\n\n\\textbf{Legend}\nYou are given...\n\n\\textbf{Russian}\n\n\\textbf{Problem Name}\nСчастливая семёрка\n\n\\textbf{Legend}\nДано целое число...'}
                rows={18}
                mono
              />
            </>
          ) : (
            <>
              <p className="text-sm text-gray-400">
                Found <strong className="text-amber-300">{Object.keys(splitPreview).length}</strong> languages. Review the parsed sections below, then click <strong className="text-amber-300">Save All Languages</strong> to upload them to Polygon.
              </p>
              <div className="space-y-3 max-h-[28rem] overflow-y-auto pr-1">
                {Object.entries(splitPreview).map(([langCode, sections]) => (
                  <div key={langCode} className="border border-[#362f28] rounded-lg overflow-hidden">
                    <div className="bg-[#211e1a] px-4 py-2 flex items-center gap-2">
                      <Languages className="w-3.5 h-3.5 text-amber-400" />
                      <span className="text-sm font-medium text-amber-300 capitalize">{langCode}</span>
                    </div>
                    <div className="px-4 py-3 space-y-1.5 text-xs">
                      {sections.name && (
                        <div><span className="text-gray-500 w-20 inline-block">Name:</span> <span className="text-gray-300">{sections.name}</span></div>
                      )}
                      {sections.legend && (
                        <div><span className="text-gray-500 w-20 inline-block">Legend:</span> <span className="text-gray-300 font-mono">{sections.legend.slice(0, 100)}{sections.legend.length > 100 ? '...' : ''}</span></div>
                      )}
                      {sections.input && (
                        <div><span className="text-gray-500 w-20 inline-block">Input:</span> <span className="text-gray-300 font-mono">{sections.input.slice(0, 80)}{sections.input.length > 80 ? '...' : ''}</span></div>
                      )}
                      {sections.output && (
                        <div><span className="text-gray-500 w-20 inline-block">Output:</span> <span className="text-gray-300 font-mono">{sections.output.slice(0, 80)}{sections.output.length > 80 ? '...' : ''}</span></div>
                      )}
                      {sections.scoring && (
                        <div><span className="text-gray-500 w-20 inline-block">Scoring:</span> <span className="text-gray-300 font-mono">{sections.scoring.slice(0, 80)}{sections.scoring.length > 80 ? '...' : ''}</span></div>
                      )}
                      {sections.notes && (
                        <div><span className="text-gray-500 w-20 inline-block">Notes:</span> <span className="text-gray-300 font-mono">{sections.notes.slice(0, 80)}{sections.notes.length > 80 ? '...' : ''}</span></div>
                      )}
                      {!sections.name && !sections.legend && !sections.input && !sections.output && (
                        <div className="text-gray-600 italic">No sections parsed</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
