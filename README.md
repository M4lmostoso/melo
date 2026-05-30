<p align="center">
  <img src="assets/icon.png?v1" alt="Melo" width="200" height="200" style="border-radius: 24px;" />
</p>

<h1 align="center">Melo</h1>

<p align="center">
  <strong>> The privacy-first, local-AI-overloaded, offline-resilient desktop email client that treats your inbox like a high-performance database. Because your local machine has 24GB+ of RAM, and by God, we are going to use it.</strong>
</p>

<p align="center">
  <a href="#features">Features</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;
  <a href="#installation">Installation</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;
  <a href="docs/keyboard-shortcuts.md">Shortcuts</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;
  <a href="docs/architecture.md">Architecture</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;
  <a href="docs/development.md">Development</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

# 🍈 Melo

Built with **Tauri v2 + React 19 + Rust**, backed by a heavy-duty **SQLite (FTS5)** engine, and deeply integrated with local or cloud AI models. **No middleman servers, no telemetry, no cloud syncing.** Just pure, unfiltered email power directly on your desktop.

---

## ✨ Features That Border on Obsession

### 📬 Accounts & The Eternal Sync

* **The Big Two & Friends:** Gmail (via native OAuth PKCE—no client secrets leaked here) and Microsoft/Outlook OAuth2, alongside auto-discovery for IMAP/SMTP (Yahoo, iCloud, Fastmail, Zoho, AOL, GMX).
* **Identity Crisis Prevention:** Full support for multiple accounts (color-coded, drag-and-drop reordering) and Gmail "send-as" aliases synced automatically.
* **The "Never Miss a Thing" Sync Engine:** * Configurable initial sync (30 to 365 days).
  * Delta sync every 60 seconds via Gmail History API or IMAP UID tracking.
  * **IMAP IDLE** for instant push notifications.
  * `UIDVALIDITY` monitoring: automatic resync if your server decides to shuffle folder IDs.
  * Fallback full-sync kicks in if you play hooky from your inbox for more than 30 days.

### 👓 Reading & The Art of Zen

* **Chronological Thread View:** Because linear time is a good concept.
* **Flexible Layouts:** 3-position reading pane (Right, Bottom, or Hidden) with adjustable list width via a buttery-smooth divider.
* **MIME Anatomy:** Print threads, export `.eml` files, or view raw, ugly MIME sources when you need to question your life choices.
* **Inline Everything:** Preview attachments inline and interact with calendar invitations without leaving the thread.

### ✍️ Composition & Absolute Control

* **TipTap Powerhouse:** Rich text editor with Markdown shortcuts (`**bold**`, `*italic*`, lists, links, code blocks, tables, and blockquotes).
* **Paranoia Features:** * **Auto-save Drafts:** Saved locally to SQLite every 3 seconds; synced to the IMAP server every 18 seconds.
  * **Undo Send:** A configurable 5–30 second panic window.
* **Smart Pipelines:** Recipient autocomplete ranked by interaction frequency, toggleable Cc/Bcc fields, multi-signature support, and automated **Send & Archive**.
* **Future-Proofing:** Schedule sends with custom dates/times or quick presets (Tomorrow morning, Monday morning).
* **The Attachment Warehouse:** A specialized attachment library to search by name/sender and filter by file type or date.

### 🗂️ Organization & Automated Bureaucracy

* **Smart Folders:** Saved searches using dynamic tokens like `__TODAY__` or `__LAST_7_DAYS__`.
* **Automation Chains:** **Quick Steps** allowing you to chain up to **18 distinct actions** in a single click.
* **The Garbage Disposal:** A strict two-phase trash system (`Archive` ➔ `Trash` ➔ `Permanent Oblivion`).
* **Mute Means Mute:** Muting a thread triggers immediate auto-archiving and completely silences notifications. No exceptions.

---

## 🤖 The Local AI Overlord (5 Providers Supported)

Melo doesn’t just API-wrap a prompt; it embeds AI into the core UX. Choose your fighter:

| Provider | Available Models |
| :--- | :--- |
| **Claude (Anthropic)** | Haiku 4.5, Sonnet 4, Opus 4 |
| **OpenAI** | GPT-4o Mini, GPT-4o, GPT-4.1 |
| **Google Gemini** | 2.5 Flash, 2.5 Pro |
| **Ollama (100% Local)** | `llama3.2` (and anything else you pull) |
| **GitHub Copilot** | OpenAI enterprise API |

### AI Core Features

* **Ask Inbox:** Run full semantic/hybrid searches (Ollama embeddings generated off-thread + FTS5) using natural language. *"What did Mario say about the meeting?"* yields answers with precise citations.
* **Auto-Draft Replies:** The AI analyzes your last 15 sent emails to build a style profile and accurately replicate your writing tone.
* **Urgency Scoring & The Reputation Engine:** Computes an importance score ($0.0$ to $1.0$) with an automatic temporal decay over 20–30 days. If a sender marks everything as "URGENT" but you constantly mute or ignore them, the **Reputation Engine** penalizes their score.
* **Smart Judge:** Once you reply to an urgent thread, the AI evaluates your text to determine if the issue is actually resolved, automatically downgrading the thread's urgency.
* **Smart Labels:** Describe what you want in Italian or English, and the AI routes incoming mail automatically.

---

## 📅 The Built-in Productivity Suite

### Task Manager

* Fully featured tasks with titles, descriptions, priorities (`None`, `Low`, `Medium`, `High`, `Urgent`), deadlines, subtasks, and custom tags.
* Supports recurring tasks (daily, weekly, monthly, yearly with custom intervals).
* **The Inbox Pipeline:** Link tasks directly to email threads. Pressing `T` triggers the AI to extract a task out of the current email, automatically suggesting a title, description, priority, and due date.

### Calendar & Snoozing

* Day, Week, and Month views powered by Google Calendar Integration (sharing the same Gmail OAuth session) or an extensible CalDAV factory.
* Background reminder checker running every 60 seconds.
* **Snooze & Bundle:** Hide threads until a specific time, or bundle low-priority newsletters to be delivered in bulk once a day or week.
* **Inbox Split:** Automated AI categorization into 5 classic streams: *Primary, Updates, Promotions, Social, and Newsletters*.

---

## 🛡️ Paranoid-Level Security & Absolute Privacy

* **The Phishing Gauntlet:** 10 strict heuristic rules evaluating every incoming link for raw IPs, homograph attacks, suspicious TLDs, URL shorteners, display text mismatches, dangerous protocols (`javascript:`, `data:`), brand impersonation, and subdomain spoofing.
* **Email Authentication Badges:** Clear cryptographic verification badges for **SPF, DKIM, and DMARC** (Green/Orange/Red) with deep breakdown modal logs on click.
* **Tracking Pixel Neutering:** Remote images are blocked by default. Global link safety dialogs intercept all external clicks.
* **Local Hardening:** No cloud sync of content or credentials. All IMAP/SMTP passwords are encrypted using **AES-256-GCM** inside your local SQLite database.
* **RFC 8058 One-Click Unsubscribe:** Fires a clean, direct HTTP POST request with local logging to get you off mailing lists cleanly.

---

## 🏎️ Offline-First & Bulletproof Resilience

Network dropped? Keep working. Melo uses an **optimistic UI** paradigm backed by an iron-clad persistence layer:

* **The Retry Ladder:** Every mutation (archive, delete, label, send) enters an offline queue with exponential backoff retry cycles ($60s \rightarrow 300s \rightarrow 900s \rightarrow 3600s$).
* **The Tombstone Guard:** A dedicated `deleted_imap_uids` table keeps record of deleted messages, ensuring a random server resync never reincarnates an email you already killed.
* **The Schema:** A beautifully normalized database with **27 migrations** and **~38 tables** managing everything from accounts and vector embeddings to your AI style profiles and phishing allowlists.

---

## 🎨 Keyboard-Centric UI & System Deep Links

Melo features a highly tailorable UI featuring Light, Dark, and System modes, 8 sophisticated accent presets (*Amber, Ink Black, Prussian Blue, Sage, Iris, Claret, Persimmon, Slate*), adjustable font scales, and density profiles (*Compact, Default, Spacious*).

Pop out threads into independent $800 \times 700$ windows, or write in a dedicated $980 \times 650$ composition frame.

### Global & App Shortcuts

Type `?` anywhere to bring up the full list. Here are the core vim-ish essentials:

| Key | Action |
| :--- | :--- |
| `J` / `K` | Next / Previous Thread |
| `O` | Open Thread |
| `C` | New Email |
| `R` / `A` / `F` | Reply / Reply All / Forward |
| `E` / `#` | Archive / Delete |
| `S` / `M` | Star / Mute |
| `T` | Extract Task with AI |
| `I` | Open Ask Inbox (AI) |
| `/` or `Ctrl + K` | Open Command Palette (Fuzzy search) |
| `G` + `I`/`S`/`T`/`D` | Go to Inbox / Starred / Tasks / Drafts |
| `F5` | Manual Sync current folder |
| `Ctrl + Shift + C` | **Global System Shortcut** (Compose from anywhere, even minimized) |

### System Integration

* System tray behavior with unread badges, manual sync access, and minimize-to-tray.
* Native OS notifications (macOS, Windows, Linux) with customizable sound profiles.
* Full deep-linking integration (`melo://...` and standard `mailto:` handling).

---

## 🛠️ Architecture & Under the Hood
