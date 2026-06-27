#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const VERSION = require("../package.json").version;
const {
  cleanOutput,
  compareVersions,
  DEFAULT_DISTRO,
  detectConfig,
  getArgValue,
  isKnownProblematicWslVersion,
  parseWslDistroList,
  parseWslVersion,
} = require("../lib/openclaw-patch-core");

// ─── Helpers ───

const config = detectConfig();
const GATEWAY_PORT = config.port;
const DISTRO = config.distro;

function log(msg) { console.log(`\x1b[36m[patch]\x1b[0m ${msg}`); }
function ok(msg)  { console.log(`\x1b[32m  ✓\x1b[0m ${msg}`); }
function warn(msg){ console.log(`\x1b[33m  !\x1b[0m ${msg}`); }
function fail(msg){ console.error(`\x1b[31m  ✗\x1b[0m ${msg}`); }

function ps(cmd) {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", cmd], {
    encoding: "utf-8", windowsHide: true, timeout: 30000,
  });
  return {
    ok: r.status === 0,
    out: cleanOutput(r.stdout),
    err: cleanOutput(r.stderr || (r.error ? r.error.message : "")),
    missing: r.error && r.error.code === "ENOENT",
    status: r.status,
  };
}

function wsl(cmd, user) {
  const args = ["-d", DISTRO];
  if (user) args.push("-u", user);
  args.push("--", "bash", "-c", cmd);
  const r = spawnSync("wsl.exe", args, { encoding: "utf-8", windowsHide: true, timeout: 30000 });
  return {
    ok: r.status === 0,
    out: cleanOutput(r.stdout),
    err: cleanOutput(r.stderr || (r.error ? r.error.message : "")),
    missing: r.error && r.error.code === "ENOENT",
    status: r.status,
  };
}

function wslHost(args, timeout = 30000) {
  const r = spawnSync("wsl.exe", args, {
    encoding: "utf-8",
    windowsHide: true,
    timeout,
  });
  return {
    ok: r.status === 0,
    out: cleanOutput(r.stdout),
    err: cleanOutput(r.stderr || (r.error ? r.error.message : "")),
    missing: r.error && r.error.code === "ENOENT",
    status: r.status,
  };
}

function getWslHostReport() {
  const versionResult = wslHost(["--version"]);
  const statusResult = wslHost(["--status"]);
  const listResult = wslHost(["-l", "-v"]);
  const combined = [versionResult.out, versionResult.err, statusResult.out, statusResult.err].join("\n");
  const version = parseWslVersion(combined);

  return {
    available: !(versionResult.missing && statusResult.missing && listResult.missing),
    version,
    knownProblematicVersion: isKnownProblematicWslVersion(version),
    versionResult,
    statusResult,
    listResult,
    distros: parseWslDistroList(listResult.out),
  };
}

function printWslRecoveryGuidance() {
  warn("Recommended WSL recovery sequence:");
  console.log("    wsl --version");
  console.log("    wsl --status");
  console.log("    wsl -l -v");
  console.log("    wsl --update");
  console.log("    wsl --shutdown");
  console.log("    # reboot Windows, then retry OpenClaw Companion setup");
  warn("If Store-based update is blocked, run: wsl --update --web-download");
}

function showWslHostStatus() {
  const report = getWslHostReport();

  if (!report.available) {
    fail("WSL host: wsl.exe not found");
    warn("Enable WSL and Virtual Machine Platform, then install/update Store WSL.");
    printWslRecoveryGuidance();
    return report;
  }

  if (report.version) {
    const label = report.knownProblematicVersion ? "known problematic for app-owned distro creation" : "detected";
    const printer = report.knownProblematicVersion ? warn : ok;
    printer(`WSL host: ${report.version} (${label})`);
  } else {
    warn("WSL host: version not detected from wsl --version output");
  }

  if (report.statusResult.ok) {
    ok("WSL status: command completed");
  } else {
    warn(`WSL status: ${report.statusResult.err || "command failed"}`);
  }

  if (report.knownProblematicVersion || !report.statusResult.ok) {
    printWslRecoveryGuidance();
  }

  return report;
}

function wslHostReadyForAppDistro(report = getWslHostReport()) {
  return report.available && report.statusResult.ok && !report.knownProblematicVersion;
}

// ─── fix-port ───

function fixPort() {
  log(`Checking port ${GATEWAY_PORT}...`);

  const r = ps(`
    $c = Get-NetTCPConnection -LocalPort ${GATEWAY_PORT} -ErrorAction SilentlyContinue
    if ($c) {
      $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      "$($p.Id)|$($p.Name)|$($p.Path)"
    }
  `);

  if (r.missing) {
    fail("PowerShell not available — cannot check or free the gateway port");
    return false;
  }

  if (!r.ok && !r.out) {
    fail(`Could not check port ${GATEWAY_PORT}: ${r.err || "unknown error"}`);
    return false;
  }

  if (!r.out) {
    ok(`Port ${GATEWAY_PORT} is free`);
    return true;
  }

  const [pid, name, ppath] = r.out.split("|");
  warn(`Port ${GATEWAY_PORT} held by ${name} (PID ${pid}) → ${ppath || "unknown"}`);

  const kill = ps(`Stop-Process -Id ${pid} -Force`);
  if (!kill.ok) {
    fail(`Could not kill PID ${pid}: ${kill.err}`);
    return false;
  }

  // Wait for port release
  for (let i = 0; i < 10; i++) {
    const check = ps(`Get-NetTCPConnection -LocalPort ${GATEWAY_PORT} -ErrorAction SilentlyContinue`);
    if (!check.out) { ok(`Port ${GATEWAY_PORT} freed`); return true; }
    spawnSync("timeout", ["/t", "1", "/nobreak"], { windowsHide: true, stdio: "ignore" });
  }

  fail(`Port ${GATEWAY_PORT} still in use after 10s`);
  return false;
}

// ─── fix-certs ───

function fixCerts() {
  log("Syncing Windows CA certificates to WSL...");

  // Check WSL distro exists
  const distroCheck = wslHost(["-l", "-q"]);
  if (distroCheck.missing) {
    fail("wsl.exe not found — cannot sync certificates");
    return false;
  }
  if (!distroCheck.out || !distroCheck.out.includes(DISTRO)) {
    fail(`WSL distro '${DISTRO}' not found — cannot sync certificates`);
    warn("Run OpenClaw setup first, or create the Gateway distro with: openclaw-patch setup --source-distro Ubuntu-24.04");
    return false;
  }

  // Export Windows CA certs via PowerShell
  const exportCmd = `
    $pem = ''
    foreach ($storeName in @('Root','CA')) {
      $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, 'LocalMachine')
      $store.Open('ReadOnly')
      foreach ($cert in $store.Certificates) {
        $b64 = [Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks')
        $pem += "-----BEGIN CERTIFICATE-----\`n$b64\`n-----END CERTIFICATE-----\`n"
      }
      $store.Close()
    }
    $pem
  `;

  const exp = ps(exportCmd);
  if (!exp.ok || !exp.out) {
    fail(`Could not export Windows CA store: ${exp.err}`);
    return false;
  }

  const certCount = (exp.out.match(/BEGIN CERTIFICATE/g) || []).length;
  log(`Exported ${certCount} certificates from Windows store`);

  // Write cert bundle into WSL via wsl.exe stdin (avoids UNC EPERM issues)
  const certPath = "/usr/local/share/ca-certificates/windows-ca-bundle.crt";
  const writeResult = spawnSync("wsl.exe", [
    "-d", DISTRO, "-u", "root", "--", "bash", "-c",
    `mkdir -p /usr/local/share/ca-certificates && cat > ${certPath}`
  ], {
    input: exp.out, encoding: "utf-8", windowsHide: true, timeout: 30000,
  });

  if (writeResult.status !== 0) {
    fail(`Could not write CA bundle to WSL: ${(writeResult.stderr || "").trim()}`);
    return false;
  }
  ok(`Wrote ${certCount} certs to WSL ca-certificates`);

  // Run update-ca-certificates
  const up = wsl("update-ca-certificates 2>&1", "root");
  if (up.ok) {
    ok("update-ca-certificates completed");
  } else {
    fail(`update-ca-certificates exited with error: ${up.err || up.out}`);
    return false;
  }

  return true;
}

// ─── status ───

function showStatus() {
  log("Status check\n");

  showWslHostStatus();
  console.log();

  // Port
  const portCheck = ps(`
    $c = Get-NetTCPConnection -LocalPort ${GATEWAY_PORT} -ErrorAction SilentlyContinue
    if ($c) {
      $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      "USED|$($p.Id)|$($p.Name)|$($p.Path)"
    } else { "FREE" }
  `);
  if (portCheck.missing) {
    warn("PowerShell: not available — port and tray process checks skipped");
  } else if (portCheck.out === "FREE") {
    ok(`Port ${GATEWAY_PORT}: free`);
  } else if (!portCheck.ok && !portCheck.out) {
    warn(`Port ${GATEWAY_PORT}: check failed (${portCheck.err || "unknown error"})`);
  } else {
    const [, pid, name] = portCheck.out.split("|");
    warn(`Port ${GATEWAY_PORT}: held by ${name} (PID ${pid})`);
  }

  // WSL distro
  const distroCheck = wslHost(["-l", "-q"]);
  const distros = distroCheck.out || "";
  if (distros.includes(DISTRO)) {
    ok(`WSL distro: ${DISTRO} registered`);

    // CA bundle
    const certCheck = spawnSync("wsl.exe", ["-d", DISTRO, "-u", "root", "--", "bash", "-c",
      "grep -c 'BEGIN CERTIFICATE' /usr/local/share/ca-certificates/windows-ca-bundle.crt 2>/dev/null || echo 0"
    ], { encoding: "utf-8", windowsHide: true, timeout: 10000 });
    const certCount = parseInt((certCheck.stdout || "0").trim(), 10);
    if (certCount > 0) {
      ok(`CA bundle: ${certCount} certs synced`);
    } else {
      warn("CA bundle: not synced (run: openclaw-patch fix-certs)");
    }
  } else {
    warn(`WSL distro: ${DISTRO} not found`);
  }

  // OpenClaw tray
  const trayCheck = ps(`Get-Process -Name OpenClawTray -ErrorAction SilentlyContinue | Select -First 1 -Expand Id`);
  if (trayCheck.missing) {
    // Already reported above.
  } else if (trayCheck.out) {
    ok(`OpenClaw tray: running (PID ${trayCheck.out})`);
  } else {
    warn("OpenClaw tray: not running");
  }

  return true;
}

// ─── fix-wsl ───

function getWslDistros() {
  const r = wslHost(["-l", "-q"]);
  return (r.out || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function fixWslHost() {
  log("Updating WSL host and restarting the WSL VM...");

  const updateArgs = ["--update"];
  if (process.argv.includes("--web-download")) updateArgs.push("--web-download");

  const update = wslHost(updateArgs, 300000);
  if (!update.ok) {
    fail(`wsl ${updateArgs.join(" ")} failed: ${update.err || update.out || "unknown error"}`);
    if (!updateArgs.includes("--web-download")) {
      warn("If Microsoft Store update is blocked, retry: openclaw-patch fix-wsl-host --web-download");
    }
    return false;
  }
  ok("wsl --update completed");

  const shutdown = wslHost(["--shutdown"], 60000);
  if (!shutdown.ok) {
    fail(`wsl --shutdown failed: ${shutdown.err || shutdown.out || "unknown error"}`);
    return false;
  } else {
    ok("wsl --shutdown completed");
  }

  warn("Reboot Windows before retrying OpenClaw Companion if preflight-wsl still fails.");
  return true;
}

function resetWslGateway() {
  const argv = process.argv.slice(2);
  const targetDistro = getArgValue(argv, "--target-distro") || DEFAULT_DISTRO;

  log(`Resetting app-owned WSL distro '${targetDistro}'...`);

  const distroList = wslHost(["-l", "-q"]);
  if (distroList.missing) {
    fail("wsl.exe not found — cannot inspect or reset Gateway distro");
    return false;
  }

  const distros = (distroList.out || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!distros.includes(targetDistro)) {
    ok(`WSL distro '${targetDistro}' is not registered`);
    return true;
  }

  if (!argv.includes("--yes")) {
    fail(`Refusing to unregister '${targetDistro}' without --yes`);
    warn(`This deletes all data inside the app-owned Gateway distro '${targetDistro}'.`);
    warn(`If this is stale failed setup state, run: openclaw-patch reset-wsl-gateway --yes`);
    return false;
  }

  if (targetDistro !== DEFAULT_DISTRO && getArgValue(argv, "--confirm-distro") !== targetDistro) {
    fail(`Refusing to unregister non-default distro '${targetDistro}' without --confirm-distro ${targetDistro}`);
    warn(`Default reset only targets '${DEFAULT_DISTRO}'.`);
    return false;
  }

  wslHost(["--shutdown"], 60000);
  const unreg = wslHost(["--unregister", targetDistro], 300000);
  if (!unreg.ok) {
    fail(`Could not unregister '${targetDistro}': ${unreg.err || unreg.out || "unknown error"}`);
    return false;
  }

  ok(`Unregistered stale WSL distro '${targetDistro}'`);
  wslHost(["--shutdown"], 60000);
  return true;
}

function getSourceDistroArg() {
  return getArgValue(process.argv.slice(2), "--source-distro");
}

function removeFileQuietly(filePath) {
  try { fs.unlinkSync(filePath); } catch {}
}

function fixWsl() {
  log(`Creating WSL distro '${DISTRO}' from local Ubuntu (bypasses --web-download TLS issue)...\n`);

  const hostReport = showWslHostStatus();
  if (!wslHostReadyForAppDistro(hostReport)) {
    fail("WSL host is not ready to create/register an app-owned OpenClaw Gateway distro");
    warn("Run: openclaw-patch fix-wsl-host");
    return false;
  }
  console.log();

  const distros = getWslDistros();

  // Already exists?
  if (distros.includes(DISTRO)) {
    ok(`WSL distro '${DISTRO}' already exists`);
    warn(`If OpenClaw still reports 'No gateway yet' after a failed setup, inspect status or run: openclaw-patch reset-wsl-gateway --yes`);
    return true;
  }

  // Find the source Ubuntu distro to export. This is explicit because it copies a filesystem.
  const sourceDistro = getSourceDistroArg();
  const ubuntuCandidates = distros.filter(d => /^ubuntu/i.test(d));
  if (!sourceDistro) {
    fail("Missing required --source-distro for fix-wsl");
    if (ubuntuCandidates.length > 0) {
      warn(`Available Ubuntu-like distros: ${ubuntuCandidates.join(", ")}`);
      warn(`Example: openclaw-patch fix-wsl --source-distro ${ubuntuCandidates[0]}`);
    } else {
      warn("No local Ubuntu distro found to clone from");
    }
    warn("Install Ubuntu from Microsoft Store first: wsl --install Ubuntu-24.04");
    return false;
  }
  if (!distros.includes(sourceDistro)) {
    fail(`Source distro '${sourceDistro}' is not registered`);
    if (ubuntuCandidates.length > 0) warn(`Available Ubuntu-like distros: ${ubuntuCandidates.join(", ")}`);
    return false;
  }
  if (!/^ubuntu/i.test(sourceDistro)) {
    fail(`Source distro '${sourceDistro}' is not Ubuntu-like`);
    warn("Use a clean Ubuntu distro, for example Ubuntu-24.04.");
    return false;
  }

  log(`Found source distro: ${sourceDistro}`);
  warn(`This copies the '${sourceDistro}' filesystem into '${DISTRO}'. Use a clean Ubuntu distro if you do not want personal files/packages copied.`);

  // Export source distro to temp tar
  const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const tmpTar = path.join(appData, "OpenClawTray", "wsl-export.tar");
  const installPath = path.join(appData, "OpenClawTray", "wsl", DISTRO);

  try { fs.mkdirSync(path.dirname(tmpTar), { recursive: true }); } catch {}
  try { fs.mkdirSync(path.dirname(installPath), { recursive: true }); } catch {}

  log(`Exporting ${sourceDistro} → ${tmpTar} (this may take a minute)...`);
  const exp = spawnSync("wsl.exe", ["--export", sourceDistro, tmpTar], {
    encoding: "utf-8", windowsHide: true, timeout: 300000, stdio: "pipe",
  });

  if (exp.status !== 0) {
    fail(`Export failed: ${(exp.stderr || "").trim()}`);
    removeFileQuietly(tmpTar);
    return false;
  }
  ok("Export complete");

  // Import as OpenClawGateway
  log(`Importing as '${DISTRO}' → ${installPath}...`);
  const imp = spawnSync("wsl.exe", ["--import", DISTRO, installPath, tmpTar, "--version", "2"], {
    encoding: "utf-8", windowsHide: true, timeout: 300000, stdio: "pipe",
  });

  if (imp.status !== 0) {
    fail(`Import failed: ${(imp.stderr || "").trim()}`);
    warn("If the error mentions preflight-wsl or distro registration, run: openclaw-patch fix-wsl-host");
    removeFileQuietly(tmpTar);
    return false;
  }
  ok(`WSL distro '${DISTRO}' created`);

  // Clean up temp tar
  removeFileQuietly(tmpTar);

  // Boot it once to make sure it's ready
  const boot = spawnSync("wsl.exe", ["-d", DISTRO, "--", "echo", "ready"], {
    encoding: "utf-8", windowsHide: true, timeout: 30000,
  });
  if (boot.status === 0) {
    ok("Distro booted successfully");
  } else {
    warn("Distro created but first boot had issues — setup may still work");
  }

  return true;
}

// ─── setup (orchestrated) ───

function hasDistro() {
  return getWslDistros().includes(DISTRO);
}

function runSetup() {
  log("=== OpenClaw Setup Patch Orchestrator ===\n");

  // Phase 1: fix port
  log("Phase 1/4: Port");
  const portOk = fixPort();
  if (!portOk) return false;
  console.log();

  // Phase 2: WSL host must be healthy enough to register app-owned distros
  log("Phase 2/4: WSL host");
  const hostReport = showWslHostStatus();
  if (!wslHostReadyForAppDistro(hostReport)) {
    fail("WSL host preflight failed");
    warn("Run: openclaw-patch fix-wsl-host");
    warn("Then reboot Windows and run: openclaw-patch setup");
    return false;
  }
  console.log();

  // Phase 3: ensure WSL distro exists (bypass --web-download TLS)
  log("Phase 3/4: WSL distro");
  if (hasDistro()) {
    ok(`WSL distro '${DISTRO}' already exists`);
  } else {
    if (!getSourceDistroArg()) {
      fail(`WSL distro '${DISTRO}' is not registered and setup will not clone an Ubuntu distro implicitly`);
      warn("Retry with an explicit clean Ubuntu source, for example:");
      warn("  openclaw-patch setup --source-distro Ubuntu-24.04");
      warn("Or let OpenClaw Companion create the app-owned distro, then rerun: openclaw-patch setup");
      return false;
    }
    const wslOk = fixWsl();
    if (!wslOk) return false;
  }
  console.log();

  // Phase 4: sync CA certs
  log("Phase 4/4: CA certificates");
  if (hasDistro()) {
    const certsOk = fixCerts();
    if (!certsOk) return false;
  } else {
    fail("WSL distro still not available — cannot sync certs");
    warn("Install Ubuntu manually: wsl --install Ubuntu-24.04");
    warn("Then run: openclaw-patch setup");
    return false;
  }
  console.log();

  ok("All patches applied!");
  log("Now run OpenClaw setup — it should succeed.\n");
  return true;
}

// ─── CLI ───

function main() {
  const cmd = process.argv[2] || "setup";
  let success = true;

  console.log(`\n\x1b[1mopenclaw-patch v${VERSION}\x1b[0m\n`);

  switch (cmd) {
    case "fix-port":
      success = fixPort();
      break;

    case "fix-certs":
      success = fixCerts();
      break;

    case "fix-wsl-host":
      success = fixWslHost();
      break;

    case "fix-wsl":
      success = fixWsl();
      break;

    case "reset-wsl-gateway":
      success = resetWslGateway();
      break;

    case "status":
      success = showStatus();
      break;

    case "setup":
    case "all":
      success = runSetup();
      break;

    case "help":
    case "--help":
    case "-h":
      console.log("Usage: openclaw-patch [command]\n");
      console.log("Commands:");
      console.log("  setup              Full setup patch — port + WSL host + distro + certs (default)");
      console.log("                     Use setup --source-distro Ubuntu-24.04 when Gateway distro is missing");
      console.log("  fix-port           Kill process holding gateway port");
      console.log("  fix-wsl-host       Run wsl --update and wsl --shutdown");
      console.log("  fix-wsl            Create WSL distro from explicit --source-distro Ubuntu");
      console.log("  reset-wsl-gateway  Unregister stale app-owned Gateway distro (requires --yes)");
      console.log("  fix-certs          Sync Windows CA certs to WSL");
      console.log("  status             Show current status");
      console.log("  all                Alias for setup");
      break;

    default:
      fail(`Unknown command: ${cmd}`);
      console.log("Usage: openclaw-patch [command]");
      console.log("Run: openclaw-patch --help");
      success = false;
      break;
  }

  console.log();
  if (success === false) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  compareVersions,
  detectConfig,
  getArgValue,
  isKnownProblematicWslVersion,
  parseWslDistroList,
  parseWslVersion,
};
