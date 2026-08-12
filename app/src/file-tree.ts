export type FileTreeNode = {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children: FileTreeNode[];
};

export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const path of paths) {
    const segments = path.split('/');
    let siblings = root;
    let currentPath = '';

    segments.forEach((segment, index) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isFile = index === segments.length - 1;
      const type = isFile ? 'file' : 'folder';

      let node = siblings.find((candidate) => candidate.name === segment && candidate.type === type);
      if (!node) {
        node = { name: segment, path: currentPath, type, children: [] };
        siblings.push(node);
      }
      siblings = node.children;
    });
  }

  sortTree(root);
  return root;
}

function sortTree(nodes: FileTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'folder' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  for (const node of nodes) {
    if (node.children.length > 0) {
      sortTree(node.children);
    }
  }
}

export function topLevelFolders(paths: string[]): string[] {
  const folders = new Set<string>();

  for (const path of paths) {
    const slashIndex = path.indexOf('/');
    if (slashIndex > 0) {
      folders.add(path.slice(0, slashIndex));
    }
  }

  return [...folders];
}
