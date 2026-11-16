use std::sync::Mutex;
use tokio::sync::Notify;

/// Resizing never interrupts an active file. A lower limit takes effect as
/// existing files finish; a higher limit immediately wakes queued workers.
pub(super) struct Concurrency {
    state: Mutex<State>,
    changed: Notify,
}

struct State {
    limit: usize,
    active: usize,
}

impl Concurrency {
    pub fn new(limit: usize) -> Self {
        Self {
            state: Mutex::new(State {
                limit: limit.clamp(1, 32),
                active: 0,
            }),
            changed: Notify::new(),
        }
    }

    pub fn set_limit(&self, limit: usize) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).limit = limit.clamp(1, 32);
        self.changed.notify_waiters();
    }

    pub async fn acquire(&self) -> Permit<'_> {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            // Register before checking the condition to avoid a lost wakeup.
            changed.as_mut().enable();
            {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                if state.active < state.limit {
                    state.active += 1;
                    return Permit(self);
                }
            }
            changed.await;
        }
    }
}

pub(super) struct Permit<'a>(&'a Concurrency);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active -= 1;
        self.0.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::poll;
    use std::task::Poll;

    #[tokio::test]
    async fn resizing_wakes_waiters_and_drains_without_interrupting_files() {
        let slots = Concurrency::new(1);
        let first = slots.acquire().await;
        let next = slots.acquire();
        tokio::pin!(next);
        assert!(poll!(next.as_mut()).is_pending());
        slots.set_limit(3);
        let second = next.await;
        let third = slots.acquire().await;
        slots.set_limit(1);
        let next = slots.acquire();
        tokio::pin!(next);
        assert!(poll!(next.as_mut()).is_pending());
        drop(first);
        assert!(poll!(next.as_mut()).is_pending());
        drop(second);
        assert!(poll!(next.as_mut()).is_pending());
        drop(third);
        assert!(matches!(poll!(next.as_mut()), Poll::Ready(_)));
    }

    #[tokio::test]
    async fn cancelling_a_waiter_does_not_leak_capacity() {
        let slots = Concurrency::new(1);
        let first = slots.acquire().await;
        {
            let waiting = slots.acquire();
            tokio::pin!(waiting);
            assert!(poll!(waiting.as_mut()).is_pending());
        }
        drop(first);
        let next = slots.acquire();
        tokio::pin!(next);
        assert!(poll!(next.as_mut()).is_ready());
    }
}
