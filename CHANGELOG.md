# Changelog

> Melo is a fork of [Velo](https://github.com/avihaymenahem/velo), an open-source desktop email client built with Tauri + React. Velo's original work provided the foundation — multi-account Gmail/IMAP, JWZ threading, rich text composition, smart inbox categories — on top of which Melo has built hundreds of improvements, new features, and its own visual identity. Thanks to Avi Haymenahem and the contributors to the original project.

---

## [Melo 0.1.0] — In development

All work described in this section took place in the Melo fork, spread across 230+ commits on top of the Velo 0.4.21 base.

---

### Branding & Identity

- New app and tray icons, including native dark/light mode on macOS via template icon
- Redesigned splash screen with updated palette and skeleton loading animation
- Removed all upstream CI/CD release workflows; version reset to 0.1.0

---

### Email & IMAP Sync

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
- **AI Smart Labels** — automatic content-based labeling for threads
- **AI Urgency Decay** — sender reputation and configurable "heat extinction"
- **SOUL.md** — configurable AI personality via Markdown file with settings UI and file monitoring
- **Semantic result merging** — semantic unification of results with citations in threads
- Thread context and past user replies injected into the AI prompt for personalization
- Task extraction from emails with multi-task support and target language injection into the prompt

---

### Task Manager

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

---

### Internationalization (i18n)

- **Full i18n refactor** — replaced all hardcoded strings with `t()` calls across 71+ components
- **Italian locale** (`it-IT.json`) — full Italian translation of the interface
- **Multi-language email headers** — forward/reply headers localized based on account language
- Localization of sidebar, smart folders, labels, shortcuts, and all main components

---

### Security & Privacy

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

---

## Foundation inherited from Velo 0.4.21

Velo 0.4.21 already provided: multi-account Gmail/Outlook/IMAP with OAuth2 PKCE, JWZ threading, full-text search with Gmail-style operators, command palette, AI-categorized split inbox, TipTap rich text editor with undo send/schedule send/auto-save draft, multiple signatures, templates, smart folders, snooze, filters, follow-up reminders, one-click unsubscribe, newsletter bundling, quick steps, five AI providers (Claude/OpenAI/Gemini/Ollama/Copilot), Google Calendar, glassmorphism design with dark/light theme and 8 accent presets, resizable reading pane, customizable keyboard shortcuts, OAuth PKCE without a backend, AES-256-GCM encryption, phishing detection, DOMPurify sandbox, tray badge, auto-update, and cross-platform distribution (Windows/macOS/Linux).
