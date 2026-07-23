import { useState, useRef, useEffect, useCallback } from 'react';
import { Archive, Upload, Loader2, Copy, RotateCcw, History, Plus, Trash2 } from 'lucide-react';
import JSZip from 'jszip';
import { api, AppSettings } from '../api/client';
import { useApp } from '../context/AppContext';
import { Problem } from '../types/polygon';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import {
  loadImportHistory, appendImportHistory, clearImportHistory, ImportHistoryEntry,
} from '../utils/importHistory';
import { requestNotifyPermission, notify } from '../utils/notify';
import {
  ParsedZip, ParsedItem, ImportOpts, ImportJob, BatchOverride,
  DiffInfo, Phase, FALLBACK_SETTINGS,
} from './zipImport/types';
import { parseZip } from './zipImport/parseZip';
import { mergeParsedGroup, baseProblemSlug } from './zipImport/merge';
import { useImportQueue } from './zipImport/useImportQueue';
import PreviewList from './zipImport/PreviewList';
import QueueView from './zipImport/QueueView';
import HistoryPanel from './zipImport/HistoryPanel';

interface Props {
  open: boolean;
  onClose: () => void;
}

let jobSeq = 0;

export default function ZipImport({ open, onClose }: Props) {
  const { toast } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>('select');
  const [parsing, setParsing] = useState(false);
  const [items, setItems] = useState<ParsedItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ImportHistoryEntry[]>(() => loadImportHistory());
  const [existingByName, setExistingByName] = useState<Map<string, number>>(new Map());
  const [diffs, setDiffs] = useState<Record<number, DiffInfo | 'loading'>>({});
  const [settings, setSettings] = useState<AppSettings>(FALLBACK_SETTINGS);
  const [concurrency, setConcurrency] = useState(2);
  const [batch, setBatch] = useState<BatchOverride>({
    enabled: false,
    timeLimit: FALLBACK_SETTINGS.default_time_limit,
    memoryLimit: FALLBACK_SETTINGS.default_memory_limit,
    checkerType: FALLBACK_SETTINGS.checker_source_type,
    solutionType: FALLBACK_SETTINGS.solution_source_type,
  });

  // Record each job to local history as it settles (stable identity so the
  // queue's settled-effect doesn't re-run).
  const recordJob = useCallback((job: ImportJob) => {
    setHistory(appendImportHistory([{
      ts: Date.now(),
      batchId: job.batchId,
      name: job.name,
      slug: job.slug,
      problemId: job.problemId,
      status: job.status === 'failed' ? 'failed' : job.status === 'warnings' ? 'warnings' : 'imported',
    }]));
  }, []);

  const { jobs, enqueue, retryJob, retryFailed, clearFinished, activeCount } = useImportQueue(concurrency, recordJob);

  // Desktop notification when the queue drains (active → idle). The error/warning
  // variant is silent (no sound) so it's noticeable but not annoying. Fires even
  // when the modal is closed, since this component stays mounted and jobs run on.
  const wasActive = useRef(false);
  useEffect(() => {
    const active = jobs.some(j => j.status === 'queued' || j.status === 'running');
    if (wasActive.current && !active && jobs.length > 0) {
      const done = jobs.filter(j => j.status === 'done').length;
      const warn = jobs.filter(j => j.status === 'warnings').length;
      const failed = jobs.filter(j => j.status === 'failed').length;
      if (failed > 0 || warn > 0) {
        const body = [`${done} imported`, warn && `${warn} with warnings`, failed && `${failed} failed`].filter(Boolean).join(' · ');
        if (!notify('Import queue finished with issues', body, { silent: true })) {
          toast('warning', `Import finished — ${body}`);
        }
      } else {
        if (!notify('Import queue finished', `${done} problem${done !== 1 ? 's' : ''} imported`)) {
          toast('success', `Import finished — ${done} imported`);
        }
      }
    }
    wasActive.current = active;
  }, [jobs, toast]);

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

  const handleClose = () => {
    // Jobs keep running in the background; only clear the transient select state.
    setItems([]);
    setDiffs({});
    setExistingByName(new Map());
    setShowHistory(false);
    setPhase(jobs.length > 0 ? 'queue' : 'select');
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
          fileName: file.name, parsed: result, skip: false, onExists: 'fill',
          slug: result.problemName, timeLimit: settings.default_time_limit, memoryLimit: settings.default_memory_limit,
        });
      } catch (err) {
        parsedItems.push({
          fileName: file.name, parsed: null,
          parseError: err instanceof Error ? err.message : 'Failed to parse ZIP',
          skip: false, onExists: 'fill', slug: '', timeLimit: 1000, memoryLimit: 256,
        });
      }
    }
    setItems(parsedItems);
    setParsing(false);
    setPhase('preview');

    const bad = parsedItems.filter(i => !i.parsed).length;
    if (bad > 0) toast('warning', `Parsed ${parsedItems.length - bad} ZIP(s); ${bad} could not be read`);

    // Pre-check existing problems so the preview can flag slug conflicts.
    try {
      const listRes = await api.problems.list({}) as { result?: Problem[] };
      const map = new Map<string, number>();
      for (const p of listRes.result || []) map.set(p.name.toLowerCase(), p.id);
      setExistingByName(map);
    } catch { /* preview still works without the pre-check */ }
  };

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
      setDiffs((d) => ({ ...d, [idx]: { curTests, newTests: parsed.tests.length, curLangs, newLangs: Object.keys(parsed.languages), curChecker } }));
    } catch {
      hideDiff(idx);
      toast('error', 'Failed to load current problem state');
    }
  };

  // Turn the previewed items into queue jobs and start processing. Archives that
  // share a slug (a problem split into a main archive + one or more test packs)
  // are merged into a SINGLE job, so their tests accumulate and the problem is
  // committed/verified once.
  const handleQueue = () => {
    const toImport = items.filter(i => i.parsed && !i.skip);
    if (toImport.length === 0) return;
    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const bySlug = new Map<string, ParsedItem[]>();
    for (const it of toImport) {
      const raw = it.slug.trim() || it.parsed!.problemName;
      // A tests-only pack named "<slug>-tests" appends to the base problem
      // "<slug>" — so it groups with the main archive (if selected together)
      // and, on its own, targets the existing problem instead of a new one.
      const key = it.parsed!.testsOnly ? baseProblemSlug(raw) : raw;
      const arr = bySlug.get(key) || [];
      arr.push(it);
      bySlug.set(key, arr);
    }

    const newJobs: ImportJob[] = Array.from(bySlug.entries()).map(([slug, groupItems]) => {
      // Representative = the main archive (carries content), else the first.
      const rep = groupItems.find(it => {
        const p = it.parsed!;
        return Object.keys(p.languages).length > 0 || p.checkerCode || p.solutionCode || p.validatorCode;
      }) || groupItems[0];
      const merged = mergeParsedGroup(groupItems.map(it => it.parsed!));
      const opts: ImportOpts = {
        slug,
        timeLimit: batch.enabled ? batch.timeLimit : rep.timeLimit,
        memoryLimit: batch.enabled ? batch.memoryLimit : rep.memoryLimit,
        onExists: rep.onExists,
        checkerType: batch.enabled ? batch.checkerType : settings.checker_source_type,
        solutionType: batch.enabled ? batch.solutionType : settings.solution_source_type,
      };
      const name = merged.testsOnly
        ? `${slug} — append ${merged.tests.length} tests`
        : groupItems.length > 1 ? `${merged.displayName} (${groupItems.length} archives)` : merged.displayName;
      return {
        id: `job-${++jobSeq}`, batchId, name, slug,
        parsed: merged, opts, status: 'queued' as const, log: [], errors: 0,
      };
    });

    enqueue(newJobs);
    // Ask for desktop-notification permission on this user gesture, so we can
    // ping when the queue finishes (see the settle effect above).
    requestNotifyPermission();
    setItems([]);
    setPhase('queue');
    const merges = newJobs.filter((_, i) => Array.from(bySlug.values())[i].length > 1).length;
    toast('info', `Queued ${newJobs.length} problem(s)${merges > 0 ? ` (${merges} merged from multiple archives)` : ''}`);
  };

  const copySlugs = async (slugs: string[], label: string) => {
    if (slugs.length === 0) { toast('error', 'Nothing to copy'); return; }
    try {
      await navigator.clipboard.writeText(slugs.join('\r\n'));
      toast('success', `Copied ${slugs.length} slug(s) ${label}`);
    } catch { toast('error', 'Clipboard copy failed'); }
  };

  const handleClearHistory = () => { clearImportHistory(); setHistory([]); };

  const okCount = items.filter(i => i.parsed).length;
  const badCount = items.length - okCount;
  const importCount = items.filter(i => i.parsed && !i.skip).length;
  const failedJobs = jobs.filter(j => j.status === 'failed' || j.status === 'warnings').length;

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
            {jobs.length > 0 && (
              <Button variant="secondary" onClick={() => setPhase('queue')}>
                Queue ({activeCount > 0 ? `${activeCount} active` : jobs.length})
              </Button>
            )}
            <Button variant="ghost" onClick={handleClose}>Cancel</Button>
          </>
        ) : phase === 'preview' ? (
          <>
            <Button variant="ghost" onClick={() => { setItems([]); setPhase(jobs.length > 0 ? 'queue' : 'select'); }}>Back</Button>
            <Button variant="primary" icon={<Upload className="w-4 h-4" />} onClick={handleQueue} disabled={importCount === 0}>
              {jobs.length > 0 ? 'Add' : 'Import'} {importCount} Problem{importCount !== 1 ? 's' : ''}
            </Button>
          </>
        ) : phase === 'queue' ? (
          <>
            <Button variant="secondary" icon={<Plus className="w-4 h-4" />} onClick={() => { setItems([]); setPhase('select'); }}>
              Add more
            </Button>
            {jobs.length > 0 && (
              <Button variant="ghost" icon={<Copy className="w-4 h-4" />} onClick={() => copySlugs(jobs.map(j => j.slug), 'from the queue')}>
                Copy slugs
              </Button>
            )}
            {failedJobs > 0 && (
              <Button variant="ghost" icon={<RotateCcw className="w-4 h-4" />} onClick={retryFailed}>
                Retry {failedJobs}
              </Button>
            )}
            <Button variant="ghost" icon={<Trash2 className="w-4 h-4" />} onClick={clearFinished} disabled={jobs.every(j => j.status === 'queued' || j.status === 'running')}>
              Clear done
            </Button>
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
            <div className="pl-4">tutorial.mdx<span className="text-gray-600">    # optional editorial, same languages</span></div>
            <div className="pl-4">checker.cpp</div>
            <div className="pl-4">solution.cpp<span className="text-gray-600">    # main → MA</span></div>
            <div className="pl-4">validator.cpp<span className="text-gray-600">   # optional</span></div>
            <div className="pl-4">wa_*.cpp / tle_*.cpp<span className="text-gray-600">  # optional, tagged by prefix</span></div>
            <div className="pl-4">testset/</div>
            <div className="pl-8">input_s0_idx0.txt</div>
            <div className="pl-8">input_s1_idx0.txt</div>
            <div className="pl-8">...</div>
          </div>
          <div className="text-xs text-amber-300/80 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 space-y-1">
            <p className="font-medium text-amber-300">Big test sets: split across archives</p>
            <p>
              Add extra test packs named <span className="font-mono">edu-problem-name-tests.zip</span> containing only
              <span className="font-mono"> edu-problem-name/testset/…</span>. Select the main archive and all its test
              packs together — they merge into one problem, tests keyed by filename (append/replace, never clobbered),
              committed &amp; verified once. Keep test indices unique across packs.
            </p>
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
                <span className="text-xs text-gray-600 mt-1">select multiple to batch-import · add more anytime while the queue runs</span>
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

      {phase === 'queue' && (
        <QueueView jobs={jobs} concurrency={concurrency} setConcurrency={setConcurrency} onRetryJob={retryJob} />
      )}
    </Modal>
  );
}
