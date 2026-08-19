import './style.css';
import { topLevelFolders } from './file-tree';
import {
  classifyCapture,
  commitAll,
  fetchAiConfig,
  fetchAiModels,
  fetchConfiguredRemotes,
  fetchConflict,
  fetchHorizonItems,
  fetchProjects,
  fetchSnapshot,
  fetchSyncStatus,
  fetchUpcomingEvents,
  readFile,
  resolveConflict,
  setAiConfig,
  setRemote,
  suggestHorizonReassignments,
  suggestNextAction,
  syncPull,
  syncPush,
  writeFile,
  type AiConfigView,
  type AiProvider,
  type ConfiguredRemote,
  type ConflictInfo,
  type ConflictSide,
  type HorizonItem,
  type HorizonReassignmentSuggestion,
  type HorizonValue,
  type Project,
  type SyncStatus,
  type UpcomingEvent,
} from './repository';
import { getFrontmatterValue, parseFrontmatter, serializeFrontmatter, setFrontmatterValue } from './frontmatter';
import { SCREENS, currentScreen, navigateTo, onRouteChange } from './router';
import {
  escapeHtml,
  renderCaptureScreen,
  renderHorizonScreen,
  renderNextActionScreen,
  renderNotebookScreen,
  renderProjectsScreen,
  renderScreen,
  renderSettingsScreen,
  type AttachDraft,
  type AttachOperation,
  type CalendarFeed,
  type CaptureDraft,
  type CapturedNote,
  type CurrentStatus,
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
  // The alternative AI-proposed outcome (#99): attaching to an existing note instead of filing
  // a new one. A single capture can produce several of these at once (#101) — e.g. checking off
  // one task and adding another — each independently editable/confirmable. Only "Let AI propose"
  // populates this (manual filing via "File it myself" always creates a new note, unchanged from
  // #16).
  attachDrafts: AttachDraft[];
  aiConfig: AiConfigView;
  aiProvider: AiProvider;
  aiApiKey: string;
  aiModel: string;
  aiBaseUrl: string;
  aiModels: string[];
  // The persistent current-status field (#19) — null until the user sets one for the first
  // time. isEditingStatus/statusEditKind/statusEditLabel/statusEditTaskPath are the in-progress
  // "Change status" form fields, separate from the saved value so opening the form to look at
  // it (or cancelling) never touches what's actually persisted.
  currentStatus: CurrentStatus | null;
  isEditingStatus: boolean;
  statusEditKind: CurrentStatus['kind'];
  statusEditLabel: string;
  statusEditTaskPath: string;
  // The AI next-todo suggestion engine (#20). suggestion is null until requested; rejected
  // holds every suggestion shown and turned down this session (cleared on Confirm), sent back
  // to the backend so it steers away from repeating them. todayPlan is the persistent list
  // Confirm appends to, stored the same way currentStatus is (a well-known synced file).
  suggestion: string | null;
  rejectedSuggestions: string[];
  todayPlan: string[];
  // Labeled calendar feed URLs (#22) — this array doubles as both the loaded-from-file state
  // and the in-progress edit draft (add/remove/rename all mutate it directly); "Save calendar
  // feeds" is the only thing that writes it back to the vault.
  calendarFeeds: CalendarFeed[];
  // Merged/de-duplicated/future-only already, courtesy of the backend (#23) — this is just
  // whatever GET /api/calendar/upcoming last returned (#24).
  upcomingEvents: UpcomingEvent[];
  // A read-only projection over `type: project` notes (#25) — editing status/progress happens
  // by editing the note itself in Notebook, not through this screen.
  projects: Project[];
  // A read-only projection over `type: todo`/`type: project` notes' `horizon:` field (#26) —
  // moving an item writes that field directly via the generic file endpoints, not through a
  // dedicated mutation route.
  horizonItems: HorizonItem[];
  // Priority order *within* a horizon column (#26 follow-up) — the backend has no notion of
  // this (HorizonItem carries no ordering field), so it's a small JSON manifest of
  // horizon -> ordered paths, loaded/saved the same way calendarFeeds is. A path missing from
  // its column's list (a note that existed before ordering was ever touched) sorts after every
  // explicitly-ordered one, in whatever order the backend returned it.
  horizonOrder: HorizonOrder;
  // AI-proposed reassignments (#27) — never applied on their own; Confirm writes the note's
  // `horizon:` field the same way a manual drag does, Dismiss just drops the suggestion from
  // this list, leaving the item untouched.
  horizonSuggestions: HorizonReassignmentSuggestion[];
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
  attachDrafts: [],
  aiConfig: { provider: null, model: null, baseUrl: null, configured: false },
  aiProvider: 'anthropic',
  aiApiKey: '',
  aiModel: '',
  aiBaseUrl: '',
  aiModels: [],
  currentStatus: null,
  isEditingStatus: false,
  statusEditKind: 'situational',
  statusEditLabel: '',
  statusEditTaskPath: '',
  suggestion: null,
  rejectedSuggestions: [],
  todayPlan: [],
  calendarFeeds: [],
  upcomingEvents: [],
  projects: [],
  horizonItems: [],
  horizonOrder: {},
  horizonSuggestions: [],
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
          aiConfig: state.aiConfig,
          aiProvider: state.aiProvider,
          aiApiKey: state.aiApiKey,
          aiModel: state.aiModel,
          aiBaseUrl: state.aiBaseUrl,
          aiModels: state.aiModels,
          calendarFeeds: state.calendarFeeds,
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
              attachDrafts: state.attachDrafts,
              notePaths: allNotePaths(state.files, state.subfolder),
              isBusy: state.isBusy,
              busyLabel: state.busyLabel,
              statusMessage: state.statusMessage,
              errorMessage: state.errorMessage,
              aiConfigured: state.aiConfig.configured,
            })
          : screen === 'next-action'
            ? renderNextActionScreen({
                status: state.currentStatus,
                isEditing: state.isEditingStatus,
                editKind: state.statusEditKind,
                editLabel: state.statusEditLabel,
                editTaskPath: state.statusEditTaskPath,
                taskPathSuggestions: taskPathSuggestions(state.files, state.subfolder),
                suggestion: state.suggestion,
                todayPlan: state.todayPlan,
                aiConfigured: state.aiConfig.configured,
                upcomingEvents: state.upcomingEvents,
                isBusy: state.isBusy,
                busyLabel: state.busyLabel,
                statusMessage: state.statusMessage,
                errorMessage: state.errorMessage,
              })
            : screen === 'projects'
              ? renderProjectsScreen({
                  projects: state.projects,
                  isBusy: state.isBusy,
                  busyLabel: state.busyLabel,
                  statusMessage: state.statusMessage,
                  errorMessage: state.errorMessage,
                })
              : screen === 'horizon'
                ? renderHorizonScreen({
                    items: orderedHorizonItems(state.horizonItems, state.horizonOrder),
                    suggestions: state.horizonSuggestions,
                    isBusy: state.isBusy,
                    busyLabel: state.busyLabel,
                    statusMessage: state.statusMessage,
                    errorMessage: state.errorMessage,
                    aiConfigured: state.aiConfig.configured,
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
  } else if (screen === 'next-action') {
    bindNextActionScreen();
  } else if (screen === 'projects') {
    bindProjectsScreen();
  } else if (screen === 'horizon') {
    bindHorizonScreen();
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
// Chained rather than fired in parallel — state.subfolder (needed to build the status file's
// path) is only known once the snapshot resolves.
void loadSnapshot('Connecting to backend…').then(() => {
  void refreshCurrentStatus();
  void refreshTodayPlan();
  void refreshCalendarFeeds();
  void refreshUpcomingEvents();
  void refreshProjects();
  void refreshHorizonItems();
  void refreshHorizonOrder();
});

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

// Queries the saved provider's model catalog — called on startup (if already configured) and
// again after every save, since a changed provider/base URL means a different catalog. Errors
// (provider unreachable, no config yet) just leave the Model field without suggestions, a fine
// quiet fallback rather than blocking the rest of Settings.
async function refreshAiModels(): Promise<void> {
  try {
    state.aiModels = await fetchAiModels();
  } catch {
    state.aiModels = [];
  }
  render();
}

// AI provider config reflects backend/env state, not something this app's own actions change —
// a single fetch on startup is enough, same rationale as configuredRemotes above.
void fetchAiConfig()
  .then((config) => {
    state.aiConfig = config;
    if (config.provider) {
      state.aiProvider = config.provider;
    }
    if (config.model) {
      state.aiModel = config.model;
    }
    if (config.baseUrl) {
      state.aiBaseUrl = config.baseUrl;
    }
    render();
    if (config.configured) {
      void refreshAiModels();
    }
  })
  .catch(() => {
    // Not configured yet, or the backend couldn't be reached — Capture's "Let AI propose"
    // button just stays disabled, which is a fine, quiet fallback.
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

  main.querySelector<HTMLSelectElement>('#ai-provider')?.addEventListener('change', (event) => {
    state.aiProvider = (event.target as HTMLSelectElement).value as AiProvider;
  });

  main.querySelector<HTMLInputElement>('#ai-api-key')?.addEventListener('input', (event) => {
    state.aiApiKey = (event.target as HTMLInputElement).value;
  });

  main.querySelector<HTMLInputElement>('#ai-model')?.addEventListener('input', (event) => {
    state.aiModel = (event.target as HTMLInputElement).value;
  });

  main.querySelector<HTMLInputElement>('#ai-base-url')?.addEventListener('input', (event) => {
    state.aiBaseUrl = (event.target as HTMLInputElement).value;
  });

  main.querySelector<HTMLButtonElement>('#save-ai-config-button')?.addEventListener('click', async () => {
    await runRepositoryAction('Saving AI settings…', async () => {
      state.aiConfig = await setAiConfig({
        provider: state.aiProvider,
        apiKey: state.aiApiKey,
        model: state.aiModel,
        baseUrl: state.aiBaseUrl,
      });
      state.statusMessage = 'AI settings saved.';
    });
    await refreshAiModels();
  });

  main.querySelector<HTMLButtonElement>('#clear-ai-config-button')?.addEventListener('click', async () => {
    await runRepositoryAction('Clearing AI settings…', async () => {
      state.aiConfig = await setAiConfig(null);
      state.aiApiKey = '';
      state.aiModels = [];
      state.statusMessage = 'AI settings cleared.';
    });
  });

  main.querySelectorAll<HTMLInputElement>('[data-calendar-label]').forEach((input) => {
    input.addEventListener('input', () => {
      const index = Number(input.dataset.calendarLabel);
      const feed = state.calendarFeeds[index];
      if (feed) {
        state.calendarFeeds[index] = { ...feed, label: input.value };
      }
    });
  });

  main.querySelectorAll<HTMLInputElement>('[data-calendar-url]').forEach((input) => {
    input.addEventListener('input', () => {
      const index = Number(input.dataset.calendarUrl);
      const feed = state.calendarFeeds[index];
      if (feed) {
        state.calendarFeeds[index] = { ...feed, url: input.value };
      }
    });
  });

  main.querySelector<HTMLButtonElement>('#add-calendar-button')?.addEventListener('click', () => {
    state.calendarFeeds = [...state.calendarFeeds, { label: '', url: '' }];
    render();
  });

  main.querySelectorAll<HTMLButtonElement>('[data-remove-calendar]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.removeCalendar);
      state.calendarFeeds = state.calendarFeeds.filter((_, feedIndex) => feedIndex !== index);
      render();
    });
  });

  main.querySelector<HTMLButtonElement>('#save-calendars-button')?.addEventListener('click', async () => {
    // Drops rows left completely blank (e.g. an added-then-unfilled row) rather than persisting
    // empty entries — a row with only one of label/url filled in is left alone, not validated.
    const feeds = state.calendarFeeds.filter((feed) => feed.label.trim() || feed.url.trim());
    await runRepositoryAction('Saving calendar feeds…', async () => {
      const snapshot = await writeFile(calendarFeedsFilePath(state.subfolder), serializeCalendarFeeds(feeds));
      state.files = snapshot.files;
      state.pendingChanges = snapshot.pendingChanges;
      state.calendarFeeds = feeds;
      state.statusMessage = 'Calendar feeds saved.';
    });
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
  return serializeFrontmatter({
    frontmatter: [
      ['type', type],
      ['status', 'backlog'],
    ],
    body: captureText,
  });
}

// Local date, not UTC — a capture's "day" should match what the user experienced, not shift
// across midnight depending on timezone. Matches the mockup's own note-naming convention
// (e.g. `2026-08-10-shipped-spec-pr.md`, `2026-08-11-conversation.md`).
function dateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

const STATUS_FILE_NAME = 'status.md';

function statusFilePath(subfolder: string): string {
  return `${subfolder}/${STATUS_FILE_NAME}`;
}

// backlog/doing only — a note already marked done isn't a sensible "what I'm doing right now"
// target. Just a suggestion list (the field stays free text, see renderNextActionScreen's
// <datalist>), so this doesn't need to read file contents to confirm each candidate is actually
// a `type: todo` note.
function taskPathSuggestions(files: string[], subfolder: string): string[] {
  return files.filter(
    (path) =>
      (path.startsWith(`${subfolder}/backlog/`) || path.startsWith(`${subfolder}/doing/`)) && path.endsWith('.md')
  );
}

// Every note inside the subfolder, any status folder — the AI-proposed attach target (#99) can
// be any existing note, not just a project or an active task.
function allNotePaths(files: string[], subfolder: string): string[] {
  const prefix = `${subfolder}/`;
  return files.filter((path) => path.startsWith(prefix) && path.endsWith('.md'));
}

function taskLabelFallback(taskPath: string): string {
  return (taskPath.split('/').pop() ?? taskPath).replace(/\.md$/, '');
}

// `kind: situational` or `kind: task` (plus `task: <path>` when linked) in the frontmatter,
// free-text label as the body — built on #18's shared parser. Malformed/unrecognized content
// (e.g. a `kind` that isn't one of the two known values) is treated the same as "not set yet"
// rather than crashing Next Action.
function parseStatus(content: string): CurrentStatus | null {
  const { frontmatter, body } = parseFrontmatter(content);
  const kind = getFrontmatterValue(frontmatter, 'kind');
  const label = body.trim();
  if (kind === 'situational') {
    return { kind: 'situational', label };
  }
  if (kind === 'task') {
    const taskPath = getFrontmatterValue(frontmatter, 'task');
    if (typeof taskPath === 'string' && taskPath) {
      return { kind: 'task', label, taskPath };
    }
  }
  return null;
}

function serializeStatus(status: CurrentStatus): string {
  const frontmatter: Array<[string, string]> =
    status.kind === 'task'
      ? [
          ['kind', 'task'],
          ['task', status.taskPath],
        ]
      : [['kind', 'situational']];
  return serializeFrontmatter({ frontmatter, body: status.label });
}

async function refreshCurrentStatus(): Promise<void> {
  try {
    const content = await readFile(statusFilePath(state.subfolder));
    state.currentStatus = parseStatus(content);
  } catch {
    // No status set yet (fresh vault) or the backend couldn't be reached — Next Action just
    // shows the empty state, the same quiet-fallback pattern as configuredRemotes/aiConfig.
    state.currentStatus = null;
  }
  render();
}

const TODAY_PLAN_FILE_NAME = 'today.md';

function todayPlanFilePath(subfolder: string): string {
  return `${subfolder}/${TODAY_PLAN_FILE_NAME}`;
}

// A single `items` list field via #18's frontmatter parser — no per-entry file, no date-bucket
// logic (out of scope here; see #20's AC, which only asks that Confirm adds to the list).
function parseTodayPlan(content: string): string[] {
  const { frontmatter } = parseFrontmatter(content);
  const items = getFrontmatterValue(frontmatter, 'items');
  return Array.isArray(items) ? items : [];
}

function serializeTodayPlan(items: string[]): string {
  return serializeFrontmatter({ frontmatter: [['items', items]], body: '' });
}

async function refreshTodayPlan(): Promise<void> {
  try {
    const content = await readFile(todayPlanFilePath(state.subfolder));
    state.todayPlan = parseTodayPlan(content);
  } catch {
    state.todayPlan = [];
  }
  render();
}

const CALENDAR_FEEDS_FILE_NAME = 'calendars.json';

function calendarFeedsFilePath(subfolder: string): string {
  return `${subfolder}/${CALENDAR_FEEDS_FILE_NAME}`;
}

// A plain JSON array (not a frontmatter note like status.md/today.md) — each entry is a
// {label, url} pair, and the shared frontmatter parser's list fields only ever hold flat
// strings, not structured records. Not git-ignored like #89's local settings file: a feed URL
// isn't a credential, and syncing it across devices is the entire point.
function parseCalendarFeeds(content: string): CalendarFeed[] {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is { label: unknown; url: unknown } => typeof entry === 'object' && entry !== null)
      .map((entry) => ({
        label: typeof entry.label === 'string' ? entry.label : '',
        url: typeof entry.url === 'string' ? entry.url : '',
      }));
  } catch {
    return [];
  }
}

function serializeCalendarFeeds(feeds: CalendarFeed[]): string {
  return JSON.stringify(feeds, null, 2);
}

async function refreshCalendarFeeds(): Promise<void> {
  try {
    const content = await readFile(calendarFeedsFilePath(state.subfolder));
    state.calendarFeeds = parseCalendarFeeds(content);
  } catch {
    state.calendarFeeds = [];
  }
  render();
}

// Quiet fallback on failure, same as the other startup refreshes above — an empty upcoming list
// (no feeds configured, or a transient fetch failure) is a normal, non-alarming state here.
async function refreshUpcomingEvents(): Promise<void> {
  try {
    state.upcomingEvents = await fetchUpcomingEvents();
  } catch {
    state.upcomingEvents = [];
  }
  render();
}

async function refreshProjects(): Promise<void> {
  try {
    state.projects = await fetchProjects();
  } catch {
    state.projects = [];
  }
  render();
}

async function refreshHorizonItems(): Promise<void> {
  try {
    state.horizonItems = await fetchHorizonItems();
  } catch {
    state.horizonItems = [];
  }
  render();
}

// Keyed by horizon value ("" for Unscheduled, matching HorizonItem.horizon) — each value is that
// column's item paths in priority order. Nothing on the backend has a notion of order within a
// column, so this is purely a frontend concern, persisted the same way calendarFeeds is.
type HorizonOrder = Record<string, string[]>;

const HORIZON_ORDER_FILE_NAME = 'horizon-order.json';

function horizonOrderFilePath(subfolder: string): string {
  return `${subfolder}/${HORIZON_ORDER_FILE_NAME}`;
}

function parseHorizonOrder(content: string): HorizonOrder {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const order: HorizonOrder = {};
    for (const [horizon, paths] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(paths)) {
        order[horizon] = paths.filter((path): path is string => typeof path === 'string');
      }
    }
    return order;
  } catch {
    return {};
  }
}

function serializeHorizonOrder(order: HorizonOrder): string {
  return JSON.stringify(order, null, 2);
}

async function refreshHorizonOrder(): Promise<void> {
  try {
    const content = await readFile(horizonOrderFilePath(state.subfolder));
    state.horizonOrder = parseHorizonOrder(content);
  } catch {
    state.horizonOrder = {};
  }
  render();
}

// Items within each horizon column, sorted by that column's explicit order (unlisted items —
// never dragged since ordering was introduced — keep their original relative order and sort
// after every explicitly-ordered one). Cross-column order doesn't matter: renderHorizonScreen
// filters this list per column, and Array.filter preserves relative order among matches
// regardless of other elements' positions, so sorting each column's own bucket is sufficient.
function orderedHorizonItems(items: HorizonItem[], order: HorizonOrder): HorizonItem[] {
  const byHorizon = new Map<string, HorizonItem[]>();
  for (const item of items) {
    const bucket = byHorizon.get(item.horizon);
    if (bucket) {
      bucket.push(item);
    } else {
      byHorizon.set(item.horizon, [item]);
    }
  }

  const result: HorizonItem[] = [];
  for (const [horizon, bucket] of byHorizon) {
    const explicitOrder = order[horizon] ?? [];
    const sorted = [...bucket].sort((a, b) => {
      const indexA = explicitOrder.indexOf(a.path);
      const indexB = explicitOrder.indexOf(b.path);
      if (indexA === -1 && indexB === -1) {
        return 0;
      }
      if (indexA === -1) {
        return 1;
      }
      if (indexB === -1) {
        return -1;
      }
      return indexA - indexB;
    });
    result.push(...sorted);
  }
  return result;
}

// Mirrors backend/src/projects.rs's own checklist parsing exactly (- [ ] / - [x] / - [X]) —
// toggling a task is a plain read-modify-write on the note's raw content via the existing
// generic file endpoints, not a dedicated mutation endpoint.
const TASK_LINE_PATTERN = /^(\s*-\s\[)([ xX])(\]\s.*)$/;

function toggleTaskLine(content: string, taskIndex: number): string {
  let seen = -1;
  const lines = content.split('\n').map((line) => {
    const match = line.match(TASK_LINE_PATTERN);
    if (!match) {
      return line;
    }
    seen += 1;
    if (seen !== taskIndex) {
      return line;
    }
    const isDone = match[2].toLowerCase() === 'x';
    return `${match[1]}${isDone ? ' ' : 'x'}${match[3]}`;
  });
  return lines.join('\n');
}

// Unlike toggleTaskLine, always sets done (idempotent if already checked) rather than
// flipping — an AI-proposed "check_task" (#99) means "mark this resolved," not "toggle it,"
// since the AI never has a reason to propose un-checking something.
function setTaskLineDoneAt(content: string, taskIndex: number): string {
  let seen = -1;
  const lines = content.split('\n').map((line) => {
    const match = line.match(TASK_LINE_PATTERN);
    if (!match) {
      return line;
    }
    seen += 1;
    if (seen !== taskIndex) {
      return line;
    }
    return `${match[1]}x${match[3]}`;
  });
  return lines.join('\n');
}

// There's no per-project AI-suggestion queue yet — matching the mockup, this just sends the
// user to Next Action, where AI suggestions already surface (#20/#21). Every AI-delegated
// project's card renders this same button, so it's bound by attribute, not a unique id.
function bindProjectsScreen(): void {
  main.querySelectorAll<HTMLButtonElement>('[data-review-ai-suggestions]').forEach((button) => {
    button.addEventListener('click', () => {
      navigateTo('next-action');
    });
  });

  main.querySelectorAll<HTMLInputElement>('[data-toggle-task]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const path = checkbox.dataset.projectPath;
      const taskIndex = Number(checkbox.dataset.taskIndex);
      if (!path) {
        return;
      }
      await runRepositoryAction('Updating task…', async () => {
        const content = await readFile(path);
        const snapshot = await writeFile(path, toggleTaskLine(content, taskIndex));
        state.files = snapshot.files;
        state.pendingChanges = snapshot.pendingChanges;
        // Progress is derived server-side from the updated checklist — refetch rather than
        // recompute it here, so the two never drift out of sync.
        state.projects = await fetchProjects();
      });
    });
  });
}

// Cursor above a card's own vertical midpoint means "insert before it," below means "insert
// after" — the only way a 2-item column can have its order swapped by dropping one card directly
// onto the other (there's no third card to drop "before" for the "move it after" case).
function dropIsAfterCard(event: DragEvent, card: HTMLElement): boolean {
  const rect = card.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2;
}

// Moving an item between columns is a plain read-modify-write on its `horizon:` frontmatter
// field via the existing generic file endpoints (#26) — same reuse pattern as project task
// toggling and Capture's attach flow. Reordering within a column only touches horizon-order.json
// (see refreshHorizonOrder) since the note's own frontmatter has no notion of priority.
async function moveHorizonItem(
  path: string,
  targetHorizon: HorizonValue | '',
  beforePath: string | null,
  insertAfter: boolean
): Promise<void> {
  const item = state.horizonItems.find((entry) => entry.path === path);
  if (!item || (item.horizon === targetHorizon && beforePath === path)) {
    return;
  }

  await runRepositoryAction('Moving item…', async () => {
    if (item.horizon !== targetHorizon) {
      const content = await readFile(path);
      const parsed = parseFrontmatter(content);
      const updated = serializeFrontmatter({
        frontmatter: setFrontmatterValue(parsed.frontmatter, 'horizon', targetHorizon),
        body: parsed.body,
      });
      const snapshot = await writeFile(path, updated);
      state.files = snapshot.files;
      state.pendingChanges = snapshot.pendingChanges;
    }

    // Drop `path` from every column's explicit order, then splice it back into the target
    // column's *currently displayed* order at the requested position — that materializes
    // whatever implicit order unlisted items were already in, so they don't reshuffle.
    const nextOrder: HorizonOrder = {};
    for (const [horizon, paths] of Object.entries(state.horizonOrder)) {
      nextOrder[horizon] = paths.filter((entry) => entry !== path);
    }
    const targetOrder = orderedHorizonItems(state.horizonItems, state.horizonOrder)
      .filter((entry) => entry.horizon === targetHorizon && entry.path !== path)
      .map((entry) => entry.path);
    let insertIndex = beforePath ? targetOrder.indexOf(beforePath) : targetOrder.length;
    if (insertIndex === -1) {
      insertIndex = targetOrder.length;
    } else if (insertAfter) {
      insertIndex += 1;
    }
    targetOrder.splice(insertIndex, 0, path);
    nextOrder[targetHorizon] = targetOrder;

    const snapshot = await writeFile(horizonOrderFilePath(state.subfolder), serializeHorizonOrder(nextOrder));
    state.files = snapshot.files;
    state.pendingChanges = snapshot.pendingChanges;
    state.horizonOrder = nextOrder;
    // The column an item belongs in is derived server-side from the field just written —
    // refetch rather than recompute it here, so the two never drift out of sync.
    state.horizonItems = await fetchHorizonItems();
  });
}

function bindHorizonScreen(): void {
  main.querySelectorAll<HTMLElement>('[data-horizon-drag]').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      const path = card.dataset.horizonDrag;
      if (!path || !event.dataTransfer) {
        return;
      }
      event.dataTransfer.setData('text/plain', path);
      event.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
    });

    // Handled here (not just at the column level) so dropping one card directly onto another
    // reorders them within the column instead of just appending to the end.
    card.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      card.classList.toggle('drag-over-after', dropIsAfterCard(event, card));
      card.classList.toggle('drag-over-before', !dropIsAfterCard(event, card));
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over-before', 'drag-over-after');
    });
    card.addEventListener('drop', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      card.classList.remove('drag-over-before', 'drag-over-after');
      const path = event.dataTransfer?.getData('text/plain');
      const targetPath = card.dataset.horizonDrag;
      const column = card.closest<HTMLElement>('[data-horizon-drop]');
      if (!path || !targetPath || !column) {
        return;
      }
      const horizon = (column.dataset.horizonDrop ?? '') as HorizonValue | '';
      await moveHorizonItem(path, horizon, targetPath, dropIsAfterCard(event, card));
    });
  });

  main.querySelectorAll<HTMLElement>('[data-horizon-drop]').forEach((column) => {
    column.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      column.classList.add('drag-over');
    });
    column.addEventListener('dragleave', () => {
      column.classList.remove('drag-over');
    });
    // Only fires when the drop lands on the column's own background, not a card — each card's
    // own drop handler above calls stopPropagation, so this is purely the "append to the end"
    // case (empty space below the last card, or an empty column).
    column.addEventListener('drop', async (event) => {
      event.preventDefault();
      column.classList.remove('drag-over');
      const path = event.dataTransfer?.getData('text/plain');
      if (!path) {
        return;
      }
      const horizon = (column.dataset.horizonDrop ?? '') as HorizonValue | '';
      await moveHorizonItem(path, horizon, null, false);
    });
  });

  main.querySelector<HTMLButtonElement>('#suggest-horizon-reassignments-button')?.addEventListener('click', async () => {
    await runRepositoryAction('Asking AI to review horizons…', async () => {
      state.horizonSuggestions = await suggestHorizonReassignments();
    });
  });

  main.querySelectorAll<HTMLButtonElement>('[data-dismiss-horizon-suggestion]').forEach((button) => {
    button.addEventListener('click', () => {
      const path = button.dataset.dismissHorizonSuggestion;
      // AC: dismissing leaves the item's horizon unchanged — this only drops the suggestion
      // from the list, no note write at all.
      state.horizonSuggestions = state.horizonSuggestions.filter((suggestion) => suggestion.path !== path);
      render();
    });
  });

  main.querySelectorAll<HTMLButtonElement>('[data-confirm-horizon-suggestion]').forEach((button) => {
    button.addEventListener('click', async () => {
      const path = button.dataset.confirmHorizonSuggestion;
      const suggestion = state.horizonSuggestions.find((entry) => entry.path === path);
      if (!suggestion) {
        return;
      }
      state.horizonSuggestions = state.horizonSuggestions.filter((entry) => entry.path !== suggestion.path);
      // Confirming writes the note's `horizon:` field exactly like a manual drag would —
      // appended to the end of the target column's order, same as the column-drop case.
      await moveHorizonItem(suggestion.path, suggestion.to, null, false);
    });
  });
}

function bindNextActionScreen(): void {
  main.querySelector<HTMLButtonElement>('#status-change-button')?.addEventListener('click', () => {
    const current = state.currentStatus;
    state.statusEditKind = current?.kind ?? 'situational';
    state.statusEditLabel = current?.label ?? '';
    state.statusEditTaskPath = current?.kind === 'task' ? current.taskPath : '';
    state.isEditingStatus = true;
    render();
  });

  main.querySelector<HTMLButtonElement>('#status-cancel-button')?.addEventListener('click', () => {
    state.isEditingStatus = false;
    render();
  });

  // Clears the label rather than carrying it across — the same input means different things
  // per kind (the whole status for situational, an optional override for task), so leaving
  // e.g. "Coffee break" behind after switching to Task would silently become that task's
  // description instead of falling back to its file name.
  main.querySelector<HTMLSelectElement>('#status-kind')?.addEventListener('change', (event) => {
    state.statusEditKind = (event.target as HTMLSelectElement).value as CurrentStatus['kind'];
    state.statusEditLabel = '';
    render();
  });

  main.querySelector<HTMLInputElement>('#status-label')?.addEventListener('input', (event) => {
    state.statusEditLabel = (event.target as HTMLInputElement).value;
  });

  main.querySelector<HTMLInputElement>('#status-task-path')?.addEventListener('input', (event) => {
    state.statusEditTaskPath = (event.target as HTMLInputElement).value;
  });

  main.querySelector<HTMLButtonElement>('#status-save-button')?.addEventListener('click', async () => {
    const kind = state.statusEditKind;
    const label = state.statusEditLabel.trim();
    const taskPath = state.statusEditTaskPath.trim();

    if (kind === 'situational' && !label) {
      state.errorMessage = 'Enter what you are doing before saving.';
      render();
      return;
    }
    if (kind === 'task' && !taskPath) {
      state.errorMessage = 'Enter or pick a task note before saving.';
      render();
      return;
    }

    const status: CurrentStatus =
      kind === 'task' ? { kind: 'task', taskPath, label: label || taskLabelFallback(taskPath) } : { kind: 'situational', label };

    await runRepositoryAction('Saving status…', async () => {
      const snapshot = await writeFile(statusFilePath(state.subfolder), serializeStatus(status));
      state.files = snapshot.files;
      state.pendingChanges = snapshot.pendingChanges;
      state.currentStatus = status;
      state.isEditingStatus = false;
      state.statusMessage = 'Status updated.';
    });
  });

  main.querySelector<HTMLButtonElement>('#suggestion-request-button')?.addEventListener('click', async () => {
    await runRepositoryAction('Asking AI for a suggestion…', async () => {
      const result = await suggestNextAction(state.rejectedSuggestions);
      state.suggestion = result.suggestion;
    });
  });

  // The rejected suggestion is remembered (not just discarded) so the next request can ask the
  // backend to steer away from repeating it — see suggestNextAction's excludedSuggestions.
  main.querySelector<HTMLButtonElement>('#suggestion-another-button')?.addEventListener('click', async () => {
    if (state.suggestion) {
      state.rejectedSuggestions = [...state.rejectedSuggestions, state.suggestion];
    }
    await runRepositoryAction('Asking AI for another suggestion…', async () => {
      const result = await suggestNextAction(state.rejectedSuggestions);
      state.suggestion = result.suggestion;
    });
  });

  main.querySelector<HTMLButtonElement>('#suggestion-confirm-button')?.addEventListener('click', async () => {
    const suggestion = state.suggestion;
    if (!suggestion) {
      return;
    }
    await runRepositoryAction("Adding to today's plan…", async () => {
      const nextPlan = [...state.todayPlan, suggestion];
      const snapshot = await writeFile(todayPlanFilePath(state.subfolder), serializeTodayPlan(nextPlan));
      state.files = snapshot.files;
      state.pendingChanges = snapshot.pendingChanges;
      state.todayPlan = nextPlan;
      state.suggestion = null;
      state.rejectedSuggestions = [];
      state.statusMessage = "Added to today's plan.";
    });
  });

  main.querySelector<HTMLButtonElement>('#refresh-upcoming-button')?.addEventListener('click', async () => {
    await runRepositoryAction('Refreshing upcoming events…', async () => {
      state.upcomingEvents = await fetchUpcomingEvents();
      state.statusMessage = 'Upcoming events refreshed.';
    });
  });
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
      // Filing this capture manually supersedes any AI-proposed actions still pending for it —
      // leave other captures' pending proposals untouched.
      state.attachDrafts = state.attachDrafts.filter((draft) => draft.captureId !== capture.id);
      render();
    });
  });

  main.querySelectorAll<HTMLButtonElement>('[data-ai-propose-capture]').forEach((button) => {
    button.addEventListener('click', async () => {
      const captureId = button.dataset.aiProposeCapture;
      const capture = state.captures.find((entry) => entry.id === captureId);
      if (!capture) {
        return;
      }

      await runRepositoryAction('Asking AI to propose a draft…', async () => {
        // Usually one proposal, but a capture can imply several actions against the same note
        // (#101, e.g. check off a finished task AND add a new one) — render one attach panel per
        // attach_existing proposal; only the first new_note proposal (if any) becomes the single
        // draft panel, since that's a full note editor, not something meant to repeat.
        const proposals = await classifyCapture(capture.text);
        const attachDrafts: AttachDraft[] = [];
        let newDraft: CaptureDraft | null = null;
        for (const proposal of proposals) {
          if (proposal.action === 'attach_existing' && proposal.path) {
            attachDrafts.push({
              id: crypto.randomUUID(),
              captureId: capture.id,
              path: proposal.path,
              operation: proposal.operation ?? 'add_task',
              taskText: proposal.taskText ?? capture.text,
              taskIndex: proposal.taskIndex ?? 0,
              text: proposal.text ?? capture.text,
            });
          } else if (!newDraft) {
            const type = proposal.type ?? 'todo';
            newDraft = {
              captureId: capture.id,
              type,
              title: proposal.title ?? capture.text.slice(0, 48),
              content: proposal.content ?? defaultDraftContent(type, capture.text),
            };
          }
        }
        state.attachDrafts = attachDrafts;
        state.draft = newDraft;
      });
    });
  });

  // Only the frontmatter's `type` field is regenerated — every other field (including ones an
  // AI proposal or the user added by hand, e.g. `project`/`date`/`attendees`) round-trips
  // untouched, so switching type after starting to edit doesn't clobber their work.
  main.querySelector<HTMLSelectElement>('#draft-type')?.addEventListener('change', (event) => {
    if (!state.draft) {
      return;
    }
    const newType = (event.target as HTMLSelectElement).value as DraftType;
    const contentInput = main.querySelector<HTMLTextAreaElement>('#draft-content');
    if (contentInput) {
      const parsed = parseFrontmatter(contentInput.value);
      contentInput.value = serializeFrontmatter({
        frontmatter: setFrontmatterValue(parsed.frontmatter, 'type', newType),
        body: parsed.body,
      });
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
      // Dated by when the thing was captured, not when it happened to get filed — a status
      // jotted down at 9am and filed at 6pm is still a 9am status.
      const capture = state.captures.find((entry) => entry.id === draft.captureId);
      const capturedAt = capture ? new Date(capture.capturedAt) : new Date();
      const slug = `${dateStamp(capturedAt)}-${slugifyTitle(title)}`;
      const path = uniqueFilePath(state.files, `${state.subfolder}/backlog`, slug);
      const snapshot = await writeFile(path, content);
      state.files = snapshot.files;
      state.pendingChanges = snapshot.pendingChanges;
      state.draft = null;
      clearCaptureIfFullyResolved(draft.captureId);
      state.selectedFilePath = path;
      state.selectedFileContent = content;
      state.statusMessage = `Saved to Notebook: ${path}.`;
    });
  });

  main.querySelectorAll<HTMLInputElement>('[data-attach-field="path"]').forEach((input) => {
    const id = input.dataset.attachId;
    if (!id) return;
    input.addEventListener('input', (event) => {
      updateAttachDraft(id, { path: (event.target as HTMLInputElement).value });
    });
  });

  // Changes which fields are shown below, so this re-renders — unlike the plain text inputs
  // here, which just keep state in sync without disturbing focus/cursor position.
  main.querySelectorAll<HTMLSelectElement>('[data-attach-field="operation"]').forEach((select) => {
    const id = select.dataset.attachId;
    if (!id) return;
    select.addEventListener('change', (event) => {
      updateAttachDraft(id, { operation: (event.target as HTMLSelectElement).value as AttachOperation });
      render();
    });
  });

  main.querySelectorAll<HTMLInputElement>('[data-attach-field="taskText"]').forEach((input) => {
    const id = input.dataset.attachId;
    if (!id) return;
    input.addEventListener('input', (event) => {
      updateAttachDraft(id, { taskText: (event.target as HTMLInputElement).value });
    });
  });

  main.querySelectorAll<HTMLInputElement>('[data-attach-field="taskIndex"]').forEach((input) => {
    const id = input.dataset.attachId;
    if (!id) return;
    input.addEventListener('input', (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      updateAttachDraft(id, { taskIndex: Number.isFinite(value) ? value : 0 });
    });
  });

  main.querySelectorAll<HTMLTextAreaElement>('[data-attach-field="text"]').forEach((textarea) => {
    const id = textarea.dataset.attachId;
    if (!id) return;
    textarea.addEventListener('input', (event) => {
      updateAttachDraft(id, { text: (event.target as HTMLTextAreaElement).value });
    });
  });

  main.querySelectorAll<HTMLButtonElement>('[data-attach-cancel]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.attachCancel;
      state.attachDrafts = state.attachDrafts.filter((draft) => draft.id !== id);
      render();
    });
  });

  main.querySelectorAll<HTMLButtonElement>('[data-attach-confirm]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.attachConfirm;
      const attachDraft = state.attachDrafts.find((draft) => draft.id === id);
      if (!attachDraft) {
        return;
      }

      if (!attachDraft.path.trim()) {
        state.errorMessage = 'Enter or pick a note before confirming.';
        render();
        return;
      }
      if (attachDraft.operation === 'add_task' && !attachDraft.taskText.trim()) {
        state.errorMessage = 'Enter the task text before confirming.';
        render();
        return;
      }
      if (attachDraft.operation === 'append_text' && !attachDraft.text.trim()) {
        state.errorMessage = 'Enter the text before confirming.';
        render();
        return;
      }

      await runRepositoryAction('Updating note…', async () => {
        const content = await readFile(attachDraft.path);
        const separator = content.endsWith('\n') ? '' : '\n';
        const updated =
          attachDraft.operation === 'add_task'
            ? `${content}${separator}- [ ] ${attachDraft.taskText.trim()}\n`
            : attachDraft.operation === 'check_task'
              ? setTaskLineDoneAt(content, attachDraft.taskIndex)
              : `${content}${separator}${attachDraft.text.trim()}\n`;

        const snapshot = await writeFile(attachDraft.path, updated);
        state.files = snapshot.files;
        state.pendingChanges = snapshot.pendingChanges;
        state.attachDrafts = state.attachDrafts.filter((draft) => draft.id !== attachDraft.id);
        clearCaptureIfFullyResolved(attachDraft.captureId);
        // The target note's tasks/progress may have changed — refetch rather than let Projects
        // drift stale until the next full snapshot load.
        state.projects = await fetchProjects();
        state.statusMessage = `Updated ${attachDraft.path}.`;
      });
    });
  });
}

function updateAttachDraft(id: string, changes: Partial<AttachDraft>): void {
  state.attachDrafts = state.attachDrafts.map((draft) => (draft.id === id ? { ...draft, ...changes } : draft));
}

// A capture can produce several proposed actions at once (#101) — only drop it from the list once
// every one of them (the draft panel and every attach panel) has been resolved, so confirming just
// one of several doesn't make the rest silently disappear along with the capture.
function clearCaptureIfFullyResolved(captureId: string): void {
  const stillPending = state.draft?.captureId === captureId || state.attachDrafts.some((draft) => draft.captureId === captureId);
  if (stillPending) {
    return;
  }
  state.captures = state.captures.filter((entry) => entry.id !== captureId);
  saveCaptures(state.captures);
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
    // Best-effort preview only — in a real vault the first file can easily be something
    // non-text (e.g. an image pasted into an Obsidian note). Failing to preview it shouldn't
    // abort the rest of snapshot loading below, or surface as an app-wide error message.
    state.selectedFileContent = '';
    if (state.selectedFilePath) {
      try {
        state.selectedFileContent = await readFile(state.selectedFilePath);
      } catch {
        state.selectedFilePath = '';
      }
    }

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
