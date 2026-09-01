import { invoke } from "@tauri-apps/api/core";

/**
 * Persist webview logs into the same rotating file the Rust side writes
 * (tauri-plugin-log, `~/Library/Logs/com.melomail.app/Melo.log` on macOS).
 *
 * Until this existed the file carried Rust targets only, so everything the
 * frontend knew died in a devtools buffer nobody had open. That is not an
 * academic gap: a send whose Sent-copy writes all failed under DB contention
 * logged three `console.warn`s and left no trace anywhere — the email was
 * delivered and the local copy simply never existed, with nothing to diagnose
 * after the fact.
 *
 * Only warn/error are forwarded (info-level frontend chatter would drown the
 * sync logs); `logToFile` is available for milestones worth keeping regardless.
 */

/** tauri-plugin-log LogLevel discriminants (Trace = 1 … Error = 5). */
const LEVEL = { info: 3, warn: 4, error: 5 } as const;

type LogLevelName = keyof typeof LEVEL;

/** Longest single line handed to the logger — raw emails must never reach the file. */
const MAX_MESSAGE_CHARS = 2000;

/**
 * Guards only the synchronous `invoke` call, so anything it logs on its own way
 * out is ignored instead of recursing. It must NOT stay raised for the duration
 * of the IPC: every warning raised while one was in flight would be dropped —
 * and the concurrent ones are precisely what a failure cascade produces.
 */
let inForwarder = false;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Write one line to the app log file. Never throws and never blocks the caller:
 * a logging failure must not take down the operation being logged.
 */
export function logToFile(level: LogLevelName, ...args: unknown[]): void {
  if (!isTauri() || inForwarder) return;
  const message = args.map(stringifyArg).join(" ").slice(0, MAX_MESSAGE_CHARS);
  if (!message) return;
  inForwarder = true;
  try {
    // The rejection handler never touches the console, so it cannot recurse.
    invoke("plugin:log|log", {
      level: LEVEL[level],
      message,
      location: "webview",
    }).catch(() => {});
  } catch {
    /* IPC unavailable — logging must never break the caller */
  } finally {
    inForwarder = false;
  }
}

let installed = false;

/**
 * Mirror `console.warn` / `console.error` into the app log file. Call once per
 * window (each webview — main, composer, thread, preview — is its own JS realm
 * and needs its own hook). The original console methods are preserved so
 * devtools keeps showing everything it did before.
 */
export function installFileLogForwarding(): void {
  if (installed || !isTauri()) return;
  installed = true;

  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    logToFile("warn", ...args);
  };
  console.error = (...args: unknown[]) => {
    originalError(...args);
    logToFile("error", ...args);
  };

  // Anything that escaped a promise chain or an event handler never reached a
  // console patch above — catch it here so the file records it too.
  window.addEventListener("unhandledrejection", (e) => {
    logToFile("error", "[unhandledrejection]", e.reason);
  });
  window.addEventListener("error", (e) => {
    logToFile("error", "[window.error]", e.message, `${e.filename}:${e.lineno}`);
  });
}
