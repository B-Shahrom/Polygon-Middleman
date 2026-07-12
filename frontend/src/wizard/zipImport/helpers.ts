import { api } from '../../api/client';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Save one test, retrying transient failures (rate limits, heavy payloads).
 * Uses checkExisting:false so duplicate-content tests are still written at their
 * assigned index — otherwise Polygon rejects the duplicate and the index is left
 * empty, corrupting the testset enumeration. Returns true if the test landed.
 */
export async function saveTestWithRetry(
  pid: number,
  t: { index: number; input: string; group: string },
  retries = 3,
): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
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
      if (attempt < retries) await sleep(500 * (attempt + 1)); // linear backoff
    }
  }
  return false;
}
