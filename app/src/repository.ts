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

export type SyncStatus = 'synced' | 'offline' | 'conflict' | 'error';

export type SyncResult = {
  status: SyncStatus;
  message: string;
};

export type RemoteConfig = {
  url: string;
  username: string;
  token: string;
};

export type ConfiguredRemote = {
  name: string;
  url: string;
};

// Files a real 3-way merge couldn't reconcile on its own (see backend/src/repository.rs,
// PullOutcome::Conflict) and still need a keep-mine/keep-theirs decision via resolveConflict.
export type ConflictInfo = {
  files: string[];
};

export type ConflictSide = 'mine' | 'theirs';

export type ConflictResolution = {
  path: string;
  keep: ConflictSide;
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

export async function fetchSyncStatus(): Promise<SyncResult> {
  return requestJson<SyncResult>('/sync/status');
}

// `null` clears the configured remote (matches the backend's PUT /api/sync/remote semantics —
// an empty URL is treated the same way, but sending null is unambiguous over the wire).
export async function setRemote(remote: RemoteConfig | null): Promise<void> {
  const response = await fetch(`${API_BASE}/sync/remote`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(remote),
  });
  if (!response.ok) {
    throw new Error(await errorMessageFrom(response));
  }
}

export async function syncPull(): Promise<SyncResult> {
  return requestJson<SyncResult>('/sync/pull', { method: 'POST' });
}

export async function syncPush(immediate: boolean): Promise<SyncResult> {
  return requestJson<SyncResult>('/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ immediate }),
  });
}

// Remotes already configured in the vault's .git/config (e.g. origin) — surfaced as suggestions
// on the Remote URL field, not as the currently-active sync remote (that's fetchSyncStatus).
export async function fetchConfiguredRemotes(): Promise<ConfiguredRemote[]> {
  return requestJson<ConfiguredRemote[]>('/sync/remotes');
}

// `null` when the last pull/push merged cleanly (or nothing has run yet) — not every `conflict`
// SyncStatus implies this is populated (see the backend's own conflict_message), but polling
// this after seeing that status is how the UI gets the actual file list to act on.
export async function fetchConflict(): Promise<ConflictInfo | null> {
  return requestJson<ConflictInfo | null>('/sync/conflict');
}

export async function resolveConflict(resolutions: ConflictResolution[]): Promise<SyncResult> {
  return requestJson<SyncResult>('/sync/conflict/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolutions }),
  });
}

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'mistral' | 'groq' | 'ollama';

export type AiConfigView = {
  provider: AiProvider | null;
  model: string | null;
  baseUrl: string | null;
  configured: boolean;
};

export type AiConfigInput = {
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
};

export type AiClassification = {
  type: 'todo' | 'meeting' | 'status' | 'project';
  title: string;
  content: string;
};

export async function fetchAiConfig(): Promise<AiConfigView> {
  return requestJson<AiConfigView>('/ai/config');
}

// `null` clears the configured provider entirely — same convention as setRemote.
export async function setAiConfig(config: AiConfigInput | null): Promise<AiConfigView> {
  return requestJson<AiConfigView>('/ai/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      config
        ? {
            provider: config.provider,
            apiKey: config.apiKey,
            model: config.model.trim() ? config.model.trim() : null,
            baseUrl: config.baseUrl.trim() ? config.baseUrl.trim() : null,
          }
        : null
    ),
  });
}

export async function classifyCapture(text: string): Promise<AiClassification> {
  return requestJson<AiClassification>('/ai/classify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

// Queries the *saved* provider's model catalog (not whatever's typed but unsaved in the form) —
// surfaced as suggestions on the Model field, same pattern as fetchConfiguredRemotes.
export async function fetchAiModels(): Promise<string[]> {
  return requestJson<string[]>('/ai/models');
}

export type NextActionSuggestion = {
  suggestion: string;
};

// excludedSuggestions carries whatever's already been shown and rejected this Next Action
// session, so the backend can steer the model away from repeating them — see backend/src/ai.rs's
// build_suggestion_prompt.
export async function suggestNextAction(excludedSuggestions: string[]): Promise<NextActionSuggestion> {
  return requestJson<NextActionSuggestion>('/ai/suggest-next-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ excludedSuggestions }),
  });
}

// Merged, de-duplicated, and already filtered to upcoming-only by the backend (see
// backend/src/calendar.rs) — an empty array is the normal "no feeds configured yet" state, not
// an error, matching how the backend treats a missing calendars.json (#22/#23).
export type UpcomingEvent = {
  source: string;
  summary: string;
  start: string;
  end: string | null;
};

export async function fetchUpcomingEvents(): Promise<UpcomingEvent[]> {
  return requestJson<UpcomingEvent[]>('/calendar/upcoming');
}

// A read-only projection over whatever notes already carry `type: project` frontmatter (see
// backend/src/projects.rs) — the markdown stays the source of truth; editing a project's
// status/progress happens by editing its note directly in Notebook, not through this endpoint.
export type Project = {
  path: string;
  name: string;
  status: string;
  progress: number;
  meta: string;
};

export async function fetchProjects(): Promise<Project[]> {
  return requestJson<Project[]>('/projects');
}
