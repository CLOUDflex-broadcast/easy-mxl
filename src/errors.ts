/**
 * HTTP-aware error type shared by every module.
 *
 * Modules throw `HttpError` for conditions that map cleanly to a status code
 * (validation → 400, missing → 404, conflicts → 409, Docker unreachable → 502).
 * The express error handler serialises it as `{ error: { code, message, details } }`.
 */
export interface ErrorPayload<T = unknown> {
  error: { code: string; message: string; details?: T };
}

export class HttpError<T = unknown> extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: T;

  /**
   * @param {number} status HTTP status code
   * @param {string} code machine-readable code, snake_case (e.g. "name_conflict")
   * @param {string} [message] human-readable message (defaults to code)
   * @param {any} [details] optional structured details
   */
  constructor(status: number, code: string, message?: string, details?: T) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toJSON(): ErrorPayload<T> {
    const error: ErrorPayload<T>['error'] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

/**
 * Convert any thrown value into an HttpError.
 *
 * Handles Dockerode errors (`statusCode`, `reason`, `json`), Node fs/net errors
 * (`ENOENT`, `EACCES`, `EPERM`, `ECONNREFUSED`) and passes HttpErrors through.
 *
 * @param {unknown} err
 * @returns {HttpError}
 */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (!err || typeof err !== 'object') {
    return new HttpError(500, 'internal_error', String(err));
  }
  const e = err as Record<string, any>;
  const message = typeof e.message === 'string' ? e.message : String(err);

  // express/body-parser errors carry a `type` and a statusCode; classify them
  // before the generic statusCode mapping below would turn them into bad_request.
  if (e.type === 'entity.parse.failed') {
    return new HttpError(400, 'invalid_json', message);
  }
  if (e.type === 'entity.too.large') {
    return new HttpError(413, 'payload_too_large', message);
  }

  // Malformed percent-encoding in a URL path segment surfaces as a URIError.
  if (e instanceof URIError || e.name === 'URIError') {
    return new HttpError(400, 'bad_request', `Malformed URL encoding: ${message}`);
  }

  // Dockerode / docker-modem errors carry statusCode and often a JSON body. For streamed
  // endpoints (pull) docker-modem leaves `json` null and puts its own generic reason in
  // `reason`, so prefer the daemon text embedded in the message over that reason.
  if (typeof e.statusCode === 'number') {
    const dockerMessage = (e.json && e.json.message) || stripModemPrefix(message) || e.reason || message;
    switch (e.statusCode) {
      case 304:
        return new HttpError(200, 'not_modified', dockerMessage);
      case 400:
        return new HttpError(400, 'bad_request', dockerMessage);
      case 404:
        return new HttpError(404, 'not_found', dockerMessage);
      case 409:
        return new HttpError(409, 'conflict', dockerMessage);
      default:
        if (e.statusCode >= 500) return new HttpError(502, 'docker_error', dockerMessage);
        return new HttpError(e.statusCode, 'docker_error', dockerMessage);
    }
  }

  switch (e.code) {
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EHOSTUNREACH':
      return new HttpError(502, 'docker_unavailable', `Cannot reach the Docker daemon: ${message}`);
    case 'ENOENT':
      // A missing docker socket is a daemon problem; a missing path is a 404.
      if (/docker\.sock|\/run\/docker/.test(message) || /socket/i.test(String(e.syscall)) || e.syscall === 'connect') {
        return new HttpError(502, 'docker_unavailable', `Cannot reach the Docker daemon: ${message}`);
      }
      return new HttpError(404, 'not_found', message);
    case 'EACCES':
    case 'EPERM':
      return new HttpError(403, 'permission_denied', message);
    case 'EEXIST':
      return new HttpError(409, 'already_exists', message);
    case 'ENOTEMPTY':
      return new HttpError(409, 'not_empty', message);
    case 'EINVAL':
      return new HttpError(400, 'invalid_argument', message);
    default:
      break;
  }

  if (e.name === 'SyntaxError') {
    return new HttpError(400, 'invalid_json', message);
  }
  return new HttpError(500, 'internal_error', message);
}

/**
 * Remove the `(HTTP code NNN) <reason> - ` prefix docker-modem prepends to error messages.
 * Returns '' when the message has no such prefix (callers fall back to other fields).
 * @param {string} message
 * @returns {string}
 */
function stripModemPrefix(message: string): string {
  const m = /^\(HTTP code \d+\)\s*[^-]*-\s*/.exec(message);
  return m ? message.slice(m[0].length).trim() : '';
}

/**
 * Small helper for validation in route handlers.
 * @param {boolean} cond
 * @param {string} message
 * @param {any} [details]
 */
export function assertValid(cond: unknown, message: string, details?: unknown): asserts cond {
  if (!cond) throw new HttpError(400, 'validation_error', message, details);
}
