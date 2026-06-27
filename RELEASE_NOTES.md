# Release Notes

## v1.1.0 - 2026-06-27

### Added
- Added WSL host recovery support for OpenClaw Companion Windows Gateway setup failures.
- Added `fix-wsl-host` to run `wsl --update` and `wsl --shutdown`, with `--web-download` support for Store-blocked environments.
- Added `reset-wsl-gateway --yes` for explicit stale `OpenClawGateway` cleanup.
- Added explicit `fix-wsl --source-distro <Ubuntu>` and `setup --source-distro <Ubuntu>` flows for app-owned Gateway distro creation.
- Added parser and CLI regression tests using Node's built-in test runner.

### Changed
- `setup` now checks port, WSL host readiness, Gateway distro state, and CA certificate sync as separate phases.
- Gateway distro creation no longer clones the first Ubuntu distro implicitly; the source distro must be named explicitly.
- Destructive reset behavior is limited to the default `OpenClawGateway` unless a non-default target is confirmed by name.
- Core parsing/config helper logic moved to `lib/openclaw-patch-core.js` for better testability.
- Package contents are allowlisted so generated local artifacts are not published.

### Fixed
- Fixed false-success CLI paths for unknown commands, WSL shutdown failure, missing Gateway distro during certificate sync, and unsupported host checks.
- Fixed `fix-wsl` cleanup so temporary WSL export tarballs are removed on export failure, import failure, and successful import.
- Documented the common `preflight-wsl`, `wsl-create`, and `No gateway yet` failure family and the recommended recovery sequence.

### Validation
- `npm test` passes 12 tests.
- `node --check` passes for changed JavaScript files.
- `npm pack --dry-run` includes only the intended package files.
- Independent code review result: APPROVE.
- Independent architecture review result: CLEAR.
