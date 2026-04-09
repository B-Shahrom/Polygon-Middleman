import { useState, useEffect } from 'react';
import { Save, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import Button from '../components/ui/Button';
import { Textarea, Select } from '../components/ui/Input';
import Card from '../components/ui/Card';

const TESTSETS = [
  { value: 'tests', label: 'tests' },
  { value: 'pretests', label: 'pretests' },
];

interface Props { problemId: number }

export default function ScriptTab({ problemId }: Props) {
  const { toast } = useApp();
  const [testset, setTestset] = useState('tests');
  const [script, setScript] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.problem.script(problemId, testset) as Response;
      const text = await res.text();
      // If it's JSON (FAILED response), show error
      try {
        const json = JSON.parse(text);
        if (json.status === 'FAILED') {
          setScript('');
        } else {
          setScript(text);
        }
      } catch {
        setScript(text);
      }
    } catch {
      setScript('');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [problemId, testset]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.problem.saveScript(problemId, script, testset);
      toast('success', 'Script saved!');
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to save script');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-4">
        <div className="w-36">
          <Select
            label="Testset"
            value={testset}
            onChange={(e) => setTestset(e.target.value)}
            options={TESTSETS}
          />
        </div>
        <div className="flex items-center gap-2 mt-4">
          <Button variant="ghost" size="sm" icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />} onClick={load}>
            Reload
          </Button>
        </div>
      </div>

      <Card
        title={`Test Generation Script — ${testset}`}
        actions={
          <Button variant="primary" size="sm" icon={<Save className="w-3.5 h-3.5" />} loading={saving} onClick={handleSave}>
            Save Script
          </Button>
        }
      >
        {loading ? (
          <p className="text-gray-600 text-sm">Loading script...</p>
        ) : (
          <Textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={20}
            mono
            placeholder={`# Script for test generation\n# Example:\n# gen 1 2 3 > $\n# gen 100000 > $`}
          />
        )}
      </Card>

      <Card title="Script Help">
        <div className="text-sm text-gray-500 space-y-2 font-mono">
          <p className="text-gray-400 not-italic font-sans font-medium">Script format:</p>
          <p><code className="text-amber-300">generator_name arg1 arg2 &gt; $</code> — run generator, output to test</p>
          <p><code className="text-amber-300">generator_name arg1 &gt; $N</code> — run generator, save to test N</p>
          <p className="text-gray-600 text-xs mt-2">The generator must be uploaded as a source file first.</p>
        </div>
      </Card>
    </div>
  );
}
