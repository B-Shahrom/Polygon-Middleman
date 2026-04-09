import { useState, useEffect } from 'react';
import { Shield, CheckCircle2, RefreshCw, Upload, Code2 } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { PolygonFile, FilesResult } from '../types/polygon';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { Select, Input, Textarea } from '../components/ui/Input';
import Modal from '../components/ui/Modal';

const STANDARD_CHECKERS = [
  { value: '', label: '(no checker / custom file)' },
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

interface Props { problemId: number }

export default function CheckerValidatorTab({ problemId }: Props) {
  const { toast } = useApp();
  const [checker, setChecker] = useState<string>('');
  const [validator, setValidator] = useState<string>('');
  const [interactor, setInteractor] = useState<string>('');
  const [sourceFiles, setSourceFiles] = useState<PolygonFile[]>([]);
  const [loading, setLoading] = useState(true);

  const [checkerMode, setCheckerMode] = useState<'standard' | 'custom'>('custom');
  const [selectedStdChecker, setSelectedStdChecker] = useState('');
  const [selectedCustomChecker, setSelectedCustomChecker] = useState('');
  const [selectedValidator, setSelectedValidator] = useState('');
  const [selectedInteractor, setSelectedInteractor] = useState('');

  // Upload states
  const [uploadOpen, setUploadOpen] = useState<'checker' | 'validator' | 'interactor' | null>(null);
  const [upFile, setUpFile] = useState<File | null>(null);
  const [upMode, setUpMode] = useState<'file' | 'paste'>('file');
  const [upCode, setUpCode] = useState('');
  const [upFileName, setUpFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [setting, setSetting] = useState(false);

  const load = async () => {
    setLoading(true);
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
        // Detect standard checker: "std::wcmp.cpp" → "wcmp"
        const stdMatch = cur.match(/^std::(\w+)\.cpp$/);
        if (stdMatch && STANDARD_CHECKERS.slice(1).some(c => c.value === stdMatch[1])) {
          setCheckerMode('standard');
          setSelectedStdChecker(stdMatch[1]);
        } else {
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
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [problemId]);

  const handleSetChecker = async () => {
    const raw = checkerMode === 'standard' ? selectedStdChecker : selectedCustomChecker;
    if (!raw) { toast('error', 'Select a checker'); return; }
    // Standard checkers must be sent as "std::name.cpp" to Polygon
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

  const handleUploadAndSet = async () => {
    if (!uploadOpen) return;
    let file: File;
    let fileName: string;
    if (upMode === 'paste') {
      if (!upCode.trim() || !upFileName.trim()) { toast('error', 'Enter filename and code'); return; }
      fileName = upFileName.trim().endsWith('.cpp') ? upFileName.trim() : upFileName.trim() + '.cpp';
      file = new File([upCode], fileName, { type: 'text/plain' });
    } else {
      if (!upFile) return;
      file = upFile;
      fileName = upFile.name;
    }
    setUploading(true);
    try {
      await api.problem.saveFile(problemId, 'source', fileName, file, 'cpp.g++17');
      // Set as checker/validator/interactor
      if (uploadOpen === 'checker') {
        await api.problem.setChecker(problemId, fileName);
        setChecker(fileName);
      } else if (uploadOpen === 'validator') {
        await api.problem.setValidator(problemId, fileName);
        setValidator(fileName);
      } else {
        await api.problem.setInteractor(problemId, fileName);
        setInteractor(fileName);
      }
      toast('success', `${fileName} uploaded and set as ${uploadOpen}!`);
      setUploadOpen(null);
      setUpFile(null);
      setUpCode('');
      setUpFileName('');
      await load();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const sourceOptions = [
    { value: '', label: '— select —' },
    ...sourceFiles.map((f) => ({ value: f.name, label: f.name })),
  ];

  return (
    <div className="p-6 space-y-5 max-w-2xl">
      {/* Checker */}
      <Card title="Checker">
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-500">Current:</span>
            <code className="font-mono text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded">
              {checker || '(none)'}
            </code>
          </div>

          {/* Mode toggle */}
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
            <Button variant="secondary" size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => setUploadOpen('checker')}>
              Upload & Set
            </Button>
          </div>
        </div>
      </Card>

      {/* Validator */}
      <Card title="Validator">
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
            <Button variant="secondary" size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => setUploadOpen('validator')}>
              Upload & Set
            </Button>
          </div>
        </div>
      </Card>

      {/* Interactor */}
      <Card title="Interactor (Interactive Problems)">
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
            <Button variant="secondary" size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={() => setUploadOpen('interactor')}>
              Upload & Set
            </Button>
          </div>
        </div>
      </Card>

      {/* Upload & Set Modal */}
      <Modal
        open={!!uploadOpen}
        onClose={() => { if (!uploading) { setUploadOpen(null); setUpFile(null); setUpCode(''); setUpFileName(''); } }}
        title={`Upload & Set ${uploadOpen ? uploadOpen.charAt(0).toUpperCase() + uploadOpen.slice(1) : ''}`}
        size="md"
        footer={
          <>
            <Button variant="ghost" disabled={uploading} onClick={() => { setUploadOpen(null); setUpFile(null); setUpCode(''); setUpFileName(''); }}>Cancel</Button>
            <Button
              variant="primary"
              loading={uploading}
              onClick={handleUploadAndSet}
              disabled={upMode === 'file' ? !upFile : (!upCode.trim() || !upFileName.trim())}
            >
              Upload & Set
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {/* Mode toggle */}
          <div className="flex rounded-lg overflow-hidden border border-[#362f28] w-fit">
            <button
              onClick={() => setUpMode('file')}
              className={`px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5 ${
                upMode === 'file' ? 'bg-amber-600 text-white' : 'bg-[#211e1a] text-gray-500 hover:text-gray-300'
              }`}
            >
              <Upload className="w-3.5 h-3.5" /> File
            </button>
            <button
              onClick={() => setUpMode('paste')}
              className={`px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5 ${
                upMode === 'paste' ? 'bg-amber-600 text-white' : 'bg-[#211e1a] text-gray-500 hover:text-gray-300'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" /> Paste Code
            </button>
          </div>

          {upMode === 'file' ? (
            <label className="flex flex-col items-center justify-center w-full h-28 border-2 border-dashed border-[#362f28] rounded-xl cursor-pointer hover:border-amber-500/50 transition-colors bg-[#1a1714]">
              <Upload className="w-5 h-5 text-gray-500 mb-2" />
              <span className="text-sm text-gray-500">{upFile ? upFile.name : 'Click to select file'}</span>
              <input type="file" className="sr-only" accept=".cpp,.cc,.h" onChange={(e) => setUpFile(e.target.files?.[0] || null)} />
            </label>
          ) : (
            <>
              <Input
                label="Filename"
                placeholder="checker.cpp"
                value={upFileName}
                onChange={(e) => setUpFileName(e.target.value)}
              />
              <Textarea
                label="Source Code"
                value={upCode}
                onChange={(e) => setUpCode(e.target.value)}
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
