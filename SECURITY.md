# Security policy

EASY MXL controls a Docker daemon, which is equivalent to root on the host. Please
treat any issue that lets an unauthorised party reach the API as high severity.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's private
vulnerability reporting on the repository ("Security" tab, "Report a vulnerability")
or contact the CLOUDflex Broadcast maintainers directly. Include the version
(`node dist/bin/easy-mxl.js --version` or the image tag), how you deployed EASY MXL
(host install, container, reverse proxy) and steps to reproduce.

You will get an acknowledgement within a few working days and a fix or mitigation
as quickly as the severity warrants. Credit is given in the release notes unless
you prefer otherwise.

## Deployment guidance

- Keep the default loopback bind unless you need network access; when you do,
  set `EASY_MXL_TOKEN` (the installer generates one) and put a TLS-terminating
  reverse proxy in front.
- State-changing requests and WebSocket upgrades are rejected from other browser
  origins; list your proxy's public origin with `--allowed-origins`.
- Only mount trusted host paths into media-function containers; the launcher
  refuses `/`, `/etc`, `/proc`, `/sys`, `/dev`, `/boot` and the Docker socket.

Supported versions: the latest release. Older releases receive fixes only when the
change is trivial to backport.
