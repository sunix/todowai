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
