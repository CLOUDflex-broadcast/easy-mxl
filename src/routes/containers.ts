/**
 * `/api/containers` — list, inspect, lifecycle actions, removal and a
 * non-following log snapshot. Also exports the short-lived container list
 * cache shared with the apps and domains routers.
 */
import { Router } from 'express';
import { HttpError } from '../errors.js';
import {
  inspectContainer,
  killContainer,
  listContainers,
  removeContainer,
  restartContainer,
  startContainer,
  stopContainer,
} from '../docker/containers.js';
import { streamLogs } from '../docker/logs.js';

/** Hard cap on the lines returned by the snapshot endpoint. */
export const MAX_SNAPSHOT_LINES = 5000;
const DEFAULT_TAIL = 200;
const SNAPSHOT_TIMEOUT_MS = 30000;
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Interpret a `?flag=` query value: `1`, `true`, `yes`, `on` (any case) are true.
 * @param {unknown} value
 * @returns {boolean}
 */
export function queryFlag(value) {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && TRUTHY.has(v.trim().toLowerCase());
}

/**
 * A `listContainers` wrapper that reuses its result for `ttlMs` so pollers
 * (flow tables, app lists) do not hammer the daemon. Failures are not cached.
 *
 * @param {import('dockerode')} docker
 * @param {{ domainRoot?: string, catalogById?: Map<string, object> }} ctx summarize context
 * @param {number} [ttlMs=2000]
 * @returns {() => Promise<object[]>} ContainerSummary[]
 */
export function createContainerCache(docker, ctx, ttlMs = 2000) {
  let cached = null;
  let cachedAt = 0;
  let inflight = null;
  return () => {
    const now = Date.now();
    if (cached && now - cachedAt < ttlMs) return Promise.resolve(cached);
    if (!inflight) {
      inflight = listContainers(docker, ctx)
        .then((list) => {
          cached = list;
          cachedAt = Date.now();
          return list;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}

/**
 * Parse `?tail=`: default 200, `all` or anything above the cap → the cap.
 * @param {unknown} raw
 * @returns {number}
 */
function parseTail(raw) {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === null || v === '') return DEFAULT_TAIL;
  if (v === 'all') return MAX_SNAPSHOT_LINES;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n)) throw new HttpError(400, 'invalid_tail', 'tail must be a non-negative integer or "all"');
  return Math.min(n, MAX_SNAPSHOT_LINES);
}

/**
 * Collect a container's current log output (no follow) as lines.
 *
 * @param {import('dockerode')} docker
 * @param {string} id
 * @param {{ tail: number, timestamps: boolean }} opts
 * @returns {Promise<{ stream: 'stdout'|'stderr', text: string }[]>}
 */
export function snapshotLogs(docker, id, { tail, timestamps }) {
  return new Promise((resolve, reject) => {
    const lines = [];
    const partial = { stdout: '', stderr: '' };
    let finished = false;
    let handle = null;
    let timer = null;

    const push = (stream, text) => {
      const parts = (partial[stream] + text).split('\n');
      partial[stream] = parts.pop();
      for (const p of parts) lines.push({ stream, text: p.endsWith('\r') ? p.slice(0, -1) : p });
    };
    const finish = (err) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (err) {
        reject(err);
        return;
      }
      for (const stream of ['stdout', 'stderr']) {
        if (partial[stream]) lines.push({ stream, text: partial[stream] });
      }
      resolve(lines.length > MAX_SNAPSHOT_LINES ? lines.slice(-MAX_SNAPSHOT_LINES) : lines);
    };

    streamLogs(docker, id, { tail, timestamps, follow: false }, {
      onChunk: push,
      onEnd: () => finish(null),
      onError: (err) => finish(err),
    }).then((h) => {
      if (finished) {
        h.stop();
        return;
      }
      handle = h;
      timer = setTimeout(() => handle.stop(), SNAPSHOT_TIMEOUT_MS);
      timer.unref();
    }, finish);
  });
}

/**
 * @param {import('../server.js').RouteContext} ctx
 * @returns {import('express').Router}
 */
export function createContainersRouter(ctx) {
  const router = Router();
  const summarizeCtx = { domainRoot: ctx.config.domainRoot, catalogById: ctx.catalogById };
  const timeoutOf = (body) => (body && typeof body === 'object' && body.timeout !== undefined ? { timeout: body.timeout } : {});

  router.get('/', async (req, res) => {
    res.json(await listContainers(ctx.docker, summarizeCtx));
  });

  router.get('/:id', async (req, res) => {
    res.json(await inspectContainer(ctx.docker, req.params.id, summarizeCtx));
  });

  const action = (verb, run) => {
    router.post(`/:id/${verb}`, async (req, res) => {
      await run(req.params.id, timeoutOf(req.body));
      const { summary } = await inspectContainer(ctx.docker, req.params.id, summarizeCtx);
      res.json({ ok: true, summary });
    });
  };
  action('start', (id) => startContainer(ctx.docker, id));
  action('stop', (id, opts) => stopContainer(ctx.docker, id, opts));
  action('restart', (id, opts) => restartContainer(ctx.docker, id, opts));
  action('kill', (id) => killContainer(ctx.docker, id));

  router.delete('/:id', async (req, res) => {
    await removeContainer(ctx.docker, req.params.id, { force: queryFlag(req.query.force), volumes: queryFlag(req.query.volumes) });
    res.json({ ok: true });
  });

  router.get('/:id/logs', async (req, res) => {
    const lines = await snapshotLogs(ctx.docker, req.params.id, {
      tail: parseTail(req.query.tail),
      timestamps: queryFlag(req.query.timestamps),
    });
    res.json({ lines });
  });

  return router;
}
