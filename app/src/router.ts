export type ScreenId =
  | 'capture'
  | 'notebook'
  | 'next-action'
  | 'projects'
  | 'horizon'
  | 'meetings'
  | 'settings';

export const SCREENS: { id: ScreenId; label: string }[] = [
  { id: 'capture', label: 'Capture' },
  { id: 'notebook', label: 'Notebook' },
  { id: 'next-action', label: 'Next Action' },
  { id: 'projects', label: 'Projects' },
  { id: 'horizon', label: 'Horizon' },
  { id: 'meetings', label: 'Meetings' },
  { id: 'settings', label: 'Settings' },
];

const DEFAULT_SCREEN: ScreenId = 'capture';

function isScreenId(value: string): value is ScreenId {
  return SCREENS.some((screen) => screen.id === value);
}

export function currentScreen(): ScreenId {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return isScreenId(hash) ? hash : DEFAULT_SCREEN;
}

export function navigateTo(screen: ScreenId): void {
  window.location.hash = `/${screen}`;
}

export function onRouteChange(callback: (screen: ScreenId) => void): void {
  window.addEventListener('hashchange', () => callback(currentScreen()));
}
