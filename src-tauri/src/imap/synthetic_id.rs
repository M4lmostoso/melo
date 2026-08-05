//! Stable synthetic RFC Message-ID for IMAP messages that carry no `Message-ID` header.
//!
//! Mirror of `src/services/imap/syntheticMessageId.ts` — the canonical form and the
//! hash MUST stay byte-identical on both sides, otherwise the same message imported
//! by Rust and looked up by TypeScript would get two different identities (duplicate
//! rows, re-keyed threads, orphaned tasks). The shared test vector at the bottom of
//! this file is repeated verbatim in syntheticMessageId.test.ts; if you change the
//! algorithm, change it in both places and re-key stored ids in the same release.
//!
//! Identity is derived from content that survives a UID renumber or a folder move:
//! date, sender, recipients, subject, exact byte size.

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
/// ASCII unit separator — cannot appear inside any of the joined fields.
const SEP: char = '\u{1f}';

fn fnv1a64(input: &str) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Canonical string that gets hashed. Kept byte-identical with the TypeScript side.
pub fn canonical_form(
    date: i64,
    from_address: Option<&str>,
    to_addresses: Option<&str>,
    subject: Option<&str>,
    raw_size: u32,
) -> String {
    let norm = |s: Option<&str>| s.unwrap_or("").trim().to_lowercase();
    format!(
        "{date}{SEP}{}{SEP}{}{SEP}{}{SEP}{raw_size}",
        norm(from_address),
        norm(to_addresses),
        subject.unwrap_or("").trim(),
    )
}

/// `synthetic-<16 hex digits>@melo.local` — stable across UID renumbers and folder moves.
pub fn synthetic_message_id(
    date: i64,
    from_address: Option<&str>,
    to_addresses: Option<&str>,
    subject: Option<&str>,
    raw_size: u32,
) -> String {
    let hash = fnv1a64(&canonical_form(
        date,
        from_address,
        to_addresses,
        subject,
        raw_size,
    ));
    format!("synthetic-{hash:016x}@melo.local")
}

#[cfg(test)]
mod tests {
    use super::*;

    // SHARED TEST VECTOR — identical assertion in src/services/imap/syntheticMessageId.test.ts.
    #[test]
    fn matches_the_typescript_implementation() {
        let id = synthetic_message_id(
            1_754_400_000_000,
            Some("Mario.Rossi@example.com"),
            Some("m.landenna@termomeccanica.com"),
            Some("Offerta impianto - rev. 2"),
            48_213,
        );
        assert_eq!(id, "synthetic-5ca99472fc027bdf@melo.local");
    }

    #[test]
    fn is_independent_of_uid_and_folder() {
        // The whole point: nothing about the message's IMAP coordinates feeds the id.
        let a = synthetic_message_id(1, Some("a@b.c"), Some("d@e.f"), Some("Hi"), 10);
        let b = synthetic_message_id(1, Some("a@b.c"), Some("d@e.f"), Some("Hi"), 10);
        assert_eq!(a, b);
    }

    #[test]
    fn differs_when_content_differs() {
        let a = synthetic_message_id(1, Some("a@b.c"), Some("d@e.f"), Some("Hi"), 10);
        let b = synthetic_message_id(1, Some("a@b.c"), Some("d@e.f"), Some("Hi"), 11);
        assert_ne!(a, b);
    }

    #[test]
    fn missing_fields_do_not_panic_and_stay_distinct() {
        let empty = synthetic_message_id(0, None, None, None, 0);
        assert!(empty.starts_with("synthetic-"));
        assert_ne!(empty, synthetic_message_id(1, None, None, None, 0));
    }
}
