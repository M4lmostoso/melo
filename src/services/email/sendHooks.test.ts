import { describe, it, expect, vi } from "vitest";
import { onSmtpAccepted, fireSmtpAccepted, messageIdFromRaw } from "./sendHooks";

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("sendHooks", () => {
  it("fires once, matching Message-IDs with or without brackets / case", async () => {
    const hook = vi.fn();
    onSmtpAccepted("<ABC.123@Termomeccanica.com>", hook);
    fireSmtpAccepted("abc.123@termomeccanica.com");
    fireSmtpAccepted("abc.123@termomeccanica.com");
    await Promise.resolve();
    expect(hook).toHaveBeenCalledOnce();
  });

  it("unregister removes the hook; unknown ids and null are no-ops", () => {
    const hook = vi.fn();
    const off = onSmtpAccepted("x@y", hook);
    off();
    fireSmtpAccepted("x@y");
    fireSmtpAccepted(null);
    expect(hook).not.toHaveBeenCalled();
  });

  it("a failing hook never throws into the send path", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onSmtpAccepted("boom@x", () => {
      throw new Error("boom");
    });
    onSmtpAccepted("async-boom@x", async () => {
      throw new Error("async boom");
    });
    expect(() => fireSmtpAccepted("boom@x")).not.toThrow();
    expect(() => fireSmtpAccepted("async-boom@x")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("reads the Message-ID from the headers without decoding a huge body", () => {
    const raw = b64url(
      "From: a@b.c\r\nMessage-ID: <1794259200725.4x0u9znm@termomeccanica.com>\r\nSubject: s\r\n\r\n" +
        "A".repeat(200_000),
    );
    expect(messageIdFromRaw(raw)).toBe("1794259200725.4x0u9znm@termomeccanica.com");
    expect(messageIdFromRaw(b64url("Subject: none\r\n\r\nMessage-ID: <in-body@x>"))).toBeNull();
    expect(messageIdFromRaw("%%%not base64")).toBeNull();
  });
});
