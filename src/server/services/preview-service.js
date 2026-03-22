import path from "node:path";
import fs from "node:fs/promises";
import mime from "mime-types";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { fileTypeFromBuffer } from "file-type";
import {
  PREVIEW_HEADER_SCAN_BYTES,
  PREVIEW_SQLITE_MAX_ROWS_PER_TABLE,
  SQLITE_PREVIEW_EXTENSIONS,
  PLIST_PREVIEW_EXTENSIONS,
  VIDEO_PREVIEW_EXTENSIONS,
  VIDEO_PREVIEW_MIME_TYPES,
} from "../config/constants.js";

export async function analyzePreviewForEntry(relativePath, sourcePath) {
  const ext = path.extname(String(relativePath || "")).toLowerCase();
  const fallbackMimeType = String(mime.lookup(relativePath) || "application/octet-stream").toLowerCase();
  const header = sourcePath ? await readPartialFile(sourcePath, PREVIEW_HEADER_SCAN_BYTES).catch(() => null) : null;
  const headerData = header ? header.data : null;
  const signatures = detectPreviewSignatures(headerData);
  const detectedType = await detectFileType(headerData);
  const detectedExt = detectedType?.ext ? `.${String(detectedType.ext).toLowerCase()}` : "";
  const detectedMimeType = String(detectedType?.mime || "").toLowerCase();
  const mimeType = resolvePreviewMimeType(fallbackMimeType, detectedMimeType, signatures);

  return {
    mimeType,
    previewKind: resolvePreviewKind({
      ext,
      mimeType,
      detectedExt,
      detectedMimeType,
      signatures,
    }),
  };
}

async function detectFileType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return null;
  }
  try {
    return await fileTypeFromBuffer(buffer);
  } catch {
    return null;
  }
}

function resolvePreviewMimeType(fallbackMimeType, detectedMimeType, signatures) {
  if (detectedMimeType) {
    return detectedMimeType;
  }
  if (signatures.jpeg) {
    return "image/jpeg";
  }
  if (signatures.binaryPlist) {
    return "application/x-plist";
  }
  if (signatures.sqlite) {
    return "application/vnd.sqlite3";
  }
  return fallbackMimeType;
}

function resolvePreviewKind({ ext, mimeType, detectedExt, detectedMimeType, signatures }) {
  if (
    signatures.sqlite ||
    SQLITE_PREVIEW_EXTENSIONS.has(ext) ||
    (detectedExt && SQLITE_PREVIEW_EXTENSIONS.has(detectedExt))
  ) {
    return "sqlite";
  }
  if (
    signatures.binaryPlist ||
    PLIST_PREVIEW_EXTENSIONS.has(ext) ||
    (detectedExt && PLIST_PREVIEW_EXTENSIONS.has(detectedExt))
  ) {
    return "plist";
  }
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType === "application/pdf") {
    return "pdf";
  }
  if (detectedMimeType.startsWith("video/")) {
    return "video";
  }
  if (isVideoPreviewCandidate(ext, mimeType) && signatures.isoBmffVideo) {
    return "video";
  }
  return "text";
}

function detectPreviewSignatures(buffer) {
  return {
    jpeg: isLikelyJpegImage(buffer),
    binaryPlist: isLikelyBinaryPlist(buffer),
    sqlite: isLikelySqliteDatabase(buffer),
    isoBmffVideo: isLikelyIsoBmffVideo(buffer),
  };
}

function isVideoPreviewCandidate(ext, mimeType) {
  return VIDEO_PREVIEW_EXTENSIONS.has(ext) || VIDEO_PREVIEW_MIME_TYPES.has(mimeType);
}

export async function readPartialFile(filePath, maxBytes) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const totalSize = stat.size;
    const bytesToRead = Math.min(totalSize, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    return {
      data: buffer.subarray(0, bytesRead),
      totalSize,
      truncated: totalSize > maxBytes,
    };
  } finally {
    await handle.close();
  }
}

export function isLikelyBinaryPlist(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6) {
    return false;
  }
  return buffer.subarray(0, 6).toString("ascii") === "bplist";
}

function isLikelyJpegImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) {
    return false;
  }
  return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isLikelySqliteDatabase(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    return false;
  }
  return buffer.subarray(0, 16).toString("ascii") === "SQLite format 3\0";
}

function isLikelyIsoBmffVideo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    return false;
  }

  const scanLimit = Math.min(buffer.length, PREVIEW_HEADER_SCAN_BYTES);
  let offset = 0;
  let inspectedBoxes = 0;

  while (offset + 8 <= scanLimit && inspectedBoxes < 8) {
    const boxType = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const size32 = buffer.readUInt32BE(offset);
    let boxHeaderSize = 8;
    let boxSize = size32;

    if (size32 === 1) {
      if (offset + 16 > scanLimit) {
        return false;
      }
      boxSize = Number(buffer.readBigUInt64BE(offset + 8));
      boxHeaderSize = 16;
    } else if (size32 === 0) {
      boxSize = scanLimit - offset;
    }

    if (!Number.isFinite(boxSize) || boxSize < boxHeaderSize) {
      return false;
    }

    if (boxType === "ftyp") {
      const majorBrandOffset = offset + boxHeaderSize;
      if (majorBrandOffset + 4 > scanLimit) {
        return false;
      }
      const majorBrand = buffer.subarray(majorBrandOffset, majorBrandOffset + 4).toString("ascii");
      return isLikelyFourCc(majorBrand);
    }

    if (boxSize <= 0) {
      return false;
    }
    offset += boxSize;
    inspectedBoxes += 1;
  }

  return false;
}

function isLikelyFourCc(value) {
  if (typeof value !== "string" || value.length !== 4) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const charCode = value.charCodeAt(i);
    if (charCode < 0x20 || charCode > 0x7e) {
      return false;
    }
  }
  return true;
}

function escapeSqliteIdentifier(identifier) {
  return String(identifier || "").replace(/"/g, '""');
}

export async function readSqlitePreview(filePath, maxRowsPerTable = PREVIEW_SQLITE_MAX_ROWS_PER_TABLE) {
  const db = await open({
    filename: filePath,
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READONLY,
  });

  try {
    const tableRows = await db.all(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `);

    const tables = [];
    for (const row of tableRows) {
      const tableName = String(row?.name || "");
      if (!tableName || tableName.startsWith("sqlite_")) {
        continue;
      }

      const escapedTableName = escapeSqliteIdentifier(tableName);
      const tableInfo = await db.all(`PRAGMA table_info("${escapedTableName}")`);
      let columns = tableInfo.map((item) => String(item?.name || "")).filter(Boolean);

      const rawRows = await db.all(`SELECT * FROM "${escapedTableName}" LIMIT ${Number(maxRowsPerTable)}`);
      if (columns.length === 0 && rawRows.length > 0) {
        columns = Object.keys(rawRows[0]);
      }

      const rows = rawRows.map((record) => {
        const cells = {};
        for (const columnName of columns) {
          cells[columnName] = makeJsonSafe(record[columnName]);
        }
        return cells;
      });

      tables.push({
        name: tableName,
        columns,
        rows,
      });
    }

    return {
      rowLimit: Number(maxRowsPerTable),
      tables,
    };
  } finally {
    await db.close();
  }
}

export function makeJsonSafe(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }
  if (depth > 25) {
    return "[Max depth reached]";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    if (value.length <= 64) {
      return {
        type: "Buffer",
        length: value.length,
        base64: value.toString("base64"),
      };
    }
    return {
      type: "Buffer",
      length: value.length,
      base64: `${value.subarray(0, 64).toString("base64")}...`,
      truncated: true,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => makeJsonSafe(item, depth + 1));
  }
  if (typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = makeJsonSafe(nested, depth + 1);
    }
    return output;
  }
  return value;
}

export function bufferToTextPreview(buffer) {
  return buffer.toString("utf8").replace(/\u0000/g, "\\0");
}
