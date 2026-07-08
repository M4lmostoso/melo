# Changelog

> Melo is a fork of [Velo](https://github.com/avihaymenahem/velo), an open-source desktop email client built with Tauri + React. Velo's original work provided the foundation — multi-account Gmail/IMAP, JWZ threading, rich text composition, smart inbox categories — on top of which Melo has built hundreds of improvements, new features, and its own visual identity. Thanks to Avi Haymenahem and the contributors to the original project.

---

## [0.1.4](https://github.com/M4lmostoso/melo/compare/v0.1.3...v0.1.4) (2026-07-08)


### Features

* add customizable application font family settings and persistent state management ([9303a92](https://github.com/M4lmostoso/melo/commit/9303a9250d8504c552f72f35894acc4bfc64488a))
* add database maintenance settings tab, background auto-optimization, and improve thread grouping logic by validating conversation markers ([4895f02](https://github.com/M4lmostoso/melo/commit/4895f023c9a756c27225abfc1e2f9b89bf35e23f))
* add is_trashed column to message database schema and update insert/upsert logic ([0dff66d](https://github.com/M4lmostoso/melo/commit/0dff66df2489189825dc4c2230d61cf300f16e68))
* auto-reload messages in ThreadView when background sync completes ([9e6773e](https://github.com/M4lmostoso/melo/commit/9e6773e0b13ded6815c94c8c2738ba875f3cde90))
* optimize attachment and CID image fetching by implementing batch downloading via single IMAP body stream ([c924758](https://github.com/M4lmostoso/melo/commit/c924758b8ec55a3769edb78b7ad318e906ceabdb))
* optimize attachment downloads with message-level batch expansion and concurrent fetch throttling ([45149e8](https://github.com/M4lmostoso/melo/commit/45149e8bba0dd4f8b37d7c48d08958a518065332))


### Bug Fixes

* ensure reliable \Seen flag application, improve From header formatting, include CID parts as attachments, and include display names in address suggestions ([ecccbef](https://github.com/M4lmostoso/melo/commit/ecccbef8185c25f3fc7565b16ebe09a5b30c12b0))
* ensure sync completion event triggers UI refresh even when delta counters are zero ([9eac270](https://github.com/M4lmostoso/melo/commit/9eac2709253a6ada7db3457987846a3cda12af52))
* improve imap sync stability by increasing fetch timeouts, ensuring thread stats consistency, and preventing duplicate UID ping-pong via monotonic updates and skip-listing. ([e26a8b8](https://github.com/M4lmostoso/melo/commit/e26a8b81c35f46b312d05bd781eda2caaddcd4ea))
* use Tauri HTTP plugin for connectivity probe to bypass webview CORS restrictions ([c625197](https://github.com/M4lmostoso/melo/commit/c62519744c4111bd6864561614461dd7f67b4f33))

## [0.1.3](https://github.com/M4lmostoso/melo/compare/v0.1.2...v0.1.3) (2026-07-03)


### Features

* add deep-link thread fetching and implement robust reply-all recipient parsing ([c6e35e6](https://github.com/M4lmostoso/melo/commit/c6e35e6bf835645006acc3724007b7cf0d067770))
* add pre-send warning when sending to a domain from an unusual account ([472f88a](https://github.com/M4lmostoso/melo/commit/472f88a11abdda50f25a38985d670e6d9c746408))
* implement robust SMTP timeouts, atomic DB batch operations, and OAuth re-authentication monitoring with improved error recovery. ([a0dd2fd](https://github.com/M4lmostoso/melo/commit/a0dd2fda21f2e08c06fb9d82faf973ca14536d6c))
* implement skipped message management with sidebar warnings, configuration, and a UI for ignoring or restoring unfetchable UIDs ([b7a2329](https://github.com/M4lmostoso/melo/commit/b7a2329536d27af0d8900b0a23c2dde0ec940fd6))


### Bug Fixes

* navigate back when the last viewed thread is removed to prevent stale state ([f58c66e](https://github.com/M4lmostoso/melo/commit/f58c66e4418fa8da4d657e25b7d24eb8e9059c2e))
* render ContextMenu via portal to fix positioning and resolve thread read-state logic to correctly handle trashed messages ([4c11166](https://github.com/M4lmostoso/melo/commit/4c11166733871ebfc53c0768d6f3b4dc652c72ab))
* strip base64 padding in decoder and trigger immediate sync after cross-account moves ([a65b57a](https://github.com/M4lmostoso/melo/commit/a65b57ab69d6947c62158269147da181d90a6e4c))

## [0.1.2](https://github.com/M4lmostoso/melo/compare/v0.1.1...v0.1.2) (2026-07-01)


### Features

* configurable, user-visible skip-list for unfetchable IMAP messages ([a14c5f2](https://github.com/M4lmostoso/melo/commit/a14c5f26cc50c06ad7ec1680c8887de0a141c195))
* self-healing periodic IMAP reconcile so sync can't silently drift ([2753829](https://github.com/M4lmostoso/melo/commit/275382989ee79d768be31e0f8a5967d2c994b5ea))
* surface per-account sync health so failures aren't silent ([52f2f05](https://github.com/M4lmostoso/melo/commit/52f2f050a44a7e566c1faed7623af95f07eb2ef2))


### Bug Fixes

* add total wall-clock timeout to raw IMAP fetch ([9373e7c](https://github.com/M4lmostoso/melo/commit/9373e7cb782c1f2cb0e7a31c239b5bc2ee7a0899))
* handle unfetchable message errors by skipping poison UIDs and adding idle timeouts to literal reads ([b49cebc](https://github.com/M4lmostoso/melo/commit/b49cebc41746a96447e65cd46be0bd38098988d7))
* reliable raw-connection UID SEARCH for DavMail/Exchange enumeration ([8be75fc](https://github.com/M4lmostoso/melo/commit/8be75fcb0668fb3bd21d790a542b84faa313c86b))
* sync accounts concurrently so one stuck account can't block others ([0b06d7e](https://github.com/M4lmostoso/melo/commit/0b06d7ef4ad3ed7612b3d48973ce4bf7da92bbe3))

## [0.1.1](https://github.com/M4lmostoso/melo/compare/v0.1.0...v0.1.1) (2026-06-30)


### Features

* add release-please workflow for automated versioning and changelog management ([acf1c0d](https://github.com/M4lmostoso/melo/commit/acf1c0df3e0a9f9b33835485af8587b09faecaf6))
* implement automated draft cleanup for successful retried sendMessage operations ([2d6a2e3](https://github.com/M4lmostoso/melo/commit/2d6a2e34b1fbf099c3bda39bd1fa3496e554b1b6))
* implement batch attachment downloads with de-duplication and progress tracking ([007d900](https://github.com/M4lmostoso/melo/commit/007d900005c1715fc0bf2d48a2af1c6ebbe63d2d))
* implement CalDAV PUT/update logic, sync IMAP/CalDAV credentials, and add calendar reminder background checks. ([8a6ff5d](https://github.com/M4lmostoso/melo/commit/8a6ff5de4c41d46558b2c047a735341943407e17))


### Bug Fixes

* drop component prefix from release-please tags so v0.1.0 is detected ([074c739](https://github.com/M4lmostoso/melo/commit/074c739f743fc4bd531ec7a3be679427a6b2d561))
* improve calendar deduplication, add in-app reminder toasts, and hash long attachment paths ([094f060](https://github.com/M4lmostoso/melo/commit/094f060f141c7a24ef6e2fa39fe3bb3532ad3512))
* skip CLA check on maintainer's own PRs ([430eaff](https://github.com/M4lmostoso/melo/commit/430eaff87369e558b460ab8d6941a9628b6589a5))
* store CLA signatures on dedicated unprotected branch ([6bac3a7](https://github.com/M4lmostoso/melo/commit/6bac3a77ffcab7c14561cbaee1333662fbfcc3d3))
* update calendar reminder window to handle missed events, replace callback with window events, and improve notification resilience ([b2d2d0f](https://github.com/M4lmostoso/melo/commit/b2d2d0f1f8b995a9c89bd631620399224f556524))

## [Melo 0.1.0] — In development

All work described in this section took place in the Melo fork, spread across 230+ commits on top of the Velo 0.4.21 base.

---

### Branding & Identity

- New app and tray icons, including native dark/light mode on macOS via template icon
- Redesigned splash screen with updated palette and skeleton loading animation
- Removed all upstream CI/CD release workflows; version reset to 0.1.0
- **Minimal CI** — GitHub Actions workflow runs type-check + the full test suite on every pull request

---

### Email & IMAP Sync

- **PEC (Certified Email) support** — detection of Italian PEC accounts with a dedicated certified-receipt (Ricevute) folder, automatic receipt reconciliation during IMAP sync, and receipt filtering
- **iCloud Mail support** with dedicated connection rate-limiting and app-specific password warnings
- **IMAP IDLE** — real-time background sync without polling; UI management tabs
- **IMAP session pool** — connection pool with frontend concurrency limits to optimize attachment fetching and database performance
- **Fragmented thread reconciliation** — `reconcileFragmentedThreads` unifies split threads during IMAP sync
- **Tombstone for deleted UIDs** — `deleted_imap_uids` table prevents re-importing deleted messages
- **IMAP message deduplication** — external reconciliation with UID updates for duplicate messages
- **IMAP drafts with synchronous tombstones** — reliable local deletion on composer close
- **Separate SMTP credentials** — distinct SMTP username/password from IMAP; login string sanitization
- **SINCE-date fallback for delta sync** — compatibility with DavMail/Exchange servers that don't support UID ranges
- **Stale state guarding** — protection against stale thread loads during list updates
- **Thread sync on reply** — thread reloaded from server after sending a reply
- Support for `imap_username` credentials separate from the email address as login
- Automatic repair of migration 26 if the `deleted_imap_uids` table is missing
- Batch retry and improved duplicate label handling in IMAP
- IMAP flag synchronization with granular read-state tracking

---

### Composer

- **Pre-send validation** — warns about a missing subject or a forgotten attachment (e.g. "see attached" with no file) before the message goes out
- **Font toolbar** — font family, size, and color picker directly in the composer toolbar
- **AI Sidebar in composer** — integrated AI chat interface for writing assistance
- **Account switcher** — switch accounts in the modal composer without reopening the window
- **Context-aware account selection** — composer opens pre-set to the correct account based on context (search, shortcuts)
- **Conversation history in AI** — AI providers receive the full thread history for more contextual replies
- **BlockStyle TipTap extension** — preserves inline block styling in the rich text editor
- **RFC 2822 References header** — support for References/In-Reply-To thread headers in composer and reply flows
- **Subject-based thread merging** — unifies threads by subject when References headers are missing
- **Quoting aware** — quoted HTML passed as URL parameter for composer initialization; quoting support in pop-out windows
- **Drafts in SQLite** — draft persistence in the database instead of localStorage for cross-window availability
- **Auto-save on window close** — drafts are automatically saved when the composer window closes
- Configurable default font family and size in settings
- Signature correctly placed before quoted text in reply/forward
- Proper composer state reset on fresh compose
- Email sending delegated to the main window; reply keyboard shortcut enabled in pop-out windows

---

### Artificial Intelligence

- **Urgency scoring** — scoring pipeline with temporal decay, legal sender detection, follow-up identification, and disclaimer sanitization
- **Automatic backfill** of urgency scores for existing threads
- **AI Answer Panel (Ask My Inbox)** — answer panel with citations and navigation to cited threads; textarea in SearchBar
- **Hybrid FTS + vector RAG** — search with Reciprocal Rank Fusion in Rust; manual re-indexing from settings; aggregated progress indicator; automatic backfill resume after sync
- **AI phishing arbitration** — AI-assisted adjudication layered on top of the heuristic phishing rules to reduce false positives
- **AI Smart Labels** — automatic content-based labeling for threads
- **AI Urgency Decay** — sender reputation and configurable "heat extinction"
- **SOUL.md** — configurable AI personality via Markdown file with settings UI and file monitoring
- **Semantic result merging** — semantic unification of results with citations in threads
- Urgency scoring prompts now return rationales explaining each score
- Thread context and past user replies injected into the AI prompt for personalization
- Task extraction from emails with multi-task support and target language injection into the prompt

---

### Task Manager

- **Email–task linking** — link an email to a task from a dedicated UI; the active account follows the linked thread on navigation
- **Task panel** integrated in the sidebar with tags and deadline tracking
- **TasksDayPanel** — weekly scheduling view for daily tasks
- **AI task extraction** — automatic task extraction from emails with sidebar grouping
- **Inline editing** of tasks directly in the list
- **Configurable retention** — task retention period setting in preferences
- **Account-based badges** — per-account task counters in the system tray and sidebar
- **Unified inbox mode** for tasks with updated route navigation
- Active account updated when navigating to a thread linked to a task
- Task badges periodically refreshed and auto-updated after mutations

---

### Calendar

- **Sync reconciliation** — local calendar state reconciled against the server so events deleted or moved remotely are dropped locally
- **CalDAV synchronization** — calendar metadata, colors, events, and invite responses
- **Unified view** — aggregation of events and calendars across all accounts
- **Client-side RRULE expansion** — recurring event expansion on the client for CalDAV providers that lack native support
- **Meeting join buttons** — "Join" buttons with URL parsing for Zoom/Meet/Teams links in event views
- **Interactive month picker** — quick month selection in the calendar toolbar
- **Auto-scroll to current time** with a visual time indicator in WeekView
- **Dynamic event colors** — color coding per calendar in all views
- **Background reminders** — desktop notifications for upcoming events
- Respond to calendar invites directly from the attachment in email
- **Automatic pruning** of accepted/expired calendar invites
- **Calendar smart folder** for quick navigation to events
- Full localization of calendar headers, titles, and time formatting
- Week layout with absolute event positioning and correct Monday-first logic
- Correct end-time calculation for all-day events

---

### Search & Contacts

- **Contact autocomplete in SearchBar** — auto-complete suggestions for senders/recipients in the search bar
- **Batched DB queries** — optimized database queries for search with direct result hydration into the thread store
- **Contact display name caching** — dedicated store for caching display names across UI components
- **Google Contacts sync** — Google Contacts synchronization for Gmail accounts
- **Contact sidebar** — contact panel updated based on the selected message sender
- Detailed sender contact information stored in threads with name parsing in the UI
- Frequency-ranked contact autocomplete in the composer

---

### Accounts & Multi-account

- **Multi-account with labels** — optional label field for custom account identification
- **Unified view** — cross-account inbox and folders with global account settings
- **Drag-and-drop ordering** — drag-and-drop reordering of mail accounts in settings
- **Account creation flow** — add account flow integrated in the settings page
- **Per-account sync status indicators** — visual badges per account in the sidebar
- **Account colors** — derived from account object properties instead of email hashing
- **Cross-account smart folders** — saved searches that aggregate data across all global accounts
- **Unified cross-account labels** — shared folder support across multiple accounts
- Global aggregated unread counters per account in the sidebar and tray

---

### UI & Design

- **Catppuccin Mocha palette** — dark mode redesign with Zed/Catppuccin Mocha colors
- **Theme overhaul** — new color palette definitions, global styles, and updated 8 accent presets
- **Swipe-to-action** — swipe gestures to archive/delete threads via pointer and trackpad, with scrollTracker to prevent accidental gestures
- **SwipeableThreadCard** — thread card component with built-in swipe support
- **Sound effects** — configurable sound effects system with notification and action triggers
- **Unread message indicator** — visual badge in MessageItem components
- **Attachment icon** on thread cards in the email list
- **Office document preview** — Word/Excel/PowerPoint preview directly in-app
- **Local file preview modal** — modal for previewing local files
- **Empty state illustrations** — illustrations for empty views
- **Floating sync pill** — sync status bar converted to a floating pill in the bottom-right corner
- **ContactChip hover cards** — contact preview cards on hover, with navigation to a focused contact sidebar
- **Manual mail sync button** in the macOS sidebar for on-demand sync
- **Multi-select attachments** — multi-select with drag-and-drop and native app integration
- **Native macOS traffic lights** — semaphore buttons in the sidebar for native window control
- **Window dragging** — `data-tauri-drag-region` on the main layout and fullpage composer
- **Print email** — printing with threading, signatures, dedicated CSS print styles, and dynamic document title
- **Per-message action support** — contextual actions for individual messages in a thread
- Skeleton animation on loading (replaces loading text)
- Auto-scroll to selected thread with ResizeObserver; concurrency control in EmailList loading
- Auto-advance to next thread after removal actions
- Visual highlight for spam threads with dimmed red background

---

### Scheduled Emails

- **Scheduled emails view** — dedicated panel with list and detail views for outgoing scheduled emails
- **Context menu** on the scheduled list with multi-action support and attachments
- **Cross-window sync** of scheduled emails via Tauri events
- **Multi-account bulk actions** for spam/trash

---

### Outgoing Queue

- **Outgoing view** — sidebar section with persistent and in-memory tracking of outgoing emails
- **Failed send queue** — dedicated view for failed messages with retry support
- **Edit queued emails** — modify outgoing messages before they send; in-flight items shown in the queue view

---

### Internationalization (i18n)

- **Full i18n refactor** — replaced all hardcoded strings with `t()` calls across 71+ components
- **Italian locale** (`it-IT.json`) — full Italian translation of the interface
- **Multi-language email headers** — forward/reply headers localized based on account language
- Localization of sidebar, smart folders, labels, shortcuts, and all main components

---

### Security & Privacy

- **Production log stripping** — `console.log`/`console.debug` removed from release builds (warnings/errors kept) to avoid console noise and incidental data exposure
- **Nonce-based message verification** — iframe message verification with nonce to resolve WKWebView issues
- **iframe srcdoc** — migration from `blob:` URLs to `srcdoc` in EmailRenderer for improved security
- **postMessage link handling** — secure iframe link handling via postMessage with sandbox restriction
- CSP fix for inline scripts and stable iframe height calculation
- Improved remote image detection in CSS

---

### Performance

- **jemalloc** — optimized memory allocation for sync operations
- **Lazy body fetching** — lazy message body retrieval with backpressure via semaphores
- **Body caching** — local cache of email bodies to reduce server requests
- **Attachment disk caching** — on-disk attachment cache with optimized memory management
- **Raw TCP attachment fetching** — bypasses IMAP parser hangs with a fallback discovery path for legacy messages
- **Batched IMAP CID resolution** — batch CID image resolution on the Rust side to reduce memory footprint
- **Batched DB queries** — batch database queries for search and thread loading
- ResizeObserver for frame height calculation (avoids layout thrashing)
- Removed `MAX_THREAD_STORE_SIZE` limit for email list pagination

---

### Notable Bug Fixes (Melo)

- Prevent duplicate IMAP draft deletions and ensure sidebar badge refresh
- Exclude drafts from unread counters and thread message counts
- Reply-all with correct recipient filtering and multi-account support
- Restore trashed items to the correct thread
- Sync local state with server by removing orphaned messages
- Fix race conditions in thread loading during list updates
- Correct read state by overriding stale Gmail API data with History API events
- Prevent skeleton flash in the Outgoing view
- Proper iframe height handling on WKWebView
- Fix unread count calculation for smart folders in global mode
- Resolve over-trashing of Gmail threads — migration for orphaned messages plus an automatic re-sync when a thread fails to load

---

## Foundation inherited from Velo 0.4.21

Velo 0.4.21 already provided: multi-account Gmail/Outlook/IMAP with OAuth2 PKCE, JWZ threading, full-text search with Gmail-style operators, command palette, AI-categorized split inbox, TipTap rich text editor with undo send/schedule send/auto-save draft, multiple signatures, templates, smart folders, snooze, filters, follow-up reminders, one-click unsubscribe, newsletter bundling, quick steps, five AI providers (Claude/OpenAI/Gemini/Ollama/Copilot), Google Calendar, glassmorphism design with dark/light theme and 8 accent presets, resizable reading pane, customizable keyboard shortcuts, OAuth PKCE without a backend, AES-256-GCM encryption, phishing detection, DOMPurify sandbox, tray badge, auto-update, and cross-platform distribution (Windows/macOS/Linux).
