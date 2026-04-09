import { useState, useEffect } from 'react';
import { Upload, Eye, FileCode, ClipboardPaste, Info, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { Solution, SolutionTag } from '../types/polygon';
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

function fmt(bytes: number) { return (bytes / 1024).toFixed(1) + ' KB'; }

type UploadMode = 'file' | 'paste';

interface Props { problemId: number }

export default function SolutionsTab({ problemId }: Props) {
  const { toast } = useApp();
  const [solutions, setSolutions] = useState<Solution[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Upload state
  const [uploadMode, setUploadMode] = useState<UploadMode>('file');
  const [upFile, setUpFile] = useState<File | null>(null);
  const [upPasteCode, setUpPasteCode] = useState('');
  const [upPasteName, setUpPasteName] = useState('');
  const [upTag, setUpTag] = useState<SolutionTag>('MA');
  const [upSourceType, setUpSourceType] = useState('');

  // View state
  const [viewContent, setViewContent] = useState<{ name: string; content: string } | null>(null);

  const resetUploadForm = () => {
    setUpFile(null);
    setUpPasteCode('');
    setUpPasteName('');
    setUpTag('MA');
    setUpSourceType('');
    setUploadMode('file');
  };

  const load = async () => {
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

  useEffect(() => { load(); }, [problemId]);

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
      await load();
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

  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete solution "${name}"? This will save an empty file to overwrite it.`)) return;
    setDeleting(name);
    try {
      const emptyFile = new File([''], name, { type: 'text/plain' });
      await api.problem.saveSolution(problemId, name, emptyFile, 'RJ');
      toast('success', `Solution "${name}" deleted`);
      await load();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to delete solution');
    } finally {
      setDeleting(null);
    }
  };

  const modeButtonClass = (mode: UploadMode) =>
    `flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
      uploadMode === mode
        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
        : 'bg-[#1a1714] text-gray-500 border border-[#362f28] hover:text-gray-400 hover:border-[#3e4174]'
    }`;

  return (
    <div className="p-6 space-y-5">
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
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<Eye className="w-3.5 h-3.5" />}
                    onClick={() => handleView(s.name)}
                  >
                    View
                  </Button>
                  <Button
                    variant="danger"
                    size="xs"
                    icon={<Trash2 className="w-3.5 h-3.5" />}
                    loading={deleting === s.name}
                    onClick={() => handleDelete(s.name)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Upload Modal */}
      <Modal
        open={uploadOpen}
        onClose={() => { setUploadOpen(false); resetUploadForm(); }}
        title="Upload Solution"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setUploadOpen(false); resetUploadForm(); }}>Cancel</Button>
            <Button variant="primary" loading={uploading} onClick={handleUpload} disabled={!canUpload}>
              Upload
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {/* Mode toggle */}
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

          <Select
            label="Tag"
            value={upTag}
            onChange={(e) => setUpTag(e.target.value as SolutionTag)}
            options={TAGS}
          />
          <Select
            label="Source Language"
            value={upSourceType}
            onChange={(e) => setUpSourceType(e.target.value)}
            options={SOURCE_TYPES}
          />

          {uploadMode === 'file' ? (
            <label className="flex flex-col items-center justify-center w-full h-28 border-2 border-dashed border-[#362f28] rounded-xl cursor-pointer hover:border-amber-500/50 transition-colors bg-[#1a1714]">
              <Upload className="w-5 h-5 text-gray-500 mb-2" />
              <span className="text-sm text-gray-500">{upFile ? upFile.name : 'Click to select solution file'}</span>
              <input type="file" className="sr-only" accept=".cpp,.cc,.java,.py,.pas" onChange={(e) => setUpFile(e.target.files?.[0] || null)} />
            </label>
          ) : (
            <>
              <Input
                label="Filename"
                placeholder="e.g. solution.cpp"
                value={upPasteName}
                onChange={(e) => setUpPasteName(e.target.value)}
                helperText="Include the file extension (e.g. .cpp, .java, .py)"
              />
              <Textarea
                label="Source Code"
                mono
                rows={12}
                placeholder="Paste your solution code here..."
                value={upPasteCode}
                onChange={(e) => setUpPasteCode(e.target.value)}
              />
            </>
          )}
        </div>
      </Modal>

      {/* View modal */}
      <Modal
        open={!!viewContent}
        onClose={() => setViewContent(null)}
        title={viewContent?.name || 'Solution'}
        size="xl"
      >
        <pre className="font-mono text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">
          {viewContent?.content}
        </pre>
      </Modal>
    </div>
  );
}
