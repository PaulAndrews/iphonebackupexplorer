export const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const PREVIEW_PLIST_MAX_BYTES = 16 * 1024 * 1024;
export const PREVIEW_SQLITE_MAX_ROWS_PER_TABLE = 10;
export const PREVIEW_HEADER_SCAN_BYTES = 4100;

export const VIDEO_PREVIEW_EXTENSIONS = new Set([".mp4", ".mov"]);
export const VIDEO_PREVIEW_MIME_TYPES = new Set(["video/mp4", "video/quicktime"]);
export const SQLITE_PREVIEW_EXTENSIONS = new Set([".sqlite3"]);
export const PLIST_PREVIEW_EXTENSIONS = new Set([".plist", ".bplist"]);

export const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);
