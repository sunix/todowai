import { buildFileTree, type FileTreeNode } from './file-tree';
import { parseFrontmatter } from './frontmatter';
import type {
  AiConfigView,
  AiProvider,
  ConfiguredRemote,
  ConflictInfo,
  ConflictSide,
  Project,
  RepositoryChange,
  RepositoryHistoryEntry,
  UpcomingEvent,
} from './repository';
import type { ScreenId } from './router';

// Quick picks for the situational-status field — the text input stays free-form (same
// <datalist>-suggestion convention as the git-remote-URL and AI-model fields elsewhere), these
// are just a starting point, not an enum the field is restricted to.
const SITUATIONAL_STATUS_SUGGESTIONS = [
  '☕ Coffee break',
  '🍽️ Lunch break',
  '🍳 Having breakfast',
  '🏫 Picking up the kids from school',
  '⚽ At the stadium for a football match',
  '🚇 On the metro / commuting',
  '🚗 Driving',
  '🚶 Walking',
  '🛌 Before going to bed',
  '🌅 Just woke up',
  '🍳 Making breakfast',
  '🧺 Doing laundry',
  '👨‍🍳 Cooking dinner',
  '🧹 Tidying up',
  '🛒 Grocery shopping',
  '🚿 Getting ready',
  '🏋️ At the gym',
  '🚌 Waiting for the bus/train',
  '🩺 Waiting room (doctor, appointment)',
  '👶 With the kids',
  '🐕 Walking the dog',
  '📺 Winding down / watching TV',
  '🛋️ Taking a break on the couch',
  '💼 Working on a customer project',
  '🏢 Working on an internal project',
  '🚀 Working on a side project',
  '📖 Reading a book',
  '🎓 Learning (tutorial, course)',
];

const AI_PROVIDER_OPTIONS: Array<{ value: AiProvider; label: string }> = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'groq', label: 'Groq' },
  { value: 'ollama', label: 'Ollama (local)' },
];

function aiProviderLabel(provider: AiProvider | null): string {
  return AI_PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? 'unknown provider';
}

const TITLES: Record<ScreenId, string> = {
  capture: 'Capture',
  notebook: 'Notebook',
  'next-action': 'Next Action',
  projects: 'Projects',
  horizon: 'Horizon',
  meetings: 'Meetings',
  settings: 'Settings',
};

// Placeholder screens — each will be built out by its own implementation issue.
// See plan/implementation.md for the milestone each screen belongs to.
export function renderScreen(screen: ScreenId): string {
  return `
    <h1 class="title">${TITLES[screen]}</h1>
    <p class="placeholder">This screen is not implemented yet.</p>
  `;
}

// A known set gets distinct badge styling (matching the mockup's blocked/parallel/ai badges);
// anything else the user writes into a project note's `status` field still renders, just with
// a neutral fallback style — the field stays free text, not a fixed enum.
const PROJECT_STATUS_LABELS: Record<string, string> = {
  blocked: 'Blocked',
  'in-progress': 'In progress',
  'ai-delegated': 'AI delegated',
  backlog: 'Backlog',
  done: 'Done',
};

const KNOWN_PROJECT_STATUSES = new Set(Object.keys(PROJECT_STATUS_LABELS));

function projectStatusLabel(status: string): string {
  return PROJECT_STATUS_LABELS[status] ?? status;
}

function projectStatusClass(status: string): string {
  return KNOWN_PROJECT_STATUSES.has(status) ? `badge-${status}` : 'badge-default';
}

type ProjectsScreenState = {
  projects: Project[];
  isBusy: boolean;
  busyLabel: string;
  statusMessage: string;
  errorMessage: string;
};

export function renderProjectsScreen(state?: ProjectsScreenState): string {
  const viewState = state ?? { projects: [], isBusy: false, busyLabel: '', statusMessage: '', errorMessage: '' };

  const projectCards =
    viewState.projects.length > 0
      ? viewState.projects
          .map(
            (project) => `
              <article class="card project-card">
                <div class="project-name">
                  ${escapeHtml(project.name)}
                  <span class="badge ${projectStatusClass(project.status)}">${escapeHtml(projectStatusLabel(project.status))}</span>
                </div>
                ${project.meta ? `<p class="project-meta">${escapeHtml(project.meta)}</p>` : ''}
                <div class="progress-track"><div class="progress-fill" style="width: ${project.progress}%"></div></div>
                ${
                  project.status === 'ai-delegated'
                    ? `<button class="secondary-button" data-review-ai-suggestions>Review AI suggestions →</button>`
                    : ''
                }
              </article>
            `
          )
          .join('')
      : '<p class="empty-state">No projects yet — file a capture as a "Project note" to see it here.</p>';

  return `
    <h1 class="title">${TITLES.projects}</h1>
    <p class="placeholder">Large tasks, parallel work, and delegated AI work.</p>
    ${
      viewState.isBusy
        ? `<p class="busy-message"><span class="spinner" aria-hidden="true"></span>${escapeHtml(viewState.busyLabel)}</p>`
        : ''
    }
    ${
      viewState.statusMessage
        ? `<p class="status-message" role="status">${escapeHtml(viewState.statusMessage)}</p>`
        : ''
    }
    ${
      viewState.errorMessage
        ? `<p class="error-message" role="alert">${escapeHtml(viewState.errorMessage)}</p>`
        : ''
    }
    <div class="project-grid">${projectCards}</div>
  `;
}

// The single, persistent "what am I doing right now" value (specification/specs.md) — distinct
// from Capture's "status" note type, which files a discrete, never-overwritten journal entry
// each time. This is the opposite: one well-known file (`<subfolder>/status.md`), always
// overwritten in place, synced like any other vault file so it's the same on every device.
export type CurrentStatus =
  | { kind: 'situational'; label: string }
  | { kind: 'task'; label: string; taskPath: string };

type NextActionScreenState = {
  status: CurrentStatus | null;
  isEditing: boolean;
  editKind: CurrentStatus['kind'];
  editLabel: string;
  editTaskPath: string;
  taskPathSuggestions: string[];
  suggestion: string | null;
  todayPlan: string[];
  aiConfigured: boolean;
  upcomingEvents: UpcomingEvent[];
  isBusy: boolean;
  busyLabel: string;
  statusMessage: string;
  errorMessage: string;
};

export function renderNextActionScreen(state?: NextActionScreenState): string {
  const viewState = state ?? {
    status: null,
    isEditing: false,
    editKind: 'situational' as const,
    editLabel: '',
    editTaskPath: '',
    taskPathSuggestions: [],
    suggestion: null,
    todayPlan: [],
    aiConfigured: false,
    upcomingEvents: [],
    isBusy: false,
    busyLabel: '',
    statusMessage: '',
    errorMessage: '',
  };

  const statusValueHtml = viewState.status
    ? viewState.status.kind === 'task'
      ? `Working on: ${escapeHtml(viewState.status.label)}`
      : escapeHtml(viewState.status.label)
    : 'No status set yet';

  const editFieldsHtml =
    viewState.editKind === 'situational'
      ? `
        <label class="field-label" for="status-label">What are you doing?</label>
        <input
          class="text-input"
          id="status-label"
          list="status-situational-suggestions"
          value="${escapeHtmlAttribute(viewState.editLabel)}"
          placeholder="e.g. Coffee break, taking the metro…"
          ${viewState.isBusy ? 'disabled' : ''}
        >
        <datalist id="status-situational-suggestions">
          ${SITUATIONAL_STATUS_SUGGESTIONS.map((suggestion) => `<option value="${escapeHtmlAttribute(suggestion)}"></option>`).join('')}
        </datalist>
      `
      : `
        <label class="field-label" for="status-task-path">Task note</label>
        <input
          class="text-input"
          id="status-task-path"
          list="status-task-suggestions"
          value="${escapeHtmlAttribute(viewState.editTaskPath)}"
          placeholder="e.g. ${escapeHtmlAttribute(viewState.taskPathSuggestions[0] ?? 'todowai/backlog/my-task.md')}"
          ${viewState.isBusy ? 'disabled' : ''}
        >
        <datalist id="status-task-suggestions">
          ${viewState.taskPathSuggestions.map((path) => `<option value="${escapeHtmlAttribute(path)}"></option>`).join('')}
        </datalist>
        <label class="field-label" for="status-label">Description (optional)</label>
        <input
          class="text-input"
          id="status-label"
          value="${escapeHtmlAttribute(viewState.editLabel)}"
          placeholder="Defaults to the task note's file name"
          ${viewState.isBusy ? 'disabled' : ''}
        >
      `;

  const editCardHtml = viewState.isEditing
    ? `
      <article class="card status-edit-card">
        <label class="field-label" for="status-kind">Kind</label>
        <select class="text-input" id="status-kind" ${viewState.isBusy ? 'disabled' : ''}>
          <option value="situational" ${viewState.editKind === 'situational' ? 'selected' : ''}>Situational context</option>
          <option value="task" ${viewState.editKind === 'task' ? 'selected' : ''}>Task</option>
        </select>
        ${editFieldsHtml}
        <div class="button-row">
          <button class="primary-button" id="status-save-button" ${viewState.isBusy ? 'disabled' : ''}>Save status</button>
          <button class="secondary-button" id="status-cancel-button" ${viewState.isBusy ? 'disabled' : ''}>Cancel</button>
        </div>
      </article>
    `
    : '';

  const suggestionCardHtml = viewState.suggestion
    ? `
      <article class="card suggestion-card">
        <div class="suggestion-tag">Next todo — needs your confirmation</div>
        <p class="suggestion-text">${escapeHtml(viewState.suggestion)}</p>
        <div class="button-row">
          <button class="primary-button" id="suggestion-confirm-button" ${viewState.isBusy ? 'disabled' : ''}>Confirm</button>
          <button class="secondary-button" id="suggestion-another-button" ${viewState.isBusy ? 'disabled' : ''}>Suggest something else</button>
        </div>
      </article>
    `
    : `
      <article class="card suggestion-card">
        <button
          class="secondary-button"
          id="suggestion-request-button"
          ${viewState.isBusy || !viewState.aiConfigured ? 'disabled' : ''}
          title="${viewState.aiConfigured ? '' : 'Configure an AI provider in Settings first'}"
        >Suggest something to do next</button>
      </article>
    `;

  const todayPlanHtml =
    viewState.todayPlan.length > 0
      ? `<ul class="plan-list">${viewState.todayPlan.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '<p class="empty-state">Nothing confirmed yet today.</p>';

  const upcomingListHtml =
    viewState.upcomingEvents.length > 0
      ? `<ul class="upcoming-list">${viewState.upcomingEvents
          .map(
            (event) => `
              <li class="upcoming-entry">
                <span class="upcoming-source">${escapeHtml(event.source)}</span>
                <span class="upcoming-summary">${escapeHtml(event.summary)}</span>
                <span class="upcoming-time">${escapeHtml(new Date(event.start).toLocaleString())}</span>
              </li>
            `
          )
          .join('')}</ul>`
      : '<p class="empty-state">Nothing upcoming — connect a calendar feed in Settings, or refresh.</p>';

  return `
    <h1 class="title">${TITLES['next-action']}</h1>
    <p class="placeholder">Your current status, and what the AI suggests doing about it.</p>
    ${
      viewState.isBusy
        ? `<p class="busy-message"><span class="spinner" aria-hidden="true"></span>${escapeHtml(viewState.busyLabel)}</p>`
        : ''
    }
    ${
      viewState.statusMessage
        ? `<p class="status-message" role="status">${escapeHtml(viewState.statusMessage)}</p>`
        : ''
    }
    ${
      viewState.errorMessage
        ? `<p class="error-message" role="alert">${escapeHtml(viewState.errorMessage)}</p>`
        : ''
    }
    <div class="card status-card">
      <div>
        <div class="status-card-label">Current status</div>
        <div class="status-card-value">${statusValueHtml}</div>
      </div>
      ${
        !viewState.isEditing
          ? `<button class="secondary-button" id="status-change-button" ${viewState.isBusy ? 'disabled' : ''}>Change status</button>`
          : ''
      }
    </div>
    ${editCardHtml}
    ${suggestionCardHtml}
    <h2 class="section-title next-action-plan-title">Today's plan</h2>
    ${todayPlanHtml}
    <div class="upcoming-header">
      <h2 class="section-title">Upcoming</h2>
      <button class="secondary-button" id="refresh-upcoming-button" ${viewState.isBusy ? 'disabled' : ''}>Refresh</button>
    </div>
    ${upcomingListHtml}
  `;
}

// A captured note isn't written to the vault at all — per specification/specs.md, it stays an
// editable draft (kept only in the browser, see main.ts's localStorage-backed persistence) until
// the user explicitly files it into the Notebook (this manual path is #16; an AI-proposed one is
// the separate #17).
export type CapturedNote = {
  id: string;
  text: string;
  capturedAt: string;
};

// Purely a frontmatter concern once filed (see specification/specs.md — meetings/projects are
// plain notes discovered by frontmatter, not their own folders) — every manually filed note
// lands in the subfolder's "backlog" status folder regardless of type, matching the mockup's own
// manual-draft default (`status: backlog`). #18's real frontmatter parser is expected to build on
// this convention, not replace it.
export type DraftType = 'todo' | 'meeting' | 'status' | 'project';

const DRAFT_TYPE_OPTIONS: Array<{ value: DraftType; label: string }> = [
  { value: 'todo', label: 'Todo' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'status', label: 'Current status' },
  { value: 'project', label: 'Project note' },
];

export type CaptureDraft = {
  captureId: string;
  type: DraftType;
  title: string;
  content: string;
};

type CaptureScreenState = {
  captures: CapturedNote[];
  draft: CaptureDraft | null;
  isBusy: boolean;
  busyLabel: string;
  statusMessage: string;
  errorMessage: string;
  aiConfigured: boolean;
};

export function renderCaptureScreen(state?: CaptureScreenState): string {
  const viewState = state ?? {
    captures: [],
    draft: null,
    isBusy: false,
    busyLabel: '',
    statusMessage: '',
    errorMessage: '',
    aiConfigured: false,
  };

  const listHtml =
    viewState.captures.length > 0
      ? viewState.captures
          .map(
            (capture) => `
              <li class="capture-entry">
                <p class="capture-text">${escapeHtml(capture.text)}</p>
                <div class="capture-entry-footer">
                  <span class="capture-meta">${escapeHtml(new Date(capture.capturedAt).toLocaleString())}</span>
                  <div class="capture-entry-actions">
                    <button
                      class="secondary-button"
                      data-file-capture="${escapeHtmlAttribute(capture.id)}"
                      ${viewState.isBusy ? 'disabled' : ''}
                    >File it myself</button>
                    <button
                      class="secondary-button"
                      data-ai-propose-capture="${escapeHtmlAttribute(capture.id)}"
                      ${viewState.isBusy || !viewState.aiConfigured ? 'disabled' : ''}
                      title="${viewState.aiConfigured ? '' : 'Configure an AI provider in Settings first'}"
                    >Let AI propose</button>
                  </div>
                </div>
              </li>
            `
          )
          .join('')
      : '<li class="empty-state">Nothing captured yet.</li>';

  return `
    <h1 class="title">${TITLES.capture}</h1>
    <p class="placeholder">Jot something down now — file it into the Notebook later.</p>
    ${
      viewState.isBusy
        ? `<p class="busy-message"><span class="spinner" aria-hidden="true"></span>${escapeHtml(viewState.busyLabel)}</p>`
        : ''
    }
    ${
      viewState.statusMessage
        ? `<p class="status-message" role="status">${escapeHtml(viewState.statusMessage)}</p>`
        : ''
    }
    ${
      viewState.errorMessage
        ? `<p class="error-message" role="alert">${escapeHtml(viewState.errorMessage)}</p>`
        : ''
    }
    <div class="card capture-card">
      <textarea
        class="text-area capture-input"
        id="capture-input"
        placeholder="Type a thought, task, or observation…"
      ></textarea>
      <div class="button-row">
        <button class="primary-button" id="capture-save-button">Save note</button>
        <button class="secondary-button" id="capture-clear-button">Clear</button>
      </div>
    </div>
    <h2 class="section-title capture-list-title">Recently captured</h2>
    <ul class="capture-list">${listHtml}</ul>
    ${viewState.draft ? renderDraftPanel(viewState.draft, viewState.isBusy) : ''}
  `;
}

function renderDraftPanel(draft: CaptureDraft, isBusy: boolean): string {
  const typeOptions = DRAFT_TYPE_OPTIONS.map(
    (option) =>
      `<option value="${option.value}" ${option.value === draft.type ? 'selected' : ''}>${option.label}</option>`
  ).join('');

  return `
    <article class="card draft-card">
      <h2 class="section-title">File into the Notebook</h2>
      <p class="section-copy">
        Nothing is saved until you click "Save to Notebook" — edit anything below first, including the raw
        frontmatter. New notes are filed into <code>backlog</code>; move them to <code>doing</code>/<code>done</code>
        later from the Notebook.
      </p>
      <label class="field-label" for="draft-type">Type</label>
      <select class="text-input" id="draft-type" ${isBusy ? 'disabled' : ''}>${typeOptions}</select>
      <label class="field-label" for="draft-title">Title</label>
      <input class="text-input" id="draft-title" value="${escapeHtmlAttribute(draft.title)}" ${isBusy ? 'disabled' : ''}>
      <label class="field-label" for="draft-content">Content (editable before saving)</label>
      <textarea class="text-area" id="draft-content" ${isBusy ? 'disabled' : ''}>${escapeHtml(draft.content)}</textarea>
      <div class="button-row">
        <button class="primary-button" id="draft-save-button" ${isBusy ? 'disabled' : ''}>Save to Notebook</button>
        <button class="secondary-button" id="draft-cancel-button" ${isBusy ? 'disabled' : ''}>Cancel</button>
      </div>
    </article>
  `;
}

type NotebookScreenState = {
  subfolder: string;
  files: string[];
  selectedFilePath: string;
  selectedFileContent: string;
  expandedFolders: Set<string>;
  isBusy: boolean;
  busyLabel: string;
  statusMessage: string;
  errorMessage: string;
};

// The Todowai-managed slice of the vault only — matches #14's AC ("lists real files from the
// configured subfolder"), unlike Settings' file tree/editor which deliberately shows the whole
// vault (existing notes outside the subfolder, e.g. a coexisting Obsidian vault, stay editable
// there — see specification/decisions.md). Both screens share the same underlying state
// (files/selectedFilePath/selectedFileContent) since they're views onto the same vault, not
// separate data.
function notebookFiles(files: string[], subfolder: string): string[] {
  return files.filter((path) => path === subfolder || path.startsWith(`${subfolder}/`));
}

// Read-only, #18's shared parser applied to whatever's currently open — including notes Todowai
// didn't create itself (e.g. an existing Obsidian note with its own frontmatter). Editing stays
// raw-text below this (see the textarea it sits above); this is purely a legibility aid, not a
// structured form, so a file with no recognizable frontmatter just renders nothing here.
function frontmatterSummaryHtml(content: string): string {
  const { frontmatter } = parseFrontmatter(content);
  if (frontmatter.length === 0) {
    return '';
  }
  const chips = frontmatter
    .map(([key, value]) => {
      const displayValue = Array.isArray(value) ? value.join(', ') : value;
      return `<span class="frontmatter-chip"><strong>${escapeHtml(key)}</strong>: ${escapeHtml(displayValue)}</span>`;
    })
    .join('');
  return `<p class="notebook-frontmatter-summary">${chips}</p>`;
}

export function renderNotebookScreen(state?: NotebookScreenState): string {
  const viewState = state ?? {
    subfolder: 'todowai',
    files: [],
    selectedFilePath: '',
    selectedFileContent: '',
    expandedFolders: new Set<string>(),
    isBusy: false,
    busyLabel: '',
    statusMessage: '',
    errorMessage: '',
  };

  const scopedFiles = notebookFiles(viewState.files, viewState.subfolder);
  const fileTree = buildFileTree(scopedFiles);
  const fileTreeHtml =
    fileTree.length > 0
      ? `<ul class="tree-root">${renderFileTreeNodes(fileTree, viewState.selectedFilePath, viewState.expandedFolders, viewState.isBusy, 0)}</ul>`
      : '<p class="empty-state">No notes yet in this subfolder.</p>';

  // The globally-selected file might be one Settings opened outside this subfolder (e.g. an
  // existing Obsidian note) — Notebook only edits its own scoped files, so it prompts to pick
  // one from its own tree rather than showing content that isn't actually listed here.
  const hasSelection = scopedFiles.includes(viewState.selectedFilePath);

  return `
    <h1 class="title">${TITLES.notebook}</h1>
    <p class="placeholder">Obsidian-style markdown workspace — <code>${escapeHtml(viewState.subfolder)}</code> subfolder.</p>
    ${
      viewState.isBusy
        ? `<p class="busy-message"><span class="spinner" aria-hidden="true"></span>${escapeHtml(viewState.busyLabel)}</p>`
        : ''
    }
    ${
      viewState.statusMessage
        ? `<p class="status-message" role="status">${escapeHtml(viewState.statusMessage)}</p>`
        : ''
    }
    ${
      viewState.errorMessage
        ? `<p class="error-message" role="alert">${escapeHtml(viewState.errorMessage)}</p>`
        : ''
    }
    <div class="notebook">
      <div class="notebook-tree">
        <div class="notebook-create-row">
          <input
            class="text-input"
            id="notebook-new-path"
            placeholder="e.g. backlog/new-idea.md"
            ${viewState.isBusy ? 'disabled' : ''}
          >
          <div class="notebook-create-buttons">
            <button class="primary-button" id="notebook-new-note-button" ${viewState.isBusy ? 'disabled' : ''}>New note</button>
            <button class="primary-button" id="notebook-new-folder-button" ${viewState.isBusy ? 'disabled' : ''}>New folder</button>
          </div>
          <p class="field-help">
            Relative to <code>${escapeHtml(viewState.subfolder)}</code> — a path with slashes creates any folders it needs.
            "New folder" adds an empty <code>untitled.md</code> inside it, since git can't track an empty folder on its own.
          </p>
        </div>
        ${fileTreeHtml}
      </div>
      <div class="notebook-editor">
        ${
          hasSelection
            ? `
              <p class="notebook-editor-path"><code>${escapeHtml(viewState.selectedFilePath)}</code></p>
              ${frontmatterSummaryHtml(viewState.selectedFileContent)}
              <textarea
                class="notebook-editor-content"
                id="notebook-file-content"
                ${viewState.isBusy ? 'disabled' : ''}
              >${escapeHtml(viewState.selectedFileContent)}</textarea>
              <div class="button-row">
                <button class="primary-button" id="notebook-save-button" ${viewState.isBusy ? 'disabled' : ''}>Save</button>
              </div>
            `
            : '<p class="empty-state">Select a file from the tree to view and edit it.</p>'
        }
      </div>
    </div>
  `;
}

// Read-only iCal feed URLs the AI/Upcoming list can merge events from (#23/#24) — persisted at
// `<subfolder>/calendars.json`, a plain synced vault file (unlike the git-ignored local settings
// from #89: a feed URL isn't a credential, and the whole point here is it follows the user
// across devices via the same sync as their notes).
export type CalendarFeed = {
  label: string;
  url: string;
};

type SettingsScreenState = {
  folderName: string | null;
  subfolder: string;
  files: string[];
  selectedFilePath: string;
  selectedFileContent: string;
  history: RepositoryHistoryEntry[];
  pendingChanges: RepositoryChange[];
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
  conflict: ConflictInfo | null;
  conflictChoices: Record<string, ConflictSide>;
  aiConfig: AiConfigView;
  aiProvider: AiProvider;
  aiApiKey: string;
  aiModel: string;
  aiBaseUrl: string;
  aiModels: string[];
  calendarFeeds: CalendarFeed[];
};

const CHANGE_TYPE_LABEL: Record<RepositoryChange['changeType'], string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
};

export function renderSettingsScreen(state?: SettingsScreenState): string {
  const viewState = state ?? {
    folderName: null,
    files: [],
    selectedFilePath: '',
    selectedFileContent: '',
    history: [],
    pendingChanges: [],
    subfolder: 'todowai',
    expandedFolders: new Set<string>(),
    isBusy: false,
    busyLabel: '',
    statusMessage: '',
    errorMessage: '',
    commitAuthorName: 'Todowai User',
    commitAuthorEmail: 'todowai@example.invalid',
    commitMessage: 'feat: update Todowai note',
    remoteUrl: '',
    remoteUsername: '',
    remoteToken: '',
    configuredRemotes: [],
    conflict: null,
    conflictChoices: {},
    aiConfig: { provider: null, model: null, baseUrl: null, configured: false },
    aiProvider: 'anthropic' as AiProvider,
    aiApiKey: '',
    aiModel: '',
    aiBaseUrl: '',
    aiModels: [],
    calendarFeeds: [],
  };

  const fileTree = buildFileTree(viewState.files);
  const fileTreeHtml =
    fileTree.length > 0
      ? `<ul class="tree-root">${renderFileTreeNodes(fileTree, viewState.selectedFilePath, viewState.expandedFolders, viewState.isBusy, 0)}</ul>`
      : '<p class="empty-state">No files found (outside .git and .obsidian) yet.</p>';

  const historyItems =
    viewState.history.length > 0
      ? viewState.history
          .map(
            (entry) => `
              <li class="history-entry">
                <strong>${escapeHtml(entry.message || '(no message)')}</strong>
                <span>${escapeHtml(entry.authorName)} · ${escapeHtml(entry.authorEmail)}</span>
                <span>${escapeHtml(entry.committedAt)}</span>
                <code>${escapeHtml(entry.oid.slice(0, 7))}</code>
              </li>
            `
          )
          .join('')
      : '<li class="empty-state">No commits were found yet.</li>';

  const pendingChangeItems =
    viewState.pendingChanges.length > 0
      ? viewState.pendingChanges
          .map(
            (change) => `
              <li class="change-entry change-entry-${change.changeType}">
                <span class="change-type">${CHANGE_TYPE_LABEL[change.changeType]}</span>
                <span class="change-path">${escapeHtml(change.filepath)}</span>
              </li>
            `
          )
          .join('')
      : '<li class="empty-state">No pending changes.</li>';

  return `
    <h1 class="title">${TITLES.settings}</h1>
    <p class="placeholder">Storage and git configuration.</p>

    <section class="settings-stack">
      <article class="card">
        <h2 class="section-title">Repository</h2>
        <p class="section-copy">
          Served by the backend from its mounted vault — there's nothing to open or pick here.
        </p>
        <button class="primary-button" id="refresh-repo-button" ${viewState.isBusy ? 'disabled' : ''}>
          Refresh from backend
        </button>
        <p class="field-help">
          Connected vault: <strong>${escapeHtml(viewState.folderName ?? 'Not connected yet')}</strong>
        </p>

        <p class="field-label">Todowai subfolder</p>
        <p class="field-help">
          <code>${escapeHtml(viewState.subfolder)}</code> — configured on the backend (<code>TODOWAI_SUBFOLDER</code>),
          not editable here. New notes Todowai creates go here. You can still read and edit other notes anywhere in
          the vault (e.g. an existing Obsidian vault) — Todowai just won't create or delete files outside this
          folder. <code>.git</code> and <code>.obsidian</code> are always off-limits.
        </p>
        ${
          viewState.isBusy
            ? `<p class="busy-message"><span class="spinner" aria-hidden="true"></span>${escapeHtml(viewState.busyLabel)}</p>`
            : ''
        }
        ${
          viewState.statusMessage
            ? `<p class="status-message" role="status">${escapeHtml(viewState.statusMessage)}</p>`
            : ''
        }
        ${
          viewState.errorMessage
            ? `<p class="error-message" role="alert">${escapeHtml(viewState.errorMessage)}</p>`
            : ''
        }
      </article>

      <article class="card">
        <h2 class="section-title">Remote sync</h2>
        <p class="section-copy">
          Optional: connect a git remote to sync this vault. Credentials are saved to a
          git-ignored settings file inside this vault's Todowai subfolder — never committed, and
          never sent back to the browser once saved — so you won't need to re-enter them after a
          restart. If a remote was already configured (via that file or environment variables),
          these fields will look empty here — that's expected. Leave them blank and just watch
          the sync status in the sidebar rather than resaving, or fill them in to override.
        </p>
        <label class="field-label" for="remote-url">Remote URL</label>
        <input class="text-input" id="remote-url" list="configured-remotes" value="${escapeHtmlAttribute(viewState.remoteUrl)}" placeholder="https://github.com/you/notes.git">
        <datalist id="configured-remotes">${configuredRemoteOptions(viewState.configuredRemotes)}</datalist>
        ${
          viewState.configuredRemotes.length > 0
            ? `<p class="field-help">Suggestions from this repository's existing git remotes (${viewState.configuredRemotes
                .map((remote) => escapeHtml(remote.name))
                .join(', ')}).</p>`
            : ''
        }
        <label class="field-label" for="remote-username">Username</label>
        <input class="text-input" id="remote-username" value="${escapeHtmlAttribute(viewState.remoteUsername)}" placeholder="git">
        <label class="field-label" for="remote-token">Personal access token</label>
        <input class="text-input" type="password" id="remote-token" value="${escapeHtmlAttribute(viewState.remoteToken)}" placeholder="•••••••••••">
        <div class="button-row">
          <button class="primary-button" id="save-remote-button" ${viewState.isBusy ? 'disabled' : ''}>Save remote settings</button>
        </div>
        <p class="field-help">Leave the URL blank and save to disconnect the remote entirely.</p>
      </article>

      <article class="card">
        <h2 class="section-title">AI provider</h2>
        <p class="section-copy">
          Optional: connect an AI provider so Capture's "Let AI propose" button can draft a
          classification for you. Credentials are saved to a git-ignored settings file inside
          this vault's Todowai subfolder — never committed, and never sent back to the browser
          once saved — so you won't need to re-enter them after a restart. Currently:
          <strong>${
            viewState.aiConfig.configured
              ? `${escapeHtml(aiProviderLabel(viewState.aiConfig.provider))}${
                  viewState.aiConfig.model ? ` (${escapeHtml(viewState.aiConfig.model)})` : ''
                }`
              : 'not configured'
          }</strong>.
        </p>
        <label class="field-label" for="ai-provider">Provider</label>
        <select class="text-input" id="ai-provider" ${viewState.isBusy ? 'disabled' : ''}>
          ${AI_PROVIDER_OPTIONS.map(
            (option) =>
              `<option value="${option.value}" ${option.value === viewState.aiProvider ? 'selected' : ''}>${option.label}</option>`
          ).join('')}
        </select>
        <label class="field-label" for="ai-api-key">API key</label>
        <input
          class="text-input"
          type="password"
          id="ai-api-key"
          value="${escapeHtmlAttribute(viewState.aiApiKey)}"
          placeholder="not needed for Ollama"
          ${viewState.isBusy ? 'disabled' : ''}
        >
        <label class="field-label" for="ai-model">Model</label>
        <input
          class="text-input"
          id="ai-model"
          list="ai-models"
          value="${escapeHtmlAttribute(viewState.aiModel)}"
          placeholder="optional for Anthropic (defaults to claude-opus-5); required for other providers"
          ${viewState.isBusy ? 'disabled' : ''}
        >
        <datalist id="ai-models">${aiModelOptions(viewState.aiModels)}</datalist>
        ${
          viewState.aiModels.length > 0
            ? `<p class="field-help">Available from the configured provider: ${viewState.aiModels
                .map((model) => escapeHtml(model))
                .join(', ')}.</p>`
            : ''
        }
        <label class="field-label" for="ai-base-url">Base URL</label>
        <input
          class="text-input"
          id="ai-base-url"
          value="${escapeHtmlAttribute(viewState.aiBaseUrl)}"
          placeholder="override the default endpoint — e.g. for Ollama or a self-hosted server"
          ${viewState.isBusy ? 'disabled' : ''}
        >
        <div class="button-row">
          <button class="primary-button" id="save-ai-config-button" ${viewState.isBusy ? 'disabled' : ''}>Save AI settings</button>
          <button class="secondary-button" id="clear-ai-config-button" ${viewState.isBusy ? 'disabled' : ''}>Clear</button>
        </div>
      </article>

      <article class="card">
        <h2 class="section-title">Calendar feeds</h2>
        <p class="section-copy">
          Optional: read-only calendar feed URLs (e.g. iCal links), each with a label (e.g.
          "Work", "Personal") — merged into what's upcoming. Saved to this vault and synced like
          any other note; unlike Remote sync/AI provider above, a feed URL isn't a credential, so
          this file isn't git-ignored.
        </p>
        ${
          viewState.calendarFeeds.length > 0
            ? viewState.calendarFeeds
                .map(
                  (feed, index) => `
                    <div class="calendar-row">
                      <input
                        class="text-input label-input"
                        data-calendar-label="${index}"
                        value="${escapeHtmlAttribute(feed.label)}"
                        placeholder="Work"
                        ${viewState.isBusy ? 'disabled' : ''}
                      >
                      <input
                        class="text-input"
                        data-calendar-url="${index}"
                        value="${escapeHtmlAttribute(feed.url)}"
                        placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
                        ${viewState.isBusy ? 'disabled' : ''}
                      >
                      <button class="secondary-button" data-remove-calendar="${index}" ${viewState.isBusy ? 'disabled' : ''}>Remove</button>
                    </div>
                  `
                )
                .join('')
            : '<p class="empty-state">No calendar feeds yet.</p>'
        }
        <div class="button-row">
          <button class="secondary-button" id="add-calendar-button" ${viewState.isBusy ? 'disabled' : ''}>+ Add calendar</button>
          <button class="primary-button" id="save-calendars-button" ${viewState.isBusy ? 'disabled' : ''}>Save calendar feeds</button>
        </div>
      </article>

      ${viewState.conflict ? renderConflictCard(viewState.conflict, viewState.conflictChoices, viewState.isBusy) : ''}

      <div class="settings-grid">
        <article class="card">
          <h2 class="section-title">Repository files</h2>
          <div class="file-list">${fileTreeHtml}</div>
        </article>

        <article class="card">
          <h2 class="section-title">File editor</h2>
          <label class="field-label" for="repo-file-path">Relative file path</label>
          <input class="text-input" id="repo-file-path" value="${escapeHtmlAttribute(viewState.selectedFilePath)}" placeholder="notes/todowai.md">
          <label class="field-label" for="repo-file-content">File contents</label>
          <textarea class="text-area" id="repo-file-content" placeholder="Write Markdown here...">${escapeHtml(
            viewState.selectedFileContent
          )}</textarea>
          <div class="button-row">
            <button class="primary-button" id="save-file-button" ${viewState.folderName && !viewState.isBusy ? '' : 'disabled'}>Save file</button>
          </div>
        </article>
      </div>

      <div class="settings-grid">
        <article class="card">
          <h2 class="section-title">Pending changes</h2>
          <ul class="change-list">${pendingChangeItems}</ul>
        </article>

        <article class="card">
          <h2 class="section-title">Commit changes</h2>
          <label class="field-label" for="commit-author-name">Author name</label>
          <input class="text-input" id="commit-author-name" value="${escapeHtmlAttribute(viewState.commitAuthorName)}">
          <label class="field-label" for="commit-author-email">Author email</label>
          <input class="text-input" id="commit-author-email" value="${escapeHtmlAttribute(viewState.commitAuthorEmail)}">
          <label class="field-label" for="commit-message">Commit message</label>
          <input class="text-input" id="commit-message" value="${escapeHtmlAttribute(viewState.commitMessage)}">
          <div class="button-row">
            <button class="primary-button" id="commit-changes-button" ${viewState.folderName && viewState.pendingChanges.length > 0 && !viewState.isBusy ? '' : 'disabled'}>Commit all changes</button>
          </div>
        </article>

        <article class="card">
          <h2 class="section-title">Recent history</h2>
          <ol class="history-list">${historyItems}</ol>
        </article>
      </div>
    </section>
  `;
}

// Deliberately just "keep mine" / "keep remote" per file, not a hand-edited merge — a full
// diff/merge editor is out of scope for v1 (#13). Local work stays exactly as it was and fully
// editable while a conflict is pending (see the backend's clean-abort-on-conflict behavior);
// this card is the one place that pending state becomes actionable instead of just a status dot.
function renderConflictCard(conflict: ConflictInfo, choices: Record<string, ConflictSide>, isBusy: boolean): string {
  const fileRows = conflict.files
    .map((file) => {
      const choice = choices[file] ?? 'mine';
      const radio = (side: ConflictSide, label: string) => `
        <label class="conflict-choice">
          <input
            type="radio"
            name="conflict-${escapeHtmlAttribute(file)}"
            value="${side}"
            data-conflict-file="${escapeHtmlAttribute(file)}"
            ${choice === side ? 'checked' : ''}
            ${isBusy ? 'disabled' : ''}
          >
          ${label}
        </label>
      `;
      return `
        <li class="conflict-file">
          <code class="conflict-file-path">${escapeHtml(file)}</code>
          <div class="conflict-choice-row">
            ${radio('mine', 'Keep mine')}
            ${radio('theirs', 'Keep remote')}
          </div>
        </li>
      `;
    })
    .join('');

  return `
    <article class="card conflict-card">
      <h2 class="section-title">Merge conflict</h2>
      <p class="section-copy">
        Local and remote history couldn't be merged automatically for the file${conflict.files.length === 1 ? '' : 's'} below.
        Everything else already synced normally. Pick which version to keep for each one, then resolve to continue syncing —
        you can keep editing other files in the meantime.
      </p>
      <ul class="conflict-file-list">${fileRows}</ul>
      <div class="button-row">
        <button class="primary-button" id="resolve-conflict-button" ${isBusy ? 'disabled' : ''}>Resolve and sync</button>
      </div>
    </article>
  `;
}

function configuredRemoteOptions(remotes: ConfiguredRemote[]): string {
  return remotes
    .map(
      (remote) =>
        `<option value="${escapeHtmlAttribute(remote.url)}" label="${escapeHtmlAttribute(remote.name)}"></option>`
    )
    .join('');
}

function aiModelOptions(models: string[]): string {
  return models.map((model) => `<option value="${escapeHtmlAttribute(model)}"></option>`).join('');
}

function renderFileTreeNodes(
  nodes: FileTreeNode[],
  selectedFilePath: string,
  expandedFolders: Set<string>,
  isBusy: boolean,
  depth: number
): string {
  const indent = depth * 16 + 10;

  return nodes
    .map((node) => {
      if (node.type === 'file') {
        return `
          <li class="tree-row">
            <button
              class="tree-file${node.path === selectedFilePath ? ' active' : ''}"
              data-file-path="${escapeHtmlAttribute(node.path)}"
              style="padding-left: ${indent}px"
              ${isBusy ? 'disabled' : ''}
            >${escapeHtml(node.name)}</button>
          </li>
        `;
      }

      const isExpanded = expandedFolders.has(node.path);
      return `
        <li class="tree-row">
          <button class="tree-folder" data-toggle-folder="${escapeHtmlAttribute(node.path)}" style="padding-left: ${indent}px">
            <span class="tree-disclosure">${isExpanded ? '▾' : '▸'}</span>${escapeHtml(node.name)}
          </button>
          ${
            isExpanded
              ? `<ul class="tree-children">${renderFileTreeNodes(node.children, selectedFilePath, expandedFolders, isBusy, depth + 1)}</ul>`
              : ''
          }
        </li>
      `;
    })
    .join('');
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll('`', '&#96;');
}
