import { Copy, Trash2, ExternalLink, CheckCircle2, AlertCircle, X } from 'lucide-react';
import Button from '../../components/ui/Button';
import { ImportHistoryEntry } from '../../utils/importHistory';
import { groupHistory } from './types';

interface Props {
  history: ImportHistoryEntry[];
  onCopyAll: () => void;
  onCopyBatch: (slugs: string[]) => void;
  onClear: () => void;
  onBack: () => void;
}

export default function HistoryPanel({ history, onCopyAll, onCopyBatch, onClear, onBack }: Props) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200">Import History</h3>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" icon={<Copy className="w-3.5 h-3.5" />} onClick={onCopyAll} disabled={history.length === 0}>
            Copy slugs
          </Button>
          <Button variant="ghost" size="sm" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={onClear} disabled={history.length === 0}>
            Clear
          </Button>
          <Button variant="secondary" size="sm" onClick={onBack}>Back</Button>
        </div>
      </div>
      {history.length === 0 ? (
        <p className="text-sm text-gray-600">No imports recorded yet.</p>
      ) : (
        <div className="space-y-3 max-h-[24rem] overflow-y-auto pr-1">
          {groupHistory(history).map((batch) => (
            <div key={batch.key} className="border border-[#362f28] rounded-lg overflow-hidden">
              <div className="bg-[#211e1a] px-3 py-1.5 flex items-center justify-between gap-2">
                <span className="text-xs text-gray-400">
                  {new Date(batch.ts).toLocaleString()} · <span className="text-gray-500">{batch.entries.length} problem{batch.entries.length !== 1 ? 's' : ''}</span>
                </span>
                <button
                  onClick={() => onCopyBatch(batch.entries.map(e => e.slug))}
                  className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
                >
                  <Copy className="w-3 h-3" />Copy slugs
                </button>
              </div>
              <div className="divide-y divide-[#362f28]/40">
                {batch.entries.map((h, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm py-1.5 px-3">
                    {h.status === 'imported'
                      ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                      : h.status === 'warnings'
                        ? <AlertCircle className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
                        : <X className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />}
                    <span className="text-gray-300 truncate">{h.name}</span>
                    <span className="text-xs font-mono text-gray-600 truncate">{h.slug}</span>
                    {h.problemId && (
                      <a
                        href={`https://polygon.codeforces.com/edit-start?problemId=${h.problemId}`}
                        target="_blank" rel="noreferrer"
                        className="ml-auto text-xs font-mono text-amber-400 hover:text-amber-300 flex items-center gap-0.5 flex-shrink-0"
                      >
                        #{h.problemId}<ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
