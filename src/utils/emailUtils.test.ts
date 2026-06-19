import { normalizeEmail, parseAddressList, resolveRecipientLabel } from "./emailUtils";

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
