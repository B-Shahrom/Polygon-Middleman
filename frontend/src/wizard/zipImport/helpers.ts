import { api } from '../../api/client';

type PendingTest = { index: number; input: string; group: string };

/**
 * Save one test (single attempt). checkExisting:false so duplicate-content tests
 * are still written at their assigned index — otherwise Polygon rejects the
 * duplicate and the index is left empty, corrupting the testset enumeration.
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
      checkExisting: false,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the expected tests that are NOT yet present on the platform (by index).
 * Used to auto-fill dropped/skipped tests after an upload pass. On a query
 * failure we assume complete (return []) rather than loop forever.
 */
export async function findMissingTests<T extends PendingTest>(pid: number, expected: T[]): Promise<T[]> {
  try {
    const res = await api.problem.tests(pid, 'tests', true) as { result?: { index: number }[] };
    const have = new Set((res.result || []).map(t => t.index));
    return expected.filter(t => !have.has(t.index));
  } catch {
    return [];
  }
}
