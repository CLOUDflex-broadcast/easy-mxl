# Configuration

Every option is available as a command-line flag and as an environment variable; flags win
over variables, variables over the built-in defaults.

## Options

| Setting | Default | Flag | Environment variable |
|---|---|---|---|
| Bind address | `127.0.0.1` | `--host <ip>` | `EASY_MXL_HOST` |
| Port | `9700` | `--port <n>` | `EASY_MXL_PORT` |
| Domain root (tmpfs) | `/dev/shm/mxl` | `--domain-root <dir>` | `EASY_MXL_DOMAIN_ROOT` |
| Docker endpoint | `/var/run/docker.sock` | `--docker <unix:// or tcp:// URL>` | `DOCKER_HOST` |
| API token | none | `--token <secret>` | `EASY_MXL_TOKEN` |
| Extra catalog file(s) | built-in only | `--catalog <file>` (repeatable) | `EASY_MXL_CATALOG` (`:`-separated) |
| Owner uid of new domains | `1000` | `--domain-uid <n>` | `EASY_MXL_DOMAIN_UID` |
| Owner gid of new domains | `1000` | `--domain-gid <n>` | `EASY_MXL_DOMAIN_GID` |
| Mode of new domains | `0775` | `--domain-mode <octal>` | `EASY_MXL_DOMAIN_MODE` |
| Log level | `info` | `--log-level <level>` (`debug`, `info`, `warn`, `error`, `silent`) | `EASY_MXL_LOG_LEVEL` |
| Allowed origins | request host only | `--allowed-origins <origin>` (repeatable) | `EASY_MXL_ALLOWED_ORIGINS` (`,`-separated) |
| Help / version | | `--help` (`-h`), `--version` | |

Flags accept both `--flag value` and `--flag=value`. An empty environment value counts as
unset, so `EASY_MXL_TOKEN=` means "no token". Values are validated at start (port range,
integer uid/gid, octal mode, known log level); an unknown flag or invalid value is reported
and EASY MXL exits. `node dist/bin/easy-mxl.js --help` prints the same table.

```sh
easy-mxl                                   # http://127.0.0.1:9700, domains in /dev/shm/mxl
easy-mxl --host 0.0.0.0 --token s3cret     # reachable on the LAN, token required
easy-mxl --domain-root /Volumes/mxl        # share domains with the mxl-hands-on compose files
easy-mxl --catalog ./my-apps.json          # add or override catalog entries
```

(`easy-mxl` stands for `node dist/bin/easy-mxl.js`; the systemd unit runs
`/usr/bin/node /opt/easy-mxl/dist/bin/easy-mxl.js`.)

`deploy/easy-mxl.env.example` documents the same variables in `KEY=value` form for
`/etc/default/easy-mxl` or `docker run --env-file`. Logs go to stderr - the journal under
systemd (`journalctl -u easy-mxl -f`).

Where the settings live depends on how you run EASY MXL:

| Run as | Settings |
|---|---|
| foreground (`npm start`, `node dist/bin/easy-mxl.js`) | flags or exported variables |
| systemd service | `/etc/default/easy-mxl`; its values override the unit's own `Environment=` lines (`EASY_MXL_HOST=0.0.0.0`); `systemctl restart easy-mxl` afterwards |
| container | `-e KEY=value` or `--env-file`; the image presets `EASY_MXL_HOST=0.0.0.0`, `EASY_MXL_PORT=9700` and `EASY_MXL_DOMAIN_ROOT=/dev/shm/mxl` |

## Security model

The API starts, stops and removes containers and bind-mounts host directories: whoever can
reach it is root on the host. EASY MXL therefore binds to loopback by default and prints a
prominent warning when started on another interface without a token:

```text
* SECURITY WARNING: listening on 0.0.0.0 WITHOUT a token.
* Anyone who can reach this port controls Docker on this host (root-equivalent).
* Set --token <secret> or EASY_MXL_TOKEN=<secret>, or bind to 127.0.0.1.
```

**Token.** When you expose EASY MXL on the LAN set `EASY_MXL_TOKEN`; every `/api/*` request and
`/ws/*` upgrade must then carry `Authorization: Bearer <token>`, `X-Easy-MXL-Token: <token>` or
`?token=<token>`, otherwise it gets `401 unauthorized`. The web UI asks for the token once and
stores it in the browser (`localStorage`). Static files are always served. The token is
compared in constant time.

```sh
curl -H "Authorization: Bearer $EASY_MXL_TOKEN" http://localhost:9700/api/health
```

**Origin guard.** Independently of the token, the server rejects browser requests from other
origins, because browsers do not apply the same-origin policy to WebSocket handshakes or to
"simple" POSTs: a state-changing `/api` call (anything but GET, HEAD, OPTIONS) or a WebSocket
upgrade whose `Origin` host does not match the request `Host` and is not allow-listed gets
`403 origin_not_allowed`. Requests without an `Origin` header (curl, scripts) are accepted
unless fetch metadata flags them `Sec-Fetch-Site: cross-site`.

**Host guard.** While bound to `127.0.0.1` a `Host` header other than localhost / `127.x` /
`::1` gets `403 host_not_allowed` (DNS rebinding protection). Other bind addresses are not
affected.

**Allow list.** If you publish EASY MXL through a reverse proxy under another name, list that
origin or host name with `--allowed-origins https://ops.example.com` (or
`EASY_MXL_ALLOWED_ORIGINS`). An entry may be a full origin, a `host[:port]` or a bare hostname;
`*` allows everything (not recommended). The list is used by both guards.

```sh
# example: reachable as https://ops.example.com through nginx on the same host
easy-mxl --host 127.0.0.1 --token "$EASY_MXL_TOKEN" --allowed-origins https://ops.example.com
```

Tokens are never written to the log; `?token=` in URLs is redacted. There is no TLS and no
user management; put a reverse proxy with TLS (nginx, Caddy) in front if you need either -
see [Deployment](deployment.md#behind-a-reverse-proxy).

## Domain ownership

New domain directories are created with owner `EASY_MXL_DOMAIN_UID:EASY_MXL_DOMAIN_GID`
(default `1000:1000`) and mode `EASY_MXL_DOMAIN_MODE` (default `0775`). `1000:1000` matches the
user the hands-on `mxl-writer`, `mxl-reader` and `mxl-clip-player` images run as; the GStreamer
web apps run as root and do not care.

Changing the owner needs root. When EASY MXL runs as root (the systemd unit, the container) it
chowns each new domain; when it runs unprivileged it cannot, so either run it as root or set
`--domain-uid` / `--domain-gid` to the ids of the user EASY MXL runs as and keep the mode at
`0775`. The domain root itself is created on start when missing (`mkdir -p`, chown and chmod
best effort). Fix an existing domain by hand with
`sudo chown -R 1000:1000 /dev/shm/mxl/domain_1`.

Remember that `/dev/shm` is a tmpfs: domains (and the containers' flows) disappear on reboot.
The containers themselves persist and are restarted by Docker (`unless-stopped`); recreate the
domain with the same name and they find it again.
