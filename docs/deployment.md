# Deployment

EASY MXL runs as a systemd service on the Docker host (the primary deployment) or as a
container next to the media functions it manages. Both routes end up with the same process
listening on port 9700.

## As a systemd service

### With the one-line installer

```sh
curl -fsSL https://github.com/CLOUDflex-broadcast/easy-mxl/releases/latest/download/install.sh | sudo bash
```

The script installs Docker Engine if it is missing, Node.js 22 if it is missing, and the
latest release (`easy-mxl-<version>.tar.gz`, prebuilt with `dist/` and production
`node_modules`) to `/opt/easy-mxl`. It installs the systemd unit, which listens on
`0.0.0.0:9700`, writes `/etc/default/easy-mxl` with a random `EASY_MXL_TOKEN` and prints the
URL and the token.

Options are environment variables: `EASY_MXL_VERSION=v0.1.0` pins a release,
`EASY_MXL_TMPFS_VOLUMES=1` adds the hands-on `/Volumes/mxl` tmpfs entry to `/etc/fstab` and
mounts it.

```sh
curl -fsSL https://github.com/CLOUDflex-broadcast/easy-mxl/releases/latest/download/install.sh \
  | sudo env EASY_MXL_VERSION=v0.1.0 bash
```

### With the repository installer

From a git checkout or an unpacked release tarball:

```sh
git clone https://github.com/CLOUDflex-broadcast/easy-mxl.git easy-mxl
cd easy-mxl
sudo scripts/install-ubuntu24.sh            # add --yes for unattended, --tmpfs-volumes for /Volumes/mxl
```

The script checks Ubuntu 24 / Docker / Node.js (offers NodeSource 22.x when Node is missing),
copies the repository to `/opt/easy-mxl`, installs dependencies, compiles TypeScript and prunes
development dependencies (a prebuilt release tarball, recognised by its `.release-prebuilt`
marker, is copied as-is without touching npm), installs `deploy/easy-mxl.service`, creates
`/etc/default/easy-mxl` with a random `EASY_MXL_TOKEN` (printed once, file mode 0600), enables
and starts the service and prints the URL. It is idempotent: re-run it after `git pull` to
upgrade; an existing `/etc/default/easy-mxl` is left untouched.

| Option | Effect |
|---|---|
| `-y`, `--yes` | do not prompt; accept the Node.js 22.x installation from NodeSource when Node.js >= 20 is missing |
| `--tmpfs-volumes` | also add the mxl-hands-on tmpfs mount `tmpfs /Volumes/mxl tmpfs defaults,noatime,size=512M,uid=1000,gid=1000,mode=0755 0 0` to `/etc/fstab` and mount it now |
| `-h`, `--help` | show the help and exit |

When systemd is not running (WSL without systemd, a container) the unit is installed but not
started; the script prints the command to start EASY MXL by hand.

### Manual steps

```sh
sudo rsync -a --delete --exclude node_modules --exclude .git ./ /opt/easy-mxl/
cd /opt/easy-mxl && sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo cp deploy/easy-mxl.service /etc/systemd/system/
sudo cp deploy/easy-mxl.env.example /etc/default/easy-mxl
sudo chmod 600 /etc/default/easy-mxl
sudo sed -i "s|^#EASY_MXL_TOKEN=.*|EASY_MXL_TOKEN=$(openssl rand -hex 16)|" /etc/default/easy-mxl
sudo systemctl daemon-reload
sudo systemctl enable --now easy-mxl
systemctl status easy-mxl; journalctl -u easy-mxl -f
```

### What the unit does

The unit runs `/usr/bin/node /opt/easy-mxl/dist/bin/easy-mxl.js` as root with
`EASY_MXL_HOST=0.0.0.0`, after `docker.service`, restarting on failure. Values in
`/etc/default/easy-mxl` override the unit's `Environment=` lines (systemd applies
`EnvironmentFile=` after `Environment=`). Logs go to the journal (`journalctl -u easy-mxl -f`).
The unit applies mild hardening (`NoNewPrivileges`, `ProtectSystem=full`,
`ProtectHome=read-only`, `PrivateTmp`) that leaves the Docker socket and `/dev/shm` usable; do
not add `PrivateDevices=` or `ProtectProc=`, the first hides `/dev/shm` and the second breaks
the `/proc/<pid>/cgroup` lookups.

`User=root` is the default because EASY MXL needs the Docker socket (root-equivalent anyway),
reads `/proc/locks` and `/proc/<pid>/cgroup` to map flow writers to containers, and chowns new
domain directories to `1000:1000`. The unit file explains how to run as an unprivileged member
of the `docker` group instead:

```sh
sudo useradd --system --home /opt/easy-mxl --shell /usr/sbin/nologin -G docker easy-mxl
# then in the unit: User=easy-mxl / Group=docker
```

Such a user cannot chown the domains it creates, so set `EASY_MXL_DOMAIN_UID` / `GID` to its
ids in `/etc/default/easy-mxl` (or make it uid 1000) and keep the domain mode at `0775`.

## Running EASY MXL itself in Docker

Pull the published image or build it from the repository root (so that `.dockerignore`
applies):

```sh
docker build -t easy-mxl -f deploy/Dockerfile .      # build from the repository root
```

```sh
EASY_MXL_TOKEN="$(openssl rand -hex 16)"; echo "token: $EASY_MXL_TOKEN"   # keep it, the UI asks for it
docker run -d --name easy-mxl --restart unless-stopped \
  --pid=host --cgroupns=host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /dev/shm:/dev/shm \
  -p 9700:9700 \
  -e EASY_MXL_TOKEN="$EASY_MXL_TOKEN" \
  ghcr.io/cloudflex-broadcast/easy-mxl:latest
```

Images are tagged with the release version, `major.minor` and `latest`
(`ghcr.io/cloudflex-broadcast/easy-mxl:0.1.0`, `:0.1`, `:latest`).

- `-v /var/run/docker.sock:...` gives the container the Docker API; it is root-equivalent on
  the host, so always set a token and publish the port only where you trust the network
  (`-p 127.0.0.1:9700:9700` keeps it local).
- `-v /dev/shm:/dev/shm` - the domain root must be visible at the **same absolute path**
  inside and outside the container. When EASY MXL launches an app it asks the daemon to bind
  mount `<domain path>`, and the daemon resolves that path on the host. With another root
  (for example `/Volumes/mxl`) mount it at the identical path and set
  `-e EASY_MXL_DOMAIN_ROOT=/Volumes/mxl`.
- `--pid=host` - `/proc/locks` lists lock holders by PID *as seen from the reader's PID
  namespace*. In an isolated namespace the writer processes of other containers show up as PID
  0 and cannot be mapped to a container through `/proc/<pid>/cgroup`; sharing the host PID
  namespace makes writer detection work exactly as on the host.
- `--cgroupns=host` - on cgroup v2 hosts (stock Ubuntu 24.04) a container gets a private
  cgroup namespace, in which `/proc/<pid>/cgroup` of other containers' processes no longer
  contains the `docker-<id>.scope` path; without the host cgroup namespace flows show as active
  but without a writer container name.
- `/api/ports/check` probes ports from inside the EASY MXL container, so its "already
  listening on this host" hint only reflects that container; the container-binding check
  (which app publishes the port) still works.

The image is `node:22-alpine` plus `python3` (for the TAI offset) and the production
dependencies; `EASY_MXL_HOST=0.0.0.0` is preset and port 9700 is exposed. It carries a
`HEALTHCHECK` that calls `/api/health` with the configured token every 30 s. Extra catalog
files go in with another `-v` plus `-e EASY_MXL_CATALOG=/path/in/container.json`.

## Upgrading

| Installed with | Upgrade |
|---|---|
| one-line installer | run the same `curl ... \| sudo bash` command again (or with `EASY_MXL_VERSION=` to pick a release); `/etc/default/easy-mxl` is kept |
| repository installer | `git pull` in the checkout, then `sudo scripts/install-ubuntu24.sh` again |
| manual steps | repeat the rsync / `npm ci` / `npm run build` / `npm prune --omit=dev` steps and `sudo systemctl restart easy-mxl` |
| container | `docker pull ghcr.io/cloudflex-broadcast/easy-mxl:latest`, `docker rm -f easy-mxl`, then the `docker run` command above |

Upgrading EASY MXL does not touch the media-function containers or the domains: the containers
keep running, the domains stay on tmpfs until the host reboots.

## Uninstalling

With the one-line installer:

```sh
curl -fsSL https://github.com/CLOUDflex-broadcast/easy-mxl/releases/latest/download/install.sh | sudo bash -s -- --uninstall
```

By hand, for an installation made with the repository installer or the manual steps:

```sh
sudo systemctl disable --now easy-mxl
sudo rm /etc/systemd/system/easy-mxl.service /etc/default/easy-mxl
sudo systemctl daemon-reload
sudo rm -rf /opt/easy-mxl
```

For the container: `docker rm -f easy-mxl`. Containers launched through EASY MXL are ordinary
Docker containers and stay until you remove them (`docker rm -f test-generator ...`); a
`/Volumes/mxl` fstab entry added by the installer has to be removed by hand.

## Behind a reverse proxy

EASY MXL speaks plain HTTP and WebSocket. To add TLS or publish it under a DNS name, keep it
bound to loopback and put nginx or Caddy in front:

```nginx
server {
    listen 443 ssl;
    server_name ops.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:9700;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 1h;
    }
}
```

```caddyfile
ops.example.com {
    reverse_proxy 127.0.0.1:9700
}
```

Three things to get right:

- **WebSocket upgrade.** `/ws/events`, `/ws/containers/:id/logs` and
  `/ws/containers/:id/terminal` need the `Upgrade` / `Connection` headers forwarded (nginx
  needs `proxy_http_version 1.1`; Caddy handles it by itself).
- **Idle timeouts.** Log and terminal sockets stay open for as long as the panel is open. EASY
  MXL pings every WebSocket every 30 s, which keeps most proxies happy; raise the read timeout
  (`proxy_read_timeout`) anyway if your proxy cuts idle connections.
- **Allowed origins.** Behind the proxy the browser's `Origin` and the forwarded `Host` name
  the public address while EASY MXL is bound to loopback, so start it with
  `--allowed-origins https://ops.example.com` (or `EASY_MXL_ALLOWED_ORIGINS` in
  `/etc/default/easy-mxl`); otherwise state-changing calls and WebSocket upgrades fail with
  `403 origin_not_allowed` / `host_not_allowed` ([Configuration](configuration.md#security-model)).


