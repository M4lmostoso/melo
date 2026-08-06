# Keyboard Shortcuts

Melo is designed to be used entirely from the keyboard. All shortcuts are customizable in Settings.

## Navigation

| Key | Action |
|-----|--------|
| `j` / `k` | Next / previous thread |
| `o` or `Enter` | Open thread |
| `Escape` | Close composer / clear selection / deselect |
| `g` then `i` | Go to Inbox |
| `g` then `s` | Go to Starred |
| `g` then `t` | Go to Sent |
| `g` then `d` | Go to Drafts |
| `g` then `p` | Go to Primary |
| `g` then `u` | Go to Updates |
| `g` then `o` | Go to Promotions |
| `g` then `c` | Go to Social |
| `g` then `n` | Go to Newsletters |
| `g` then `k` | Go to Tasks |
| `g` then `a` | Go to Attachments |

## Actions

| Key | Action |
|-----|--------|
| `c` | Compose new email |
| `r` | Reply |
| `a` | Reply all |
| `f` | Forward |
| `e` | Archive |
| `s` | Star / unstar |
| `p` | Pin / unpin |
| `m` | Mute / unmute thread |
| `#` | Trash (permanent delete if already in trash) |
| `!` | Spam / not spam |
| `u` | Unsubscribe |
| `t` | Create task from email (AI) |
| `v` | Move to folder/label |
| `Ctrl+Enter` | Send email |
| `Ctrl+A` | Select all threads |
| `Ctrl+Shift+A` | Select all from current position |

## In-thread

| Key | Action |
|-----|--------|
| `↓` (Arrow Down) | Next message in thread |
| `↑` (Arrow Up) | Previous message in thread |

## App

| Key | Action |
|-----|--------|
| `/` or `Ctrl+K` | Command palette |
| `?` | Keyboard shortcuts help |
| `i` | Ask Inbox (AI) |
| `F5` | Sync current folder |
| `Ctrl+Shift+E` | Toggle sidebar |

## Multi-select

Standard macOS list semantics:

- **Click** clears the selection and opens the thread
- **Cmd/Ctrl+click** toggles a single thread (and moves the range anchor)
- **Shift+click** selects the range from the anchor to the clicked thread; clicking back toward the anchor shrinks it again, and ⌘-clicked threads outside the range survive
- **Shift+↑ / Shift+↓** extends or shrinks the range with the keyboard
- **Click the avatar** to toggle a thread without the keyboard
- `Escape` clears the selection
- Selection only ever covers rows the list is actually displaying — rows hidden by the current search/filter are excluded, and rows that stop being displayed drop out of the selection
- All keyboard actions (archive, trash, star, etc.) apply to the entire selection

## Two-key sequences

Melo supports Vim-style two-key sequences. Press the first key, then the second within 1 second:

- `g` is the only prefix key currently
- If the second key isn't pressed in time, the sequence resets

## Customization

All shortcuts can be rebound in **Settings > Keyboard Shortcuts**. Custom bindings are persisted to the local database and restored on startup. Shortcut definitions live in `src/constants/shortcuts.ts`.
