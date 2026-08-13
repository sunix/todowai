use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

use crate::api::SharedRepository;
use crate::repository::{SyncResult, SyncStatus};

/// The actual pull/push work a SyncScheduler drives. Kept separate from SyncScheduler itself
/// (which only handles *when* to call these, not what they do) so the debounce/interval timing
/// mechanics can be tested with a trivial counting fake instead of a real git repository —
/// mirroring how the superseded browser scheduler (#12) took plain `pull`/`push` callbacks for
/// exactly this reason. Synchronous because the real implementation (RepositoryBackend) wraps
/// blocking libgit2 calls, which need spawn_blocking regardless — SyncScheduler does that once,
/// generically, for any backend.
pub trait SyncBackend: Send + Sync + 'static {
    fn pull(&self) -> SyncResult;
    fn push(&self) -> SyncResult;
}

/// The production SyncBackend: pulls/pushes the shared Repository, using the given identity for
/// any synthetic merge commit a non-fast-forward pull produces (not the commit form's per-commit
/// author fields, which are unrelated to this).
pub struct RepositoryBackend {
    pub repository: SharedRepository,
    pub author_name: String,
    pub author_email: String,
}

impl SyncBackend for RepositoryBackend {
    fn pull(&self) -> SyncResult {
        let repository = self.repository.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        repository.pull(&self.author_name, &self.author_email)
    }

    fn push(&self) -> SyncResult {
        let repository = self.repository.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        repository.push()
    }
}

/// Schedules pull/push against a SyncBackend, replacing the browser-based scheduler from the
/// superseded #12 (see specification/decisions.md, ADR-001) with the same design — pull on start
/// and on a background interval, a shared push entry point with an `immediate` flag — running
/// here instead, where there's no browser CORS restriction on the git protocol.
///
/// Unlike the old per-browser-tab scheduler, this runs for the lifetime of the backend process
/// rather than being started/stopped per session, so it's always started once at boot (see
/// main.rs) regardless of whether a remote is configured yet — pulling/pushing with no remote
/// configured is a cheap, immediate no-op (see Repository::pull/push), not a real network call.
pub struct SyncScheduler<B: SyncBackend = RepositoryBackend> {
    inner: Arc<Inner<B>>,
}

impl<B: SyncBackend> Clone for SyncScheduler<B> {
    fn clone(&self) -> Self {
        Self { inner: self.inner.clone() }
    }
}

struct Inner<B: SyncBackend> {
    backend: B,
    push_debounce: Duration,
    background_pull_interval: Duration,
    pending_push: AsyncMutex<Option<JoinHandle<()>>>,
    status: Mutex<SyncResult>,
}

impl<B: SyncBackend> SyncScheduler<B> {
    pub fn new(backend: B, push_debounce: Duration, background_pull_interval: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                backend,
                push_debounce,
                background_pull_interval,
                pending_push: AsyncMutex::new(None),
                status: Mutex::new(SyncResult {
                    status: SyncStatus::Error,
                    message: "No remote configured.".to_string(),
                }),
            }),
        }
    }

    pub fn status(&self) -> SyncResult {
        self.inner.status.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    /// Fire-and-forget: spawns the pull-on-start-then-interval loop and returns immediately.
    /// Never awaited by the caller, matching the offline-first NFR that sync must never block
    /// startup or any request.
    pub fn start(&self) {
        let scheduler = self.clone();
        tokio::spawn(async move {
            scheduler.pull_now().await;

            let mut interval = tokio::time::interval(scheduler.inner.background_pull_interval);
            // interval() fires its first tick immediately on creation; consume that one here so
            // the loop's own tick().await waits a full interval before the *next* pull, rather
            // than firing a redundant second one right away.
            interval.tick().await;
            loop {
                interval.tick().await;
                scheduler.pull_now().await;
            }
        });
    }

    pub async fn pull_now(&self) {
        let inner = self.inner.clone();
        let result = tokio::task::spawn_blocking(move || inner.backend.pull())
            .await
            .unwrap_or_else(|_| SyncResult {
                status: SyncStatus::Error,
                message: "Pull task panicked.".to_string(),
            });
        *self.inner.status.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = result;
    }

    async fn push_now(&self) {
        let inner = self.inner.clone();
        let result = tokio::task::spawn_blocking(move || inner.backend.push())
            .await
            .unwrap_or_else(|_| SyncResult {
                status: SyncStatus::Error,
                message: "Push task panicked.".to_string(),
            });
        *self.inner.status.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = result;
    }

    /// A shared entry point for both manual edits (debounced) and a future AI-edit path
    /// (`immediate: true`) — mirrors the superseded browser scheduler's design exactly, per
    /// #62's acceptance criteria. A new debounced call cancels and restarts any pending one
    /// (coalescing several rapid edits into a single push) rather than queuing multiple pushes;
    /// `immediate` bypasses the debounce and cancels a pending debounced push outright.
    ///
    /// Known limitation, acceptable for v1: if a call arrives while a previously scheduled push
    /// is already mid-flight (past the debounce sleep, inside push_now's network call), aborting
    /// it cannot stop the in-flight libgit2 call (spawn_blocking work isn't preemptible) — the
    /// push itself still completes, only its status-recording update may be dropped.
    pub async fn request_push(&self, immediate: bool) {
        let mut pending = self.inner.pending_push.lock().await;
        if let Some(handle) = pending.take() {
            handle.abort();
        }

        if immediate {
            drop(pending);
            self.push_now().await;
            return;
        }

        let scheduler = self.clone();
        let debounce = self.inner.push_debounce;
        *pending = Some(tokio::spawn(async move {
            tokio::time::sleep(debounce).await;
            scheduler.push_now().await;
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingBackend {
        pull_count: Arc<AtomicUsize>,
        push_count: Arc<AtomicUsize>,
    }

    impl SyncBackend for CountingBackend {
        fn pull(&self) -> SyncResult {
            self.pull_count.fetch_add(1, Ordering::SeqCst);
            SyncResult { status: SyncStatus::Synced, message: "pulled".to_string() }
        }

        fn push(&self) -> SyncResult {
            self.push_count.fetch_add(1, Ordering::SeqCst);
            SyncResult { status: SyncStatus::Synced, message: "pushed".to_string() }
        }
    }

    fn counting_scheduler(push_debounce_ms: u64, background_pull_interval_ms: u64) -> (SyncScheduler<CountingBackend>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let pull_count = Arc::new(AtomicUsize::new(0));
        let push_count = Arc::new(AtomicUsize::new(0));
        let backend = CountingBackend { pull_count: pull_count.clone(), push_count: push_count.clone() };
        let scheduler = SyncScheduler::new(
            backend,
            Duration::from_millis(push_debounce_ms),
            Duration::from_millis(background_pull_interval_ms),
        );
        (scheduler, pull_count, push_count)
    }

    #[tokio::test]
    async fn debounce_coalesces_multiple_requests_into_one_push() {
        let (scheduler, _pull_count, push_count) = counting_scheduler(50, 100_000);

        scheduler.request_push(false).await;
        scheduler.request_push(false).await; // resets the timer — should not cause 2 pushes
        scheduler.request_push(false).await;
        assert_eq!(push_count.load(Ordering::SeqCst), 0, "push should not fire before the debounce elapses");

        tokio::time::sleep(Duration::from_millis(90)).await;
        assert_eq!(push_count.load(Ordering::SeqCst), 1, "push should fire exactly once after the debounce, even after 3 requests");
    }

    #[tokio::test]
    async fn immediate_bypasses_the_debounce() {
        let (scheduler, _pull_count, push_count) = counting_scheduler(5_000, 100_000);

        scheduler.request_push(true).await;
        assert_eq!(push_count.load(Ordering::SeqCst), 1, "immediate push should fire right away, bypassing the debounce entirely");
    }

    #[tokio::test]
    async fn immediate_cancels_a_pending_debounced_push_rather_than_both_firing() {
        let (scheduler, _pull_count, push_count) = counting_scheduler(50, 100_000);

        scheduler.request_push(false).await; // debounced, would fire at ~50ms
        scheduler.request_push(true).await; // fires now AND should cancel the pending debounced one
        tokio::time::sleep(Duration::from_millis(90)).await; // past when the debounced one would have fired too

        assert_eq!(push_count.load(Ordering::SeqCst), 1, "expected exactly 1 push (immediate cancels the pending debounced one)");
    }

    #[tokio::test]
    async fn start_pulls_immediately_then_on_the_background_interval() {
        let (scheduler, pull_count, _push_count) = counting_scheduler(100_000, 30);

        scheduler.start();
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(pull_count.load(Ordering::SeqCst), 1, "start() should pull immediately");

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(pull_count.load(Ordering::SeqCst) >= 2, "background interval should have triggered at least one more pull");
    }

    #[tokio::test]
    async fn status_reflects_the_most_recent_result() {
        let (scheduler, _pull_count, _push_count) = counting_scheduler(100_000, 100_000);

        scheduler.pull_now().await;
        assert_eq!(scheduler.status().status, SyncStatus::Synced);
        assert_eq!(scheduler.status().message, "pulled");
    }
}
