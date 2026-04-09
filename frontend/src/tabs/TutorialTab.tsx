import { useState, useEffect } from 'react';
import { Save } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import Button from '../components/ui/Button';
import { Textarea } from '../components/ui/Input';
import Card from '../components/ui/Card';

interface Props { problemId: number }

export default function TutorialTab({ problemId }: Props) {
  const { toast } = useApp();
  const [description, setDescription] = useState('');
  const [tutorial, setTutorial] = useState('');
  const [savingDesc, setSavingDesc] = useState(false);
  const [savingTut, setSavingTut] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [descRes, tutRes] = await Promise.allSettled([
          api.problem.viewGeneralDescription(problemId),
          api.problem.viewGeneralTutorial(problemId),
        ]);
        if (descRes.status === 'fulfilled') {
          const r = descRes.value as { result: string };
          setDescription(r.result || '');
        }
        if (tutRes.status === 'fulfilled') {
          const r = tutRes.value as { result: string };
          setTutorial(r.result || '');
        }
      } catch { /* ignore */ }
      finally { setLoading(false); }
    };
    load();
  }, [problemId]);

  const handleSaveDesc = async () => {
    setSavingDesc(true);
    try {
      await api.problem.saveGeneralDescription(problemId, description);
      toast('success', 'General description saved!');
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to save description');
    } finally {
      setSavingDesc(false);
    }
  };

  const handleSaveTut = async () => {
    setSavingTut(true);
    try {
      await api.problem.saveGeneralTutorial(problemId, tutorial);
      toast('success', 'Tutorial saved!');
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to save tutorial');
    } finally {
      setSavingTut(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-gray-600 text-sm">Loading...</div>;
  }

  return (
    <div className="p-6 space-y-5 max-w-3xl">
      <Card
        title="General Description"
        actions={
          <Button variant="primary" size="sm" icon={<Save className="w-3.5 h-3.5" />} loading={savingDesc} onClick={handleSaveDesc}>
            Save
          </Button>
        }
      >
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          mono
          placeholder="General problem description (not shown in statement)..."
          helperText="Internal description for problem organizers."
        />
      </Card>

      <Card
        title="General Tutorial"
        actions={
          <Button variant="primary" size="sm" icon={<Save className="w-3.5 h-3.5" />} loading={savingTut} onClick={handleSaveTut}>
            Save
          </Button>
        }
      >
        <Textarea
          value={tutorial}
          onChange={(e) => setTutorial(e.target.value)}
          rows={12}
          mono
          placeholder="Solution explanation and editorial..."
          helperText="The general tutorial for this problem."
        />
      </Card>
    </div>
  );
}
