import path from "node:path";
import fs from "node:fs/promises";
import plist from "plist";
import bplistParser from "bplist-parser";

export async function parsePlistFile(filePath) {
  const exists = await fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return null;
  }

  const data = await fs.readFile(filePath);
  return parsePlistBuffer(data);
}

export function parsePlistBuffer(data) {
  try {
    const parsed = bplistParser.parseBuffer(data);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed[0];
    }
  } catch {
    // Continue and try XML plist parser.
  }

  try {
    return plist.parse(data.toString("utf8"));
  } catch {
    return null;
  }
}

function pickInfoSummary(infoPlist) {
  if (!infoPlist || typeof infoPlist !== "object") {
    return null;
  }

  const keys = [
    "Device Name",
    "Display Name",
    "Product Name",
    "Product Type",
    "Product Version",
    "Unique Identifier",
    "Serial Number",
    "iTunes Version",
    "Last Backup Date",
  ];

  const summary = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(infoPlist, key)) {
      const rawValue = infoPlist[key];
      summary[key] = rawValue instanceof Date ? rawValue.toISOString() : rawValue;
    }
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

export async function loadBackupMetadata(backupPath) {
  const infoPath = path.join(backupPath, "Info.plist");
  const manifestPath = path.join(backupPath, "Manifest.plist");

  const [infoPlist, manifestPlist] = await Promise.all([
    parsePlistFile(infoPath),
    parsePlistFile(manifestPath),
  ]);

  const isEncrypted = Boolean(
    manifestPlist &&
      (manifestPlist.IsEncrypted === true ||
        manifestPlist.IsEncrypted === 1 ||
        String(manifestPlist.IsEncrypted).toLowerCase() === "true"),
  );

  return {
    isEncrypted,
    infoSummary: pickInfoSummary(infoPlist),
  };
}
