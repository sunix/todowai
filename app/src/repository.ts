// Thin HTTP client for the Rust backend (see backend/src/api.rs). Replaces the browser-only
// File System Access API + isomorphic-git engine from the now-superseded #10/#11/#12 — see
// specification/decisions.md, ADR-001. There's nothing to "open" here: the backend already
// owns the vault (mounted via a Docker volume at startup), so this module has no notion of a
// picker or a connection to establish, just requests against whatever the backend is currently
// serving. Requests use relative /api/... paths since the backend serves the built UI and the
// API from the same origin (see the Vite dev proxy in vite.config.ts for local development).

const API_BASE = '/api';

export type RepositoryChangeType = 'added' | 'modified' | 'deleted';

export type RepositoryChange = {
  filepath: string;
  changeType: RepositoryChangeType;
};

export type RepositoryHistoryEntry = {
  oid: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
};

export type RepositorySnapshot = {
  folderName: string;
  subfolder: string;
  files: string[];
  history: RepositoryHistoryEntry[];
  pendingChanges: RepositoryChange[];
};

export type RepositoryCommitResult = {
  oid: string;
  files: string[];
  pendingChanges: RepositoryChange[];
};

async function errorMessageFrom(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) {
      return body.error;
    }
  } catch {
    // Not a JSON error body — fall through to the generic message below.
  }
  return `Request failed with status ${response.status}.`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    throw new Error(await errorMessageFrom(response));
  }
  return response.json() as Promise<T>;
}

export async function fetchSnapshot(): Promise<RepositorySnapshot> {
  return requestJson<RepositorySnapshot>('/repository');
}

export async function readFile(path: string): Promise<string> {
  const response = await fetch(`${API_BASE}/repository/file?path=${encodeURIComponent(path)}`);
  if (!response.ok) {
    throw new Error(await errorMessageFrom(response));
  }
  return response.text();
}

export async function writeFile(path: string, content: string): Promise<RepositorySnapshot> {
  return requestJson<RepositorySnapshot>('/repository/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
}

export async function commitAll(
  message: string,
  authorName: string,
  authorEmail: string
): Promise<RepositoryCommitResult> {
  const trimmedMessage = message.trim();
  const trimmedAuthorName = authorName.trim();
  const trimmedAuthorEmail = authorEmail.trim();

  if (!trimmedMessage) {
    throw new Error('Enter a commit message before committing.');
  }
  if (!trimmedAuthorName || !trimmedAuthorEmail) {
    throw new Error('Enter an author name and email before committing.');
  }

  return requestJson<RepositoryCommitResult>('/repository/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: trimmedMessage,
      authorName: trimmedAuthorName,
      authorEmail: trimmedAuthorEmail,
    }),
  });
}
