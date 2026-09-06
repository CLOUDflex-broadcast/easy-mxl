# HTTP API

Everything the web UI does goes through a JSON API under `/api` and three WebSocket endpoints
under `/ws`; scripts and other tools can use them the same way.

## Conventions

- All endpoints are under `/api`, speak JSON and return errors as
  `{ "error": { "code", "message", "details"? } }`.
- Container ids accept the full id, the short id or the name.
- Long operations (launch, pull) return `202 { "jobId" }`; follow the job via `/api/jobs/:id`
  or the `/ws/events` socket. A job is `{ id, kind, meta, status, progress, result, error }`
  with `status` `running`, `done` or `error` and `progress: { message, current, total }`.
- When a token is configured every `/api/*` request and `/ws/*` upgrade must carry
  `Authorization: Bearer <token>`, `X-Easy-MXL-Token: <token>` or `?token=<token>`; otherwise
  `401 unauthorized`. State-changing requests from a foreign browser origin get
  `403 origin_not_allowed`; while EASY MXL is bound to loopback, a foreign `Host` header gets
  `403 host_not_allowed` ([Configuration](configuration.md#security-model)).
- Request bodies are JSON (`Content-Type: application/json`, 1 MB limit). Boolean query flags
  such as `?force=1` accept `1` or `true`.
- Common error codes: `400 validation_error`, `404 not_found` / `domain_not_found` /
  `flow_not_found` / `app_not_found` / `job_not_found`, `409` for conflicts (see the table),
  `502 docker_unavailable` when the daemon cannot be reached.

## REST endpoints

| Method and path | Body / query | Response |
|---|---|---|
| `GET /api/health` | | `{ ok, version, docker, domainRoot, domainRootFs, procLocksReadable, taiOffsetNs, taiSource }` |
| `GET /api/apps` | | catalog apps with `imagePresent` and their `containers`; local-image apps add `imagePolicy`, `imageRepository`, `imageRepositories`, `localImages` |
| `GET /api/apps/:id` | | one app |
| `POST /api/apps/:id/launch` | `{ domain, name?, image?, hostPorts?, env?, params?, hostPaths?, launchRequires?, pull? }` | `202 { jobId }`; `409 name_conflict` when the container name exists; `404 image_not_loaded` for a local image that was not `docker load`ed; `400 image_repository_mismatch`, `unknown_dependency`, `invalid_pull_policy` |
| `GET /api/containers` | | container summaries (all states) |
| `GET /api/containers/:id` | | `{ summary, inspect }` |
| `POST /api/containers/:id/start` (also `stop`, `restart`, `kill`) | `{ timeout? }` | `{ ok, summary }` |
| `DELETE /api/containers/:id` | `?force=1&volumes=1` | `{ ok }` |
| `GET /api/containers/:id/logs` | `?tail=200&timestamps=0` | `{ lines: [{ stream, text }] }` (snapshot, max 5000 lines) |
| `GET /api/domains` | | domains without flows |
| `POST /api/domains` | `{ name, label?, description?, id?, historyDurationMs? }` | `201` domain; `409 domain_exists` |
| `GET /api/domains/:name` | | domain with `flows` |
| `POST /api/domains/:name/repair` | `{ label?, description?, id?, force? }` | regenerates `domain_def.json` (fresh id, label defaults to the directory name); `409 domain_def_exists` unless `force` |
| `PATCH /api/domains/:name` | `{ historyDurationMs }` (number, or `null` to reset to the 200 ms default) | domain |
| `DELETE /api/domains/:name` | `?force=1` | `{ ok }`; `409 domain_in_use` while running containers mount it, `409 domain_active` while flows are active, unless forced |
| `GET /api/domains/:name/flows` | | flows, each with `writerContainer: { id, name }` or `null` |
| `GET /api/domains/:name/flows/:flowId` | | one flow |
| `DELETE /api/domains/:name/flows/:flowId` | `?force=1` | `{ ok }`; `409 flow_active` when a writer holds the lock, unless forced |
| `GET /api/domains/:name/containers` | | containers that mount the domain |
| `GET /api/jobs`, `GET /api/jobs/:id` | | jobs (`running` / `done` / `error` with progress) |
| `GET /api/images` | | `[{ ref, present, id, size, created }]` for catalog images |
| `POST /api/images/pull` | `{ image }` | `202 { jobId }` |
| `GET /api/ports/check` | `?port=9600&protocol=tcp` | `{ port, protocol, container, listening }` |

Launch parameters in detail:

| Field | Meaning |
|---|---|
| `domain` | domain name under the domain root; required when the app has a `domainMount` |
| `name` | container name override (default: the catalog `containerName`) |
| `image` | image reference override; for `imagePolicy: local` apps the loaded tag to run, its repository must be one of the app's `imageRepositories` |
| `hostPorts` | `{ "9600/tcp": 9610 }` - host port per container port spec |
| `env` | `{ "KEY": "value" }`, merged over the catalog `env` after templating |
| `params` | `{ "groupHint": "cam-1" }`, template values merged over the catalog defaults |
| `hostPaths` | `{ "clips": "/srv/clips" }`, absolute host path per `hostPaths[].key` |
| `launchRequires` | `true` (default) starts or launches the apps listed in `requires` first |
| `pull` | `missing` (default) or `always`; `always` is rejected for local images |

Domain names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Flow objects carry `id`, `label`,
`group`, `role`, `format`, `mediaType`, `summary`, `status` (`active` / `inactive` / `stale`),
`active` (`true`, `false` or `null` when `/proc/locks` is unreadable), `headIndex` and
`lastWriteTime` in `header`, `lastWriteAgeMs`, `latencyGrains`, `sizeBytes`, `writerPid` and
`writerContainer`; the full shapes are in the
[design contract](DESIGN.md#7-http-api-srcserverts-srcroutes).

## Examples

```sh
export EASY_MXL_TOKEN=...            # from /etc/default/easy-mxl
H='Authorization: Bearer '"$EASY_MXL_TOKEN"
B=http://localhost:9700

# health: Docker reachable? /proc/locks readable? TAI offset source?
curl -s -H "$H" $B/api/health

# create a domain with a 400 ms ring buffer
curl -s -H "$H" -H 'Content-Type: application/json' \
  -d '{"name":"domain_1","label":"Studio 1","historyDurationMs":400}' $B/api/domains

# launch the Test Generator into it (returns a job id)
curl -s -H "$H" -H 'Content-Type: application/json' \
  -d '{"domain":"domain_1"}' $B/api/apps/test-generator/launch
# -> {"jobId":"..."}

# follow the job until status is "done" or "error"
curl -s -H "$H" $B/api/jobs/<jobId>

# list the flows with their writer containers
curl -s -H "$H" $B/api/domains/domain_1/flows

# is host port 9600 free?
curl -s -H "$H" "$B/api/ports/check?port=9600&protocol=tcp"

# recreate a missing domain_def.json for a directory created by hand
curl -s -H "$H" -X POST -H 'Content-Type: application/json' -d '{}' $B/api/domains/domain_1/repair

# remove a stale flow left by a crashed writer (force skips the "not active" check)
curl -s -H "$H" -X DELETE "$B/api/domains/domain_1/flows/<flowId>?force=1"

# stop a container, then remove it together with its anonymous volumes
curl -s -H "$H" -X POST -H 'Content-Type: application/json' -d '{"timeout":5}' $B/api/containers/test-generator/stop
curl -s -H "$H" -X DELETE "$B/api/containers/test-generator?volumes=1"
```

## WebSocket endpoints

Same authentication as the API (`?token=` is the practical choice for browsers). Unknown paths
are rejected before the upgrade completes; the server pings every socket every 30 s and drops
dead ones.

| Path | Server -> client | Client -> server |
|---|---|---|
| `/ws/events` | `{type:'hello', version}`, `{type:'container', action, id, name, image, time}`, `{type:'image', action, id, time}`, `{type:'job', job}` | - |
| `/ws/containers/:id/logs?tail=&timestamps=` | `{type:'log', stream, text}`, `{type:'end'}`, `{type:'error', message}` | `{type:'stop'}` |
| `/ws/containers/:id/terminal?cols=&rows=&cmd=` | binary frames = terminal output; `{type:'ready'}`, `{type:'exit', code}`, `{type:'error', message}` | binary frames = keyboard input; `{type:'resize', cols, rows}` |

`/ws/events` carries Docker container and image events plus every job update, which is how the
UI refreshes without polling. The terminal endpoint runs `docker exec` with a TTY; `cmd`, when
present, is split on whitespace and replaces the default shell (`bash` when available, else
`sh`). A terminal on a container that is not running fails with `409 not_running`.

```sh
# watch events with websocat (any WebSocket client works)
websocat "ws://localhost:9700/ws/events?token=$EASY_MXL_TOKEN"
```
