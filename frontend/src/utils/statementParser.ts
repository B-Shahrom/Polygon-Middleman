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
