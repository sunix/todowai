// Pure timer/debounce logic for the offline-first sync engine — deliberately independent of
// RepositoryController and the DOM so it can be unit-tested with real (short) timers instead of
// a full mock File System Access setup. main.ts wires this to RepositoryController.pull/push.

export type SyncSchedulerOptions = {
  pull: () => Promise<void>;
  push: () => Promise<void>;
  pushDebounceMs: number;
  backgroundPullIntervalMs: number;
  // Defaults to the Page Visibility API; overridable for tests.
  isForegrounded?: () => boolean;
};

export type SyncScheduler = {
  start(): void;
  stop(): void;
  pullNow(): void;
  // Manual saves call this with immediate:false (or omitted) to debounce; a future AI-edit path
  // (and, for now, tests standing in for it) calls it with immediate:true to push right away.
  requestPush(options?: { immediate?: boolean }): void;
};

function defaultIsForegrounded(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

export function createSyncScheduler(options: SyncSchedulerOptions): SyncScheduler {
  const isForegrounded = options.isForegrounded ?? defaultIsForegrounded;

  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let backgroundTimer: ReturnType<typeof setInterval> | null = null;

  function pullNow(): void {
    void options.pull();
  }

  function requestPush(requestOptions: { immediate?: boolean } = {}): void {
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }

    if (requestOptions.immediate) {
      void options.push();
      return;
    }

    pushTimer = setTimeout(() => {
      pushTimer = null;
      void options.push();
    }, options.pushDebounceMs);
  }

  function start(): void {
    pullNow();
    backgroundTimer = setInterval(() => {
      if (isForegrounded()) {
        pullNow();
      }
    }, options.backgroundPullIntervalMs);
  }

  function stop(): void {
    if (backgroundTimer) {
      clearInterval(backgroundTimer);
      backgroundTimer = null;
    }
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
  }

  return { start, stop, pullNow, requestPush };
}
