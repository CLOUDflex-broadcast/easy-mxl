/**
 * `GET /api/images` (catalog image presence) and `POST /api/images/pull` (job).
 */
import { Router } from 'express';
import { HttpError, toHttpError } from '../errors.js';
import { normalizeImageRef, pullImage } from '../docker/images.js';

/**
 * Inspect one image reference; a missing image is reported, other daemon
 * errors propagate (the whole endpoint is about the daemon's image store).
 *
 * @param {import('dockerode')} docker
 * @param {string} ref normalised image reference
 * @returns {Promise<{ ref: string, present: boolean, id: string|null, size: number|null, created: string|null }>}
 */
async function describeImage(docker, ref) {
  try {
    const info = await docker.getImage(ref).inspect();
    return {
      ref,
      present: true,
      id: typeof info.Id === 'string' ? info.Id : null,
      size: typeof info.Size === 'number' ? info.Size : null,
      created: typeof info.Created === 'string' ? info.Created : null,
    };
  } catch (err) {
    if (err && err.statusCode === 404) return { ref, present: false, id: null, size: null, created: null };
    throw toHttpError(err);
  }
}

/**
 * @param {import('../server.js').RouteContext} ctx
 * @returns {import('express').Router}
 */
export function createImagesRouter(ctx) {
  const router = Router();

  router.get('/', async (req, res) => {
    const refs = [...new Set(ctx.catalog.map((app) => normalizeImageRef(app.image)))];
    res.json(await Promise.all(refs.map((ref) => describeImage(ctx.docker, ref))));
  });

  router.post('/pull', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.image !== 'string' || !body.image.trim()) {
      throw new HttpError(400, 'validation_error', 'Body must be { "image": "<reference>" }');
    }
    const image = normalizeImageRef(body.image);
    const job = ctx.jobs.run('pull', { image }, (j) =>
      pullImage(ctx.docker, image, (progress) => {
        try {
          ctx.jobs.update(j.id, { progress });
        } catch (err) {
          ctx.log.debug('could not record pull progress', { job: j.id, error: err });
        }
      }));
    res.status(202).json({ jobId: job.id });
  });

  return router;
}
