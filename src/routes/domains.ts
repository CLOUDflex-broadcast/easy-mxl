/**
 * `/api/domains` — MXL domain CRUD, flows and attached containers.
 */
import fs from 'node:fs/promises';
import { Router } from 'express';
import { HttpError } from '../errors.js';
import { listContainers } from '../docker/containers.js';
import {
  createDomain,
  deleteDomain,
  deleteFlow,
  domainPath,
  getDomain,
  listDomains,
  updateDomainOptions,
  repairDomainDef,
} from '../mxl/domain.js';
import { readFlow, scanFlows } from '../mxl/flows.js';
import { queryFlag } from './containers.js';

const ACTIVE_STATES = new Set(['running', 'restarting', 'paused']);

/**
 * Does the container mount (or is it labelled with) this domain?
 * @param {object} container ContainerSummary
 * @param {string} name domain name
 * @param {string} dir absolute domain directory
 * @returns {boolean}
 */
function isAttached(container, name, dir) {
  if (container.domain === name) return true;
  const base = dir.replace(/\/+$/, '');
  return (container.domainMounts || []).some((m) => m.source === base || m.source.startsWith(`${base}/`));
}

/**
 * Add `writerContainer: { id, name } | null` to flows whose writer PID mapped to a container.
 * @param {object[]} flows
 * @param {object[]} containers ContainerSummary[]
 * @returns {object[]}
 */
function withWriterContainers(flows, containers) {
  const byId = new Map(containers.map((c) => [c.id, c]));
  return flows.map((flow) => {
    const c = flow.writerContainerId ? byId.get(flow.writerContainerId) : undefined;
    return { ...flow, writerContainer: c ? { id: c.id, name: c.name } : null };
  });
}

/**
 * Domain directory path after checking the directory exists.
 * @param {string} root
 * @param {string} name
 * @returns {Promise<string>}
 * @throws {HttpError} 400 invalid name, 404 `domain_not_found`
 */
async function existingDomainDir(root, name) {
  const dir = domainPath(root, name);
  try {
    if ((await fs.stat(dir)).isDirectory()) return dir;
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
  }
  throw new HttpError(404, 'domain_not_found', `Domain "${name}" not found`);
}

/**
 * @param {import('../server.js').RouteContext} ctx
 * @returns {import('express').Router}
 */
export function createDomainsRouter(ctx) {
  const router = Router();
  const root = () => ctx.config.domainRoot;
  const owner = () => ({ uid: ctx.config.domainUid, gid: ctx.config.domainGid, mode: ctx.config.domainMode });
  const summarizeCtx = { domainRoot: ctx.config.domainRoot, catalogById: ctx.catalogById };
  // Pin the TAI offset only when it is authoritative (CLOCK_TAI probe, fixed or custom). With an
  // assumed-zero offset the scanner estimates it from an actively written flow instead.
  const AUTHORITATIVE_TAI = new Set(['python3', 'fixed', 'custom']);
  const scanOpts = async () => {
    const tai = await ctx.getTaiOffset();
    return tai && AUTHORITATIVE_TAI.has(tai.source) ? { taiOffsetNs: tai.offsetNs } : {};
  };
  const containersSoft = () => ctx.listContainersCached().catch((err) => {
    ctx.log.debug('domains: container list unavailable', { error: err && err.message });
    return [];
  });

  router.get('/', async (req, res) => {
    res.json(await listDomains(root(), await scanOpts()));
  });

  router.post('/', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body) throw new HttpError(400, 'validation_error', 'Body must be a JSON object with at least { "name" }');
    res.status(201).json(await createDomain(root(), body, owner()));
  });

  router.get('/:name', async (req, res) => {
    const [domain, containers] = await Promise.all([
      getDomain(root(), req.params.name, { withFlows: true, ...(await scanOpts()) }),
      containersSoft(),
    ]);
    res.json({ ...domain, flows: withWriterContainers(domain.flows || [], containers) });
  });

  router.post('/:name/repair', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (body.force !== undefined && typeof body.force !== 'boolean') throw new HttpError(400, 'validation_error', 'force must be a boolean');
    res.json(await repairDomainDef(root(), req.params.name, body, { force: body.force === true }));
  });

  router.patch('/:name', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    res.json(await updateDomainOptions(root(), req.params.name, body));
  });

  router.delete('/:name', async (req, res) => {
    const name = req.params.name;
    const force = queryFlag(req.query.force);
    const dir = await existingDomainDir(root(), name);
    if (!force) {
      let containers = [];
      try {
        containers = await listContainers(ctx.docker, summarizeCtx);
      } catch (err) {
        ctx.log.warn('cannot list containers; deleting domain without the attached-container check', { domain: name, error: err && err.message });
      }
      const attached = containers
        .filter((c) => ACTIVE_STATES.has(c.state) && isAttached(c, name, dir))
        .map((c) => ({ id: c.id, name: c.name, state: c.state }));
      if (attached.length) {
        throw new HttpError(
          409,
          'domain_in_use',
          `Domain "${name}" is mounted by ${attached.length} running container(s): ${attached.map((c) => c.name).join(', ')}. Stop them first or force the deletion`,
          { containers: attached },
        );
      }
    }
    await deleteDomain(root(), name, { force });
    res.json({ ok: true });
  });

  router.get('/:name/flows', async (req, res) => {
    const dir = await existingDomainDir(root(), req.params.name);
    const [flows, containers] = await Promise.all([scanFlows(dir, await scanOpts()), containersSoft()]);
    res.json(withWriterContainers(flows, containers));
  });

  router.get('/:name/flows/:flowId', async (req, res) => {
    const dir = await existingDomainDir(root(), req.params.name);
    const [flow, containers] = await Promise.all([readFlow(dir, req.params.flowId, await scanOpts()), containersSoft()]);
    res.json(withWriterContainers([flow], containers)[0]);
  });

  router.delete('/:name/flows/:flowId', async (req, res) => {
    await deleteFlow(root(), req.params.name, req.params.flowId, { force: queryFlag(req.query.force) });
    res.json({ ok: true });
  });

  router.get('/:name/containers', async (req, res) => {
    const name = req.params.name;
    const dir = await existingDomainDir(root(), name);
    const containers = await ctx.listContainersCached();
    res.json(containers.filter((c) => isAttached(c, name, dir)));
  });

  return router;
}
