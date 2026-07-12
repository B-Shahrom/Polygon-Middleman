import { Loader2, CheckCircle2, AlertCircle, X, ExternalLink, RotateCcw } from 'lucide-react';
import { LogEntry, ImportResult, Phase } from './types';

interface Props {
  log: LogEntry[];
  results: ImportResult[];
  phase: Phase;
  onRetry: (targets: ImportResult[]) => void;
}

export default function ProgressView({ log, results, phase, onRetry }: Props) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5 max-h-80 overflow-y-auto">
        {log.map((entry, i) => (
          entry.kind === 'header' ? (
            <div key={i} className="flex items-center gap-2 mt-3 first:mt-0 pb-1 border-b border-[#362f28]">
              {entry.status === 'running' && <Loader2 className="w-4 h-4 text-amber-400 animate-spin flex-shrink-0" />}
              {entry.status === 'done' && <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />}
              {entry.status === 'error' && <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />}
              <span className="text-sm font-semibold text-amber-300">{entry.text}</span>
            </div>
          ) : (
            <div key={i} className="flex items-start gap-2 pl-1">
              {entry.status === 'running' && <Loader2 className="w-4 h-4 text-amber-400 animate-spin flex-shrink-0 mt-0.5" />}
              {entry.status === 'done' && <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />}
              {entry.status === 'error' && <X className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />}
              {entry.status === 'pending' && <div className="w-4 h-4 rounded-full border border-gray-600 flex-shrink-0 mt-0.5" />}
              <span className={`text-sm ${entry.status === 'error' ? 'text-red-400' : entry.status === 'done' ? 'text-gray-300' : 'text-gray-400'}`}>
                {entry.text}
              </span>
            </div>
          )
        ))}
      </div>
      {phase === 'done' && results.length > 0 && (
        <div className="bg-[#1a1714] border border-[#362f28] rounded-lg p-3 space-y-1.5">
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Summary</div>
          {results.map((r, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              {r.failed
                ? <X className="w-4 h-4 text-red-400 flex-shrink-0" />
                : r.ok
                  ? <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                  : <AlertCircle className="w-4 h-4 text-yellow-400 flex-shrink-0" />}
              <span className="text-gray-300">{r.name}</span>
              {r.problemId && (
                <a
                  href={`https://polygon.codeforces.com/edit-start?problemId=${r.problemId}`}
                  target="_blank" rel="noreferrer"
                  className="text-xs font-mono text-amber-400 hover:text-amber-300 flex items-center gap-0.5"
                >
                  #{r.problemId}<ExternalLink className="w-3 h-3" />
                </a>
              )}
              <span className="text-xs text-gray-600">
                {r.failed ? 'failed' : r.ok ? 'imported' : `imported with ${r.errors} warning${r.errors !== 1 ? 's' : ''}`}
              </span>
              {r.verifyStatus === 'verifying' && (
                <span className="flex items-center gap-1 text-xs text-amber-400/90">
                  <Loader2 className="w-3 h-3 animate-spin" />verifying
                </span>
              )}
              {r.verifyStatus === 'passed' && (
                <span className="text-xs text-green-400">✓ verified</span>
              )}
              {r.verifyStatus === 'failed' && (
                <span className="text-xs text-red-400" title={r.verifyComment || ''}>✗ verification failed</span>
              )}
              {!r.ok && (
                <button
                  onClick={() => onRetry([r])}
                  className="ml-auto flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Retry
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
