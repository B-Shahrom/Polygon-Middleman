import { useState, useEffect } from 'react';
import { Upload, Eye, FileCode, ClipboardPaste, Info, Trash2, Shield, CheckCircle2, Code2 } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { Solution, SolutionTag, PolygonFile, FilesResult } from '../types/polygon';
import Button from '../components/ui/Button';
import { SolutionTagBadge } from '../components/ui/Badge';
import Card from '../components/ui/Card';
import Modal from '../components/ui/Modal';
import { Select, Input, Textarea } from '../components/ui/Input';

const TAGS: { value: SolutionTag; label: string }[] = [
  { value: 'MA', label: 'Main correct solution' },
  { value: 'OK', label: 'Correct' },
  { value: 'RJ', label: 'Incorrect' },
  { value: 'TL', label: 'Time limit exceeded' },
  { value: 'TO', label: 'Time limit exceeded or correct' },
  { value: 'TM', label: 'Time limit exceeded or memory limit exceeded' },
  { value: 'WA', label: 'Wrong answer' },
  { value: 'PE', label: 'Presentation error' },
  { value: 'ML', label: 'Memory limit exceeded' },
  { value: 'RE', label: 'Runtime error' },
  { value: 'NR', label: 'Do not run' },
  { value: 'FL', label: 'Failed' },
];

const SOURCE_TYPES = [
  { value: '', label: '(Auto-detect)' },
  { value: 'cpp.g++17', label: 'C++ 17 (GCC)' },
  { value: 'cpp.g++20', label: 'C++ 20 (GCC)' },
  { value: 'cpp.g++14', label: 'C++ 14 (GCC)' },
  { value: 'java.11', label: 'Java 11' },
  { value: 'python.3', label: 'Python 3' },
  { value: 'python.pypy3', label: 'PyPy 3' },
];

const STANDARD_CHECKERS = [
  { value: '', label: '— select —' },
  { value: 'fcmp', label: "fcmp.cpp - Lines, doesn't ignore whitespaces" },
  { value: 'hcmp', label: 'hcmp.cpp - Single huge integer' },
  { value: 'lcmp', label: 'lcmp.cpp - Lines, ignores whitespaces' },
  { value: 'ncmp', label: 'ncmp.cpp - Single or more int64, ignores whitespaces' },
  { value: 'nyesno', label: 'nyesno.cpp - Zero or more yes/no, case insensitive' },
  { value: 'rcmp4', label: 'rcmp4.cpp - Single or more double, max any error 1E-4' },
  { value: 'rcmp6', label: 'rcmp6.cpp - Single or more double, max any error 1E-6' },
  { value: 'rcmp9', label: 'rcmp9.cpp - Single or more double, max any error 1E-9' },
  { value: 'wcmp', label: 'wcmp.cpp - Sequence of tokens' },
  { value: 'yesno', label: 'yesno.cpp - Single yes or no, case insensitive' },
];

function fmt(bytes: number) { return (bytes / 1024).toFixed(1) + ' KB'; }

type UploadMode = 'file' | 'paste';

interface Props { problemId: number }

export default function SolutionsTab({ problemId }: Props) {
  const { toast } = useApp();

  // ── Solutions state ──
  const [solutions, setSolutions] = useState<Solution[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMode, setUploadMode] = useState<UploadMode>('file');
  const [upFile, setUpFile] = useState<File | null>(null);
  const [upPasteCode, setUpPasteCode] = useState('');
  const [upPasteName, setUpPasteName] = useState('');
  const [upTag, setUpTag] = useState<SolutionTag>('MA');
  const [upSourceType, setUpSourceType] = useState('');
  const [viewContent, setViewContent] = useState<{ name: string; content: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // ── Checker / Validator / Interactor state ──
  const [checker, setChecker] = useState<string>('');
  const [validator, setValidator] = useState<string>('');
  const [interactor, setInteractor] = useState<string>('');
  const [sourceFiles, setSourceFiles] = useState<PolygonFile[]>([]);
  const [cvLoading, setCvLoading] = useState(true);
  const [checkerMode, setCheckerMode] = useState<'standard' | 'custom'>('standard');
  const [selectedStdChecker, setSelectedStdChecker] = useState('');
  const [selectedCustomChecker, setSelectedCustomChecker] = useState('');
  const [selectedValidator, setSelectedValidator] = useState('');
  const [selectedInteractor, setSelectedInteractor] = useState('');
  const [cvUploadOpen, setCvUploadOpen] = useState<'checker' | 'validator' | 'interactor' | null>(null);
  const [cvUpFile, setCvUpFile] = useState<File | null>(null);
  const [cvUpMode, setCvUpMode] = useState<'file' | 'paste'>('file');
  const [cvUpCode, setCvUpCode] = useState('');
  const [cvUpFileName, setCvUpFileName] = useState('');
  const [cvUploading, setCvUploading] = useState(false);
  const [setting, setSetting] = useState(false);

  const resetUploadForm = () => {
    setUpFile(null);
    setUpPasteCode('');
    setUpPasteName('');
    setUpTag('MA');
    setUpSourceType('');
    setUploadMode('file');
  };

  // ── Load solutions ──
  const loadSolutions = async () => {
    setLoading(true);
    try {
      const res = await api.problem.solutions(problemId) as { result: Solution[] };
      setSolutions(res.result || []);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to load solutions');
    } finally {
      setLoading(false);
    }
  };

  // ── Load checker/validator/interactor ──
  const loadCV = async () => {
    setCvLoading(true);
    try {
      const [checkerRes, validatorRes, interactorRes, filesRes] = await Promise.allSettled([
        api.problem.checker(problemId),
        api.problem.validator(problemId),
        api.problem.interactor(problemId),
        api.problem.files(problemId),
      ]);

      if (checkerRes.status === 'fulfilled') {
        const r = checkerRes.value as { result: string };
        const cur = r.result || '';
        setChecker(cur);
        const stdMatch = cur.match(/^std::(\w+)\.cpp$/);
        if (stdMatch && STANDARD_CHECKERS.slice(1).some(c => c.value === stdMatch[1])) {
          setCheckerMode('standard');
          setSelectedStdChecker(stdMatch[1]);
        } else if (cur) {
          setCheckerMode('custom');
          setSelectedCustomChecker(cur);
        }
      }
      if (validatorRes.status === 'fulfilled') {
        const r = validatorRes.value as { result: string };
        setValidator(r.result || '');
        setSelectedValidator(r.result || '');
      }
      if (interactorRes.status === 'fulfilled') {
        const r = interactorRes.value as { result: string };
        setInteractor(r.result || '');
        setSelectedInteractor(r.result || '');
      }
      if (filesRes.status === 'fulfilled') {
        const r = filesRes.value as { result: FilesResult };
        setSourceFiles(r.result?.sourceFiles || []);
      }
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to load checker/validator info');
    } finally {
      setCvLoading(false);
    }
  };

  useEffect(() => {
    loadSolutions();
    loadCV();
  }, [problemId]);

  // ── Solution handlers ──
  const canUpload = uploadMode === 'file'
    ? !!upFile
    : upPasteCode.trim().length > 0 && upPasteName.trim().length > 0;

  const handleUpload = async () => {
    if (!canUpload) return;
    setUploading(true);
    try {
      let file: File;
      let name: string;
      if (uploadMode === 'file') {
        file = upFile!;
        name = file.name;
      } else {
        const trimmedName = upPasteName.trim();
        name = trimmedName;
        const blob = new Blob([upPasteCode], { type: 'text/plain' });
        file = new File([blob], trimmedName);
      }
      await api.problem.saveSolution(problemId, name, file, upTag, upSourceType || undefined);
      toast('success', `${name} uploaded!`);
      setUploadOpen(false);
      resetUploadForm();
      await loadSolutions();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleView = async (name: string) => {
    try {
      const res = await api.problem.viewSolution(problemId, name);
      const text = typeof res === 'string' ? res : res instanceof Response ? await res.text() : String(res);
      setViewContent({ name, content: text });
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to view solution');
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete solution "${name}"? This will save an empty file to overwrite it.`)) return;
    setDeleting(name);
    try {
      const emptyFile = new File([''], name, { type: 'text/plain' });
      await api.problem.saveSolution(problemId, name, emptyFile, 'RJ');
      toast('success', `Solution "${name}" deleted`);
      await loadSolutions();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to delete solution');
    } finally {
      setDeleting(null);
    }
  };

  // ── Checker/Validator handlers ──
  const handleSetChecker = async () => {
    const raw = checkerMode === 'standard' ? selectedStdChecker : selectedCustomChecker;
    if (!raw) { toast('error', 'Select a checker'); return; }
    const name = checkerMode === 'standard' ? `std::${raw}.cpp` : raw;
    setSetting(true);
    try {
      await api.problem.setChecker(problemId, name);
      setChecker(name);
      toast('success', `Checker set to "${name}"`);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to set checker');
    } finally {
      setSetting(false);
    }
  };

  const handleSetValidator = async () => {
    if (!selectedValidator) { toast('error', 'Select a validator'); return; }
    setSetting(true);
    try {
      await api.problem.setValidator(problemId, selectedValidator);
      setValidator(selectedValidator);
      toast('success', `Validator set to "${selectedValidator}"`);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to set validator');
    } finally {
      setSetting(false);
    }
  };

  const handleSetInteractor = async () => {
    if (!selectedInteractor) { toast('error', 'Select an interactor'); return; }
    setSetting(true);
    try {
      await api.problem.setInteractor(problemId, selectedInteractor);
      setInteractor(selectedInteractor);
      toast('success', `Interactor set to "${selectedInteractor}"`);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to set interactor');
    } finally {
      setSetting(false);
    }
  };

  const handleCvUploadAndSet = async () => {
    if (!cvUploadOpen) return;
    let file: File;
    let fileName: string;
    if (cvUpMode === 'paste') {
      if (!cvUpCode.trim() || !cvUpFileName.trim()) { toast('error', 'Enter filename and code'); return; }
      fileName = cvUpFileName.trim().endsWith('.cpp') ? cvUpFileName.trim() : cvUpFileName.trim() + '.cpp';
      file = new File([cvUpCode], fileName, { type: 'text/plain' });
    } else {
      if (!cvUpFile) return;
      file = cvUpFile;
      fileName = cvUpFile.name;
    }
    setCvUploading(true);
    try {
      await api.problem.saveFile(problemId, 'source', fileName, file, 'cpp.g++17');
      if (cvUploadOpen === 'checker') {
        await api.problem.setChecker(problemId, fileName);
        setChecker(fileName);
      } else if (cvUploadOpen === 'validator') {
        await api.problem.setValidator(problemId, fileName);
        setValidator(fileName);
      } else {
        await api.problem.setInteractor(problemId, fileName);
        setInteractor(fileName);
      }
      toast('success', `${fileName} uploaded and set as ${cvUploadOpen}!`);
      setCvUploadOpen(null);
      setCvUpFile(null);
      setCvUpCode('');
      setCvUpFileName('');
      await loadCV();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setCvUploading(false);
    }
  };

  const sourceOptions = [
    { value: '', label: '— select —' },
    ...sourceFiles.map((f) => ({ value: f.name, label: f.name })),
  ];

  const modeButtonClass = (mode: UploadMode) =>
    `flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
      uploadMode === mode
        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
        : 'bg-[#1a1714] text-gray-500 border border-[#362f28] hover:text-gray-400 hover:border-[#3e4174]'
    }`;

  return (
    <div className="p-6 space-y-5">
      {/* ── Solutions ── */}
      <Card
        title={`Solutions (${solutions.length})`}
        actions={
          <Button variant="primary" size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => setUploadOpen(true)}>
            Upload Solution
          </Button>
        }
      >
        {loading ? (
          <p className="text-gray-600 text-sm">Loading...</p>
        ) : solutions.length === 0 ? (
          <p className="text-gray-600 text-sm">No solutions uploaded yet.</p>
        ) : (
          <div className="divide-y divide-[#362f28]/50">
            {solutions.map((s) => (
              <div key={s.name} className="flex items-center gap-4 py-3 group">
                <div className="relative group/tag">
                  <SolutionTagBadge tag={s.tag} />
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-[#211e1a] border border-[#362f28] rounded-lg shadow-xl text-xs text-gray-400 whitespace-nowrap opacity-0 pointer-events-none group-hover/tag:opacity-100 transition-opacity z-10">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Info className="w-3 h-3 text-gray-500" />
                      <span className="text-gray-300 font-medium">Current tag: {s.tag}</span>
                    </div>
                    <span>Re-upload solution to change tag</span>
                    <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px w-2 h-2 bg-[#211e1a] border-r border-b border-[#362f28] rotate-45" />
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-sm text-gray-300">{s.name}</span>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-600">
                    <span>{s.sourceType}</span>
                    <span>·</span>
                    <span>{fmt(s.length)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="ghost" size="xs" icon={<Eye className="w-3.5 h-3.5" />} onClick={() => handleView(s.name)}>
                    View
                  </Button>
                  <Button variant="danger" size="xs" icon={<Trash2 className="w-3.5 h-3.5" />} loading={deleting === s.name} onClick={() => handleDelete(s.name)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── Checker ── */}
      <Card title="Checker">
        {cvLoading ? (
          <p className="text-gray-600 text-sm">Loading...</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-500">Current:</span>
              <code className="font-mono text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded">
                {checker || '(none)'}
              </code>
            </div>

            <div className="flex rounded-lg overflow-hidden border border-[#362f28] w-fit">
              {(['standard', 'custom'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setCheckerMode(m)}
                  className={`px-4 py-2 text-sm font-medium transition-colors capitalize ${
                    checkerMode === m
                      ? 'bg-amber-600 text-white'
                      : 'bg-[#211e1a] text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            {checkerMode === 'standard' ? (
              <Select
                label="Standard Checker"
                value={selectedStdChecker}
                onChange={(e) => setSelectedStdChecker(e.target.value)}
                options={STANDARD_CHECKERS.slice(1)}
              />
            ) : (
              <Select
                label="Custom Checker (from source files)"
                value={selectedCustomChecker}
                onChange={(e) => setSelectedCustomChecker(e.target.value)}
                options={sourceOptions}
              />
            )}

            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" icon={<CheckCircle2 className="w-3.5 h-3.5" />} loading={setting} onClick={handleSetChecker}>
                Set Checker
              </Button>
              <Button variant="secondary" size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => setCvUploadOpen('checker')}>
                Upload & Set
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ── Validator ── */}
      <Card title="Validator">
        {cvLoading ? (
          <p className="text-gray-600 text-sm">Loading...</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-500">Current:</span>
              <code className="font-mono text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded">
                {validator || '(none)'}
              </code>
            </div>
            <Select
              label="Validator (from source files)"
              value={selectedValidator}
              onChange={(e) => setSelectedValidator(e.target.value)}
              options={sourceOptions}
            />
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" icon={<CheckCircle2 className="w-3.5 h-3.5" />} loading={setting} onClick={handleSetValidator}>
                Set Validator
              </Button>
              <Button variant="secondary" size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => setCvUploadOpen('validator')}>
                Upload & Set
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ── Interactor ── */}
      <Card title="Interactor (Interactive Problems)">
        {cvLoading ? (
          <p className="text-gray-600 text-sm">Loading...</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-500">Current:</span>
              <code className="font-mono text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded">
                {interactor || '(none)'}
              </code>
            </div>
            <Select
              label="Interactor (from source files)"
              value={selectedInteractor}
              onChange={(e) => setSelectedInteractor(e.target.value)}
              options={sourceOptions}
            />
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" icon={<CheckCircle2 className="w-3.5 h-3.5" />} loading={setting} onClick={handleSetInteractor}>
                Set Interactor
              </Button>
              <Button variant="secondary" size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => setCvUploadOpen('interactor')}>
                Upload & Set
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ── Upload Solution Modal ── */}
      <Modal
        open={uploadOpen}
        onClose={() => { setUploadOpen(false); resetUploadForm(); }}
        title="Upload Solution"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setUploadOpen(false); resetUploadForm(); }}>Cancel</Button>
            <Button variant="primary" loading={uploading} onClick={handleUpload} disabled={!canUpload}>Upload</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex gap-2">
            <button type="button" className={modeButtonClass('file')} onClick={() => setUploadMode('file')}>
              <FileCode className="w-4 h-4" />
              Upload File
            </button>
            <button type="button" className={modeButtonClass('paste')} onClick={() => setUploadMode('paste')}>
              <ClipboardPaste className="w-4 h-4" />
              Paste Code
            </button>
          </div>

          <Select label="Tag" value={upTag} onChange={(e) => setUpTag(e.target.value as SolutionTag)} options={TAGS} />
          <Select label="Source Language" value={upSourceType} onChange={(e) => setUpSourceType(e.target.value)} options={SOURCE_TYPES} />

          {uploadMode === 'file' ? (
            <label className="flex flex-col items-center justify-center w-full h-28 border-2 border-dashed border-[#362f28] rounded-xl cursor-pointer hover:border-amber-500/50 transition-colors bg-[#1a1714]">
              <Upload className="w-5 h-5 text-gray-500 mb-2" />
              <span className="text-sm text-gray-500">{upFile ? upFile.name : 'Click to select solution file'}</span>
              <input type="file" className="sr-only" accept=".cpp,.cc,.java,.py,.pas" onChange={(e) => setUpFile(e.target.files?.[0] || null)} />
            </label>
          ) : (
            <>
              <Input label="Filename" placeholder="e.g. solution.cpp" value={upPasteName} onChange={(e) => setUpPasteName(e.target.value)} helperText="Include the file extension (e.g. .cpp, .java, .py)" />
              <Textarea label="Source Code" mono rows={12} placeholder="Paste your solution code here..." value={upPasteCode} onChange={(e) => setUpPasteCode(e.target.value)} />
            </>
          )}
        </div>
      </Modal>

      {/* ── View Solution Modal ── */}
      <Modal open={!!viewContent} onClose={() => setViewContent(null)} title={viewContent?.name || 'Solution'} size="xl">
        <pre className="font-mono text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">
          {viewContent?.content}
        </pre>
      </Modal>

      {/* ── Upload & Set Checker/Validator/Interactor Modal ── */}
      <Modal
        open={!!cvUploadOpen}
        onClose={() => { if (!cvUploading) { setCvUploadOpen(null); setCvUpFile(null); setCvUpCode(''); setCvUpFileName(''); } }}
        title={`Upload & Set ${cvUploadOpen ? cvUploadOpen.charAt(0).toUpperCase() + cvUploadOpen.slice(1) : ''}`}
        size="md"
        footer={
          <>
            <Button variant="ghost" disabled={cvUploading} onClick={() => { setCvUploadOpen(null); setCvUpFile(null); setCvUpCode(''); setCvUpFileName(''); }}>Cancel</Button>
            <Button
              variant="primary"
              loading={cvUploading}
              onClick={handleCvUploadAndSet}
              disabled={cvUpMode === 'file' ? !cvUpFile : (!cvUpCode.trim() || !cvUpFileName.trim())}
            >
              Upload & Set
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex rounded-lg overflow-hidden border border-[#362f28] w-fit">
            <button
              onClick={() => setCvUpMode('file')}
              className={`px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5 ${
                cvUpMode === 'file' ? 'bg-amber-600 text-white' : 'bg-[#211e1a] text-gray-500 hover:text-gray-300'
              }`}
            >
              <Upload className="w-3.5 h-3.5" /> File
            </button>
            <button
              onClick={() => setCvUpMode('paste')}
              className={`px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5 ${
                cvUpMode === 'paste' ? 'bg-amber-600 text-white' : 'bg-[#211e1a] text-gray-500 hover:text-gray-300'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" /> Paste Code
            </button>
          </div>

          {cvUpMode === 'file' ? (
            <label className="flex flex-col items-center justify-center w-full h-28 border-2 border-dashed border-[#362f28] rounded-xl cursor-pointer hover:border-amber-500/50 transition-colors bg-[#1a1714]">
              <Upload className="w-5 h-5 text-gray-500 mb-2" />
              <span className="text-sm text-gray-500">{cvUpFile ? cvUpFile.name : 'Click to select file'}</span>
              <input type="file" className="sr-only" accept=".cpp,.cc,.h" onChange={(e) => setCvUpFile(e.target.files?.[0] || null)} />
            </label>
          ) : (
            <>
              <Input label="Filename" placeholder="checker.cpp" value={cvUpFileName} onChange={(e) => setCvUpFileName(e.target.value)} />
              <Textarea
                label="Source Code"
                value={cvUpCode}
                onChange={(e) => setCvUpCode(e.target.value)}
                rows={10}
                mono
                placeholder="#include &quot;testlib.h&quot;&#10;&#10;int main(int argc, char* argv[]) {&#10;  ..."
              />
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
