import { buildFileTree, type FileTreeNode } from './file-tree';
import type { ConfiguredRemote, ConflictInfo, ConflictSide, RepositoryChange, RepositoryHistoryEntry } from './repository';
import type { ScreenId } from './router';

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
          Optional: connect a git remote to sync this vault. Credentials are kept in memory on
          the backend only, never written to disk. If a remote was already configured via
          environment variables, these fields will look empty here — that's expected, the backend
          never sends a saved token back to the browser. Leave them blank and just watch the sync
          status in the sidebar rather than resaving, or fill them in to override.
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
