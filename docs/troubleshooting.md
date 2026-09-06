# Troubleshooting

Symptoms you may meet on a fresh host, what causes them and what to do. `GET /api/health`
(`curl -H "Authorization: Bearer $EASY_MXL_TOKEN" http://localhost:9700/api/health`) is the
first thing to check: it tells you whether Docker is reachable, whether `/proc/locks` is
readable and where the TAI offset comes from.

## Docker and images

### permission denied on /var/run/docker.sock

Health shows Docker unreachable and the API answers `502 docker_unavailable`. Run EASY MXL as
root (systemd unit) or add your user to the `docker` group: `sudo usermod -aG docker $USER`,
then log in again or `newgrp docker`. Check with `docker info`. If the daemon is simply not
running: `sudo systemctl start docker`.

### Image pull fails

Behind a proxy configure the daemon as described under
[Requirements](getting-started.md#requirements) (`docker pull ghcr.io/cbcrc/test-generator:latest`
on the host shows the raw error). The images are published for `linux/amd64`; on an arm64 host
Docker needs `qemu-user-static` / binfmt emulation. An image that does not exist yet on
`ghcr.io` (check the hands-on repository) has to be built from source and given a new `image`
in a [custom catalog](apps.md#adding-your-own-apps).


## Domains and flows

### A domain does not show up inside an app

The GStreamer apps list every directory under `/mxl-domain` that contains a `domain_def.json`.
A directory created by hand has none - create the domain through EASY MXL (Domains & Flows or
`POST /api/domains`), or add the file; such directories are flagged "no domain_def.json" in the
domain list. Also check the mount: the web apps expect the domain at `/mxl-domain`, the
hands-on writer / reader tools at `/domain`. The domain view shows the attached containers and
a copy-ready mount snippet (`-v /dev/shm/mxl/domain_1:/mxl-domain -e MXL_DOMAIN=/mxl-domain`).

### missing domain_def.json on a domain

The directory exists under the domain root but has no (or an unreadable) `domain_def.json`, so
the apps' domain scan skips it and the launch dialog refuses to select it. Open the domain
under **Domains & Flows** and press **Fix: create domain_def.json**; EASY MXL writes a new
definition with a fresh id and the directory name as label
(`POST /api/domains/<name>/repair`). A valid existing file is only replaced when `force` is
set in the API call.

### A flow shows inactive although its writer is running

Activity comes from `/proc/locks`, so EASY MXL must run on the same host as the containers; if
it runs in Docker it needs `--pid=host` and `--cgroupns=host`
([Deployment](deployment.md#running-easy-mxl-itself-in-docker)). When `/proc/locks` is
unreadable the status is unknown (`active: null`); `GET /api/health` reports
`procLocksReadable`. If the writer has crashed the flow really is inactive or stale - delete it
from the flow table.

### A flow is active but has no writer container

The lock holder's PID could not be mapped to a container. In a containerised EASY MXL this is
the missing `--cgroupns=host`: in a private cgroup namespace `/proc/<pid>/cgroup` of other
containers' processes no longer contains the `docker-<id>.scope` path. A writer that runs
directly on the host (not in a container) also shows no container name.

### "not on tmpfs" warning on a domain

The domain root is on a disk filesystem. MXL memory maps the flow files and expects RAM-backed
storage; use `/dev/shm/mxl` (default), mount a tmpfs at your root (see
[Requirements](getting-started.md#requirements)), or on WSL 2 use the `/Volumes/mxl` fstab
entry from the hands-on preparation and `--domain-root /Volumes/mxl`.

### mxl-writer cannot write: Permission denied in its logs

The hands-on writer and reader run as uid 1000 and need a domain directory writable by that
uid. EASY MXL creates domains as `1000:1000` mode `0775` when it runs as root; when it runs
unprivileged it cannot chown, so either run it as root or set `--domain-uid/--domain-gid` to
your own ids. Fix an existing domain with `sudo chown -R 1000:1000 /dev/shm/mxl/domain_1`.

### Latency or last-write age is off by about 37 s

The TAI-UTC offset could not be read (no `python3`); `GET /api/health` shows `taiOffsetNs` and
`taiSource`. Install `python3` or ignore it - flow status does not depend on it. See
[How it works](how-it-works.md#time-latency-and-the-tai-offset).

## Launching and ports

### Port already in use

For EASY MXL itself (`EADDRINUSE` at start) choose another port with `--port`. For an app, the
launch dialog checks each host port (`/api/ports/check`) and warns; change the host port in the
form or stop the process using it (`ss -ltnp | grep 9600`). If a container of the same name
already exists - typically from the hands-on `docker compose` stack - the launch reports
`name_conflict` and offers **Start existing** or **Remove & relaunch**.

### HTML5 Keyer crashes at start (Chromium "Bus error" / renderer gone)

Chromium needs a 1 GB `/dev/shm` *inside its container*; the catalog sets `shmSize: "1g"`.
Verify with `docker inspect html5-keyer --format '{{.HostConfig.ShmSize}}'` (expected
`1073741824`), and make sure the host has that much free memory besides the domains.

## Access

### 403 origin_not_allowed / host_not_allowed

The browser origin or the `Host` header does not match the address EASY MXL is bound to
(typical behind a reverse proxy or when opening it through a DNS name while bound to
loopback). Add the public origin or name with `--allowed-origins` /
`EASY_MXL_ALLOWED_ORIGINS` ([Configuration](configuration.md#security-model)).

### 401 unauthorized / the UI keeps asking for a token

The request carries no token or a wrong one. The token is `EASY_MXL_TOKEN` in
`/etc/default/easy-mxl` (installer) or whatever you passed with `-e EASY_MXL_TOKEN` / `--token`.
The UI stores it in the browser once accepted; clear it by entering the new one when prompted.
