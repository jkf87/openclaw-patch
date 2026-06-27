const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const cliPath = path.join(__dirname, "..", "bin", "openclaw-patch.js");

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
  });
}

function runCliWithPath(args, extraPath) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
    env: { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH || ""}` },
  });
}

test("help exits successfully", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: openclaw-patch/);
});

test("unknown commands fail instead of silently showing successful help", () => {
  const result = runCli(["does-not-exist"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: does-not-exist/);
});

test("reset-wsl-gateway fails when WSL is unavailable", { skip: process.platform === "win32" }, () => {
  const result = runCli(["reset-wsl-gateway", "--target-distro", "MyGateway", "--yes"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /wsl\.exe not found|cannot inspect or reset Gateway distro/);
});

test("fix-wsl fails when host preflight cannot run", { skip: process.platform === "win32" }, () => {
  const result = runCli(["fix-wsl", "--source-distro", "Ubuntu-24.04"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WSL host: wsl\.exe not found|WSL host is not ready/);
});

test("fix-certs fails when WSL exists but Gateway distro is missing", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-patch-test-"));
  const fakeWsl = path.join(dir, "wsl.exe");
  fs.writeFileSync(fakeWsl, "#!/bin/sh\nif [ \"$1\" = \"-l\" ]; then printf 'Ubuntu-24.04\\n'; exit 0; fi\nexit 1\n");
  fs.chmodSync(fakeWsl, 0o755);

  try {
    const result = runCliWithPath(["fix-certs"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OpenClawGateway' not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
