use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use async_imap::Session;

use super::client::{self as imap_client, ImapStream};
use super::types::ImapConfig;

type ImapSession = Session<ImapStream>;

/// A pooled session plus the moment it was last known good, so [`ImapSessionPool::acquire`]
/// can discard obviously-expired ones instead of probing them.
struct PooledSession {
    session: ImapSession,
    last_used: Instant,
}

const MAX_SESSIONS_PER_KEY: usize = 4;
// iCloud IMAP is sensitive to concurrent connections; Apple rate-limits aggressively.
const MAX_SESSIONS_ICLOUD: usize = 2;
// A NOOP on a live-but-loaded server (DavMail proxying to on-prem Exchange) can
// take well over 5s. Timing it out declared healthy sessions dead and paid a full
// TCP+TLS+LOGIN — on DavMail an entire EWS re-authentication — to replace them.
const NOOP_TIMEOUT: Duration = Duration::from_secs(15);
/// Age past which a pooled session is dropped without probing it. Servers close
/// idle client connections on their own (DavMail's `davmail.clientSoTimeout`
/// defaults to 300s), so a session idle this long is dead in all likelihood:
/// paying a NOOP round trip — and its timeout — only to discover that is waste.
/// Kept comfortably under the 300s DavMail limit.
const MAX_POOLED_IDLE: Duration = Duration::from_secs(240);
/// How often the SINCE-date fallback is re-run per folder on servers whose UID
/// range search works. There it is pure insurance: the range query already finds
/// new mail on every cycle, and anything both miss is caught by the authoritative
/// `UID SEARCH NOT DELETED` reconcile the TS layer runs every ~10 minutes. Paying
/// it on every folder every cycle doubled the IMAP command count for nothing.
const SINCE_PROBE_INTERVAL: Duration = Duration::from_secs(600);

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
    sessions: Mutex<HashMap<String, Vec<PooledSession>>>,
    // Server-identity keyed quirk cache (in-memory, reset on app restart). Some
    // servers (DavMail/Exchange proxies, Mailo, ...) return non-standard FETCH
    // responses or silently drop UID range SEARCH queries. Once a quirk is
    // confirmed for a given server, we skip straight to the known-working path
    // instead of re-attempting (and re-downloading) the doomed one on every
    // batch/folder/cycle — this is what turned multi-minute, double-bandwidth
    // syncs on quirky IMAP bridges into single-pass ones.
    raw_fetch_only: Mutex<HashSet<String>>,
    no_range_search: Mutex<HashSet<String>>,
    // Last time the SINCE-date fallback ran, keyed "session_key|folder".
    since_probe_at: Mutex<HashMap<String, Instant>>,
    // Servers whose UID range search has already been sanity-probed this run.
    range_probe_done: Mutex<HashSet<String>>,
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
            since_probe_at: Mutex::new(HashMap::new()),
            range_probe_done: Mutex::new(HashSet::new()),
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

    /// Whether the SINCE-date fallback should run for this folder on this cycle.
    ///
    /// On a server whose range search is broken the fallback IS the detector and
    /// always runs. Everywhere else it is a backstop for a query that already
    /// works, so it is rate-limited per folder — the cost of a miss is bounded by
    /// the periodic authoritative reconcile, the cost of running it was a doubled
    /// IMAP command count on every folder of every cycle.
    pub async fn should_probe_since(&self, config: &ImapConfig, folder: &str) -> bool {
        let key = format!("{}|{}", session_key(config), folder);
        match self.since_probe_at.lock().await.get(&key) {
            Some(at) => at.elapsed() >= SINCE_PROBE_INTERVAL,
            None => true,
        }
    }

    pub async fn mark_since_probed(&self, config: &ImapConfig, folder: &str) {
        let key = format!("{}|{}", session_key(config), folder);
        self.since_probe_at.lock().await.insert(key, Instant::now());
    }

    /// True until this server's UID range search has been sanity-probed once this
    /// run. The probe exists because [`mark_no_range_search`] can otherwise only
    /// latch when new mail happens to arrive — on a quiet mailbox a server known
    /// to drop range results keeps paying a doomed query on every folder, every
    /// cycle, forever.
    pub async fn needs_range_sanity_probe(&self, config: &ImapConfig) -> bool {
        !self.range_probe_done.lock().await.contains(&session_key(config))
    }

    pub async fn mark_range_probe_done(&self, config: &ImapConfig) {
        self.range_probe_done.lock().await.insert(session_key(config));
    }

    /// Acquire a session from the pool, or create a new one.
    ///
    /// Returns `(session, pool_key)`. The caller is responsible for calling
    /// [`release`] on success or letting the session drop on error (which closes
    /// the TCP connection automatically).
    pub async fn acquire(&self, config: &ImapConfig) -> Result<(ImapSession, String), String> {
        let key = session_key(config);

        // Pop a candidate session while holding the lock, then immediately drop
        // the lock so the NOOP probe doesn't block other threads. Sessions are
        // pushed in release order, so the tail is the freshest: if even that one
        // is past MAX_POOLED_IDLE every entry behind it is older still, and the
        // whole bucket goes with it rather than lingering as dead sockets.
        let maybe_session = {
            let mut guard = self.sessions.lock().await;
            match guard.get_mut(&key) {
                Some(v) => match v.pop() {
                    Some(pooled) if pooled.last_used.elapsed() > MAX_POOLED_IDLE => {
                        let dropped = v.len() + 1;
                        v.clear();
                        log::debug!(
                            "[ImapPool] discarding {dropped} idle session(s) key={key} (idle > {}s) — connecting fresh",
                            MAX_POOLED_IDLE.as_secs()
                        );
                        None
                    }
                    other => other,
                },
                None => None,
            }
        };

        if let Some(PooledSession { mut session, .. }) = maybe_session {
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
            pool.push(PooledSession { session, last_used: Instant::now() });
        }
        // If pool is full the session is dropped (graceful close).
    }
}
