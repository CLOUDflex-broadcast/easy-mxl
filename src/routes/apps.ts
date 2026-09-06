/**
 * `/api/apps` — the catalog with live decoration, and app launches as jobs.
 */
import { Router } from 'express';
import { HttpError } from '../errors.js';
import { resolveApp } from '../catalog.js';
import { imagePresent as isImagePresent, listLocalImages } from '../docker/images.js';
import { buildCreateOptions, checkNameConflict, launchApp } from '../docker/launch.js';
import { getDomain, listDomains } from '../mxl/domain.js';

/**
 * Validate and normalise the launch request body into `LaunchParams`.
 * @param {unknown} body
 * @returns {object}
 * @throws {HttpError} 400 when the body is not an object
 */
function normalizeLaunchParams(body) {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'validation_error', 'Launch parameters must be a JSON object');
  }
  const params = { .../** @type {object} */ (body) };
  if (params.domain !== undefined && params.domain !== null) {
    if (typeof params.domain !== 'string') throw new HttpError(400, 'validation_error', 'domain must be a string');
    params.domain = params.domain.trim() || null;
  }
  if (params.image !== undefined && params.image !== null) {
    if (typeof params.image !== 'string') throw new HttpError(400, 'validation_error', 'image must be a string');
    params.image = params.image.trim();
    if (!params.image) delete params.image;
  }
  if (params.pull !== undefined && params.pull !== null && params.pull !== 'missing' && params.pull !== 'always') {
    throw new HttpError(400, 'invalid_pull_policy', `pull must be "missing" or "always" (got ${JSON.stringify(params.pull)})`);
  }
  if (params.launchRequires !== undefined && params.launchRequires !== null && typeof params.launchRequires !== 'boolean') {
    throw new HttpError(400, 'validation_error', 'launchRequires must be a boolean');
  }
  return params;
}

/**
 * Decorate a catalog entry with live image state and the containers created from it.
 * Local (docker load) apps list their loaded tags; registry apps report `imagePresent`.
 * @param {import('../server.js').RouteContext} ctx
 * @param {object} app
 * @param {object[]} containers ContainerSummary[]
 * @returns {Promise<object>}
 */
async function decorateApp(ctx, app, containers) {
  const out = {
    ...app,
    imagePresent: null,
    containers: containers.filter((c) => c.app === app.id).map((c) => ({ id: c.id, name: c.name, state: c.state })),
  };
  if (app.imagePolicy === 'local') {
    const repositories = Array.isArray(app.imageRepositories) && app.imageRepositories.length ? app.imageRepositories : [app.imageRepository];
    const localImages = await listLocalImages(ctx.docker, repositories).catch((err) => {
      ctx.log.debug('apps: local image listing failed', { repositories, error: err && err.message });
      return [];
    });
    out.localImages = localImages;
    out.imagePresent = localImages.length > 0;
  } else {
    out.imagePresent = await isImagePresent(ctx.docker, app.image).catch((err) => {
      ctx.log.debug('apps: image check failed', { image: app.image, error: err && err.message });
      return null;
    });
  }
  return out;
}

/**
 * Render a `launchApp` progress hook call as job progress.
 * @param {'pull'|'dependency'|'create'|'start'} stage
 * @param {any} detail
 * @returns {{ message: string, current: number|null, total: number|null }}
 */
function describeProgress(stage, detail) {
  const d = detail && typeof detail === 'object' ? detail : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (stage) {
    case 'pull':
      return { message: d.message ? `Pull ${d.image}: ${d.message}` : `Pulling ${d.image}`, current: num(d.current), total: num(d.total) };
    case 'dependency':
      return { message: `Dependency ${d.app}: ${d.action}${d.name ? ` (${d.name})` : ''}`, current: null, total: null };
    case 'create':
      return { message: `Creating container ${d.name} from ${d.image}`, current: null, total: null };
    case 'start':
      return { message: `Starting container ${d.name}`, current: null, total: null };
    default:
      return { message: String(stage), current: null, total: null };
  }
}

/**
 * @param {import('../server.js').RouteContext} ctx
 * @returns {import('express').Router}
 */
export function createAppsRouter(ctx) {
  const router = Router();
  const root = () => ctx.config.domainRoot;

  const containersSoft = () => ctx.listContainersCached().catch((err) => {
    ctx.log.debug('apps: container list unavailable', { error: err && err.message });
    return [];
  });

  router.get('/', async (req, res) => {
    const containers = await containersSoft();
    res.json(await Promise.all(ctx.catalog.map((app) => decorateApp(ctx, app, containers))));
  });

  router.get('/:id', async (req, res) => {
    const app = resolveApp(ctx.catalogById, req.params.id);
    res.json(await decorateApp(ctx, app, await containersSoft()));
  });

  router.post('/:id/launch', async (req, res) => {
    const app = resolveApp(ctx.catalogById, req.params.id);
    const params = normalizeLaunchParams(req.body);
    const domain = app.domainMount && params.domain ? await getDomain(root(), params.domain) : null;

    // Validate everything that can be known now so the caller gets a 400 instead of a failed job.
    const { name } = buildCreateOptions(app, params, { domain, config: ctx.config });
    if (params.launchRequires !== false) {
      for (const dep of app.requires || []) {
        if (!ctx.catalogById.has(dep)) {
          throw new HttpError(400, 'unknown_dependency', `App "${app.id}" requires "${dep}", which is not in the catalog (or is disabled). Set launchRequires=false to launch without it.`, { app: app.id, dependency: dep });
        }
      }
    }
    const conflict = await checkNameConflict(ctx.docker, name);
    if (conflict) {
      throw new HttpError(409, 'name_conflict', `A container named "${name}" already exists (${conflict.state})`, conflict);
    }

    const launchCtx = {
      config: ctx.config,
      catalogById: ctx.catalogById,
      getDomain: (domainName) => getDomain(root(), domainName),
    };
    const job = ctx.jobs.run('launch', { app: app.id, name, domain: domain ? domain.name : null }, (j) => {
      const hooks = {
        catalogById: ctx.catalogById,
        listDomains: () => listDomains(root()),
        onProgress: (stage, detail) => {
          try {
            ctx.jobs.update(j.id, { progress: describeProgress(stage, detail) });
          } catch (err) {
            ctx.log.debug('could not record launch progress', { job: j.id, error: err });
          }
        },
      };
      return launchApp(ctx.docker, app, params, launchCtx, hooks);
    });
    res.status(202).json({ jobId: job.id });
  });

  return router;
}
