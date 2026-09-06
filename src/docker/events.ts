/**
 * Docker event stream subscription with automatic reconnection.
 */
import { log } from '../log.js';

/**
 * Convert a raw Docker event into the compact `onEvent` shape.
 * @param {object} ev
 * @returns {{ type: string|null, action: string|null, id: string|null, name: string|null, image: string|null, time: string|null, attributes: object }}
 */
function normalizeEvent(ev) {
  const actor = ev.Actor && typeof ev.Actor === 'object' ? ev.Actor : {};
  const attributes = actor.Attributes && typeof actor.Attributes === 'object' ? { ...actor.Attributes } : {};
  const type = typeof ev.Type === 'string' ? ev.Type : null;
  let time = null;
  if (typeof ev.timeNano === 'number' && Number.isFinite(ev.timeNano)) {
    time = new Date(Math.floor(ev.timeNano / 1e6)).toISOString();
  } else if (typeof ev.time === 'number' && Number.isFinite(ev.time)) {
    time = new Date(ev.time * 1000).toISOString();
  }
  const id = typeof actor.ID === 'string' ? actor.ID : (typeof ev.id === 'string' ? ev.id : null);
  return {
    type,
    action: typeof ev.Action === 'string' ? ev.Action : (typeof ev.status === 'string' ? ev.status : null),
    id,
    name: typeof attributes.name === 'string' ? attributes.name : null,
    image: typeof attributes.image === 'string' ? attributes.image : (type === 'image' ? id : null),
    time,
    attributes,
  };
}

/**
 * Subscribe to Docker events. The returned handle keeps the subscription
 * alive across daemon restarts: when the stream drops it reconnects with
 * exponential backoff (`minBackoffMs` → `maxBackoffMs`). Nothing thrown by the
 * daemon or by `onEvent` escapes after this function returns.
 *
 * @param {import('dockerode')} docker
 * @param {(event: ReturnType<typeof normalizeEvent>) => void} onEvent
 * @param {{ types?: string[], minBackoffMs?: number, maxBackoffMs?: number }} [opts]
 * @returns {Promise<{ stop(): void }>}
 */
export async function watchEvents(docker, onEvent, { types = ['container', 'image'], minBackoffMs = 1000, maxBackoffMs = 30000 } = {}) {
  if (typeof onEvent !== 'function') {
    throw new TypeError('watchEvents: onEvent must be a function');
  }
  const filters = Array.isArray(types) && types.length ? { type: types.map(String) } : undefined;
  let stopped = false;
  let stream = null;
  let timer = null;
  let delay = minBackoffMs;

  const emit = (raw) => {
    let event;
    try {
      event = normalizeEvent(raw);
    } catch (err) {
      log.debug('ignoring malformed docker event', { error: err });
      return;
    }
    try {
      onEvent(event);
    } catch (err) {
      log.warn('docker event handler threw', { error: err });
    }
  };

  const scheduleReconnect = () => {
    if (stopped || timer) return;
    const wait = delay;
    delay = Math.min(delay * 2, maxBackoffMs);
    log.debug(`docker events: reconnecting in ${wait} ms`);
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, wait);
    if (typeof timer.unref === 'function') timer.unref();
  };

  async function connect() {
    if (stopped) return;
    let s;
    try {
      s = await docker.getEvents(filters ? { filters } : {});
    } catch (err) {
      log.warn('docker events: connection failed', { error: err });
      scheduleReconnect();
      return;
    }
    if (stopped) {
      s.destroy();
      return;
    }
    stream = s;
    delay = minBackoffMs;
    let buffer = '';
    s.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let raw;
        try {
          raw = JSON.parse(line);
        } catch {
          log.debug('docker events: skipping non-JSON line');
          continue;
        }
        if (raw && typeof raw === 'object') emit(raw);
      }
    });
    const onDone = (err) => {
      if (stream !== s) return;
      stream = null;
      if (stopped) return;
      if (err) log.warn('docker events: stream error', { error: err });
      else log.info('docker events: stream ended');
      scheduleReconnect();
    };
    s.once('error', onDone);
    s.once('end', () => onDone(null));
    s.once('close', () => onDone(null));
  }

  await connect();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (stream) {
        const s = stream;
        stream = null;
        s.destroy();
      }
    },
  };
}
