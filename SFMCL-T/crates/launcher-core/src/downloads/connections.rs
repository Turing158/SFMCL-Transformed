use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

/// One permit per live HTTP response, shared by transfers and source probes.
/// Files with fewer live requests get first choice; ties rotate file groups.
pub(crate) struct Connections {
    state: Mutex<State>,
    changed: Notify,
}
struct State {
    limit: usize,
    active: usize,
    groups: HashMap<String, usize>,
    served: HashMap<String, u64>,
    turn: u64,
    waiting: Vec<(u64, String)>,
    next: u64,
}
impl Connections {
    pub fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                limit: limit.clamp(1, 32),
                active: 0,
                groups: HashMap::new(),
                served: HashMap::new(),
                turn: 0,
                waiting: Vec::new(),
                next: 0,
            }),
            changed: Notify::new(),
        })
    }
    pub fn set_limit(&self, limit: usize) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).limit = limit.clamp(1, 32);
        self.changed.notify_waiters();
    }
    pub async fn acquire(self: &Arc<Self>, group: &str) -> Permit {
        let ticket = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let ticket = state.next;
            state.next += 1;
            state.waiting.push((ticket, group.into()));
            // A newcomer gets an early turn without repeatedly outranking
            // older files when a stream of small files keeps arriving.
            let welcome_turn = state.turn.saturating_sub(1);
            state.served.entry(group.into()).or_insert(welcome_turn);
            ticket
        };
        let mut waiter = Waiter {
            slots: self.clone(),
            ticket,
            queued: true,
            group: group.into(),
        };
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                let chosen = state
                    .waiting
                    .iter()
                    .min_by_key(|(ticket, group)| {
                        (
                            state.groups.get(group).copied().unwrap_or(0),
                            state.served.get(group).copied().unwrap_or(0),
                            *ticket,
                        )
                    })
                    .map(|(ticket, _)| *ticket);
                if state.active < state.limit && chosen == Some(ticket) {
                    state.waiting.retain(|(id, _)| *id != ticket);
                    state.active += 1;
                    *state.groups.entry(group.into()).or_default() += 1;
                    state.turn += 1;
                    let turn = state.turn;
                    state.served.insert(group.into(), turn);
                    waiter.queued = false;
                    self.changed.notify_waiters();
                    return Permit {
                        slots: self.clone(),
                        group: group.into(),
                    };
                }
            }
            changed.await;
        }
    }
}
struct Waiter {
    slots: Arc<Connections>,
    ticket: u64,
    queued: bool,
    group: String,
}
impl Drop for Waiter {
    fn drop(&mut self) {
        if self.queued {
            let mut state = self.slots.state.lock().unwrap_or_else(|e| e.into_inner());
            state.waiting.retain(|(id, _)| *id != self.ticket);
            if !state.groups.contains_key(&self.group)
                && !state.waiting.iter().any(|(_, group)| *group == self.group)
            {
                state.served.remove(&self.group);
            }
            self.slots.changed.notify_waiters();
        }
    }
}
pub(crate) struct Permit {
    slots: Arc<Connections>,
    group: String,
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self.slots.state.lock().unwrap_or_else(|e| e.into_inner());
        state.active -= 1;
        let active = state.groups.get_mut(&self.group).unwrap();
        *active -= 1;
        if *active == 0 {
            state.groups.remove(&self.group);
            if !state.waiting.iter().any(|(_, group)| *group == self.group) {
                state.served.remove(&self.group);
            }
        }
        self.slots.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::poll;
    #[tokio::test]
    async fn one_connection_rotates_files_before_queued_extra_segments() {
        let slots = Connections::new(1);
        let first = slots.acquire("large").await;
        let extra = slots.acquire("large");
        tokio::pin!(extra);
        assert!(poll!(extra.as_mut()).is_pending());
        let late = slots.acquire("small");
        tokio::pin!(late);
        assert!(poll!(late.as_mut()).is_pending());
        drop(first);
        assert!(poll!(extra.as_mut()).is_pending());
        let late = late.await;
        drop(late);
        let extra = extra.await;
        drop(extra);
        assert!(slots.state.lock().unwrap().served.is_empty());
    }
    #[tokio::test]
    async fn fairness_resize_and_cancel() {
        let slots = Connections::new(1);
        let first = slots.acquire("large").await;
        let extra = slots.acquire("large");
        tokio::pin!(extra);
        assert!(poll!(extra.as_mut()).is_pending());
        let small = slots.acquire("small");
        tokio::pin!(small);
        assert!(poll!(small.as_mut()).is_pending());
        slots.set_limit(2);
        assert!(poll!(extra.as_mut()).is_pending());
        let basic = small.await;
        slots.set_limit(1);
        drop(first);
        assert!(poll!(extra.as_mut()).is_pending());
        drop(basic);
        let extra = extra.await;
        {
            let abandoned = slots.acquire("abandoned");
            tokio::pin!(abandoned);
            assert!(poll!(abandoned.as_mut()).is_pending());
        }
        drop(extra);
        assert_eq!(slots.state.lock().unwrap().active, 0);
        assert!(slots.state.lock().unwrap().waiting.is_empty());
        let _next = slots.acquire("next").await;
    }
}
