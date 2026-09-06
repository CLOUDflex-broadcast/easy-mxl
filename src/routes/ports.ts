/**
 * `GET /api/ports/check?port=&protocol=` — is a host port taken by a container
 * and/or already bound on this host?
 */
import dgram from 'node:dgram';
import net from 'node:net';
import { Router } from 'express';
import { HttpError } from '../errors.js';
import { findHostPortUsage } from '../docker/launch.js';

const PROTOCOLS = new Set(['tcp', 'udp']);
const PROBE_TIMEOUT_MS = 1500;

/**
 * Try to bind `0.0.0.0:<port>`; EADDRINUSE means something is listening.
 * A permission error (unprivileged process, port < 1024) falls back to a
 * loopback connect probe for TCP.
 *
 * @param {number} port
 * @param {'tcp'|'udp'} protocol
 * @returns {Promise<boolean>}
 */
export function probeListening(port, protocol) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);

    if (protocol === 'udp') {
      const sock = dgram.createSocket('udp4');
      sock.once('error', (err) => {
        sock.close();
        finish(err && err.code === 'EADDRINUSE');
      });
      sock.bind(port, '0.0.0.0', () => sock.close(() => finish(false)));
      return;
    }

    const server = net.createServer();
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        finish(true);
      } else if (err && err.code === 'EACCES') {
        connectProbe(port).then(finish, () => finish(false));
      } else {
        finish(false);
      }
    });
    server.listen(port, '0.0.0.0', () => server.close(() => finish(false)));
  });
}

/**
 * Connect to `127.0.0.1:<port>`; resolves `true` when something accepts.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function connectProbe(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.setTimeout(PROBE_TIMEOUT_MS);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('error', () => resolve(false));
  });
}

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
