/**
 * `GET /api/jobs`, `GET /api/jobs/:id` — the in-memory job registry.
 */
import { Router } from 'express';
import { HttpError } from '../errors.js';

/**
 * @param {import('../server.js').RouteContext} ctx
 * @returns {import('express').Router}
 */
export function createJobsRouter(ctx) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(ctx.jobs.list());
  });

  router.get('/:id', (req, res) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new HttpError(404, 'job_not_found', `Unknown job "${req.params.id}"`, { id: req.params.id });
    res.json(job);
  });

  return router;
}
