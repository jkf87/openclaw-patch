#!/usr/bin/env node
"use strict";

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── Config Detection ───

function detectConfig() {
  const cfg = { port: 18789, distro: "OpenClawGateway" };

  // 1. (lowest) Read from setup config if present
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const configLocations = [
    path.join(appData, "OpenClawTray", "setup-config.json"),
    path.join(localAppData, "OpenClawTray", "setup-config.json"),
  ];
  for (const cfgPath of configLocations) {
    try {
      if (fs.existsSync(cfgPath)) {
        const j = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        if (j.GatewayPort) cfg.port = j.GatewayPort;
        if (j.DistroName) cfg.distro = j.DistroName;
        break;
      }
    } catch { /* use defaults */ }
  }

  // 2. Read from tray settings (overrides setup config)
  const settingsPath = path.join(appData, "OpenClawTray", "settings.json");
  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings.GatewayUrl) {
        const m = settings.GatewayUrl.match(/:(\d+)\/?$/);
        if (m) cfg.port = parseInt(m[1], 10);
      }
    }
  } catch { /* use defaults */ }

  // 3. (highest) CLI args: --port 12345 --distro MyDistro
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) cfg.port = parseInt(args[i + 1], 10);
    if (args[i] === "--distro" && args[i + 1]) cfg.distro = args[i + 1];
  }

  return cfg;
}

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
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function wsl(cmd, user) {
  const args = ["-d", DISTRO];
  if (user) args.push("-u", user);
  args.push("--", "bash", "-c", cmd);
  const r = spawnSync("wsl.exe", args, { encoding: "utf-8", windowsHide: true, timeout: 30000 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
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
  const distroCheck = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "utf-8", windowsHide: true });
  if (!distroCheck.stdout || !distroCheck.stdout.replace(/\0/g, "").includes(DISTRO)) {
    warn(`WSL distro '${DISTRO}' not found — skipping cert sync (run setup first)`);
    return true;
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

  // Write to WSL via UNC path
  const wslCertDir = `\\\\wsl$\\${DISTRO}\\usr\\local\\share\\ca-certificates`;
  const wslCertFile = path.join(wslCertDir, "windows-ca-bundle.crt");

  try {
    fs.mkdirSync(wslCertDir, { recursive: true });
    fs.writeFileSync(wslCertFile, exp.out, "utf-8");
    ok(`Wrote ${certCount} certs to WSL ca-certificates`);
  } catch (e) {
    fail(`Could not write to WSL filesystem: ${e.message}`);
    warn("Make sure WSL is running: wsl -d OpenClawGateway -- echo ok");
    return false;
  }

  // Run update-ca-certificates
  const up = wsl("update-ca-certificates 2>&1", "root");
  if (up.ok) {
    ok("update-ca-certificates completed");
  } else {
    warn(`update-ca-certificates exited with error: ${up.err || up.out}`);
  }

  return true;
}

// ─── status ───

function showStatus() {
  log("Status check\n");

  // Port
  const portCheck = ps(`
    $c = Get-NetTCPConnection -LocalPort ${GATEWAY_PORT} -ErrorAction SilentlyContinue
    if ($c) {
      $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      "USED|$($p.Id)|$($p.Name)|$($p.Path)"
    } else { "FREE" }
  `);
  if (portCheck.out === "FREE") {
    ok(`Port ${GATEWAY_PORT}: free`);
  } else {
    const [, pid, name, ppath] = portCheck.out.split("|");
    warn(`Port ${GATEWAY_PORT}: held by ${name} (PID ${pid})`);
  }

  // WSL distro
  const distroCheck = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "utf-8", windowsHide: true });
  const distros = (distroCheck.stdout || "").replace(/\0/g, "");
  if (distros.includes(DISTRO)) {
    ok(`WSL distro: ${DISTRO} registered`);

    // CA bundle
    const certPath = `\\\\wsl$\\${DISTRO}\\usr\\local\\share\\ca-certificates\\windows-ca-bundle.crt`;
    if (fs.existsSync(certPath)) {
      const content = fs.readFileSync(certPath, "utf-8");
      const count = (content.match(/BEGIN CERTIFICATE/g) || []).length;
      ok(`CA bundle: ${count} certs synced`);
    } else {
      warn("CA bundle: not synced (run: openclaw-patch fix-certs)");
    }
  } else {
    warn(`WSL distro: ${DISTRO} not found`);
  }

  // OpenClaw tray
  const trayCheck = ps(`Get-Process -Name OpenClawTray -ErrorAction SilentlyContinue | Select -First 1 -Expand Id`);
  if (trayCheck.out) {
    ok(`OpenClaw tray: running (PID ${trayCheck.out})`);
  } else {
    warn("OpenClaw tray: not running");
  }
}

// ─── setup (orchestrated) ───

function hasDistro() {
  const r = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "utf-8", windowsHide: true });
  return (r.stdout || "").replace(/\0/g, "").includes(DISTRO);
}

function runSetup() {
  log("=== OpenClaw Setup Patch Orchestrator ===\n");

  // Phase 1: always fix port
  log("Phase 1: Port check");
  fixPort();
  console.log();

  // Phase 2: check WSL distro to decide cert strategy
  if (hasDistro()) {
    // Distro exists → we can sync certs now
    log("Phase 2: WSL distro found — syncing certificates");
    fixCerts();
    console.log();
    ok("All patches applied!");
    log("Now re-run OpenClaw setup — it should succeed.\n");
  } else {
    // Distro doesn't exist yet → need setup to create it first
    log("Phase 2: WSL distro not found yet\n");
    ok("Port is ready.");
    console.log();
    log("Next steps:");
    console.log("  1. Run OpenClaw setup now (it will create WSL but may fail at install-cli)");
    console.log("  2. After that failure, run this command again:");
    console.log(`     \x1b[1mopenclaw-patch setup\x1b[0m`);
    console.log("  3. WSL distro will exist, certs will be synced, then re-run setup\n");
  }
}

// ─── CLI ───

const cmd = process.argv[2] || "setup";

console.log("\n\x1b[1mopenclaw-patch v1.0.0\x1b[0m\n");

switch (cmd) {
  case "fix-port":
    fixPort();
    break;

  case "fix-certs":
    fixCerts();
    break;

  case "status":
    showStatus();
    break;

  case "setup":
    runSetup();
    break;

  case "all":
    log("Applying all patches...\n");
    const p = fixPort();
    console.log();
    const c = fixCerts();
    console.log();
    if (p && c) {
      ok("All patches applied. Run OpenClaw setup now.");
    } else {
      warn("Some patches had issues — check output above.");
    }
    break;

  default:
    console.log("Usage: openclaw-patch [command]\n");
    console.log("Commands:");
    console.log("  setup      Guided setup patch (default)");
    console.log("  fix-port   Kill process holding port 18789");
    console.log("  fix-certs  Sync Windows CA certs to WSL");
    console.log("  status     Show current status");
    console.log("  all        Apply all patches at once");
    break;
}

console.log();
