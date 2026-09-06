/**
 * Image presence checks and pulls with progress reporting.
 */
import { HttpError, toHttpError } from '../errors.js';
import { log } from '../log.js';

/**
 * Normalise an image reference: append `:latest` when neither a tag nor a
 * digest is present. Registry ports (`localhost:5000/img`) are recognised.
 *
 * @param {string} ref
 * @returns {string}
 * @throws {HttpError} 400 for an empty/non-string reference
 */
export function normalizeImageRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new HttpError(400, 'invalid_image', 'Image reference must be a non-empty string');
  }
  const r = ref.trim();
  if (r.includes('@')) return r;
  const lastSlash = r.lastIndexOf('/');
  const lastColon = r.lastIndexOf(':');
  return lastColon > lastSlash ? r : `${r}:latest`;
}

/**
 * Whether the image is available locally.
 *
 * @param {import('dockerode')} docker
 * @param {string} ref
 * @returns {Promise<boolean>}
 * @throws {HttpError} for daemon errors other than "no such image"
 */
export async function imagePresent(docker, ref) {
  const name = normalizeImageRef(ref);
  try {
    await docker.getImage(name).inspect();
    return true;
  } catch (err) {
    if (err && err.statusCode === 404) return false;
    throw toHttpError(err);
  }
}

/**
 * Locally present tags of one or more repositories (for images delivered as archives and
 * loaded with `docker load`). Exact repository match: `media-app` does not match
 * `media-app-x`. Architecture-specific deliveries pass one repository per architecture.
 *
 * @param {import('dockerode')} docker
 * @param {string|string[]} repository repository (or list) without tag, e.g. `media-app-amd64`
 * @returns {Promise<{ ref: string, tag: string, id: string, created: string|null, size: number|null }[]>} newest first; `[]` when the daemon cannot be queried
 * @throws {HttpError} 400 when no repository is given
 */
export async function listLocalImages(docker, repository) {
  const repositories = (Array.isArray(repository) ? repository : [repository])
    .map((r) => (typeof r === 'string' ? r.trim() : ''))
    .filter(Boolean);
  if (!repositories.length) {
    throw new HttpError(400, 'invalid_image', 'Image repository must be a non-empty string');
  }
  let images;
  try {
    images = await docker.listImages();
  } catch (err) {
    log.debug('listLocalImages: cannot list images', { repositories, error: err && err.message });
    return [];
  }
  const out = [];
  for (const img of Array.isArray(images) ? images : []) {
    const tags = Array.isArray(img && img.RepoTags) ? img.RepoTags : [];
    for (const ref of tags) {
      if (typeof ref !== 'string' || ref.includes('<none>')) continue;
      const repo = repositories.find((r) => ref.startsWith(`${r}:`));
      if (!repo) continue;
      const created = Number.isFinite(Number(img.Created)) ? new Date(Number(img.Created) * 1000).toISOString() : null;
      out.push({ ref, tag: ref.slice(repo.length + 1), id: String(img.Id || ''), created, size: Number.isFinite(Number(img.Size)) ? Number(img.Size) : null });
    }
  }
  out.sort((a, b) => (b.created || '').localeCompare(a.created || '') || a.ref.localeCompare(b.ref));
  return out;
}

/**
 * Map a Docker error (rejection or in-stream `error` event) to an HttpError.
 * @param {unknown} err
 * @param {string} image
 * @returns {HttpError}
 */
function pullError(err, image) {
  const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
  // Registry-side throttling (Docker Hub anonymous pull limits) and auth failures are reported by
  // the daemon as generic 500s whose text mentions the upstream HTTP status; classify them first
  // so they are not mistaken for a missing image.
  if (/429|too ?many ?requests|toomanyrequests/i.test(message)) {
    return new HttpError(429, 'pull_rate_limited', `Pull of "${image}" was rate limited by the registry: ${message.trim()}`, { image });
  }
  if (/unauthorized|authentication required|denied: requested access|401 Unauthorized|403 Forbidden/i.test(message)) {
    return new HttpError(403, 'pull_unauthorized', `Pull of "${image}" was refused by the registry: ${message.trim()}`, { image });
  }
  if ((err && err.statusCode === 404) || /not found|manifest unknown|does not exist|no such|name unknown|repository .* not exist/i.test(message)) {
    return new HttpError(404, 'image_not_found', `Image "${image}" not found: ${message.trim()}`, { image });
  }
  if (err && typeof err.statusCode === 'number') {
    const converted = toHttpError(err);
    return new HttpError(converted.status, converted.code, `Pull of "${image}" failed: ${converted.message}`, { image });
  }
  return new HttpError(502, 'pull_failed', `Pull of "${image}" failed: ${message.trim()}`, { image });
}

/**
 * Convert a raw pull progress event into the `onProgress` shape.
 * @param {object} evt
 * @returns {{ status: string, id: string|null, current: number|null, total: number|null, message: string }}
 */
function mapProgress(evt) {
  const status = typeof evt.status === 'string' ? evt.status : (evt.error ? 'error' : '');
  const id = typeof evt.id === 'string' && evt.id ? evt.id : null;
  const detail = evt.progressDetail && typeof evt.progressDetail === 'object' ? evt.progressDetail : {};
  const current = typeof detail.current === 'number' ? detail.current : null;
  const total = typeof detail.total === 'number' ? detail.total : null;
  let message = evt.error ? String(evt.error) : status;
  if (id) message = `${id}: ${message}`;
  if (typeof evt.progress === 'string' && evt.progress) message += ` ${evt.progress}`;
  return { status, id, current, total, message };
}

/**
 * Pull an image, reporting layer progress. Resolves when the pull completed;
 * rejects with `HttpError` (404 `image_not_found`, 502 `pull_failed`, …).
 *
 * @param {import('dockerode')} docker
 * @param {string} ref
 * @param {(progress: { status: string, id: string|null, current: number|null, total: number|null, message: string }) => void} [onProgress]
 * @returns {Promise<void>}
 */
export async function pullImage(docker, ref, onProgress) {
  const image = normalizeImageRef(ref);
  let stream;
  try {
    stream = await docker.pull(image);
  } catch (err) {
    throw pullError(err, image);
  }
  await new Promise((resolve, reject) => {
    let failure = null;
    docker.modem.followProgress(
      stream,
      (err, output) => {
        if (err) {
          reject(pullError(err, image));
          return;
        }
        const errorEvent = failure || (Array.isArray(output) ? output.find((o) => o && o.error) : null);
        if (errorEvent) {
          reject(pullError({ message: errorEvent.error }, image));
          return;
        }
        resolve();
      },
      (evt) => {
        if (!evt || typeof evt !== 'object') return;
        if (evt.error && !failure) failure = evt;
        if (typeof onProgress !== 'function') return;
        try {
          onProgress(mapProgress(evt));
        } catch (hookErr) {
          log.warn('pull progress hook threw', { image, error: hookErr });
        }
      },
    );
  });
}
