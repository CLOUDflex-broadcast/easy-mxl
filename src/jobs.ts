/**
 * In-memory registry of long-running jobs (image pulls, app launches).
 *
 * The registry is an EventEmitter that emits `'update'` with the job object
 * whenever a job is created or changed, so the WebSocket layer can forward
 * `{ type: 'job', job }` messages.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HttpError, toHttpError } from './errors.js';
import { log } from './log.js';

/**
 * @typedef {object} Job
 * @property {string} id uuid
 * @property {string} kind e.g. `'launch'`, `'pull'`
 * @property {object} meta caller-supplied metadata
 * @property {'running'|'done'|'error'} status
 * @property {{ message: string, current: number|null, total: number|null }|null} progress
 * @property {unknown} result set when `status === 'done'`
 * @property {{ message: string, code: string, details: unknown }|null} error set when `status === 'error'`
 * @property {string} createdAt ISO
 * @property {string} updatedAt ISO
 */

/**
 * Normalise a progress patch into `{ message, current, total }`.
 * @param {unknown} progress
 * @returns {Job['progress']}
 */
function normalizeProgress(progress) {
  if (progress === null || progress === undefined) return null;
  if (typeof progress === 'string') return { message: progress, current: null, total: null };
  if (typeof progress !== 'object') return { message: String(progress), current: null, total: null };
  const p = /** @type {any} */ (progress);
  return {
    message: typeof p.message === 'string' ? p.message : (typeof p.status === 'string' ? p.status : ''),
    current: typeof p.current === 'number' ? p.current : null,
    total: typeof p.total === 'number' ? p.total : null,
  };
}

class JobRegistry extends EventEmitter {
  /**
   * @param {{ maxJobs?: number }} [opts]
   */
  constructor({ maxJobs = 200 } = {}) {
    super();
    if (!Number.isInteger(maxJobs) || maxJobs < 1) {
      throw new Error('createJobRegistry: maxJobs must be a positive integer');
    }
    /** @type {Map<string, Job>} */
    this.jobs = new Map();
    this.maxJobs = maxJobs;
  }

  /**
   * Register a new running job.
   * @param {string} kind
   * @param {object} [meta]
   * @returns {Job}
   */
  create(kind, meta = {}) {
    if (typeof kind !== 'string' || !kind) {
      throw new Error('JobRegistry.create: kind must be a non-empty string');
    }
    const now = new Date().toISOString();
    /** @type {Job} */
    const job = {
      id: randomUUID(),
      kind,
      meta: meta && typeof meta === 'object' ? meta : {},
      status: 'running',
      progress: null,
      result: undefined,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.prune();
    this.notify(job);
    return job;
  }

  /**
   * Merge a patch into a job. `progress` is normalised; other known fields
   * (`status`, `result`, `error`, `meta`) are replaced.
   *
   * @param {string} id
   * @param {Partial<Job>} patch
   * @returns {Job}
   * @throws {HttpError} 404 `job_not_found`
   */
  update(id, patch = {}) {
    const job = this.jobs.get(id);
    if (!job) {
      throw new HttpError(404, 'job_not_found', `Unknown job "${id}"`, { id });
    }
    const p = patch && typeof patch === 'object' ? patch : {};
    if ('progress' in p) job.progress = normalizeProgress(p.progress);
    if ('status' in p && ['running', 'done', 'error'].includes(p.status)) job.status = p.status;
    if ('result' in p) job.result = p.result;
    if ('error' in p) job.error = p.error === null || p.error === undefined ? null : toJobError(p.error);
    if ('meta' in p && p.meta && typeof p.meta === 'object') job.meta = { ...job.meta, ...p.meta };
    job.updatedAt = new Date().toISOString();
    this.notify(job);
    return job;
  }

  /**
   * @param {string} id
   * @returns {Job|undefined}
   */
  get(id) {
    return this.jobs.get(id);
  }

  /**
   * All jobs, newest first.
   * @returns {Job[]}
   */
  list() {
    return [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /**
   * Create a job and run `fn(job)`; marks it `done` with the result or
   * `error` with a normalised error. Returns the job immediately.
   *
   * @template T
   * @param {string} kind
   * @param {object} meta
   * @param {(job: Job) => Promise<T>|T} fn
   * @returns {Job}
   */
  run(kind, meta, fn) {
    const job = this.create(kind, meta);
    Promise.resolve()
      .then(() => fn(job))
      .then(
        (result) => {
          this.update(job.id, { status: 'done', result: result === undefined ? null : result, progress: null });
        },
        (err) => {
          const httpErr = toHttpError(err);
          log.warn(`job ${job.id} (${kind}) failed`, { code: httpErr.code, message: httpErr.message });
          this.update(job.id, { status: 'error', error: httpErr });
        },
      );
    return job;
  }

  /**
   * Drop the oldest finished jobs when the registry exceeds `maxJobs`.
   * Running jobs are never evicted.
   * @returns {void}
   */
  prune() {
    if (this.jobs.size <= this.maxJobs) return;
    const finished = this.list().filter((j) => j.status !== 'running').reverse(); // oldest first
    for (const job of finished) {
      if (this.jobs.size <= this.maxJobs) break;
      this.jobs.delete(job.id);
    }
  }

  /**
   * Emit `'update'` without letting listener errors propagate into job logic.
   * @param {Job} job
   */
  notify(job) {
    try {
      this.emit('update', job);
    } catch (err) {
      log.warn('job update listener threw', { id: job.id, error: err });
    }
  }
}

/**
 * Normalise anything thrown into the Job error shape.
 * @param {unknown} err
 * @returns {{ message: string, code: string, details: unknown }}
 */
function toJobError(err) {
  const httpErr = toHttpError(err);
  return { message: httpErr.message, code: httpErr.code, details: httpErr.details === undefined ? null : httpErr.details };
}

/**
 * Create a job registry.
 *
 * @param {{ maxJobs?: number }} [opts]
 * @returns {JobRegistry}
 */
export function createJobRegistry({ maxJobs = 200 } = {}) {
  return new JobRegistry({ maxJobs });
}
