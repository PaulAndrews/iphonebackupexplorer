export function createFolderNode(id, name) {
  return {
    id,
    type: "folder",
    name,
    children: [],
  };
}

export function cloneTreeNode(node, idPrefix) {
  if (node.type === "file") {
    return {
      id: `${idPrefix}:${node.id}`,
      type: "file",
      name: node.name,
      fileRefId: node.fileRefId,
      logicalPath: node.logicalPath,
    };
  }

  return {
    id: `${idPrefix}:${node.id}`,
    type: "folder",
    name: node.name,
    children: Array.isArray(node.children)
      ? node.children.map((child) => cloneTreeNode(child, idPrefix))
      : [],
  };
}
