const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_SERVER_URL = process.env.OMNIPORTAL_SERVER_URL || "https://omniportal.ronanrocking.com";
const WINDOW_TITLE = "OmniPortal Host";
const HOST_CODE_PATTERN = /^\d{6}$/;

function configPath() {
  return path.join(app.getPath("userData"), "host-config.json");
}

function generateHostCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function normalizeServerUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  const candidate = trimmed || DEFAULT_SERVER_URL;
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Server URL must start with http:// or https://");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeDisplayName(value) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, 50);
}

function normalizeHostCode(value, fallbackCode) {
  const nextCode = String(value || fallbackCode || "").trim();
  if (!HOST_CODE_PATTERN.test(nextCode)) {
    return generateHostCode();
  }
  return nextCode;
}

function defaultConfig() {
  const now = new Date().toISOString();
  return {
    host_id: crypto.randomUUID(),
    host_code: generateHostCode(),
    display_name: "",
    server_url: normalizeServerUrl(DEFAULT_SERVER_URL),
    created_at: now,
    updated_at: now
  };
}

async function readConfig() {
  try {
    const raw = await fs.readFile(configPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      ...defaultConfig(),
      ...parsed,
      server_url: normalizeServerUrl(parsed.server_url || DEFAULT_SERVER_URL)
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    const config = defaultConfig();
    await fs.mkdir(path.dirname(configPath()), { recursive: true });
    await fs.writeFile(configPath(), JSON.stringify(config, null, 2), "utf-8");
    return config;
  }
}

async function writeConfig(nextConfig) {
  const current = await readConfig().catch(() => defaultConfig());
  const now = new Date().toISOString();
  const merged = {
    ...current,
    ...nextConfig,
    host_id: current.host_id,
    host_code: normalizeHostCode(nextConfig.host_code, current.host_code),
    display_name: normalizeDisplayName(nextConfig.display_name ?? current.display_name),
    server_url: normalizeServerUrl(nextConfig.server_url ?? current.server_url ?? DEFAULT_SERVER_URL),
    created_at: current.created_at || now,
    updated_at: now
  };
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 700,
    title: WINDOW_TITLE,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return;
    }
    event.preventDefault();
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { role: "reload", label: "Reload" },
        { role: "forceReload", label: "Force Reload" },
        { type: "separator" },
        { role: "quit", label: "Exit" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload", label: "Reload" },
        { role: "toggleDevTools", label: "Toggle DevTools" },
        { type: "separator" },
        { role: "resetZoom", label: "Actual Size" },
        { role: "zoomIn", label: "Zoom In" },
        { role: "zoomOut", label: "Zoom Out" }
      ]
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Open OmniPortal Website",
          click: () => shell.openExternal(DEFAULT_SERVER_URL)
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("host-config:load", async () => {
  return readConfig();
});

ipcMain.handle("host-config:save", async (_event, nextConfig) => {
  return writeConfig(nextConfig || {});
});

ipcMain.handle("host-config:regenerate-code", async () => {
  return writeConfig({ host_code: generateHostCode() });
});

ipcMain.handle("host-runtime:info", async () => {
  return {
    defaultServerUrl: normalizeServerUrl(DEFAULT_SERVER_URL),
    deviceName: os.hostname(),
    platform: process.platform,
    appVersion: app.getVersion()
  };
});

ipcMain.handle("host-http:request-json", async (_event, request) => {
  const response = await fetch(request.url, {
    method: request.method || "GET",
    headers: request.headers || {},
    body: request.body
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || "Request failed.");
  }
  return data;
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
