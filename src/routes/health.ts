/**
 * `GET /api/health` — server, Docker daemon and domain-root status.
 */
import { Router } from 'express';
import { pingDocker } from '../docker/client.js';
import { fsInfo } from '../mxl/domain.js';
import { readProcLocksOrNull } from '../mxl/locks.js';

/**
 * @param {import('../server.js').RouteContext} ctx
 * @returns {import('express').Router}
 */
export function createHealthRouter(ctx) {
  const router = Router();

  router.get('/', async (req, res) => {
    const [docker, domainRootFs, locks, tai] = await Promise.all([
      pingDocker(ctx.docker),
      fsInfo(ctx.config.domainRoot),
      readProcLocksOrNull(),
      ctx.getTaiOffset(),
    ]);
    res.json({
      ok: true,
      version: ctx.config.version,
      docker,
      domainRoot: ctx.config.domainRoot,
      domainRootFs,
      procLocksReadable: locks !== null,
      taiOffsetNs: tai.offsetNs,
      taiSource: tai.source,
    });
  });

  return router;
}
