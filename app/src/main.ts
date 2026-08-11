import './style.css';
import { SCREENS, currentScreen, navigateTo, onRouteChange } from './router';
import { renderScreen } from './screens';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="app-shell">
    <nav class="sidebar" id="sidebar"></nav>
    <main id="main"></main>
  </div>
`;

const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
const main = document.querySelector<HTMLElement>('#main')!;

sidebar.innerHTML = SCREENS.map(
  (screen) => `<button data-screen="${screen.id}">${screen.label}</button>`
).join('');

sidebar.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-screen]');
  if (button) navigateTo(button.dataset.screen as never);
});

function render(): void {
  const screen = currentScreen();
  main.innerHTML = renderScreen(screen);
  sidebar.querySelectorAll<HTMLButtonElement>('button[data-screen]').forEach((button) => {
    button.classList.toggle('active', button.dataset.screen === screen);
  });
}

onRouteChange(render);
render();
