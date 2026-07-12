import { useState, useRef, useEffect } from 'react';
import { Archive, Upload, Loader2, Copy, RotateCcw, History } from 'lucide-react';
import JSZip from 'jszip';
import { api, AppSettings } from '../api/client';
import { useApp } from '../context/AppContext';
import { Problem } from '../types/polygon';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import { deriveDependenciesFromScoring, derivePointsFromScoring } from '../utils/statementParser';
import {
  loadImportHistory, appendImportHistory, clearImportHistory, ImportHistoryEntry,
} from '../utils/importHistory';
import {
  ParsedZip, ParsedItem, ImportResult, ImportOpts, BatchOverride, LogEntry,
  DiffInfo, VerifyStatus, Phase, FALLBACK_SETTINGS,
} from './zipImport/types';
import { parseZip } from './zipImport/parseZip';
import { sleep, saveTestWithRetry } from './zipImport/helpers';
import PreviewList from './zipImport/PreviewList';
import ProgressView from './zipImport/ProgressView';
import HistoryPanel from './zipImport/HistoryPanel';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ZipImport({ open, onClose }: Props) {
  const { toast } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>('select');
  const [parsing, setParsing] = useState(false);
  const [items, setItems] = useState<ParsedItem[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ImportHistoryEntry[]>(() => loadImportHistory());
  // Lowercased name → problemId for problems already on Polygon (slug-conflict
  // warnings + the "what changes?" diff).
  const [existingByName, setExistingByName] = useState<Map<string, number>>(new Map());
  // Per-item change preview (keyed by item index): what a fill/reset would touch.
  const [diffs, setDiffs] = useState<Record<number, DiffInfo | 'loading'>>({});
  // Import defaults from Settings + an optional per-batch override (default off).
  const [settings, setSettings] = useState<AppSettings>(FALLBACK_SETTINGS);
  const [batch, setBatch] = useState<BatchOverride>({
    enabled: false,
    timeLimit: FALLBACK_SETTINGS.default_time_limit,
    memoryLimit: FALLBACK_SETTINGS.default_memory_limit,
    checkerType: FALLBACK_SETTINGS.checker_source_type,
    solutionType: FALLBACK_SETTINGS.solution_source_type,
  });

  // Load import defaults from Settings whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    api.settings.get().then((s) => {
      const merged = { ...FALLBACK_SETTINGS, ...s };
      setSettings(merged);
      setBatch((b) => b.enabled ? b : {
        enabled: false,
        timeLimit: merged.default_time_limit,
        memoryLimit: merged.default_memory_limit,
        checkerType: merged.checker_source_type,
        solutionType: merged.solution_source_type,
      });
    }).catch(() => {});
  }, [open]);

  const updateItem = (idx: number, patch: Partial<ParsedItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const hideDiff = (idx: number) => setDiffs((d) => { const n = { ...d }; delete n[idx]; return n; });

  // Background verification poller. buildPackage(verify=true) only STARTS the
  // build; we poll problem.packages for each problem still 'verifying' and flip
  // it to passed/failed when its latest package reaches READY/FAILED — without
  // ever blocking the import of other problems.
  useEffect(() => {
    if (phase !== 'done') return;
    const pending = results.filter(r => r.verifyStatus === 'verifying' && r.problemId);
    if (pending.length === 0) return;

    let cancelled = false;
    interface Pkg { id: number; state?: string; comment?: string; creationTimeSeconds?: number }

    const pollOnce = async () => {
      for (const r of pending) {
        if (cancelled) return;
        try {
          const res = await api.problem.packages(r.problemId!) as { result?: Pkg[] };
          const pkgs = res.result || [];
          if (pkgs.length === 0) continue;
          const latest = pkgs.reduce((a, b) =>
            (b.creationTimeSeconds ?? b.id) > (a.creationTimeSeconds ?? a.id) ? b : a);
          if (latest.state === 'READY' || latest.state === 'FAILED') {
            const status: VerifyStatus = latest.state === 'READY' ? 'passed' : 'failed';
            setResults(prev => prev.map(x =>
              x.problemId === r.problemId ? { ...x, verifyStatus: status, verifyComment: latest.comment } : x));
          }
        } catch { /* transient — try again next tick */ }
      }
    };

    const iv = setInterval(pollOnce, 4000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [phase, results]);

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

  const handleClose = () => {
    if (importing) return;
    setItems([]);
    setResults([]);
    setDiffs({});
    setExistingByName(new Map());
    setPhase('select');
    setLog([]);
    onClose();
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    e.target.value = '';

    setDiffs({});
    setParsing(true);
    const parsedItems: ParsedItem[] = [];
    for (const file of files) {
      try {
        const zip = await JSZip.loadAsync(file);
        const result = await parseZip(zip);
        parsedItems.push({
          fileName: file.name,
          parsed: result,
          skip: false,
          onExists: 'fill',
          slug: result.problemName,
          timeLimit: settings.default_time_limit,
          memoryLimit: settings.default_memory_limit,
        });
      } catch (err) {
        parsedItems.push({
          fileName: file.name,
          parsed: null,
          parseError: err instanceof Error ? err.message : 'Failed to parse ZIP',
          skip: false,
          onExists: 'fill',
          slug: '',
          timeLimit: 1000,
          memoryLimit: 256,
        });
      }
    }
    setItems(parsedItems);
    setParsing(false);
    setPhase('preview');

    const ok = parsedItems.filter(i => i.parsed).length;
    const bad = parsedItems.length - ok;
    if (bad > 0) toast('warning', `Parsed ${ok} ZIP(s); ${bad} could not be read`);

    // Pre-check: fetch existing problems so the preview can flag slug conflicts
    // (matched locally, so it updates live as the slug is edited).
    try {
      const listRes = await api.problems.list({}) as { result?: Problem[] };
      const map = new Map<string, number>();
      for (const p of listRes.result || []) map.set(p.name.toLowerCase(), p.id);
      setExistingByName(map);
    } catch { /* preview still works without the pre-check */ }
  };

  // Fetch what a fill/reset would touch for an existing problem (tests count,
  // statement languages, checker) so the user can see the impact before import.
  const loadDiff = async (idx: number, problemId: number, parsed: ParsedZip) => {
    setDiffs((d) => ({ ...d, [idx]: 'loading' }));
    try {
      const [testsRes, stmtRes, checkerRes] = await Promise.all([
        api.problem.tests(problemId, 'tests', true).catch(() => ({ result: [] })),
        api.problem.statements(problemId).catch(() => ({ result: {} })),
        api.problem.checker(problemId).catch(() => ({ result: '' })),
      ]);
      const curTests = Array.isArray((testsRes as { result?: unknown }).result) ? (testsRes as { result: unknown[] }).result.length : 0;
      const curLangs = Object.keys(((stmtRes as { result?: Record<string, unknown> }).result) || {});
      const curChecker = String((checkerRes as { result?: unknown }).result || '') || '(none)';
      setDiffs((d) => ({
        ...d,
        [idx]: { curTests, newTests: parsed.tests.length, curLangs, newLangs: Object.keys(parsed.languages), curChecker },
      }));
    } catch {
      hideDiff(idx);
      toast('error', 'Failed to load current problem state');
    }
  };

  // Upload a single parsed problem. Returns step-level errors + the problem id.
  const importProblem = async (parsed: ParsedZip, opts: ImportOpts): Promise<{ failed: boolean; errors: number; problemId?: number; verifyRequested?: boolean }> => {
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

    // 1. Create-or-resolve the problem. Polygon's problem.create THROWS
    //    ("you already have such problem") when the slug exists, so we treat that
    //    as an existing problem and resolve its id from problems.list.
    let problemId: number | undefined;
    let existed = false;
    addLog(`Creating problem "${opts.slug}"...`, 'running');
    try {
      const createRes = await api.problems.create(opts.slug) as { result?: Problem };
      problemId = createRes.result?.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already\s+have|already\s+exists|such\s+problem/i.test(msg)) {
        existed = true;
      } else {
        updateLastLog('error', `Failed to create problem — ${msg}`);
        return { failed: true, errors: errors + 1 };
      }
    }
    // Resolve the id by name when create didn't return one (existing problem, or
    // Polygon's occasional omission of result.id on a fresh create).
    if (!problemId) {
      try {
        const listRes = await api.problems.list({}) as { result?: unknown };
        const all: Problem[] = Array.isArray((listRes as { result?: unknown }).result) ? (listRes as { result: Problem[] }).result : [];
        const target = opts.slug;
        const found =
          all.find((p) => p.name === target) ??
          all.find((p) => p.name.toLowerCase() === target.toLowerCase());
        problemId = found?.id;
      } catch { /* fall through to failure below */ }
    }
    if (!problemId) {
      updateLastLog('error', `Failed to resolve problem "${opts.slug}" (${existed ? 'exists but not found in list' : 'id not returned'})`);
      return { failed: true, errors: errors + 1 };
    }

    const pid = problemId;

    // Apply the on-exists policy for a problem that already existed.
    if (existed) {
      if (opts.onExists === 'reset') {
        updateLastLog('done', `Exists (#${pid}) — reset & overwrite`);
        await step('Discarding working copy...', async () => {
          await api.problem.discardWorkingCopy(pid);
          return 'Working copy discarded';
        });
      } else {
        updateLastLog('done', `Exists (#${pid}) — filling / updating`);
      }
    } else {
      updateLastLog('done', `Created problem #${pid}`);
    }

    // 2. Update info
    await step(`Setting problem info (TL=${opts.timeLimit}ms, ML=${opts.memoryLimit}MB)...`, async () => {
      await api.problem.updateInfo({
        problemId: pid, inputFile: 'stdin', outputFile: 'stdout', interactive: false,
        timeLimit: opts.timeLimit, memoryLimit: opts.memoryLimit,
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
            problemId: pid, lang: langCode, encoding: 'UTF-8',
            name: sections.name, legend: sections.legend, input: sections.input,
            output: sections.output, scoring: sections.scoring,
            interaction: sections.interaction, notes: sections.notes,
          });
        }
        return `Statements saved: ${langs.join(', ')}`;
      });
    }

    // 4. Upload checker (source type from Settings / batch override)
    if (parsed.checkerCode) {
      await step('Uploading checker.cpp...', async () => {
        const checkerFile = new File([new Blob([parsed.checkerCode!], { type: 'text/plain' })], 'checker.cpp', { type: 'text/plain' });
        await api.problem.saveFile(pid, 'source', 'checker.cpp', checkerFile, opts.checkerType);
        await api.problem.setChecker(pid, 'checker.cpp');
        return 'Checker uploaded & set';
      });
    }

    // 4b. Upload validator (optional; same source type as the checker)
    if (parsed.validatorCode) {
      await step('Uploading validator.cpp...', async () => {
        const vFile = new File([new Blob([parsed.validatorCode!], { type: 'text/plain' })], 'validator.cpp', { type: 'text/plain' });
        await api.problem.saveFile(pid, 'source', 'validator.cpp', vFile, opts.checkerType);
        await api.problem.setValidator(pid, 'validator.cpp');
        return 'Validator uploaded & set';
      });
    }

    // 5. Upload main solution (always solution.cpp → MA)
    if (parsed.solutionCode) {
      await step('Uploading solution.cpp [MA]...', async () => {
        const solFile = new File([new Blob([parsed.solutionCode!], { type: 'text/plain' })], 'solution.cpp', { type: 'text/plain' });
        await api.problem.saveSolution(pid, 'solution.cpp', solFile, 'MA', opts.solutionType);
        return 'Solution uploaded (MA)';
      });
    }

    // 5b. Upload extra solutions with their detected tags (WA/TL/ML/RE/…)
    if (parsed.extraSolutions.length > 0) {
      await step(`Uploading ${parsed.extraSolutions.length} extra solution(s)...`, async () => {
        let uploaded = 0;
        const labels: string[] = [];
        for (const s of parsed.extraSolutions) {
          try {
            const file = new File([new Blob([s.code], { type: 'text/plain' })], s.filename, { type: 'text/plain' });
            await api.problem.saveSolution(pid, s.filename, file, s.tag, opts.solutionType);
            uploaded++;
            labels.push(`${s.filename} [${s.tag}]`);
          } catch { /* continue with the rest */ }
        }
        if (uploaded === 0) throw new Error('all extra solutions failed');
        return `Extra solutions: ${labels.join(', ')}`;
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
    const allGroups = [...new Set(parsed.tests.map(t => t.group))].sort((a, b) => Number(a) - Number(b));

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

    // 8. Configure group policies, dependencies, and points.
    //    - If the statement HAS a scoring section: auto-run "derive dependencies"
    //      and "derive points" (parse the scoring table for per-group deps/points).
    //    - Otherwise: last group depends on all others + 100 points on the last group.
    if (allGroups.length > 0) {
      await step('Configuring group policies...', async () => {
        // Re-send enable commands to be safe (Polygon may need them after tests exist)
        await api.problem.enableGroups(pid, 'tests', true);
        await api.problem.enablePoints(pid, true);

        const nonSampleGroups = allGroups.filter(g => g !== '0');

        // Helper: set points on the first test of a group (input already in memory)
        const setGroupPoints = async (group: string, pts: number) => {
          const t = parsed.tests.find((x) => x.group === group);
          if (!t) return false;
          await api.problem.saveTest({
            problemId: pid, testset: 'tests', testIndex: t.index, testInput: t.input,
            testGroup: group, testPoints: pts, checkExisting: false,
          });
          return true;
        };

        if (parsed.hasScoring) {
          // Derive per-group deps + points straight from the scoring section
          const depMap = deriveDependenciesFromScoring(parsed.scoringText);
          const pointsMap = derivePointsFromScoring(parsed.scoringText);

          for (const group of allGroups) {
            const deps = depMap[group];
            await api.problem.saveTestGroup({
              problemId: pid, testset: 'tests', group, pointsPolicy: 'COMPLETE_GROUP',
              ...(deps && deps.length ? { dependencies: deps.join(',') } : {}),
            });
          }

          let ptsApplied = 0;
          for (const [group, pts] of Object.entries(pointsMap)) {
            if (await setGroupPoints(group, pts)) ptsApplied++;
          }

          const depCount = Object.keys(depMap).length;
          return `Derived from scoring — deps: ${depCount} group(s), points: ${ptsApplied} group(s) (COMPLETE_GROUP)`;
        }

        // No scoring: last group depends on all others + 100pts on last group
        const lastGroup = allGroups[allGroups.length - 1];
        const otherGroups = allGroups.filter(g => g !== lastGroup);

        for (const group of allGroups) {
          const deps = group === lastGroup && otherGroups.length > 0 ? otherGroups.join(',') : undefined;
          await api.problem.saveTestGroup({
            problemId: pid, testset: 'tests', group, pointsPolicy: 'COMPLETE_GROUP',
            ...(deps ? { dependencies: deps } : {}),
          });
        }

        let ptsInfo = '';
        if (nonSampleGroups.length > 0) {
          const pointsGroup = nonSampleGroups[nonSampleGroups.length - 1];
          if (await setGroupPoints(pointsGroup, 100)) ptsInfo = `, 100pts on group ${pointsGroup}`;
        }
        const depInfo = otherGroups.length > 0 ? `, group ${lastGroup} depends on ${otherGroups.join(',')}` : '';
        return `Groups configured (COMPLETE_GROUP)${depInfo}${ptsInfo}`;
      });
    }

    // 9 & 10. Commit + verify — ONLY if every previous step succeeded. If any
    //    step errored (or the testset is incomplete), we skip commit & verify and
    //    leave the problem uncommitted for a clean re-import / retry.
    let verifyRequested = false;
    if (errors === 0 && testsComplete) {
      // Commit — required because the API can only verify a committed revision
      // (Polygon's working-copy "Verify" button is not exposed via the API).
      await step('Committing changes...', async () => {
        await api.problem.commitChanges(pid, { message: 'Import via Polygon Middleman' });
        return 'Changes committed';
      });

      // Only request verification if the commit itself also succeeded.
      if (errors === 0) {
        // buildPackage(verify=true) only STARTS the build; we do NOT wait for it
        // here. The batch moves on to the next problem and a background poller
        // reports each verification's pass/fail as it completes.
        addLog('Requesting verification (build package)...', 'running');
        try {
          await api.problem.buildPackage(pid, false, true);
          updateLastLog('done', 'Verification requested (building in background)');
          verifyRequested = true;
        } catch (err) {
          errors++;
          updateLastLog('error', `Verification request failed — ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }
    } else {
      addLog('Skipped commit & verify — an earlier step failed (fix and retry)', 'error');
    }

    return { failed: false, errors, problemId: pid, verifyRequested };
  };

  // Run the pipeline for one parsed problem, logging a header + returning a result.
  const runImportFor = async (parsed: ParsedZip, opts: ImportOpts, headerLabel: string): Promise<ImportResult> => {
    addLog(headerLabel, 'running', 'header');
    try {
      const { failed, errors, problemId, verifyRequested } = await importProblem(parsed, opts);
      updateHeader(parsed.displayName, failed || errors > 0 ? 'error' : 'done');
      return {
        name: parsed.displayName, slug: opts.slug, problemId,
        ok: !failed && errors === 0, errors, failed,
        verifyRequested, verifyStatus: verifyRequested ? 'verifying' : undefined,
        parsed, opts,
      };
    } catch (err) {
      addLog(`Unexpected error: ${err instanceof Error ? err.message : 'Unknown'}`, 'error');
      updateHeader(parsed.displayName, 'error');
      return { name: parsed.displayName, slug: opts.slug, ok: false, errors: 1, failed: true, parsed, opts };
    }
  };

  const announce = (rs: ImportResult[]) => {
    const fullOk = rs.filter(r => r.ok).length;
    const partial = rs.filter(r => !r.ok && !r.failed).length;
    const failed = rs.filter(r => r.failed).length;
    if (failed === 0 && partial === 0) {
      toast('success', `Done: ${fullOk} imported — verifying in background`);
    } else {
      toast('warning', `Done: ${fullOk} clean, ${partial} with warnings, ${failed} failed — check the log`);
    }
  };

  // Persist a run's outcomes to the local import history under one batch id
  // (so the History view can group them by the run they came from).
  const recordHistory = (rs: ImportResult[]) => {
    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const ts = Date.now();
    const entries: ImportHistoryEntry[] = rs.map(r => ({
      ts, batchId, name: r.name, slug: r.slug, problemId: r.problemId,
      status: r.failed ? 'failed' : r.ok ? 'imported' : 'warnings',
    }));
    setHistory(appendImportHistory(entries));
  };

  const handleImport = async () => {
    const toImport = items.filter(i => i.parsed && !i.skip);
    if (toImport.length === 0) return;

    setPhase('uploading');
    setImporting(true);
    setLog([]);
    const runResults: ImportResult[] = [];

    for (let i = 0; i < toImport.length; i++) {
      const it = toImport[i];
      const opts: ImportOpts = {
        slug: it.slug.trim() || it.parsed!.problemName,
        // Batch override (when enabled) supersedes per-item limits.
        timeLimit: batch.enabled ? batch.timeLimit : it.timeLimit,
        memoryLimit: batch.enabled ? batch.memoryLimit : it.memoryLimit,
        onExists: it.onExists,
        checkerType: batch.enabled ? batch.checkerType : settings.checker_source_type,
        solutionType: batch.enabled ? batch.solutionType : settings.solution_source_type,
      };
      runResults.push(await runImportFor(it.parsed!, opts, `Problem ${i + 1}/${toImport.length}: ${it.parsed!.displayName}`));
    }

    setResults(runResults);
    recordHistory(runResults);
    setPhase('done');
    setImporting(false);
    announce(runResults);
  };

  // Re-run the pipeline for a subset of already-attempted problems (retry).
  // Re-import lands in the SAME Polygon problem (name exists → resolved by
  // fallback), overwriting/filling whatever was missing. Reuses each problem's
  // original overrides.
  const handleRetry = async (targets: ImportResult[]) => {
    const retryable = targets.filter(t => t.parsed);
    if (retryable.length === 0) return;

    setPhase('uploading');
    setImporting(true);
    const updated = [...results];
    const redone: ImportResult[] = [];

    for (let i = 0; i < retryable.length; i++) {
      const t = retryable[i];
      const res = await runImportFor(t.parsed, t.opts, `Retry ${i + 1}/${retryable.length}: ${t.parsed.displayName}`);
      const idx = updated.findIndex(r => r.name === res.name);
      if (idx >= 0) updated[idx] = res; else updated.push(res);
      redone.push(res);
    }

    setResults(updated);
    recordHistory(redone);
    setPhase('done');
    setImporting(false);
    announce(updated);
  };

  // Copy slugs (one per line, CRLF so each lands on its own line everywhere).
  const copySlugs = async (slugs: string[], label: string) => {
    if (slugs.length === 0) { toast('error', 'Nothing to copy'); return; }
    try {
      await navigator.clipboard.writeText(slugs.join('\r\n'));
      toast('success', `Copied ${slugs.length} slug(s) ${label}`);
    } catch {
      toast('error', 'Clipboard copy failed');
    }
  };

  const handleClearHistory = () => { clearImportHistory(); setHistory([]); };

  const failedResults = results.filter(r => !r.ok);
  const okCount = items.filter(i => i.parsed).length;
  const badCount = items.length - okCount;
  const importCount = items.filter(i => i.parsed && !i.skip).length;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Import Problems from ZIP"
      size="lg"
      footer={
        phase === 'select' ? (
          <>
            <Button variant="ghost" icon={<History className="w-4 h-4" />} onClick={() => setShowHistory(v => !v)}>
              History{history.length > 0 ? ` (${history.length})` : ''}
            </Button>
            <Button variant="ghost" onClick={handleClose}>Cancel</Button>
          </>
        ) : phase === 'preview' ? (
          <>
            <Button variant="ghost" onClick={() => { setItems([]); setPhase('select'); }}>Back</Button>
            <Button variant="primary" icon={<Upload className="w-4 h-4" />} onClick={handleImport} disabled={importCount === 0}>
              Import {importCount} Problem{importCount !== 1 ? 's' : ''}
            </Button>
          </>
        ) : phase === 'done' ? (
          <>
            {results.length > 0 && (
              <Button variant="ghost" icon={<Copy className="w-4 h-4" />} onClick={() => copySlugs(results.map(r => r.slug), 'to clipboard')}>
                Copy slugs
              </Button>
            )}
            {failedResults.length > 0 && (
              <Button variant="secondary" icon={<RotateCcw className="w-4 h-4" />} onClick={() => handleRetry(failedResults)}>
                Retry {failedResults.length} failed
              </Button>
            )}
            <Button variant="primary" onClick={handleClose}>Close</Button>
          </>
        ) : null
      }
    >
      {phase === 'select' && showHistory && (
        <HistoryPanel
          history={history}
          onCopyAll={() => copySlugs(history.map(h => h.slug), 'from history')}
          onCopyBatch={(slugs) => copySlugs(slugs, 'from this batch')}
          onClear={handleClearHistory}
          onBack={() => setShowHistory(false)}
        />
      )}

      {phase === 'select' && !showHistory && (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            Select one or more ZIP files. Each ZIP should contain a single problem with this structure:
          </p>
          <div className="text-xs text-gray-500 bg-[#1a1714] rounded-lg p-3 font-mono space-y-0.5">
            <div>edu-problem-name/</div>
            <div className="pl-4">problem_statement.mdx</div>
            <div className="pl-4">checker.cpp</div>
            <div className="pl-4">solution.cpp<span className="text-gray-600">    # main → MA</span></div>
            <div className="pl-4">validator.cpp<span className="text-gray-600">   # optional</span></div>
            <div className="pl-4">wa_*.cpp / tle_*.cpp<span className="text-gray-600">  # optional, tagged by prefix</span></div>
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
            <input ref={fileRef} type="file" accept=".zip" multiple className="sr-only" onChange={handleFileSelect} disabled={parsing} />
          </label>
        </div>
      )}

      {phase === 'preview' && items.length > 0 && (
        <PreviewList
          items={items}
          updateItem={updateItem}
          batch={batch}
          setBatch={setBatch}
          existingByName={existingByName}
          diffs={diffs}
          loadDiff={loadDiff}
          hideDiff={hideDiff}
          okCount={okCount}
          badCount={badCount}
        />
      )}

      {(phase === 'uploading' || phase === 'done') && (
        <ProgressView log={log} results={results} phase={phase} onRetry={handleRetry} />
      )}
    </Modal>
  );
}
