//! Connection-level metering — and nothing else.
//!
//! PRD §9 privacy posture: connection-level proxy logs (bytes/duration) are
//! retained 7 days for abuse handling, publicly documented; **no content, no
//! URLs, no hostnames**. That promise is enforced by the types here, not by
//! reviewer discipline: [`ConnectionSample`] and [`UserTotals`] contain only
//! numeric fields, so there is no field a hostname *could* be written into.
//! The single string in this module is the user id the sample is keyed by.
//! If you find yourself adding a `host`/`sni`/`url` field here, you are
//! breaking a documented user-facing promise — don't.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

/// One finished tunnel, reduced to the only facts the gateway may keep.
/// Deliberately no `Display`/serialization of anything but numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectionSample {
    /// Bytes spliced client → target.
    pub bytes_to_target: u64,
    /// Bytes spliced target → client.
    pub bytes_to_client: u64,
    pub duration: Duration,
}

/// Running per-user totals. Numeric-only by construction (see module docs).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct UserTotals {
    pub connections: u64,
    pub bytes_to_target: u64,
    pub bytes_to_client: u64,
    pub active_millis: u64,
}

/// Per-user counters, keyed by the authenticated user id from the tunnel
/// token. In-memory here; the 7-day-retention export sits behind this type.
#[derive(Default)]
pub struct EgressMetrics {
    users: Mutex<HashMap<String, UserTotals>>,
}

impl EgressMetrics {
    pub fn record(&self, user_id: &str, sample: ConnectionSample) {
        let mut users = self.users.lock().expect("metrics lock poisoned");
        let t = users.entry(user_id.to_string()).or_default();
        t.connections += 1;
        t.bytes_to_target += sample.bytes_to_target;
        t.bytes_to_client += sample.bytes_to_client;
        t.active_millis += sample.duration.as_millis() as u64;
    }

    pub fn totals(&self, user_id: &str) -> Option<UserTotals> {
        self.users
            .lock()
            .expect("metrics lock poisoned")
            .get(user_id)
            .copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_per_user_counters() {
        let m = EgressMetrics::default();
        m.record(
            "user-a",
            ConnectionSample {
                bytes_to_target: 100,
                bytes_to_client: 2000,
                duration: Duration::from_millis(1500),
            },
        );
        m.record(
            "user-a",
            ConnectionSample {
                bytes_to_target: 50,
                bytes_to_client: 500,
                duration: Duration::from_millis(500),
            },
        );
        m.record(
            "user-b",
            ConnectionSample {
                bytes_to_target: 1,
                bytes_to_client: 1,
                duration: Duration::from_millis(1),
            },
        );

        let a = m.totals("user-a").unwrap();
        assert_eq!(a.connections, 2);
        assert_eq!(a.bytes_to_target, 150);
        assert_eq!(a.bytes_to_client, 2500);
        assert_eq!(a.active_millis, 2000);
        assert_eq!(m.totals("user-b").unwrap().connections, 1);
        assert_eq!(m.totals("nobody"), None);
    }
}
