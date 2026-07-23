import { ParsedZip } from './types';

/** Pull the developer's global test index out of a testset filename.
 *  Prefers an explicit `idx<n>`; falls back to the first number; else keeps
 *  input order. Used to re-order tests that arrive split across archives. */
export function globalIndexFromFilename(filename: string): number {
  const m = filename.match(/idx(\d+)/i) || filename.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Merge several archives that belong to the SAME problem (same slug) into one
 * logical problem. A problem may be split across a "main" archive (statement +
 * checker + solution + some tests) and one or more test-only packs, because the
 * problem-developing agent caps archive size.
 *
 * - The statement / checker / solution / scoring come from the main archive
 *   (the first one that actually carries them).
 * - Tests from every archive are pooled and re-ordered by (group, global index
 *   parsed from the filename), then renumbered 1..N. Indices are globally unique
 *   across the archives, so this reconstructs the intended testset even when a
 *   later archive carries a different subset of groups.
 * - If no archive carries a statement/checker/solution, the result is a pure
 *   test pack (`testsOnly`) that only appends tests.
 *
 * `parsedList` must be non-empty and all share the same slug.
 */
export function mergeParsedGroup(parsedList: ParsedZip[]): ParsedZip {
  if (parsedList.length === 1) return parsedList[0];

  // The "main" archive is the first with real problem content.
  const main =
    parsedList.find(p => Object.keys(p.languages).length > 0 || p.checkerCode || p.solutionCode || p.validatorCode) ||
    parsedList[0];

  // Pool every test, then order by group, then by the global filename index.
  const pooled = parsedList.flatMap(p => p.tests);
  pooled.sort((a, b) => {
    const ga = Number(a.group), gb = Number(b.group);
    if (ga !== gb) return ga - gb;
    return globalIndexFromFilename(a.filename) - globalIndexFromFilename(b.filename);
  });
  const tests = pooled.map((t, i) => ({ index: i + 1, input: t.input, group: t.group, filename: t.filename }));

  const testsOnly =
    Object.keys(main.languages).length === 0 &&
    !main.checkerCode && !main.solutionCode && !main.validatorCode &&
    main.extraSolutions.length === 0;

  // Fold each archive's warnings in, tagged by source, plus a merge note.
  const warnings = [
    `Merged ${parsedList.length} archives → ${tests.length} tests total`,
    ...parsedList.flatMap(p => p.warnings),
  ];

  return {
    problemName: main.problemName,
    displayName: main.displayName,
    languages: main.languages,
    tutorials: main.tutorials,
    checkerCode: main.checkerCode,
    validatorCode: main.validatorCode,
    solutionCode: main.solutionCode,
    extraSolutions: main.extraSolutions,
    tests,
    hasScoring: main.hasScoring,
    scoringText: main.scoringText,
    warnings,
    testsOnly,
  };
}
