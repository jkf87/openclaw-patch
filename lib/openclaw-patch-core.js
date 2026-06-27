"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_DISTRO = "OpenClawGateway";
const KNOWN_BAD_WSL_APP_DISTRO_VERSION = "2.3.24.0";

function cleanOutput(value) {
  return (value || "").replace(/\0/g, "").trim();
}

function getArgValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--")) return undefined;
  return argv[index + 1];
}

function detectConfig(argv = process.argv.slice(2)) {
  const cfg = { port: 18789, distro: DEFAULT_DISTRO };

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

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) cfg.port = parseInt(argv[i + 1], 10);
    if (argv[i] === "--distro" && argv[i + 1]) cfg.distro = argv[i + 1];
  }

  return cfg;
}

function parseWslVersion(output) {
  const text = cleanOutput(output);
  const explicit = text.match(/WSL\s+(?:version:?\s*)?(\d+\.\d+\.\d+(?:\.\d+)?)/i);
  if (explicit) return explicit[1];
  const fallback = text.match(/\b(\d+\.\d+\.\d+(?:\.\d+)?)\b/);
  return fallback ? fallback[1] : null;
}

function compareVersions(a, b) {
  const left = String(a || "").split(".").map(n => parseInt(n, 10) || 0);
  const right = String(b || "").split(".").map(n => parseInt(n, 10) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    if ((left[i] || 0) > (right[i] || 0)) return 1;
    if ((left[i] || 0) < (right[i] || 0)) return -1;
  }
  return 0;
}

function isKnownProblematicWslVersion(version) {
  return Boolean(version) && compareVersions(version, KNOWN_BAD_WSL_APP_DISTRO_VERSION) <= 0;
}

function parseWslDistroList(output) {
  return cleanOutput(output)
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^\*\s*/, ""))
    .filter(Boolean)
    .filter(line => !/^NAME\s+STATE\s+VERSION$/i.test(line))
    .map(line => {
      const verbose = line.match(/^(.+?)\s+(Running|Stopped|Installing|Uninstalling|Converting)\s+([12])$/i);
      if (verbose) {
        return { name: verbose[1].trim(), state: verbose[2], version: verbose[3] };
      }
      return { name: line, state: "", version: "" };
    });
}

module.exports = {
  cleanOutput,
  compareVersions,
  DEFAULT_DISTRO,
  detectConfig,
  getArgValue,
  isKnownProblematicWslVersion,
  parseWslDistroList,
  parseWslVersion,
};
