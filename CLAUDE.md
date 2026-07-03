# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For deeper reference, see:

- [docs/architecture.md](docs/architecture.md) — full service/component/DB breakdown
- [docs/development.md](docs/development.md) — dev setup, testing, build
- [docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md) — all keyboard shortcuts

## Context management

Test files (`**/*.test.ts`, `**/*.test.tsx`) are excluded from automatic indexing. When asked to run, write, fix, or review tests, always read the relevant test files explicitly before proceeding.

## Commands

```bash
# Development — starts Tauri app with Vite dev server (port 1420)
npm run tauri dev

# Build production app
npm run tauri build

# Vite dev server only (no Tauri)
npm run dev

# Run all tests (single run)
npm run test

# Run tests in watch mode
npm run test:watch

# Run a single test file
npx vitest run src/stores/uiStore.test.ts

# Type-check only (no emit)
npx tsc --noEmit

# Rust backend only (from src-tauri/)
cargo build
cargo test
```

## Architecture

Tauri v2 desktop app: Rust backend + React 19 frontend communicating via Tauri IPC.

**Rust backend** (`src-tauri/`): System tray, minimize-to-tray, splash screen, OAuth PKCE server (port 17248), single-instance enforcement, autostart. Tauri commands: `start_oauth_server`, `oauth_exchange_token`, `oauth_refresh_token`, `close_splashscreen`, `set_tray_tooltip`, `open_devtools`, 17 IMAP commands and 2 SMTP commands (see `src-tauri/src/lib.rs:89`). Rust IMAP uses `async-imap` + `mail-parser`, SMTP uses `lettre`. Plugins: sql, notification, opener, log, dialog, fs, http, single-instance, autostart, deep-link (`mailto:`), global-shortcut.

**Service layer** (`src/services/`): All business logic. Plain async functions (not classes, except `GmailClient`). Key subdirs: `db/` (SQLite, migrations, FTS5), `email/` (`EmailProvider` abstraction), `gmail/`, `imap/`, `threading/` (JWZ), `ai/` (5 providers: Claude, OpenAI, Gemini, Ollama local, Copilot), `composer/`, `search/`, `filters/`, `queue/`, `tasks/`, `smartLabels/`. Root-level: `emailActions.ts` (offline-aware operations), `badgeManager.ts`, `deepLinkHandler.ts`, `globalShortcut.ts`.

**UI layer** (`src/components/`, `src/stores/`): Nine Zustand stores (`uiStore`, `accountStore`, `threadStore`, `composerStore`, `labelStore`, `contextMenuStore`, `shortcutStore`, `smartFolderStore`, `taskStore`) — simple synchronous state, no middleware.

### Startup sequence (App.tsx)

1. `runMigrations()`
2. Restore persisted settings (theme, sidebar, reading pane, density, font scale, etc.)
3. `shortcutStore.loadKeyMap()`
4. `getAllAccounts()` → init Gmail clients / IMAP providers → `fetchSendAsAliases()` per Gmail account
5. `startBackgroundSync()` (60s), `backfillUncategorizedThreads()`
6. Start checkers: snooze, scheduled send, follow-up, bundles (60s each), queue processor (30s), pre-cache manager (15min)
7. Network status detection (`online`/`offline` → `uiStore.setOnline()`, queue flush on reconnect)
8. `initNotifications()` → `initGlobalShortcut()` → `initDeepLinkHandler()`
9. `updateBadgeCount()` → `close_splashscreen` → show main window

### Database

SQLite via Tauri SQL plugin. 69 migrations, 39 tables (full list in [docs/architecture.md](docs/architecture.md)). Non-obvious tables: `folder_sync_state` (IMAP UIDVALIDITY/last_uid tracking), `pending_operations` (offline queue), `local_drafts` (offline IMAP drafts), `deleted_imap_uids` (tombstone — prevents re-import of deleted IMAP messages), `imap_unfetchable_uids` (skip-list for UIDs the server won't serve; `reason` 'error'|'duplicate', user-`ignored` entries excluded from the sync warning), `messages_fts` (FTS5 full-text index on messages).

### Styling

Tailwind CSS v4 — `@theme {}` for custom properties, `@custom-variant dark` in `globals.css`. Dark mode via `<html class="dark">`. Font scale via `font-scale-{small|default|large|xlarge}` on `<html>`.

Semantic tokens: `bg-bg-*`, `text-text-*`, `border-border-*`, `bg-accent*`, `bg-sidebar-*` (full list in `globals.css`). Glass effects: `.glass-panel`, `.glass-modal`, `.glass-backdrop`. 8 accent presets in `src/constants/themes.ts`. Icons: `lucide-react`.

## Testing

Vitest + jsdom. `globals: true`. Tests colocated with source. Zustand pattern: `useStore.setState()` in `beforeEach`, assert via `.getState()`. ~132 test files.

## Internationalization (i18n)

All user-visible strings must go through the `t()` function from `src/i18n.ts`. **Any UI change that adds, removes, or modifies visible text must update ALL locale files in `public/locale/`.** Currently: `en-US.json`, `it-IT.json`. Adding a key to only one file is a bug.

**Usage:**

```ts
import { t } from "@/i18n";

// Simple key lookup
t("sidebar.nav.inbox")                          // → "Inbox"

// With interpolation
t("threadView.messageCount", { count: 5 })      // → "5 messages in this thread"
t("layout.emailList.conversations", { count: 2 }) // → "2 conversations"
```

**Key structure:** Nested by component/section, e.g.:

- `common.*` — shared labels (Cancel, Save, Delete, ...)
- `sidebar.*` — sidebar nav and labels
- `composer.*` — compose window
- `settings.*` — all settings tabs (`settings.ai.*`, `settings.general.*`, ...)
- `email.*` — thread/message display
- `threadCard.*`, `threadView.*`, `messageItem.*` — thread list/view
- `actionBar.*` — toolbar actions
- `layout.*` — EmailList, TitleBar, ReadingPane, ScheduledPanel
- `ui.*` — generic UI components (ConfirmDialog, ErrorBoundary, etc.)
- `calendar.*`, `tasks.*`, `attachments.*`, `help.*`, `search.*` — feature sections

**When adding new UI strings:**

1. Add the English value under the appropriate nested key in `public/locale/en-US.json`
2. Add the translated value under the same key in **every other locale file** (`it-IT.json`, and any future locales) — never skip a locale
3. Use `t("your.new.key")` in the component

The locale is bundled at build time via a static Vite import — no async loading needed.

## Key Gotchas

- **Tauri SQL plugin config**: `preload` in tauri.conf.json must be an array `["sqlite:melo.db"]` — NOT an object
- **Tauri capabilities**: Any new plugin needs explicit permissions in `src-tauri/capabilities/default.json`. Windows allow `"main"`, `"splashscreen"`, `"thread-*"` wildcard
- **Tauri window config**: macOS uses `titleBarStyle: "Overlay"`, Windows/Linux removes decorations in Rust. 1200x800 default, 800x600 min
- **Single instance**: `tauri-plugin-single-instance` must be first plugin registered
- **Minimize-to-tray**: Use `.on_window_event()` on the Builder, not `window.on_window_event()`
- **Windows AUMID**: Set explicitly in Rust (`com.melomail.app`) for notification identity
- **OAuth (Gmail)**: Localhost server tries ports 17248-17251. PKCE, no client secret. Client ID in SQLite settings
- **IMAP message IDs**: Format is `imap-{accountId}-{folder}-{uid}` — not the RFC Message-ID header
- **IMAP security mapping**: UI shows "SSL/TLS"/"STARTTLS"/"None" but stores "ssl"/"starttls"/"none"
- **IMAP UIDVALIDITY**: If changed, all cached UIDs invalid → full folder resync
- **IMAP tombstone**: Deleted IMAP messages tracked in `deleted_imap_uids` table to prevent re-import during sync
- **IMAP unfetchable skip-list**: `imap_unfetchable_uids` — `reason='error'` (server won't serve, counts toward the amber sidebar warning) vs `reason='duplicate'` (cross-folder dedup, never counted). Clicking the warning opens a detail dialog; entries can be user-ignored (excluded from count) and restored in Settings → Accounts → Skipped messages
- **IMAP passwords**: Encrypted AES-256-GCM in SQLite. Optional `imap_username` column overrides email as login
- **IMAP local drafts**: Two-tier system — stable UUID row in `messages` table (local, 3s debounce) + server APPEND to Drafts folder (18s debounce). The stable UUID row carries `imap_uid`/`imap_folder` coords so delete/tombstone always finds the right server message. `local_drafts` table exists in schema but is unused
- **Provider abstraction**: All sync/send goes through `EmailProvider` — use `getEmailProvider(account)` from `providerFactory.ts`, never call Gmail/IMAP directly from components
- **Offline mode**: All email modify ops go through `emailActions.ts` (optimistic UI + local DB + queue). Never call `getGmailClient()` directly for mutations. Queue processor: 30s, exponential backoff (60s→300s→900s→3600s)
- **Email HTML rendering**: DOMPurify sanitization in sandboxed iframe (`allow-same-origin` only). Remote images blocked by default (`data-blocked-src`), allowlist per sender
- **Thread deletion**: Two-stage — trash first, then permanent delete from DB if already in trash
- **AI providers**: 5 providers — Claude, OpenAI, Gemini, Ollama (local HTTP, `ollama_server_url`/`ollama_model` settings), Copilot. API keys/URLs in SQLite settings. Results cached in `ai_cache`
- **Gmail History API**: Expires ~30 days → automatic full sync fallback
- **CSP**: Allows googleapis.com, anthropic.com, openai.com, generativelanguage.googleapis.com, gravatar.com, googleusercontent.com
- **Phishing detection**: 10 heuristic rules, sensitivity configurable (low/default/high), cached in `link_scan_results`
- **Mute threads**: Sets `is_muted` and drops `urgency_score` to 0.05. Does NOT archive. Suppressed from notifications during delta sync
- **Smart folders**: Dynamic tokens `__LAST_7_DAYS__`, `__LAST_30_DAYS__`, `__TODAY__` in saved searches
- **Help page**: In-app at `/help/$topic`. Content in `src/constants/helpContent.ts`. After adding a new feature, run `/document-feature`
- **Cross-component events**: `melo-sync-done`, `melo-toggle-command-palette`, `melo-toggle-shortcuts-help`, `melo-toggle-ask-inbox`, `melo-move-to-folder`. Tray emits `tray-check-mail` via Tauri event system
- **Undo-send persistence**: on Send the email is persisted as a `pending_operations` row with `status='undo'` BEFORE the draft is tombstoned. The main window claims it via CAS (`claimUndoOperation`); expired rows are promoted to `pending` by the queue processor. Never delete the row without a confirmed send outcome — that's the anti-loss invariant
- **Startup queue recovery**: `queueRecovery.ts` runs before the checkers start. Interrupted `sendMessage` ops (`executing`) and scheduled emails stuck in `sending` become `failed` + notification (never auto-resent — duplicate risk); idempotent ops re-queue; `undo` rows promote to `pending`
- **`withTransaction` is NOT atomic**: it only serializes writes at the JS level (plugin pool ≠ single connection). For multi-table writes where partial state = corruption use `executeAtomicBatch` (`connection.ts` → Rust `db_execute_transaction`, rusqlite, ONE real transaction). Its SQL uses `?N` placeholders, not the plugin's `$N`
- **Encryption key in OS keychain**: service `com.melomail.app`, account `melo-db-key`. Legacy `melo.key` file is migrated with read-back-verify before deletion and remains the fallback when no keychain is available (Linux)
- **Notification suppression is logged**: every suppressed notification logs `[notify] suppressed (<reason>)` — grep for it when investigating "missing notification" reports. Recovery/full syncs notify via a single catch-up digest (`notifySyncCatchUp`)
- **Connectivity probe**: `connectivityMonitor.ts` — network-shaped failures while `navigator.onLine` is true trigger an HTTPS probe; on failure the app flips to offline mode (writes queue) and a 30s re-probe restores it via a synthetic `online` event
