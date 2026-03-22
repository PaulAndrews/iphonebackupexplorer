import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { registerApiRoutes } from "./routes/api-routes.js";
import { createBackupSessionStore } from "./state/backup-session-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../../public");

function isLoopbackAddress(remoteAddress) {
  const value = String(remoteAddress || "").trim().toLowerCase();
  return (
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1"
  );
}

export function createApp() {
  const app = express();
  const backupSession = createBackupSessionStore();

  app.use(express.json({ limit: "10mb" }));
  app.use((req, res, next) => {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      res.status(403).json({
        error: "Local access only. This app accepts requests from localhost only.",
      });
      return;
    }
    next();
  });
  app.use(express.static(publicDir));

  registerApiRoutes(app, { backupSession });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(500).json({
      error: error?.message || "Unexpected server error",
    });
  });

  return app;
}
