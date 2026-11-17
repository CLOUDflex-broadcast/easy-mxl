/**
 * `GET /api/ports/check?port=&protocol=` — is a host port taken by a container
 * and/or already bound on this host?
 */
import { Router } from 'express';
import { HttpError } from '../errors.js';
import { findHostPortUsage } from '../docker/launch.js';
import { probeListening } from '../portprobe.js';

export { probeListening };

const PROTOCOLS = new Set(['tcp', 'udp']);

/**
 * @param {import('../server.js').RouteContext} ctx
 * @returns {import('express').Router}
 */
export function createPortsRouter(ctx) {
  const router = Router();

  router.get('/check', async (req, res) => {
    const raw = req.query.port;
    const port = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new HttpError(400, 'validation_error', 'port must be an integer between 1 and 65535');
    }
    const protocol = typeof req.query.protocol === 'string' && req.query.protocol ? req.query.protocol.toLowerCase() : 'tcp';
    if (!PROTOCOLS.has(protocol)) {
      throw new HttpError(400, 'validation_error', 'protocol must be tcp or udp');
    }

    const [container, listening] = await Promise.all([
      findHostPortUsage(ctx.docker, port, protocol).catch((err) => {
        ctx.log.warn('port check: container scan failed', { port, protocol, error: err && err.message });
        return null;
      }),
      probeListening(port, /** @type {'tcp'|'udp'} */ (protocol)),
    ]);
    res.json({ port, protocol, container, listening });
  });

  return router;
}
