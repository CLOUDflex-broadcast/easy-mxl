/**
 * Host port probe: is something already listening on a TCP/UDP port of this host?
 * Used by `GET /api/ports/check` and by the launch of host-networked apps.
 */
import dgram from 'node:dgram';
import net from 'node:net';

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
