import JSZip from 'jszip';
import {
  convertMdxToLatex, splitMultiLanguage, splitMultiLanguageRaw, parseLatexStatement, ParsedSections,
  deriveDependenciesFromScoring, derivePointsFromScoring,
} from '../../utils/statementParser';
import { extractGroupFromFilename } from '../../utils/testParser';
import { ParsedZip, ExtraSolution } from './types';
import { baseProblemSlug } from './merge';

/** Lowercased final path segment. */
function baseName(p: string): string {
  return (p.split('/').pop() || '').toLowerCase();
}

// Extra-solution filename → Polygon tag, by leading prefix. Order matters
// (more specific alternatives first). Main solution stays solution.cpp → MA.
const SOLUTION_TAG_PREFIXES: [RegExp, string][] = [
  [/^(wa|wrong)/, 'WA'],
  [/^(tle|tl|slow)/, 'TL'],
  [/^(mle|ml)/, 'ML'],
  [/^(rte|re|runtime)/, 'RE'],
  [/^(pe|presentation)/, 'PE'],
  [/^(to)/, 'TO'],
  [/^(tm)/, 'TM'],
  [/^(ok|ac|correct|accepted|brute|bf)/, 'OK'],
];

/** Detect a solution tag from a .cpp basename, or null if it isn't a tagged solution. */
function detectSolutionTag(base: string): string | null {
  const name = base.replace(/\.(cpp|cc|cxx)$/i, '');
  for (const [re, tag] of SOLUTION_TAG_PREFIXES) {
    if (re.test(name)) return tag;
  }
  return null;
}

/**
 * Locate the slug root folder from a reference file path. Prefers an
 * `edu-<name>/` segment anywhere in the path; otherwise uses the top folder.
 */
function rootFromPath(p: string): string {
  const segs = p.split('/');
  const eduIdx = segs.findIndex(s => /^edu[-_]/i.test(s));
  if (eduIdx >= 0) return segs.slice(0, eduIdx + 1).join('/') + '/';
  return segs.length > 1 ? segs[0] + '/' : '';
}

export async function parseZip(zip: JSZip): Promise<ParsedZip> {
  const filePaths = Object.keys(zip.files).filter(p => !zip.files[p].dir);

  // ── Strict component lookup ────────────────────────────────────────────────
  // Only the exact files we need are read; everything else in the archive is
  // ignored. For each component pick the shallowest matching basename (closest
  // to the slug root) so a stray copy in a garbage subfolder can't win.
  const findByName = (...names: string[]): string | undefined => {
    const wanted = names.map(n => n.toLowerCase());
    return filePaths
      .filter(p => wanted.includes(baseName(p)))
      .sort((a, b) => a.split('/').length - b.split('/').length)[0];
  };

  const stmtPath = findByName('problem_statement.mdx', 'problem_statement.tex');
  const tutorialPath = findByName('tutorial.mdx', 'tutorial.tex');
  const checkerPath = findByName('checker.cpp');
  const solutionPath = findByName('solution.cpp');
  const validatorPath = findByName('validator.cpp');

  // Slug root folder — derived from a core file so garbage at the top level
  // (loose files/folders next to the real problem folder) is ignored.
  const refPath = stmtPath || checkerPath || solutionPath || filePaths[0] || '';
  const rootPrefix = rootFromPath(refPath);

  // Keep the edu- prefix as the Polygon slug; strip it only for display.
  const folderName = rootPrefix.replace(/\/$/, '') || 'imported-problem';
  const problemName = folderName;
  const displayName = folderName
    .replace(/^edu[-_]/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  // Read problem_statement.mdx (or .tex)
  let languages: Record<string, ParsedSections> = {};
  if (stmtPath) {
    const rawMdx = await zip.files[stmtPath].async('string');
    const isTeX = stmtPath.toLowerCase().endsWith('.tex');
    const latex = isTeX ? rawMdx : convertMdxToLatex(rawMdx);
    languages = splitMultiLanguage(latex);
    if (Object.keys(languages).length === 0) {
      // No language markers found — treat as single English statement
      languages = { english: parseLatexStatement(latex) };
    }
  }

  // Read tutorial.mdx (or .tex) — a LaTeX editorial split by the same
  // \textbf{English}/\textbf{Russian} language markers as the statement. Kept as
  // raw per-language text (no section parsing) since it's free-form prose.
  let tutorials: Record<string, string> = {};
  if (tutorialPath) {
    const rawTut = await zip.files[tutorialPath].async('string');
    const isTeX = tutorialPath.toLowerCase().endsWith('.tex');
    const latex = isTeX ? rawTut : convertMdxToLatex(rawTut);
    tutorials = splitMultiLanguageRaw(latex);
    if (Object.keys(tutorials).length === 0 && latex.trim()) {
      // No language markers — treat the whole file as the English tutorial.
      tutorials = { english: latex.trim() };
    }
  }

  // Read checker.cpp
  let checkerCode: string | null = null;
  if (checkerPath) {
    checkerCode = await zip.files[checkerPath].async('string');
  }

  // Read validator.cpp (optional)
  let validatorCode: string | null = null;
  if (validatorPath) {
    validatorCode = await zip.files[validatorPath].async('string');
  }

  // Read solution.cpp (main → MA)
  let solutionCode: string | null = null;
  if (solutionPath) {
    solutionCode = await zip.files[solutionPath].async('string');
  }

  // Read extra solutions — any *.cpp under the slug root whose basename starts
  // with a known tag prefix (wa_*, tle_*, …). Core files are excluded. Deduped
  // by basename (Polygon solution names must be unique).
  const CORE_CPP = new Set(['checker.cpp', 'solution.cpp', 'validator.cpp']);
  const extraSolutions: ExtraSolution[] = [];
  const seenNames = new Set<string>();
  for (const p of filePaths) {
    if (rootPrefix && !p.startsWith(rootPrefix)) continue;
    const b = baseName(p);
    if (!b.endsWith('.cpp') || CORE_CPP.has(b) || seenNames.has(b)) continue;
    const tag = detectSolutionTag(b);
    if (!tag) continue;
    seenNames.add(b);
    extraSolutions.push({ filename: b, code: await zip.files[p].async('string'), tag });
  }

  // Read tests — ONLY input*.txt files inside a testset/ folder (tesset/ typo
  // accepted), under the slug root. Answer/output/other files are ignored.
  const testFiles = filePaths.filter(p => {
    if (rootPrefix && !p.startsWith(rootPrefix)) return false;
    const segs = p.toLowerCase().split('/');
    const inTestset = segs.includes('testset') || segs.includes('tesset');
    return inTestset && /^input.*\.txt$/.test(baseName(p));
  });

  interface RawTest { input: string; group: string; sortKey: number; filename: string }
  const rawTests: RawTest[] = [];

  for (const path of testFiles) {
    const filename = path.split('/').pop() || path;
    const content = await zip.files[path].async('string');
    const group = extractGroupFromFilename(filename) || '0';
    const match = filename.match(/idx(\d+)/i) || filename.match(/(\d+)/);
    const sortKey = match ? parseInt(match[1], 10) : rawTests.length;
    rawTests.push({ input: content, group, sortKey, filename });
  }

  // Sort by group then by sort key
  rawTests.sort((a, b) => {
    const gA = parseInt(a.group, 10);
    const gB = parseInt(b.group, 10);
    if (gA !== gB) return gA - gB;
    return a.sortKey - b.sortKey;
  });

  // Assign sequential 1-based indices
  const tests = rawTests.map((t, i) => ({
    index: i + 1,
    input: t.input,
    group: t.group,
    filename: t.filename,
  }));

  const scoringText = (
    languages['english']?.scoring?.trim() ||
    Object.values(languages).map(s => s.scoring).find(s => s.trim())?.trim() ||
    ''
  );
  const hasScoring = scoringText.length > 0;

  // ── Pre-flight validation (advisory warnings; import still allowed) ─────────
  const warnings: string[] = [];
  if (Object.keys(languages).length === 0) warnings.push('No statement languages parsed');
  if (!checkerCode) warnings.push('No checker.cpp found');
  if (!solutionCode) warnings.push('No solution.cpp (main) found');
  if (tests.length === 0) warnings.push('No tests found in testset/');

  const groupNums = [...new Set(tests.map(t => Number(t.group)))].sort((a, b) => a - b);
  if (groupNums.length > 0) {
    const maxG = groupNums[groupNums.length - 1];
    const missing: number[] = [];
    for (let g = 0; g <= maxG; g++) if (!groupNums.includes(g)) missing.push(g);
    if (missing.length) warnings.push(`Non-contiguous groups — missing ${missing.join(', ')}`);
  }

  if (hasScoring) {
    const pts = derivePointsFromScoring(scoringText);
    const deps = deriveDependenciesFromScoring(scoringText);
    if (Object.keys(pts).length === 0 && Object.keys(deps).length === 0) {
      warnings.push('Scoring section present but no points/deps could be parsed');
    } else {
      const scoredGroups = new Set([...Object.keys(pts), ...Object.keys(deps)]);
      const unknown = [...scoredGroups].filter(g => !groupNums.includes(Number(g)));
      if (unknown.length) warnings.push(`Scoring references group(s) ${unknown.join(', ')} with no tests`);
    }
  }

  // The tutorial should cover exactly the statement's languages.
  const stmtLangs = Object.keys(languages);
  const tutLangs = Object.keys(tutorials);
  if (tutorialPath && tutLangs.length === 0) {
    warnings.push('tutorial file found but no content could be parsed');
  } else if (tutLangs.length > 0 && stmtLangs.length > 0) {
    const missing = stmtLangs.filter(l => !tutLangs.includes(l));
    const extra = tutLangs.filter(l => !stmtLangs.includes(l));
    if (missing.length) warnings.push(`Tutorial missing language(s): ${missing.join(', ')}`);
    if (extra.length) warnings.push(`Tutorial has language(s) with no statement: ${extra.join(', ')} (will be skipped)`);
  }

  // A pure test pack has tests but no statement/checker/solution/validator — it
  // just tops up an existing problem's tests.
  const testsOnly =
    Object.keys(languages).length === 0 &&
    !checkerCode && !solutionCode && !validatorCode &&
    extraSolutions.length === 0 && tests.length > 0;
  if (testsOnly) {
    const target = baseProblemSlug(problemName);
    warnings.push(`Tests-only archive (${tests.length} tests) — appends to problem "${target}"`);
  }

  return {
    problemName, displayName, languages, tutorials,
    checkerCode, validatorCode, solutionCode, extraSolutions,
    tests, hasScoring, scoringText, warnings, testsOnly,
  };
}
