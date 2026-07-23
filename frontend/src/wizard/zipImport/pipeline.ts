import { api } from '../../api/client';
import { Problem } from '../../types/polygon';
import { deriveDependenciesFromScoring, derivePointsFromScoring } from '../../utils/statementParser';
import { ParsedZip, ImportOpts, LogEntry } from './types';
import { saveOneTest, findMissingTests, fetchExistingTests, planTestUploads, PendingTest } from './helpers';

/** Job-scoped logging sink, so concurrent jobs each write to their own log. */
export interface JobLogger {
  addLog: (text: string, status?: LogEntry['status'], kind?: 'header') => void;
  updateLastLog: (status: LogEntry['status'], text?: string) => void;
}

export interface PipelineResult {
  failed: boolean;
  errors: number;
  problemId?: number;
  verifyRequested?: boolean;
}

/**
 * Import one parsed problem into Polygon. Pure of React — logs through the
 * injected logger so it can run concurrently for many jobs. Never throttles;
 * relies on findMissingTests to self-heal dropped tests.
 *
 * Tests are written keyed by filename (their Polygon description): an incoming
 * test replaces the one with the same filename or appends at the tail, so
 * several archives of one problem accumulate instead of clobbering each other.
 * A pure test pack (`parsed.testsOnly`) only appends tests + commits, leaving
 * the existing statement, scoring and group config untouched.
 */
export async function runImportPipeline(parsed: ParsedZip, opts: ImportOpts, log: JobLogger): Promise<PipelineResult> {
  let errors = 0;

  const step = async (label: string, fn: () => Promise<string | void>) => {
    log.addLog(label, 'running');
    try {
      const msg = await fn();
      log.updateLastLog('done', msg || label.replace(/\.\.\.$/, ''));
    } catch (err) {
      errors++;
      log.updateLastLog('error', `${label.replace(/\.\.\.$/, '')} — ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  // 1. Create-or-resolve the problem.
  let problemId: number | undefined;
  let existed = false;
  log.addLog(`${parsed.testsOnly ? 'Resolving' : 'Creating'} problem "${opts.slug}"...`, 'running');
  try {
    const createRes = await api.problems.create(opts.slug) as { result?: Problem };
    problemId = createRes.result?.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already\s+have|already\s+exists|such\s+problem/i.test(msg)) {
      existed = true;
    } else {
      log.updateLastLog('error', `Failed to create problem — ${msg}`);
      return { failed: true, errors: errors + 1 };
    }
  }
  if (!problemId) {
    try {
      const listRes = await api.problems.list({}) as { result?: unknown };
      const all: Problem[] = Array.isArray((listRes as { result?: unknown }).result) ? (listRes as { result: Problem[] }).result : [];
      const target = opts.slug;
      const found = all.find((p) => p.name === target) ?? all.find((p) => p.name.toLowerCase() === target.toLowerCase());
      problemId = found?.id;
    } catch { /* fall through */ }
  }
  if (!problemId) {
    log.updateLastLog('error', `Failed to resolve problem "${opts.slug}" (${existed ? 'exists but not found in list' : 'id not returned'})`);
    return { failed: true, errors: errors + 1 };
  }

  const pid = problemId;

  if (existed) {
    if (opts.onExists === 'reset' && !parsed.testsOnly) {
      log.updateLastLog('done', `Exists (#${pid}) — reset & overwrite`);
      await step('Discarding working copy...', async () => {
        await api.problem.discardWorkingCopy(pid);
        return 'Working copy discarded';
      });
    } else {
      log.updateLastLog('done', `Exists (#${pid}) — ${parsed.testsOnly ? 'appending tests' : 'filling / updating'}`);
    }
  } else {
    log.updateLastLog('done', `Created problem #${pid}`);
  }

  // ── Shared: description-keyed test upload with self-healing fill rounds ──────
  let testsComplete = true;
  let plan: PendingTest[] = [];
  const uploadTests = async () => {
    if (parsed.tests.length === 0) return;
    await step(`Uploading ${parsed.tests.length} tests...`, async () => {
      const existing = await fetchExistingTests(pid);
      plan = planTestUploads(existing, parsed.tests);
      for (const t of plan) await saveOneTest(pid, t);

      let missing = await findMissingTests(pid, plan);
      let rounds = 0;
      let refilled = 0;
      while (missing.length > 0 && rounds < 4) {
        log.updateLastLog('running', `Filling ${missing.length} missing test(s) (round ${rounds + 1})...`);
        for (const t of missing) { if (await saveOneTest(pid, t)) refilled++; }
        missing = await findMissingTests(pid, plan);
        rounds++;
      }
      if (missing.length > 0) {
        testsComplete = false;
        throw new Error(
          `${missing.length}/${plan.length} test(s) still missing after auto-fill ` +
          `(indices ${missing.map(t => t.index).join(', ')}). Skipping commit & verify — retry to finish.`
        );
      }
      const existingIdx = new Set(existing.map(e => e.index));
      const replaced = plan.filter(t => existingIdx.has(t.index)).length;
      const added = plan.length - replaced;
      const changeNote = existing.length > 0 ? ` (${added} new, ${replaced} replaced)` : '';
      const filledNote = refilled > 0 ? ` · auto-filled ${refilled}` : '';
      return `${plan.length}/${plan.length} tests uploaded & verified${changeNote}${filledNote}`;
    });
  };

  // ── Shared: commit + verify, only if every step so far succeeded ────────────
  let verifyRequested = false;
  const commitAndVerify = async () => {
    if (errors === 0 && testsComplete) {
      await step('Committing changes...', async () => {
        await api.problem.commitChanges(pid, { message: 'Import via Polygon Middleman' });
        return 'Changes committed';
      });
      if (errors === 0) {
        log.addLog('Requesting verification (build package)...', 'running');
        try {
          await api.problem.buildPackage(pid, false, true);
          log.updateLastLog('done', 'Verification requested (building in background)');
          verifyRequested = true;
        } catch (err) {
          errors++;
          log.updateLastLog('error', `Verification request failed — ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }
    } else {
      log.addLog('Skipped commit & verify — an earlier step failed (fix and retry)', 'error');
    }
  };

  // ── Tests-only pack: just append tests, don't touch statement/scoring/groups ─
  if (parsed.testsOnly) {
    // Enable groups/points so each test's group sticks; do NOT reconfigure the
    // existing scoring (no fallback 100pts / dependency rewrite here).
    await step('Enabling groups and points...', async () => {
      await api.problem.enableGroups(pid, 'tests', true);
      await api.problem.enablePoints(pid, true);
      return 'Groups & points enabled';
    });
    await uploadTests();
    await commitAndVerify();
    return { failed: false, errors, problemId: pid, verifyRequested };
  }

  // 2. Info
  await step(`Setting problem info (TL=${opts.timeLimit}ms, ML=${opts.memoryLimit}MB)...`, async () => {
    await api.problem.updateInfo({
      problemId: pid, inputFile: 'stdin', outputFile: 'stdout', interactive: false,
      timeLimit: opts.timeLimit, memoryLimit: opts.memoryLimit,
    });
    return 'Problem info set';
  });

  // 3. Statements (+ the per-language tutorial/editorial, which Polygon stores
  //    as the statement's `tutorial` field).
  const langs = Object.keys(parsed.languages);
  if (langs.length > 0) {
    await step(`Saving statements for ${langs.length} language(s)...`, async () => {
      const withTutorial: string[] = [];
      for (const langCode of langs) {
        const s = parsed.languages[langCode];
        const tutorial = parsed.tutorials[langCode] || '';
        if (tutorial) withTutorial.push(langCode);
        await api.problem.saveStatement({
          problemId: pid, lang: langCode, encoding: 'UTF-8',
          name: s.name, legend: s.legend, input: s.input, output: s.output,
          scoring: s.scoring, interaction: s.interaction, notes: s.notes,
          ...(tutorial ? { tutorial } : {}),
        });
      }
      const tutNote = withTutorial.length > 0 ? ` · tutorial: ${withTutorial.join(', ')}` : '';
      return `Statements saved: ${langs.join(', ')}${tutNote}`;
    });
  }

  // 4. Checker
  if (parsed.checkerCode) {
    await step('Uploading checker.cpp...', async () => {
      const f = new File([new Blob([parsed.checkerCode!], { type: 'text/plain' })], 'checker.cpp', { type: 'text/plain' });
      await api.problem.saveFile(pid, 'source', 'checker.cpp', f, opts.checkerType);
      await api.problem.setChecker(pid, 'checker.cpp');
      return 'Checker uploaded & set';
    });
  }

  // 4b. Validator
  if (parsed.validatorCode) {
    await step('Uploading validator.cpp...', async () => {
      const f = new File([new Blob([parsed.validatorCode!], { type: 'text/plain' })], 'validator.cpp', { type: 'text/plain' });
      await api.problem.saveFile(pid, 'source', 'validator.cpp', f, opts.checkerType);
      await api.problem.setValidator(pid, 'validator.cpp');
      return 'Validator uploaded & set';
    });
  }

  // 5. Main solution
  if (parsed.solutionCode) {
    await step('Uploading solution.cpp [MA]...', async () => {
      const f = new File([new Blob([parsed.solutionCode!], { type: 'text/plain' })], 'solution.cpp', { type: 'text/plain' });
      await api.problem.saveSolution(pid, 'solution.cpp', f, 'MA', opts.solutionType);
      return 'Solution uploaded (MA)';
    });
  }

  // 5b. Extra solutions
  if (parsed.extraSolutions.length > 0) {
    await step(`Uploading ${parsed.extraSolutions.length} extra solution(s)...`, async () => {
      let uploaded = 0;
      const labels: string[] = [];
      for (const s of parsed.extraSolutions) {
        try {
          const f = new File([new Blob([s.code], { type: 'text/plain' })], s.filename, { type: 'text/plain' });
          await api.problem.saveSolution(pid, s.filename, f, s.tag, opts.solutionType);
          uploaded++;
          labels.push(`${s.filename} [${s.tag}]`);
        } catch { /* continue */ }
      }
      if (uploaded === 0) throw new Error('all extra solutions failed');
      return `Extra solutions: ${labels.join(', ')}`;
    });
  }

  // 6. Enable groups & points
  await step('Enabling groups and points...', async () => {
    await api.problem.enableGroups(pid, 'tests', true);
    await api.problem.enablePoints(pid, true);
    return 'Groups & points enabled';
  });

  // 7. Tests — description-keyed upload with self-healing fill.
  await uploadTests();

  // 8. Group policies + deps + points (indices come from the upload plan).
  const allGroups = [...new Set(plan.map(t => t.group))].sort((a, b) => Number(a) - Number(b));
  if (allGroups.length > 0) {
    await step('Configuring group policies...', async () => {
      await api.problem.enableGroups(pid, 'tests', true);
      await api.problem.enablePoints(pid, true);

      const nonSampleGroups = allGroups.filter(g => g !== '0');
      const setGroupPoints = async (group: string, pts: number) => {
        const t = plan.find((x) => x.group === group);
        if (!t) return false;
        await api.problem.saveTest({ problemId: pid, testset: 'tests', testIndex: t.index, testInput: t.input, testGroup: group, testPoints: pts, ...(t.filename ? { testDescription: t.filename } : {}), checkExisting: false });
        return true;
      };

      if (parsed.hasScoring) {
        const depMap = deriveDependenciesFromScoring(parsed.scoringText);
        const pointsMap = derivePointsFromScoring(parsed.scoringText);
        for (const group of allGroups) {
          const deps = depMap[group];
          await api.problem.saveTestGroup({ problemId: pid, testset: 'tests', group, pointsPolicy: 'COMPLETE_GROUP', ...(deps && deps.length ? { dependencies: deps.join(',') } : {}) });
        }
        let ptsApplied = 0;
        for (const [group, pts] of Object.entries(pointsMap)) if (await setGroupPoints(group, pts)) ptsApplied++;
        return `Derived from scoring — deps: ${Object.keys(depMap).length} group(s), points: ${ptsApplied} group(s) (COMPLETE_GROUP)`;
      }

      const lastGroup = allGroups[allGroups.length - 1];
      const otherGroups = allGroups.filter(g => g !== lastGroup);
      for (const group of allGroups) {
        const deps = group === lastGroup && otherGroups.length > 0 ? otherGroups.join(',') : undefined;
        await api.problem.saveTestGroup({ problemId: pid, testset: 'tests', group, pointsPolicy: 'COMPLETE_GROUP', ...(deps ? { dependencies: deps } : {}) });
      }
      let ptsInfo = '';
      if (nonSampleGroups.length > 0) {
        const pointsGroup = nonSampleGroups[nonSampleGroups.length - 1];
        if (await setGroupPoints(pointsGroup, 100)) ptsInfo = `, 100pts on group ${pointsGroup}`;
      }
      const depInfo = otherGroups.length > 0 ? `, group ${lastGroup} depends on ${otherGroups.join(',')}` : '';
      return `Groups configured (COMPLETE_GROUP)${depInfo}${ptsInfo}`;
    });
  }

  // 9 & 10. Commit + verify (only if everything succeeded).
  await commitAndVerify();

  return { failed: false, errors, problemId: pid, verifyRequested };
}
