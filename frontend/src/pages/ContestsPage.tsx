import { useState } from 'react';
import {
  Trophy, Plus, RefreshCw, Download, ListChecks, ExternalLink,
  Loader2, ChevronRight, Info,
} from 'lucide-react';
import { api, AutomationLog } from '../api/client';
import { useApp } from '../context/AppContext';
import { Problem } from '../types/polygon';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { Input } from '../components/ui/Input';

const POLYGON = 'https://polygon.codeforces.com';

type ContestRef = { id: string; name: string; url: string };
type ContestProblem = { index: string; problem: Problem };

function automationError(error?: string): string {
  if (error === 'playwright-missing')
    return 'Playwright is not installed. Run: pip install playwright && playwright install chromium';
  if (error === 'login-failed')
    return 'Login failed — check your Codeforces web login in Settings (or run headful to log in manually).';
  return 'Automation finished with errors — check the log below.';
}

export default function ContestsPage() {
  const { toast } = useApp();
  const [headful, setHeadful] = useState(true);
  const [log, setLog] = useState<AutomationLog>([]);
  const [busy, setBusy] = useState<null | 'list' | 'create' | 'add' | 'load'>(null);

  // Create
  const [newName, setNewName] = useState('');

  // Existing contests (scraped via browser)
  const [contests, setContests] = useState<ContestRef[]>([]);

  // Active contest being managed
  const [activeId, setActiveId] = useState('');
  const [activeName, setActiveName] = useState('');
  const [problems, setProblems] = useState<ContestProblem[] | null>(null);

  // Add problems
  const [slugsText, setSlugsText] = useState('');

  const parsedSlugs = slugsText.split('\n').map((s) => s.trim()).filter(Boolean);

  const refreshContests = async () => {
    setBusy('list');
    setLog([{ text: 'Opening browser…', status: 'running' }]);
    try {
      const res = await api.automation.listContests(headful);
      setLog(res.log || []);
      if (res.ok) {
        setContests(res.contests || []);
        toast('success', `Found ${res.contests?.length ?? 0} contest(s)`);
      } else {
        toast('error', automationError(res.error));
      }
    } catch (e: unknown) {
      setLog((l) => [...l, { text: e instanceof Error ? e.message : 'Failed', status: 'error' }]);
      toast('error', 'Failed to list contests');
    } finally {
      setBusy(null);
    }
  };

  const createContest = async () => {
    if (!newName.trim()) return;
    setBusy('create');
    setLog([{ text: 'Opening browser…', status: 'running' }]);
    try {
      const res = await api.automation.createContest(newName.trim(), headful);
      setLog(res.log || []);
      if (res.ok && res.id) {
        toast('success', `Contest ${res.id} created`);
        const ref: ContestRef = { id: res.id, name: newName.trim(), url: res.url || `${POLYGON}/c/${res.id}` };
        setContests((cs) => [ref, ...cs.filter((c) => c.id !== res.id)]);
        selectContest(ref);
        setNewName('');
      } else {
        toast('error', automationError(res.error));
      }
    } catch (e: unknown) {
      setLog((l) => [...l, { text: e instanceof Error ? e.message : 'Failed', status: 'error' }]);
      toast('error', 'Failed to create contest');
    } finally {
      setBusy(null);
    }
  };

  // Load a contest's current problems via the READ-ONLY API (no browser needed).
  const loadProblems = async (id: string) => {
    if (!id.trim()) return;
    setBusy('load');
    setProblems(null);
    try {
      const res = await api.contest.problems(id.trim()) as { result?: Record<string, Problem> };
      const entries = Object.entries(res.result || {})
        .map(([index, problem]) => ({ index, problem }))
        .sort((a, b) => a.index.localeCompare(b.index));
      setProblems(entries);
    } catch (e: unknown) {
      setProblems([]);
      toast('error', e instanceof Error ? e.message : 'Failed to load contest problems');
    } finally {
      setBusy(null);
    }
  };

  const selectContest = (c: ContestRef) => {
    setActiveId(c.id);
    setActiveName(c.name);
    loadProblems(c.id);
  };

  const addProblems = async () => {
    if (!activeId.trim() || parsedSlugs.length === 0) return;
    setBusy('add');
    setLog([{ text: 'Opening browser…', status: 'running' }]);
    try {
      const res = await api.automation.addProblems(activeId.trim(), parsedSlugs, headful);
      setLog(res.log || []);
      if (res.ok) {
        toast('success', `Added ${res.added?.length ?? 0} problem(s)`);
        setSlugsText('');
        loadProblems(activeId.trim());
      } else if (res.error) {
        toast('error', automationError(res.error));
      } else {
        toast('warning', `Added ${res.added?.length ?? 0}, failed ${res.failed?.length ?? 0} — check the log`);
        if ((res.added?.length ?? 0) > 0) loadProblems(activeId.trim());
      }
    } catch (e: unknown) {
      setLog((l) => [...l, { text: e instanceof Error ? e.message : 'Failed', status: 'error' }]);
      toast('error', 'Failed to add problems');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              <Trophy className="w-6 h-6 text-amber-400" />
              Contests
            </h1>
            <p className="text-gray-500 text-sm mt-1">
              Create Polygon contests and add problems by slug. Polygon has no contest API, so these
              actions drive the website in a browser.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none whitespace-nowrap mt-1">
            <input
              type="checkbox"
              checked={headful}
              onChange={(e) => setHeadful(e.target.checked)}
              className="rounded accent-amber-500"
            />
            Show browser
          </label>
        </div>

        {/* Prereq note */}
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 flex items-start gap-2">
          <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            Requires a <span className="font-medium">Codeforces web login</span> (set it in Settings) and Playwright
            (<code className="font-mono">pip install playwright &amp;&amp; playwright install chromium</code>).
            Keep "Show browser" on the first time so you can complete any login prompt.
          </span>
        </div>

        {/* Create a contest */}
        <Card title="Create a contest">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Input
                label="Contest name"
                placeholder="e.g. Educational Round 3"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createContest(); }}
              />
            </div>
            <Button
              variant="primary"
              icon={<Plus className="w-4 h-4" />}
              loading={busy === 'create'}
              disabled={!newName.trim() || busy !== null}
              onClick={createContest}
            >
              Create
            </Button>
          </div>
        </Card>

        {/* Existing contests */}
        <Card
          title="Existing contests"
          actions={
            <Button
              variant="secondary"
              size="sm"
              icon={busy === 'list' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              disabled={busy !== null}
              onClick={refreshContests}
            >
              Load from Polygon
            </Button>
          }
        >
          <div className="space-y-4">
            {/* Manual id entry — works without scraping */}
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Input
                  label="Or enter a contest ID"
                  placeholder="e.g. 12345"
                  value={activeId}
                  onChange={(e) => setActiveId(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') loadProblems(activeId); }}
                />
              </div>
              <Button
                variant="secondary"
                icon={busy === 'load' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                disabled={!activeId.trim() || busy !== null}
                onClick={() => loadProblems(activeId)}
              >
                Load problems
              </Button>
            </div>

            {contests.length > 0 && (
              <div className="border border-[#362f28] rounded-lg divide-y divide-[#2c2722] max-h-64 overflow-y-auto">
                {contests.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => selectContest(c)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                      activeId === c.id ? 'bg-amber-600/15' : 'hover:bg-[#211e1a]'
                    }`}
                  >
                    <Trophy className="w-4 h-4 text-amber-400/70 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-200 truncate">{c.name || `Contest ${c.id}`}</div>
                      <div className="text-[11px] text-gray-600">#{c.id}</div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-gray-600 flex-shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* Manage active contest */}
        {activeId && (
          <Card
            title={`Manage contest #${activeId}${activeName ? ` — ${activeName}` : ''}`}
            actions={
              <a
                href={`${POLYGON}/c/${activeId}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
              >
                Open in Polygon <ExternalLink className="w-3 h-3" />
              </a>
            }
          >
            <div className="space-y-5">
              {/* Current problems */}
              <div>
                <div className="flex items-center gap-2 mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <ListChecks className="w-3.5 h-3.5" />
                  Current problems
                  {busy === 'load' && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-600" />}
                </div>
                {problems === null ? (
                  <p className="text-sm text-gray-600">Not loaded yet.</p>
                ) : problems.length === 0 ? (
                  <p className="text-sm text-gray-600">No problems in this contest yet.</p>
                ) : (
                  <div className="border border-[#362f28] rounded-lg divide-y divide-[#2c2722]">
                    {problems.map(({ index, problem }) => (
                      <div key={index} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <span className="w-6 text-amber-400 font-mono font-semibold">{index}</span>
                        <span className="text-gray-200 flex-1 min-w-0 truncate">{problem.name}</span>
                        <span className="text-[11px] text-gray-600">#{problem.id}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add problems */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  Add problems by slug
                </label>
                <textarea
                  value={slugsText}
                  onChange={(e) => setSlugsText(e.target.value)}
                  placeholder={'one slug per line, e.g.\nedu-two-sum\nedu-binary-search'}
                  rows={5}
                  className="w-full bg-[#211e1a] border border-[#362f28] rounded-lg px-3 py-2 text-gray-200 placeholder-gray-600 text-sm font-mono focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/50 transition-colors resize-y"
                />
                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs text-gray-600">
                    {parsedSlugs.length} slug{parsedSlugs.length === 1 ? '' : 's'} — one per line, or paste many at once
                  </span>
                  <Button
                    variant="primary"
                    icon={<Plus className="w-4 h-4" />}
                    loading={busy === 'add'}
                    disabled={parsedSlugs.length === 0 || busy !== null}
                    onClick={addProblems}
                  >
                    Add {parsedSlugs.length > 0 ? parsedSlugs.length : ''} to contest
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Automation log */}
        {log.length > 0 && (
          <Card title="Automation log">
            <div className="bg-[#1a1714] border border-[#362f28] rounded-lg p-3 max-h-72 overflow-y-auto space-y-1">
              {log.map((l, i) => (
                <div
                  key={i}
                  className={`text-xs font-mono ${
                    l.status === 'error' ? 'text-red-400' : l.status === 'done' ? 'text-gray-300' : 'text-gray-500'
                  }`}
                >
                  {l.status === 'running' && '… '}{l.text}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
