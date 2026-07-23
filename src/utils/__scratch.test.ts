import { readFileSync } from "node:fs";
import { sanitizeHtml } from "./sanitize";
import { transformHtml } from "./forwardedMessage";

const P = "/private/tmp/claude-501/-Users-mirkolandenna-melo/cc95c794-bb58-43f7-aa54-b82d591d7898/scratchpad/msg2.html";

it("scratch", () => {
  const raw = readFileSync(P, "utf-8");
  const escaped = raw.replace(/<([^<>\s]+@[^<>\s]+)>/g, "&lt;$1&gt;");
  const san = sanitizeHtml(escaped);
  const i = san.indexOf("13:19:06");
  console.log("=== SANITIZED around attribution ===");
  console.log(JSON.stringify(san.slice(Math.max(0, i - 600), i + 600)));
  const out = transformHtml(san);
  const j = out.indexOf("13:19:06");
  console.log("=== OUTPUT around attribution ===");
  console.log(JSON.stringify(out.slice(Math.max(0, j - 800), j + 800)));
  console.log("fw-blk count:", (out.match(/fw-blk/g) ?? []).length);
});
