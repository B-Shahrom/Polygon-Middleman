export type ParseFormat = 'latex' | 'plain';

export interface ParsedSections {
  name: string;
  legend: string;
  input: string;
  output: string;
  scoring: string;
  notes: string;
  interaction: string;
}

export const LANG_NAME_MAP: Record<string, string> = {
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

export function parseLatexStatement(raw: string): ParsedSections {
  const sections: ParsedSections = { name: '', legend: '', input: '', output: '', scoring: '', notes: '', interaction: '' };

  const text = raw.replace(/\r\n/g, '\n');

  const markers: { key: keyof ParsedSections; re: RegExp }[] = [
    { key: 'input',       re: /\\textbf\{Input(?:\s+format)?\}|\\section\*?\{Input(?:\s+format)?\}|\\InputFile/i },
    { key: 'output',      re: /\\textbf\{Output(?:\s+format)?\}|\\section\*?\{Output(?:\s+format)?\}|\\OutputFile/i },
    { key: 'scoring',     re: /\\textbf\{Scoring\}|\\textbf\{Subtasks\}|\\section\*?\{Scoring\}|\\section\*?\{Subtasks\}|\\Scoring/i },
    { key: 'notes',       re: /\\textbf\{Notes?\}|\\section\*?\{Notes?\}|\\Note/i },
    { key: 'interaction', re: /\\textbf\{Interaction\}|\\section\*?\{Interaction\}/i },
  ];

  const nameRe = /\\textbf\{Problem Name\}|\\section\*?\{Problem Name\}/i;
  const legendRe = /\\textbf\{(?:Legend|Description)\}|\\section\*?\{(?:Legend|Description)\}/i;

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

  splits.sort((a, b) => a.pos - b.pos);

  if (splits.length === 0) {
    sections.legend = text.trim();
    return sections;
  }

  const beforeFirst = text.slice(0, splits[0].pos).trim();
  if (beforeFirst) {
    if (splits[0].key !== 'name') {
      sections.legend = beforeFirst;
    }
  }

  for (let i = 0; i < splits.length; i++) {
    const endPos = i + 1 < splits.length ? splits[i + 1].pos : text.length;
    const content = text.slice(splits[i].end, endPos).trim();
    sections[splits[i].key] = content;
  }

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

export function parsePlainTextStatement(raw: string): ParsedSections {
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

export function convertInline(text: string): string {
  let result = text;
  result = result.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}');
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '\\textit{$1}');
  result = result.replace(/`([^`]+)`/g, '\\texttt{$1}');
  return result;
}

export function convertMdxToLatex(mdx: string): string {
  const lines = mdx.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

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

    if (line.trim() === '') {
      out.push('');
      i++;
      continue;
    }

    out.push(convertInline(line));
    i++;
  }

  return out.join('\n');
}

export function splitMultiLanguage(raw: string): Record<string, ParsedSections> {
  const text = raw.replace(/\r\n/g, '\n');
  const result: Record<string, ParsedSections> = {};

  const langNames = Object.keys(LANG_NAME_MAP);
  const langPattern = new RegExp(
    `\\\\textbf\\s*\\{\\s*(${langNames.join('|')})\\s*\\}`,
    'gi'
  );

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

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].end;
    const end = i + 1 < positions.length ? positions[i + 1].pos : text.length;
    const langContent = text.slice(start, end).trim();
    result[positions[i].code] = parseLatexStatement(langContent);
  }

  return result;
}

// --------------- Scoring section parsers ---------------
// Shared by the Tests tab (manual "Derive …" buttons) and the ZIP importer
// (auto-run when the imported statement has a scoring section).

/**
 * Parse group → dependency-list from a Scoring section.
 * Supports LaTeX tabular rows ("3 & No additional & 60 & 0, 1, 2 \\") and the
 * plain-text "Subtask 3 ... depends on subtasks 1, 2" form.
 */
export function deriveDependenciesFromScoring(scoring: string): Record<string, string[]> {
  const depMap: Record<string, string[]> = {};
  const lines = scoring.split('\n');

  let foundTabular = false;
  for (const line of lines) {
    const cells = line.split('&').map((c) => c.replace(/\\\\/g, '').trim());
    if (cells.length >= 3) {
      const groupMatch = cells[0].match(/(\d+)/);
      if (!groupMatch) continue;
      const groupNum = groupMatch[1];

      const lastCell = cells[cells.length - 1];

      // Skip header rows
      if (/subtask|group|dependencies|required/i.test(cells[0]) && /constraint|points|dep/i.test(cells[1])) continue;
      // Skip "no dependencies" cells (dashes / empty)
      if (/^[-—\s]*$/.test(lastCell) || lastCell === '') continue;

      const depNums = lastCell.match(/\d+/g);
      if (depNums && depNums.length > 0) {
        depMap[groupNum] = depNums.map((n) => n.trim());
        foundTabular = true;
      }
    }
  }

  if (!foundTabular) {
    for (const line of lines) {
      const subtaskMatch = line.match(/(?:subtask|group)\s+(\d+)/i);
      if (!subtaskMatch) continue;
      const groupNum = subtaskMatch[1];
      const depMatch = line.match(/depends?\s+on\s+(?:subtasks?\s+)?(.+?)(?:\.|$)/i);
      if (depMatch) {
        const depNums = depMatch[1].match(/\d+/g);
        if (depNums && depNums.length > 0) depMap[groupNum] = depNums;
      }
    }
  }

  return depMap;
}

/**
 * Parse group → points from a Scoring section.
 * Supports LaTeX tabular ("group & constraint & points & deps \\") and the
 * plain-text "Subtask N (X points)" form.
 */
export function derivePointsFromScoring(scoring: string): Record<string, number> {
  const pointsMap: Record<string, number> = {};
  const lines = scoring.split('\n');

  let foundTabular = false;
  for (const line of lines) {
    const cells = line.split('&').map((c) => c.replace(/\\\\/g, '').trim());
    if (cells.length >= 3) {
      const groupMatch = cells[0].match(/(\d+)/);
      if (!groupMatch) continue;
      const groupNum = groupMatch[1];

      if (/subtask|group|dependencies|required/i.test(cells[0]) && /constraint|points|dep/i.test(cells[1])) continue;

      let pointsVal: number | null = null;
      for (let ci = 1; ci < cells.length; ci++) {
        const cell = cells[ci].replace(/[$ \\]/g, '').trim();
        if (/^\d+$/.test(cell) && !/[<>=]/.test(cells[ci])) {
          pointsVal = parseInt(cell, 10);
          break;
        }
      }

      if (pointsVal !== null) {
        pointsMap[groupNum] = pointsVal;
        foundTabular = true;
      }
    }
  }

  if (!foundTabular) {
    for (const line of lines) {
      const m = line.match(/(?:subtask|group)\s+(\d+)\s*.*?(\d+)\s*(?:points?|баллов|очков)/i);
      if (m) pointsMap[m[1]] = parseInt(m[2], 10);
    }
  }

  return pointsMap;
}
