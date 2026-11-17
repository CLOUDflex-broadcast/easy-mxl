/**
 * Host port probe: is something already listening on a TCP/UDP port of this host?
 * Used by `GET /api/ports/check` and by the launch of host-networked apps.
 */
import dgram from 'node:dgram';
import net from 'node:net';

const PROBE_TIMEOUT_MS = 1500;

/**
 * Try to bind the IPv4 wildcard `0.0.0.0:<port>` and then the IPv6 wildcard `[::]:<port>`;
 * EADDRINUSE on either means something is listening. The IPv6 bind is IPv6-only, so it also
 * finds listeners that hold the port on an IPv6 address alone (`[::1]`, or `[::]` with
 * `IPV6_V6ONLY`), which a server binding `:<port>` on both families would collide with.
 * A host without IPv6 simply fails that bind with another error and counts as free.
 * A permission error (unprivileged process, port < 1024) falls back to a loopback connect
 * probe for TCP.
 *
 * @param {number} port
 * @param {'tcp'|'udp'} protocol
 * @returns {Promise<boolean>}
 */
export async function probeListening(port, protocol) {
  if (await probeFamily(port, protocol, 4)) return true;
  return probeFamily(port, protocol, 6);
}

/**
 * @param {number} port
 * @param {'tcp'|'udp'} protocol
 * @param {4|6} family
 * @returns {Promise<boolean>}
 */
function probeFamily(port, protocol, family) {
  const host = family === 6 ? '::' : '0.0.0.0';
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
      const sock = dgram.createSocket({ type: family === 6 ? 'udp6' : 'udp4', ipv6Only: family === 6 });
      sock.once('error', (err) => {
        sock.close();
        finish(!!err && err.code === 'EADDRINUSE');
      });
      sock.bind(port, host, () => sock.close(() => finish(false)));
      return;
    }

    const server = net.createServer();
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        finish(true);
      } else if (err && err.code === 'EACCES' && family === 4) {
        connectProbe(port).then(finish, () => finish(false));
      } else {
        finish(false);
      }
    });
    server.listen({ port, host, ipv6Only: family === 6 }, () => server.close(() => finish(false)));
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
