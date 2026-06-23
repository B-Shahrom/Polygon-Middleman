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
import { convertMdxToLatex, splitMultiLanguage, parseLatexStatement, ParsedSections } from '../utils/statementParser';
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

interface LogEntry { text: string; status: 'pending' | 'running' | 'done' | 'error'; kind?: 'header' }

interface ParsedItem {
  fileName: string;
  parsed: ParsedZip | null;
  parseError?: string;
}

interface ImportResult { name: string; ok: boolean; errors: number; failed?: boolean }

type Phase = 'select' | 'preview' | 'uploading' | 'done';

export default function ZipImport({ open, onClose }: Props) {
  const { toast } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>('select');
  const [parsing, setParsing] = useState(false);
  const [items, setItems] = useState<ParsedItem[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportResult[]>([]);

  const addLog = (text: string, status: LogEntry['status'] = 'pending', kind?: 'header') =>
    setLog((prev) => [...prev, { text, status, kind }]);

  const updateLastLog = (status: LogEntry['status'], text?: string) =>
    setLog((prev) => {
      const next = [...prev];
      // Update the last non-header entry
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].kind !== 'header') {
          next[i] = { ...next[i], status, ...(text ? { text } : {}) };
          break;
        }
      }
      return next;
    });

  const handleClose = () => {
    if (importing) return;
    setItems([]);
    setResults([]);
    setPhase('select');
    setLog([]);
    onClose();
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    e.target.value = '';

    setParsing(true);
    const parsedItems: ParsedItem[] = [];
    for (const file of files) {
      try {
        const zip = await JSZip.loadAsync(file);
        const result = await parseZip(zip);
        parsedItems.push({ fileName: file.name, parsed: result });
      } catch (err) {
        parsedItems.push({
          fileName: file.name,
          parsed: null,
          parseError: err instanceof Error ? err.message : 'Failed to parse ZIP',
        });
      }
    }
    setItems(parsedItems);
    setParsing(false);
    setPhase('preview');

    const ok = parsedItems.filter(i => i.parsed).length;
    const bad = parsedItems.length - ok;
    if (bad > 0) toast('warning', `Parsed ${ok} ZIP(s); ${bad} could not be read`);
  };

  // Upload a single parsed problem. Returns the number of step-level errors.
  const importProblem = async (parsed: ParsedZip): Promise<{ failed: boolean; errors: number }> => {
    let errors = 0;

    const step = async (label: string, fn: () => Promise<string | void>) => {
      addLog(label, 'running');
      try {
        const msg = await fn();
        updateLastLog('done', msg || label.replace(/\.\.\.$/, ''));
      } catch (err) {
        errors++;
        updateLastLog('error', `${label.replace(/\.\.\.$/, '')} — ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    };

    // 1. Create problem (fatal for THIS problem — skip the rest of its steps if it fails)
    let problemId: number | undefined;
    addLog(`Creating problem "${parsed.problemName}"...`, 'running');
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
      return { failed: true, errors: errors + 1 };
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
    if (langs.length > 0) {
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
    }

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

    // 7. Upload tests — every index 1..N MUST land or the testset enumeration
    //    breaks ("Tests are enumerated incorrectly"). So: retry each test, use
    //    checkExisting:false (duplicate-content tests must still be written), and
    //    NEVER silently skip — a permanent failure aborts commit+verify below.
    let testsComplete = true;
    const allGroups = [...new Set(parsed.tests.map(t => t.group))]
      .sort((a, b) => Number(a) - Number(b));

    if (parsed.tests.length > 0) {
      await step(`Uploading ${parsed.tests.length} tests...`, async () => {
        const failed: number[] = [];
        for (const t of parsed.tests) {
          const ok = await saveTestWithRetry(pid, t);
          if (!ok) failed.push(t.index);
          await sleep(100); // ease Polygon's per-request rate limit
        }
        if (failed.length > 0) {
          testsComplete = false;
          throw new Error(
            `${failed.length}/${parsed.tests.length} test(s) failed after retries ` +
            `(indices ${failed.join(', ')}). Skipping commit & verify to avoid a ` +
            `gapped testset — re-run the import to fill the gaps.`
          );
        }
        return `${parsed.tests.length}/${parsed.tests.length} tests uploaded`;
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
              checkExisting: false,
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

    // 9 & 10. Commit + verify — only if the testset is complete. A gapped testset
    //    would make the verify build fail with "Tests are enumerated incorrectly",
    //    so we skip both and leave the problem uncommitted for a clean re-import.
    if (testsComplete) {
      // Commit — required because the API can only verify a committed revision
      // (Polygon's working-copy "Verify" button is not exposed via the API).
      await step('Committing changes...', async () => {
        await api.problem.commitChanges(pid, { message: 'Import via Polygon Middleman' });
        return 'Changes committed';
      });

      // buildPackage with verify=true runs all solutions on all tests and the
      // checker on stress tests to confirm the tags are valid.
      await step('Requesting verification (build package)...', async () => {
        await api.problem.buildPackage(pid, false, true);
        return 'Verification build requested';
      });
    } else {
      addLog('Skipped commit & verify — testset incomplete (see test error above)', 'error');
      errors++;
    }

    return { failed: false, errors };
  };

  const handleImport = async () => {
    const toImport = items.filter(i => i.parsed);
    if (toImport.length === 0) return;

    setPhase('uploading');
    setImporting(true);
    setLog([]);
    const runResults: ImportResult[] = [];

    for (let i = 0; i < toImport.length; i++) {
      const item = toImport[i];
      const parsed = item.parsed!;
      addLog(`Problem ${i + 1}/${toImport.length}: ${parsed.displayName}`, 'running', 'header');
      try {
        const { failed, errors } = await importProblem(parsed);
        updateHeader(parsed.displayName, failed ? 'error' : errors > 0 ? 'error' : 'done');
        runResults.push({ name: parsed.displayName, ok: !failed && errors === 0, errors, failed });
      } catch (err) {
        // Unexpected error in the per-problem pipeline — log and keep going
        addLog(`Unexpected error: ${err instanceof Error ? err.message : 'Unknown'}`, 'error');
        updateHeader(parsed.displayName, 'error');
        runResults.push({ name: parsed.displayName, ok: false, errors: 1, failed: true });
      }
    }

    setResults(runResults);
    setPhase('done');
    setImporting(false);

    const fullOk = runResults.filter(r => r.ok).length;
    const partial = runResults.filter(r => !r.ok && !r.failed).length;
    const failed = runResults.filter(r => r.failed).length;
    if (failed === 0 && partial === 0) {
      toast('success', `All ${fullOk} problem(s) imported successfully!`);
    } else {
      toast('warning', `Done: ${fullOk} clean, ${partial} with warnings, ${failed} failed — check the log`);
    }
  };

  // Mark a header entry done/error once its problem finishes
  const updateHeader = (displayName: string, status: LogEntry['status']) =>
    setLog((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].kind === 'header' && next[i].text.includes(displayName)) {
          next[i] = { ...next[i], status };
          break;
        }
      }
      return next;
    });

  const okCount = items.filter(i => i.parsed).length;
  const badCount = items.length - okCount;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Import Problems from ZIP"
      size="lg"
      footer={
        phase === 'select' ? (
          <Button variant="ghost" onClick={handleClose}>Cancel</Button>
        ) : phase === 'preview' ? (
          <>
            <Button variant="ghost" onClick={() => { setItems([]); setPhase('select'); }}>Back</Button>
            <Button variant="primary" icon={<Upload className="w-4 h-4" />} onClick={handleImport} disabled={okCount === 0}>
              Import {okCount} Problem{okCount !== 1 ? 's' : ''}
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
            Select one or more ZIP files. Each ZIP should contain a single problem with this structure:
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
                <span className="text-sm text-gray-400">Parsing ZIP files...</span>
              </>
            ) : (
              <>
                <Archive className="w-8 h-8 text-gray-500 mb-2" />
                <span className="text-sm text-gray-500">Click to select ZIP file(s)</span>
                <span className="text-xs text-gray-600 mt-1">select multiple to batch-import</span>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".zip"
              multiple
              className="sr-only"
              onChange={handleFileSelect}
              disabled={parsing}
            />
          </label>
        </div>
      )}

      {phase === 'preview' && items.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-gray-400">
            {okCount} problem{okCount !== 1 ? 's' : ''} ready to import
            {badCount > 0 && <span className="text-yellow-400"> · {badCount} could not be read</span>}
          </p>
          <div className="space-y-2 max-h-[26rem] overflow-y-auto pr-1">
            {items.map((item, idx) => (
              <div key={idx} className={`border rounded-lg overflow-hidden ${item.parsed ? 'border-[#362f28]' : 'border-red-500/30'}`}>
                <div className="bg-[#211e1a] px-3 py-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {item.parsed
                      ? <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                      : <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />}
                    <span className="text-sm font-medium text-gray-200 truncate">
                      {item.parsed ? item.parsed.displayName : item.fileName}
                    </span>
                  </div>
                  {item.parsed && (
                    <span className="text-xs text-gray-600 font-mono flex-shrink-0">{item.parsed.problemName}</span>
                  )}
                </div>
                {item.parsed ? (
                  <div className="px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    <span className="text-gray-500">
                      Langs: <span className="text-gray-300 capitalize">{Object.keys(item.parsed.languages).join(', ') || 'none'}</span>
                    </span>
                    <span className="text-gray-500">
                      Tests: <span className="text-gray-300">{item.parsed.tests.length}</span>
                      {item.parsed.tests.length > 0 && (
                        <span className="text-gray-600"> (groups {[...new Set(item.parsed.tests.map(t => t.group))].sort((a, b) => Number(a) - Number(b)).join(',')})</span>
                      )}
                    </span>
                    <span className={item.parsed.checkerCode ? 'text-green-400' : 'text-yellow-400'}>checker {item.parsed.checkerCode ? '✓' : '✗'}</span>
                    <span className={item.parsed.solutionCode ? 'text-green-400' : 'text-yellow-400'}>solution {item.parsed.solutionCode ? '✓' : '✗'}</span>
                    {!item.parsed.hasScoring && <span className="text-gray-600">no scoring → 100pts on last group</span>}
                  </div>
                ) : (
                  <div className="px-3 py-2 text-xs text-red-400">{item.parseError}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {(phase === 'uploading' || phase === 'done') && (
        <div className="space-y-3">
          <div className="space-y-1.5 max-h-80 overflow-y-auto">
            {log.map((entry, i) => (
              entry.kind === 'header' ? (
                <div key={i} className="flex items-center gap-2 mt-3 first:mt-0 pb-1 border-b border-[#362f28]">
                  {entry.status === 'running' && <Loader2 className="w-4 h-4 text-amber-400 animate-spin flex-shrink-0" />}
                  {entry.status === 'done' && <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />}
                  {entry.status === 'error' && <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />}
                  <span className="text-sm font-semibold text-amber-300">{entry.text}</span>
                </div>
              ) : (
                <div key={i} className="flex items-start gap-2 pl-1">
                  {entry.status === 'running' && <Loader2 className="w-4 h-4 text-amber-400 animate-spin flex-shrink-0 mt-0.5" />}
                  {entry.status === 'done' && <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />}
                  {entry.status === 'error' && <X className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />}
                  {entry.status === 'pending' && <div className="w-4 h-4 rounded-full border border-gray-600 flex-shrink-0 mt-0.5" />}
                  <span className={`text-sm ${entry.status === 'error' ? 'text-red-400' : entry.status === 'done' ? 'text-gray-300' : 'text-gray-400'}`}>
                    {entry.text}
                  </span>
                </div>
              )
            ))}
          </div>
          {phase === 'done' && results.length > 0 && (
            <div className="bg-[#1a1714] border border-[#362f28] rounded-lg p-3 space-y-1.5">
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Summary</div>
              {results.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  {r.failed
                    ? <X className="w-4 h-4 text-red-400 flex-shrink-0" />
                    : r.ok
                      ? <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                      : <AlertCircle className="w-4 h-4 text-yellow-400 flex-shrink-0" />}
                  <span className="text-gray-300">{r.name}</span>
                  <span className="text-xs text-gray-600">
                    {r.failed ? 'failed' : r.ok ? 'imported' : `imported with ${r.errors} warning${r.errors !== 1 ? 's' : ''}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Save one test, retrying transient failures (rate limits, heavy payloads).
 * Uses checkExisting:false so duplicate-content tests are still written at their
 * assigned index — otherwise Polygon rejects the duplicate and the index is left
 * empty, corrupting the testset enumeration. Returns true if the test landed.
 */
async function saveTestWithRetry(
  pid: number,
  t: { index: number; input: string; group: string },
  retries = 3,
): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await api.problem.saveTest({
        problemId: pid,
        testset: 'tests',
        testIndex: t.index,
        testInput: t.input,
        testGroup: t.group,
        testUseInStatements: t.group === '0',
        checkExisting: false,
      });
      return true;
    } catch {
      if (attempt < retries) await sleep(500 * (attempt + 1)); // linear backoff
    }
  }
  return false;
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
