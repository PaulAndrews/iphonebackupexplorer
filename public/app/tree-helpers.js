export function buildFolderFileIdMap(nodes) {
  const map = new Map();

  const walk = (node) => {
    if (!node || typeof node !== "object") {
      return [];
    }
    if (node.type === "file") {
      return [node.fileRefId];
    }
    if (node.type !== "folder") {
      return [];
    }

    const fileIds = new Set();
    for (const child of node.children || []) {
      for (const fileId of walk(child)) {
        fileIds.add(fileId);
      }
    }

    const idsArray = Array.from(fileIds);
    map.set(node.id, idsArray);
    return idsArray;
  };

  for (const node of nodes || []) {
    walk(node);
  }

  return map;
}

function cloneTreeForView(node) {
  if (node.type === "file") {
    return {
      id: node.id,
      type: "file",
      name: node.name,
      fileRefId: node.fileRefId,
      logicalPath: node.logicalPath,
    };
  }

  return {
    id: node.id,
    type: "folder",
    name: node.name,
    children: Array.isArray(node.children) ? node.children.map(cloneTreeForView) : [],
  };
}

export function pruneEmptyFolders(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return [];
  }

  const result = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      continue;
    }

    if (node.type === "file") {
      result.push(node);
      continue;
    }

    if (node.type !== "folder") {
      continue;
    }

    const prunedChildren = pruneEmptyFolders(node.children || []);
    if (prunedChildren.length === 0) {
      continue;
    }

    result.push({
      ...node,
      children: prunedChildren,
    });
  }

  return result;
}

function filterFolderNodeBySearch(node, queryLower, includeFiles = false) {
  if (!node || node.type !== "folder") {
    return null;
  }

  const folderMatches = String(node.name || "").toLowerCase().includes(queryLower);
  if (folderMatches) {
    return cloneTreeForView(node);
  }

  const filteredChildren = [];
  for (const child of node.children || []) {
    if (child.type === "folder") {
      const filteredChild = filterFolderNodeBySearch(child, queryLower, includeFiles);
      if (filteredChild) {
        filteredChildren.push(filteredChild);
      }
      continue;
    }

    if (includeFiles && child.type === "file") {
      const fileMatches = String(child.name || "").toLowerCase().includes(queryLower);
      if (fileMatches) {
        filteredChildren.push(cloneTreeForView(child));
      }
    }
  }

  if (filteredChildren.length === 0) {
    return null;
  }

  return {
    id: node.id,
    type: "folder",
    name: node.name,
    children: filteredChildren,
  };
}

export function getVisibleTree(tree, treeSearchQuery, treeSearchScope) {
  const query = String(treeSearchQuery || "").trim().toLowerCase();
  if (!query) {
    return tree;
  }

  const includeFiles = treeSearchScope === "all";
  const filtered = [];
  for (const rootNode of tree) {
    if (rootNode.type !== "folder") {
      continue;
    }
    const filteredNode = filterFolderNodeBySearch(rootNode, query, includeFiles);
    if (filteredNode) {
      filtered.push(filteredNode);
    }
  }
  return filtered;
}

export function collectAllFileIds(nodes, output = []) {
  for (const node of nodes) {
    if (node.type === "file") {
      output.push(node.fileRefId);
    } else if (node.children && node.children.length > 0) {
      collectAllFileIds(node.children, output);
    }
  }
  return output;
}
