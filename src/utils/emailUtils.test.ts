import {
  buildReplyAllRecipients,
  buildReplyRecipients,
  normalizeEmail,
  parseAddressList,
  resolveRecipientLabel,
} from "./emailUtils";

describe("normalizeEmail", () => {
  it("lowercases an email address", () => {
    expect(normalizeEmail("User@Example.COM")).toBe("user@example.com");
  });

  it("trims whitespace", () => {
    expect(normalizeEmail("  user@example.com  ")).toBe("user@example.com");
  });

  it("handles both trim and lowercase", () => {
    expect(normalizeEmail("  User@Example.COM  ")).toBe("user@example.com");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeEmail("")).toBe("");
  });

  it("handles already normalized email", () => {
    expect(normalizeEmail("user@example.com")).toBe("user@example.com");
  });

  it("handles mixed-case local and domain parts", () => {
    expect(normalizeEmail("John.Doe@Gmail.Com")).toBe("john.doe@gmail.com");
  });
});

describe("parseAddressList", () => {
  it("parses name + angle-bracketed address", () => {
    expect(parseAddressList("John Doe <john@x.com>")).toEqual([
      { name: "John Doe", email: "john@x.com" },
    ]);
  });

  it("parses a bare email with no name", () => {
    expect(parseAddressList("plain@y.com")).toEqual([
      { name: null, email: "plain@y.com" },
    ]);
  });

  it("splits multiple addresses", () => {
    expect(parseAddressList("A <a@x.com>, b@y.com, C <c@z.com>")).toEqual([
      { name: "A", email: "a@x.com" },
      { name: null, email: "b@y.com" },
      { name: "C", email: "c@z.com" },
    ]);
  });

  it("does not split on commas inside a quoted name", () => {
    expect(parseAddressList('"Doe, John" <j@x.com>, k@y.com')).toEqual([
      { name: "Doe, John", email: "j@x.com" },
      { name: null, email: "k@y.com" },
    ]);
  });

  it("keeps an unquoted 'Lastname, Firstname' name attached to its address", () => {
    expect(parseAddressList("Rossi, Mario <mario.rossi@x.com>")).toEqual([
      { name: "Rossi, Mario", email: "mario.rossi@x.com" },
    ]);
  });

  it("handles multiple senders where one has an unquoted comma in the name", () => {
    expect(
      parseAddressList("Rossi, Mario <m@x.com>, Anna Bianchi <anna@y.com>"),
    ).toEqual([
      { name: "Rossi, Mario", email: "m@x.com" },
      { name: "Anna Bianchi", email: "anna@y.com" },
    ]);
  });

  it("merges chained name fragments and a trailing bare email", () => {
    expect(parseAddressList("Doe, John <j@x.com>, plain@y.com")).toEqual([
      { name: "Doe, John", email: "j@x.com" },
      { name: null, email: "plain@y.com" },
    ]);
  });

  it("keeps a bare email after a comma-name address intact (does not glue the name onto it)", () => {
    // Regression: a bare email must stay a clean, contact-matchable address.
    expect(parseAddressList("Rossi, Mario <m@x.com>, mirko@gmail.com")).toEqual([
      { name: "Rossi, Mario", email: "m@x.com" },
      { name: null, email: "mirko@gmail.com" },
    ]);
  });

  it("does not absorb a name-only fragment into a following bare email", () => {
    expect(parseAddressList("Team, mirko@gmail.com")).toEqual([
      { name: null, email: "Team" },
      { name: null, email: "mirko@gmail.com" },
    ]);
  });

  it("returns [] for empty/null input", () => {
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
  });
});

describe("buildReplyAllRecipients", () => {
  it("keeps 'Lastname, Firstname <email>' recipients intact (no comma split)", () => {
    const { to, cc } = buildReplyAllRecipients({
      replyTo: "sender@x.com",
      toHeader:
        "Chevalier, Francois <francois.chevalier@suez.com>, Valente, Edoardo <E.Valente@termomeccanica.com>",
      ccHeader: null,
      selfEmails: ["me@gmail.com"],
    });
    expect(to).toEqual([
      "sender@x.com",
      "Chevalier, Francois <francois.chevalier@suez.com>",
      "Valente, Edoardo <E.Valente@termomeccanica.com>",
    ]);
    expect(cc).toEqual([]);
  });

  it("excludes the user's own addresses and de-dupes across To/Cc", () => {
    const { to, cc } = buildReplyAllRecipients({
      replyTo: "boss@x.com",
      toHeader: "boss@x.com, ME@gmail.com, Ann <ann@y.com>",
      ccHeader: "ann@y.com, carl@z.com",
      selfEmails: ["me@gmail.com"],
    });
    expect(to).toEqual(["boss@x.com", "Ann <ann@y.com>"]);
    expect(cc).toEqual(["carl@z.com"]);
  });

  it("handles a reply-to that already carries a display name", () => {
    const { to } = buildReplyAllRecipients({
      replyTo: "Jane Doe <jane@x.com>",
      toHeader: null,
      ccHeader: null,
      selfEmails: [],
    });
    expect(to).toEqual(["Jane Doe <jane@x.com>"]);
  });
});

describe("buildReplyRecipients", () => {
  it("replies to the sender for a message from someone else", () => {
    const { to } = buildReplyRecipients({
      replyTo: null,
      fromAddress: "sender@x.com",
      toHeader: "me@gmail.com",
      selfEmails: ["me@gmail.com"],
    });
    expect(to).toEqual(["sender@x.com"]);
  });

  it("prefers reply-to over from for a normal reply", () => {
    const { to } = buildReplyRecipients({
      replyTo: "list@x.com",
      fromAddress: "sender@x.com",
      toHeader: "me@gmail.com",
      selfEmails: ["me@gmail.com"],
    });
    expect(to).toEqual(["list@x.com"]);
  });

  it("targets the original recipients when replying to a message I sent", () => {
    const { to } = buildReplyRecipients({
      replyTo: null,
      fromAddress: "ME@gmail.com",
      toHeader: "Ann <ann@y.com>, carl@z.com",
      selfEmails: ["me@gmail.com"],
    });
    expect(to).toEqual(["Ann <ann@y.com>", "carl@z.com"]);
  });

  it("excludes self and de-dupes when replying to my own message", () => {
    const { to } = buildReplyRecipients({
      replyTo: null,
      fromAddress: "me@gmail.com",
      toHeader: "ann@y.com, me@gmail.com, Ann <ann@y.com>",
      selfEmails: ["me@gmail.com"],
    });
    expect(to).toEqual(["ann@y.com"]);
  });

  it("keeps 'Lastname, Firstname <email>' intact for a self-sent reply", () => {
    const { to } = buildReplyRecipients({
      replyTo: null,
      fromAddress: "me@gmail.com",
      toHeader: "Chevalier, Francois <francois.chevalier@suez.com>",
      selfEmails: ["me@gmail.com"],
    });
    expect(to).toEqual(["Chevalier, Francois <francois.chevalier@suez.com>"]);
  });

  it("returns an empty To when a self-sent message has no other recipients", () => {
    const { to } = buildReplyRecipients({
      replyTo: null,
      fromAddress: "me@gmail.com",
      toHeader: "me@gmail.com",
      selfEmails: ["me@gmail.com"],
    });
    expect(to).toEqual([]);
  });
});

describe("resolveRecipientLabel", () => {
  const map = { "john@x.com": "Johnny (saved)" };

  it("prefers the stored contact name", () => {
    expect(resolveRecipientLabel({ name: "John Doe", email: "john@x.com" }, map)).toBe(
      "Johnny (saved)",
    );
  });

  it("falls back to the header name when no contact exists", () => {
    expect(resolveRecipientLabel({ name: "Jane", email: "jane@y.com" }, map)).toBe("Jane");
  });

  it("falls back to the email when neither contact nor name exists", () => {
    expect(resolveRecipientLabel({ name: null, email: "anon@z.com" }, map)).toBe("anon@z.com");
  });
});
