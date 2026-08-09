import { useState, useRef, useEffect, useCallback } from 'react';
import { api, VerifyStatusResponse, VerifyProblem } from '../../api/client';
import { ImportJob, JobStatus, VerifyStatus } from './types';

/**
 * A persistent import queue. Each job uploads its archive(s) to the backend's
 * async import endpoint (POST /api/import-problem) — the WHOLE pipeline runs
 * server-side (one implementation, shared with the headless/Maestro path). The
 * queue then polls GET /api/verify-status/{jobId} and mirrors the backend's
 * per-problem state + step log into the UI.
 *   - Up to `concurrency` jobs are submitted at once (the "several agents").
 *   - Same-slug jobs are serialized here AND on the backend (one working copy
 *     per problem).
 *   - Enqueue more jobs any time; the pool picks them up. `onSettled` fires once
 *     per job when its import reaches a terminal state (for history).
 */
export function useImportQueue(concurrency: number, onSettled: (job: ImportJob) => void) {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const jobsRef = useRef<ImportJob[]>(jobs);
  jobsRef.current = jobs;
  const runningSlugs = useRef<Set<string>>(new Set());
  const settled = useRef<Set<string>>(new Set());

  const patch = (id: string, p: Partial<ImportJob>) =>
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...p } : j)));

  // Map a backend problem record onto a frontend job. The import "slot" is freed
  // as soon as the import finishes, even while the build/verify keeps running.
  const applyBackendProblem = (jobId: string, slug: string, prob: VerifyProblem) => {
    const importDone = prob.importState === 'imported' || prob.importState === 'failed' || prob.importState === 'cancelled';
    const status: JobStatus = !importDone
      ? 'running'
      : prob.importState === 'cancelled' ? 'cancelled'
      : prob.importState === 'failed' ? 'failed' : prob.errors > 0 ? 'warnings' : 'done';

    let verifyStatus: VerifyStatus | undefined;
    const v = prob.verify;
    if (v?.state === 'READY') verifyStatus = 'passed';
    else if (v?.state === 'FAILED') verifyStatus = 'failed';
    else if (prob.verifyRequested) verifyStatus = 'verifying';

    const p: Partial<ImportJob> = {
      status,
      errors: prob.errors,
      problemId: prob.problemId ?? undefined,
      verifyStatus,
      verifyComment: v?.comment,
    };
    // Only overwrite the log once the backend has real steps. Until the pipeline
    // logs its first step (e.g. while it waits on a same-slug lock), prob.log is
    // empty — keep showing "Submitting to backend…" rather than flashing back to
    // "Waiting to start…" for the whole upload.
    if (prob.log && prob.log.length) p.log = prob.log;
    patch(jobId, p);
    if (importDone) runningSlugs.current.delete(slug.toLowerCase());
  };

  const startJob = useCallback((job: ImportJob) => {
    runningSlugs.current.add(job.slug.toLowerCase());
    patch(job.id, { status: 'running', log: [{ text: 'Submitting to backend…', status: 'running' }] });
    (async () => {
      try {
        const res = await api.import.problem(job.files, job.opts);
        if (res.parseErrors && res.parseErrors.length > 0) {
          patch(job.id, { status: 'failed', log: [{ text: `Parse error: ${res.parseErrors[0].error}`, status: 'error' }] });
          runningSlugs.current.delete(job.slug.toLowerCase());
          return;
        }
        // The poller (keyed on backendJobId) takes over from here.
        patch(job.id, { backendJobId: res.jobId });
      } catch (e) {
        patch(job.id, { status: 'failed', log: [{ text: `Submit failed: ${e instanceof Error ? e.message : 'Unknown error'}`, status: 'error' }] });
        runningSlugs.current.delete(job.slug.toLowerCase());
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pump = useCallback(() => {
    let slots = concurrency - runningSlugs.current.size;
    if (slots <= 0) return;
    for (const job of jobsRef.current) {
      if (slots <= 0) break;
      if (job.status !== 'queued') continue;
      const slug = job.slug.toLowerCase();
      if (runningSlugs.current.has(slug)) continue;  // serialize same-slug jobs
      slots--;
      startJob(job);
    }
  }, [concurrency, startJob]);

  useEffect(() => { pump(); }, [jobs, concurrency, pump]);

  // onSettled once per job when its import reaches a terminal state.
  useEffect(() => {
    for (const j of jobs) {
      const terminal = j.status === 'done' || j.status === 'warnings' || j.status === 'failed';
      if (terminal && !settled.current.has(j.id)) {
        settled.current.add(j.id);
        onSettled(j);
      }
    }
  }, [jobs, onSettled]);

  // Poll verify-status for every job that has a backend job and isn't fully
  // settled (import still running, or build still verifying). Keyed on that set
  // so log churn doesn't reset the interval.
  const pollKey = jobs
    .filter((j) => j.backendJobId && (j.status === 'running' || j.verifyStatus === 'verifying'))
    .map((j) => `${j.id}:${j.backendJobId}:${j.slug}`)
    .join('|');

  useEffect(() => {
    if (!pollKey) return;
    const targets = pollKey.split('|').map((s) => {
      const [id, bid, ...slugParts] = s.split(':');
      return { id, bid, slug: slugParts.join(':') };
    });
    let cancelled = false;
    const poll = async () => {
      for (const t of targets) {
        if (cancelled) return;
        try {
          const resp = await api.import.verifyStatus(t.bid) as VerifyStatusResponse;
          const prob = resp.problems?.[0];
          if (prob) applyBackendProblem(t.id, t.slug, prob);
        } catch { /* transient — keep polling */ }
      }
    };
    poll();
    const iv = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollKey]);

  const enqueue = (newJobs: ImportJob[]) => setJobs((prev) => [...prev, ...newJobs]);

  const resetJob = (j: ImportJob): ImportJob => ({
    ...j, status: 'queued', log: [], errors: 0,
    backendJobId: undefined, verifyStatus: undefined, verifyComment: undefined,
  });

  const retryJob = (id: string) => {
    settled.current.delete(id);
    setJobs((prev) => prev.map((j) => (j.id === id ? resetJob(j) : j)));
  };

  const retryFailed = () => {
    setJobs((prev) => prev.map((j) => {
      if (j.status !== 'failed' && j.status !== 'warnings' && j.status !== 'cancelled') return j;
      settled.current.delete(j.id);
      return resetJob(j);
    }));
  };

  const clearFinished = () =>
    setJobs((prev) => prev.filter((j) => j.status === 'queued' || j.status === 'running'));

  // Stop a single running job (cancel its backend task) or drop it if still queued.
  const stopJob = (id: string) => {
    const job = jobsRef.current.find((j) => j.id === id);
    if (!job) return;
    if (job.backendJobId) api.import.cancel(job.backendJobId).catch(() => {});
    settled.current.add(id);
    runningSlugs.current.delete(job.slug.toLowerCase());
    patch(id, { status: 'cancelled', log: [...(job.log || []), { text: 'Cancelled by user', status: 'error' }] });
  };

  // Stop EVERYTHING in flight: cancel all backend tasks, drop queued jobs, and mark
  // queued/running jobs cancelled so the pump won't resubmit them.
  const stopAll = () => {
    api.import.cancelAll().catch(() => {});
    setJobs((prev) => prev.map((j) => {
      if (j.status !== 'queued' && j.status !== 'running') return j;
      if (j.backendJobId) api.import.cancel(j.backendJobId).catch(() => {});
      settled.current.add(j.id);
      runningSlugs.current.delete(j.slug.toLowerCase());
      return { ...j, status: 'cancelled' as const, log: [...(j.log || []), { text: 'Cancelled by user', status: 'error' }] };
    }));
  };

  const activeCount = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;

  return { jobs, enqueue, retryJob, retryFailed, clearFinished, stopJob, stopAll, activeCount };
}
