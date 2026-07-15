import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../../api/client';
import { ImportJob, JobStatus, LogEntry } from './types';
import { runImportPipeline, JobLogger, PipelineResult } from './pipeline';

/**
 * A persistent import queue processed by a bounded worker pool.
 *   - Up to `concurrency` jobs run at once (the "several agents").
 *   - Jobs with the SAME slug are serialized (Polygon edits one working copy
 *     per problem, so two flows on one problem would conflict).
 *   - You can enqueue more jobs at any time; workers pick them up.
 * `onSettled` fires once per job when it reaches a terminal state (for history).
 */
export function useImportQueue(concurrency: number, onSettled: (job: ImportJob) => void) {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const jobsRef = useRef<ImportJob[]>(jobs);
  jobsRef.current = jobs;
  const runningSlugs = useRef<Set<string>>(new Set());
  const settled = useRef<Set<string>>(new Set());

  const patch = (id: string, p: Partial<ImportJob>) =>
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...p } : j)));

  const makeLogger = (id: string): JobLogger => ({
    addLog: (text, status = 'pending', kind) =>
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, log: [...j.log, { text, status, kind }] } : j))),
    updateLastLog: (status, text) =>
      setJobs((prev) => prev.map((j) => {
        if (j.id !== id) return j;
        const log = [...j.log];
        for (let i = log.length - 1; i >= 0; i--) {
          if (log[i].kind !== 'header') { log[i] = { ...log[i], status, ...(text ? { text } : {}) }; break; }
        }
        return { ...j, log };
      })),
  });

  const startJob = useCallback((job: ImportJob) => {
    runningSlugs.current.add(job.slug.toLowerCase());
    patch(job.id, { status: 'running', log: [] });
    (async () => {
      let res: PipelineResult;
      try {
        res = await runImportPipeline(job.parsed, job.opts, makeLogger(job.id));
      } catch (e) {
        res = { failed: true, errors: 1 };
        makeLogger(job.id).addLog(`Unexpected error: ${e instanceof Error ? e.message : 'Unknown'}`, 'error');
      }
      const status: JobStatus = res.failed ? 'failed' : res.errors > 0 ? 'warnings' : 'done';
      patch(job.id, {
        status, problemId: res.problemId, errors: res.errors,
        verifyStatus: res.verifyRequested ? 'verifying' : undefined,
      });
      runningSlugs.current.delete(job.slug.toLowerCase());
      pump();
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

  // Drive the pool whenever the queue or the concurrency changes.
  useEffect(() => { pump(); }, [jobs, concurrency, pump]);

  // Fire onSettled once per job when it reaches a terminal state.
  useEffect(() => {
    for (const j of jobs) {
      const terminal = j.status === 'done' || j.status === 'warnings' || j.status === 'failed';
      if (terminal && !settled.current.has(j.id)) {
        settled.current.add(j.id);
        onSettled(j);
      }
    }
  }, [jobs, onSettled]);

  // Background verification poller for jobs whose build is still running. Keyed
  // on the SET of verifying jobs (not the whole `jobs` array) so ongoing log
  // churn from other running jobs doesn't keep resetting the interval.
  const verifyingKey = jobs
    .filter((j) => j.verifyStatus === 'verifying' && j.problemId)
    .map((j) => `${j.id}:${j.problemId}`)
    .join('|');

  useEffect(() => {
    if (!verifyingKey) return;
    const targets = verifyingKey.split('|').map((s) => {
      const [id, pid] = s.split(':');
      return { id, problemId: Number(pid) };
    });
    let cancelled = false;
    interface Pkg { id: number; state?: string; comment?: string; creationTimeSeconds?: number }
    const poll = async () => {
      for (const t of targets) {
        if (cancelled) return;
        try {
          const res = await api.problem.packages(t.problemId) as { result?: Pkg[] };
          const pkgs = res.result || [];
          if (pkgs.length === 0) continue;
          const latest = pkgs.reduce((a, b) => (b.creationTimeSeconds ?? b.id) > (a.creationTimeSeconds ?? a.id) ? b : a);
          if (latest.state === 'READY' || latest.state === 'FAILED') {
            patch(t.id, { verifyStatus: latest.state === 'READY' ? 'passed' : 'failed', verifyComment: latest.comment });
          }
        } catch { /* transient */ }
      }
    };
    const iv = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [verifyingKey]);

  const enqueue = (newJobs: ImportJob[]) => setJobs((prev) => [...prev, ...newJobs]);

  const retryJob = (id: string) => {
    settled.current.delete(id);
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: 'queued', log: [], errors: 0, verifyStatus: undefined, verifyComment: undefined } : j)));
  };

  const retryFailed = () => {
    setJobs((prev) => prev.map((j) => {
      if (j.status !== 'failed' && j.status !== 'warnings') return j;
      settled.current.delete(j.id);
      return { ...j, status: 'queued', log: [], errors: 0, verifyStatus: undefined, verifyComment: undefined };
    }));
  };

  const clearFinished = () =>
    setJobs((prev) => prev.filter((j) => j.status === 'queued' || j.status === 'running'));

  const activeCount = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;

  return { jobs, enqueue, retryJob, retryFailed, clearFinished, activeCount };
}
