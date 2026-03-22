function escapeAttributeValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function updateActiveFileButtons(treeContainerElement, previousFileId, nextFileId) {
  if (previousFileId !== null && previousFileId !== undefined && previousFileId !== nextFileId) {
    const escapedPrev = escapeAttributeValue(previousFileId);
    const prevButtons = treeContainerElement.querySelectorAll(
      `.file-button[data-file-ref-id="${escapedPrev}"]`,
    );
    for (const button of prevButtons) {
      button.classList.remove("active");
    }
  }

  if (nextFileId === null || nextFileId === undefined) {
    return;
  }

  const escapedNext = escapeAttributeValue(nextFileId);
  const nextButtons = treeContainerElement.querySelectorAll(
    `.file-button[data-file-ref-id="${escapedNext}"]`,
  );
  for (const button of nextButtons) {
    button.classList.add("active");
  }
}

function formatTextPreviewSummary(previewData) {
  let modeLabel = `Text preview (${previewData.format || "text"})`;
  if (previewData.forcedRaw) {
    modeLabel = "Text preview (raw)";
  } else if (previewData.mode === "plist") {
    modeLabel = `Parsed ${previewData.format || "plist"}`;
  }
  const truncationLabel = previewData.truncated ? " - truncated" : "";
  return `${modeLabel}${truncationLabel}`;
}

function formatSqliteCellValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

export function createPreviewController({
  state,
  el,
  apiFetch,
  formatSize,
  escapeHtml,
  isPreviewHiddenForLayout,
  defaultPlaceholderHtml,
}) {
  function clearPreviewHeaderActions() {
    el.previewHeaderActions.innerHTML = "";
  }

  function resetPreviewContainer(sqliteMode = false) {
    el.previewContainer.classList.toggle("preview-sqlite-mode", Boolean(sqliteMode));
    el.previewContainer.innerHTML = "";
  }

  function createPreviewLoadingElement(labelText = "Loading preview...") {
    const loading = document.createElement("div");
    loading.className = "preview-loading";
    loading.setAttribute("role", "status");
    loading.setAttribute("aria-live", "polite");

    const spinner = document.createElement("div");
    spinner.className = "preview-spinner";
    spinner.setAttribute("aria-hidden", "true");
    loading.appendChild(spinner);

    const label = document.createElement("div");
    label.className = "preview-loading-label";
    label.textContent = labelText;
    loading.appendChild(label);

    return loading;
  }

  function renderPreviewSummaryRow(summaryText) {
    const row = document.createElement("div");
    row.className = "preview-summary-row";

    const summary = document.createElement("div");
    summary.className = "summary";
    summary.textContent = String(summaryText || "");
    row.appendChild(summary);

    const rawToggle = document.createElement("label");
    rawToggle.className = "preview-raw-toggle";

    const rawCheckbox = document.createElement("input");
    rawCheckbox.type = "checkbox";
    rawCheckbox.checked = state.previewRawMode;
    rawCheckbox.setAttribute("aria-label", "Always show raw text preview");
    rawCheckbox.addEventListener("change", () => {
      const nextValue = Boolean(rawCheckbox.checked);
      if (state.previewRawMode === nextValue) {
        return;
      }
      state.previewRawMode = nextValue;
      rerenderActivePreview();
    });

    const rawLabel = document.createElement("span");
    rawLabel.textContent = "Raw";

    rawToggle.appendChild(rawCheckbox);
    rawToggle.appendChild(rawLabel);
    row.appendChild(rawToggle);

    el.previewContainer.appendChild(row);
  }

  function showPreviewLoadingState(summaryText = "Loading preview...", loadingLabel = "Loading preview...") {
    resetPreviewContainer(false);
    renderPreviewSummaryRow(summaryText);
    const loading = createPreviewLoadingElement(loadingLabel);
    el.previewContainer.appendChild(loading);
    return loading;
  }

  function setPreviewHeaderDownloadAction(meta) {
    const downloadUrl = `/api/files/${encodeURIComponent(meta.id)}/content?download=1`;
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Download this file";

    clearPreviewHeaderActions();
    el.previewHeaderActions.appendChild(link);
  }

  function formatPreviewMeta(meta) {
    const logicalPath = String(meta.logicalPath || "").trim();
    const slashIndex = logicalPath.lastIndexOf("/");
    const hasPathSeparator = slashIndex >= 0;

    const directoryPath = hasPathSeparator ? logicalPath.slice(0, slashIndex + 1) : logicalPath;
    const fileName = hasPathSeparator ? logicalPath.slice(slashIndex + 1) : "";

    const lines = [];
    if (directoryPath) {
      lines.push(directoryPath);
    }
    if (fileName) {
      lines.push(fileName);
    }
    lines.push(formatSize(meta.size));
    lines.push(meta.mimeType || "unknown type");
    return lines.join("\n");
  }

  function renderTextPreviewContent(previewData) {
    resetPreviewContainer(false);
    renderPreviewSummaryRow(formatTextPreviewSummary(previewData));

    const pre = document.createElement("pre");
    pre.className = "text-preview";
    pre.textContent = previewData.content || "";
    el.previewContainer.appendChild(pre);
  }

  function renderSqlitePreviewContent(previewData) {
    resetPreviewContainer(true);

    const tableCount = Number(previewData.tableCount || (previewData.tables || []).length || 0);
    const rowLimit = Number(previewData.rowLimit || 10);
    renderPreviewSummaryRow(
      `SQLite preview: ${tableCount} table${tableCount === 1 ? "" : "s"}, up to ${rowLimit} rows per table`,
    );

    const wrapper = document.createElement("div");
    wrapper.className = "sqlite-preview";

    const tables = Array.isArray(previewData.tables) ? previewData.tables : [];
    if (tables.length === 0) {
      const empty = document.createElement("div");
      empty.className = "placeholder";
      empty.textContent = "No user tables found in this SQLite database.";
      wrapper.appendChild(empty);
      el.previewContainer.appendChild(wrapper);
      return;
    }

    for (const tableInfo of tables) {
      const section = document.createElement("section");
      section.className = "sqlite-table-section";

      const title = document.createElement("h3");
      title.className = "sqlite-table-title";
      const tableName = String(tableInfo?.name || "Unnamed table");
      const rows = Array.isArray(tableInfo?.rows) ? tableInfo.rows : [];
      title.textContent = `${tableName} (${rows.length} row${rows.length === 1 ? "" : "s"} shown)`;
      section.appendChild(title);

      const columns = Array.isArray(tableInfo?.columns) ? tableInfo.columns.map(String) : [];
      if (columns.length === 0) {
        const noColumns = document.createElement("div");
        noColumns.className = "placeholder";
        noColumns.textContent = "No column metadata available.";
        section.appendChild(noColumns);
        wrapper.appendChild(section);
        continue;
      }

      const table = document.createElement("table");
      table.className = "sqlite-table";

      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      for (const columnName of columns) {
        const th = document.createElement("th");
        th.textContent = columnName;
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      if (rows.length === 0) {
        const emptyRow = document.createElement("tr");
        const emptyCell = document.createElement("td");
        emptyCell.colSpan = columns.length;
        emptyCell.className = "sqlite-empty-cell";
        emptyCell.textContent = "No rows";
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
      } else {
        for (const row of rows) {
          const tr = document.createElement("tr");
          for (const columnName of columns) {
            const td = document.createElement("td");
            const value = row && typeof row === "object" ? row[columnName] : "";
            td.textContent = formatSqliteCellValue(value);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
      }
      table.appendChild(tbody);
      section.appendChild(table);
      wrapper.appendChild(section);
    }

    el.previewContainer.appendChild(wrapper);
  }

  function renderInlinePreviewContent(meta, inlineUrl) {
    let summaryText = "";
    let loadEvent = "load";
    let mediaElement = null;
    const mimeType = String(meta?.mimeType || "").toLowerCase();

    if (meta.previewKind === "image" || mimeType.startsWith("image/")) {
      const image = document.createElement("img");
      image.alt = meta.relativePath;
      summaryText = "Image preview";
      loadEvent = "load";
      mediaElement = image;
    }

    if ((meta.previewKind === "pdf" || mimeType === "application/pdf") && !mediaElement) {
      const frame = document.createElement("iframe");
      frame.title = meta.relativePath;
      summaryText = "PDF preview";
      loadEvent = "load";
      mediaElement = frame;
    }

    if ((meta.previewKind === "video" || mimeType.startsWith("video/")) && !mediaElement) {
      const video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.playsInline = true;
      video.title = meta.relativePath || "Video preview";
      summaryText = "Video preview";
      loadEvent = "loadedmetadata";
      mediaElement = video;
    }

    if (mimeType.startsWith("audio/") && !mediaElement) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "metadata";
      summaryText = "Audio preview";
      loadEvent = "loadedmetadata";
      mediaElement = audio;
    }

    if (!mediaElement) {
      return false;
    }

    resetPreviewContainer(false);
    renderPreviewSummaryRow(summaryText);
    const loading = createPreviewLoadingElement("Loading media...");
    el.previewContainer.appendChild(loading);

    mediaElement.classList.add("preview-media-pending");
    const revealMedia = () => {
      loading.remove();
      mediaElement.classList.remove("preview-media-pending");
    };
    const handleMediaError = () => {
      loading.remove();
      mediaElement.remove();
      const note = document.createElement("div");
      note.className = "placeholder";
      note.textContent = "Preview media failed to load.";
      el.previewContainer.appendChild(note);
    };

    mediaElement.addEventListener(loadEvent, revealMedia, { once: true });
    mediaElement.addEventListener("error", handleMediaError, { once: true });
    mediaElement.src = `${inlineUrl}?t=${Date.now()}`;
    el.previewContainer.appendChild(mediaElement);
    return true;
  }

  async function renderPreview(meta) {
    if (isPreviewHiddenForLayout()) {
      return;
    }

    const inlineUrl = `/api/files/${encodeURIComponent(meta.id)}/content`;

    clearPreviewHeaderActions();
    el.fileMeta.textContent = formatPreviewMeta(meta);

    resetPreviewContainer(false);

    if (!meta.exists) {
      el.previewContainer.innerHTML =
        '<div class="placeholder">File content was not found in this backup folder.</div>';
      return;
    }

    setPreviewHeaderDownloadAction(meta);

    if (!state.previewRawMode && renderInlinePreviewContent(meta, inlineUrl)) {
      return;
    }

    showPreviewLoadingState("Loading preview...", "Loading preview...");

    try {
      const rawQuery = state.previewRawMode ? "?raw=1" : "";
      const previewData = await apiFetch(`/api/files/${encodeURIComponent(meta.id)}/preview${rawQuery}`);
      if (isPreviewHiddenForLayout()) {
        return;
      }
      if (previewData.mode === "sqlite") {
        renderSqlitePreviewContent(previewData);
      } else {
        renderTextPreviewContent(previewData);
      }
    } catch (error) {
      if (isPreviewHiddenForLayout()) {
        return;
      }
      resetPreviewContainer(false);
      const note = document.createElement("div");
      note.className = "placeholder";
      note.textContent = `Preview failed: ${error.message}`;
      el.previewContainer.appendChild(note);
    }
  }

  async function openPreview(fileId) {
    if (isPreviewHiddenForLayout()) {
      clearActivePreviewSelection();
      return;
    }

    try {
      const previousFileId = state.activeFileId;
      state.activeFileId = fileId;
      updateActiveFileButtons(el.treeContainer, previousFileId, fileId);
      const meta = await apiFetch(`/api/files/${encodeURIComponent(fileId)}/meta`);

      if (isPreviewHiddenForLayout()) {
        clearActivePreviewSelection();
        return;
      }

      state.metaByFileId.set(fileId, meta);
      await renderPreview(meta);
    } catch (error) {
      clearPreviewHeaderActions();
      el.fileMeta.textContent = "Preview failed.";
      el.previewContainer.innerHTML = `<div class="placeholder">${escapeHtml(error.message)}</div>`;
    }
  }

  function clearActivePreviewSelection() {
    const previousFileId = state.activeFileId;
    state.activeFileId = null;
    updateActiveFileButtons(el.treeContainer, previousFileId, null);
    clearPreviewHeaderActions();
    el.fileMeta.textContent = "No file selected.";
    el.previewContainer.innerHTML = defaultPlaceholderHtml;
  }

  function rerenderActivePreview() {
    if (state.activeFileId === null || state.activeFileId === undefined) {
      return;
    }
    const activeMeta = state.metaByFileId.get(state.activeFileId);
    if (activeMeta) {
      renderPreview(activeMeta);
      return;
    }
    openPreview(state.activeFileId);
  }

  return {
    clearPreviewHeaderActions,
    clearActivePreviewSelection,
    openPreview,
    rerenderActivePreview,
  };
}
