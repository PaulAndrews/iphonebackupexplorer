import {
  buildFolderFileIdMap,
  collectAllFileIds,
  getVisibleTree,
} from "./tree-helpers.js";

const EMPTY_TREE_PLACEHOLDER_HTML =
  '<div class="placeholder">No files to show. Open a backup folder first.</div>';
const TREE_LOADING_PLACEHOLDER_HTML = '<div class="placeholder">Loading tree view...</div>';
const TREE_SEARCH_DEBOUNCE_MS = 400;

export function createTreeController({ state, el, onFileOpenPreview }) {
  let treeSearchDebounceTimer = null;
  let pendingTreeSearchQuery = "";
  let treeRenderScheduled = false;

  function setTree(nodes) {
    state.tree = Array.isArray(nodes) ? nodes : [];
    state.fileIdsByFolderId = buildFolderFileIdMap(state.tree);
    state.visibleFileIdsByFolderId = new Map();
  }

  function getSelectableFolderFileIds(folderId) {
    if (state.visibleFileIdsByFolderId.has(folderId)) {
      return state.visibleFileIdsByFolderId.get(folderId) || [];
    }
    return state.fileIdsByFolderId.get(folderId) || [];
  }

  function updateSelectionSummary() {
    el.selectionSummary.textContent = `Selected: ${state.selected.size}`;
  }

  function getFolderSelectionState(folderId) {
    const descendantFileIds = getSelectableFolderFileIds(folderId);
    if (descendantFileIds.length === 0) {
      return {
        checked: false,
        indeterminate: false,
        disabled: true,
        descendantFileIds,
      };
    }

    let selectedCount = 0;
    for (const fileId of descendantFileIds) {
      if (state.selected.has(fileId)) {
        selectedCount += 1;
      }
    }

    return {
      checked: selectedCount === descendantFileIds.length,
      indeterminate: selectedCount > 0 && selectedCount < descendantFileIds.length,
      disabled: false,
      descendantFileIds,
    };
  }

  function syncTreeSelectionStates() {
    const fileCheckboxes = el.treeContainer.querySelectorAll('input[type="checkbox"][data-file-ref-id]');
    for (const checkbox of fileCheckboxes) {
      const fileRefId = checkbox.dataset.fileRefId;
      checkbox.checked = state.selected.has(fileRefId);
    }

    const folderCheckboxes = el.treeContainer.querySelectorAll('input[type="checkbox"][data-folder-id]');
    for (const checkbox of folderCheckboxes) {
      const folderId = checkbox.dataset.folderId;
      const selectionState = getFolderSelectionState(folderId);
      checkbox.checked = selectionState.checked;
      checkbox.indeterminate = selectionState.indeterminate;
      checkbox.disabled = selectionState.disabled;
    }

    updateSelectionSummary();
  }

  function createFolderNodeElement(node, depth) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "folder-row";

    const details = document.createElement("details");
    details.className = "folder";
    details.open = state.treeSearchQuery.trim() ? true : depth < 1;

    const summary = document.createElement("summary");
    const folderSelectionState = getFolderSelectionState(node.id);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.folderId = String(node.id);
    checkbox.checked = folderSelectionState.checked;
    checkbox.indeterminate = folderSelectionState.indeterminate;
    checkbox.disabled = folderSelectionState.disabled;
    checkbox.addEventListener("change", () => {
      const descendantFileIds = getSelectableFolderFileIds(node.id);
      if (checkbox.checked) {
        for (const fileId of descendantFileIds) {
          state.selected.add(fileId);
        }
      } else {
        for (const fileId of descendantFileIds) {
          state.selected.delete(fileId);
        }
      }
      syncTreeSelectionStates();
    });

    summary.textContent = node.name;
    details.appendChild(summary);

    const list = document.createElement("ul");
    for (const child of node.children || []) {
      list.appendChild(createTreeNodeElement(child, depth + 1));
    }

    details.appendChild(list);
    row.appendChild(checkbox);
    row.appendChild(details);
    li.appendChild(row);
    return li;
  }

  function createFileNodeElement(node) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "file-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.fileRefId = String(node.fileRefId);
    checkbox.checked = state.selected.has(node.fileRefId);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selected.add(node.fileRefId);
      } else {
        state.selected.delete(node.fileRefId);
      }
      syncTreeSelectionStates();
    });

    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-button";
    button.textContent = node.name;
    button.dataset.fileRefId = String(node.fileRefId);
    if (state.activeFileId === node.fileRefId) {
      button.classList.add("active");
    }

    button.addEventListener("click", () => {
      onFileOpenPreview(node.fileRefId);
    });

    row.appendChild(checkbox);
    row.appendChild(button);
    li.appendChild(row);
    return li;
  }

  function createTreeNodeElement(node, depth) {
    if (node.type === "folder") {
      return createFolderNodeElement(node, depth);
    }
    return createFileNodeElement(node);
  }

  function renderTree() {
    if (!state.loaded || !state.tree.length) {
      state.visibleTree = [];
      state.visibleFileIdsByFolderId = new Map();
      el.treeContainer.innerHTML = EMPTY_TREE_PLACEHOLDER_HTML;
      updateSelectionSummary();
      return;
    }

    const visibleTree = getVisibleTree(state.tree, state.treeSearchQuery, state.treeSearchScope);
    state.visibleTree = visibleTree;
    state.visibleFileIdsByFolderId = buildFolderFileIdMap(visibleTree);

    if (visibleTree.length === 0) {
      const searchTarget =
        state.treeSearchScope === "all" ? "directory or file names" : "directory names";
      el.treeContainer.innerHTML =
        `<div class="placeholder">No ${searchTarget} matched your search. Try a shorter or different term.</div>`;
      updateSelectionSummary();
      return;
    }

    const list = document.createElement("ul");
    list.className = "tree-root";
    for (const node of visibleTree) {
      list.appendChild(createTreeNodeElement(node, 0));
    }

    el.treeContainer.innerHTML = "";
    el.treeContainer.appendChild(list);
    syncTreeSelectionStates();
  }

  function renderTreeLoadingPlaceholder() {
    state.visibleTree = [];
    state.visibleFileIdsByFolderId = new Map();
    el.treeContainer.innerHTML = TREE_LOADING_PLACEHOLDER_HTML;
    updateSelectionSummary();
  }

  function scheduleRenderTree() {
    if (treeRenderScheduled) {
      return;
    }
    treeRenderScheduled = true;
    window.requestAnimationFrame(() => {
      treeRenderScheduled = false;
      renderTree();
    });
  }

  function queueTreeSearch(query) {
    pendingTreeSearchQuery = String(query ?? "");
    if (treeSearchDebounceTimer) {
      window.clearTimeout(treeSearchDebounceTimer);
    }
    treeSearchDebounceTimer = window.setTimeout(() => {
      treeSearchDebounceTimer = null;
      state.treeSearchQuery = pendingTreeSearchQuery;
      scheduleRenderTree();
    }, TREE_SEARCH_DEBOUNCE_MS);
  }

  function cancelQueuedTreeSearch() {
    if (!treeSearchDebounceTimer) {
      return;
    }
    window.clearTimeout(treeSearchDebounceTimer);
    treeSearchDebounceTimer = null;
  }

  function applySearchScope(scopeValue, queryValue) {
    state.treeSearchScope = scopeValue === "all" ? "all" : "directories";
    cancelQueuedTreeSearch();
    state.treeSearchQuery = String(queryValue ?? "");
    scheduleRenderTree();
  }

  function clearSearch() {
    cancelQueuedTreeSearch();
    pendingTreeSearchQuery = "";
    state.treeSearchQuery = "";
    scheduleRenderTree();
  }

  function selectAll() {
    if (!state.loaded) {
      return;
    }
    const scopeNodes = state.visibleTree.length ? state.visibleTree : state.tree;
    for (const fileId of collectAllFileIds(scopeNodes)) {
      state.selected.add(fileId);
    }
    syncTreeSelectionStates();
  }

  function clearSelection() {
    state.selected.clear();
    syncTreeSelectionStates();
  }

  return {
    setTree,
    renderTree,
    renderTreeLoadingPlaceholder,
    queueTreeSearch,
    applySearchScope,
    clearSearch,
    selectAll,
    clearSelection,
    updateSelectionSummary,
  };
}
