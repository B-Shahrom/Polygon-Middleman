import { useState, useRef } from 'react';
import {
  ChevronRight, ChevronLeft, Check, Search, Plus, Upload, Archive,
  AlertCircle, CheckCircle2, Loader2, X
} from 'lucide-react';
import JSZip from 'jszip';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { Problem, SolutionTag } from '../types/polygon';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import { Input, Textarea, Select } from '../components/ui/Input';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface StepState {
  // Step 1: Problem
  problemMode: 'existing' | 'new';
  selectedProblem: Problem | null;
  newProblemName: string;
  resolvedProblemId: number | null;

  // Step 2: Info
  timeLimit: number;
  memoryLimit: number;
  inputFile: string;
  outputFile: string;
  interactive: boolean;

  // Step 3: Statement
  lang: string;
  stmtName: string;
  legend: string;
  input: string;
  output: string;
  scoring: string;
  notes: string;

  // Step 4: Checker
  checkerMode: 'standard' | 'custom';
  standardChecker: string;
  checkerFile: File | null;

  // Step 5: Validator
  skipValidator: boolean;
  validatorFile: File | null;

  // Step 6: Solutions
  solutions: { file: File; tag: SolutionTag; sourceType: string }[];

  // Step 7: Tests
  testFiles: { index: number; input: string; filename?: string }[];
  testZipFile: File | null;
}

const INITIAL: StepState = {
  problemMode: 'new',
  selectedProblem: null,
  newProblemName: '',
  resolvedProblemId: null,
  timeLimit: 1000,
  memoryLimit: 256,
  inputFile: 'stdin',
  outputFile: 'stdout',
  interactive: false,
  lang: 'english',
  stmtName: '',
  legend: '',
  input: '',
  output: '',
  scoring: '',
  notes: '',
  checkerMode: 'custom',
  standardChecker: 'wcmp',
  checkerFile: null,
  skipValidator: true,
  validatorFile: null,
  solutions: [],
  testFiles: [],
  testZipFile: null,
};

const STANDARD_CHECKERS = ['fcmp', 'hcmp', 'lcmp', 'ncmp', 'nyesno', 'rcmp4', 'rcmp6', 'rcmp9', 'wcmp', 'yesno'];
const SOLUTION_TAGS: { value: SolutionTag; label: string }[] = [
  { value: 'MA', label: 'Main correct solution' },
  { value: 'OK', label: 'Correct' },
  { value: 'RJ', label: 'Incorrect' },
  { value: 'TL', label: 'Time limit exceeded' },
  { value: 'TO', label: 'Time limit exceeded or correct' },
  { value: 'TM', label: 'TL or ML exceeded' },
  { value: 'WA', label: 'Wrong answer' },
  { value: 'PE', label: 'Presentation error' },
  { value: 'ML', label: 'Memory limit exceeded' },
  { value: 'RE', label: 'Runtime error' },
  { value: 'NR', label: 'Do not run' },
  { value: 'FL', label: 'Failed' },
];
const LANGUAGES = ['english', 'russian', 'arabic', 'french', 'spanish', 'portuguese', 'chinese', 'turkish'];
const SOURCE_TYPES = [
  { value: 'cpp.g++17', label: 'C++ 17' },
  { value: 'cpp.g++20', label: 'C++ 20' },
  { value: 'cpp.g++14', label: 'C++ 14' },
  { value: 'java.11', label: 'Java 11' },
  { value: 'python.3', label: 'Python 3' },
];

const STEPS = [
  'Problem',
  'Info',
  'Statement',
  'Checker',
  'Validator',
  'Solutions',
  'Tests',
  'Commit',
];

interface UploadLogEntry { text: string; status: 'pending' | 'running' | 'done' | 'error' }

export default function UploadWizard({ open, onClose }: Props) {
  const { problems, toast } = useApp();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<StepState>(INITIAL);
  const [searchQuery, setSearchQuery] = useState('');
  const [creating, setCreating] = useState(false);

  // Upload phase
  const [uploading, setUploading] = useState(false);
  const [uploadLog, setUploadLog] = useState<UploadLogEntry[]>([]);
  const [uploadDone, setUploadDone] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);

  const zipRef = useRef<HTMLInputElement>(null);

  const upd = (patch: Partial<StepState>) => setState((s) => ({ ...s, ...patch }));

  const filteredProblems = problems.filter(
    (p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      String(p.id).includes(searchQuery)
  );

  // ── Step 1: Select / Create problem ────────────────────────────────────────

  const handleStep1Next = async () => {
    if (state.problemMode === 'new') {
      if (!state.newProblemName.trim()) { toast('error', 'Enter a problem name'); return; }
      setCreating(true);
      try {
        const createRaw = await api.problems.create(state.newProblemName.trim());
        console.log('[Wizard] problem.create raw response:', JSON.stringify(createRaw));
        const res = createRaw as { result?: Problem };
        let problemId = res.result?.id;
        let problemName = res.result?.name ?? state.newProblemName.trim();
        // Fallback: Polygon's problem.create sometimes omits result.id.
        // Fetch the full problem list and locate by name (client-side match).
        if (!problemId) {
          const listRaw = await api.problems.list({});
          console.log('[Wizard] problems.list fallback raw response:', JSON.stringify(listRaw));
          const listRes = listRaw as { result?: unknown };
          const all: Problem[] = Array.isArray(listRes.result) ? listRes.result : [];
          const target = state.newProblemName.trim();
          console.log('[Wizard] searching for name:', JSON.stringify(target), 'in', all.map(p => p.name));
          const found =
            all.find((p) => p.name === target) ??
            all.find((p) => p.name.toLowerCase() === target.toLowerCase());
          problemId = found?.id;
          if (found) problemName = found.name;
        }
        if (!problemId) throw new Error('Problem was created but its ID could not be retrieved.');
        upd({ resolvedProblemId: problemId });
        toast('success', `Problem "${problemName}" created (#${problemId})`);
        setStep(1);
      } catch (e: unknown) {
        toast('error', e instanceof Error ? e.message : 'Failed to create problem');
      } finally {
        setCreating(false);
      }
    } else {
      if (!state.selectedProblem) { toast('error', 'Select a problem'); return; }
      upd({ resolvedProblemId: state.selectedProblem.id });
      setStep(1);
    }
  };

  // ── Step 7: ZIP tests ──────────────────────────────────────────────────────

  const handleZipSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    upd({ testZipFile: file });
    try {
      const zip = await JSZip.loadAsync(file);
      const items: { index: number; input: string; filename: string }[] = [];
      const fileNames = Object.keys(zip.files).sort();
      for (const name of fileNames) {
        const entry = zip.files[name];
        if (entry.dir) continue;
        const content = await entry.async('string');
        const m = name.match(/[_\-]?(\d+)[_\-.]/) || name.match(/^(\d+)/);
        const idx = m ? parseInt(m[1], 10) : items.length + 1;
        items.push({ index: idx, input: content, filename: name });
      }
      items.sort((a, b) => a.index - b.index);
      items.forEach((it, i) => { it.index = i + 1; });
      upd({ testFiles: items });
      toast('info', `Parsed ${items.length} tests from ZIP`);
    } catch {
      toast('error', 'Failed to parse ZIP file');
    }
    e.target.value = '';
  };

  // ── Upload phase ──────────────────────────────────────────────────────────

  const addLog = (text: string, status: UploadLogEntry['status'] = 'pending') =>
    setUploadLog((prev) => [...prev, { text, status }]);

  const updateLastLog = (status: UploadLogEntry['status'], text?: string) =>
    setUploadLog((prev) => {
      const next = [...prev];
      if (next.length > 0) {
        next[next.length - 1] = { ...next[next.length - 1], status, ...(text ? { text } : {}) };
      }
      return next;
    });

  const handleUpload = async () => {
    const pid = state.resolvedProblemId!;
    setUploading(true);
    setUploadLog([]);

    try {
      // 1. Problem info
      addLog('Updating problem info...', 'running');
      await api.problem.updateInfo({
        problemId: pid,
        inputFile: state.inputFile,
        outputFile: state.outputFile,
        interactive: state.interactive,
        timeLimit: state.timeLimit,
        memoryLimit: state.memoryLimit,
      });
      updateLastLog('done', '✓ Problem info updated');

      // 2. Statement
      if (state.stmtName || state.legend || state.input || state.output) {
        addLog('Saving statement...', 'running');
        await api.problem.saveStatement({
          problemId: pid,
          lang: state.lang,
          name: state.stmtName,
          legend: state.legend,
          input: state.input,
          output: state.output,
          scoring: state.scoring,
          notes: state.notes,
        });
        updateLastLog('done', '✓ Statement saved');
      }

      // 3. Checker
      if (state.checkerMode === 'custom' && state.checkerFile) {
        addLog(`Uploading checker: ${state.checkerFile.name}...`, 'running');
        await api.problem.saveFile(pid, 'source', state.checkerFile.name, state.checkerFile, 'cpp.g++17');
        await api.problem.setChecker(pid, state.checkerFile.name);
        updateLastLog('done', `✓ Checker: ${state.checkerFile.name}`);
      } else if (state.checkerMode === 'standard') {
        addLog(`Setting standard checker: ${state.standardChecker}...`, 'running');
        await api.problem.setChecker(pid, state.standardChecker);
        updateLastLog('done', `✓ Checker: ${state.standardChecker}`);
      }

      // 4. Validator
      if (!state.skipValidator && state.validatorFile) {
        addLog(`Uploading validator: ${state.validatorFile.name}...`, 'running');
        await api.problem.saveFile(pid, 'source', state.validatorFile.name, state.validatorFile, 'cpp.g++17');
        await api.problem.setValidator(pid, state.validatorFile.name);
        updateLastLog('done', `✓ Validator: ${state.validatorFile.name}`);
      }

      // 5. Solutions
      for (const sol of state.solutions) {
        addLog(`Uploading solution: ${sol.file.name} [${sol.tag}]...`, 'running');
        await api.problem.saveSolution(pid, sol.file.name, sol.file, sol.tag, sol.sourceType || undefined);
        updateLastLog('done', `✓ Solution: ${sol.file.name} [${sol.tag}]`);
      }

      // 6. Tests
      if (state.testFiles.length > 0) {
        addLog(`Uploading ${state.testFiles.length} tests...`, 'running');
        let uploaded = 0;
        for (const t of state.testFiles) {
          try {
            await api.problem.saveTest({
              problemId: pid,
              testset: 'tests',
              testIndex: t.index,
              testInput: t.input,
              checkExisting: true,
            });
            uploaded++;
          } catch {
            // continue
          }
        }
        updateLastLog('done', `✓ Tests: ${uploaded}/${state.testFiles.length} uploaded`);
      }

      setUploadDone(true);
      toast('success', 'All files uploaded successfully!');
    } catch (e: unknown) {
      updateLastLog('error', `✗ Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
      toast('error', 'Upload failed. See log for details.');
    } finally {
      setUploading(false);
    }
  };

  const handleCommit = async () => {
    const pid = state.resolvedProblemId!;
    setCommitting(true);
    try {
      await api.problem.commitChanges(pid, { message: commitMsg || 'Upload via Polygon Middleman' });
      toast('success', 'Changes committed!');
      handleClose();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Commit failed');
    } finally {
      setCommitting(false);
    }
  };

  const handleClose = () => {
    if (uploading) return;
    setState(INITIAL);
    setStep(0);
    setUploadLog([]);
    setUploadDone(false);
    setCommitMsg('');
    setSearchQuery('');
    onClose();
  };

  const canNext = () => {
    if (step === 0) return true;
    if (step === 6) return state.testFiles.length > 0 || true; // tests optional
    return true;
  };

  return (
    <Modal open={open} onClose={handleClose} title="Problem Upload Wizard" size="xl">
      <div className="flex flex-col h-full" style={{ minHeight: 480 }}>
        {/* Step indicator */}
        <div className="flex items-center gap-1 mb-6 overflow-x-auto pb-1">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-1 flex-shrink-0">
              <div className={`
                flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold transition-colors
                ${i < step ? 'bg-green-500 text-white' : i === step ? 'bg-amber-500 text-white' : 'bg-[#2c2722] text-gray-600'}
              `}>
                {i < step ? <Check className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <span className={`text-xs whitespace-nowrap ${i === step ? 'text-amber-300' : i < step ? 'text-gray-500' : 'text-gray-700'}`}>
                {s}
              </span>
              {i < STEPS.length - 1 && <ChevronRight className="w-3 h-3 text-gray-700 ml-1" />}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto">
          {/* Step 0: Select Problem */}
          {step === 0 && (
            <div className="space-y-4">
              <div className="flex rounded-lg overflow-hidden border border-[#362f28] w-fit">
                {(['new', 'existing'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => upd({ problemMode: m })}
                    className={`px-4 py-2 text-sm font-medium transition-colors ${
                      state.problemMode === m ? 'bg-amber-600 text-white' : 'bg-[#211e1a] text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {m === 'new' ? '+ New Problem' : 'Select Existing'}
                  </button>
                ))}
              </div>

              {state.problemMode === 'new' ? (
                <Input
                  label="Problem Name"
                  placeholder="e.g. A Plus B"
                  value={state.newProblemName}
                  onChange={(e) => upd({ newProblemName: e.target.value })}
                  autoFocus
                />
              ) : (
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                    <input
                      placeholder="Search problems..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full bg-[#211e1a] border border-[#362f28] rounded-lg pl-9 pr-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg border border-[#362f28] bg-[#1a1714] p-1">
                    {filteredProblems.length === 0 && (
                      <p className="text-gray-600 text-sm p-3">No problems found.</p>
                    )}
                    {filteredProblems.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => upd({ selectedProblem: p })}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                          state.selectedProblem?.id === p.id
                            ? 'bg-amber-500/20 text-amber-300'
                            : 'hover:bg-[#2c2722] text-gray-400'
                        }`}
                      >
                        <span className="font-mono text-xs text-gray-600 w-12">#{p.id}</span>
                        <span className="text-sm">{p.name}</span>
                        {state.selectedProblem?.id === p.id && <Check className="w-4 h-4 ml-auto text-amber-400" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 1: Problem Info */}
          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">Set time limit, memory limit, and I/O files.</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">Time Limit (ms)</label>
                  <input type="number" value={state.timeLimit} onChange={(e) => upd({ timeLimit: Number(e.target.value) })}
                    className="w-full bg-[#211e1a] border border-[#362f28] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-500 font-mono" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">Memory Limit (MB)</label>
                  <input type="number" value={state.memoryLimit} onChange={(e) => upd({ memoryLimit: Number(e.target.value) })}
                    className="w-full bg-[#211e1a] border border-[#362f28] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-500 font-mono" />
                </div>
                <Input label="Input File" value={state.inputFile} onChange={(e) => upd({ inputFile: e.target.value })} placeholder="stdin" />
                <Input label="Output File" value={state.outputFile} onChange={(e) => upd({ outputFile: e.target.value })} placeholder="stdout" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={state.interactive} onChange={(e) => upd({ interactive: e.target.checked })} className="rounded accent-amber-500" />
                <span className="text-sm text-gray-400">Interactive problem</span>
              </label>
            </div>
          )}

          {/* Step 2: Statement */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">Language</label>
                  <select value={state.lang} onChange={(e) => upd({ lang: e.target.value })}
                    className="w-full bg-[#211e1a] border border-[#362f28] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-500">
                    {LANGUAGES.map((l) => <option key={l} value={l} className="bg-[#211e1a]">{l}</option>)}
                  </select>
                </div>
                <Input label="Problem Name" value={state.stmtName} onChange={(e) => upd({ stmtName: e.target.value })} placeholder="e.g. A Plus B" />
              </div>
              <Textarea label="Legend" value={state.legend} onChange={(e) => upd({ legend: e.target.value })} rows={5} mono placeholder="Story and problem description..." />
              <div className="grid grid-cols-2 gap-4">
                <Textarea label="Input Format" value={state.input} onChange={(e) => upd({ input: e.target.value })} rows={4} mono placeholder="The first line contains..." />
                <Textarea label="Output Format" value={state.output} onChange={(e) => upd({ output: e.target.value })} rows={4} mono placeholder="Print..." />
              </div>
              <Textarea label="Scoring (optional)" value={state.scoring} onChange={(e) => upd({ scoring: e.target.value })} rows={4} mono placeholder="\begin{tabular}..." />
              <Textarea label="Notes (optional)" value={state.notes} onChange={(e) => upd({ notes: e.target.value })} rows={3} mono placeholder="Explanation of examples..." />
            </div>
          )}

          {/* Step 3: Checker */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="flex rounded-lg overflow-hidden border border-[#362f28] w-fit">
                {(['custom', 'standard'] as const).map((m) => (
                  <button key={m} onClick={() => upd({ checkerMode: m })}
                    className={`px-4 py-2 text-sm font-medium transition-colors capitalize ${state.checkerMode === m ? 'bg-amber-600 text-white' : 'bg-[#211e1a] text-gray-500 hover:text-gray-300'}`}>
                    {m === 'custom' ? 'Upload checker.cpp' : 'Standard checker'}
                  </button>
                ))}
              </div>
              {state.checkerMode === 'custom' ? (
                <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-[#362f28] rounded-xl cursor-pointer hover:border-amber-500/50 transition-colors bg-[#1a1714]">
                  <Upload className="w-5 h-5 text-gray-500 mb-2" />
                  <span className="text-sm text-gray-400">{state.checkerFile ? state.checkerFile.name : 'Upload checker.cpp'}</span>
                  <input type="file" className="sr-only" accept=".cpp,.cc" onChange={(e) => upd({ checkerFile: e.target.files?.[0] || null })} />
                </label>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {STANDARD_CHECKERS.map((c) => (
                    <button key={c} onClick={() => upd({ standardChecker: c })}
                      className={`px-3 py-2 rounded-lg text-sm font-mono text-left transition-colors border ${
                        state.standardChecker === c ? 'border-amber-500 bg-amber-500/15 text-amber-300' : 'border-[#362f28] text-gray-500 hover:border-amber-500/50 hover:text-gray-300'
                      }`}>
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 4: Validator */}
          {step === 4 && (
            <div className="space-y-4">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={state.skipValidator} onChange={(e) => upd({ skipValidator: e.target.checked })} className="rounded accent-amber-500" />
                <span className="text-sm text-gray-400">Skip validator (not required for most problems)</span>
              </label>
              {!state.skipValidator && (
                <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-[#362f28] rounded-xl cursor-pointer hover:border-amber-500/50 transition-colors bg-[#1a1714]">
                  <Upload className="w-5 h-5 text-gray-500 mb-2" />
                  <span className="text-sm text-gray-400">{state.validatorFile ? state.validatorFile.name : 'Upload validator.cpp'}</span>
                  <input type="file" className="sr-only" accept=".cpp,.cc" onChange={(e) => upd({ validatorFile: e.target.files?.[0] || null })} />
                </label>
              )}
            </div>
          )}

          {/* Step 5: Solutions */}
          {step === 5 && (
            <div className="space-y-4">
              <div className="space-y-2">
                {state.solutions.map((sol, i) => (
                  <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-[#2c2722] border border-[#362f28]">
                    <span className={`tag-${sol.tag} px-2 py-0.5 rounded text-xs font-mono font-semibold`}>{sol.tag}</span>
                    <span className="text-sm font-mono text-gray-300 flex-1">{sol.file.name}</span>
                    <span className="text-xs text-gray-600">{sol.sourceType}</span>
                    <button onClick={() => upd({ solutions: state.solutions.filter((_, j) => j !== i) })}
                      className="text-gray-600 hover:text-red-400 transition-colors">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
              <AddSolutionRow onAdd={(sol) => upd({ solutions: [...state.solutions, sol] })} />
            </div>
          )}

          {/* Step 6: Tests */}
          {step === 6 && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Button variant="secondary" icon={<Archive className="w-4 h-4" />} onClick={() => zipRef.current?.click()}>
                  Upload ZIP Archive
                </Button>
                <input ref={zipRef} type="file" accept=".zip" className="sr-only" onChange={handleZipSelect} />
                {state.testFiles.length > 0 && (
                  <button onClick={() => upd({ testFiles: [], testZipFile: null })} className="text-gray-600 hover:text-red-400 transition-colors flex items-center gap-1 text-sm">
                    <X className="w-3.5 h-3.5" /> Clear
                  </button>
                )}
              </div>
              {state.testFiles.length > 0 ? (
                <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg border border-[#362f28] bg-[#1a1714] p-2">
                  {state.testFiles.map((t) => (
                    <div key={t.index} className="flex items-center gap-3 px-3 py-1.5 rounded bg-[#2c2722] text-sm">
                      <span className="font-mono text-gray-500 w-8">#{t.index}</span>
                      <span className="text-gray-600 text-xs">{t.filename}</span>
                      <span className="ml-auto text-xs text-gray-700">{t.input.length} chars</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-600">No tests loaded. Upload a ZIP archive containing test input files (named input_s0_idx0.txt, etc.).</p>
              )}
              <p className="text-xs text-gray-700">Tests are optional. You can add them later in the Tests tab.</p>
            </div>
          )}

          {/* Step 7: Upload & Commit */}
          {step === 7 && (
            <div className="space-y-4">
              {!uploadDone ? (
                <>
                  {uploadLog.length === 0 ? (
                    <div className="space-y-3">
                      <p className="text-sm text-gray-400 font-medium">Ready to upload. Review summary:</p>
                      <div className="space-y-2 text-sm text-gray-500">
                        <p>✓ Problem ID: <span className="text-amber-300 font-mono">#{state.resolvedProblemId}</span></p>
                        <p>✓ Time: {state.timeLimit}ms, Memory: {state.memoryLimit}MB</p>
                        {(state.legend || state.input) && <p>✓ Statement ({state.lang})</p>}
                        {state.checkerMode === 'custom' && state.checkerFile && <p>✓ Checker: {state.checkerFile.name}</p>}
                        {state.checkerMode === 'standard' && <p>✓ Checker: {state.standardChecker}</p>}
                        {!state.skipValidator && state.validatorFile && <p>✓ Validator: {state.validatorFile.name}</p>}
                        {state.solutions.length > 0 && <p>✓ {state.solutions.length} solution(s)</p>}
                        {state.testFiles.length > 0 && <p>✓ {state.testFiles.length} test(s)</p>}
                      </div>
                      <Button variant="primary" size="lg" icon={<Upload className="w-4 h-4" />} loading={uploading} onClick={handleUpload} className="mt-2">
                        Start Upload
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {uploadLog.map((entry, i) => (
                        <div key={i} className="flex items-center gap-3 text-sm py-1.5">
                          {entry.status === 'running' && <Loader2 className="w-4 h-4 animate-spin text-blue-400 flex-shrink-0" />}
                          {entry.status === 'done' && <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />}
                          {entry.status === 'error' && <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />}
                          {entry.status === 'pending' && <div className="w-4 h-4 rounded-full border border-gray-700 flex-shrink-0" />}
                          <span className={entry.status === 'error' ? 'text-red-400' : entry.status === 'done' ? 'text-gray-300' : 'text-gray-500'}>
                            {entry.text}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-green-400">
                    <CheckCircle2 className="w-5 h-5" />
                    <span className="font-medium">All files uploaded successfully!</span>
                  </div>
                  <Input
                    label="Commit Message"
                    placeholder="Upload via Polygon Middleman"
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                  />
                  <Button variant="primary" loading={committing} onClick={handleCommit}>
                    Commit Changes
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Navigation */}
        {step < 7 && (
          <div className="flex items-center justify-between mt-6 pt-4 border-t border-[#362f28]">
            <Button variant="ghost" icon={<ChevronLeft className="w-4 h-4" />} onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
              Back
            </Button>
            <Button variant="primary" icon={<ChevronRight className="w-4 h-4" />} loading={creating} onClick={() => {
              if (step === 0) { handleStep1Next(); return; }
              setStep(step + 1);
            }}>
              {step === 6 ? 'Review & Upload' : 'Next'}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function AddSolutionRow({ onAdd }: { onAdd: (s: { file: File; tag: SolutionTag; sourceType: string }) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [tag, setTag] = useState<SolutionTag>('MA');
  const [srcType, setSrcType] = useState('cpp.g++17');

  const handleAdd = () => {
    if (!file) return;
    onAdd({ file, tag, sourceType: srcType });
    setFile(null);
  };

  return (
    <div className="flex items-end gap-3 p-3 rounded-lg border border-dashed border-[#362f28] bg-[#1a1714]">
      <label className="flex flex-col cursor-pointer">
        <span className="text-xs text-gray-600 mb-1">Solution file</span>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#2c2722] border border-[#362f28] text-sm text-gray-400 hover:border-amber-500/50 transition-colors">
          <Upload className="w-3.5 h-3.5" />
          {file ? file.name : 'Choose file...'}
        </div>
        <input type="file" className="sr-only" accept=".cpp,.cc,.java,.py" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-600">Tag</span>
        <select value={tag} onChange={(e) => setTag(e.target.value as SolutionTag)}
          className="bg-[#2c2722] border border-[#362f28] rounded-lg px-2 py-2 text-sm text-gray-300 focus:outline-none focus:border-amber-500">
          {SOLUTION_TAGS.map((t) => <option key={t.value} value={t.value}>{t.value}</option>)}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-600">Language</span>
        <select value={srcType} onChange={(e) => setSrcType(e.target.value)}
          className="bg-[#2c2722] border border-[#362f28] rounded-lg px-2 py-2 text-sm text-gray-300 focus:outline-none focus:border-amber-500">
          {SOURCE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
      <Button variant="success" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={handleAdd} disabled={!file}>
        Add
      </Button>
    </div>
  );
}
