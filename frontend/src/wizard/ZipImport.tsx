import { useState, useRef, useEffect } from 'react';
import {
  Archive, Upload, CheckCircle2, Loader2, X, AlertCircle, Copy, RotateCcw,
  History, Trash2, ExternalLink,
} from 'lucide-react';
import JSZip from 'jszip';
import { api, AppSettings } from '../api/client';
import { useApp } from '../context/AppContext';
import { Problem } from '../types/polygon';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import {
  convertMdxToLatex, splitMultiLanguage, parseLatexStatement, ParsedSections,
  deriveDependenciesFromScoring, derivePointsFromScoring,
} from '../utils/statementParser';
import { extractGroupFromFilename } from '../utils/testParser';
import {
  loadImportHistory, appendImportHistory, clearImportHistory, ImportHistoryEntry,
} from '../utils/importHistory';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ExtraSolution { filename: string; code: string; tag: string }

interface ParsedZip {
  problemName: string;
  displayName: string;
  languages: Record<string, ParsedSections>;
  checkerCode: string | null;
  validatorCode: string | null;
  solutionCode: string | null;
  extraSolutions: ExtraSolution[];
  tests: { index: number; input: string; group: string; filename: string }[];
  hasScoring: boolean;
  scoringText: string;
  warnings: string[];
}

interface LogEntry { text: string; status: 'pending' | 'running' | 'done' | 'error'; kind?: 'header' }

// What to do when a problem with the same slug already exists on Polygon.
//   fill  — upload the archive over it (adds missing, overwrites changed) [default]
//   reset — discard the working copy first, then upload (hard overwrite)
type OnExists = 'fill' | 'reset';

const ON_EXISTS_LABEL: Record<OnExists, string> = {
  fill: 'Fill / update',
  reset: 'Reset & overwrite',
};

// Background verification (buildPackage) outcome per problem.
type VerifyStatus = 'verifying' | 'passed' | 'failed';

// Fallback import defaults (used until Settings load, and as the seed for the
// optional per-batch override panel).
const FALLBACK_SETTINGS: AppSettings = {
  enable_groups: true,
  enable_points: true,
  checker_source_type: 'cpp.gcc14-64-msys2-g++23',
  solution_source_type: 'cpp.g++17',
  default_time_limit: 1000,
  default_memory_limit: 256,
};

interface HistoryBatch { key: string; ts: number; entries: ImportHistoryEntry[] }

/** Group history entries by their import run (batchId), preserving order. */
function groupHistory(history: ImportHistoryEntry[]): HistoryBatch[] {
  const groups: HistoryBatch[] = [];
  const byId = new Map<string, number>();
  for (const h of history) {
    const key = h.batchId || `legacy-${h.ts}`;
    let gi = byId.get(key);
    if (gi === undefined) {
      gi = groups.length;
      byId.set(key, gi);
      groups.push({ key, ts: h.ts, entries: [] });
    }
    groups[gi].entries.push(h);
  }
  return groups;
}

/** Per-problem, user-editable overrides applied at import time. */
interface ImportOpts {
  slug: string;
  timeLimit: number;
  memoryLimit: number;
  onExists: OnExists;
  checkerType: string;
  solutionType: string;
}

/** Optional per-batch override of the Settings import defaults. */
interface BatchOverride {
  enabled: boolean;
  timeLimit: number;
  memoryLimit: number;
  checkerType: string;
  solutionType: string;
}

interface ParsedItem {
  fileName: string;
  parsed: ParsedZip | null;
  parseError?: string;
  skip: boolean;        // exclude this ZIP from the batch entirely
  onExists: OnExists;   // what to do if the slug already exists on Polygon
  slug: string;         // editable Polygon slug (defaults to folder name)
  timeLimit: number;    // ms
  memoryLimit: number;  // MB
}

interface ImportResult {
  name: string;
  slug: string;
  problemId?: number;
  ok: boolean;
  errors: number;
  failed?: boolean;
  verifyRequested?: boolean;
  verifyStatus?: VerifyStatus;
  verifyComment?: string;
  parsed: ParsedZip;
  opts: ImportOpts;
}

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
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ImportHistoryEntry[]>(() => loadImportHistory());
  // Lowercased names of problems already on Polygon (for slug-conflict warnings).
  const [existingNames, setExistingNames] = useState<Set<string>>(new Set());
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

    // Pre-check: fetch existing problem names so the preview can flag slug
    // conflicts (matched locally, so it updates live as the slug is edited).
    try {
      const listRes = await api.problems.list({}) as { result?: Problem[] };
      setExistingNames(new Set((listRes.result || []).map(p => p.name.toLowerCase())));
    } catch { /* preview still works without the pre-check */ }
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
        problemId: pid,
        inputFile: 'stdin',
        outputFile: 'stdout',
        interactive: false,
        timeLimit: opts.timeLimit,
        memoryLimit: opts.memoryLimit,
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

    // 4. Upload checker (source type from Settings / batch override)
    if (parsed.checkerCode) {
      await step('Uploading checker.cpp...', async () => {
        const checkerBlob = new Blob([parsed.checkerCode!], { type: 'text/plain' });
        const checkerFile = new File([checkerBlob], 'checker.cpp', { type: 'text/plain' });
        await api.problem.saveFile(pid, 'source', 'checker.cpp', checkerFile, opts.checkerType);
        await api.problem.setChecker(pid, 'checker.cpp');
        return 'Checker uploaded & set';
      });
    }

    // 4b. Upload validator (optional; same source type as the checker)
    if (parsed.validatorCode) {
      await step('Uploading validator.cpp...', async () => {
        const vBlob = new Blob([parsed.validatorCode!], { type: 'text/plain' });
        const vFile = new File([vBlob], 'validator.cpp', { type: 'text/plain' });
        await api.problem.saveFile(pid, 'source', 'validator.cpp', vFile, opts.checkerType);
        await api.problem.setValidator(pid, 'validator.cpp');
        return 'Validator uploaded & set';
      });
    }

    // 5. Upload main solution (always solution.cpp → MA)
    if (parsed.solutionCode) {
      await step('Uploading solution.cpp [MA]...', async () => {
        const solBlob = new Blob([parsed.solutionCode!], { type: 'text/plain' });
        const solFile = new File([solBlob], 'solution.cpp', { type: 'text/plain' });
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
            const blob = new Blob([s.code], { type: 'text/plain' });
            const file = new File([blob], s.filename, { type: 'text/plain' });
            await api.problem.saveSolution(pid, s.filename, file, s.tag, opts.solutionType);
            uploaded++;
            labels.push(`${s.filename} [${s.tag}]`);
          } catch {
            // continue with the rest
          }
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
            problemId: pid, testset: 'tests',
            testIndex: t.index, testInput: t.input,
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
              problemId: pid,
              testset: 'tests',
              group,
              pointsPolicy: 'COMPLETE_GROUP',
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

        let ptsInfo = '';
        if (nonSampleGroups.length > 0) {
          const pointsGroup = nonSampleGroups[nonSampleGroups.length - 1];
          if (await setGroupPoints(pointsGroup, 100)) ptsInfo = `, 100pts on group ${pointsGroup}`;
        }
        const depInfo = otherGroups.length > 0
          ? `, group ${lastGroup} depends on ${otherGroups.join(',')}`
          : '';
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
      ts,
      batchId,
      name: r.name,
      slug: r.slug,
      problemId: r.problemId,
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
      // The problem now exists (created on the first attempt), so retry overwrites
      // in place using its original fill/reset policy.
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

  // Copy the slugs of every problem in the run (one per line), including
  // failed ones — the slug is what you paste to build a contest.
  const copySlugs = async (slugs: string[], label: string) => {
    if (slugs.length === 0) { toast('error', 'Nothing to copy'); return; }
    // CRLF so each slug lands on its own line everywhere (incl. Windows Notepad).
    const text = slugs.join('\r\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('success', `Copied ${slugs.length} slug(s) ${label}`);
    } catch {
      toast('error', 'Clipboard copy failed');
    }
  };

  const copyImportedList = () => copySlugs(results.map(r => r.slug), 'to clipboard');
  const copyHistoryList = () => copySlugs(history.map(h => h.slug), 'from history');

  const handleClearHistory = () => { clearImportHistory(); setHistory([]); };

  const failedResults = results.filter(r => !r.ok);

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
              <Button variant="ghost" icon={<Copy className="w-4 h-4" />} onClick={copyImportedList}>
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
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-200">Import History</h3>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" icon={<Copy className="w-3.5 h-3.5" />} onClick={copyHistoryList} disabled={history.length === 0}>
                Copy slugs
              </Button>
              <Button variant="ghost" size="sm" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={handleClearHistory} disabled={history.length === 0}>
                Clear
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setShowHistory(false)}>Back</Button>
            </div>
          </div>
          {history.length === 0 ? (
            <p className="text-sm text-gray-600">No imports recorded yet.</p>
          ) : (
            <div className="space-y-3 max-h-[24rem] overflow-y-auto pr-1">
              {groupHistory(history).map((batch) => (
                <div key={batch.key} className="border border-[#362f28] rounded-lg overflow-hidden">
                  <div className="bg-[#211e1a] px-3 py-1.5 flex items-center justify-between gap-2">
                    <span className="text-xs text-gray-400">
                      {new Date(batch.ts).toLocaleString()} · <span className="text-gray-500">{batch.entries.length} problem{batch.entries.length !== 1 ? 's' : ''}</span>
                    </span>
                    <button
                      onClick={() => copySlugs(batch.entries.map(e => e.slug), 'from this batch')}
                      className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
                    >
                      <Copy className="w-3 h-3" />Copy slugs
                    </button>
                  </div>
                  <div className="divide-y divide-[#362f28]/40">
                    {batch.entries.map((h, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm py-1.5 px-3">
                        {h.status === 'imported'
                          ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                          : h.status === 'warnings'
                            ? <AlertCircle className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
                            : <X className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />}
                        <span className="text-gray-300 truncate">{h.name}</span>
                        <span className="text-xs font-mono text-gray-600 truncate">{h.slug}</span>
                        {h.problemId && (
                          <a
                            href={`https://polygon.codeforces.com/edit-start?problemId=${h.problemId}`}
                            target="_blank" rel="noreferrer"
                            className="ml-auto text-xs font-mono text-amber-400 hover:text-amber-300 flex items-center gap-0.5 flex-shrink-0"
                          >
                            #{h.problemId}<ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
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

          {/* Optional per-batch override of the Settings import defaults */}
          <div className="border border-[#362f28] rounded-lg overflow-hidden">
            <label className="flex items-center gap-2 px-3 py-2 bg-[#211e1a] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={batch.enabled}
                onChange={(e) => setBatch({ ...batch, enabled: e.target.checked })}
                className="rounded accent-amber-500"
              />
              <span className="text-sm text-gray-300">Override import defaults for this batch</span>
              <span className="text-xs text-gray-600">(otherwise uses Settings)</span>
            </label>
            {batch.enabled && (
              <div className="px-3 py-2.5 grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-xs text-gray-500">
                  Checker source type
                  <input value={batch.checkerType} onChange={(e) => setBatch({ ...batch, checkerType: e.target.value })}
                    className="bg-[#1a1714] border border-[#362f28] rounded px-2 py-1 text-xs font-mono text-gray-200 focus:outline-none focus:border-amber-500" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-gray-500">
                  Solution source type
                  <input value={batch.solutionType} onChange={(e) => setBatch({ ...batch, solutionType: e.target.value })}
                    className="bg-[#1a1714] border border-[#362f28] rounded px-2 py-1 text-xs font-mono text-gray-200 focus:outline-none focus:border-amber-500" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-gray-500">
                  Time limit (ms) — applies to all
                  <input type="number" min={250} step={250} value={batch.timeLimit}
                    onChange={(e) => setBatch({ ...batch, timeLimit: Number(e.target.value) || 1000 })}
                    className="bg-[#1a1714] border border-[#362f28] rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-amber-500" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-gray-500">
                  Memory limit (MB) — applies to all
                  <input type="number" min={64} step={64} value={batch.memoryLimit}
                    onChange={(e) => setBatch({ ...batch, memoryLimit: Number(e.target.value) || 256 })}
                    className="bg-[#1a1714] border border-[#362f28] rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-amber-500" />
                </label>
              </div>
            )}
          </div>

          <div className="space-y-2 max-h-[26rem] overflow-y-auto pr-1">
            {items.map((item, idx) => (
              <div key={idx} className={`border rounded-lg overflow-hidden ${!item.parsed ? 'border-red-500/30' : item.skip ? 'border-[#2a251f] opacity-55' : 'border-[#362f28]'}`}>
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
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <label className="flex items-center gap-1.5 text-xs text-gray-500">
                        If exists
                        <select
                          value={item.onExists}
                          onChange={(e) => updateItem(idx, { onExists: e.target.value as OnExists })}
                          disabled={item.skip}
                          className="bg-[#1a1714] border border-[#362f28] rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-amber-500 disabled:opacity-50"
                        >
                          {(Object.keys(ON_EXISTS_LABEL) as OnExists[]).map((k) => (
                            <option key={k} value={k}>{ON_EXISTS_LABEL[k]}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={item.skip}
                          onChange={(e) => updateItem(idx, { skip: e.target.checked })}
                          className="rounded accent-amber-500"
                        />
                        Skip
                      </label>
                    </div>
                  )}
                </div>
                {item.parsed ? (
                  <div className="px-3 py-2.5 space-y-2">
                    {/* Editable overrides */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <label className="flex items-center gap-1.5 text-xs text-gray-500">
                        Slug
                        <input
                          value={item.slug}
                          onChange={(e) => updateItem(idx, { slug: e.target.value })}
                          className="bg-[#1a1714] border border-[#362f28] rounded px-2 py-1 text-xs font-mono text-gray-200 w-56 focus:outline-none focus:border-amber-500"
                        />
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-gray-500">
                        TL
                        <input
                          type="number" min={250} step={250}
                          value={item.timeLimit}
                          onChange={(e) => updateItem(idx, { timeLimit: Number(e.target.value) || 1000 })}
                          className="bg-[#1a1714] border border-[#362f28] rounded px-2 py-1 text-xs text-gray-200 w-20 focus:outline-none focus:border-amber-500"
                        />
                        <span className="text-gray-600">ms</span>
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-gray-500">
                        ML
                        <input
                          type="number" min={64} step={64}
                          value={item.memoryLimit}
                          onChange={(e) => updateItem(idx, { memoryLimit: Number(e.target.value) || 256 })}
                          className="bg-[#1a1714] border border-[#362f28] rounded px-2 py-1 text-xs text-gray-200 w-20 focus:outline-none focus:border-amber-500"
                        />
                        <span className="text-gray-600">MB</span>
                      </label>
                    </div>

                    {/* Component summary */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
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
                      {item.parsed.validatorCode && <span className="text-green-400">validator ✓</span>}
                      {item.parsed.extraSolutions.length > 0 && (
                        <span className="text-gray-500">+{item.parsed.extraSolutions.length} sol ({item.parsed.extraSolutions.map(s => s.tag).join(',')})</span>
                      )}
                      {!item.parsed.hasScoring && <span className="text-gray-600">no scoring → 100pts on last group</span>}
                    </div>

                    {/* Slug conflict warning */}
                    {existingNames.has(item.slug.trim().toLowerCase()) && (
                      <div className="flex items-center gap-1.5 text-xs text-amber-400">
                        <AlertCircle className="w-3 h-3 flex-shrink-0" />
                        A problem with this slug already exists on Polygon — it will be <strong className="font-semibold">{ON_EXISTS_LABEL[item.onExists].toLowerCase()}</strong>, or change the slug above.
                      </div>
                    )}

                    {/* Validation warnings */}
                    {item.parsed.warnings.length > 0 && (
                      <div className="flex flex-col gap-0.5">
                        {item.parsed.warnings.map((w, wi) => (
                          <div key={wi} className="flex items-center gap-1.5 text-xs text-yellow-400/90">
                            <AlertCircle className="w-3 h-3 flex-shrink-0" />{w}
                          </div>
                        ))}
                      </div>
                    )}
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
                  {r.problemId && (
                    <a
                      href={`https://polygon.codeforces.com/edit-start?problemId=${r.problemId}`}
                      target="_blank" rel="noreferrer"
                      className="text-xs font-mono text-amber-400 hover:text-amber-300 flex items-center gap-0.5"
                    >
                      #{r.problemId}<ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  <span className="text-xs text-gray-600">
                    {r.failed ? 'failed' : r.ok ? 'imported' : `imported with ${r.errors} warning${r.errors !== 1 ? 's' : ''}`}
                  </span>
                  {r.verifyStatus === 'verifying' && (
                    <span className="flex items-center gap-1 text-xs text-amber-400/90">
                      <Loader2 className="w-3 h-3 animate-spin" />verifying
                    </span>
                  )}
                  {r.verifyStatus === 'passed' && (
                    <span className="text-xs text-green-400">✓ verified</span>
                  )}
                  {r.verifyStatus === 'failed' && (
                    <span className="text-xs text-red-400" title={r.verifyComment || ''}>✗ verification failed</span>
                  )}
                  {!r.ok && (
                    <button
                      onClick={() => handleRetry([r])}
                      className="ml-auto flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Retry
                    </button>
                  )}
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

async function parseZip(zip: JSZip): Promise<ParsedZip> {
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

  return {
    problemName, displayName, languages,
    checkerCode, validatorCode, solutionCode, extraSolutions,
    tests, hasScoring, scoringText, warnings,
  };
}
