// ── Origin sharding ──────────────────────────────────────────────────────────
// Browsers cap ~6 concurrent HTTP/1.1 connections PER ORIGIN, which throttles
// parallel imports. The backend binds 0.0.0.0, so the SAME server answers under
// several distinct origins — and origin is scheme+host+port compared as STRINGS,
// so "localhost" / "127.0.0.1" / "127.0.0.2" are three different origins with
// three separate connection pools. Round-robining across them multiplies usable
// concurrency (~6 → ~24) with no server change.
//
// Loopback IP literals are used because they need no DNS at all (verified: a
// 0.0.0.0-bound server answers on 127.0.0.1/.2/.3 on Windows and Linux; macOS
// only configures 127.0.0.1 by default). *.localhost is included as a bonus —
// Chrome/Firefox resolve it internally, though the OS resolver often can't.
//
// Every candidate is probed once at startup and only pooled if it actually
// answers, so an unusable host is simply dropped — never a hard failure. Until
// probing finishes, everything uses the primary origin.
const PRIMARY = 'http://localhost:8000';
const SHARD_CANDIDATES = [
  'http://127.0.0.1:8000',
  'http://127.0.0.2:8000',
  'http://127.0.0.3:8000',
  'http://a.localhost:8000',
  'http://b.localhost:8000',
];

let origins: string[] = [PRIMARY];
let rr = 0;

/** Round-robin the next backend origin. */
function nextOrigin(): string {
  const o = origins[rr % origins.length];
  rr++;
  return o;
}

/** Active backend origins (1 = sharding unavailable / not probed yet). */
export function apiOriginCount(): number {
  return origins.length;
}

async function probeShards(): Promise<void> {
  const results = await Promise.all(SHARD_CANDIDATES.map(async (o) => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(`${o}/health`, { signal: ctl.signal });
      clearTimeout(t);
      return res.ok ? o : null;
    } catch {
      return null; // hostname didn't resolve / backend unreachable on that name
    }
  }));
  const usable = results.filter((o): o is string => o !== null);
  if (usable.length > 0) origins = [PRIMARY, ...usable];
}

// The page can load before the backend is up, which would fail every probe and
// disable sharding for the whole session — so retry once after a short delay.
async function probeShardsWithRetry(): Promise<number> {
  await probeShards();
  if (origins.length === 1) {
    await new Promise((r) => setTimeout(r, 4000));
    await probeShards();
  }
  return origins.length;
}

/** Resolves with the number of usable origins once shard probing finishes. */
export const apiOriginsReady: Promise<number> = probeShardsWithRetry();

export interface AppSettings {
  enable_groups: boolean;
  enable_points: boolean;
  checker_source_type: string;
  solution_source_type: string;
  default_time_limit: number;
  default_memory_limit: number;
}

export class ApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

async function handleResponse(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') || '';
  // Polygon API returns JSON with "text/html" content-type, so we must
  // attempt JSON parsing for any text-like response, not just application/json.
  if (ct.includes('application/json') || ct.includes('text/html') || ct.includes('text/plain')) {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      if (json.status === 'FAILED') throw new ApiError(json.comment || 'Polygon API error');
      if (!res.ok) throw new ApiError(json.detail || `HTTP ${res.status}`);
      return json;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (!res.ok) throw new ApiError(text || `HTTP ${res.status}`);
      // Not valid JSON but response is OK — return raw text (source code, test input, etc.)
      return text;
    }
  }
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`);
  return res; // raw response (binary file downloads)
}

async function get(path: string, params?: Record<string, string | number | boolean>) {
  const url = new URL(`${nextOrigin()}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }
  const res = await fetch(url.toString());
  return handleResponse(res);
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${nextOrigin()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(res);
}

async function postForm(path: string, formData: FormData) {
  const res = await fetch(`${nextOrigin()}${path}`, {
    method: 'POST',
    body: formData,
  });
  return handleResponse(res);
}

// ── Credentials ──────────────────────────────────────────────────────────────

export const api = {
  credentials: {
    get: () => get('/credentials') as Promise<{ api_key: string; has_secret: boolean; username: string }>,
    set: (api_key: string, api_secret: string, username?: string) =>
      post('/credentials', { api_key, api_secret, ...(username !== undefined ? { username } : {}) }),
  },

  settings: {
    get: () => get('/settings') as Promise<AppSettings>,
    update: (settings: Partial<AppSettings>) => post('/settings', settings),
  },

  // ── Problems ────────────────────────────────────────────────────────────────

  problems: {
    list: (params?: { showDeleted?: boolean; id?: number; name?: string; owner?: string }) =>
      get('/api/problems.list', params as Record<string, string | number | boolean>),
    create: (name: string) => post('/api/problem.create', { name }),
  },

  problem: {
    info: (problemId: number) => get('/api/problem.info', { problemId }),
    updateInfo: (data: { problemId: number; inputFile?: string; outputFile?: string; interactive?: boolean; timeLimit?: number; memoryLimit?: number }) =>
      post('/api/problem.updateInfo', data),
    updateWorkingCopy: (problemId: number) => post('/api/problem.updateWorkingCopy', { problemId }),
    discardWorkingCopy: (problemId: number) => post('/api/problem.discardWorkingCopy', { problemId }),
    commitChanges: (problemId: number, opts?: { minorChanges?: boolean; message?: string }) =>
      post('/api/problem.commitChanges', { problemId, ...opts }),

    // Statements
    statements: (problemId: number) => get('/api/problem.statements', { problemId }),
    saveStatement: (data: { problemId: number; lang: string; [key: string]: unknown }) =>
      post('/api/problem.saveStatement', data),
    statementResources: (problemId: number) => get('/api/problem.statementResources', { problemId }),
    saveStatementResource: (problemId: number, name: string, file: File) => {
      const fd = new FormData();
      fd.append('problemId', String(problemId));
      fd.append('name', name);
      fd.append('file', file);
      return postForm('/api/problem.saveStatementResource', fd);
    },

    // Checker / Validator
    checker: (problemId: number) => get('/api/problem.checker', { problemId }),
    validator: (problemId: number) => get('/api/problem.validator', { problemId }),
    extraValidators: (problemId: number) => get('/api/problem.extraValidators', { problemId }),
    interactor: (problemId: number) => get('/api/problem.interactor', { problemId }),
    setChecker: (problemId: number, checker: string) => post('/api/problem.setChecker', { problemId, checker }),
    setValidator: (problemId: number, validator: string) => post('/api/problem.setValidator', { problemId, validator }),
    setInteractor: (problemId: number, interactor: string) => post('/api/problem.setInteractor', { problemId, interactor }),

    // Validator / Checker tests
    validatorTests: (problemId: number) => get('/api/problem.validatorTests', { problemId }),
    checkerTests: (problemId: number) => get('/api/problem.checkerTests', { problemId }),
    saveValidatorTest: (data: { problemId: number; testIndex: number; testInput: string; testVerdict: string; checkExisting?: boolean }) =>
      post('/api/problem.saveValidatorTest', data),
    saveCheckerTest: (data: { problemId: number; testIndex: number; testInput: string; testOutput: string; testAnswer: string; testVerdict: string; checkExisting?: boolean }) =>
      post('/api/problem.saveCheckerTest', data),

    // Files
    files: (problemId: number) => get('/api/problem.files', { problemId }),
    saveFile: (problemId: number, type: string, name: string, file: File, sourceType?: string) => {
      const fd = new FormData();
      fd.append('problemId', String(problemId));
      fd.append('type', type);
      fd.append('name', name);
      fd.append('file', file);
      if (sourceType) fd.append('sourceType', sourceType);
      return postForm('/api/problem.saveFile', fd);
    },
    viewFile: (problemId: number, type: string, name: string) =>
      get('/api/problem.viewFile', { problemId, type, name }) as Promise<Response>,

    // Solutions
    solutions: (problemId: number) => get('/api/problem.solutions', { problemId }),
    saveSolution: (problemId: number, name: string, file: File, tag?: string, sourceType?: string) => {
      const fd = new FormData();
      fd.append('problemId', String(problemId));
      fd.append('name', name);
      fd.append('file', file);
      if (tag) fd.append('tag', tag);
      if (sourceType) fd.append('sourceType', sourceType);
      return postForm('/api/problem.saveSolution', fd);
    },
    viewSolution: (problemId: number, name: string) =>
      get('/api/problem.viewSolution', { problemId, name }) as Promise<Response>,
    editSolutionExtraTags: (data: { problemId: number; remove: boolean; name: string; testset?: string; testGroup?: string; tag?: string }) =>
      post('/api/problem.editSolutionExtraTags', data),

    // Tests
    tests: (problemId: number, testset?: string, noInputs?: boolean) =>
      get('/api/problem.tests', { problemId, testset: testset || 'tests', noInputs: !!noInputs }),
    saveTest: (data: { problemId: number; testset?: string; testIndex: number; testInput: string; [key: string]: unknown }) =>
      post('/api/problem.saveTest', data),
    testInput: (problemId: number, testset: string, testIndex: number) =>
      get('/api/problem.testInput', { problemId, testset, testIndex }) as Promise<Response>,
    testAnswer: (problemId: number, testset: string, testIndex: number) =>
      get('/api/problem.testAnswer', { problemId, testset, testIndex }) as Promise<Response>,
    setTestGroup: (data: { problemId: number; testset: string; testGroup: string; testIndices?: string }) =>
      post('/api/problem.setTestGroup', data),
    enableGroups: (problemId: number, testset: string, enable: boolean) =>
      post('/api/problem.enableGroups', { problemId, testset, enable }),
    enablePoints: (problemId: number, enable: boolean) =>
      post('/api/problem.enablePoints', { problemId, enable }),

    // Test groups
    viewTestGroup: (problemId: number, testset: string, group?: string) =>
      get('/api/problem.viewTestGroup', { problemId, testset, ...(group ? { group } : {}) }),
    saveTestGroup: (data: { problemId: number; testset: string; group: string; pointsPolicy?: string; feedbackPolicy?: string; dependencies?: string }) =>
      post('/api/problem.saveTestGroup', data),

    // Script
    script: (problemId: number, testset?: string) =>
      get('/api/problem.script', { problemId, testset: testset || 'tests' }) as Promise<Response>,
    saveScript: (problemId: number, source: string, testset?: string) =>
      post('/api/problem.saveScript', { problemId, source, testset: testset || 'tests' }),

    // Tags
    viewTags: (problemId: number) => get('/api/problem.viewTags', { problemId }),
    saveTags: (problemId: number, tags: string) => post('/api/problem.saveTags', { problemId, tags }),

    // General description / tutorial
    viewGeneralDescription: (problemId: number) => get('/api/problem.viewGeneralDescription', { problemId }),
    saveGeneralDescription: (problemId: number, description: string) =>
      post('/api/problem.saveGeneralDescription', { problemId, description }),
    viewGeneralTutorial: (problemId: number) => get('/api/problem.viewGeneralTutorial', { problemId }),
    saveGeneralTutorial: (problemId: number, tutorial: string) =>
      post('/api/problem.saveGeneralTutorial', { problemId, tutorial }),

    // Packages
    packages: (problemId: number) => get('/api/problem.packages', { problemId }),
    buildPackage: (problemId: number, full: boolean, verify: boolean) =>
      post('/api/problem.buildPackage', { problemId, full, verify }),
    downloadPackage: (problemId: number, packageId: number, type?: string) => {
      // Opens a browser window — always use the stable primary origin.
      const url = new URL(`${PRIMARY}/api/problem.package`);
      url.searchParams.set('problemId', String(problemId));
      url.searchParams.set('packageId', String(packageId));
      if (type) url.searchParams.set('type', type);
      window.open(url.toString(), '_blank');
    },
  },

  contest: {
    problems: (contestId: string) => get('/api/contest.problems', { contestId }),
  },
};
