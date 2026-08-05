import { describe, it, expect } from "vitest";
import {
  syntheticMessageId,
  syntheticCanonicalForm,
  isSyntheticMessageId,
  isInternalPlaceholderId,
} from "./syntheticMessageId";

const base = {
  date: 1_754_400_000_000,
  fromAddress: "Mario.Rossi@example.com",
  toAddresses: "m.landenna@termomeccanica.com",
  subject: "Offerta impianto - rev. 2",
  rawSize: 48_213,
};

describe("syntheticMessageId", () => {
  // SHARED TEST VECTOR — the identical assertion lives in
  // src-tauri/src/imap/synthetic_id.rs (matches_the_typescript_implementation).
  // If this digest changes, the Rust import path and the TypeScript lookup path
  // stop agreeing on what a message IS.
  it("matches the Rust implementation byte for byte", () => {
    expect(syntheticMessageId(base)).toBe("synthetic-5ca99472fc027bdf@melo.local");
  });

  it("does not depend on the IMAP UID or folder", () => {
    // Nothing UID-shaped feeds the canonical form — that is the entire point.
    expect(syntheticCanonicalForm(base)).not.toMatch(/imap-|INBOX|\buid\b/i);
    expect(syntheticMessageId(base)).toBe(syntheticMessageId({ ...base }));
  });

  it("normalises address and subject whitespace/case so a re-import matches", () => {
    expect(
      syntheticMessageId({
        ...base,
        fromAddress: "  mario.rossi@EXAMPLE.com ",
        subject: "  Offerta impianto - rev. 2  ",
      }),
    ).toBe(syntheticMessageId(base));
  });

  it("separates fields so shifted content cannot collide", () => {
    const a = syntheticMessageId({ ...base, subject: "ab", fromAddress: "c" });
    const b = syntheticMessageId({ ...base, subject: "a", fromAddress: "bc" });
    expect(a).not.toBe(b);
  });

  it.each([
    ["date", { date: base.date + 1 }],
    ["sender", { fromAddress: "other@example.com" }],
    ["recipients", { toAddresses: "other@example.com" }],
    ["subject", { subject: "Offerta impianto - rev. 3" }],
    ["size", { rawSize: base.rawSize + 1 }],
  ])("changes when the %s changes", (_field, override) => {
    expect(syntheticMessageId({ ...base, ...override })).not.toBe(syntheticMessageId(base));
  });

  it("handles missing fields without collapsing distinct messages", () => {
    const empty = syntheticMessageId({
      date: 0,
      fromAddress: null,
      toAddresses: null,
      subject: null,
      rawSize: 0,
    });
    expect(empty).toMatch(/^synthetic-[0-9a-f]{16}@melo\.local$/);
    expect(empty).not.toBe(
      syntheticMessageId({ date: 1, fromAddress: null, toAddresses: null, subject: null, rawSize: 0 }),
    );
  });
});

describe("placeholder id detection", () => {
  it("recognises current synthetic ids", () => {
    expect(isSyntheticMessageId(syntheticMessageId(base))).toBe(true);
    expect(isSyntheticMessageId("<real.id@example.com>")).toBe(false);
    expect(isSyntheticMessageId(null)).toBe(false);
  });

  it("also recognises the legacy UID-derived form, which must never be sent either", () => {
    const legacy = "synthetic-acc-1-INBOX-2410@melo.local";
    expect(isSyntheticMessageId(legacy)).toBe(false); // not the current shape
    expect(isInternalPlaceholderId(legacy)).toBe(true); // but still internal
    expect(isInternalPlaceholderId("<real.id@example.com>")).toBe(false);
  });
});
