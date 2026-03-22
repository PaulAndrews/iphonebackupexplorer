import { app, BrowserWindow, shell } from "electron";
import { createApp } from "../src/server/create-app.js";

let backendServer = null;
let backendUrl = "";
let mainWindow = null;

function openExternalUrlSafely(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      void shell.openExternal(parsed.toString());
    }
  } catch {
    // Ignore malformed URLs.
  }
}

function isSameOriginNavigation(urlText) {
  try {
    const parsed = new URL(urlText);
    return parsed.origin === backendUrl;
  } catch {
    return false;
  }
}

function applyNavigationGuards(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrlSafely(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!isSameOriginNavigation(url)) {
      event.preventDefault();
      openExternalUrlSafely(url);
    }
  });
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  applyNavigationGuards(win);
  win.once("ready-to-show", () => {
    win.show();
  });
  void win.loadURL(backendUrl);
  return win;
}

function startBackendServer() {
  return new Promise((resolve, reject) => {
    const expressApp = createApp();
    const server = expressApp.listen(0, "127.0.0.1");

    server.once("error", (error) => {
      reject(error);
    });
    server.once("listening", () => {
      resolve(server);
    });
  });
}

function resolveBackendUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve backend listening port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function bootstrapDesktopApp() {
  backendServer = await startBackendServer();
  backendUrl = resolveBackendUrl(backendServer);
  mainWindow = createMainWindow();
}

async function closeBackendServer() {
  if (!backendServer) {
    return;
  }

  await new Promise((resolve) => {
    backendServer.close(() => {
      resolve();
    });
  });
  backendServer = null;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void closeBackendServer();
});

app.whenReady()
  .then(async () => {
    await bootstrapDesktopApp();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Electron startup failed:", error);
    app.exit(1);
  });
