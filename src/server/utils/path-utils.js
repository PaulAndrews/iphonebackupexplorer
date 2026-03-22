import path from "node:path";
import fsSync from "node:fs";
import { WINDOWS_RESERVED_NAMES } from "../config/constants.js";

export function normalizePathPart(pathValue) {
  if (pathValue === null || pathValue === undefined) {
    return "";
  }
  const normalized = String(pathValue).replace(/\\/g, "/");
  return normalized.replace(/^\/+|\/+$/g, "");
}

export function sanitizeSegment(segment) {
  let value = String(segment || "").trim();
  if (!value) {
    return "_";
  }

  value = value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  value = value.replace(/[. ]+$/g, "");
  if (!value) {
    value = "_";
  }

  if (WINDOWS_RESERVED_NAMES.has(value.toUpperCase())) {
    value = `_${value}`;
  }

  return value;
}

export function resolveUniqueOutputPath(targetDir, domain, relativePath, usedOutputPaths) {
  const parts = [sanitizeSegment(domain)];
  const relSegments = normalizePathPart(relativePath).split("/").filter(Boolean);

  for (const segment of relSegments) {
    parts.push(sanitizeSegment(segment));
  }

  if (parts.length === 1) {
    parts.push("unnamed_file");
  }

  const destination = path.join(targetDir, ...parts);
  let candidate = destination;
  let counter = 1;

  while (usedOutputPaths.has(candidate) || fsSync.existsSync(candidate)) {
    candidate = appendCounter(destination, counter);
    counter += 1;
  }

  usedOutputPaths.add(candidate);
  return candidate;
}

function appendCounter(filePath, counter) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return path.join(dir, `${base} (${counter})${ext}`);
}
