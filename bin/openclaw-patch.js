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
  if (trayCheck.out) {
    ok(`OpenClaw tray: running (PID ${trayCheck.out})`);
  } else {
    warn("OpenClaw tray: not running");
  }
}

// ─── fix-wsl ───

function getWslDistros() {
  const r = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "utf-8", windowsHide: true });
  return (r.stdout || "").replace(/\0/g, "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function fixWsl() {
  log(`Creating WSL distro '${DISTRO}' from local Ubuntu (bypasses --web-download TLS issue)...\n`);

  const distros = getWslDistros();

  // Already exists?
  if (distros.includes(DISTRO)) {
    ok(`WSL distro '${DISTRO}' already exists`);
    return true;
  }

  // Find a source Ubuntu distro to export
  const sourceDistro = distros.find(d => /^ubuntu/i.test(d));
  if (!sourceDistro) {
    fail("No local Ubuntu distro found to clone from");
    warn("Install Ubuntu from Microsoft Store first: wsl --install Ubuntu-24.04");
    return false;
  }

  log(`Found source distro: ${sourceDistro}`);

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
    return false;
  }
  ok("Export complete");

  // Import as OpenClawGateway
  log(`Importing as '${DISTRO}' → ${installPath}...`);
  const imp = spawnSync("wsl.exe", ["--import", DISTRO, installPath, tmpTar], {
    encoding: "utf-8", windowsHide: true, timeout: 300000, stdio: "pipe",
  });

  if (imp.status !== 0) {
    fail(`Import failed: ${(imp.stderr || "").trim()}`);
    return false;
  }
  ok(`WSL distro '${DISTRO}' created`);

  // Clean up temp tar
  try { fs.unlinkSync(tmpTar); } catch {}

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
  const r = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "utf-8", windowsHide: true });
  return (r.stdout || "").replace(/\0/g, "").includes(DISTRO);
}

function runSetup() {
  log("=== OpenClaw Setup Patch Orchestrator ===\n");

  // Phase 1: fix port
  log("Phase 1/3: Port");
  const p = fixPort();
  console.log();

  // Phase 2: ensure WSL distro exists (bypass --web-download TLS)
  log("Phase 2/3: WSL distro");
  if (hasDistro()) {
    ok(`WSL distro '${DISTRO}' already exists`);
  } else {
    fixWsl();
  }
  console.log();

  // Phase 3: sync CA certs
  log("Phase 3/3: CA certificates");
  if (hasDistro()) {
    fixCerts();
  } else {
    fail("WSL distro still not available — cannot sync certs");
    warn("Install Ubuntu manually: wsl --install Ubuntu-24.04");
    warn("Then run: openclaw-patch setup");
    return;
  }
  console.log();

  ok("All patches applied!");
  log("Now run OpenClaw setup — it should succeed.\n");
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

  case "fix-wsl":
    fixWsl();
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
    console.log("  setup      Full setup patch — port + wsl + certs (default)");
    console.log("  fix-port   Kill process holding gateway port");
    console.log("  fix-wsl    Create WSL distro from local Ubuntu (bypass --web-download)");
    console.log("  fix-certs  Sync Windows CA certs to WSL");
    console.log("  status     Show current status");
    console.log("  all        Apply all patches at once");
    break;
}

console.log();
