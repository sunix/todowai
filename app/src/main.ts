import './style.css';
import { topLevelFolders } from './file-tree';
import {
  commitAll,
  fetchConfiguredRemotes,
  fetchConflict,
  fetchSnapshot,
  fetchSyncStatus,
  readFile,
  resolveConflict,
  setRemote,
  syncPull,
  syncPush,
  writeFile,
  type ConfiguredRemote,
  type ConflictInfo,
  type ConflictSide,
  type SyncStatus,
} from './repository';
import { SCREENS, currentScreen, navigateTo, onRouteChange } from './router';
import {
  escapeHtml,
  renderCaptureScreen,
  renderNotebookScreen,
  renderScreen,
  renderSettingsScreen,
  type CaptureDraft,
  type CapturedNote,
  type DraftType,
} from './screens';

// Captures are a draft concept, not vault content — see CapturedNote's doc comment in
// screens.ts — so they live in the browser only, not the backend. localStorage (rather than
// plain in-memory state) means a quick capture survives an accidental reload instead of just
// vanishing, which would defeat the point of a "quick capture" tool.
const CAPTURES_STORAGE_KEY = 'todowai:captures';

function loadCaptures(): CapturedNote[] {
  try {
    const raw = localStorage.getItem(CAPTURES_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as CapturedNote[]) : [];
  } catch {
    return [];
  }
}

function saveCaptures(captures: CapturedNote[]): void {
  try {
    localStorage.setItem(CAPTURES_STORAGE_KEY, JSON.stringify(captures));
  } catch {
    // Storage full or unavailable (e.g. private browsing) — captures still work for this
    // session, just won't survive a reload. Not worth surfacing as an error.
  }
}

// How often to poll the backend for sync status, purely to keep the sidebar indicator live —
// unrelated to the backend's own pull interval, which runs independently regardless of whether
// any browser tab is even open.
const SYNC_POLL_INTERVAL_MS = 15_000;

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="app-shell">
    <nav class="sidebar" id="sidebar">
      <div id="navlist"></div>
      <div class="sidebar-footer" id="syncIndicator"></div>
    </nav>
    <main id="main"></main>
  </div>
`;

const navlist = document.querySelector<HTMLElement>('#navlist')!;
const syncIndicator = document.querySelector<HTMLElement>('#syncIndicator')!;
const main = document.querySelector<HTMLElement>('#main')!;

type AppState = {
  folderName: string | null;
  subfolder: string;
  files: string[];
  selectedFilePath: string;
  selectedFileContent: string;
  history: import('./repository').RepositoryHistoryEntry[];
  pendingChanges: import('./repository').RepositoryChange[];
  expandedFolders: Set<string>;
  isBusy: boolean;
  busyLabel: string;
  statusMessage: string;
  errorMessage: string;
  commitAuthorName: string;
  commitAuthorEmail: string;
  commitMessage: string;
  remoteUrl: string;
  remoteUsername: string;
  remoteToken: string;
  configuredRemotes: ConfiguredRemote[];
  // "idle" only before the very first status fetch resolves. Runs independently of isBusy — a
  // background sync tick must never disable foreground actions like saving or committing.
  syncStatus: SyncStatus | 'idle';
  syncMessage: string;
  isSyncing: boolean;
  // Populated only while syncStatus is 'conflict' — see refreshSyncStatus. conflictChoices holds
  // the user's in-progress keep-mine/keep-theirs picks, keyed by file path, before "Resolve and
  // sync" is clicked.
  conflict: ConflictInfo | null;
  conflictChoices: Record<string, ConflictSide>;
  captures: CapturedNote[];
  draft: CaptureDraft | null;
};

const state: AppState = {
  folderName: null,
  subfolder: '',
  files: [],
  selectedFilePath: '',
  selectedFileContent: '',
  history: [],
  pendingChanges: [],
  expandedFolders: new Set(),
  isBusy: false,
  busyLabel: '',
  statusMessage: '',
  errorMessage: '',
  // These are form fields the user types into. They must live in AppState (not just the DOM)
  // because render() rebuilds the whole screen via innerHTML on every repository action —
  // selecting a different file to preview, for instance — which would otherwise silently
  // wipe out a commit message/author the user already typed, letting a commit go through
  // with the wrong message without any warning.
  commitAuthorName: 'Todowai User',
  commitAuthorEmail: 'todowai@example.invalid',
  commitMessage: 'feat: update Todowai note',
  remoteUrl: '',
  remoteUsername: '',
  remoteToken: '',
  configuredRemotes: [],
  syncStatus: 'idle',
  syncMessage: 'Checking sync status…',
  isSyncing: false,
  conflict: null,
  conflictChoices: {},
  captures: loadCaptures(),
  draft: null,
};

navlist.innerHTML = SCREENS.map(
  (screen) => `<button data-screen="${screen.id}"><span class="icon">${screen.icon}</span> ${screen.label}</button>`
).join('');

navlist.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-screen]');
  if (button) navigateTo(button.dataset.screen as never);
});

function render(): void {
  const screen = currentScreen();
  main.innerHTML =
    screen === 'settings'
      ? renderSettingsScreen({
          folderName: state.folderName,
          subfolder: state.subfolder,
          files: state.files,
          selectedFilePath: state.selectedFilePath,
          selectedFileContent: state.selectedFileContent,
          history: state.history,
          pendingChanges: state.pendingChanges,
          expandedFolders: state.expandedFolders,
          isBusy: state.isBusy,
          busyLabel: state.busyLabel,
          statusMessage: state.statusMessage,
          errorMessage: state.errorMessage,
          commitAuthorName: state.commitAuthorName,
          commitAuthorEmail: state.commitAuthorEmail,
          commitMessage: state.commitMessage,
          remoteUrl: state.remoteUrl,
          remoteUsername: state.remoteUsername,
          remoteToken: state.remoteToken,
          configuredRemotes: state.configuredRemotes,
          conflict: state.conflict,
          conflictChoices: state.conflictChoices,
        })
      : screen === 'notebook'
        ? renderNotebookScreen({
            subfolder: state.subfolder,
            files: state.files,
            selectedFilePath: state.selectedFilePath,
            selectedFileContent: state.selectedFileContent,
            expandedFolders: state.expandedFolders,
            isBusy: state.isBusy,
            busyLabel: state.busyLabel,
            statusMessage: state.statusMessage,
            errorMessage: state.errorMessage,
          })
        : screen === 'capture'
          ? renderCaptureScreen({
              captures: state.captures,
              draft: state.draft,
              isBusy: state.isBusy,
              busyLabel: state.busyLabel,
              statusMessage: state.statusMessage,
              errorMessage: state.errorMessage,
            })
          : renderScreen(screen);
  navlist.querySelectorAll<HTMLButtonElement>('button[data-screen]').forEach((button) => {
    button.classList.toggle('active', button.dataset.screen === screen);
  });

  if (screen === 'settings') {
    bindSettingsScreen();
  } else if (screen === 'notebook') {
    bindNotebookScreen();
  } else if (screen === 'capture') {
    bindCaptureScreen();
  }
}

function renderSyncIndicator(): void {
  // "No remote configured." is technically SyncStatus::Error on the backend (there's nothing
  // else for pull/push to return when there's nothing to sync against), but a fresh, never-
  // configured app showing an alarming red error dot by default would be misleading — treat
  // this one specific, expected message as the neutral state instead of a real error.
  const isUnconfigured = state.syncMessage === 'No remote configured.';
  const dotClass = state.syncStatus === 'idle' || isUnconfigured ? '' : ` sync-dot-${state.syncStatus}`;
  // A conflict can't be fixed by just retrying pull/push again — send the user to the
  // resolution card in Settings instead of a "Sync now" that would just conflict again.
  const isConflict = state.syncStatus === 'conflict';
  syncIndicator.innerHTML = `
    <div class="sync-row">
      <span class="sync-dot${dotClass}" aria-hidden="true"></span>
      <span>${escapeHtml(state.syncMessage)}</span>
    </div>
    <button class="primary-button sync-now-button" id="syncNowButton" ${state.isSyncing ? 'disabled' : ''}>
      ${isConflict ? 'Resolve in Settings' : 'Sync now'}
    </button>
  `;
  syncIndicator.querySelector<HTMLButtonElement>('#syncNowButton')?.addEventListener('click', () => {
    if (isConflict) {
      navigateTo('settings');
      return;
    }
    void handleSyncNow();
  });
}

onRouteChange(render);
render();
renderSyncIndicator();

// There's nothing to "open" any more — the backend already owns the vault (mounted via Docker
// at startup) — so this loads automatically once on startup, rather than waiting for a picker
// button click like the superseded browser-only flow did.
void loadSnapshot('Connecting to backend…');

// Configured remotes reflect static .git/config content, not something this app's own actions
// change, so a single fetch on startup is enough — no need to re-poll like sync status does.
void fetchConfiguredRemotes()
  .then((remotes) => {
    state.configuredRemotes = remotes;
    render();
  })
  .catch(() => {
    // No remotes configured, or the backend couldn't read them — the Remote URL field just
    // won't offer suggestions, which is a fine, quiet fallback.
  });

// The sync indicator is global (every screen, per the mockup's sidebar-footer placement) and
// runs independently of any screen's own load/busy state — polled here rather than tied to
// route changes, since the backend's own pull loop keeps syncing regardless of what's on screen.
void refreshSyncStatus();
setInterval(() => {
  void refreshSyncStatus();
}, SYNC_POLL_INTERVAL_MS);

async function refreshSyncStatus(): Promise<void> {
  // Captured before updating state, so a full re-render of Settings (below) only happens when
  // the conflict actually changes — not on every 15s poll tick, which would otherwise disrupt
  // whatever the user might be typing elsewhere on that screen.
  const previousConflictFiles = state.conflict?.files.join('\n') ?? null;

  try {
    const result = await fetchSyncStatus();
    state.syncStatus = result.status;
    state.syncMessage = result.message;
  } catch (error) {
    state.syncStatus = 'error';
    state.syncMessage = error instanceof Error ? error.message : 'Could not reach the backend.';
  }

  if (state.syncStatus === 'conflict') {
    state.conflict = await fetchConflict().catch(() => null);
  } else {
    state.conflict = null;
    state.conflictChoices = {};
  }

  renderSyncIndicator();

  const currentConflictFiles = state.conflict?.files.join('\n') ?? null;
  if (currentScreen() === 'settings' && currentConflictFiles !== previousConflictFiles) {
    render();
  }
}

// Pull then push, mirroring what the background scheduler already does on its own — this is
// just an on-demand trigger for the same two operations. Skips the push if the pull didn't
// succeed (offline/conflict/error): pushing on top of a failed pull isn't useful, and its
// result would just overwrite the more informative pull failure in the indicator.
async function handleSyncNow(): Promise<void> {
  state.isSyncing = true;
  renderSyncIndicator();

  try {
    const pullResult = await syncPull();
    state.syncStatus = pullResult.status;
    state.syncMessage = pullResult.message;
    renderSyncIndicator();

    if (pullResult.status === 'synced') {
      const pushResult = await syncPush(true);
      state.syncStatus = pushResult.status;
      state.syncMessage = pushResult.message;
    }
  } catch (error) {
    state.syncStatus = 'error';
    state.syncMessage = error instanceof Error ? error.message : 'Sync failed.';
  } finally {
    if (state.syncStatus === 'conflict') {
      state.conflict = await fetchConflict().catch(() => null);
    } else {
      state.conflict = null;
      state.conflictChoices = {};
    }
    state.isSyncing = false;
    renderSyncIndicator();
    // An explicit, user-initiated action, unlike the background poll — safe to fully re-render
    // Settings right away so a newly-discovered conflict's resolution card shows up immediately.
    if (currentScreen() === 'settings') {
      render();
    }
  }
}

function bindSettingsScreen(): void {
  main.querySelector<HTMLButtonElement>('#refresh-repo-button')?.addEventListener('click', async () => {
    await loadSnapshot('Refreshing from backend…');
  });

  main.querySelector<HTMLInputElement>('#remote-url')?.addEventListener('input', (event) => {
    state.remoteUrl = (event.target as HTMLInputElement).value;
  });

  main.querySelector<HTMLInputElement>('#remote-username')?.addEventListener('input', (event) => {
    state.remoteUsername = (event.target as HTMLInputElement).value;
  });

  main.querySelector<HTMLInputElement>('#remote-token')?.addEventListener('input', (event) => {
    state.remoteToken = (event.target as HTMLInputElement).value;
  });

  main.querySelector<HTMLButtonElement>('#save-remote-button')?.addEventListener('click', async () => {
    const trimmedUrl = state.remoteUrl.trim();
    await runRepositoryAction('Saving remote settings…', async () => {
      await setRemote(trimmedUrl ? { url: trimmedUrl, username: state.remoteUsername, token: state.remoteToken } : null);
      state.statusMessage = trimmedUrl ? 'Remote settings saved.' : 'Remote cleared.';
    });
    await refreshSyncStatus();
  });

  main.querySelectorAll<HTMLInputElement>('[data-conflict-file]').forEach((input) => {
    input.addEventListener('change', () => {
      const file = input.dataset.conflictFile;
      if (!file) {
        return;
      }
      state.conflictChoices[file] = input.value as ConflictSide;
      // Purely local UI state (the pick isn't sent until "Resolve and sync") — no repository
      // I/O, so this bypasses runRepositoryAction and just re-renders directly.
      render();
    });
  });

  main.querySelector<HTMLButtonElement>('#resolve-conflict-button')?.addEventListener('click', async () => {
    const conflict = state.conflict;
    if (!conflict) {
      return;
    }
    const resolutions = conflict.files.map((path) => ({
      path,
      keep: state.conflictChoices[path] ?? ('mine' as ConflictSide),
    }));

    await runRepositoryAction('Resolving conflict…', async (setLabel) => {
      const result = await resolveConflict(resolutions);
      state.syncStatus = result.status;
      state.syncMessage = result.message;
      state.conflict = result.status === 'conflict' ? await fetchConflict().catch(() => null) : null;
      state.conflictChoices = {};
      if (result.status === 'synced') {
        state.statusMessage = 'Conflict resolved and synced.';
      }

      // Resolving a conflict changes tracked file content on disk — refresh so the file
      // list/editor/history don't show stale pre-resolution state.
      setLabel('Loading updated files…');
      const snapshot = await fetchSnapshot();
      state.files = snapshot.files;
      state.history = snapshot.history;
      state.pendingChanges = snapshot.pendingChanges;
      if (state.selectedFilePath && state.files.includes(state.selectedFilePath)) {
        state.selectedFileContent = await readFile(state.selectedFilePath);
      }
    });
    renderSyncIndicator();
  });

  main.querySelectorAll<HTMLButtonElement>('[data-toggle-folder]').forEach((button) => {
    button.addEventListener('click', () => {
      const folderPath = button.dataset.toggleFolder;
      if (!folderPath) {
        return;
      }

      if (state.expandedFolders.has(folderPath)) {
        state.expandedFolders.delete(folderPath);
      } else {
        state.expandedFolders.add(folderPath);
      }
      // Purely local UI state — no repository I/O, so this bypasses runRepositoryAction
      // and just re-renders directly.
      render();
    });
  });

  main.querySelectorAll<HTMLButtonElement>('[data-file-path]').forEach((button) => {
    button.addEventListener('click', async () => {
      const filePath = button.dataset.filePath;
      if (!filePath) {
        return;
      }

      await runRepositoryAction('Loading file…', async () => {
        state.selectedFilePath = filePath;
        state.selectedFileContent = await readFile(filePath);
      });
    });
  });

  main.querySelector<HTMLButtonElement>('#save-file-button')?.addEventListener('click', async () => {
    const pathInput = main.querySelector<HTMLInputElement>('#repo-file-path');
    const contentInput = main.querySelector<HTMLTextAreaElement>('#repo-file-content');
    if (!pathInput || !contentInput) {
      return;
    }

    await runRepositoryAction('Saving…', async () => {
      const snapshot = await writeFile(pathInput.value, contentInput.value);
      state.selectedFilePath = pathInput.value;
      state.selectedFileContent = contentInput.value;
      state.files = snapshot.files;
      state.pendingChanges = snapshot.pendingChanges;
      state.statusMessage = `Saved ${pathInput.value}.`;
    });
  });

  main.querySelector<HTMLInputElement>('#commit-author-name')?.addEventListener('input', (event) => {
    state.commitAuthorName = (event.target as HTMLInputElement).value;
  });

  main.querySelector<HTMLInputElement>('#commit-author-email')?.addEventListener('input', (event) => {
    state.commitAuthorEmail = (event.target as HTMLInputElement).value;
  });

  main.querySelector<HTMLInputElement>('#commit-message')?.addEventListener('input', (event) => {
    state.commitMessage = (event.target as HTMLInputElement).value;
  });

  main.querySelector<HTMLButtonElement>('#commit-changes-button')?.addEventListener('click', async () => {
    await runRepositoryAction('Committing…', async (setLabel) => {
      const result = await commitAll(state.commitMessage, state.commitAuthorName, state.commitAuthorEmail);
      state.statusMessage = `Committed ${result.oid.slice(0, 7)}.`;

      // The commit endpoint doesn't return history (committing doesn't change which files
      // exist), so a full snapshot refresh picks that up along with anything else — cheap on
      // the backend, unlike the old browser engine's full-vault walks.
      setLabel('Loading history…');
      const snapshot = await fetchSnapshot();
      state.files = snapshot.files;
      state.history = snapshot.history;
      state.pendingChanges = snapshot.pendingChanges;
      if (state.selectedFilePath && !state.files.includes(state.selectedFilePath)) {
        // Rare: the selected file was itself deleted as part of this commit.
        state.selectedFilePath = state.files[0] ?? '';
        state.selectedFileContent = state.selectedFilePath ? await readFile(state.selectedFilePath) : '';
      }
    });
  });
}

// A path typed into "New note"/"New folder" is relative to the subfolder, not the vault root —
// but tolerate the user typing the subfolder name themselves (e.g. "todowai/backlog/idea.md")
// rather than silently double-prefixing it.
function resolveNotebookPath(subfolder: string, input: string): string {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, '');
  return trimmed === subfolder || trimmed.startsWith(`${subfolder}/`) ? trimmed : `${subfolder}/${trimmed}`;
}

function withMarkdownExtension(path: string): string {
  const lastSegment = path.split('/').pop() ?? '';
  return lastSegment.includes('.') ? path : `${path}.md`;
}

// Git never tracks an empty directory — a "new folder" only becomes real (durable across a
// restart/re-clone) once it has a file in it, so this is what "New folder" actually creates.
function starterNotePathForFolder(folderPath: string): string {
  return `${folderPath.replace(/\/+$/, '')}/untitled.md`;
}

function ancestorFolderPaths(filePath: string): string[] {
  const segments = filePath.split('/').slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

// Notebook shares its file-open state (selectedFilePath/selectedFileContent/files) with
// Settings' own file editor — both are views onto the same vault, not separate data — so
// opening/saving a note here is visible there too, and vice versa.
function bindNotebookScreen(): void {
  main.querySelectorAll<HTMLButtonElement>('[data-toggle-folder]').forEach((button) => {
    button.addEventListener('click', () => {
      const folderPath = button.dataset.toggleFolder;
      if (!folderPath) {
        return;
      }

      if (state.expandedFolders.has(folderPath)) {
        state.expandedFolders.delete(folderPath);
      } else {
        state.expandedFolders.add(folderPath);
      }
      render();
    });
  });

  main.querySelectorAll<HTMLButtonElement>('[data-file-path]').forEach((button) => {
    button.addEventListener('click', async () => {
      const filePath = button.dataset.filePath;
      if (!filePath) {
        return;
      }

      await runRepositoryAction('Loading file…', async () => {
        state.selectedFilePath = filePath;
        state.selectedFileContent = await readFile(filePath);
      });
    });
  });

  main.querySelector<HTMLButtonElement>('#notebook-save-button')?.addEventListener('click', async () => {
    const contentInput = main.querySelector<HTMLTextAreaElement>('#notebook-file-content');
    if (!contentInput || !state.selectedFilePath) {
      return;
    }

    await runRepositoryAction('Saving…', async () => {
      const snapshot = await writeFile(state.selectedFilePath, contentInput.value);
      state.selectedFileContent = contentInput.value;
      state.files = snapshot.files;
      state.pendingChanges = snapshot.pendingChanges;
      state.statusMessage = `Saved ${state.selectedFilePath}.`;
    });
  });

  main.querySelector<HTMLButtonElement>('#notebook-new-note-button')?.addEventListener('click', async () => {
    const pathInput = main.querySelector<HTMLInputElement>('#notebook-new-path');
    const raw = pathInput?.value.trim();
    if (!raw) {
      return;
    }

    await runRepositoryAction('Creating note…', async () => {
      const path = withMarkdownExtension(resolveNotebookPath(state.subfolder, raw));
      if (state.files.includes(path)) {
        throw new Error(`A note already exists at ${path}.`);
      }

      const snapshot = await writeFile(path, '');
      state.files = snapshot.files;
      state.pendingChanges = snapshot.pendingChanges;
      ancestorFolderPaths(path).forEach((folder) => state.expandedFolders.add(folder));
      state.selectedFilePath = path;
      state.selectedFileContent = '';
      state.statusMessage = `Created ${path}.`;
    });
  });

  main.querySelector<HTMLButtonElement>('#notebook-new-folder-button')?.addEventListener('click', async () => {
    const pathInput = main.querySelector<HTMLInputElement>('#notebook-new-path');
    const raw = pathInput?.value.trim();
    if (!raw) {
      return;
    }

    await runRepositoryAction('Creating folder…', async () => {
      const folderPath = resolveNotebookPath(state.subfolder, raw);
      const path = starterNotePathForFolder(folderPath);
      if (state.files.includes(path)) {
        throw new Error(`"${folderPath}" already has an untitled.md note.`);
      }

      const snapshot = await writeFile(path, '');
      state.files = snapshot.files;
      state.pendingChanges = snapshot.pendingChanges;
      ancestorFolderPaths(path).forEach((folder) => state.expandedFolders.add(folder));
      state.selectedFilePath = path;
      state.selectedFileContent = '';
      state.statusMessage = `Created folder ${folderPath}.`;
    });
  });
}

function defaultDraftContent(type: DraftType, captureText: string): string {
  return `---\ntype: ${type}\nstatus: backlog\n---\n\n${captureText}`;
}

function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

// Appends a numeric suffix until landing on a path nothing already occupies, rather than
// silently overwriting an existing note that happens to share a title.
function uniqueFilePath(existingFiles: string[], folder: string, slug: string): string {
  let candidate = `${folder}/${slug}.md`;
  let suffix = 2;
  while (existingFiles.includes(candidate)) {
    candidate = `${folder}/${slug}-${suffix}.md`;
    suffix += 1;
  }
  return candidate;
}

function bindCaptureScreen(): void {
  main.querySelector<HTMLButtonElement>('#capture-save-button')?.addEventListener('click', () => {
    const input = main.querySelector<HTMLTextAreaElement>('#capture-input');
    const text = input?.value.trim();
    if (!text) {
      return;
    }

    // Newest first, matching "appears at the top of Recently Captured immediately" (#15's AC) —
    // no repository I/O at all, so this is a synchronous state update + re-render, not a
    // runRepositoryAction call.
    state.captures = [{ id: crypto.randomUUID(), text, capturedAt: new Date().toISOString() }, ...state.captures];
    saveCaptures(state.captures);
    render();
  });

  main.querySelector<HTMLButtonElement>('#capture-clear-button')?.addEventListener('click', () => {
    const input = main.querySelector<HTMLTextAreaElement>('#capture-input');
    if (input) {
      input.value = '';
    }
  });

  main.querySelectorAll<HTMLButtonElement>('[data-file-capture]').forEach((button) => {
    button.addEventListener('click', () => {
      const captureId = button.dataset.fileCapture;
      const capture = state.captures.find((entry) => entry.id === captureId);
      if (!capture) {
        return;
      }

      const type: DraftType = 'todo';
      state.draft = {
        captureId: capture.id,
        type,
        title: capture.text.slice(0, 48),
        content: defaultDraftContent(type, capture.text),
      };
      render();
    });
  });

  // Only the frontmatter's `type:` line is regenerated — the rest of the content stays exactly
  // as the user left it, so switching type after starting to edit doesn't clobber their work.
  main.querySelector<HTMLSelectElement>('#draft-type')?.addEventListener('change', (event) => {
    if (!state.draft) {
      return;
    }
    const newType = (event.target as HTMLSelectElement).value as DraftType;
    const contentInput = main.querySelector<HTMLTextAreaElement>('#draft-content');
    if (contentInput) {
      contentInput.value = contentInput.value.replace(/^type: \w+$/m, `type: ${newType}`);
    }
    state.draft = { ...state.draft, type: newType };
  });

  main.querySelector<HTMLButtonElement>('#draft-cancel-button')?.addEventListener('click', () => {
    state.draft = null;
    render();
  });

  main.querySelector<HTMLButtonElement>('#draft-save-button')?.addEventListener('click', async () => {
    const draft = state.draft;
    const titleInput = main.querySelector<HTMLInputElement>('#draft-title');
    const contentInput = main.querySelector<HTMLTextAreaElement>('#draft-content');
    if (!draft || !titleInput || !contentInput) {
      return;
    }

    const title = titleInput.value.trim() || 'Untitled';
    const content = contentInput.value;

    await runRepositoryAction('Saving to Notebook…', async () => {
      const path = uniqueFilePath(state.files, `${state.subfolder}/backlog`, slugifyTitle(title));
      const snapshot = await writeFile(path, content);
      state.files = snapshot.files;
      state.pendingChanges = snapshot.pendingChanges;
      state.captures = state.captures.filter((entry) => entry.id !== draft.captureId);
      saveCaptures(state.captures);
      state.draft = null;
      state.selectedFilePath = path;
      state.selectedFileContent = content;
      state.statusMessage = `Saved to Notebook: ${path}.`;
    });
  });
}

async function loadSnapshot(busyLabel: string): Promise<void> {
  await runRepositoryAction(busyLabel, async () => {
    const snapshot = await fetchSnapshot();
    state.folderName = snapshot.folderName;
    state.subfolder = snapshot.subfolder;
    state.files = snapshot.files;
    state.history = snapshot.history;
    state.pendingChanges = snapshot.pendingChanges;
    state.selectedFilePath = snapshot.files[0] ?? '';
    state.selectedFileContent = state.selectedFilePath ? await readFile(state.selectedFilePath) : '';

    // Auto-expand first-level folders so a freshly loaded vault shows some content
    // immediately, rather than a flat list of collapsed top-level entries.
    state.expandedFolders = new Set(topLevelFolders(state.files));
    state.statusMessage = `Connected to ${state.folderName}.`;
  });
}

async function runRepositoryAction(
  label: string,
  action: (setLabel: (nextLabel: string) => void) => Promise<void>
): Promise<void> {
  state.errorMessage = '';
  state.statusMessage = '';
  state.isBusy = true;
  state.busyLabel = label;
  // Paint the busy state immediately — without this render(), the UI would stay on its
  // previous frame until `action` resolves, since nothing yields back to the browser
  // between setting isBusy and the await below.
  render();

  const setLabel = (nextLabel: string) => {
    state.busyLabel = nextLabel;
    render();
  };

  try {
    await action(setLabel);
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : 'Unexpected repository error.';
  } finally {
    state.isBusy = false;
    state.busyLabel = '';
    render();
  }
}
