# Development

EASY MXL is a TypeScript project compiled by `tsc` to plain ES modules in `dist/`, with no
frontend framework and no bundler. This page covers the layout, the npm scripts, how to extend
the catalog and how a release is cut.

## Layout

```text
bin/easy-mxl.ts        CLI entry: flags, config, server start, graceful shutdown
src/config.ts          loadConfig(argv, env)
src/mxl/               flowinfo.ts (header parser), locks.ts (/proc/locks), flows.ts (scan), domain.ts (CRUD), time.ts (TAI)
src/docker/            client, containers, images, launch, logs, terminal, events
src/catalog.ts         catalog loading / validation / {{templates}}
src/jobs.ts            in-memory job registry
src/server.ts          express app, auth, static files, error handler
src/routes/            /api/* routers
src/ws.ts              /ws/* upgrade handling
public/                frontend TypeScript and static HTML/CSS
catalog/default.json   built-in app catalog
deploy/                systemd unit, env example, Dockerfile
scripts/               install-ubuntu24.sh, copy-static.ts
test/                  TypeScript node:test suites and fixtures
docs/                  this documentation (MkDocs) and DESIGN.md
dist/                  generated runnable JavaScript (created by `npm run build`)
```

Runtime dependencies: `dockerode`, `express`, `ws`, `@xterm/xterm`, `@xterm/addon-fit`;
Node.js >= 20.10. Everything else is Node built-ins. The compiled entry point is
`dist/bin/easy-mxl.js`; `npm start` runs it.

## npm scripts

```sh
npm run build       # compile TypeScript and copy runtime assets to dist/
npm test            # build, then run node:test - no Docker or network required
npm run typecheck   # validate the TypeScript project without emitting files
npm run dev         # rebuild on TypeScript changes and restart the compiled server
EASY_MXL_IT=1 npm test   # additionally runs test/integration.docker.test.ts against the local daemon (busybox)
```

Tests use `node:test` and `node:assert/strict` with temp directories, the fixtures in
`test/fixtures/` (sample `/proc/locks`, cgroup files, Docker inspect output, real flow headers)
and fake Dockerode objects. The integration test is skipped unless `EASY_MXL_IT=1`; it starts
throwaway `busybox` containers that create a fake flow and hold `flock -s` on its `data` file,
then asserts that the flow is `active` and the writer maps to that container.

The module contract - file paths, function signatures, data shapes and the MXL facts the
implementation relies on - is the [design contract](DESIGN.md). Changes to a module's public
API start there.

## Adding a catalog entry

1. Add the app object to `catalog/default.json` (schema and field table under
   [Apps](apps.md#adding-your-own-apps); the compose file of the hands-on exercise is the
   usual source for image, ports, mounts and environment).
2. Run `npm test`: the catalog tests load and validate the built-in file.
3. Start EASY MXL, launch the app against a domain and check **Open UI**, the flows and the
   writer detection.
4. Add the row to the [catalog table](apps.md#the-built-in-catalog) in the documentation.

While iterating, keep the entry in a separate file and load it with `--catalog my-app.json`;
an entry with the same `id` overrides the built-in one, so you can test a change without
editing `default.json`.

## Documentation

The site is built with MkDocs Material from `docs/` and `mkdocs.yml`:

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r docs/requirements.txt
mkdocs serve            # http://127.0.0.1:8000
mkdocs build --strict   # what CI runs; fails on broken links
```

Docs deploy to <https://cloudflex-broadcast.github.io/easy-mxl/> on every push to `main`.

## Release process

1. Make sure `main` is green (`npm test`, `npm run typecheck`).
2. Bump the version; `npm version` updates `package.json` and `package-lock.json`, commits and
   creates the tag `v<version>`:

    ```sh
    npm version minor -m "Release v%s"     # or patch / major
    git push --follow-tags
    ```

3. The release workflow runs on the tag: it verifies that the tag matches the version in
   `package.json`, runs the tests, builds the release tarball `easy-mxl-<version>.tar.gz`
   (prebuilt: `dist/` plus production `node_modules`, with the `.release-prebuilt` marker
   the installer recognises), publishes the GitHub Release with the tarball, `SHA256SUMS` and
   `install.sh`, and pushes the container image `ghcr.io/cloudflex-broadcast/easy-mxl` tagged
   with the version, `major.minor` and `latest`.

`GET /api/health` and `--version` report the version from `package.json`, which is why the tag
has to match it.

## Contributing and security

- [CONTRIBUTING.md](https://github.com/CLOUDflex-broadcast/easy-mxl/blob/main/CONTRIBUTING.md) -
  how to propose changes.
- [SECURITY.md](https://github.com/CLOUDflex-broadcast/easy-mxl/blob/main/SECURITY.md) - how to
  report a vulnerability. Remember that the EASY MXL API is root-equivalent on its host by
  design; the [security model](configuration.md#security-model) describes the guards around it.
- [README.md](https://github.com/CLOUDflex-broadcast/easy-mxl/blob/main/README.md) - the
  repository front page.

EASY MXL is licensed under the MIT License.
