# EASY MXL — Design

EASY MXL is a small Node.js web tool that runs on an Ubuntu 24.04 Docker host. It launches
Docker containers that carry DMF‑MXL media functions (the CBC/Radio‑Canada `ghcr.io/cbcrc/*`
GStreamer apps from [mxl-hands-on](https://github.com/cbcrc/mxl-hands-on)), opens their web
interfaces, manages MXL domains in shared memory, lists the flows inside a domain, and gives
container logs and a terminal in the browser.

This document is the build contract. Every module below has a fixed file path and a fixed
public API. Modules are developed against this document, not against each other.

---

## 1. MXL background (facts the implementation relies on)

Source of truth: `dmf-mxl/mxl` (`docs/Architecture.md`, `lib/include/mxl/flowinfo.h`,
`lib/src/flow.cpp`, `tools/mxl-info/main.cpp`) and `cbcrc/mxl-hands-on` compose files.

* An **MXL domain** is a directory on a **tmpfs** filesystem. Flows are memory‑mapped files
  inside it. Multiple domains may coexist. The hands‑on uses `/Volumes/mxl/domain_1`
  (tmpfs mounted via fstab); the MXL examples use `/dev/shm/mxl`. On Ubuntu 24 `/dev/shm` is
  already a tmpfs (½ RAM, world‑writable), so **the default domain root is `/dev/shm/mxl`**
  and a domain is `/dev/shm/mxl/<name>`.
* `<domain>/domain_def.json` — `{"id": "<uuid>", "label": "...", "description": "..."}`.
  The GStreamer apps discover domains by recursively looking for this file under the
  directory mounted at `/mxl-domain` (env `MXL_DOMAIN`). A domain **must** have this file.
* `<domain>/options.json` (optional) — `{"urn:x-mxl:option:history_duration/v1.0": <ns>}`,
  ring‑buffer depth in nanoseconds, default 200 000 000 ns (200 ms) when absent.
* `<domain>/<flowId>.mxl-flow/` — one directory per flow; `<flowId>` is a UUID.
  * `flow_def.json` — NMOS IS‑04 Flow resource: `id`, `label`, `description`, `format`
    (`urn:x-nmos:format:video|audio|data`), `media_type` (`video/v210`, `video/v210a`,
    `audio/float32`, `video/smpte291`), `grain_rate {numerator, denominator}` (video/data),
    `sample_rate {numerator[, denominator]}` + `channel_count` (audio), `frame_width`,
    `frame_height`, `interlace_mode`, `colorspace`, `components[]`,
    `tags["urn:x-nmos:tag:grouphint/v1.0"][0] = "<Group>:<Role>"`.
  * `data` — `mxlFlowInfo` header (2048 bytes, little‑endian, layout in §4.1) followed by a
    small sync‑state block; the file observed from a real writer is 2064 bytes. Parse the first
    2048 bytes only and accept any file ≥ 224 bytes.
  * `grains/` — discrete flows (video/data): one file per ring‑buffer slot, named `data.<n>`
    (observed: `data.0`…`data.4` for 200 ms at 29.97 fps).
  * `channels` — continuous flows (audio): one blob, `channelCount*bufferLength*4` bytes.
  * `access` — touched by readers.
* **Active flow** = a writer process holds a *shared* `flock()` on `<flow>/data` (it also locks
  `channels` and every grain file, but `data` is the one `mxlIsFlowActive` tests)
  (`mxlIsFlowActive` tries `LOCK_EX|LOCK_NB` and reports active when that fails).
  On Linux every flock is listed in `/proc/locks` as
  `N: FLOCK  ADVISORY  READ|WRITE <pid> <maj>:<min>:<inode> 0 EOF` (major/minor in hex).
  EASY MXL runs on the host, so it can match `<maj>:<min>:<inode>` against `fs.stat()` of the
  `data` file and, via `/proc/<pid>/cgroup`, map the writer PID to a Docker container ID.
* **Time** is TAI nanoseconds since the SMPTE ST 2059 epoch (`CLOCK_TAI`). The SDK rounds
  half‑up when converting (`IndexConversion.hpp`): `grainIndex = floor((ts * num + 5e8 * den) /
  (den * 1e9))` and `timestamp(index) = floor((index * den * 1e9 + num / 2) / num)`; EASY MXL
  mirrors that exactly so its latency matches `mxl-info`. Node has no CLOCK_TAI; see §4.2.
* Containers get a domain through a **bind mount** of the host domain directory. The
  hands‑on gst‑apps mount it at `/mxl-domain` and set `MXL_DOMAIN=/mxl-domain`; the simple
  writer/reader images (`ghcr.io/cbcrc/mxl-writer`, `mxl-reader`, `mxl-clip-player`) expect it
  at `/domain` and run as user `1000:1000`.
* Reference stack (exercise‑4): test-generator :9600, mxl2webrtc :9601 (+ `bluenviron/mediamtx`
  with `network_mode: host`), file-player :9602, hls2mxl :9603, input-selector :9604,
  html5-keyer :9605 (`shm_size: 1gb`), webrtc2mxl :9606, mxl-info-gui :9699. All FastAPI apps
  listen on container port 9600 and serve Swagger at `/docs`.

---

## 2. Repository layout

```
package.json                 ESM, Node >= 20.10, deps: dockerode, express, ws, @xterm/xterm, @xterm/addon-fit
bin/easy-mxl.ts              CLI entry (parses flags, calls createServer, prints URL)
src/config.ts                loadConfig(argv, env) -> Config
src/log.ts                   tiny leveled logger: log.info/warn/error/debug(msg, meta?)
src/errors.ts                HttpError class + helpers
src/mxl/flowinfo.ts          binary header parser + index/time helpers (pure)
src/mxl/locks.ts             /proc/locks + /proc/<pid>/cgroup parsing (pure + fs)
src/mxl/flows.ts             scanFlows(domainPath, opts) -> Flow[]
src/mxl/domain.ts            domain CRUD on the tmpfs root
src/mxl/time.ts              TAI offset estimation
src/docker/client.ts         createDocker(config), pingDocker(docker)
src/docker/containers.ts     list/inspect/start/stop/restart/kill/remove + summarize()
src/docker/images.ts         imagePresent(), pullImage() with progress
src/docker/launch.ts         buildCreateOptions() (pure) + launchApp()
src/docker/logs.ts           streamLogs()
src/docker/terminal.ts       openTerminal()
src/docker/events.ts         watchEvents()
src/jobs.ts                  in-memory job registry (EventEmitter)
src/catalog.ts               loadCatalog(paths) -> App[], validateApp(), resolveApp()
src/server.ts                createServer(config, deps) -> { app, httpServer, start, stop }
src/routes/*.js              express routers (health, apps, containers, domains, flows, jobs, images, ports)
src/ws.ts                    WebSocket upgrade handling for /ws/*
catalog/default.json         built-in DMF-MXL app catalog
public/                      frontend TypeScript modules and static assets
  index.html  styles.css  app.js  api.js  format.js  logs.js  terminal.js  launch.js  domains.js
deploy/easy-mxl.service      systemd unit
deploy/Dockerfile            optional containerised EASY MXL
scripts/install-ubuntu24.sh  host install helper
scripts/copy-static.ts       copies non-TypeScript assets into dist/
test/*.test.ts               node:test suites compiled into dist/test/
docs/DESIGN.md               this file
README.md
```

Conventions: TypeScript ES modules with `import`/`export`, compiled by `tsc`, with no frontend bundler. Use only
Node built‑ins plus the five dependencies above. All async APIs return Promises. All paths are
absolute. Every exported function is documented with a JSDoc block. IDs from Docker are used
verbatim (full 64‑hex) internally; `shortId` (12 chars) is only for display.

---

## 3. Configuration — `src/config.ts`

```js
export function loadConfig(argv = process.argv.slice(2), env = process.env) -> Config
export function printHelp() -> string
```

`Config`:

| field | default | flag | env |
|---|---|---|---|
| `host` | `127.0.0.1` | `--host` | `EASY_MXL_HOST` |
| `port` | `9700` | `--port` | `EASY_MXL_PORT` |
| `domainRoot` | `/dev/shm/mxl` | `--domain-root` | `EASY_MXL_DOMAIN_ROOT` |
| `dockerHost` | `null` (→ dockerode default `/var/run/docker.sock`) | `--docker` | `DOCKER_HOST` |
| `token` | `null` | `--token` | `EASY_MXL_TOKEN` |
| `catalogPaths` | `[<repo>/catalog/default.json]` + extras | `--catalog <file>` (repeatable) | `EASY_MXL_CATALOG` (`:`‑separated) |
| `domainUid` | `1000` | `--domain-uid` | `EASY_MXL_DOMAIN_UID` |
| `domainGid` | `1000` | `--domain-gid` | `EASY_MXL_DOMAIN_GID` |
| `domainMode` | `0o775` | `--domain-mode` (octal string) | `EASY_MXL_DOMAIN_MODE` |
| `logLevel` | `info` | `--log-level` | `EASY_MXL_LOG_LEVEL` |
| `allowedOrigins` | `[]` | `--allowed-origins <origin>` (repeatable) | `EASY_MXL_ALLOWED_ORIGINS` (`,`‑separated) |
| `publicDir` | `<repo>/public` | — | — |
| `version` | from package.json | — | — |

`--help`/`-h` sets `config.help = true`; `--version` sets `config.showVersion = true`.
Unknown flags throw `Error("Unknown option: …")`. Numeric flags are validated.

Security rule: when `host` is not loopback and `token` is null, `bin/easy-mxl.ts` prints a
prominent warning (the API gives full control of Docker) but still starts.

---

## 4. MXL modules

### 4.1 `src/mxl/flowinfo.ts` (pure)

```js
export const FLOW_INFO_SIZE = 2048;
export const FORMAT = { 0: 'unspecified', 1: 'video', 2: 'audio', 3: 'data' };
export function parseFlowInfo(buf: Buffer) -> FlowHeader   // throws RangeError if buf.length < 224
export function timestampToIndex(rate: {numerator, denominator}, tsNs: bigint) -> bigint   // round half-up like the SDK
export function indexToTimestamp(rate, index: bigint) -> bigint                             // round half-up like the SDK
export function grainDurationNs(rate) -> number
export function uuidFromBytes(buf: Buffer, offset = 0) -> string   // 8-4-4-4-12 lowercase
```

Byte layout (little‑endian), offsets in decimal:

| offset | type | field |
|---|---|---|
| 0 | u32 | `version` (expected 1) |
| 4 | u32 | `size` (expected 2048) |
| 8 | 16 B | `id` (flow UUID bytes, RFC 4122 order) |
| 24 | u32 | `format` (0..3, see FORMAT) |
| 28 | u32 | `flags` |
| 32 | i64 | `grainRate.numerator` |
| 40 | i64 | `grainRate.denominator` |
| 48 | u32 | `maxCommitBatchSizeHint` |
| 52 | u32 | `maxSyncBatchSizeHint` |
| 56 | u32 | `payloadLocation` (0 host, 1 device) |
| 60 | i32 | `deviceIndex` |
| 136 | u32×4 | discrete: `sliceSizes[4]` |
| 152 | u32 | discrete: `grainCount` |
| 136 | u32 | continuous: `channelCount` |
| 140 | u32 | continuous: `bufferLength` |
| 200 | u64 | `headIndex` |
| 208 | u64 | `lastWriteTime` (ns TAI) |
| 216 | u64 | `lastReadTime` (ns TAI) |

`FlowHeader` (all 64‑bit values as **strings** of decimal digits so they survive JSON, plus a
`BigInt` copy under a non‑enumerable `_big` property is NOT required — keep it simple: return
strings and let callers `BigInt()` them):

```js
{
  version, size, id, format /* 'video'|'audio'|'data'|'unspecified' */, formatCode, flags,
  grainRate: { numerator, denominator },        // numbers
  maxCommitBatchSizeHint, maxSyncBatchSizeHint, payloadLocation /* 'host'|'device' */, deviceIndex,
  discrete: { sliceSizes: [n,n,n,n], grainCount } | null,   // when format is video|data
  continuous: { channelCount, bufferLength } | null,        // when format is audio
  headIndex: string, lastWriteTime: string, lastReadTime: string
}
```

### 4.2 `src/mxl/time.ts`

```js
export async function getTaiOffsetNs(opts = {}) -> number   // cached; refreshes at most every 10 min
export function nowTaiNs(offsetNs) -> bigint                // BigInt(Date.now())*1_000_000n + BigInt(offsetNs)
export function estimateOffsetFromWrite(lastWriteTimeNs: bigint, nowUnixNs: bigint) -> number|null
```

Strategy for `getTaiOffsetNs`: (1) if `python3` exists, run
`python3 -c 'import time;print(time.clock_gettime_ns(time.CLOCK_TAI)-time.time_ns())'`
with a 2 s timeout and use the result; (2) otherwise return `0` and set
`getTaiOffsetNs.source = 'assumed-zero'`. `estimateOffsetFromWrite` returns `37e9` when
`|diff − 37e9| < 5e9`, `0` when `|diff| < 5e9`, else `null` — used by `flows.js` as a
sanity fallback when the python probe is unavailable and a flow is actively written.

### 4.3 `src/mxl/locks.ts`

```js
export function parseProcLocks(text: string) -> LockEntry[]
// LockEntry: { type:'FLOCK'|'POSIX'|'OFDLCK'|..., mandatory:boolean, mode:'READ'|'WRITE', pid:number, major:number, minor:number, ino:number, start:string, end:string }
export async function readProcLocks(procPath = '/proc/locks') -> LockEntry[]     // [] if unreadable
export function devMajorMinor(stDev: number|bigint) -> { major, minor }           // Linux encoding: major=(dev>>8)&0xfff, minor=(dev&0xff)|((dev>>12)&0xfff00)
export function findLocksForFile(locks, stat: fs.Stats) -> LockEntry[]            // match major/minor/ino
export function parseCgroupContainerId(text: string) -> string|null              // /docker[-/]([0-9a-f]{64})/ or /([0-9a-f]{64})\.scope/
export async function containerIdForPid(pid, procRoot = '/proc') -> string|null
```

`findLocksForFile` must match **only FLOCK entries**. Tests feed sample `/proc/locks` text.

### 4.4 `src/mxl/flows.ts`

```js
export const FLOW_DIR_SUFFIX = '.mxl-flow';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseGroupHint(flowDef) -> { groupHint: string, group: string, role: string }  // "" when absent; split at FIRST ':'
export function summarizeFlowDef(flowDef) -> string   // "1920x1080p 30000/1001 video/v210" | "2 ch @ 48000 Hz audio/float32" | "video/smpte291 30000/1001" | ""
export async function readFlow(domainPath, flowId, ctx) -> Flow
export async function scanFlows(domainPath, opts = {}) -> Flow[]
// opts: { locks?: LockEntry[] (pre-read), taiOffsetNs?: number, resolveContainers?: boolean (default true), procRoot?: string }
```

`Flow`:

```js
{
  id, dir,                                  // uuid (lowercase), absolute dir path
  label, description, groupHint, group, role,
  format: 'video'|'audio'|'data'|'unknown', // from flow_def.format urn, fallback header.format
  mediaType, summary, def,                  // def = parsed flow_def.json or null
  defError: string|null,                    // JSON/read error message
  header: FlowHeader|null, headerError: string|null,
  active: boolean|null,                     // null when /proc/locks unreadable
  writerPid: number|null, writerContainerId: string|null,
  status: 'active'|'inactive'|'stale',      // active: locked; inactive: header ok, no lock; stale: no/invalid data file or invalid flow_def.json
  grainFiles: number|null,                  // entries in grains/ (discrete) or null
  sizeBytes: number,                        // sum of regular file sizes in the flow dir (1 level + grains/)
  lastWriteAgeMs: number|null,              // (nowTai - lastWriteTime)/1e6, may be negative, null if unknown
  latencyGrains: number|null,               // timestampToIndex(rate, nowTai) - headIndex (as Number), null if unknown
  headTimeIso: string|null,                 // indexToTimestamp(headIndex) rendered as UTC ISO (TAI offset removed) — best effort
  mtime: string                             // ISO mtime of flow dir
}
```

Rules: only directories whose name is `<uuid>.mxl-flow` are flows. Never throw for a broken
flow — record errors in the fields. Sorting: by `group`, then `role`, then `label`.
`scanFlows` reads `/proc/locks` once per scan.

### 4.5 `src/mxl/domain.ts`

```js
export const DOMAIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const HISTORY_KEY = 'urn:x-mxl:option:history_duration/v1.0';
export const TMPFS_MAGIC = 0x01021994;
export function validateDomainName(name) -> void                  // throws HttpError(400)
export function domainPath(root, name) -> string
export async function fsInfo(path) -> { fsType: 'tmpfs'|'other'|'unknown', tmpfs: boolean, totalBytes, freeBytes, availBytes }  // fs.statfs; on error → unknown
export async function ensureRoot(root, owner) -> void            // mkdir -p, chown/chmod best effort (ignore EPERM)
export async function listDomains(root, opts) -> Domain[]          // opts: { withFlows?: boolean }
export async function getDomain(root, name, opts) -> Domain        // throws HttpError(404)
export async function createDomain(root, input, owner) -> Domain
//   input: { name, label?, description?, id? (uuid, default randomUUID), historyDurationMs? (number > 0) }
//   owner: { uid, gid, mode }  → chown/chmod best effort (only when process is root for chown)
//   throws HttpError(409) if directory exists
export async function updateDomainOptions(root, name, { historyDurationMs|null }) -> Domain   // null removes options.json key
export async function deleteDomain(root, name, { force = false }) -> void   // throws HttpError(409) when active flows exist and !force; rm -rf
export async function deleteFlow(root, name, flowId, { force = false }) -> void  // throws 409 if active && !force; 404 if missing
```

`Domain`:

```js
{
  name, path, exists: true,
  def: { id, label, description } | null, defError: string|null,
  historyDurationNs: number|null, historyDurationMs: number|null, optionsRaw: object|null,
  flowCount, activeFlowCount,                 // from a scan (cheap: count dirs; active via locks) — computed in listDomains too
  flows: Flow[] | undefined,                  // only when withFlows
  fs: fsInfo result,
  owner: { uid, gid, mode: '0775' },
  mtime: string
}
```

Subdirectories of the root that lack `domain_def.json` are still listed (with `def: null`) so
users can see stray directories; they are flagged in the UI.

---

## 5. Docker modules

All functions take the `docker` (Dockerode instance) as first argument — no module‑level
singleton — so tests can pass fakes.

### 5.1 `src/docker/client.ts`

```js
export function createDocker(config) -> Dockerode      // honours config.dockerHost (unix://, tcp://, npipe://) else default socket
export async function pingDocker(docker) -> { ok: true, version, apiVersion, os, arch, kernel, containers, images } | { ok: false, error }
```

### 5.2 `src/docker/containers.ts`

```js
export const LABELS = { managed: 'easy-mxl.managed', app: 'easy-mxl.app', domain: 'easy-mxl.domain', domainPath: 'easy-mxl.domainPath', webui: 'easy-mxl.webui', docs: 'easy-mxl.docs' };
export function summarize(entry, ctx) -> ContainerSummary   // entry = /containers/json item OR inspect object; ctx = { domainRoot, catalogById }
export async function listContainers(docker, ctx) -> ContainerSummary[]      // all=true
export async function inspectContainer(docker, id, ctx) -> { summary: ContainerSummary, inspect: object }
export async function startContainer(docker, id), stopContainer(docker, id, { timeout = 10 }), restartContainer(docker, id, { timeout = 10 }), killContainer(docker, id), removeContainer(docker, id, { force = false, volumes = false })
export function parsePorts(portsFromListOrInspect) -> Port[]                 // Port: { ip, hostPort: number|null, containerPort: number, protocol }
```

`ContainerSummary`:

```js
{
  id, shortId, name /* without leading slash */, image, imageId,
  state /* 'running'|'exited'|'created'|'paused'|'restarting'|'removing'|'dead' */, status /* human string from Docker */,
  created: string(ISO), startedAt: string|null, finishedAt: string|null, exitCode: number|null,
  ports: Port[], labels: object,
  managed: boolean, app: string|null,      // catalog id from label
  webUI: { containerPort, hostPort, path, docsPath, inferred: boolean } | null,   // label > catalog > first published tcp port (inferred)
  domain: string|null, domainPath: string|null,   // from labels, else from a mount whose Source is under ctx.domainRoot
  domainMounts: [{ source, destination, readOnly }],
  mounts: [{ type, source, destination, readOnly }],
  networkMode, restartPolicy: string|null, cmd: string[]|null, tty: boolean
}
```

Docker errors are converted: 404 → `HttpError(404)`, 409 → `HttpError(409)`, 304 (already
started/stopped) → success, connection refused → `HttpError(502, 'docker_unavailable')`.

### 5.3 `src/docker/images.ts`

```js
export async function imagePresent(docker, ref) -> boolean
export async function pullImage(docker, ref, onProgress?) -> void
//   onProgress({ status, id, current, total, message })  — uses docker.modem.followProgress
export function normalizeImageRef(ref) -> string   // adds ':latest' when no tag/digest
```

### 5.4 `src/docker/launch.ts`

```js
export function buildCreateOptions(app: App, params: LaunchParams, ctx: { domain: Domain|null, config: Config }) -> { name: string, createOptions: object }
export async function launchApp(docker, app, params, ctx, hooks = {}) -> { id, name, started: true, dependencies: [{ app, id, name, action:'started'|'created'|'already-running' }] }
//   hooks: { onProgress(stage: 'pull'|'dependency'|'create'|'start', detail) , catalogById, listDomains }
export async function checkNameConflict(docker, name) -> { id, name, state } | null
export async function findHostPortUsage(docker, hostPort, protocol='tcp') -> { id, name, state } | null   // scans ALL containers' HostConfig.PortBindings
```

`LaunchParams`:

```js
{
  domain: string|null,                 // domain name under root (required when app.domainMount)
  name?: string,                       // container name override
  hostPorts?: { [containerPortSpec: string]: number },   // key like "9600/tcp"
  env?: { [k]: string },               // merged over app.env (after templating)
  params?: { [key]: string },          // template values, merged over app.params[].default
  hostPaths?: { [key]: string },       // host directory per app.hostPaths[].key
  launchRequires?: boolean,            // default true
  pull?: 'missing'|'always'            // default 'missing'
}
```

`buildCreateOptions` (pure, thoroughly unit‑tested) produces:

* `Image`, `name`, `Hostname` (= container name), `Env` (`KEY=VALUE` strings; includes
  `<domainMount.envVar>=<containerPath>` when set), `Cmd`/`Entrypoint` (after `{{param}}`
  templating; unknown placeholders throw 400), `User`, `Tty`, `OpenStdin`, `ExposedPorts`,
  `Labels` (all `LABELS.*`, `easy-mxl.webui="9600:/"`, `easy-mxl.docs="/docs"`, plus
  `easy-mxl.version`), `HostConfig`: `PortBindings` (`{"9600/tcp":[{HostPort:"9600"}]}`; omitted
  when `networkMode==='host'`), `Binds` (`<hostDomainPath>:<containerPath>[:ro]`, and
  `<hostPath>:<containerPath>[:ro]` for hostPaths), `NetworkMode`, `ExtraHosts`, `ShmSize`
  (bytes; parse `1g`/`512m`/number), `RestartPolicy {Name}`, `Init` when `app.init`.
* Validation → `HttpError(400)`: missing required hostPath, non‑absolute hostPath, hostPort
  out of range, domain required but missing, invalid container name (`/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/`).

`launchApp` order: resolve domain → for each `app.requires` (if `launchRequires`): if a
container labeled with that app is running → skip; if exists stopped → start; else launch it
(recursively, same domain, defaults) → pull image if missing (or always) reporting progress →
`checkNameConflict` → `HttpError(409, 'name_conflict', { id, name, state })` → create → start.

### 5.5 `src/docker/logs.ts`

```js
export async function streamLogs(docker, id, { tail = 200, since = 0, timestamps = false, follow = true }, sink) -> { stop() }
//   sink: { onChunk(stream: 'stdout'|'stderr', text: string), onEnd(), onError(err) }
```

Inspect the container first: if `Config.Tty` the stream is raw (all → `stdout`), else use
`docker.modem.demuxStream`. Decode UTF‑8 with a streaming `TextDecoder` per stream. `stop()`
destroys the underlying stream.

### 5.6 `src/docker/terminal.ts`

```js
export async function openTerminal(docker, id, { cmd, cols = 80, rows = 24, user, env }) -> Terminal
// Terminal: { stream (duplex), resize(cols, rows): Promise, write(data), close(), exec, onExit(cb) }
export const DEFAULT_SHELL_CMD = ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'];
```

Uses `container.exec({ Cmd, AttachStdin, AttachStdout, AttachStderr, Tty: true, Env:
['TERM=xterm-256color', ...env] })` then `exec.start({ hijack: true, stdin: true, Tty: true })`.
`onExit` polls `exec.inspect()` after the stream ends to get `ExitCode`. Container not running →
`HttpError(409, 'not_running')`.

### 5.7 `src/docker/events.ts`

```js
export async function watchEvents(docker, onEvent, { types = ['container', 'image'] } = {}) -> { stop() }
// onEvent({ type, action, id, name, image, time, attributes })
```

Reconnects with backoff (1 s → 30 s) when the daemon drops; never throws after start.

### 5.8 `src/jobs.ts`

```js
export function createJobRegistry({ maxJobs = 200 } = {}) -> JobRegistry
// JobRegistry extends EventEmitter: emits 'update' (job)
// .create(kind, meta) -> Job ; .update(id, patch) -> Job ; .get(id) -> Job|undefined ; .list() -> Job[] ; .run(kind, meta, async (job) => result) -> Job (sets done/error)
// Job: { id (uuid), kind, meta, status: 'running'|'done'|'error', progress: { message, current, total }|null, result, error: { message, code, details }|null, createdAt, updatedAt }
```

---

## 6. Catalog — `src/catalog.ts` and `catalog/default.json`

```js
export async function loadCatalog(paths: string[]) -> App[]    // later files override earlier by id; `"disabled": true` hides an app
export function validateApp(app) -> void                        // throws Error with a clear message
export function indexById(apps) -> Map<string, App>
export function renderTemplate(str, vars) -> string             // {{key}} → vars[key]; missing → throw
```

`App` schema (JSON):

```jsonc
{
  "id": "test-generator",                    // ^[a-z0-9][a-z0-9-]*$
  "name": "Test Generator",
  "description": "…",
  "category": "source" | "processing" | "output" | "monitoring" | "infrastructure" | "tools",
  "image": "ghcr.io/cbcrc/test-generator:latest",
  "containerName": "test-generator",         // default name
  "webUI": { "containerPort": 9600, "path": "/", "docsPath": "/docs" },   // optional
  "ports": [ { "containerPort": 9600, "hostPort": 9600, "protocol": "tcp" }, { "containerPort": 8200, "hostPort": 8200, "protocol": "udp", "rangeEnd": 8210 } ],
  "domainMount": { "containerPath": "/mxl-domain", "readOnly": false, "envVar": "MXL_DOMAIN" },  // optional; envVar optional
  "env": { "KEY": "value with {{param}}" },
  "extraHosts": ["host.docker.internal:host-gateway"],
  "networkMode": "host",                     // optional
  "shmSize": "1g",                           // optional
  "user": "1000:1000",                       // optional
  "cmd": ["…", "{{overlayText}}"],           // optional
  "entrypoint": ["…"],                       // optional
  "tty": false, "stdinOpen": false, "init": false,
  "restartPolicy": "unless-stopped" | "no" | "always" | "on-failure",
  "hostPaths": [ { "key": "clips", "label": "Clips folder (.mp4/.ts)", "containerPath": "/home/file", "readOnly": true, "required": true, "default": "" } ],
  "params": [ { "key": "overlayText", "label": "Overlay text", "default": "EBU DMF MXL", "help": "…" } ],
  "requires": ["mediamtx"],
  "notes": "free text shown in the launch dialog",
  "source": "https://github.com/cbcrc/mxl-hands-on/blob/main/docker/exercise-4/docker-compose.yml",
  "disabled": false
}
```

`ports[].rangeEnd` expands to one binding per port with the same host/container offset.

Built‑in catalog entries (all from exercise‑4 / exercise‑1..3 compose files, `platform`
omitted — Docker picks the host platform):

| id | image | host→container | category | notes |
|---|---|---|---|---|
| `test-generator` | ghcr.io/cbcrc/test-generator:latest | 9600→9600 | source | domainMount `/mxl-domain` (no envVar needed but set `MXL_DOMAIN` anyway) |
| `mxl-info-gui` | ghcr.io/cbcrc/mxl-info-gui:latest | 9699→9600 | monitoring | |
| `mediamtx` | bluenviron/mediamtx:latest | network host | infrastructure | no web UI; no domain mount |
| `mxl2webrtc` | ghcr.io/cbcrc/mxl2webrtc:latest | 9601→9600, 8200‑8210/udp | output | requires mediamtx; env `MEDIAMTX_WHIP_URL=http://host.docker.internal:8889/mxl2webrtc/whip`, `MEDIAMTX_WEBRTC_URL=http://localhost:8889`; extraHosts |
| `file-player` | ghcr.io/cbcrc/file-player:latest | 9602→9600 | source | hostPath `clips` → `/home/file:ro` (required) |
| `hls2mxl` | ghcr.io/cbcrc/hls2mxl:latest | 9603→9600 | source | |
| `input-selector` | ghcr.io/cbcrc/input-selector:latest | 9604→9600 | processing | env `MAX_INPUTS={{maxInputs}}` param default `3` |
| `html5-keyer` | ghcr.io/cbcrc/html5-keyer:latest | 9605→9600 | processing | shmSize 1g; extraHosts; env `KEYER_DEFAULT_MODE={{defaultMode}}` default `key` |
| `webrtc2mxl` | ghcr.io/cbcrc/webrtc2mxl:latest | 9606→9600 | source | requires mediamtx; env `MEDIAMTX_WHEP_URL=http://host.docker.internal:8889/webrtc2mxl/whep`, `MEDIAMTX_WHIP_URL=http://localhost:8889/webrtc2mxl/whip`; extraHosts |
| `mxl-writer` | ghcr.io/cbcrc/mxl-writer:latest | — | tools | user 1000:1000; domainMount `/domain`; cmd `["/app/mxl-gst-testsrc","-d","/domain","-g","{{groupHint}}","-v","/app/v210_flow.json","-a","/app/audio_flow.json","-t","{{overlayText}}"]`; params groupHint=`demo-app-writer`, overlayText=`EBU DMF MXL`; restart unless-stopped |
| `mxl-reader` | ghcr.io/cbcrc/mxl-reader:latest | — | tools | user 1000:1000; domainMount `/domain` read‑only; tty+stdinOpen; default CMD (`watch mxl-info -d /domain -l`); notes: open a terminal and run `/app/mxl-info -d /domain -l` |
| `mxl-clip-player` | ghcr.io/cbcrc/mxl-clip-player:latest | — | tools | domainMount `/domain`; hostPath `clip` (file) → `/app/clip.ts:ro` required; cmd `["-d","/domain","-i","/app/clip.ts"]`; runs as root (entrypoint installs libav) |

---

## 7. HTTP API — `src/server.ts`, `src/routes/*`

`createServer(config, deps)` where `deps = { docker, catalog: App[], jobs: JobRegistry, log }`
returns `{ app, httpServer, wss, start(): Promise<{port, host}>, stop(): Promise }`.

Middleware: JSON body (1 MB), request log at debug, auth (see below), static `public/` and
`/vendor/xterm.js|xterm.css|addon-fit.js` from `node_modules`, `/api/*` routers, JSON error
handler: `{ "error": { "code": string, "message": string, "details"?: any } }`.

Browser‑origin guard (independent of the token): state‑changing `/api` requests (anything but
GET/HEAD/OPTIONS) and every `/ws/*` upgrade are rejected with 403 `origin_not_allowed` when the
request carries an `Origin` whose host differs from the request `Host` and is not listed in
`config.allowedOrigins`; requests without `Origin` are rejected only when fetch metadata says
`Sec-Fetch-Site: cross-site`. While bound to loopback, a `Host` header that is not
localhost/127.x/::1 (and not allow‑listed) is rejected with 403 `host_not_allowed` (DNS
rebinding). Tokens are never written to logs (`?token=` is redacted).

Auth: if `config.token`, every `/api/*` request and every `/ws/*` upgrade must carry
`Authorization: Bearer <token>` **or** `X-Easy-MXL-Token: <token>` **or** `?token=<token>`.
Otherwise 401 `{error:{code:'unauthorized'}}`. Static files are always served.

`src/errors.ts`: `export class HttpError extends Error { constructor(status, code, message, details) }`
and `export function toHttpError(err) -> HttpError` (maps Dockerode `statusCode`, ENOENT → 404,
EACCES/EPERM → 403, ECONNREFUSED/ENOENT on socket → 502 `docker_unavailable`).

| method & path | body / query | response |
|---|---|---|
| `GET /api/health` | | `{ ok, version, docker: pingDocker(), domainRoot, domainRootFs: fsInfo, procLocksReadable: boolean, taiOffsetNs, taiSource }` |
| `GET /api/apps` | | `App[]` with added `imagePresent: boolean` (best effort) and `containers: [{id,name,state}]` currently labeled with this app |
| `GET /api/apps/:id` | | `App` |
| `POST /api/apps/:id/launch` | `LaunchParams` | `202 { jobId }` — job result is `launchApp` result; name conflicts surface as job error `{code:'name_conflict', details}` **after** a synchronous pre-check returns `409` directly when the conflict is already knowable |
| `GET /api/containers` | | `ContainerSummary[]` |
| `GET /api/containers/:id` | | `{ summary, inspect }` |
| `POST /api/containers/:id/start` / `stop` / `restart` / `kill` | `{ timeout? }` | `{ ok: true, summary }` |
| `DELETE /api/containers/:id` | `?force=1&volumes=1` | `{ ok: true }` |
| `GET /api/containers/:id/logs` | `?tail=200&timestamps=0` | `{ lines: [{ stream, text }] }` (non‑follow snapshot, max 5000 lines) |
| `GET /api/domains` | | `Domain[]` (without flows) |
| `POST /api/domains` | `{ name, label?, description?, id?, historyDurationMs? }` | `201 Domain` |
| `GET /api/domains/:name` | | `Domain` with `flows` |
| `POST /api/domains/:name/repair` | `{ label?, description?, id?, force? }` | `Domain`; regenerates `domain_def.json` (409 `domain_def_exists` when a valid one exists and `force` is not set) |
| `PATCH /api/domains/:name` | `{ historyDurationMs: number|null }` | `Domain` |
| `DELETE /api/domains/:name` | `?force=1` | `{ ok: true }` (409 when attached running containers unless force; 409 when active flows unless force) |
| `GET /api/domains/:name/flows` | | `Flow[]` with `writerContainer: { id, name } | null` resolved |
| `GET /api/domains/:name/flows/:flowId` | | `Flow` |
| `DELETE /api/domains/:name/flows/:flowId` | `?force=1` | `{ ok: true }` |
| `GET /api/domains/:name/containers` | | `ContainerSummary[]` whose mounts reference the domain path |
| `GET /api/jobs` / `GET /api/jobs/:id` | | `Job[]` / `Job` |
| `GET /api/images` | | `[{ ref, present, id, size, created }]` for catalog images |
| `POST /api/images/pull` | `{ image }` | `202 { jobId }` |
| `GET /api/ports/check` | `?port=9600&protocol=tcp` | `{ port, protocol, container: {id,name,state}|null, listening: boolean }` (listening = a quick `net` bind probe on `0.0.0.0` failed with EADDRINUSE) |

`:id` for containers accepts full id, short id or name (Dockerode resolves names).

## 8. WebSockets — `src/ws.ts`

Attach a single `WebSocketServer({ noServer: true })`; handle `upgrade` on the http server;
route by `url.pathname`; reject unknown paths (404 → `socket.destroy()`); enforce auth.
Ping every 30 s, terminate dead sockets.

| path | server → client | client → server |
|---|---|---|
| `/ws/events` | `{type:'hello', version}`, `{type:'container', action, id, name, time}`, `{type:'image', action, id}`, `{type:'job', job}` | — |
| `/ws/containers/:id/logs?tail=&timestamps=` | `{type:'log', stream, text}`, `{type:'end'}`, `{type:'error', message}` | `{type:'stop'}` |
| `/ws/containers/:id/terminal?cols=&rows=&cmd=` | **binary** frames = terminal output; text `{type:'ready'}`, `{type:'exit', code}`, `{type:'error', message}` | **binary** frames = stdin; text `{type:'resize', cols, rows}` |

`cmd` query, when present, is split on whitespace and replaces the default shell.

## 9. Frontend — `public/`

Vanilla ES modules, no framework, no build. Dark, dense "broadcast control" look, responsive
down to ~900 px. Hash router: `#/containers` (default), `#/domains`, `#/domains/<name>`.
`api.js` wraps `fetch` (adds token header from `localStorage['easy-mxl.token']`, throws with
the server `error.code/message`, on 401 shows a token prompt) and WebSocket URL building
(`ws(s)://<location.host>/ws/...?token=`).

Views:

1. **Top bar** — brand "EASY MXL", Docker status dot (green/red, tooltip with version), domain
   root, nav (Containers / Domains & Flows), "Launch app" button.
2. **Containers** — table: name, app / image, state badge, ports (`host→container/proto`),
   domain, actions. Actions: **Open UI** (new tab, `http://<location.hostname>:<hostPort><path>`),
   **API docs**, **Logs**, **Terminal**, **Start/Stop/Restart**, **Remove** (confirm; force for
   running). Toggle "show stopped" (default on). Live refresh on `/ws/events` container
   events plus 10 s polling fallback. Empty state points to "Launch app".
3. **Launch dialog** — step 1: app cards grouped by category (name, description, image,
   `imagePresent` badge "image not pulled yet", existing container state). Step 2: form —
   domain select (lists `/api/domains`, includes "+ create domain…" that opens the domain
   create form inline), container name, host port inputs (pre‑filled; async in‑use check via
   `/api/ports/check` showing a warning), hostPaths inputs, params inputs, "also launch
   required apps" checkbox, advanced: extra env `KEY=VALUE` lines, pull policy. Launch →
   shows job progress (pull layers, dependency steps) via `/ws/events` job messages → on done
   shows "Open UI" link; on `name_conflict` offers **Start existing** or **Remove & relaunch**.
4. **Domains & Flows** — left column: domain list (name, label, flow counts, tmpfs warning
   icon when not tmpfs, "no domain_def.json" warning) + create form (name, label,
   description, buffer depth ms → `historyDurationMs`). Right: selected domain — path with
   copy button, id/label/description, fs type + size/used, history duration (editable),
   **mount snippet** (`-v <path>:/mxl-domain -e MXL_DOMAIN=/mxl-domain`) with copy, attached
   containers (names, state, mount mode), **Flows table**: group, role, label, uuid (copy,
   shortened), summary, status badge (active green / inactive amber / stale grey), head index,
   last write age, latency (grains), writer container (link to logs), size; row click expands
   `flow_def.json` + header JSON; **Delete** for non‑active flows (confirm). Polls
   `/api/domains/<name>` every 2 s while visible. Domain **Delete** with confirm (force when
   attached).
5. **Logs panel** (slide‑over) — `<pre>` with autoscroll (pause when scrolled up), tail
   select (100/500/2000), timestamps toggle, wrap toggle, clear, reconnect on container
   restart. ANSI SGR sequences are stripped. stderr lines get a subtle tint.
6. **Terminal panel** (slide‑over) — xterm.js + fit addon; opens WS; sends resize on fit and
   on window resize; shows `[process exited with code N]`; "Reconnect" button.
7. **Toasts** for errors/success; **confirm** modal for destructive actions.

Accessibility: buttons have `aria-label`s; keyboard closes panels with Esc. Keep the total
frontend under ~2500 lines. No external CDN.

## 10. Deployment

* `bin/easy-mxl.ts`: `#!/usr/bin/env node`; loads config; on `--help` prints help; creates
  docker; loads catalog; ensures domain root (best effort); starts server; prints
  `EASY MXL v… listening on http://host:port  (domain root /dev/shm/mxl, docker ok/unreachable)`;
  graceful shutdown on SIGINT/SIGTERM.
* `deploy/easy-mxl.service`: `ExecStart=/usr/bin/node /opt/easy-mxl/dist/bin/easy-mxl.js`,
  `Environment=EASY_MXL_HOST=0.0.0.0`, `EnvironmentFile=-/etc/default/easy-mxl`,
  `Restart=on-failure`, `User=root` by default with a comment on using a docker‑group user.
* `scripts/install-ubuntu24.sh`: idempotent; checks `docker` + `node >= 20` (offers NodeSource
  22.x apt setup when missing), compiles TypeScript in `/opt/easy-mxl`, prunes dev dependencies, installs the unit,
  writes `/etc/default/easy-mxl` template (token placeholder), enables + starts, prints URL.
  Optional flag `--tmpfs-volumes` adds the hands‑on `/Volumes/mxl` fstab entry.
* `deploy/Dockerfile` (optional): multi-stage `node:22-alpine` build, then production dependencies only;
  README documents `docker run --pid=host -v /var/run/docker.sock:/var/run/docker.sock
  -v /dev/shm:/dev/shm -p 9700:9700 easy-mxl` and the reason for `--pid=host` (/proc/locks
  PIDs → container mapping).

## 11. Testing

`npm test` → `node --test test/`. No network, no Docker required. Tests use `node:test` +
`node:assert/strict`, temp dirs via `fs.mkdtemp`, and fake Dockerode objects (plain objects
with the methods used). An **integration** test file `test/integration.docker.test.ts` runs
only when `EASY_MXL_IT=1` and a daemon is reachable: it starts a `busybox` container that
creates a fake flow (`flow_def.json` + 2048‑byte `data`) and holds `flock -s` on `data`,
then asserts the flow is `active` and the writer maps to that container.

Fixtures live in `test/fixtures/` (sample `/proc/locks`, `/proc/<pid>/cgroup`, Docker
inspect JSON, flow_def examples copied from the MXL repo).

## 12. Non‑goals (v0.1)

Docker Compose file import, multi‑host, user accounts/RBAC, TLS termination (put nginx or
Caddy in front), editing flow_def.json, NMOS registry integration.


### 13.1 App schema additions (`src/catalog.ts`)

| field | type | default | meaning |
|---|---|---|---|
| `imagePolicy` | `"pull"` \| `"local"` | `"pull"` | `local` = never pull; the operator loads the image with `docker load` and picks a tag at launch |
| `imageRepository` | string | `image` without tag/digest | repository used to list locally present tags (exact match on `<repository>:`) |
| `imageRepositories` | string[] | `[imageRepository]` | allowed repositories when an architecture-specific delivery uses different image names |
| `ipcMode` | string | unset | `HostConfig.IpcMode` (`host`, `private`, `shareable`, `none`, `container:<name>`) |
| `volumes` | `[{ name, containerPath, readOnly? }]` | `[]` | Docker **named volumes**; rendered as `Binds` entries `name:containerPath[:ro]`. `name` is templated and must match `/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/` after rendering |

Built‑in template variables, available in `env`, `cmd`, `entrypoint` and `volumes[].name`
without a declared param: `{{containerName}}` (final container name), `{{domainName}}` (empty
when no domain), `{{domainContainerPath}}` (empty when no `domainMount`). Declared params take
precedence over built‑ins with the same key.

### 13.2 Launch behaviour (`src/docker/launch.ts`, `src/docker/images.ts`)

* `LaunchParams.image?: string` — image reference override. Validated as a Docker reference
  (`/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/`);
  for `imagePolicy: local` its repository part must be included in `imageRepositories`
  (400 `image_repository_mismatch`). The resolved reference becomes `createOptions.Image`.
* `imagePolicy: local`: never pull. `pull: 'always'` → 400 `invalid_pull_policy`. When the
  resolved image is absent → 404 `image_not_loaded` with message
  `Image "<ref>" is not loaded on this host. Load the delivered archive first: docker load -i <archive>.tar, then pick the tag in the launch dialog.`
  and `details: { image, repositories, localImages }`.
* `images.js`: `export async function listLocalImages(docker, repositories) -> [{ ref, tag, id, created, size }]`
  from `docker.listImages()` (`RepoTags` matching an allowed repository), newest first; returns
  `[]` on daemon errors after logging.

### 13.3 API changes (`src/routes/apps.ts`)

`GET /api/apps` and `GET /api/apps/:id` add `imagePolicy`, `imageRepository`,
`imageRepositories` and, for local
apps, `localImages` (`[]` when none). For local apps `imagePresent` is `localImages.length > 0`.
`POST /api/apps/:id/launch` accepts `image` in the body (string, optional).

### 13.4 Frontend (`public/launch.js`)

For `imagePolicy === 'local'` apps the card badge reads **image not loaded** when
`imagePresent` is false. The form shows an **Image** select listing `localImages` (label
`ref · size · created`), newest first, submitted as `params.image`; when the list is empty a
warning notice shows the `docker load -i <file>.tar` instruction and the Launch button is
disabled. The Pull policy control is hidden for local apps. `app.notes` is shown above the form.


