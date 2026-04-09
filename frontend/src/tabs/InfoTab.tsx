import { useState, useEffect } from 'react';
import { Save, Clock, Database, ArrowLeftRight, X, Plus } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { ProblemInfo } from '../types/polygon';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import Card from '../components/ui/Card';

interface Props {
  problemId: number;
  info: ProblemInfo | null;
  onUpdated: () => void;
}

const SUGGESTED_TAGS = [
  'implementation', 'math', 'dp', 'greedy', 'graphs', 'trees',
  'binary search', 'sorting', 'strings', 'number theory',
  'combinatorics', 'geometry', 'flows', 'data structures',
  'bitmasks', 'brute force', 'constructive algorithms',
  'dfs and similar', 'shortest paths', 'two pointers',
];

export default function InfoTab({ problemId, info, onUpdated }: Props) {
  const { toast } = useApp();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    inputFile: info?.inputFile ?? 'stdin',
    outputFile: info?.outputFile ?? 'stdout',
    interactive: info?.interactive ?? false,
    timeLimit: info?.timeLimit ?? 1000,
    memoryLimit: info?.memoryLimit ?? 256,
  });

  // Tags state
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [savingTags, setSavingTags] = useState(false);
  const [loadingTags, setLoadingTags] = useState(true);

  // Load tags
  useEffect(() => {
    const loadTags = async () => {
      setLoadingTags(true);
      try {
        const res = await api.problem.viewTags(problemId) as { result: string[] };
        setTags(res.result || []);
      } catch {
        setTags([]);
      } finally {
        setLoadingTags(false);
      }
    };
    loadTags();
  }, [problemId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.problem.updateInfo({
        problemId,
        inputFile: form.inputFile,
        outputFile: form.outputFile,
        interactive: form.interactive,
        timeLimit: form.timeLimit,
        memoryLimit: form.memoryLimit,
      });
      toast('success', 'Problem info updated!');
      onUpdated();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to update info');
    } finally {
      setSaving(false);
    }
  };

  // Tag handlers
  const handleAddTag = () => {
    const t = newTag.trim().toLowerCase().replace(/\s+/g, '-');
    if (!t || tags.includes(t)) return;
    setTags([...tags, t]);
    setNewTag('');
  };

  const handleRemoveTag = (tag: string) => setTags(tags.filter((t) => t !== tag));

  const handleSaveTags = async () => {
    setSavingTags(true);
    try {
      await api.problem.saveTags(problemId, tags.join(','));
      toast('success', 'Tags saved!');
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to save tags');
    } finally {
      setSavingTags(false);
    }
  };

  const notAdded = SUGGESTED_TAGS.filter((s) => !tags.includes(s));

  return (
    <div className="p-6 max-w-2xl space-y-5">
      {/* Problem Configuration Card */}
      <Card title="Problem Configuration">
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wide flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> Time Limit (ms)
              </label>
              <input
                type="number"
                value={form.timeLimit}
                onChange={(e) => setForm({ ...form, timeLimit: Number(e.target.value) })}
                min={100}
                max={30000}
                step={100}
                className="w-full bg-[#211e1a] border border-[#362f28] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-500 font-mono"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wide flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5" /> Memory Limit (MB)
              </label>
              <input
                type="number"
                value={form.memoryLimit}
                onChange={(e) => setForm({ ...form, memoryLimit: Number(e.target.value) })}
                min={4}
                max={1024}
                step={4}
                className="w-full bg-[#211e1a] border border-[#362f28] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-500 font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Input File"
              placeholder="stdin"
              value={form.inputFile}
              onChange={(e) => setForm({ ...form, inputFile: e.target.value })}
            />
            <Input
              label="Output File"
              placeholder="stdout"
              value={form.outputFile}
              onChange={(e) => setForm({ ...form, outputFile: e.target.value })}
            />
          </div>

          <label className="flex items-center gap-3 cursor-pointer select-none">
            <div className="relative">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={form.interactive}
                onChange={(e) => setForm({ ...form, interactive: e.target.checked })}
              />
              <div className="w-10 h-5 bg-[#2c2722] rounded-full peer peer-checked:bg-amber-600 transition-colors" />
              <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5" />
            </div>
            <div>
              <span className="text-sm font-medium text-gray-300 flex items-center gap-1.5">
                <ArrowLeftRight className="w-3.5 h-3.5 text-amber-400" />
                Interactive Problem
              </span>
              <p className="text-xs text-gray-600 mt-0.5">Enable for problems with an interactor</p>
            </div>
          </label>

          <Button
            variant="primary"
            icon={<Save className="w-4 h-4" />}
            loading={saving}
            onClick={handleSave}
          >
            Save Changes
          </Button>
        </div>
      </Card>

      {/* Problem Tags Card */}
      <Card
        title="Problem Tags"
        actions={
          <Button variant="primary" size="sm" icon={<Save className="w-3.5 h-3.5" />} loading={savingTags} onClick={handleSaveTags}>
            Save Tags
          </Button>
        }
      >
        {loadingTags ? (
          <p className="text-gray-600 text-sm">Loading...</p>
        ) : (
          <div className="space-y-4">
            {/* Current tags */}
            <div className="flex flex-wrap gap-2">
              {tags.length === 0 && <p className="text-gray-600 text-sm">No tags added yet.</p>}
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-sm"
                >
                  {tag}
                  <button
                    onClick={() => handleRemoveTag(tag)}
                    className="text-amber-500 hover:text-amber-300 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>

            {/* Add tag input */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Add tag..."
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                className="flex-1 bg-[#211e1a] border border-[#362f28] rounded-lg px-3 py-2 text-gray-200 text-sm placeholder-gray-500 focus:outline-none focus:border-amber-500"
              />
              <Button variant="secondary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={handleAddTag}>
                Add
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Suggested Tags Card */}
      {notAdded.length > 0 && (
        <Card title="Suggested Tags">
          <div className="flex flex-wrap gap-2">
            {notAdded.map((tag) => (
              <button
                key={tag}
                onClick={() => setTags([...tags, tag])}
                className="px-2.5 py-1 rounded-full border border-dashed border-[#362f28] text-gray-600 text-sm hover:border-amber-500/50 hover:text-amber-400 transition-colors"
              >
                + {tag}
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
