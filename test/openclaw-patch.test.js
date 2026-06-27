const assert = require("node:assert/strict");
const test = require("node:test");

const {
  compareVersions,
  detectConfig,
  getArgValue,
  isKnownProblematicWslVersion,
  parseWslDistroList,
  parseWslVersion,
} = require("../lib/openclaw-patch-core");

test("parseWslVersion reads regular wsl --version output", () => {
  assert.equal(parseWslVersion("WSL version: 2.4.10.0\nKernel version: 5.15.153.1"), "2.4.10.0");
});

test("parseWslVersion reads OpenClaw preflight wording", () => {
  assert.equal(
    parseWslVersion("WSL 2.3.24.0 cannot create a clean app-owned OpenClaw gateway distro"),
    "2.3.24.0",
  );
});

test("known problematic WSL versions are detected conservatively", () => {
  assert.equal(isKnownProblematicWslVersion("2.3.24.0"), true);
  assert.equal(isKnownProblematicWslVersion("2.3.23.0"), true);
  assert.equal(isKnownProblematicWslVersion("2.4.0.0"), false);
});

test("compareVersions handles different version lengths", () => {
  assert.equal(compareVersions("2.4.0", "2.3.24.0"), 1);
  assert.equal(compareVersions("2.3.24.0", "2.3.24"), 0);
  assert.equal(compareVersions("2.3.1", "2.3.24"), -1);
});

test("parseWslDistroList handles verbose WSL list output", () => {
  const distros = parseWslDistroList("\u0000  NAME            STATE           VERSION\n* Ubuntu-24.04    Stopped         2\n  OpenClawGateway Running         2\n");
  assert.deepEqual(distros, [
    { name: "Ubuntu-24.04", state: "Stopped", version: "2" },
    { name: "OpenClawGateway", state: "Running", version: "2" },
  ]);
});

test("detectConfig honors CLI overrides", () => {
  assert.deepEqual(detectConfig(["setup", "--port", "19000", "--distro", "MyGateway"]), {
    port: 19000,
    distro: "MyGateway",
  });
});

test("getArgValue does not treat another flag as the missing value", () => {
  assert.equal(getArgValue(["reset-wsl-gateway", "--target-distro", "--yes"], "--target-distro"), undefined);
  assert.equal(getArgValue(["fix-wsl", "--source-distro", "Ubuntu-24.04"], "--source-distro"), "Ubuntu-24.04");
});
