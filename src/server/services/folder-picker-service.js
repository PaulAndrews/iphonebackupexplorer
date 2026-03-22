import path from "node:path";
import os from "node:os";
import fsSync from "node:fs";
import { spawn } from "node:child_process";

function isDirectory(candidatePath) {
  try {
    return fsSync.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

export function getDefaultBackupBasePath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const backupRoot = path.join(appData, "Apple Computer", "MobileSync", "Backup");
  if (isDirectory(backupRoot)) {
    return backupRoot;
  }
  return isDirectory(appData) ? appData : os.homedir();
}

export function getDefaultExportDir() {
  const downloadsPath = path.join(os.homedir(), "Downloads");
  if (isDirectory(downloadsPath)) {
    return downloadsPath;
  }
  return os.homedir();
}

function escapePowerShellString(text) {
  return String(text || "").replace(/'/g, "''");
}

export function resolveExistingDirectory(candidatePath, fallbackPath) {
  const fallbackResolved = path.resolve(String(fallbackPath || os.homedir()));
  const candidateResolved = path.resolve(String(candidatePath || fallbackResolved));
  if (isDirectory(candidateResolved)) {
    return candidateResolved;
  }
  return isDirectory(fallbackResolved) ? fallbackResolved : os.homedir();
}

export function openWindowsFolderPicker(options = {}) {
  return new Promise((resolve, reject) => {
    const fallbackPath = String(options.fallbackPath || os.homedir());
    const selectedPath = resolveExistingDirectory(options.defaultPath, fallbackPath);
    const description = String(options.description || "Select folder");
    const showNewFolderButton = options.showNewFolderButton !== false;
    const safeDefaultPath = escapePowerShellString(selectedPath);
    const safeDescription = escapePowerShellString(description);
    const showNewFolderFlag = showNewFolderButton ? "$true" : "$false";
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$dialog.Description = '${safeDescription}'`,
      `$dialog.ShowNewFolderButton = ${showNewFolderFlag}`,
      `$dialog.SelectedPath = '${safeDefaultPath}'`,
      "$result = $dialog.ShowDialog()",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "  Write-Output $dialog.SelectedPath",
      "}",
    ].join("; ");

    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to launch folder picker: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || `exit code ${code}`;
        reject(new Error(`Folder picker failed: ${detail}`));
        return;
      }

      const selected = stdout.trim();
      resolve(selected || null);
    });
  });
}
