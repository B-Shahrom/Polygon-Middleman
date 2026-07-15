import { useState } from 'react';
import {
  Loader2, CheckCircle2, AlertCircle, X, ExternalLink, RotateCcw, ChevronRight, ChevronDown, Clock,
} from 'lucide-react';
import { ImportJob } from './types';

interface Props {
  jobs: ImportJob[];
  concurrency: number;
  setConcurrency: (n: number) => void;
  onRetryJob: (id: string) => void;
}

function StatusIcon({ status }: { status: ImportJob['status'] }) {
  if (status === 'queued') return <Clock className="w-4 h-4 text-gray-500 flex-shrink-0" />;
  if (status === 'running') return <Loader2 className="w-4 h-4 text-amber-400 animate-spin flex-shrink-0" />;
  if (status === 'done') return <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />;
  if (status === 'warnings') return <AlertCircle className="w-4 h-4 text-yellow-400 flex-shrink-0" />;
  return <X className="w-4 h-4 text-red-400 flex-shrink-0" />;
}

export default function QueueView({ jobs, concurrency, setConcurrency, onRetryJob }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const count = (s: ImportJob['status']) => jobs.filter((j) => j.status === s).length;
  const running = count('running');
  const queued = count('queued');
  const done = count('done');
  const warn = count('warnings');
  const failed = count('failed');

  return (
    <div className="space-y-3">
      {/* Summary + concurrency */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 text-xs">
          {running > 0 && <span className="flex items-center gap-1 text-amber-400"><Loader2 className="w-3 h-3 animate-spin" />{running} running</span>}
          {queued > 0 && <span className="flex items-center gap-1 text-gray-400"><Clock className="w-3 h-3" />{queued} queued</span>}
          {done > 0 && <span className="text-green-400">{done} done</span>}
          {warn > 0 && <span className="text-yellow-400">{warn} warnings</span>}
          {failed > 0 && <span className="text-red-400">{failed} failed</span>}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-500">
          Parallel agents
          <select
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            className="bg-[#1a1714] border border-[#362f28] rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-amber-500"
          >
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      <div className="space-y-1.5 max-h-[28rem] overflow-y-auto pr-1">
        {jobs.map((job) => {
          const isOpen = expanded.has(job.id);
          const lastStep = job.log.filter((l) => l.kind !== 'header').slice(-1)[0];
          return (
            <div key={job.id} className="border border-[#362f28] rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-[#211e1a]">
                <button onClick={() => toggle(job.id)} className="text-gray-500 hover:text-gray-300 flex-shrink-0">
                  {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </button>
                <StatusIcon status={job.status} />
                <span className="text-sm font-medium text-gray-200 truncate">{job.name}</span>
                {job.problemId && (
                  <a
                    href={`https://polygon.codeforces.com/edit-start?problemId=${job.problemId}`}
                    target="_blank" rel="noreferrer"
                    className="text-xs font-mono text-amber-400 hover:text-amber-300 flex items-center gap-0.5 flex-shrink-0"
                  >
                    #{job.problemId}<ExternalLink className="w-3 h-3" />
                  </a>
                )}
                {job.verifyStatus === 'verifying' && <span className="flex items-center gap-1 text-xs text-amber-400/90 flex-shrink-0"><Loader2 className="w-3 h-3 animate-spin" />verifying</span>}
                {job.verifyStatus === 'passed' && <span className="text-xs text-green-400 flex-shrink-0">✓ verified</span>}
                {job.verifyStatus === 'failed' && <span className="text-xs text-red-400 flex-shrink-0" title={job.verifyComment || ''}>✗ verify failed</span>}
                <span className="ml-auto flex items-center gap-2 flex-shrink-0">
                  {job.status === 'running' && lastStep && (
                    <span className="text-xs text-gray-500 truncate max-w-[16rem] hidden sm:inline">{lastStep.text}</span>
                  )}
                  {(job.status === 'failed' || job.status === 'warnings') && (
                    <button onClick={() => onRetryJob(job.id)} className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300">
                      <RotateCcw className="w-3.5 h-3.5" />Retry
                    </button>
                  )}
                </span>
              </div>
              {isOpen && (
                <div className="px-3 py-2 space-y-1 border-t border-[#362f28]/60">
                  {job.log.length === 0 ? (
                    <p className="text-xs text-gray-600">Waiting to start…</p>
                  ) : job.log.map((entry, i) => (
                    entry.kind === 'header' ? null : (
                      <div key={i} className="flex items-start gap-2">
                        {entry.status === 'running' && <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin flex-shrink-0 mt-0.5" />}
                        {entry.status === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0 mt-0.5" />}
                        {entry.status === 'error' && <X className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />}
                        {entry.status === 'pending' && <div className="w-3.5 h-3.5 rounded-full border border-gray-600 flex-shrink-0 mt-0.5" />}
                        <span className={`text-xs ${entry.status === 'error' ? 'text-red-400' : entry.status === 'done' ? 'text-gray-400' : 'text-gray-500'}`}>{entry.text}</span>
                      </div>
                    )
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
