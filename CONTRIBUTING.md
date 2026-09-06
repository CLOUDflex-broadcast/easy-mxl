# Contributing to EASY MXL

Thanks for helping make MXL easier. Bug reports, catalog entries for new media
functions, documentation fixes and code are all welcome.

## Development setup

```sh
git clone https://github.com/CLOUDflex-broadcast/easy-mxl.git
cd easy-mxl
npm ci
npm run build        # compile TypeScript to dist/
npm test             # build + unit tests (no Docker needed)
npm run dev          # rebuild on change and restart the server
```

`EASY_MXL_IT=1 npm test` additionally runs the integration tests against the local
Docker daemon (needs `busybox`). The design contract lives in
[`docs/DESIGN.md`](docs/DESIGN.md); the module layout and API are described there and
in the [documentation site](https://cloudflex-broadcast.github.io/easy-mxl/).

## Pull requests

- Open an issue first for anything larger than a bug fix or a catalog entry, so the
  approach can be agreed before you invest time.
- Keep pull requests focused. Add or update tests for behaviour you change; the CI
  runs `npm run typecheck`, `npm test`, shell checks and a release-tarball dry run on
  every pull request.
- Documentation lives in `docs/` (MkDocs). Update it together with the code when a
  flag, endpoint or catalog field changes.
- Catalog entries (`catalog/default.json`) must reference public images or clearly
  documented locally loaded archives, follow the field table in the docs, and come
  with a `source` link. Run `npm test` to validate the entry.

## Commit messages

Use a short imperative subject line and explain *why* in the body when it is not
obvious. Reference issues with `Fixes #123` where applicable.

## Releases (maintainers)

```sh
npm version minor -m "Release v%s"   # or patch / major
git push --follow-tags
```

The release workflow verifies that the tag matches `package.json`, runs the tests,
builds `easy-mxl-<version>.tar.gz`, publishes the GitHub Release (with
`SHA256SUMS` and `install.sh`) and the Docker workflow pushes the versioned image
to GHCR. The documentation site deploys automatically on pushes to `main`.

## Code of conduct

Be kind and constructive. Harassment or personal attacks are not tolerated; report
concerns privately to the maintainers.
