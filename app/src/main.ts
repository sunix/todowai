import './style.css';
import { topLevelFolders } from './file-tree';
import { commitAll, fetchSnapshot, readFile, writeFile } from './repository';
import { SCREENS, currentScreen, navigateTo, onRouteChange } from './router';
import { renderScreen, renderSettingsScreen } from './screens';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="app-shell">
    <nav class="sidebar" id="sidebar"></nav>
    <main id="main"></main>
  </div>
`;

const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
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
};

sidebar.innerHTML = SCREENS.map(
  (screen) => `<button data-screen="${screen.id}"><span class="icon">${screen.icon}</span> ${screen.label}</button>`
).join('');

sidebar.addEventListener('click', (event) => {
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
        })
      : renderScreen(screen);
  sidebar.querySelectorAll<HTMLButtonElement>('button[data-screen]').forEach((button) => {
    button.classList.toggle('active', button.dataset.screen === screen);
  });

  if (screen === 'settings') {
    bindSettingsScreen();
  }
}

onRouteChange(render);
render();

// There's nothing to "open" any more — the backend already owns the vault (mounted via Docker
// at startup) — so this loads automatically once on startup, rather than waiting for a picker
// button click like the superseded browser-only flow did.
void loadSnapshot('Connecting to backend…');

function bindSettingsScreen(): void {
  main.querySelector<HTMLButtonElement>('#refresh-repo-button')?.addEventListener('click', async () => {
    await loadSnapshot('Refreshing from backend…');
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
