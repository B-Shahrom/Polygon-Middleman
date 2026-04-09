import { useState, useEffect } from 'react';
import { Upload, Download, FolderOpen, Code2, File } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { PolygonFile, FilesResult } from '../types/polygon';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Card from '../components/ui/Card';
import Modal from '../components/ui/Modal';
import { Select } from '../components/ui/Input';
import { Input } from '../components/ui/Input';

const SOURCE_TYPES = [
  { value: '', label: '(Auto-detect)' },
  { value: 'cpp.g++17', label: 'C++ 17 (GCC)' },
  { value: 'cpp.g++20', label: 'C++ 20 (GCC)' },
  { value: 'cpp.g++14', label: 'C++ 14 (GCC)' },
  { value: 'java.11', label: 'Java 11' },
  { value: 'python.3', label: 'Python 3' },
  { value: 'python.pypy3', label: 'PyPy 3' },
];

const FILE_TYPES = [
  { value: 'source', label: 'Source file' },
  { value: 'resource', label: 'Resource file' },
  { value: 'aux', label: 'Aux file' },
];

interface Props { problemId: number }

export default function FilesTab({ problemId }: Props) {
  const { toast } = useApp();
  const [files, setFiles] = useState<FilesResult>({ resourceFiles: [], sourceFiles: [], auxFiles: [] });
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [upFile, setUpFile] = useState<File | null>(null);
  const [upType, setUpType] = useState('source');
  const [upSourceType, setUpSourceType] = useState('');
  const [viewContent, setViewContent] = useState<{ name: string; content: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.problem.files(problemId) as { result: FilesResult };
      setFiles(res.result || { resourceFiles: [], sourceFiles: [], auxFiles: [] });
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [problemId]);

  const handleUpload = async () => {
    if (!upFile) return;
    setUploading(true);
    try {
      await api.problem.saveFile(problemId, upType, upFile.name, upFile, upSourceType || undefined);
      toast('success', `${upFile.name} uploaded as ${upType}!`);
      setUploadOpen(false);
      setUpFile(null);
      await load();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleView = async (type: string, name: string) => {
    try {
      const res = await api.problem.viewFile(problemId, type, name) as Response;
      const text = await res.text();
      setViewContent({ name, content: text });
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to view file');
    }
  };

  const totalCount = files.resourceFiles.length + files.sourceFiles.length + files.auxFiles.length;

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{totalCount} files total</p>
        <Button variant="primary" size="sm" icon={<Upload className="w-4 h-4" />} onClick={() => setUploadOpen(true)}>
          Upload File
        </Button>
      </div>

      {/* Source Files */}
      <FileSection
        title="Source Files"
        icon={<Code2 className="w-4 h-4 text-blue-400" />}
        files={files.sourceFiles}
        type="source"
        onView={handleView}
        loading={loading}
      />

      {/* Resource Files */}
      <FileSection
        title="Resource Files"
        icon={<FolderOpen className="w-4 h-4 text-yellow-400" />}
        files={files.resourceFiles}
        type="resource"
        onView={handleView}
        loading={loading}
      />

      {/* Aux Files */}
      <FileSection
        title="Aux Files"
        icon={<File className="w-4 h-4 text-gray-400" />}
        files={files.auxFiles}
        type="aux"
        onView={handleView}
        loading={loading}
      />

      {/* Upload Modal */}
      <Modal
        open={uploadOpen}
        onClose={() => { setUploadOpen(false); setUpFile(null); }}
        title="Upload File"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={uploading} onClick={handleUpload} disabled={!upFile}>
              Upload
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Select
            label="File Type"
            value={upType}
            onChange={(e) => setUpType(e.target.value)}
            options={FILE_TYPES}
          />
          {upType === 'source' && (
            <Select
              label="Source Language"
              value={upSourceType}
              onChange={(e) => setUpSourceType(e.target.value)}
              options={SOURCE_TYPES}
            />
          )}
          <label className="flex flex-col items-center justify-center w-full h-28 border-2 border-dashed border-[#362f28] rounded-xl cursor-pointer hover:border-amber-500/50 transition-colors bg-[#1a1714]">
            <Upload className="w-5 h-5 text-gray-500 mb-2" />
            <span className="text-sm text-gray-500">{upFile ? upFile.name : 'Click to select file'}</span>
            <input type="file" className="sr-only" onChange={(e) => setUpFile(e.target.files?.[0] || null)} />
          </label>
        </div>
      </Modal>

      {/* View file modal */}
      <Modal
        open={!!viewContent}
        onClose={() => setViewContent(null)}
        title={viewContent?.name || 'File'}
        size="xl"
      >
        <pre className="font-mono text-xs text-gray-300 whitespace-pre-wrap leading-relaxed overflow-x-auto">
          {viewContent?.content}
        </pre>
      </Modal>
    </div>
  );
}

function FileSection({
  title, icon, files, type, onView, loading
}: {
  title: string;
  icon: React.ReactNode;
  files: PolygonFile[];
  type: string;
  onView: (type: string, name: string) => void;
  loading: boolean;
}) {
  return (
    <Card
      title={title}
    >
      {loading ? (
        <p className="text-gray-600 text-sm">Loading...</p>
      ) : files.length === 0 ? (
        <p className="text-gray-600 text-sm">No {title.toLowerCase()} found.</p>
      ) : (
        <div className="divide-y divide-[#362f28]/50">
          {files.map((f) => (
            <div key={f.name} className="flex items-center justify-between py-2.5 group">
              <div className="flex items-center gap-3">
                {icon}
                <div>
                  <span className="font-mono text-sm text-gray-300">{f.name}</span>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-gray-600">{(f.length / 1024).toFixed(1)} KB</span>
                    {f.sourceType && <Badge variant="info">{f.sourceType}</Badge>}
                  </div>
                </div>
              </div>
              <Button
                variant="ghost"
                size="xs"
                icon={<Download className="w-3.5 h-3.5" />}
                onClick={() => onView(type, f.name)}
                className="opacity-0 group-hover:opacity-100"
              >
                View
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
