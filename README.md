<p align="center">
  <img src="assets/icon.png?v1" alt="Melo" width="200" height="200" style="border-radius: 24px;" />
</p>

<h1 align="center">Melo</h1>

<p align="center">
  <em><strong>Another email client. Yes, really. No, we're not sorry.</strong></em>
</p>

---

Melo is a **desktop email client** built with Tauri v2, React 19, and Rust — because apparently SQLite, a Rust binary, five AI providers, a task manager, a calendar, semantic search, phishing detection, RFC 8058 one-click unsubscribe, and an urgency scoring engine with temporal decay weren't enough reasons to just use Thunderbird.

It is **offline-first**, **privacy-first**, and, if we're being honest, **feature-count-first**.

---

## ✨ Features

### 📬 Email (you know, the thing)

Multi-account support because you definitely need your work Gmail, your personal Gmail, your iCloud alias, your Outlook from 2009, and your Fastmail that you set up to feel sophisticated. All with OAuth PKCE, IMAP auto-discovery, custom colors, and drag-drop reordering — because the order of your accounts in a sidebar is a deeply personal matter.

**Sync strategy**: Gmail History API, IMAP UID tracking, IMAP IDLE push, UIDVALIDITY monitoring, exponential retry queues (60s → 300s → 900s → 3600s), and tombstone tables to prevent re-importing messages you definitely meant to delete. We have thought about this more than you have.

---

### 📖 Reading

- Thread view. Chronological. As God intended.
- Reading pane: right, bottom, or hidden (for the "I process email by vibes" crowd)
- Draggable divider for the list width, because 347px felt wrong and you knew it
- Mark-as-read: immediately, after 2 seconds, or manually — a philosophical choice about your relationship with attention
- Print, export `.eml`, raw MIME source — for when you need to prove to IT that yes, the email did say that

---

### ✍️ Compose

TipTap rich text editor with markdown shortcuts. Because you deserve `**bold**` to just work without opening a toolbar like it's 2004.

- **Auto-save every 3 seconds** to SQLite + IMAP sync every 18 seconds — your half-written passive-aggressive reply to Karen will survive a kernel panic
- **Undo Send** (5–30s window, configurable) — for when you hit send and immediately achieve enlightenment
- **Schedule Send** — "tomorrow morning" and "Monday morning" presets included, for when you want to seem like you work normal hours
- **Send & Archive** — because closing the loop should cost one click, not two
- **Attachment library** — searchable by name, sender, type, date. Yes, we indexed your attachments. You're welcome.

---

### 🗂️ Organization

- Gmail labels with colors, IMAP folder mapping — the great schism, handled
- **Smart Folders**: saved searches with dynamic tokens like `__TODAY__` and `__LAST_7_DAYS__`. They sound like environment variables. They are not.
- **Filter rules**: from/subject/body/attachment → label, archive, trash, star, mark read. Declarative email triage for people who have given up on zero inbox but haven't given up on *trying*
- **Smart Labels (AI-powered)**: describe in plain Italian or English what you want to label. The AI figures it out. This is not a feature we expected to ship either.
- **Quick Steps**: chains of up to 18 actions in one click. Eighteen. We did not add a hard limit above 18 because we ran out of imagination for why you'd need 19.
- Drag threads onto labels. Star. Pin. Mute (auto-archive + no notifications — the digital equivalent of a polite restraining order).
- Two-phase trash: archive → trash → permanent delete. For the indecisive.

---

### 🔍 Search

Gmail-style operators: `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `before:`, `after:`, `label:`. Plus FTS5 full-text search on subject, body, and sender name — locally, instantly, without sending your emails to a server in Virginia.

**Command palette** (`Ctrl+K` or `/`): fuzzy search over emails, labels, folders, and actions. For people who have decided that menus are a form of suffering.

**Ask Inbox**: natural language questions like *"What did Mario say about the meeting?"* — AI searches the local DB and responds with citations. It works. We're a little unsettled too.

---

### ✅ Task Manager

Because email clients now come with task managers. This is the world we live in.

- Priorities: none, low, medium, high, urgent — a scale that accurately reflects the gap between what your manager says and what they mean
- Subtasks, tags, due dates, recurring tasks (daily/weekly/monthly/yearly with intervals)
- Drag-to-reorder. Filters. Grouping by priority, deadline, or tag.
- **Linked to the current email thread** — so the task "reply to this" lives next to the thing you need to reply to
- **AI task extraction** (press `T`): AI reads the email and suggests title, description, priority, and due date. You still have to do the task. We cannot help you there.

---

### 💤 Snooze, Follow-up & Bundle

- **Snooze**: make a thread disappear and reappear at a time of your choosing. Like adulting, but scheduled.
- **Follow-up reminders**: get notified if nobody replies within a configured window. Passive-aggressive, but automated.
- **Bundle**: group newsletter/subscription emails by sender, delivered as a batch at a configured time (daily or weekly). Your morning digest of things you subscribed to in 2021 and haven't had the heart to unsubscribe from.
- **Inbox split**: Primary, Updates, Promotions, Social, Newsletters — with AI auto-categorization. Gmail invented this. We just didn't want you to miss it while leaving Gmail.

---

### 🤖 AI — 5 Providers, 0 Excuses

| Provider           | Models                       |
| ------------------ | ---------------------------- |
| Claude (Anthropic) | Haiku 4.5, Sonnet 4, Opus 4  |
| OpenAI             | GPT-4o Mini, GPT-4o, GPT-4.1 |
| Google Gemini      | 2.5 Flash, 2.5 Pro           |
| Ollama (local)     | llama3.2 (configurable)      |
| GitHub Copilot     | OpenAI enterprise API        |

**What the AI actually does:**

- **Thread summaries** — cached, because re-summarizing the same email chain every time would be both slow and philosophically wasteful
- **Smart replies** — 2–3 suggestions. You pick one, edit it slightly to feel human, send it.
- **AI Compose** — draft from natural language. Transformations: formal, casual, grammar fix, translate, shorten, expand, simplify. The full spectrum of "I know what I want to say but not how to say it."
- **Auto-draft replies** — analyzes your last 15 sent emails and replicates your writing style. Slightly unsettling. Very useful.
- **Urgency scoring** (0–1 scale with temporal decay over 20–30 configurable days) — because not all unread email is equally urgent, and your inbox knows it even if you don't
- **Reputation engine** — penalizes senders who habitually generate false urgency based on your mute/reply/task patterns. Justice, but algorithmic.
- **Smart Judge** — if you reply to an urgent email, AI evaluates whether your reply actually resolves the thread and lowers its urgency score. It is judging you. Constructively.
- **Semantic search** — Ollama embeddings generated off-thread, combined with FTS5. Finds what you mean, not just what you typed.

All AI processing runs locally or through your own API keys. Your emails are not used to train anything. This is not a disclaimer we enjoy writing.

---

### 📅 Calendar

Day, week, month views. Google Calendar via OAuth (same token as Gmail, because we're not monsters). Multi-calendar with color coding. Create events from time slots. CalDAV-extensible. Background reminder checker every 60 seconds. Does not yet brew coffee.

---

### 🔐 Security & Privacy

**Phishing detection** — 10 heuristic rules covering:
IP-based URLs, homograph attacks, suspicious TLDs, URL shorteners, display/real URL mismatch, dangerous protocols (`javascript:`, `data:`), brand impersonation, subdomain spoofing. We are watching the links so you don't have to.

**Authentication badges** — SPF/DKIM/DMARC with green/orange/red indicators and click-for-details. Know who actually sent what.

**Privacy:**

- Remote images blocked by default (tracking pixels get nothing)
- IMAP/SMTP passwords encrypted AES-256-GCM in local SQLite
- No cloud sync of credentials or content
- Link safety dialog before opening any URL
- One-click unsubscribe per RFC 8058 (HTTP POST, with log) — no "click here, then confirm, then wait 10 business days"

---

### 🎨 Interface & Customization

**Themes:** Light, Dark, System — plus 8 accent color presets with names that sound like a paint collection at a boutique hardware store: *Amber, Ink Black, Prussian Blue, Sage, Iris, Claret, Persimmon, Slate.*

**Layout:** Collapsible sidebar (icons only), reading pane positioning, customizable sidebar items, pop-out thread windows (800×700), separate compose window (980×650). We have opinions about window sizes. They are non-negotiable.

**Font scale:** Small, Default, Large, Extra Large — for when "zoom" feels too aggressive.

**Density:** Compact, Default, Spacious — for when you need to feel like you have either fewer or more emails than you actually do.

Animated gradient background that adapts to light/dark mode. Because we had to ship *something* that doesn't improve deliverability.

---

### ⌨️ Keyboard Shortcuts (all customizable)

| Key               | Action                                                 |
| ----------------- | ------------------------------------------------------ |
| `J` / `K`         | Next / Previous thread                                 |
| `O`               | Open thread                                            |
| `C`               | New email                                              |
| `R` / `A` / `F`   | Reply / Reply All / Forward                            |
| `E`               | Archive                                                |
| `#`               | Delete                                                 |
| `S`               | Star                                                   |
| `M`               | Mute                                                   |
| `T`               | Extract task (AI)                                      |
| `V`               | Move to folder                                         |
| `I`               | Ask Inbox (AI)                                         |
| `?`               | Show shortcut help                                     |
| `/` or `Ctrl+K`   | Command palette                                        |
| `G`+`I/S/T/D/K/A` | Go to Inbox/Starred/Sent/Drafts/Tasks/Attachments      |
| `F5`              | Manual sync                                            |
| `Ctrl+Shift+C`    | Compose (global system shortcut, works when minimized) |

---

### 🖥️ System Integration

- System tray with unread badge and "Check Mail" menu
- Autostart at boot (optional — we respect your morning routine)
- Single instance enforcement (one window, no chaos)
- Deep links: `melo://` and `mailto:`
- Native desktop notifications (macOS, Windows, Linux) with configurable sounds
- Global shortcut that works even when the app is minimized — because email doesn't wait for you to un-minimize things

---

### 💾 Database

SQLite + FTS5. **27 migrations. ~38 tables.**

Accounts, threads, messages, attachments, contacts, signatures, filter rules, smart labels, quick steps, tasks, calendar events, pending operations queue, snooze state, bundles, AI style profiles, vector embeddings, AI cache, phishing allowlists, image allowlists, and more.

It is, at this point, a small ERP system that also receives email.

---

## 🏗️ Tech Stack

- **Frontend**: React 19 + TypeScript
- **Backend**: Rust (Tauri v2)
- **Database**: SQLite + FTS5
- **Email**: IMAP/SMTP, Gmail API, Microsoft Graph
- **AI**: Anthropic, OpenAI, Google Gemini, Ollama, GitHub Copilot
- **Calendar**: Google Calendar API, CalDAV
- **Rich Text**: TipTap
- **Sync**: Gmail History API, IMAP IDLE, exponential retry queues

---

## 🤷 Philosophy

Melo started as an email client and gradually became a productivity suite with email as its legal guardian. It is opinionated about what a good email experience looks like, slightly paranoid about privacy, and unreasonably thorough about edge cases.

It will not make you enjoy email. Nothing will. But it will make it faster, quieter, and less likely to phish you.

---

## 📄 License

TBD. Like your inbox.

---

*Built with Tauri, React, Rust, SQLite, and a concerning amount of conviction that this was a good idea.*
