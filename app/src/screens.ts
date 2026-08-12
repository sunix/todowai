import { buildFileTree, type FileTreeNode } from './file-tree';
import type { ConfiguredRemote, RepositoryChange, RepositoryHistoryEntry, SyncStatus } from './repository';
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
  if (screen === 'settings') {
    return renderSettingsScreen();
  }

  return `
    <h1 class="title">${TITLES[screen]}</h1>
    <p class="placeholder">This screen is not implemented yet.</p>
  `;
}

type SettingsScreenState = {
  supportsFileSystemAccess: boolean;
  folderName: string | null;
  files: string[];
  selectedFilePath: string;
  selectedFileContent: string;
  history: RepositoryHistoryEntry[];
  pendingChanges: RepositoryChange[];
  subfolder: string;
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
  syncStatus: SyncStatus | 'idle' | 'syncing';
  syncMessage: string;
};

const CHANGE_TYPE_LABEL: Record<RepositoryChange['changeType'], string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
};

export function renderSettingsScreen(state?: SettingsScreenState): string {
  const viewState = state ?? {
    supportsFileSystemAccess: false,
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
    syncStatus: 'idle' as const,
    syncMessage: 'No remote configured.',
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

  const syncStatusClass = viewState.syncStatus === 'idle' ? '' : ` sync-status-${viewState.syncStatus}`;

  const configuredRemoteOptions = viewState.configuredRemotes
    .map(
      (remote) =>
        `<option value="${escapeHtmlAttribute(remote.url)}" label="${escapeHtmlAttribute(remote.name)}"></option>`
    )
    .join('');

  return `
    <h1 class="title">${TITLES.settings}</h1>
    <p class="placeholder">Storage and git configuration.</p>

    <section class="settings-stack">
      <article class="card">
        <h2 class="section-title">Local repository</h2>
        <p class="section-copy">
          Open an existing local repository with the File System Access API. Todowai uses isomorphic-git for reads,
          writes, commits, and history.
        </p>
        <button class="primary-button" id="open-repo-button" ${viewState.supportsFileSystemAccess && !viewState.isBusy ? '' : 'disabled'}>
          Open local git repository
        </button>
        <p class="field-help">
          ${viewState.supportsFileSystemAccess ? 'Selected folder: ' : 'This browser does not expose the File System Access API. '}
          <strong>${escapeHtml(viewState.folderName ?? 'No folder selected')}</strong>
        </p>

        <label class="field-label" for="todowai-subfolder">Todowai subfolder</label>
        <input class="text-input" id="todowai-subfolder" value="${escapeHtmlAttribute(viewState.subfolder)}" placeholder="todowai">
        <p class="field-help">
          New notes Todowai creates go here. You can still read and edit other notes anywhere in the vault (e.g. an
          existing Obsidian vault) — Todowai just won't create or delete files outside this folder.
          <code>.git</code> and <code>.obsidian</code> are always off-limits.
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
          Optional: connect a git remote to sync across devices. Pulls happen on open and periodically in the
          background; commits push after a short debounce. Credentials are kept in memory only, never persisted.
        </p>
        <label class="field-label" for="remote-url">Remote URL</label>
        <input class="text-input" id="remote-url" list="configured-remotes" value="${escapeHtmlAttribute(viewState.remoteUrl)}" placeholder="https://github.com/you/notes.git">
        <datalist id="configured-remotes">${configuredRemoteOptions}</datalist>
        ${
          viewState.configuredRemotes.length > 0
            ? '<p class="field-help">Suggestions from this repository’s existing git remotes.</p>'
            : ''
        }
        <label class="field-label" for="remote-username">Username</label>
        <input class="text-input" id="remote-username" value="${escapeHtmlAttribute(viewState.remoteUsername)}" placeholder="git">
        <label class="field-label" for="remote-token">Personal access token</label>
        <input class="text-input" type="password" id="remote-token" value="${escapeHtmlAttribute(viewState.remoteToken)}" placeholder="•••••••••••">
        <div class="button-row">
          <button class="primary-button" id="sync-now-button" ${viewState.remoteUrl.trim() ? '' : 'disabled'}>Sync now</button>
        </div>
        <p class="sync-message${syncStatusClass}">${escapeHtml(viewState.syncMessage)}</p>
      </article>

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

function escapeHtml(value: string): string {
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
