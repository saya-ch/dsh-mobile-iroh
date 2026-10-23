//! Monotonic request ownership shared by JNI connect and cancellation.

/// A cancelled request stays cancelled even if its worker enters JNI afterwards.
pub(crate) struct SessionOwner<T> {
    highest: u64,
    current: Option<(u64, T)>,
}

impl<T> Default for SessionOwner<T> {
    fn default() -> Self {
        Self {
            highest: 0,
            current: None,
        }
    }
}

impl<T> SessionOwner<T> {
    /// Observe only the exact current request without exposing another owner's resource.
    pub(crate) fn get(&self, id: u64) -> Option<&T> {
        self.current
            .as_ref()
            .and_then(|(current, resource)| (*current == id).then_some(resource))
    }
    /// Reserve a fresh request, returning prior resources for cleanup outside the lock.
    pub(crate) fn begin(&mut self, id: u64, resource: T) -> Result<Option<T>, T> {
        if id == 0 || id <= self.highest {
            return Err(resource);
        }
        self.highest = id;
        Ok(self
            .current
            .replace((id, resource))
            .map(|(_, previous)| previous))
    }

    /// Publish only to the request that still owns the session.
    pub(crate) fn replace(&mut self, id: u64, resource: T) -> Result<T, T> {
        match self.current.as_mut() {
            Some((current, previous)) if *current == id => {
                Ok(std::mem::replace(previous, resource))
            }
            _ => Err(resource),
        }
    }

    /// Withdraw this request and prevent a queued worker from resurrecting it.
    pub(crate) fn cancel(&mut self, id: u64) -> Option<T> {
        if id == 0 {
            return None;
        }
        self.highest = self.highest.max(id);
        if self
            .current
            .as_ref()
            .is_some_and(|(current, _)| *current == id)
        {
            self.current.take().map(|(_, resource)| resource)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SessionOwner;

    #[test]
    fn cancellation_before_jni_entry_rejects_queued_connect() {
        let mut owner = SessionOwner::default();
        assert_eq!(owner.cancel(1), None);
        assert_eq!(owner.begin(1, "late worker"), Err("late worker"));
    }

    #[test]
    fn late_completion_and_old_close_cannot_replace_or_close_new_session() {
        let mut owner = SessionOwner::default();
        assert_eq!(owner.begin(1, "pending one"), Ok(None));
        assert_eq!(owner.begin(2, "pending two"), Ok(Some("pending one")));
        assert_eq!(owner.replace(1, "late one"), Err("late one"));
        assert_eq!(owner.cancel(1), None);
        assert_eq!(owner.replace(2, "connected two"), Ok("pending two"));
        assert_eq!(owner.cancel(2), Some("connected two"));
        assert_eq!(owner.cancel(2), None);
    }

    #[test]
    fn ids_are_positive_and_never_reused() {
        let mut owner = SessionOwner::default();
        assert_eq!(owner.begin(0, "invalid"), Err("invalid"));
        assert_eq!(owner.begin(3, "pending"), Ok(None));
        assert_eq!(owner.begin(3, "duplicate"), Err("duplicate"));
        assert_eq!(owner.begin(2, "older queued"), Err("older queued"));
        assert_eq!(owner.cancel(3), Some("pending"));
    }

    #[test]
    fn cancelling_a_future_worker_does_not_close_another_active_owner() {
        let mut owner = SessionOwner::default();
        assert_eq!(owner.begin(1, "active one"), Ok(None));
        assert_eq!(owner.cancel(2), None);
        assert_eq!(owner.replace(1, "still active one"), Ok("active one"));
        assert_eq!(
            owner.begin(2, "late cancelled two"),
            Err("late cancelled two")
        );
        assert_eq!(owner.cancel(1), Some("still active one"));
    }
}
