# How it works

EASY MXL adds nothing to the MXL data path. It manages directories on a tmpfs, asks the Docker
daemon to bind-mount them into containers, and reads what the kernel already knows about who
holds which file lock.

## An MXL domain is a directory on tmpfs

An MXL domain is nothing more than a directory on a tmpfs filesystem (see
[dmf-mxl/mxl - Architecture](https://github.com/dmf-mxl/mxl/blob/main/docs/Architecture.md)).
Flows are memory-mapped files inside it, and several domains can coexist. EASY MXL keeps its
domains under a **domain root**, by default `/dev/shm/mxl/<name>` (`/dev/shm` is already a
tmpfs on Ubuntu, sized at half the RAM), or `/Volumes/mxl/<name>` if you want to stay
compatible with the hands-on compose files (`--domain-root /Volumes/mxl`).

Inside a domain directory:

| Path | Purpose |
|---|---|
| `domain_def.json` | `{"id": "<uuid>", "label": "...", "description": "..."}`. The GStreamer apps discover domains by looking for this file under the directory mounted at `/mxl-domain`; a domain **must** have it. |
| `options.json` | optional; `{"urn:x-mxl:option:history_duration/v1.0": <ns>}` - the ring-buffer depth in nanoseconds, 200 000 000 ns (200 ms) when absent. EASY MXL shows and edits it as the domain's *buffer depth*. |
| `<uuid>.mxl-flow/` | one directory per flow, named after the flow UUID. |

A flow directory in turn holds:

| Path | Purpose |
|---|---|
| `flow_def.json` | the NMOS IS-04 Flow resource: `id`, `label`, `description`, `format` (`urn:x-nmos:format:video`, `audio` or `data`), `media_type` (`video/v210`, `audio/float32`, `video/smpte291`, ...), `grain_rate` (video, data) or `sample_rate` and `channel_count` (audio), frame size, and the `urn:x-nmos:tag:grouphint/v1.0` tag `"<Group>:<Role>"` that EASY MXL shows as group and role. |
| `data` | the memory-mapped `mxlFlowInfo` header (2048 bytes, little-endian) followed by a small sync-state block. It carries the flow UUID, format, grain rate, `headIndex`, `lastWriteTime` and `lastReadTime`. |
| `grains/` | discrete flows (video, data): one file per ring-buffer slot, `data.0`, `data.1`, ... |
| `channels` | continuous flows (audio): one blob of `channelCount * bufferLength * 4` bytes. |
| `access` | touched by readers. |

EASY MXL creates the domain directory, `domain_def.json` and (when a buffer depth is given)
`options.json`; everything below that is written by the media functions. Directories under the
root that lack `domain_def.json` are still listed, flagged "no domain_def.json", with a
**Fix** button that regenerates the file (see
[Troubleshooting](troubleshooting.md#missing-domain_defjson-on-a-domain)).

## How a container gets the domain

When EASY MXL launches an app it bind-mounts the host domain directory into the container. The
GStreamer web apps get it at `/mxl-domain` with `MXL_DOMAIN=/mxl-domain` and discover every
directory underneath that has a `domain_def.json`; the simple `mxl-writer`, `mxl-reader` and
`mxl-clip-player` images expect it at `/domain` and run as uid 1000, which is why new domains
are owned by `1000:1000` with mode `0775` when EASY MXL runs as root. For containers you start
yourself the domain view shows a copy-ready snippet:
`-v /dev/shm/mxl/domain_1:/mxl-domain -e MXL_DOMAIN=/mxl-domain`.

Containers launched by EASY MXL carry `easy-mxl.*` labels (managed flag, app id, domain name
and path, web UI port and docs path, EASY MXL version). Containers started any other way - the
hands-on `docker compose` stacks, for example - are listed and manageable too; their domain is
inferred from mounts under the domain root and their web UI from the first published TCP port.

## How activity and the writer are detected

Flow activity is detected the same way the SDK does it. A writer holds a *shared* `flock()` on
`<flow>/data` for as long as it runs (it also locks `channels` and every grain file, but `data`
is the one `mxlIsFlowActive` tests). On Linux every such lock appears in `/proc/locks` with the
holder's PID and the file's device and inode:

```text
N: FLOCK  ADVISORY  READ <pid> <maj>:<min>:<inode> 0 EOF
```

EASY MXL reads `/proc/locks` once per scan, matches the FLOCK entries against `stat()` of each
flow's `data` file by major, minor and inode, and resolves the PID to a Docker container through
`/proc/<pid>/cgroup` (the `docker-<id>.scope` path). This is why it has to run on the same host
as the containers, or in a container with `--pid=host --cgroupns=host`
([Deployment](deployment.md#running-easy-mxl-itself-in-docker)).

Flow status as shown in the UI:

| Status | Meaning |
|---|---|
| **active** | a process holds the lock on `data`; the writer column names its container |
| **inactive** | valid header and `flow_def.json`, nobody holds the lock (writer stopped) |
| **stale** | the `data` file or `flow_def.json` is missing or unreadable - a leftover of a crashed writer, safe to delete |

When `/proc/locks` is unreadable the status is unknown (`active: null` in the API);
`GET /api/health` reports `procLocksReadable`.

## Time, latency and the TAI offset

MXL timestamps are TAI nanoseconds (`CLOCK_TAI`), and a grain index is a timestamp divided by
the grain duration. The SDK rounds half-up when converting (`IndexConversion.hpp`):

```text
index(ts)        = floor((ts * num + 5e8 * den) / (den * 1e9))
timestamp(index) = floor((index * den * 1e9 + num / 2) / num)
```

EASY MXL mirrors that exactly, so its figures match `mxl-info`. Per flow it shows:

- **head index** - `headIndex` from the flow header, the last grain the writer committed;
- **latency (grains)** - `index(now_TAI) - headIndex`, how many grains the writer is behind
  wall-clock time;
- **last write age** - `now_TAI - lastWriteTime`.

Node.js has no `CLOCK_TAI`, so the TAI-UTC offset comes from a probe. When `python3` is
installed EASY MXL runs
`python3 -c 'import time;print(time.clock_gettime_ns(time.CLOCK_TAI)-time.time_ns())'`
(cached, refreshed at most every 10 minutes; the kernel reports 37 s on a host where NTP or PTP
has set the TAI offset and 0 where it never was). Without `python3` the offset is assumed to be
0 and, as soon as a flow is actively written, refined from its `lastWriteTime` when the
difference clearly reveals a 0 s or 37 s offset. `GET /api/health` shows the value and its
source under `taiOffsetNs` and `taiSource` (`python3`, `assumed-zero` or `estimated`). Flow
status does not depend on it.

## Architecture

```text
                     browser  http://<host>:9700
                        |  HTML + /api/* (JSON) + /ws/* (events, logs, terminal)
                        v
 +---------------------------------------------------------------------------------+
 | Docker host (Ubuntu 24.04)                                                      |
 |                                                                                 |
 |  EASY MXL  (node dist/bin/easy-mxl.js)                                          |
 |   |-- Docker Engine API .... /var/run/docker.sock  (create/start/stop/logs/exec)|
 |   |-- domain root .......... /dev/shm/mxl/<domain>  (tmpfs)                     |
 |   |      domain_def.json, options.json, <uuid>.mxl-flow/{flow_def.json,data,   |
 |   |      grains/ | channels, access}                                            |
 |   `-- writer detection ..... /proc/locks -> pid -> /proc/<pid>/cgroup -> container
 |                                                                                 |
 |  /dev/shm/mxl/domain_1 --bind--> /mxl-domain  in test-generator, mxl2webrtc, ...|
 |                        --bind--> /domain      in mxl-writer, mxl-reader, ...    |
 +---------------------------------------------------------------------------------+
```

Everything runs in one Node.js process: an Express server serves the static frontend, the JSON
API under `/api/*` and the WebSocket endpoints under `/ws/*` ([HTTP API](api.md)); Dockerode
talks to the Docker Engine over the socket; the MXL modules read the domain root and `/proc`.
There is no database - domains live on tmpfs, containers in Docker, and the job registry
(pulls, launches) in memory.
