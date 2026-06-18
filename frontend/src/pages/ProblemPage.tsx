import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Info, FileText, FolderOpen, Code2, TestTube2,
  ScrollText, Package, BookOpen, GitCommit,
  RefreshCw, Trash2, ExternalLink
} from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { Problem, ProblemInfo } from '../types/polygon';
import Tabs from '../components/ui/Tabs';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import { Input } from '../components/ui/Input';

// Tabs
import InfoTab from '../tabs/InfoTab';
import StatementTab from '../tabs/StatementTab';
import FilesTab from '../tabs/FilesTab';
import SolutionsTab from '../tabs/SolutionsTab';
import TestsTab from '../tabs/TestsTab';
import ScriptTab from '../tabs/ScriptTab';
import PackagesTab from '../tabs/PackagesTab';
import TutorialTab from '../tabs/TutorialTab';

const TABS = [
  { id: 'info', label: 'Info', icon: <Info className="w-3.5 h-3.5" /> },
  { id: 'statement', label: 'Statement', icon: <FileText className="w-3.5 h-3.5" /> },
  { id: 'solutions', label: 'Solutions', icon: <Code2 className="w-3.5 h-3.5" /> },
  { id: 'tests', label: 'Tests', icon: <TestTube2 className="w-3.5 h-3.5" /> },
  { id: 'files', label: 'Files', icon: <FolderOpen className="w-3.5 h-3.5" /> },
  { id: 'script', label: 'Script', icon: <ScrollText className="w-3.5 h-3.5" /> },
  { id: 'packages', label: 'Packages', icon: <Package className="w-3.5 h-3.5" /> },
  { id: 'tutorial', label: 'Tutorial', icon: <BookOpen className="w-3.5 h-3.5" /> },
];

export default function ProblemPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { problems, setSelectedProblem, toast } = useApp();

  const [problem, setProblem] = useState<Problem | null>(null);
  const [problemInfo, setProblemInfo] = useState<ProblemInfo | null>(null);
  const [activeTab, setActiveTab] = useState('info');
  const [loading, setLoading] = useState(true);

  // Commit modal
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [minor, setMinor] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const problemId = Number(id);

  const loadProblem = async () => {
    setLoading(true);
    try {
      // Find from cached problems list first
      const cached = problems.find((p) => p.id === problemId);
      if (cached) {
        setProblem(cached);
        setSelectedProblem(cached);
      }

      const infoRes = await api.problem.info(problemId) as { result: ProblemInfo };
      setProblemInfo(infoRes.result);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to load problem');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProblem();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemId]);

  const handleCommit = async () => {
    setCommitting(true);
    try {
      await api.problem.commitChanges(problemId, {
        message: commitMsg || undefined,
        minorChanges: minor,
      });
      toast('success', 'Changes committed successfully!');
      setCommitOpen(false);
      setCommitMsg('');
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Commit failed');
    } finally {
      setCommitting(false);
    }
  };

  const handleUpdateWorkingCopy = async () => {
    setUpdating(true);
    try {
      await api.problem.updateWorkingCopy(problemId);
      toast('success', 'Working copy updated!');
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Update failed');
    } finally {
      setUpdating(false);
    }
  };

  const handleDiscard = async () => {
    if (!confirm('Discard all uncommitted changes?')) return;
    setDiscarding(true);
    try {
      await api.problem.discardWorkingCopy(problemId);
      toast('success', 'Working copy discarded.');
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Discard failed');
    } finally {
      setDiscarding(false);
    }
  };

  if (loading && !problem) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" />
        Loading problem...
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 bg-[#110f0d] border-b border-[#362f28]">
        <div className="flex items-center gap-4 px-5 py-3.5">
          <button
            onClick={() => navigate('/problems')}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-lg font-bold text-white truncate">
                {problem?.name || `Problem #${problemId}`}
              </h1>
              {problem && (
                <>
                  <span className="font-mono text-xs text-gray-600">#{problem.id}</span>
                  <Badge variant="default">r{problem.revision}</Badge>
                  {problem.modified && <Badge variant="warning">modified</Badge>}
                  {problem.deleted && <Badge variant="danger">deleted</Badge>}
                </>
              )}
            </div>
            {problemInfo?.interactive && (
              <div className="flex items-center gap-3 mt-1">
                <Badge variant="info" className="text-xs">Interactive</Badge>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href={`https://polygon.codeforces.com/problems?problemId=${problemId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-amber-400 hover:bg-[#211e1a] rounded-lg transition-colors"
              title="Open in Polygon"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Polygon
            </a>
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw className={`w-3.5 h-3.5 ${updating ? 'animate-spin' : ''}`} />}
              loading={updating}
              onClick={handleUpdateWorkingCopy}
            >
              Update
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 className="w-3.5 h-3.5" />}
              loading={discarding}
              onClick={handleDiscard}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<GitCommit className="w-3.5 h-3.5" />}
              onClick={() => setCommitOpen(true)}
            >
              Commit
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <Tabs tabs={TABS} active={activeTab} onChange={setActiveTab} className="px-5" />
      </div>

      {/* Tab content — all tabs mounted immediately, hidden via CSS */}
      <div className="flex-1 overflow-y-auto">
        <div style={{ display: activeTab === 'info' ? 'block' : 'none' }}>
          <InfoTab problemId={problemId} info={problemInfo} onUpdated={loadProblem} />
        </div>
        <div style={{ display: activeTab === 'statement' ? 'block' : 'none' }}>
          <StatementTab problemId={problemId} />
        </div>
        <div style={{ display: activeTab === 'solutions' ? 'block' : 'none' }}>
          <SolutionsTab problemId={problemId} />
        </div>
        <div style={{ display: activeTab === 'tests' ? 'block' : 'none' }}>
          <TestsTab problemId={problemId} />
        </div>
        <div style={{ display: activeTab === 'files' ? 'block' : 'none' }}>
          <FilesTab problemId={problemId} />
        </div>
        <div style={{ display: activeTab === 'script' ? 'block' : 'none' }}>
          <ScriptTab problemId={problemId} />
        </div>
        <div style={{ display: activeTab === 'packages' ? 'block' : 'none' }}>
          <PackagesTab problemId={problemId} />
        </div>
        <div style={{ display: activeTab === 'tutorial' ? 'block' : 'none' }}>
          <TutorialTab problemId={problemId} />
        </div>
      </div>

      {/* Commit Modal */}
      <Modal
        open={commitOpen}
        onClose={() => setCommitOpen(false)}
        title="Commit Changes"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCommitOpen(false)}>Cancel</Button>
            <Button variant="primary" icon={<GitCommit className="w-4 h-4" />} loading={committing} onClick={handleCommit}>
              Commit
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Commit Message (optional)"
            placeholder="Describe your changes..."
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            autoFocus
          />
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={minor}
              onChange={(e) => setMinor(e.target.checked)}
              className="rounded accent-amber-500 w-4 h-4"
            />
            <span className="text-sm text-gray-400">Minor changes (no email notification)</span>
          </label>
        </div>
      </Modal>
    </div>
  );
}
