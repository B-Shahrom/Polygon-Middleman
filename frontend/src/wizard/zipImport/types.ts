import { ParsedSections } from '../../utils/statementParser';
import { AppSettings } from '../../api/client';
import { ImportHistoryEntry } from '../../utils/importHistory';

export interface ExtraSolution { filename: string; code: string; tag: string }

export interface ParsedZip {
  problemName: string;
  displayName: string;
  languages: Record<string, ParsedSections>;
  /** Per-language editorial from tutorial.mdx, keyed by language code. */
  tutorials: Record<string, string>;
  checkerCode: string | null;
  validatorCode: string | null;
  solutionCode: string | null;
  extraSolutions: ExtraSolution[];
  tests: { index: number; input: string; group: string; filename: string }[];
  hasScoring: boolean;
  scoringText: string;
  warnings: string[];
}

export interface LogEntry { text: string; status: 'pending' | 'running' | 'done' | 'error'; kind?: 'header' }

// What to do when a problem with the same slug already exists on Polygon.
//   fill  — upload the archive over it (adds missing, overwrites changed) [default]
//   reset — discard the working copy first, then upload (hard overwrite)
export type OnExists = 'fill' | 'reset';

export const ON_EXISTS_LABEL: Record<OnExists, string> = {
  fill: 'Fill / update',
  reset: 'Reset & overwrite',
};

// Background verification (buildPackage) outcome per problem.
export type VerifyStatus = 'verifying' | 'passed' | 'failed';

// Current-vs-incoming snapshot for an existing problem ("what changes?").
export interface DiffInfo {
  curTests: number; newTests: number;
  curLangs: string[]; newLangs: string[];
  curChecker: string;
}

// Fallback import defaults (used until Settings load, and as the seed for the
// optional per-batch override panel).
export const FALLBACK_SETTINGS: AppSettings = {
  enable_groups: true,
  enable_points: true,
  checker_source_type: 'cpp.gcc14-64-msys2-g++23',
  solution_source_type: 'cpp.g++17',
  default_time_limit: 1000,
  default_memory_limit: 256,
};

/** Per-problem, user-editable overrides applied at import time. */
export interface ImportOpts {
  slug: string;
  timeLimit: number;
  memoryLimit: number;
  onExists: OnExists;
  checkerType: string;
  solutionType: string;
}

/** Optional per-batch override of the Settings import defaults. */
export interface BatchOverride {
  enabled: boolean;
  timeLimit: number;
  memoryLimit: number;
  checkerType: string;
  solutionType: string;
}

export interface ParsedItem {
  fileName: string;
  parsed: ParsedZip | null;
  parseError?: string;
  skip: boolean;        // exclude this ZIP from the batch entirely
  onExists: OnExists;   // what to do if the slug already exists on Polygon
  slug: string;         // editable Polygon slug (defaults to folder name)
  timeLimit: number;    // ms
  memoryLimit: number;  // MB
}

export interface ImportResult {
  name: string;
  slug: string;
  problemId?: number;
  ok: boolean;
  errors: number;
  failed?: boolean;
  verifyRequested?: boolean;
  verifyStatus?: VerifyStatus;
  verifyComment?: string;
  parsed: ParsedZip;
  opts: ImportOpts;
}

export type Phase = 'select' | 'preview' | 'queue';

// A single queued import (one problem). Jobs are processed by a bounded worker
// pool; same-slug jobs are serialized. Each job keeps its own log.
export type JobStatus = 'queued' | 'running' | 'done' | 'warnings' | 'failed';

export interface ImportJob {
  id: string;
  batchId: string;
  name: string;   // display name
  slug: string;
  parsed: ParsedZip;
  opts: ImportOpts;
  status: JobStatus;
  log: LogEntry[];
  problemId?: number;
  errors: number;
  verifyStatus?: VerifyStatus;
  verifyComment?: string;
}

export interface HistoryBatch { key: string; ts: number; entries: ImportHistoryEntry[] }

/** Group history entries by their import run (batchId), preserving order. */
export function groupHistory(history: ImportHistoryEntry[]): HistoryBatch[] {
  const groups: HistoryBatch[] = [];
  const byId = new Map<string, number>();
  for (const h of history) {
    const key = h.batchId || `legacy-${h.ts}`;
    let gi = byId.get(key);
    if (gi === undefined) {
      gi = groups.length;
      byId.set(key, gi);
      groups.push({ key, ts: h.ts, entries: [] });
    }
    groups[gi].entries.push(h);
  }
  return groups;
}
