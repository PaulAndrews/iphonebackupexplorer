import { pruneEmptyFolders } from "./tree-helpers.js";

export function createBackupWorkflow({
  state,
  el,
  apiFetch,
  setStatus,
  applyDefaultExportDir,
  renderBackupMeta,
  getViewLabel,
  treeController,
  previewController,
}) {
  async function openBackupAtPath(backupPath) {
    setStatus(`Opening backup: ${backupPath}`);
    previewController.clearActivePreviewSelection();

    try {
      const data = await apiFetch("/api/open-backup", {
        method: "POST",
        body: JSON.stringify({ backupPath, view: state.viewMode }),
      });

      applyDefaultExportDir(data.defaultExportDir);
      treeController.setTree(pruneEmptyFolders(data.tree || []));
      state.selected.clear();
      state.activeFileId = null;
      state.metaByFileId.clear();
      state.viewMode = data.view || state.viewMode;
      el.viewMode.value = state.viewMode;
      state.loaded = true;

      treeController.renderTree();
      renderBackupMeta(data.info, data.stats, data.isEncrypted);

      const warning = data.isEncrypted
        ? " Backup is encrypted; preview/export of encrypted content may fail."
        : "";
      setStatus(
        `Loaded ${data.stats.totalFiles} files from ${data.backupPath} (${getViewLabel(state.viewMode)}).${warning}`,
      );
    } catch (error) {
      treeController.setTree([]);
      state.selected.clear();
      state.activeFileId = null;
      state.loaded = false;
      treeController.renderTree();
      renderBackupMeta(null, null, false);
      previewController.clearActivePreviewSelection();
      setStatus(error.message, true);
    }
  }

  async function selectBackupFolder() {
    const response = await apiFetch("/api/select-backup-folder", {
      method: "POST",
    });
    return response.backupPath || null;
  }

  async function openBackup() {
    try {
      setStatus("Opening backup folder picker...");
      const backupPath = await selectBackupFolder();
      if (!backupPath) {
        const retainedLabel = state.loaded ? " Current backup remains loaded." : "";
        setStatus(`Backup selection cancelled.${retainedLabel}`);
        return;
      }

      setStatus(`Selected backup folder: ${backupPath}`);
      await openBackupAtPath(backupPath);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function selectExportFolder() {
    try {
      setStatus("Opening export folder picker...");
      const defaultPath = el.targetDir.value.trim() || state.defaultExportDir;
      const response = await apiFetch("/api/select-export-folder", {
        method: "POST",
        body: JSON.stringify({ defaultPath }),
      });

      if (!response.targetDir) {
        const retained = el.targetDir.value.trim();
        const retainedLabel = retained ? ` Current target remains ${retained}.` : "";
        setStatus(`Export folder selection cancelled.${retainedLabel}`);
        return;
      }

      el.targetDir.value = response.targetDir;
      setStatus(`Selected export folder: ${response.targetDir}`);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function refreshTreeView() {
    if (!state.loaded) {
      setStatus("Open a backup first, then switch tree view.", true);
      return;
    }

    setStatus(`Refreshing ${getViewLabel(state.viewMode)} tree...`);
    treeController.renderTreeLoadingPlaceholder();
    try {
      const data = await apiFetch(`/api/tree?view=${encodeURIComponent(state.viewMode)}`);
      treeController.setTree(pruneEmptyFolders(data.tree || []));
      state.activeFileId = null;
      state.metaByFileId.clear();
      treeController.renderTree();
      setStatus(
        `Loaded ${data.stats.totalFiles} files from ${data.backupPath} (${getViewLabel(state.viewMode)}).`,
      );
    } catch (error) {
      treeController.renderTree();
      setStatus(error.message, true);
    }
  }

  async function extractSelected() {
    if (!state.loaded) {
      setStatus("Open a backup before extraction.", true);
      return;
    }
    if (state.selected.size === 0) {
      setStatus("Select one or more files to extract.", true);
      return;
    }

    const targetDir = el.targetDir.value.trim();
    if (!targetDir) {
      setStatus("Enter a target folder path.", true);
      return;
    }

    setStatus(`Extracting ${state.selected.size} files to ${targetDir}...`);
    try {
      const result = await apiFetch("/api/extract", {
        method: "POST",
        body: JSON.stringify({
          targetDir,
          fileIds: Array.from(state.selected),
        }),
      });

      const hasIssues = result.missingCount > 0 || result.failedCount > 0 || result.invalidCount > 0;
      setStatus(
        `Exported ${result.exportedCount}/${result.requestedCount}. Missing: ${result.missingCount}, Failed: ${result.failedCount}, Invalid: ${result.invalidCount}. Output: ${result.targetDir}`,
        hasIssues,
      );

      if (Array.isArray(result.missingSamples) && result.missingSamples.length > 0) {
        setStatus(`Missing files:\n${result.missingSamples.join("\n")}`, true);
      }
      if (Array.isArray(result.failedSamples) && result.failedSamples.length > 0) {
        const failedLines = result.failedSamples.map(
          (item) => `${item.path || "Unknown path"}${item.error ? ` - ${item.error}` : ""}`,
        );
        setStatus(`Failed files:\n${failedLines.join("\n")}`, true);
      }
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function loadInitialState() {
    try {
      const stateResponse = await apiFetch("/api/state");
      applyDefaultExportDir(stateResponse.defaultExportDir);
      if (!stateResponse.loaded) {
        setStatus("No backup loaded.");
        return;
      }

      const treeResponse = await apiFetch(`/api/tree?view=${encodeURIComponent(state.viewMode)}`);
      treeController.setTree(pruneEmptyFolders(treeResponse.tree || []));
      state.viewMode = treeResponse.view || state.viewMode;
      el.viewMode.value = state.viewMode;
      state.loaded = true;
      treeController.renderTree();
      renderBackupMeta(treeResponse.info, treeResponse.stats, treeResponse.isEncrypted);
      setStatus(
        `Loaded ${treeResponse.stats.totalFiles} files from ${treeResponse.backupPath} (${getViewLabel(state.viewMode)}).`,
      );
    } catch {
      setStatus("No backup loaded.");
    }
  }

  return {
    openBackup,
    selectExportFolder,
    refreshTreeView,
    extractSelected,
    loadInitialState,
  };
}
