use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tokio::sync::Mutex;

use async_imap::Session;

use super::client::{self as imap_client, ImapStream};
use super::types::ImapConfig;

type ImapSession = Session<ImapStream>;

const MAX_SESSIONS_PER_KEY: usize = 4;
// iCloud IMAP is sensitive to concurrent connections; Apple rate-limits aggressively.
const MAX_SESSIONS_ICLOUD: usize = 2;
const NOOP_TIMEOUT: Duration = Duration::from_secs(5);

fn max_sessions_for_key(key: &str) -> usize {
    if key.contains("imap.mail.me.com") {
        MAX_SESSIONS_ICLOUD
    } else {
        MAX_SESSIONS_PER_KEY
    }
}

/// Global IMAP session pool. Stored as Tauri managed state so every command shares
/// the same pool. Keyed by "host:port:security:user" — sessions are returned after
/// successful use and reused by the next request, avoiding a full TCP/TLS handshake
/// and LOGIN for every attachment/CID fetch.
pub struct ImapSessionPool {
    sessions: Mutex<HashMap<String, Vec<ImapSession>>>,
    // Server-identity keyed quirk cache (in-memory, reset on app restart). Some
    // servers (DavMail/Exchange proxies, Mailo, ...) return non-standard FETCH
    // responses or silently drop UID range SEARCH queries. Once a quirk is
    // confirmed for a given server, we skip straight to the known-working path
    // instead of re-attempting (and re-downloading) the doomed one on every
    // batch/folder/cycle — this is what turned multi-minute, double-bandwidth
    // syncs on quirky IMAP bridges into single-pass ones.
    raw_fetch_only: Mutex<HashSet<String>>,
    no_range_search: Mutex<HashSet<String>>,
}

fn session_key(config: &ImapConfig) -> String {
    format!("{}:{}:{}:{}", config.host, config.port, config.security, config.username)
}

impl ImapSessionPool {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            raw_fetch_only: Mutex::new(HashSet::new()),
            no_range_search: Mutex::new(HashSet::new()),
        }
    }

    /// True if this server previously returned FETCH responses async-imap
    /// couldn't parse into a body — skip the doomed pooled attempt and go
    /// straight to the raw TCP fetch, which downloads the message bytes once
    /// instead of twice.
    pub async fn needs_raw_fetch(&self, config: &ImapConfig) -> bool {
        self.raw_fetch_only.lock().await.contains(&session_key(config))
    }

    pub async fn mark_raw_fetch_only(&self, config: &ImapConfig) {
        let key = session_key(config);
        if self.raw_fetch_only.lock().await.insert(key.clone()) {
            log::info!("[ImapPool] key={key} confirmed raw-fetch-only — skipping async-imap fetch attempts for this server going forward");
        }
    }

    /// True if this server previously confirmed it silently drops `UID SEARCH
    /// n:*` range queries (the SINCE-date fallback found messages the range
    /// query missed) — skip straight to the SINCE fallback instead of paying a
    /// doomed round trip on every folder, every sync cycle.
    pub async fn skip_range_search(&self, config: &ImapConfig) -> bool {
        self.no_range_search.lock().await.contains(&session_key(config))
    }

    pub async fn mark_no_range_search(&self, config: &ImapConfig) {
        let key = session_key(config);
        if self.no_range_search.lock().await.insert(key.clone()) {
            log::info!("[ImapPool] key={key} confirmed UID range SEARCH unreliable — using SINCE fallback directly for this server going forward");
        }
    }

    /// Acquire a session from the pool, or create a new one.
    ///
    /// Returns `(session, pool_key)`. The caller is responsible for calling
    /// [`release`] on success or letting the session drop on error (which closes
    /// the TCP connection automatically).
    pub async fn acquire(&self, config: &ImapConfig) -> Result<(ImapSession, String), String> {
        let key = session_key(config);

        // Pop a candidate session while holding the lock, then immediately drop
        // the lock so the NOOP probe doesn't block other threads.
        let maybe_session = {
            let mut guard = self.sessions.lock().await;
            guard.get_mut(&key).and_then(|v| v.pop())
        };

        if let Some(mut session) = maybe_session {
            let noop_ok = tokio::time::timeout(NOOP_TIMEOUT, session.noop())
                .await
                .is_ok_and(|r| r.is_ok());

            if noop_ok {
                log::debug!("[ImapPool] reusing session key={key}");
                return Ok((session, key));
            }
            log::warn!("[ImapPool] pooled session dead (NOOP failed), key={key} — reconnecting");
            // session dropped here, connection closed
        }

        log::debug!("[ImapPool] new session key={key}");
        let session = imap_client::connect(config).await?;
        Ok((session, key))
    }

    /// Return a session to the pool after a successful operation.
    pub async fn release(&self, key: String, session: ImapSession) {
        let mut guard = self.sessions.lock().await;
        let limit = max_sessions_for_key(&key);
        let pool = guard.entry(key).or_default();
        if pool.len() < limit {
            pool.push(session);
        }
        // If pool is full the session is dropped (graceful close).
    }
}
