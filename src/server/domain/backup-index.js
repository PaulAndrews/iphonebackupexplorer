import path from "node:path";
import fs from "node:fs/promises";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { createFolderNode, cloneTreeNode } from "../utils/tree-node-utils.js";
import { normalizePathPart, resolveUniqueOutputPath } from "../utils/path-utils.js";
import { analyzePreviewForEntry } from "../services/preview-service.js";

export class BackupIndex {
  constructor(backupRoot) {
    this.backupRoot = path.resolve(backupRoot);
    this.manifestDbPath = path.join(this.backupRoot, "Manifest.db");

    this.entriesById = new Map();
    this.rootNode = createFolderNode("root", "Backups");
    this.domainNodes = new Map();
    this.folderNodes = new Map();

    this.nextEntryId = 1;
    this.nextAliasNodeId = 1;
    this.loaded = false;
    this.stats = {
      totalEntries: 0,
      totalFiles: 0,
      totalFolders: 0,
      missingOnDisk: 0,
      domains: 0,
    };
  }

  async load() {
    await this.validateLayout();

    const db = await open({
      filename: this.manifestDbPath,
      driver: sqlite3.Database,
      mode: sqlite3.OPEN_READONLY,
    });

    try {
      const rows = await db.all(`
        SELECT fileID, domain, relativePath, flags
        FROM Files
        WHERE fileID IS NOT NULL AND domain IS NOT NULL
        ORDER BY domain, relativePath
      `);

      for (const row of rows) {
        this.stats.totalEntries += 1;
        const domain = String(row.domain || "").trim();
        const relativePath = normalizePathPart(row.relativePath);
        const flags = Number(row.flags || 0);

        if (!domain) {
          continue;
        }

        if (flags === 2) {
          if (relativePath) {
            this.ensureFolder(domain, relativePath);
          } else {
            this.ensureDomain(domain);
          }
          continue;
        }

        if (!relativePath) {
          // Some entries represent virtual roots and have no path.
          continue;
        }

        const entryId = String(this.nextEntryId++);
        const entry = {
          id: entryId,
          fileID: String(row.fileID),
          domain,
          relativePath,
          flags,
          logicalPath: `${domain}/${relativePath}`,
          resolvedSourcePath: undefined,
        };

        this.entriesById.set(entryId, entry);
        this.insertFileIntoTree(entry);
      }
    } finally {
      await db.close();
    }

    this.linkMobileDocumentsDomains();
    this.sortTree(this.rootNode);
    this.stats.totalFiles = this.entriesById.size;
    this.stats.domains = this.domainNodes.size;
    this.stats.totalFolders = this.folderNodes.size + this.domainNodes.size;
    this.loaded = true;
  }

  async validateLayout() {
    const stat = await fs.stat(this.backupRoot).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Backup folder not found: ${this.backupRoot}`);
    }

    const manifestStat = await fs.stat(this.manifestDbPath).catch(() => null);
    if (!manifestStat || !manifestStat.isFile()) {
      throw new Error(
        `Manifest.db was not found in ${this.backupRoot}. Expected file: ${this.manifestDbPath}`,
      );
    }
  }

  ensureDomain(domain) {
    if (this.domainNodes.has(domain)) {
      return this.domainNodes.get(domain);
    }

    const domainNode = createFolderNode(`domain:${domain}`, domain);
    this.domainNodes.set(domain, domainNode);
    this.rootNode.children.push(domainNode);
    return domainNode;
  }

  ensureFolder(domain, relativeFolderPath) {
    const cleanFolderPath = normalizePathPart(relativeFolderPath);
    if (!cleanFolderPath) {
      return this.ensureDomain(domain);
    }

    const domainNode = this.ensureDomain(domain);
    const segments = cleanFolderPath.split("/").filter(Boolean);

    let currentNode = domainNode;
    let cumulativePath = "";
    for (const segment of segments) {
      cumulativePath = cumulativePath ? `${cumulativePath}/${segment}` : segment;
      const key = `${domain}:${cumulativePath}`;
      let folderNode = this.folderNodes.get(key);
      if (!folderNode) {
        folderNode = createFolderNode(`folder:${key}`, segment);
        this.folderNodes.set(key, folderNode);
        currentNode.children.push(folderNode);
      }
      currentNode = folderNode;
    }
    return currentNode;
  }

  insertFileIntoTree(entry) {
    const domainNode = this.ensureDomain(entry.domain);
    const segments = entry.relativePath.split("/").filter(Boolean);
    const fileName = segments.length > 0 ? segments[segments.length - 1] : entry.fileID;
    const folderPath = segments.slice(0, -1).join("/");
    const parentFolder = folderPath
      ? this.ensureFolder(entry.domain, folderPath)
      : domainNode;

    parentFolder.children.push({
      id: `file:${entry.id}`,
      type: "file",
      name: fileName,
      fileRefId: entry.id,
      logicalPath: entry.logicalPath,
    });
  }

  sortTree(node) {
    node.children.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "folder" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { numeric: true });
    });

    for (const child of node.children) {
      if (child.type === "folder") {
        this.sortTree(child);
      }
    }
  }

  makeAliasId(prefix = "alias") {
    return `${prefix}:${this.nextAliasNodeId++}`;
  }

  linkMobileDocumentsDomains() {
    const mobilePrefix = "HomeDomain:Library/Mobile Documents/";

    for (const [folderKey, folderNode] of this.folderNodes.entries()) {
      if (!folderKey.startsWith(mobilePrefix)) {
        continue;
      }

      const relativePath = folderKey.slice("HomeDomain:".length);
      const pathSegments = relativePath.split("/").filter(Boolean);
      if (pathSegments.length === 0) {
        continue;
      }

      const maybeDomainName = pathSegments[pathSegments.length - 1];
      const domainNode = this.domainNodes.get(maybeDomainName);
      if (!domainNode || !Array.isArray(domainNode.children) || domainNode.children.length === 0) {
        continue;
      }

      this.mergeFolderChildrenFromDomain(folderNode, domainNode.children);
    }
  }

  mergeFolderChildrenFromDomain(targetFolder, sourceChildren) {
    for (const sourceChild of sourceChildren) {
      if (sourceChild.type === "folder") {
        let targetChild = targetFolder.children.find(
          (candidate) => candidate.type === "folder" && candidate.name === sourceChild.name,
        );

        if (!targetChild) {
          targetChild = createFolderNode(this.makeAliasId("alias-folder"), sourceChild.name);
          targetFolder.children.push(targetChild);
        }

        this.mergeFolderChildrenFromDomain(targetChild, sourceChild.children || []);
        continue;
      }

      const alreadyPresent = targetFolder.children.some(
        (candidate) =>
          candidate.type === "file" &&
          candidate.fileRefId === sourceChild.fileRefId &&
          candidate.name === sourceChild.name,
      );
      if (alreadyPresent) {
        continue;
      }

      targetFolder.children.push({
        id: this.makeAliasId("alias-file"),
        type: "file",
        name: sourceChild.name,
        fileRefId: sourceChild.fileRefId,
        logicalPath: sourceChild.logicalPath,
      });
    }
  }

  getTree(view = "raw") {
    const normalized = String(view || "raw").toLowerCase();
    if (normalized === "apps" || normalized === "app") {
      return this.buildAppTree();
    }
    if (normalized === "camera" || normalized === "photo" || normalized === "photos") {
      return this.buildCameraTree();
    }
    if (normalized === "files" || normalized === "file") {
      return this.buildFilesTree();
    }
    return this.rootNode.children;
  }

  buildAppTree() {
    const appIds = this.collectAppIdsFromDomains();
    const appBuckets = new Map();

    const ensureBucket = (appId) => {
      if (!appBuckets.has(appId)) {
        appBuckets.set(appId, {
          appId,
          sandbox: [],
          plugins: [],
          groups: [],
          mobile: [],
        });
      }
      return appBuckets.get(appId);
    };

    for (const [domainName, domainNode] of this.domainNodes.entries()) {
      const mapping = this.classifyDomainForApp(domainName, appIds);
      if (!mapping || !mapping.appId) {
        continue;
      }
      const bucket = ensureBucket(mapping.appId);
      const clones = this.buildAppCategoryClones(domainName, domainNode, mapping);
      if (clones.length === 0) {
        continue;
      }

      if (mapping.category === "sandbox") {
        bucket.sandbox.push(...clones);
      } else if (mapping.category === "plugin") {
        bucket.plugins.push(...clones);
      } else if (mapping.category === "group") {
        bucket.groups.push(...clones);
      }
    }

    const mobileContainers = this.getMobileDocumentsContainerNodes();
    for (const [containerName, containerNode] of mobileContainers.entries()) {
      const appId = this.inferAppIdFromMobileContainer(containerName, appIds);
      if (!appId) {
        continue;
      }
      const bucket = ensureBucket(appId);
      const clone = cloneTreeNode(containerNode, `apps-mobile:${containerName}`);
      clone.name = `Mobile Documents/${containerName}`;
      bucket.mobile.push(clone);
    }

    const appRoot = createFolderNode("apps-root", "Applications");
    for (const appId of Array.from(appBuckets.keys()).sort((a, b) => a.localeCompare(b))) {
      const bucket = appBuckets.get(appId);
      const appNode = createFolderNode(`app:${appId}`, appId);

      this.addCategoryNode(appNode, "App Domain", bucket.sandbox);
      this.addCategoryNode(appNode, "Plugins / Extensions", bucket.plugins);
      this.addCategoryNode(appNode, "Shared Groups", bucket.groups);
      this.addCategoryNode(appNode, "Mobile Documents / iCloud", bucket.mobile);

      if (appNode.children.length > 0) {
        this.sortTree(appNode);
        appRoot.children.push(appNode);
      }
    }

    this.sortTree(appRoot);
    return appRoot.children;
  }

  buildCameraTree() {
    const cameraRoot = createFolderNode("camera-root", "Camera");

    this.addDomainCategory(
      cameraRoot,
      "camera-domains",
      "Photo / Camera Domains",
      (domainName) => {
        const lower = String(domainName || "").toLowerCase();
        if (domainName === "CameraRollDomain" || domainName === "MediaDomain" || domainName === "PhotoDataDomain") {
          return true;
        }
        return !this.isAppDomainName(domainName) && (lower.includes("camera") || lower.includes("photo"));
      },
    );

    this.addHomeDomainFolderCategory(cameraRoot, "camera-home", "Photo Folders in HomeDomain", [
      "Media/DCIM",
      "Media/PhotoData",
      "Library/PhotoData",
      "Library/Caches/com.apple.mobileslideshow",
    ]);

    this.sortTree(cameraRoot);
    return cameraRoot.children;
  }

  buildFilesTree() {
    const filesRoot = createFolderNode("files-root", "Files");

    this.addHomeDomainFolderCategory(filesRoot, "files-home", "Common File Locations (HomeDomain)", [
      "Documents",
      "Downloads",
      "Library/Mobile Documents",
      "Library/CloudStorage",
      "Library/Application Support/FileProvider",
      "Library/Application Support/CloudDocs",
    ]);

    this.addDomainCategory(
      filesRoot,
      "files-domains",
      "File Provider / iCloud Domains",
      (domainName) => {
        if (domainName === "HomeDomain" || domainName === "CameraRollDomain") {
          return false;
        }
        const lower = String(domainName || "").toLowerCase();
        return (
          lower.includes("fileprovider") ||
          lower.includes("clouddocs") ||
          lower.includes("icloud") ||
          lower.includes("mobiledocuments")
        );
      },
    );

    const mobileContainers = this.getMobileDocumentsContainerNodes();
    if (mobileContainers.size > 0) {
      const mobileNode = createFolderNode(
        this.makeAliasId("files-mobile-category"),
        "Mobile Documents Containers",
      );

      for (const [containerName, containerNode] of mobileContainers.entries()) {
        const clone = cloneTreeNode(containerNode, `files-mobile:${containerName}`);
        clone.name = containerName;
        mobileNode.children.push(clone);
      }

      if (mobileNode.children.length > 0) {
        this.sortTree(mobileNode);
        filesRoot.children.push(mobileNode);
      }
    }

    this.sortTree(filesRoot);
    return filesRoot.children;
  }

  isAppDomainName(domainName) {
    return (
      String(domainName || "").startsWith("AppDomain-") ||
      String(domainName || "").startsWith("AppDomainPlugin-") ||
      String(domainName || "").startsWith("AppDomainGroup-")
    );
  }

  addDomainCategory(parent, idPrefix, label, predicateFn) {
    if (!parent || typeof predicateFn !== "function") {
      return;
    }

    const categoryNode = createFolderNode(this.makeAliasId(idPrefix), label);
    for (const [domainName, domainNode] of this.domainNodes.entries()) {
      if (!predicateFn(domainName, domainNode)) {
        continue;
      }
      const clone = cloneTreeNode(domainNode, `${idPrefix}:${domainName}`);
      clone.name = domainName;
      categoryNode.children.push(clone);
    }

    if (categoryNode.children.length === 0) {
      return;
    }
    this.sortTree(categoryNode);
    parent.children.push(categoryNode);
  }

  addHomeDomainFolderCategory(parent, idPrefix, label, relativeFolderPaths) {
    if (!parent || !Array.isArray(relativeFolderPaths) || relativeFolderPaths.length === 0) {
      return;
    }

    const categoryNode = createFolderNode(this.makeAliasId(idPrefix), label);
    const seen = new Set();

    for (const rawPath of relativeFolderPaths) {
      const normalizedPath = normalizePathPart(rawPath);
      if (!normalizedPath) {
        continue;
      }

      const key = `HomeDomain:${normalizedPath}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const folderNode = this.folderNodes.get(key);
      if (!folderNode) {
        continue;
      }

      const clone = cloneTreeNode(folderNode, `${idPrefix}:${key}`);
      clone.name = normalizedPath;
      categoryNode.children.push(clone);
    }

    if (categoryNode.children.length === 0) {
      return;
    }

    this.sortTree(categoryNode);
    parent.children.push(categoryNode);
  }

  addCategoryNode(parent, label, children) {
    if (!Array.isArray(children) || children.length === 0) {
      return;
    }
    const categoryNode = createFolderNode(this.makeAliasId("app-category"), label);
    categoryNode.children = children;
    parent.children.push(categoryNode);
  }

  buildAppCategoryClones(domainName, domainNode, mapping) {
    const appId = String(mapping?.appId || "");
    const category = String(mapping?.category || "");
    const clonePrefix = `apps-domain:${domainName}`;

    // AppDomain-<appId> is just a namespace wrapper, so show its contents directly.
    if (category === "sandbox" && domainName.toLowerCase() === `appdomain-${appId}`.toLowerCase()) {
      return (domainNode.children || []).map((child) => cloneTreeNode(child, clonePrefix));
    }

    const clone = cloneTreeNode(domainNode, clonePrefix);
    clone.name = this.getAppDomainDisplayName(domainName, appId, category);
    return [clone];
  }

  getAppDomainDisplayName(domainName, appId, category) {
    if (category === "group" && domainName.startsWith("AppDomainGroup-")) {
      const rest = domainName.slice("AppDomainGroup-".length);
      const firstDotIndex = rest.indexOf(".");
      if (firstDotIndex <= 0) {
        return rest || domainName;
      }

      const marker = rest.slice(0, firstDotIndex);
      const payload = rest.slice(firstDotIndex + 1);
      const simplifiedPayload = this.removeAppIdFromDottedValue(payload, appId);
      if (!simplifiedPayload) {
        return marker;
      }

      if (marker.toLowerCase() === "group") {
        return simplifiedPayload;
      }

      // Keep non-standard marker prefixes visible, e.g. "prefix.widgetkit".
      return simplifiedPayload === payload ? rest : `${marker}.${simplifiedPayload}`;
    }

    if (category === "plugin" && domainName.startsWith("AppDomainPlugin-")) {
      const rest = domainName.slice("AppDomainPlugin-".length);
      return this.removeAppIdFromDottedValue(rest, appId) || rest || domainName;
    }

    if (category === "sandbox" && domainName.startsWith("AppDomain-")) {
      const rest = domainName.slice("AppDomain-".length);
      return this.removeAppIdFromDottedValue(rest, appId) || rest || domainName;
    }

    return domainName;
  }

  removeAppIdFromDottedValue(value, appId) {
    const input = String(value || "").trim();
    const target = String(appId || "").trim();
    if (!input || !target) {
      return input;
    }

    const inputParts = input.split(".").filter(Boolean);
    const targetParts = target.split(".").filter(Boolean);
    if (inputParts.length === 0 || targetParts.length === 0 || targetParts.length > inputParts.length) {
      return input;
    }

    const inputLower = inputParts.map((part) => part.toLowerCase());
    const targetLower = targetParts.map((part) => part.toLowerCase());

    for (let start = 0; start <= inputParts.length - targetParts.length; start += 1) {
      let matches = true;
      for (let offset = 0; offset < targetLower.length; offset += 1) {
        if (inputLower[start + offset] !== targetLower[offset]) {
          matches = false;
          break;
        }
      }
      if (!matches) {
        continue;
      }

      const leading = inputParts.slice(0, start);
      const trailing = inputParts.slice(start + targetParts.length);
      return [...leading, ...trailing].join(".");
    }

    return input;
  }

  collectAppIdsFromDomains() {
    const ids = new Set();
    for (const domainName of this.domainNodes.keys()) {
      if (domainName.startsWith("AppDomain-")) {
        ids.add(domainName.slice("AppDomain-".length));
      }
    }
    return Array.from(ids);
  }

  classifyDomainForApp(domainName, appIds) {
    if (domainName.startsWith("AppDomain-")) {
      return {
        appId: domainName.slice("AppDomain-".length),
        category: "sandbox",
      };
    }

    if (domainName.startsWith("AppDomainPlugin-")) {
      const rest = domainName.slice("AppDomainPlugin-".length);
      const appId = this.findBestAppIdMatch(rest, appIds);
      return appId ? { appId, category: "plugin" } : null;
    }

    if (domainName.startsWith("AppDomainGroup-")) {
      const rest = domainName.slice("AppDomainGroup-".length);
      const stripped = rest.replace(/^group\./i, "");
      const appId = this.findBestAppIdMatch(stripped, appIds) || this.findBestAppIdMatch(rest, appIds);
      return appId ? { appId, category: "group" } : null;
    }

    return null;
  }

  findBestAppIdMatch(text, appIds) {
    const value = String(text || "").toLowerCase();
    if (!value) {
      return null;
    }

    let best = null;
    for (const candidate of appIds) {
      const candidateLower = candidate.toLowerCase();
      const isMatch =
        value === candidateLower ||
        value.startsWith(`${candidateLower}.`) ||
        value.includes(`.${candidateLower}.`) ||
        value.endsWith(`.${candidateLower}`);
      if (!isMatch) {
        continue;
      }
      if (!best || candidate.length > best.length) {
        best = candidate;
      }
    }

    if (best) {
      return best;
    }

    // Fallback for related IDs that share a strong prefix,
    // e.g. "pdf.scanner.app.publicdata" vs "pdf.scanner.app.plus".
    let bestPrefixMatch = null;
    let bestPrefixLength = 0;
    const valueParts = value.split(".");

    for (const candidate of appIds) {
      const candidateParts = candidate.toLowerCase().split(".");
      let prefixLength = 0;

      while (
        prefixLength < valueParts.length &&
        prefixLength < candidateParts.length &&
        valueParts[prefixLength] === candidateParts[prefixLength]
      ) {
        prefixLength += 1;
      }

      if (prefixLength >= 3 && prefixLength > bestPrefixLength) {
        bestPrefixLength = prefixLength;
        bestPrefixMatch = candidate;
      }
    }

    if (bestPrefixMatch) {
      return bestPrefixMatch;
    }

    return best;
  }

  getMobileDocumentsContainerNodes() {
    const result = new Map();
    const prefix = "HomeDomain:Library/Mobile Documents/";

    for (const folderKey of this.folderNodes.keys()) {
      if (!folderKey.startsWith(prefix)) {
        continue;
      }
      const remainder = folderKey.slice(prefix.length);
      const firstSegment = remainder.split("/")[0];
      if (!firstSegment) {
        continue;
      }

      if (!result.has(firstSegment)) {
        const rootContainerKey = `HomeDomain:Library/Mobile Documents/${firstSegment}`;
        const containerNode = this.folderNodes.get(rootContainerKey);
        if (containerNode) {
          result.set(firstSegment, containerNode);
        }
      }
    }

    return result;
  }

  inferAppIdFromMobileContainer(containerName, appIds) {
    const decoded = String(containerName || "").replace(/~/g, ".");
    const candidates = [
      decoded,
      decoded.replace(/^iCloud\./i, ""),
      decoded.replace(/^group\./i, ""),
    ];

    for (const candidate of candidates) {
      const match = this.findBestAppIdMatch(candidate, appIds);
      if (match) {
        return match;
      }
    }

    return null;
  }

  getStats() {
    return { ...this.stats };
  }

  getEntry(entryId) {
    return this.entriesById.get(String(entryId)) || null;
  }

  getSourceCandidates(fileID) {
    const candidates = [];
    const normalized = String(fileID || "").trim();
    if (!normalized) {
      return candidates;
    }

    const lower = normalized.toLowerCase();
    const upper = normalized.toUpperCase();
    const seen = new Set();

    const maybeAdd = (candidatePath) => {
      if (!seen.has(candidatePath)) {
        seen.add(candidatePath);
        candidates.push(candidatePath);
      }
    };

    if (normalized.length >= 2) {
      maybeAdd(path.join(this.backupRoot, normalized.slice(0, 2), normalized));
      maybeAdd(path.join(this.backupRoot, lower.slice(0, 2), lower));
      maybeAdd(path.join(this.backupRoot, upper.slice(0, 2), upper));
    }

    maybeAdd(path.join(this.backupRoot, normalized));
    maybeAdd(path.join(this.backupRoot, lower));
    maybeAdd(path.join(this.backupRoot, upper));
    return candidates;
  }

  async resolveSourcePath(entry) {
    if (entry.resolvedSourcePath !== undefined) {
      return entry.resolvedSourcePath;
    }

    const candidates = this.getSourceCandidates(entry.fileID);
    for (const candidate of candidates) {
      const exists = await fs
        .access(candidate)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        entry.resolvedSourcePath = candidate;
        return candidate;
      }
    }

    this.stats.missingOnDisk += 1;
    entry.resolvedSourcePath = null;
    return null;
  }

  async getEntryMeta(entryId) {
    const entry = this.getEntry(entryId);
    if (!entry) {
      return null;
    }

    const sourcePath = await this.resolveSourcePath(entry);
    const preview = await analyzePreviewForEntry(entry.relativePath, sourcePath);
    const isPreviewable = preview.previewKind !== "none";
    const stat = sourcePath ? await fs.stat(sourcePath).catch(() => null) : null;

    return {
      id: entry.id,
      fileID: entry.fileID,
      domain: entry.domain,
      relativePath: entry.relativePath,
      logicalPath: entry.logicalPath,
      sourcePath,
      exists: Boolean(sourcePath),
      size: stat ? stat.size : null,
      modifiedAt: stat ? stat.mtime.toISOString() : null,
      mimeType: preview.mimeType,
      previewKind: preview.previewKind,
      previewable: isPreviewable,
    };
  }

  async extract(fileIds, targetRoot) {
    const targetDir = path.resolve(String(targetRoot || ""));
    await fs.mkdir(targetDir, { recursive: true });

    const result = {
      targetDir,
      requestedCount: fileIds.length,
      exportedCount: 0,
      missingCount: 0,
      invalidCount: 0,
      failedCount: 0,
      exportedSamples: [],
      missingSamples: [],
      failedSamples: [],
    };

    const usedOutputPaths = new Set();

    for (const rawId of fileIds) {
      const entry = this.getEntry(rawId);
      if (!entry) {
        result.invalidCount += 1;
        continue;
      }

      const sourcePath = await this.resolveSourcePath(entry);
      if (!sourcePath) {
        result.missingCount += 1;
        result.missingSamples.push(entry.logicalPath);
        continue;
      }

      const outputPath = resolveUniqueOutputPath(
        targetDir,
        entry.domain,
        entry.relativePath,
        usedOutputPaths,
      );

      try {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.copyFile(sourcePath, outputPath);
        result.exportedCount += 1;
        if (result.exportedSamples.length < 25) {
          result.exportedSamples.push(path.relative(targetDir, outputPath));
        }
      } catch (error) {
        result.failedCount += 1;
        result.failedSamples.push({
          path: entry.logicalPath,
          error: error.message,
        });
      }
    }

    return result;
  }
}
