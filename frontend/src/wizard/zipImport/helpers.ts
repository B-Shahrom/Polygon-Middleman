import { api } from '../../api/client';

/** A test to upload. `filename` is stored as the Polygon test description and is
 *  the identity key for append-or-replace across archives / re-uploads. */
export type PendingTest = { index: number; input: string; group: string; filename: string };

/**
 * Save one test (single attempt). checkExisting:false so duplicate-content tests
 * are still written at their assigned index — otherwise Polygon rejects the
 * duplicate and the index is left empty, corrupting the testset enumeration.
 * The filename is written as the test description so re-uploads and later test
 * packs can be matched by name instead of clobbering by position.
 * Reliability comes from findMissingTests + re-fill rounds, not artificial delays.
 */
export async function saveOneTest(pid: number, t: PendingTest): Promise<boolean> {
  try {
    await api.problem.saveTest({
      problemId: pid,
      testset: 'tests',
      testIndex: t.index,
      testInput: t.input,
      testGroup: t.group,
      testUseInStatements: t.group === '0',
      ...(t.filename ? { testDescription: t.filename } : {}),
      checkExisting: false,
    });
    return true;
  } catch {
    return false;
  }
}

/** Existing tests on the platform, as {index, description}. Empty on failure. */
export async function fetchExistingTests(pid: number): Promise<{ index: number; description: string }[]> {
  try {
    const res = await api.problem.tests(pid, 'tests', true) as { result?: { index: number; description?: string }[] };
    return (res.result || []).map(t => ({ index: t.index, description: (t.description || '').trim() }));
  } catch {
    return [];
  }
}

/**
 * Decide where each incoming test lands, keyed by filename (description):
 *   - same filename already on the platform → REPLACE at its existing index
 *   - new filename                          → APPEND at max index + 1
 * A within-run guard means two incoming tests sharing a filename never collide
 * onto the same slot — the second one appends. Returns the planned target
 * indices (contiguous 1..N for a fresh problem; extends the tail for a fill).
 */
export function planTestUploads(
  existing: { index: number; description: string }[],
  incoming: PendingTest[],
): PendingTest[] {
  const descToIndex = new Map<string, number>();
  let maxIndex = 0;
  for (const e of existing) {
    maxIndex = Math.max(maxIndex, e.index);
    if (e.description) descToIndex.set(e.description, e.index);
  }
  const usedThisRun = new Set<string>();
  return incoming.map((t) => {
    const key = t.filename;
    let target: number;
    if (key && descToIndex.has(key) && !usedThisRun.has(key)) {
      target = descToIndex.get(key)!;      // replace in place
    } else {
      target = ++maxIndex;                 // append at the tail
    }
    if (key) usedThisRun.add(key);
    return { ...t, index: target };
  });
}

/**
 * Return the expected tests that are NOT yet present on the platform (by index).
 * Used to auto-fill dropped/skipped tests after an upload pass. On a query
 * failure we assume complete (return []) rather than loop forever.
 */
export async function findMissingTests<T extends { index: number }>(pid: number, expected: T[]): Promise<T[]> {
  try {
    const res = await api.problem.tests(pid, 'tests', true) as { result?: { index: number }[] };
    const have = new Set((res.result || []).map(t => t.index));
    return expected.filter(t => !have.has(t.index));
  } catch {
    return [];
  }
}
