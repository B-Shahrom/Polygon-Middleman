import { useState, useEffect } from 'react';
import { Save, X, Plus } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import Card from '../components/ui/Card';

interface Props { problemId: number }

export default function TagsTab({ problemId }: Props) {
  const { toast } = useApp();
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.problem.viewTags(problemId) as { result: string[] };
      setTags(res.result || []);
    } catch {
      setTags([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [problemId]);

  const handleAddTag = () => {
    const t = newTag.trim().toLowerCase().replace(/\s+/g, '-');
    if (!t || tags.includes(t)) return;
    setTags([...tags, t]);
    setNewTag('');
  };

  const handleRemoveTag = (tag: string) => setTags(tags.filter((t) => t !== tag));

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.problem.saveTags(problemId, tags.join(','));
      toast('success', 'Tags saved!');
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to save tags');
    } finally {
      setSaving(false);
    }
  };

  const SUGGESTED = [
    'implementation', 'math', 'dp', 'greedy', 'graphs', 'trees',
    'binary search', 'sorting', 'strings', 'number theory',
    'combinatorics', 'geometry', 'flows', 'data structures',
    'bitmasks', 'brute force', 'constructive algorithms',
    'dfs and similar', 'shortest paths', 'two pointers',
  ];

  const notAdded = SUGGESTED.filter((s) => !tags.includes(s));

  return (
    <div className="p-6 space-y-5 max-w-2xl">
      <Card
        title="Problem Tags"
        actions={
          <Button variant="primary" size="sm" icon={<Save className="w-3.5 h-3.5" />} loading={saving} onClick={handleSave}>
            Save Tags
          </Button>
        }
      >
        {loading ? (
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

      {/* Suggested tags */}
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
