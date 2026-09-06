# syntax=docker/dockerfile:1
#
# EASY MXL as a container (optional deployment; the systemd unit is the
# primary one). Build from the REPOSITORY ROOT so that .dockerignore applies:
#
#   docker build -t easy-mxl -f deploy/Dockerfile .
#
# Run on the Docker host that owns the MXL domains:
#
#   docker run -d --name easy-mxl --restart unless-stopped \
#     --pid=host \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v /dev/shm:/dev/shm \
#     -p 9700:9700 \
#     -e EASY_MXL_TOKEN="$(openssl rand -hex 16)" \
#     easy-mxl
#
# Why each flag matters:
#
#   --pid=host        /proc/locks reports the PID of every flock() holder in the
#                     PID namespace of the reader. Inside an isolated namespace
#                     the writer processes of other containers show up as PID 0,
#                     so EASY MXL could not open /proc/<pid>/cgroup to map a
#                     flow to the container that writes it. Sharing the host PID
#                     namespace makes the writer detection work exactly as when
#                     EASY MXL runs directly on the host.
#   -v /var/run/docker.sock:/var/run/docker.sock
#                     EASY MXL talks to the Docker Engine API over this socket.
#                     Whoever can reach the EASY MXL API can start containers,
#                     i.e. is root on the host: publish 9700 only on trusted
#                     networks and always set EASY_MXL_TOKEN.
#   -v /dev/shm:/dev/shm
#                     The domain root (default /dev/shm/mxl) must be visible at
#                     the SAME absolute path inside and outside this container.
#                     When EASY MXL launches an app it asks the daemon for a bind
#                     mount of "<domain path>", and the daemon resolves that path
#                     on the HOST. If you use another root (e.g. /Volumes/mxl),
#                     mount it at the same path and set EASY_MXL_DOMAIN_ROOT.
#   -p 9700:9700      UI and API. Use -p 127.0.0.1:9700:9700 to keep it local.
#
# python3 is included only to read CLOCK_TAI for exact TAI/UTC offsets (MXL
# timestamps are TAI); EASY MXL falls back to an estimate without it.

FROM node:22-alpine AS build

WORKDIR /opt/easy-mxl

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-alpine

LABEL org.opencontainers.image.title="EASY MXL" \
      org.opencontainers.image.description="Launch and manage DMF-MXL media function containers, inspect MXL domains and flows" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/CLOUDflex-broadcast/easy-mxl" \
      org.opencontainers.image.documentation="https://cloudflex-broadcast.github.io/easy-mxl/"

ENV NODE_ENV=production
WORKDIR /opt/easy-mxl

RUN apk add --no-cache python3

# Install production dependencies first so the layer is cached across code changes.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# The build stage compiles all TypeScript and copies the static runtime assets.
COPY --from=build /opt/easy-mxl/dist ./dist

ENV EASY_MXL_HOST=0.0.0.0 \
    EASY_MXL_PORT=9700 \
    EASY_MXL_DOMAIN_ROOT=/dev/shm/mxl

EXPOSE 9700

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.EASY_MXL_PORT || 9700) + '/api/health', { headers: { 'X-Easy-MXL-Token': process.env.EASY_MXL_TOKEN || '' } }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "dist/bin/easy-mxl.js"]
