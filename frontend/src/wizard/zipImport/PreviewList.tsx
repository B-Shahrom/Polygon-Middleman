import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { ParsedItem, ParsedZip, BatchOverride, DiffInfo, OnExists, ON_EXISTS_LABEL } from './types';

interface Props {
  items: ParsedItem[];
  updateItem: (idx: number, patch: Partial<ParsedItem>) => void;
  batch: BatchOverride;
  setBatch: (b: BatchOverride) => void;
  existingByName: Map<string, number>;
  diffs: Record<number, DiffInfo | 'loading'>;
  loadDiff: (idx: number, problemId: number, parsed: ParsedZip) => void;
  hideDiff: (idx: number) => void;
  okCount: number;
  badCount: number;
}

const inputCls = 'bg-[#1a1714] border border-[#362f28] rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-amber-500';

export default function PreviewList({ items, updateItem, batch, setBatch, existingByName, diffs, loadDiff, hideDiff, okCount, badCount }: Props) {
  // How many non-skipped archives share each slug — those merge into one problem.
  const slugCount = new Map<string, number>();
  for (const it of items) {
    if (!it.parsed || it.skip) continue;
    const s = it.slug.trim() || it.parsed.problemName;
    slugCount.set(s, (slugCount.get(s) || 0) + 1);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">
        {okCount} problem{okCount !== 1 ? 's' : ''} ready to import
        {badCount > 0 && <span className="text-yellow-400"> · {badCount} could not be read</span>}
      </p>

      {/* Optional per-batch override of the Settings import defaults */}
      <div className="border border-[#362f28] rounded-lg overflow-hidden">
        <label className="flex items-center gap-2 px-3 py-2 bg-[#211e1a] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={batch.enabled}
            onChange={(e) => setBatch({ ...batch, enabled: e.target.checked })}
            className="rounded accent-amber-500"
          />
          <span className="text-sm text-gray-300">Override import defaults for this batch</span>
          <span className="text-xs text-gray-600">(otherwise uses Settings)</span>
        </label>
        {batch.enabled && (
          <div className="px-3 py-2.5 grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              Checker source type
              <input value={batch.checkerType} onChange={(e) => setBatch({ ...batch, checkerType: e.target.value })} className={`${inputCls} font-mono`} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              Solution source type
              <input value={batch.solutionType} onChange={(e) => setBatch({ ...batch, solutionType: e.target.value })} className={`${inputCls} font-mono`} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              Time limit (ms) — applies to all
              <input type="number" min={250} step={250} value={batch.timeLimit}
                onChange={(e) => setBatch({ ...batch, timeLimit: Number(e.target.value) || 1000 })} className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              Memory limit (MB) — applies to all
              <input type="number" min={64} step={64} value={batch.memoryLimit}
                onChange={(e) => setBatch({ ...batch, memoryLimit: Number(e.target.value) || 256 })} className={inputCls} />
            </label>
          </div>
        )}
      </div>

      <div className="space-y-2 max-h-[26rem] overflow-y-auto pr-1">
        {items.map((item, idx) => (
          <div key={idx} className={`border rounded-lg overflow-hidden ${!item.parsed ? 'border-red-500/30' : item.skip ? 'border-[#2a251f] opacity-55' : 'border-[#362f28]'}`}>
            <div className="bg-[#211e1a] px-3 py-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {item.parsed
                  ? <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                  : <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />}
                <span className="text-sm font-medium text-gray-200 truncate">
                  {item.parsed ? item.parsed.displayName : item.fileName}
                </span>
                {item.parsed?.testsOnly && (
                  <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 flex-shrink-0">tests only</span>
                )}
                {item.parsed && !item.skip && (slugCount.get(item.slug.trim() || item.parsed.problemName) || 1) > 1 && (
                  <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 flex-shrink-0">
                    merges ×{slugCount.get(item.slug.trim() || item.parsed.problemName)}
                  </span>
                )}
              </div>
              {item.parsed && (
                <div className="flex items-center gap-3 flex-shrink-0">
                  <label className="flex items-center gap-1.5 text-xs text-gray-500">
                    If exists
                    <select
                      value={item.onExists}
                      onChange={(e) => updateItem(idx, { onExists: e.target.value as OnExists })}
                      disabled={item.skip}
                      className="bg-[#1a1714] border border-[#362f28] rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-amber-500 disabled:opacity-50"
                    >
                      {(Object.keys(ON_EXISTS_LABEL) as OnExists[]).map((k) => (
                        <option key={k} value={k}>{ON_EXISTS_LABEL[k]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={item.skip}
                      onChange={(e) => updateItem(idx, { skip: e.target.checked })}
                      className="rounded accent-amber-500"
                    />
                    Skip
                  </label>
                </div>
              )}
            </div>
            {item.parsed ? (
              <div className="px-3 py-2.5 space-y-2">
                {/* Editable overrides */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <label className="flex items-center gap-1.5 text-xs text-gray-500">
                    Slug
                    <input value={item.slug} onChange={(e) => updateItem(idx, { slug: e.target.value })} className={`${inputCls} font-mono w-56`} />
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-gray-500">
                    TL
                    <input type="number" min={250} step={250} value={item.timeLimit}
                      onChange={(e) => updateItem(idx, { timeLimit: Number(e.target.value) || 1000 })} className={`${inputCls} w-20`} />
                    <span className="text-gray-600">ms</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-gray-500">
                    ML
                    <input type="number" min={64} step={64} value={item.memoryLimit}
                      onChange={(e) => updateItem(idx, { memoryLimit: Number(e.target.value) || 256 })} className={`${inputCls} w-20`} />
                    <span className="text-gray-600">MB</span>
                  </label>
                </div>

                {/* Component summary */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span className="text-gray-500">
                    Langs: <span className="text-gray-300 capitalize">{Object.keys(item.parsed.languages).join(', ') || 'none'}</span>
                  </span>
                  <span className="text-gray-500">
                    Tests: <span className="text-gray-300">{item.parsed.tests.length}</span>
                    {item.parsed.tests.length > 0 && (
                      <span className="text-gray-600"> (groups {[...new Set(item.parsed.tests.map(t => t.group))].sort((a, b) => Number(a) - Number(b)).join(',')})</span>
                    )}
                  </span>
                  <span className={item.parsed.checkerCode ? 'text-green-400' : 'text-yellow-400'}>checker {item.parsed.checkerCode ? '✓' : '✗'}</span>
                  <span className={item.parsed.solutionCode ? 'text-green-400' : 'text-yellow-400'}>solution {item.parsed.solutionCode ? '✓' : '✗'}</span>
                  {item.parsed.validatorCode && <span className="text-green-400">validator ✓</span>}
                  {Object.keys(item.parsed.tutorials).length > 0 && (
                    <span className="text-green-400">tutorial ✓ <span className="text-gray-600 capitalize">({Object.keys(item.parsed.tutorials).join(',')})</span></span>
                  )}
                  {item.parsed.extraSolutions.length > 0 && (
                    <span className="text-gray-500">+{item.parsed.extraSolutions.length} sol ({item.parsed.extraSolutions.map(s => s.tag).join(',')})</span>
                  )}
                  {!item.parsed.hasScoring && !item.parsed.testsOnly && <span className="text-gray-600">no scoring → 100pts on last group</span>}
                  {item.parsed.testsOnly && <span className="text-sky-300/80">appends tests · statement &amp; scoring untouched</span>}
                </div>

                {/* Slug conflict warning + change preview */}
                {existingByName.has(item.slug.trim().toLowerCase()) && (() => {
                  const existingId = existingByName.get(item.slug.trim().toLowerCase())!;
                  const diff = diffs[idx];
                  return (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5 text-xs text-amber-400 flex-wrap">
                        <AlertCircle className="w-3 h-3 flex-shrink-0" />
                        Exists on Polygon (#{existingId}) — will be <strong className="font-semibold">{ON_EXISTS_LABEL[item.onExists].toLowerCase()}</strong>.
                        <button
                          onClick={() => diff ? hideDiff(idx) : loadDiff(idx, existingId, item.parsed!)}
                          className="underline underline-offset-2 hover:text-amber-300"
                        >
                          {diff ? 'hide changes' : 'what changes?'}
                        </button>
                      </div>
                      {diff === 'loading' && (
                        <div className="flex items-center gap-1.5 text-xs text-gray-500 pl-4"><Loader2 className="w-3 h-3 animate-spin" />loading current state…</div>
                      )}
                      {diff && diff !== 'loading' && (
                        <div className="text-xs text-gray-400 pl-4 space-y-0.5 font-mono">
                          <div>tests: <span className="text-gray-500">{diff.curTests}</span> → <span className="text-gray-200">{diff.newTests}</span>{diff.curTests > diff.newTests && <span className="text-yellow-400"> (⚠ {diff.curTests - diff.newTests} surplus stay unless reset+deleted)</span>}</div>
                          <div>langs: <span className="text-gray-500">{diff.curLangs.join(',') || '—'}</span> → <span className="text-gray-200">{diff.newLangs.join(',') || '—'}</span></div>
                          <div>checker: <span className="text-gray-500">{diff.curChecker}</span> → <span className="text-gray-200">checker.cpp</span></div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Validation warnings */}
                {item.parsed.warnings.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    {item.parsed.warnings.map((w, wi) => (
                      <div key={wi} className="flex items-center gap-1.5 text-xs text-yellow-400/90">
                        <AlertCircle className="w-3 h-3 flex-shrink-0" />{w}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="px-3 py-2 text-xs text-red-400">{item.parseError}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
