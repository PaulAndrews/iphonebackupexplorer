import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { BackupIndex } from "../domain/backup-index.js";
import { loadBackupMetadata, parsePlistBuffer } from "../services/plist-service.js";
import {
  getDefaultBackupBasePath,
  getDefaultExportDir,
  openWindowsFolderPicker,
  resolveExistingDirectory,
} from "../services/folder-picker-service.js";
import {
  bufferToTextPreview,
  isLikelyBinaryPlist,
  makeJsonSafe,
  readPartialFile,
  readSqlitePreview,
} from "../services/preview-service.js";
import {
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_PLIST_MAX_BYTES,
  PREVIEW_SQLITE_MAX_ROWS_PER_TABLE,
} from "../config/constants.js";

async function getEntryMetaOrRespond(backup, res, entryId, { requireSourcePath = false } = {}) {
  const meta = await backup.index.getEntryMeta(entryId);
  if (!meta) {
    res.status(404).json({ error: "File entry not found." });
    return null;
  }

  if (requireSourcePath && !meta.sourcePath) {
    res.status(404).json({
      error: "The backup file for this entry was not found on disk.",
    });
    return null;
  }

  return meta;
}

export function registerApiRoutes(app, { backupSession }) {
  app.get("/api/state", (req, res) => {
    const defaultExportDir = getDefaultExportDir();
    const activeBackup = backupSession.get();
    if (!activeBackup) {
      res.json({
        loaded: false,
        defaultExportDir,
      });
      return;
    }

    res.json({
      loaded: true,
      defaultExportDir,
      backupPath: activeBackup.backupPath,
      stats: activeBackup.index.getStats(),
      isEncrypted: activeBackup.metadata?.isEncrypted || false,
      info: activeBackup.metadata?.infoSummary || null,
    });
  });

  app.post("/api/select-backup-folder", async (req, res) => {
    if (process.platform !== "win32") {
      res.status(400).json({
        error: "Folder picker is only supported on Windows.",
      });
      return;
    }

    try {
      const defaultPath = getDefaultBackupBasePath();
      const backupPath = await openWindowsFolderPicker({
        defaultPath,
        fallbackPath: defaultPath,
        description: "Select iTunes backup folder",
        showNewFolderButton: false,
      });
      res.json({
        backupPath,
        defaultPath,
        cancelled: !backupPath,
      });
    } catch (error) {
      res.status(500).json({
        error: error.message || "Failed to open backup folder picker.",
      });
    }
  });

  app.post("/api/select-export-folder", async (req, res) => {
    if (process.platform !== "win32") {
      res.status(400).json({
        error: "Folder picker is only supported on Windows.",
      });
      return;
    }

    try {
      const fallbackPath = getDefaultExportDir();
      const requestedPath =
        typeof req.body?.defaultPath === "string" ? req.body.defaultPath.trim() : "";
      const defaultPath = resolveExistingDirectory(requestedPath || fallbackPath, fallbackPath);
      const targetDir = await openWindowsFolderPicker({
        defaultPath,
        fallbackPath,
        description: "Select export folder",
        showNewFolderButton: true,
      });
      res.json({
        targetDir,
        defaultPath,
        cancelled: !targetDir,
      });
    } catch (error) {
      res.status(500).json({
        error: error.message || "Failed to open export folder picker.",
      });
    }
  });

  app.post("/api/open-backup", async (req, res) => {
    const backupPath = typeof req.body?.backupPath === "string" ? req.body.backupPath : "";
    const viewMode = typeof req.body?.view === "string" ? req.body.view : "apps";
    if (!backupPath.trim()) {
      res.status(400).json({ error: "backupPath is required." });
      return;
    }

    const resolvedPath = path.resolve(backupPath.trim());
    const index = new BackupIndex(resolvedPath);

    try {
      await index.load();
      const metadata = await loadBackupMetadata(resolvedPath);

      backupSession.set({
        backupPath: resolvedPath,
        index,
        metadata,
      });

      res.json({
        backupPath: resolvedPath,
        stats: index.getStats(),
        tree: index.getTree(viewMode),
        view: viewMode,
        defaultExportDir: getDefaultExportDir(),
        isEncrypted: metadata.isEncrypted,
        info: metadata.infoSummary,
      });
    } catch (error) {
      res.status(400).json({
        error: error.message || "Failed to open backup folder.",
      });
    }
  });

  app.get("/api/tree", (req, res) => {
    const backup = backupSession.getLoadedOrRespond(res);
    if (!backup) {
      return;
    }
    const viewMode = typeof req.query?.view === "string" ? req.query.view : "apps";

    res.json({
      tree: backup.index.getTree(viewMode),
      view: viewMode,
      stats: backup.index.getStats(),
      backupPath: backup.backupPath,
      isEncrypted: backup.metadata?.isEncrypted || false,
      info: backup.metadata?.infoSummary || null,
    });
  });

  app.get("/api/files/:entryId/meta", async (req, res) => {
    const backup = backupSession.getLoadedOrRespond(res);
    if (!backup) {
      return;
    }

    const meta = await getEntryMetaOrRespond(backup, res, req.params.entryId);
    if (!meta) {
      return;
    }
    res.json(meta);
  });

  app.get("/api/files/:entryId/preview", async (req, res) => {
    const backup = backupSession.getLoadedOrRespond(res);
    if (!backup) {
      return;
    }

    const meta = await getEntryMetaOrRespond(backup, res, req.params.entryId, {
      requireSourcePath: true,
    });
    if (!meta) {
      return;
    }

    const rawQueryValue = String(req.query?.raw || "").toLowerCase();
    const forceRawText = rawQueryValue === "1" || rawQueryValue === "true";

    if (!forceRawText && meta.previewKind === "sqlite") {
      try {
        const sqlitePreview = await readSqlitePreview(meta.sourcePath, PREVIEW_SQLITE_MAX_ROWS_PER_TABLE);
        res.json({
          mode: "sqlite",
          format: "sqlite",
          truncated: false,
          byteLength: null,
          rowLimit: sqlitePreview.rowLimit,
          tableCount: sqlitePreview.tables.length,
          tables: sqlitePreview.tables,
        });
        return;
      } catch {
        // Not a readable SQLite database; continue with other preview fallbacks.
      }
    }

    if (!forceRawText && meta.previewKind === "plist") {
      const full = await readPartialFile(meta.sourcePath, PREVIEW_PLIST_MAX_BYTES);
      if (full.truncated) {
        res.json({
          mode: "text",
          format: "text",
          truncated: true,
          byteLength: full.totalSize,
          content:
            "File is too large for plist parsing preview; showing the first part as text.\n\n" +
            bufferToTextPreview(full.data),
        });
        return;
      }

      const plistParsed = parsePlistBuffer(full.data);
      if (plistParsed !== null) {
        res.json({
          mode: "plist",
          format: isLikelyBinaryPlist(full.data) ? "binary-plist" : "xml-plist",
          truncated: false,
          byteLength: full.totalSize,
          content: JSON.stringify(makeJsonSafe(plistParsed), null, 2),
        });
        return;
      }
    }

    const partial = await readPartialFile(meta.sourcePath, PREVIEW_TEXT_MAX_BYTES);
    let textContent = bufferToTextPreview(partial.data);
    if (partial.truncated) {
      textContent += `\n\n--- Preview truncated at ${PREVIEW_TEXT_MAX_BYTES} bytes (file size: ${partial.totalSize} bytes). ---`;
    }

    res.json({
      mode: "text",
      format: forceRawText ? "raw" : "text",
      forcedRaw: forceRawText,
      truncated: partial.truncated,
      byteLength: partial.totalSize,
      content: textContent,
    });
  });

  app.get("/api/files/:entryId/content", async (req, res) => {
    const backup = backupSession.getLoadedOrRespond(res);
    if (!backup) {
      return;
    }

    const meta = await getEntryMetaOrRespond(backup, res, req.params.entryId, {
      requireSourcePath: true,
    });
    if (!meta) {
      return;
    }

    const fileName = path.basename(meta.relativePath || meta.fileID || "file");
    const dispositionType = req.query.download === "1" ? "attachment" : "inline";
    const stat = await fs.stat(meta.sourcePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      res.status(404).json({
        error: "The backup file for this entry was not found on disk.",
      });
      return;
    }

    const totalSize = Number(stat.size || 0);
    const rangeHeader = typeof req.headers.range === "string" ? req.headers.range.trim() : "";
    const hasByteRange = /^bytes=\d*-\d*$/.test(rangeHeader);

    res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader(
      "Content-Disposition",
      `${dispositionType}; filename="${encodeURIComponent(fileName)}"`,
    );

    let streamStart = 0;
    let streamEnd = totalSize > 0 ? totalSize - 1 : 0;

    if (hasByteRange && totalSize > 0) {
      const [rawStart, rawEnd] = rangeHeader.replace(/^bytes=/, "").split("-");

      if (rawStart === "" && rawEnd === "") {
        res.status(416);
        res.setHeader("Content-Range", `bytes */${totalSize}`);
        res.end();
        return;
      }

      if (rawStart === "") {
        const suffixLength = Number.parseInt(rawEnd, 10);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
          res.status(416);
          res.setHeader("Content-Range", `bytes */${totalSize}`);
          res.end();
          return;
        }
        streamStart = Math.max(totalSize - suffixLength, 0);
        streamEnd = totalSize - 1;
      } else {
        streamStart = Number.parseInt(rawStart, 10);
        streamEnd = rawEnd ? Number.parseInt(rawEnd, 10) : totalSize - 1;
      }

      if (
        !Number.isFinite(streamStart) ||
        !Number.isFinite(streamEnd) ||
        streamStart < 0 ||
        streamStart > streamEnd ||
        streamEnd >= totalSize
      ) {
        res.status(416);
        res.setHeader("Content-Range", `bytes */${totalSize}`);
        res.end();
        return;
      }

      const chunkSize = streamEnd - streamStart + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${streamStart}-${streamEnd}/${totalSize}`);
      res.setHeader("Content-Length", String(chunkSize));
    } else {
      res.setHeader("Content-Length", String(totalSize));
    }

    const stream =
      hasByteRange && totalSize > 0
        ? fsSync.createReadStream(meta.sourcePath, { start: streamStart, end: streamEnd })
        : fsSync.createReadStream(meta.sourcePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream file content." });
      }
    });
    stream.pipe(res);
  });

  app.post("/api/extract", async (req, res) => {
    const backup = backupSession.getLoadedOrRespond(res);
    if (!backup) {
      return;
    }

    const targetDir = typeof req.body?.targetDir === "string" ? req.body.targetDir : "";
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];

    if (!targetDir.trim()) {
      res.status(400).json({ error: "targetDir is required." });
      return;
    }
    if (fileIds.length === 0) {
      res.status(400).json({ error: "fileIds must contain at least one entry id." });
      return;
    }

    const result = await backup.index.extract(fileIds, targetDir);
    res.json(result);
  });
}
