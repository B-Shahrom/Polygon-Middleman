// Local, persistent record of ZIP imports so a batch's problem IDs survive
// closing the modal / reloading the app. Stored in localStorage.

export interface ImportHistoryEntry {
  ts: number;                 // epoch ms
  batchId?: string;           // groups entries from the same import run
  name: string;               // display name
  slug: string;               // Polygon slug used
  problemId?: number;         // undefined if create failed
  status: 'imported' | 'warnings' | 'failed';
}

const KEY = 'polygon_middleman_import_history';
const MAX = 500;

export function loadImportHistory(): ImportHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Append entries (newest first) and persist, capped at MAX. */
export function appendImportHistory(entries: ImportHistoryEntry[]): ImportHistoryEntry[] {
  const next = [...entries, ...loadImportHistory()].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
  return next;
}

export function clearImportHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
