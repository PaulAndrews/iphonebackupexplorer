import { apiFetch } from "./app/api-client.js";
import { createBackupWorkflow } from "./app/backup-workflow.js";
import { createPreviewController } from "./app/preview-controller.js";
import { createStatusLogger } from "./app/status-log.js";
import { createTreeController } from "./app/tree-controller.js";

const state = {
  tree: [],
  visibleTree: [],
  treeSearchQuery: "",
  treeSearchScope: "directories",
  defaultExportDir: "",
  selected: new Set(),
  activeFileId: null,
  metaByFileId: new Map(),
  fileIdsByFolderId: new Map(),
  visibleFileIdsByFolderId: new Map(),
  viewMode: "apps",
  previewRawMode: false,
  loaded: false,
};

const PREVIEW_DEFAULT_PLACEHOLDER = '<div class="placeholder">Click a file to preview it here.</div>';
const compactLayoutMediaQuery = window.matchMedia("(max-width: 900px)");

const el = {
  loadBackupBtn: document.getElementById("loadBackupBtn"),
  viewMode: document.getElementById("viewMode"),
  metadataTabBtn: document.getElementById("metadataTabBtn"),
  fileTreeTabBtn: document.getElementById("fileTreeTabBtn"),
  metadataTabPanel: document.getElementById("metadataTabPanel"),
  fileTreeTabPanel: document.getElementById("fileTreeTabPanel"),
  statusMessage: document.getElementById("statusMessage"),
  backupMeta: document.getElementById("backupMeta"),
  treeContainer: document.getElementById("treeContainer"),
  treeSearchScope: document.getElementById("treeSearchScope"),
  treeSearch: document.getElementById("treeSearch"),
  clearTreeSearchBtn: document.getElementById("clearTreeSearchBtn"),
  selectAllBtn: document.getElementById("selectAllBtn"),
  clearSelectionBtn: document.getElementById("clearSelectionBtn"),
  selectionSummary: document.getElementById("selectionSummary"),
  previewHeaderActions: document.getElementById("previewHeaderActions"),
  fileMeta: document.getElementById("fileMeta"),
  previewContainer: document.getElementById("previewContainer"),
  targetDir: document.getElementById("targetDir"),
  selectTargetDirBtn: document.getElementById("selectTargetDirBtn"),
  extractBtn: document.getElementById("extractBtn"),
};

const { setStatus } = createStatusLogger(el.statusMessage);

function applyDefaultExportDir(pathValue) {
  const candidate = String(pathValue || "").trim();
  if (!candidate) {
    return;
  }
  state.defaultExportDir = candidate;
  if (!el.targetDir.value.trim()) {
    el.targetDir.value = candidate;
  }
}

function updateClearTreeSearchButtonVisibility() {
  el.clearTreeSearchBtn.hidden = el.treeSearch.value.length === 0;
}

function isPreviewHiddenForLayout() {
  return compactLayoutMediaQuery.matches;
}

function setLeftTab(tabName) {
  const showMetadata = tabName !== "tree";

  el.metadataTabBtn.classList.toggle("active", showMetadata);
  el.fileTreeTabBtn.classList.toggle("active", !showMetadata);
  el.metadataTabBtn.setAttribute("aria-selected", String(showMetadata));
  el.fileTreeTabBtn.setAttribute("aria-selected", String(!showMetadata));

  el.metadataTabPanel.classList.toggle("active", showMetadata);
  el.fileTreeTabPanel.classList.toggle("active", !showMetadata);
}

function getViewLabel(viewMode) {
  const normalized = String(viewMode || "").toLowerCase();
  if (normalized === "raw") {
    return "Raw domains";
  }
  if (normalized === "camera") {
    return "Camera";
  }
  if (normalized === "files") {
    return "Files";
  }
  return "App-centric";
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatSize(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) {
    return "Unknown";
  }
  const value = Number(bytes);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function renderBackupMeta(info, stats, encrypted) {
  if (!info && !stats) {
    el.backupMeta.innerHTML = '<div class="placeholder">No backup metadata loaded.</div>';
    return;
  }

  const rows = [];
  if (stats) {
    rows.push(["Files", String(stats.totalFiles || 0)]);
    rows.push(["Domains", String(stats.domains || 0)]);
    rows.push(["Folders", String(stats.totalFolders || 0)]);
  }

  if (info) {
    for (const [key, value] of Object.entries(info)) {
      rows.push([key, String(value)]);
    }
  }

  if (encrypted) {
    rows.push([
      "Encrypted Backup",
      "Yes (file content may not be viewable without decryption support).",
    ]);
  }

  if (rows.length === 0) {
    el.backupMeta.innerHTML = '<div class="placeholder">No backup metadata loaded.</div>';
    return;
  }

  const tableRows = rows
    .map(
      ([key, value]) =>
        `<tr><td class="key">${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`,
    )
    .join("");

  el.backupMeta.innerHTML = `<table>${tableRows}</table>`;
}

const previewController = createPreviewController({
  state,
  el,
  apiFetch,
  formatSize,
  escapeHtml,
  isPreviewHiddenForLayout,
  defaultPlaceholderHtml: PREVIEW_DEFAULT_PLACEHOLDER,
});

const treeController = createTreeController({
  state,
  el,
  onFileOpenPreview: (fileId) => {
    previewController.openPreview(fileId);
  },
});

const backupWorkflow = createBackupWorkflow({
  state,
  el,
  apiFetch,
  setStatus,
  applyDefaultExportDir,
  renderBackupMeta,
  getViewLabel,
  treeController,
  previewController,
});

el.loadBackupBtn.addEventListener("click", backupWorkflow.openBackup);
el.metadataTabBtn.addEventListener("click", () => {
  setLeftTab("metadata");
});
el.fileTreeTabBtn.addEventListener("click", () => {
  setLeftTab("tree");
});
el.viewMode.addEventListener("change", () => {
  state.viewMode = el.viewMode.value;
  backupWorkflow.refreshTreeView();
});
el.treeSearchScope.addEventListener("change", () => {
  treeController.applySearchScope(el.treeSearchScope.value, el.treeSearch.value);
});
el.treeSearch.addEventListener("input", () => {
  updateClearTreeSearchButtonVisibility();
  treeController.queueTreeSearch(el.treeSearch.value);
});
el.clearTreeSearchBtn.addEventListener("click", () => {
  el.treeSearch.value = "";
  treeController.clearSearch();
  updateClearTreeSearchButtonVisibility();
  el.treeSearch.focus();
});
el.selectAllBtn.addEventListener("click", () => {
  treeController.selectAll();
});
el.clearSelectionBtn.addEventListener("click", () => {
  treeController.clearSelection();
});
el.selectTargetDirBtn.addEventListener("click", backupWorkflow.selectExportFolder);
el.extractBtn.addEventListener("click", backupWorkflow.extractSelected);

el.targetDir.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    backupWorkflow.extractSelected();
  }
});

setLeftTab("metadata");
el.treeSearchScope.value = state.treeSearchScope;
previewController.clearPreviewHeaderActions();
updateClearTreeSearchButtonVisibility();
backupWorkflow.loadInitialState();
