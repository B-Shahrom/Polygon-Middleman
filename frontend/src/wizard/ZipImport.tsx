import { useState, useRef } from 'react';
import {
  Archive, Upload, CheckCircle2, Loader2, X, AlertCircle,
} from 'lucide-react';
import JSZip from 'jszip';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { Problem } from '../types/polygon';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import { convertMdxToLatex, splitMultiLanguage, ParsedSections } from '../utils/statementParser';
import { extractGroupFromFilename } from '../utils/testParser';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ParsedZip {
  problemName: string;
  displayName: string;
  languages: Record<string, ParsedSections>;
  checkerCode: string | null;
  solutionCode: string | null;
  tests: { index: number; input: string; group: string; filename: string }[];
  hasScoring: boolean;
}

interface LogEntry { text: string; status: 'pending' | 'running' | 'done' | 'error' }

type Phase = 'select' | 'preview' | 'uploading' | 'done';

export default function ZipImport({ open, onClose }: Props) {
  const { toast } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>('select');
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<ParsedZip | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [importing, setImporting] = useState(false);

  const addLog = (text: string, status: LogEntry['status'] = 'pending') =>
    setLog((prev) => [...prev, { text, status }]);

  const updateLastLog = (status: LogEntry['status'], text?: string) =>
    setLog((prev) => {
      const next = [...prev];
      if (next.length > 0) {
        next[next.length - 1] = { ...next[next.length - 1], status, ...(text ? { text } : {}) };
      }
      return next;
    });

  const handleClose = () => {
    if (importing) return;
    setParsed(null);
    setPhase('select');
    setLog([]);
    onClose();
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setParsing(true);
    try {
      const zip = await JSZip.loadAsync(file);
      const result = await parseZip(zip);
      setParsed(result);
      setPhase('preview');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to parse ZIP');
    } finally {
      setParsing(false);
    }
  };

  const handleImport = async () => {
    if (!parsed) return;
    setPhase('uploading');
    setImporting(true);
    setLog([]);
    let hadError = false;

    const step = async (label: string, fn: () => Promise<string | void>) => {
      addLog(label, 'running');
      try {
        const msg = await fn();
        updateLastLog('done', msg || label.replace(/\.\.\.$/,''));
      } catch (err) {
        hadError = true;
        updateLastLog('error', `${label.replace(/\.\.\.$/,'')} — ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    };

    // 1. Create problem (this one is fatal — can't continue without an ID)
    let problemId: number | undefined;
    addLog(`Creating problem "${parsed.displayName}"...`, 'running');
    try {
      const createRes = await api.problems.create(parsed.problemName) as { result?: Problem };
      problemId = createRes.result?.id;
      if (!problemId) {
        const listRes = await api.problems.list({}) as { result?: unknown };
        const all: Problem[] = Array.isArray((listRes as { result?: unknown }).result) ? (listRes as { result: Problem[] }).result : [];
        const target = parsed.problemName;
        const found =
          all.find((p) => p.name === target) ??
          all.find((p) => p.name.toLowerCase() === target.toLowerCase());
        problemId = found?.id;
      }
      if (!problemId) throw new Error('Problem was created but its ID could not be retrieved.');
      updateLastLog('done', `Created problem #${problemId}`);
    } catch (err) {
      updateLastLog('error', `Failed to create problem — ${err instanceof Error ? err.message : 'Unknown error'}`);
      setImporting(false);
      return;
    }

    const pid = problemId;

    // 2. Update info
    await step('Setting problem info (TL=1000ms, ML=256MB)...', async () => {
      await api.problem.updateInfo({
        problemId: pid,
        inputFile: 'stdin',
        outputFile: 'stdout',
        interactive: false,
        timeLimit: 1000,
        memoryLimit: 256,
      });
      return 'Problem info set';
    });

    // 3. Save statements per language
    const langs = Object.keys(parsed.languages);
    await step(`Saving statements for ${langs.length} language(s)...`, async () => {
      for (const langCode of langs) {
        const sections = parsed.languages[langCode];
        await api.problem.saveStatement({
          problemId: pid,
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
      }
      return `Statements saved: ${langs.join(', ')}`;
    });

    // 4. Upload checker
    if (parsed.checkerCode) {
      await step('Uploading checker.cpp...', async () => {
        const checkerBlob = new Blob([parsed.checkerCode!], { type: 'text/plain' });
        const checkerFile = new File([checkerBlob], 'checker.cpp', { type: 'text/plain' });
        await api.problem.saveFile(pid, 'source', 'checker.cpp', checkerFile, 'cpp.g++17');
        await api.problem.setChecker(pid, 'checker.cpp');
        return 'Checker uploaded & set';
      });
    }

    // 5. Upload solution
    if (parsed.solutionCode) {
      await step('Uploading solution.cpp [MA]...', async () => {
        const solBlob = new Blob([parsed.solutionCode!], { type: 'text/plain' });
        const solFile = new File([solBlob], 'solution.cpp', { type: 'text/plain' });
        await api.problem.saveSolution(pid, 'solution.cpp', solFile, 'MA', 'cpp.g++17');
        return 'Solution uploaded (MA)';
      });
    }

    // 6. Enable groups & points (before any test operations)
    await step('Enabling groups and points...', async () => {
      await api.problem.enableGroups(pid, 'tests', true);
      await api.problem.enablePoints(pid, true);
      return 'Groups & points enabled';
    });

    // 7. Upload tests
    const allGroups = [...new Set(parsed.tests.map(t => t.group))]
      .sort((a, b) => Number(a) - Number(b));

    if (parsed.tests.length > 0) {
      await step(`Uploading ${parsed.tests.length} tests...`, async () => {
        let uploaded = 0;
        for (const t of parsed.tests) {
          try {
            await api.problem.saveTest({
              problemId: pid,
              testset: 'tests',
              testIndex: t.index,
              testInput: t.input,
              testGroup: t.group,
              testUseInStatements: t.group === '0',
              checkExisting: true,
            });
            uploaded++;
          } catch {
            // continue uploading remaining tests
          }
        }
        return `${uploaded}/${parsed.tests.length} tests uploaded`;
      });
    }

    // 8. Configure group policies, dependencies, and points
    if (allGroups.length > 0) {
      await step('Configuring group policies...', async () => {
        // Re-send enable commands to be safe (Polygon may need them after tests exist)
        await api.problem.enableGroups(pid, 'tests', true);
        await api.problem.enablePoints(pid, true);

        const lastGroup = allGroups[allGroups.length - 1];
        const otherGroups = allGroups.filter(g => g !== lastGroup);

        for (const group of allGroups) {
          const deps = group === lastGroup && otherGroups.length > 0
            ? otherGroups.join(',')
            : undefined;

          await api.problem.saveTestGroup({
            problemId: pid,
            testset: 'tests',
            group,
            pointsPolicy: 'COMPLETE_GROUP',
            ...(deps ? { dependencies: deps } : {}),
          });
        }

        // If no scoring section, assign 100 points to first test of the last group
        const nonSampleGroups = allGroups.filter(g => g !== '0');
        if (!parsed.hasScoring && nonSampleGroups.length > 0) {
          const pointsGroup = nonSampleGroups[nonSampleGroups.length - 1];
          const targetTest = parsed.tests.find(t => t.group === pointsGroup);
          if (targetTest) {
            await api.problem.saveTest({
              problemId: pid,
              testset: 'tests',
              testIndex: targetTest.index,
              testInput: targetTest.input,
              testGroup: targetTest.group,
              testPoints: 100,
            });
          }
        }

        const depInfo = otherGroups.length > 0
          ? `, group ${lastGroup} depends on ${otherGroups.join(',')}`
          : '';
        const ptsInfo = !parsed.hasScoring && nonSampleGroups.length > 0
          ? `, 100pts on group ${nonSampleGroups[nonSampleGroups.length - 1]}`
          : '';
        return `Groups configured (COMPLETE_GROUP)${depInfo}${ptsInfo}`;
      });
    }

    setPhase('done');
    if (hadError) {
      toast('warning', `Problem imported with some errors — check the log`);
    } else {
      toast('success', `Problem "${parsed.displayName}" imported successfully!`);
    }
    setImporting(false);
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Import Problem from ZIP"
      size="lg"
      footer={
        phase === 'select' ? (
          <Button variant="ghost" onClick={handleClose}>Cancel</Button>
        ) : phase === 'preview' ? (
          <>
            <Button variant="ghost" onClick={() => { setParsed(null); setPhase('select'); }}>Back</Button>
            <Button variant="primary" icon={<Upload className="w-4 h-4" />} onClick={handleImport}>
              Start Import
            </Button>
          </>
        ) : phase === 'done' ? (
          <Button variant="primary" onClick={handleClose}>Close</Button>
        ) : null
      }
    >
      {phase === 'select' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            Select a ZIP file with the standard problem structure:
          </p>
          <div className="text-xs text-gray-500 bg-[#1a1714] rounded-lg p-3 font-mono space-y-0.5">
            <div>edu-problem-name/</div>
            <div className="pl-4">problem_statement.mdx</div>
            <div className="pl-4">checker.cpp</div>
            <div className="pl-4">solution.cpp</div>
            <div className="pl-4">testset/</div>
            <div className="pl-8">input_s0_idx0.txt</div>
            <div className="pl-8">input_s1_idx0.txt</div>
            <div className="pl-8">...</div>
          </div>
          <label className="flex flex-col items-center justify-center w-full h-36 border-2 border-dashed border-[#362f28] rounded-xl cursor-pointer hover:border-amber-500/50 transition-colors bg-[#1a1714]">
            {parsing ? (
              <>
                <Loader2 className="w-6 h-6 text-amber-400 mb-2 animate-spin" />
                <span className="text-sm text-gray-400">Parsing ZIP...</span>
              </>
            ) : (
              <>
                <Archive className="w-8 h-8 text-gray-500 mb-2" />
                <span className="text-sm text-gray-500">Click to select ZIP file</span>
                <span className="text-xs text-gray-600 mt-1">or drag and drop</span>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".zip"
              className="sr-only"
              onChange={handleFileSelect}
              disabled={parsing}
            />
          </label>
        </div>
      )}

      {phase === 'preview' && parsed && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[#1a1714] rounded-lg p-3 border border-[#362f28]">
              <div className="text-xs text-gray-500 mb-1">Problem Name</div>
              <div className="text-sm text-gray-200 font-medium">{parsed.displayName}</div>
              <div className="text-xs text-gray-600 font-mono mt-0.5">{parsed.problemName}</div>
            </div>
            <div className="bg-[#1a1714] rounded-lg p-3 border border-[#362f28]">
              <div className="text-xs text-gray-500 mb-1">Languages</div>
              <div className="flex flex-wrap gap-1 mt-1">
                {Object.keys(parsed.languages).map((l) => (
                  <span key={l} className="px-2 py-0.5 text-xs rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 capitalize">
                    {l}
                  </span>
                ))}
              </div>
            </div>
            <div className="bg-[#1a1714] rounded-lg p-3 border border-[#362f28]">
              <div className="text-xs text-gray-500 mb-1">Files</div>
              <div className="space-y-1 mt-1">
                <div className="flex items-center gap-1.5">
                  {parsed.checkerCode ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5 text-yellow-400" />
                  )}
                  <span className="text-xs text-gray-300">checker.cpp</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {parsed.solutionCode ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5 text-yellow-400" />
                  )}
                  <span className="text-xs text-gray-300">solution.cpp</span>
                </div>
              </div>
            </div>
            <div className="bg-[#1a1714] rounded-lg p-3 border border-[#362f28]">
              <div className="text-xs text-gray-500 mb-1">Tests</div>
              <div className="text-sm text-gray-200 font-medium">{parsed.tests.length} tests</div>
              {parsed.tests.length > 0 && (
                <div className="text-xs text-gray-500 mt-0.5">
                  Groups: {[...new Set(parsed.tests.map(t => t.group))].sort((a, b) => Number(a) - Number(b)).join(', ')}
                </div>
              )}
            </div>
          </div>

          {/* Statement preview per language */}
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {Object.entries(parsed.languages).map(([langCode, sections]) => (
              <div key={langCode} className="border border-[#362f28] rounded-lg overflow-hidden">
                <div className="bg-[#211e1a] px-3 py-1.5 text-xs font-medium text-amber-300 capitalize">{langCode}</div>
                <div className="px-3 py-2 space-y-0.5 text-xs">
                  {sections.name && <div><span className="text-gray-500">Name:</span> <span className="text-gray-300">{sections.name}</span></div>}
                  {sections.legend && <div><span className="text-gray-500">Legend:</span> <span className="text-gray-400 font-mono">{sections.legend.slice(0, 80)}{sections.legend.length > 80 ? '...' : ''}</span></div>}
                  {sections.input && <div><span className="text-gray-500">Input:</span> <span className="text-gray-400 font-mono">{sections.input.slice(0, 60)}{sections.input.length > 60 ? '...' : ''}</span></div>}
                  {sections.output && <div><span className="text-gray-500">Output:</span> <span className="text-gray-400 font-mono">{sections.output.slice(0, 60)}{sections.output.length > 60 ? '...' : ''}</span></div>}
                  {sections.scoring && <div><span className="text-gray-500">Scoring:</span> <span className="text-gray-400 font-mono">{sections.scoring.slice(0, 60)}{sections.scoring.length > 60 ? '...' : ''}</span></div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(phase === 'uploading' || phase === 'done') && (
        <div className="space-y-3">
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {log.map((entry, i) => (
              <div key={i} className="flex items-start gap-2">
                {entry.status === 'running' && <Loader2 className="w-4 h-4 text-amber-400 animate-spin flex-shrink-0 mt-0.5" />}
                {entry.status === 'done' && <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />}
                {entry.status === 'error' && <X className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />}
                {entry.status === 'pending' && <div className="w-4 h-4 rounded-full border border-gray-600 flex-shrink-0 mt-0.5" />}
                <span className={`text-sm ${entry.status === 'error' ? 'text-red-400' : entry.status === 'done' ? 'text-gray-300' : 'text-gray-400'}`}>
                  {entry.text}
                </span>
              </div>
            ))}
          </div>
          {phase === 'done' && (
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-400" />
              <span className="text-sm text-green-300">Import complete! Problem is ready on Polygon.</span>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

async function parseZip(zip: JSZip): Promise<ParsedZip> {
  const filePaths = Object.keys(zip.files).filter(p => !zip.files[p].dir);

  // Find root folder (edu-<name>/ or edu_<name>/)
  let rootPrefix = '';
  const rootFolder = filePaths.find(p => /^edu[-_]/.test(p));
  if (rootFolder) {
    rootPrefix = rootFolder.split('/')[0] + '/';
  } else {
    const firstSlash = filePaths[0]?.indexOf('/');
    if (firstSlash !== undefined && firstSlash > 0) {
      rootPrefix = filePaths[0].slice(0, firstSlash + 1);
    }
  }

  // Extract problem name from folder — keep edu- prefix as the Polygon slug
  let folderName = rootPrefix.replace(/\/$/, '');
  if (!folderName && filePaths.length > 0) {
    folderName = 'imported-problem';
  }
  const problemName = folderName;
  const displayName = folderName
    .replace(/^edu[-_]/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  // Read problem_statement.mdx
  let languages: Record<string, ParsedSections> = {};
  const stmtPath = filePaths.find(p =>
    p.toLowerCase().endsWith('problem_statement.mdx') ||
    p.toLowerCase().endsWith('problem_statement.tex')
  );
  if (stmtPath) {
    const rawMdx = await zip.files[stmtPath].async('string');
    const isTeX = stmtPath.toLowerCase().endsWith('.tex');
    const latex = isTeX ? rawMdx : convertMdxToLatex(rawMdx);
    languages = splitMultiLanguage(latex);
    if (Object.keys(languages).length === 0) {
      // No language markers found — treat as single English statement
      const { parseLatexStatement } = await import('../utils/statementParser');
      languages = { english: parseLatexStatement(latex) };
    }
  }

  // Read checker.cpp
  let checkerCode: string | null = null;
  const checkerPath = filePaths.find(p =>
    p.toLowerCase().endsWith('/checker.cpp') || p.toLowerCase() === 'checker.cpp'
  );
  if (checkerPath) {
    checkerCode = await zip.files[checkerPath].async('string');
  }

  // Read solution.cpp
  let solutionCode: string | null = null;
  const solutionPath = filePaths.find(p =>
    p.toLowerCase().endsWith('/solution.cpp') || p.toLowerCase() === 'solution.cpp'
  );
  if (solutionPath) {
    solutionCode = await zip.files[solutionPath].async('string');
  }

  // Read tests from testset/ (also accept tesset/ typo)
  const testFiles = filePaths.filter(p => {
    const lower = p.toLowerCase();
    return (lower.includes('/testset/') || lower.includes('/tesset/')) &&
      !lower.includes('output') && !lower.includes('answer') && !lower.includes('.a');
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

  const hasScoring = Object.values(languages).some(s => s.scoring.trim().length > 0);

  return { problemName, displayName, languages, checkerCode, solutionCode, tests, hasScoring };
}
