/**
 * Mounts every `/api/*` router and adds the JSON 404 for unknown API paths.
 */
import { Router } from 'express';
import { HttpError } from '../errors.js';
import { createAppsRouter } from './apps.js';
import { createContainersRouter } from './containers.js';
import { createDomainsRouter } from './domains.js';
import { createHealthRouter } from './health.js';
import { createImagesRouter } from './images.js';
import { createJobsRouter } from './jobs.js';
import { createPortsRouter } from './ports.js';

/**
 * @param {import('../server.js').RouteContext} ctx
 * @returns {import('express').Router} router to mount at `/api`
 */
export function createApiRouter(ctx) {
  const api = Router();
  api.use('/health', createHealthRouter(ctx));
  api.use('/apps', createAppsRouter(ctx));
  api.use('/containers', createContainersRouter(ctx));
  api.use('/domains', createDomainsRouter(ctx));
  api.use('/jobs', createJobsRouter(ctx));
  api.use('/images', createImagesRouter(ctx));
  api.use('/ports', createPortsRouter(ctx));
  api.use((req, res, next) => {
    next(new HttpError(404, 'not_found', `No API route for ${req.method} ${req.originalUrl}`));
  });
  return api;
}
