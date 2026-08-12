import * as git from 'isomorphic-git';

const VIRTUAL_REPO_ROOT = '/repo';
const HISTORY_DEPTH = 10;

type FsEncoding = 'utf8';
type FsReadOptions = { encoding?: FsEncoding | null } | FsEncoding | null;
type FsWriteOptions = { encoding?: FsEncoding | null } | FsEncoding | null;
type FsMkdirOptions = { recursive?: boolean };
type FsRmdirOptions = { recursive?: boolean };

type FsStats = {
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

type FsError = Error & { code: string };

type BrowserFs = {
  promises: {
    readFile(path: string, options?: FsReadOptions): Promise<Uint8Array | string>;
    writeFile(path: string, data: string | BufferSource, options?: FsWriteOptions): Promise<void>;
    mkdir(path: string, options?: FsMkdirOptions): Promise<void>;
    rmdir(path: string, options?: FsRmdirOptions): Promise<void>;
    unlink(path: string): Promise<void>;
    stat(path: string): Promise<FsStats>;
    lstat(path: string): Promise<FsStats>;
    readdir(path: string): Promise<string[]>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
  };
};

export type RepositoryHistoryEntry = {
  oid: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
};

export type RepositoryChangeType = 'added' | 'modified' | 'deleted';

export type RepositoryChange = {
  filepath: string;
  changeType: RepositoryChangeType;
};

export type RepositorySnapshot = {
  folderName: string;
  files: string[];
  history: RepositoryHistoryEntry[];
  pendingChanges: RepositoryChange[];
};

export type RepositoryCommitResult = {
  oid: string;
  files: string[];
  pendingChanges: RepositoryChange[];
};

export type RepositoryWriteResult = {
  filepath: string;
  files: string[];
  pendingChanges: RepositoryChange[];
};

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export class RepositoryController {
  private readonly directoryHandle: FileSystemDirectoryHandle;
  private readonly fs: BrowserFs;
  // Shared across every isomorphic-git call made through this controller, per isomorphic-git's
  // own recommendation: it lets sequential calls (e.g. statusMatrix -> add -> commit within one
  // commitAll) reuse the already-parsed .git/index and object cache instead of each independently
  // re-reading and re-parsing it from disk via our (comparatively slow) File System Access adapter.
  private readonly cache: object = {};
  // In-memory mirror of git status, seeded once by a full walk in snapshot() and kept in sync
  // afterward via narrow, single-path statusMatrix checks (see refreshOne / commitAll) instead
  // of re-walking the whole vault on every action. This only stays accurate for changes made
  // through this controller — a file edited or deleted outside the app while it's open won't be
  // reflected until the repository is reopened (which re-seeds via a fresh full walk).
  private readonly knownFiles = new Set<string>();
  private readonly pendingChangesByPath = new Map<string, RepositoryChangeType>();

  private constructor(directoryHandle: FileSystemDirectoryHandle, fs: BrowserFs) {
    this.directoryHandle = directoryHandle;
    this.fs = fs;
  }

  static async openWithPicker(): Promise<RepositoryController> {
    if (!supportsFileSystemAccess()) {
      throw new Error('This browser does not support the File System Access API.');
    }

    // Request readwrite up front: showDirectoryPicker() defaults to read-only access, and every
    // write path here (writeTextFile, and commitAll's git.add/remove/commit writing .git/index,
    // objects, and refs) needs readwrite — without this, every write throws NotAllowedError.
    const directoryHandle = await getDirectoryPickerWindow().showDirectoryPicker({ mode: 'readwrite' });

    const fs = createBrowserFs(directoryHandle);

    try {
      await fs.promises.stat(`${VIRTUAL_REPO_ROOT}/.git`);
    } catch {
      throw new Error('The selected folder is not a git repository.');
    }

    return new RepositoryController(directoryHandle, fs);
  }

  get folderName(): string {
    return this.directoryHandle.name;
  }

  // Full-vault walk. This is unavoidably as expensive as the vault is large — there is no way
  // to know the status of everything without looking at everything at least once. Called once
  // right after opening a repository to establish the baseline that writeTextFile/commitAll then
  // maintain incrementally, avoiding the need to ever repeat this full walk during a session.
  async snapshot(): Promise<RepositorySnapshot> {
    const statusMatrix = await git
      .statusMatrix({ fs: this.fs, dir: VIRTUAL_REPO_ROOT, cache: this.cache })
      .catch(() => []);

    this.knownFiles.clear();
    for (const file of filesFromStatusMatrix(statusMatrix)) {
      this.knownFiles.add(file);
    }

    this.pendingChangesByPath.clear();
    for (const change of classifyPendingChanges(statusMatrix)) {
      this.pendingChangesByPath.set(change.filepath, change.changeType);
    }

    const history = await this.recentHistory();

    return {
      folderName: this.folderName,
      files: this.sortedFiles(),
      history,
      pendingChanges: this.sortedPendingChanges(),
    };
  }

  async recentHistory(): Promise<RepositoryHistoryEntry[]> {
    return git
      .log({ fs: this.fs, dir: VIRTUAL_REPO_ROOT, depth: HISTORY_DEPTH, cache: this.cache })
      .then((entries) =>
        entries.map((entry) => ({
          oid: entry.oid,
          message: entry.commit.message.trim(),
          authorName: entry.commit.author.name,
          authorEmail: entry.commit.author.email,
          committedAt: new Date(entry.commit.committer.timestamp * 1000).toLocaleString(),
        }))
      )
      .catch(() => []);
  }

  async readTextFile(path: string): Promise<string> {
    const normalizedPath = normalizeEditableRepositoryPath(path);
    const content = await this.fs.promises.readFile(toVirtualPath(normalizedPath), { encoding: 'utf8' });
    return typeof content === 'string' ? content : new TextDecoder().decode(content);
  }

  async writeTextFile(path: string, content: string): Promise<RepositoryWriteResult> {
    const normalizedPath = normalizeEditableRepositoryPath(path);
    await this.fs.promises.writeFile(toVirtualPath(normalizedPath), content, { encoding: 'utf8' });

    // Re-check only the one file we just touched, not the whole vault: isomorphic-git's
    // statusMatrix prunes its walk to directories that could contain a requested filepath, so
    // this costs roughly "path depth", not "vault size" — see the module-level comment on
    // refreshOne for the full explanation.
    await this.refreshOne(normalizedPath);

    return {
      filepath: normalizedPath,
      files: this.sortedFiles(),
      pendingChanges: this.sortedPendingChanges(),
    };
  }

  // Scoped statusMatrix walk for exactly one path. isomorphic-git's internal tree walker
  // (`_walk`) stops recursing into a directory the moment it doesn't match any requested
  // filepath (see `worthWalking`), so — unlike the unscoped call in snapshot() — this only
  // touches the directories on the path from the repo root down to `filepath`'s parent, not
  // the entire vault.
  private async refreshOne(filepath: string): Promise<void> {
    const statusMatrix = await git.statusMatrix({
      fs: this.fs,
      dir: VIRTUAL_REPO_ROOT,
      cache: this.cache,
      filepaths: [filepath],
    });

    const [change] = classifyPendingChanges(statusMatrix);
    if (change) {
      this.pendingChangesByPath.set(change.filepath, change.changeType);
    } else {
      this.pendingChangesByPath.delete(filepath);
    }

    const stillExistsInWorkdir = statusMatrix.some(([, , worktreeStatus]) => worktreeStatus !== 0);
    if (stillExistsInWorkdir) {
      this.knownFiles.add(filepath);
    } else {
      this.knownFiles.delete(filepath);
    }
  }

  async commitAll(message: string, authorName: string, authorEmail: string): Promise<RepositoryCommitResult> {
    const trimmedMessage = message.trim();
    const trimmedAuthorName = authorName.trim();
    const trimmedAuthorEmail = authorEmail.trim();

    if (!trimmedMessage) {
      throw new Error('Enter a commit message before committing.');
    }

    if (!trimmedAuthorName || !trimmedAuthorEmail) {
      throw new Error('Enter an author name and email before committing.');
    }

    // No statusMatrix walk here at all (scoped or otherwise): pendingChangesByPath is already
    // accurate, maintained incrementally by writeTextFile since the last full walk in snapshot().
    if (this.pendingChangesByPath.size === 0) {
      throw new Error('No working tree changes were found to commit.');
    }

    const changes: RepositoryChange[] = [...this.pendingChangesByPath].map(([filepath, changeType]) => ({
      filepath,
      changeType,
    }));

    const addedOrModifiedPaths = changes
      .filter((change) => change.changeType !== 'deleted')
      .map((change) => change.filepath);

    if (addedOrModifiedPaths.length > 0) {
      // One index read-modify-write instead of one per file: git.add accepts an array, so N
      // changed files no longer means N separate round trips through the (slow) fs adapter.
      await git.add({ fs: this.fs, dir: VIRTUAL_REPO_ROOT, filepath: addedOrModifiedPaths, cache: this.cache });
    }

    for (const change of changes) {
      if (change.changeType === 'deleted') {
        // git.remove only accepts a single filepath (unlike git.add), so deletions stay per-file.
        await git.remove({ fs: this.fs, dir: VIRTUAL_REPO_ROOT, filepath: change.filepath, cache: this.cache });
        this.knownFiles.delete(change.filepath);
      }
    }

    const oid = await git.commit({
      fs: this.fs,
      dir: VIRTUAL_REPO_ROOT,
      message: trimmedMessage,
      author: {
        name: trimmedAuthorName,
        email: trimmedAuthorEmail,
      },
      cache: this.cache,
    });

    // Committing only writes to .git/ (objects, index, refs), never the working tree, and every
    // tracked pending change is now committed — so knownFiles is still accurate as-is (deletions
    // already removed above) and pendingChangesByPath is simply empty.
    this.pendingChangesByPath.clear();

    return {
      oid,
      files: this.sortedFiles(),
      pendingChanges: [],
    };
  }

  private sortedFiles(): string[] {
    return [...this.knownFiles].sort((left, right) => left.localeCompare(right));
  }

  private sortedPendingChanges(): RepositoryChange[] {
    return [...this.pendingChangesByPath.entries()]
      .map(([filepath, changeType]) => ({ filepath, changeType }))
      .sort((left, right) => left.filepath.localeCompare(right.filepath));
  }
}

function filesFromStatusMatrix(statusMatrix: Awaited<ReturnType<typeof git.statusMatrix>>): string[] {
  return statusMatrix
    .filter(([, , worktreeStatus]) => worktreeStatus !== 0)
    .map(([filepath]) => filepath)
    .sort((left, right) => left.localeCompare(right));
}

function classifyPendingChanges(statusMatrix: Awaited<ReturnType<typeof git.statusMatrix>>): RepositoryChange[] {
  const changes: RepositoryChange[] = [];

  for (const [filepath, headStatus, worktreeStatus, stageStatus] of statusMatrix) {
    if (headStatus === worktreeStatus && worktreeStatus === stageStatus) {
      continue;
    }

    changes.push({
      filepath,
      changeType: worktreeStatus === 0 ? 'deleted' : headStatus === 0 ? 'added' : 'modified',
    });
  }

  return changes;
}

function createBrowserFs(directoryHandle: FileSystemDirectoryHandle): BrowserFs {
  return {
    promises: {
      async readFile(path, options) {
        const fileHandle = await getFileHandle(directoryHandle, path);
        const file = await fileHandle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const encoding = normalizeEncoding(options);
        return encoding ? new TextDecoder(encoding).decode(bytes) : bytes;
      },
      async writeFile(path, data, options) {
        const { parentHandle, entryName } = await getParentDirectoryHandle(directoryHandle, path, true);
        const fileHandle = await parentHandle.getFileHandle(entryName, { create: true });
        const writable = await fileHandle.createWritable();
        const encoding = normalizeEncoding(options);
        const contents = typeof data === 'string' ? data : toUint8Array(data);

        const writeChunk =
          typeof contents === 'string'
            ? contents
            : encoding
              ? new TextDecoder(encoding).decode(contents)
              : new Blob([toArrayBuffer(contents)]);

        await writable.write(writeChunk);
        await writable.close();
      },
      async mkdir(path) {
        await getDirectoryHandle(directoryHandle, path, true);
      },
      async rmdir(path, options) {
        const segments = normalizeVirtualPath(path);
        const entryName = segments.pop();
        if (!entryName) {
          throw createFsError('EINVAL', path, 'Cannot remove the repository root.');
        }

        const parentHandle = await getDirectoryHandleBySegments(directoryHandle, segments, false);
        await parentHandle.removeEntry(entryName, { recursive: Boolean(options?.recursive) });
      },
      async unlink(path) {
        const segments = normalizeVirtualPath(path);
        const entryName = segments.pop();
        if (!entryName) {
          throw createFsError('EINVAL', path, 'Cannot remove the repository root.');
        }

        const parentHandle = await getDirectoryHandleBySegments(directoryHandle, segments, false);
        await parentHandle.removeEntry(entryName);
      },
      async stat(path) {
        return getStats(directoryHandle, path);
      },
      async lstat(path) {
        return getStats(directoryHandle, path);
      },
      async readdir(path) {
        const handle = await getDirectoryHandle(directoryHandle, path, false);
        const names: string[] = [];
        for await (const entry of handle.values()) {
          names.push(entry.name);
        }
        return names.sort((left, right) => left.localeCompare(right));
      },
      async readlink(path) {
        throw createFsError('ENOSYS', path, 'Symbolic links are not supported by the File System Access API.');
      },
      async symlink(_target, path) {
        throw createFsError('ENOSYS', path, 'Symbolic links are not supported by the File System Access API.');
      },
    },
  };
}

async function getStats(directoryHandle: FileSystemDirectoryHandle, path: string): Promise<FsStats> {
  const normalizedPath = normalizeVirtualPath(path);

  if (normalizedPath.length === 0) {
    return createStats('directory', 0, Date.now(), 0o040000);
  }

  // Try file first: a real repo has vastly more files than directories, so this halves the
  // File System Access API call count for the common case (each attempt walks from the root
  // through every path segment, so trying the wrong type first isn't just "one extra call" —
  // it's a second full root-to-parent traversal). Pass a copy of normalizedPath since
  // getFileHandleBySegments mutates its argument via `.pop()`.
  try {
    const fileHandle = await getFileHandleBySegments(directoryHandle, [...normalizedPath]);
    const file = await fileHandle.getFile();
    return createStats('file', file.size, file.lastModified, 0o100644);
  } catch (fileError) {
    try {
      await getDirectoryHandleBySegments(directoryHandle, normalizedPath, false);
      return createStats('directory', 0, Date.now(), 0o040000);
    } catch {
      throw fileError;
    }
  }
}

function createStats(type: 'file' | 'directory' | 'symlink', size: number, modifiedAt: number, mode: number): FsStats {
  return {
    size,
    mode,
    mtimeMs: modifiedAt,
    ctimeMs: modifiedAt,
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
    isSymbolicLink: () => type === 'symlink',
  };
}

async function getParentDirectoryHandle(
  directoryHandle: FileSystemDirectoryHandle,
  path: string,
  create: boolean
): Promise<{ parentHandle: FileSystemDirectoryHandle; entryName: string }> {
  const segments = normalizeVirtualPath(path);
  const entryName = segments.pop();

  if (!entryName) {
    throw createFsError('EINVAL', path, 'A file name is required.');
  }

  const parentHandle = await getDirectoryHandleBySegments(directoryHandle, segments, create);
  return { parentHandle, entryName };
}

async function getDirectoryHandle(
  directoryHandle: FileSystemDirectoryHandle,
  path: string,
  create: boolean
): Promise<FileSystemDirectoryHandle> {
  const segments = normalizeVirtualPath(path);
  return getDirectoryHandleBySegments(directoryHandle, segments, create);
}

async function getDirectoryHandleBySegments(
  directoryHandle: FileSystemDirectoryHandle,
  segments: string[],
  create: boolean
): Promise<FileSystemDirectoryHandle> {
  let currentHandle = directoryHandle;

  for (const segment of segments) {
    try {
      currentHandle = await currentHandle.getDirectoryHandle(segment, { create });
    } catch (error) {
      throw toFsError(error, segment);
    }
  }

  return currentHandle;
}

async function getFileHandle(directoryHandle: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
  return getFileHandleBySegments(directoryHandle, normalizeVirtualPath(path));
}

async function getFileHandleBySegments(
  directoryHandle: FileSystemDirectoryHandle,
  segments: string[]
): Promise<FileSystemFileHandle> {
  const entryName = segments.pop();

  if (!entryName) {
    throw createFsError('EISDIR', VIRTUAL_REPO_ROOT, 'Expected a file path.');
  }

  const parentHandle = await getDirectoryHandleBySegments(directoryHandle, segments, false);

  try {
    return await parentHandle.getFileHandle(entryName, { create: false });
  } catch (error) {
    throw toFsError(error, entryName);
  }
}

function normalizeEncoding(options: FsReadOptions | FsWriteOptions | undefined): FsEncoding | null {
  if (!options) {
    return null;
  }

  if (typeof options === 'string') {
    return options;
  }

  return options.encoding ?? null;
}

function getDirectoryPickerWindow(): Window &
  typeof globalThis & {
    showDirectoryPicker(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
  } {
  return window as Window &
    typeof globalThis & {
      showDirectoryPicker(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
    };
}

function normalizeVirtualPath(path: string): string[] {
  const normalizedPath = stripVirtualRoot(path).replaceAll('\\', '/');
  const segments: string[] = [];

  for (const segment of normalizedPath.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }

    if (segment === '..') {
      throw createFsError('EINVAL', path, 'Parent-directory traversal is not allowed.');
    }

    segments.push(segment);
  }

  return segments;
}

function normalizeEditableRepositoryPath(path: string): string {
  const segments = normalizeVirtualPath(path);

  if (segments.length === 0) {
    throw createFsError('EINVAL', path, 'Enter a relative file path inside the repository.');
  }

  // Case-insensitive: on the default filesystems for macOS (APFS) and Windows (NTFS/exFAT),
  // ".GIT" and ".git" resolve to the same directory, so the guard must match either.
  if (segments[0].toLowerCase() === '.git') {
    throw createFsError('EACCES', path, 'Editing files inside .git is not allowed.');
  }

  return segments.join('/');
}

function toVirtualPath(repositoryPath: string): string {
  return `${VIRTUAL_REPO_ROOT}/${normalizeEditableRepositoryPath(repositoryPath)}`;
}

function stripVirtualRoot(path: string): string {
  const normalizedPath = path.replaceAll('\\', '/');

  if (normalizedPath === VIRTUAL_REPO_ROOT) {
    return '';
  }

  if (normalizedPath.startsWith(`${VIRTUAL_REPO_ROOT}/`)) {
    return normalizedPath.slice(VIRTUAL_REPO_ROOT.length + 1);
  }

  if (!normalizedPath.startsWith('/')) {
    return normalizedPath;
  }

  throw createFsError('EINVAL', path, `Paths must stay inside ${VIRTUAL_REPO_ROOT}.`);
}

function toUint8Array(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function toFsError(error: unknown, path: string): FsError {
  // DOMException must be checked before the generic "already has .code" passthrough below:
  // every DOMException inherits a numeric legacy `.code` (e.g. NotFoundError -> 8), so the
  // passthrough would otherwise match first and hand isomorphic-git a numeric code where it
  // expects a string like 'ENOENT' — isomorphic-git's own error handling (e.g. FileSystem.lstat's
  // `err.code === 'ENOENT'` check that lets it treat a missing file as "not found" rather than a
  // hard failure) then silently fails to recognize it, causing operations like the first commit on
  // a freshly-initialized repo (before `.git/index` exists) to throw instead of finding an empty index.
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotFoundError':
        return createFsError('ENOENT', path, error.message);
      case 'TypeMismatchError':
        return createFsError('ENOTDIR', path, error.message);
      case 'NotAllowedError':
        return createFsError('EACCES', path, error.message);
      default:
        return createFsError('EIO', path, error.message);
    }
  }

  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return error as FsError;
  }

  return createFsError('EIO', path, error instanceof Error ? error.message : 'Unknown file system error.');
}

function createFsError(code: string, path: string, message: string): FsError {
  const error = new Error(message) as FsError;
  error.code = code;
  error.name = 'FileSystemAccessError';
  error.message = `${message} (${path})`;
  return error;
}
