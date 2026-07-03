/**
 * Application-level AES-GCM encryption using a device-derived key.
 *
 * The key lives in the OS keychain (macOS Keychain / Windows Credential
 * Manager) — storing it as a plaintext file next to melo.db would make the
 * "encryption at rest" of passwords/tokens meaningless against any
 * filesystem-level reader. Legacy installs that still have the melo.key file
 * are migrated on first access with a read-back-verify before the file is
 * deleted; if the keychain is unavailable (e.g. Linux without a secret
 * service), the file remains the fallback so no data is ever lost.
 */

import { exists, readTextFile, writeTextFile, remove, mkdir, BaseDirectory } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";

const KEY_FILE_NAME = "melo.key";
const KEYCHAIN_SERVICE = "com.melomail.app";
const KEYCHAIN_ACCOUNT = "melo-db-key";
const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const FS_OPTIONS = { baseDir: BaseDirectory.AppData };

let cachedKey: CryptoKey | null = null;

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Decode(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function ensureAppDataDir(): Promise<void> {
  try {
    await mkdir("", { ...FS_OPTIONS, recursive: true });
  } catch {
    // directory may already exist
  }
}

// Web Crypto API accepts BufferSource (ArrayBuffer | ArrayBufferView).
// TypeScript's ES2021 lib types are strict about Uint8Array<ArrayBufferLike> vs ArrayBufferView<ArrayBuffer>.
// This cast satisfies the type checker while passing the Uint8Array directly to the API.
function asBufferSource(arr: Uint8Array): BufferSource {
  return arr as unknown as BufferSource;
}

async function keychainGet(): Promise<string | null> {
  return invoke<string | null>("keychain_get_secret", {
    service: KEYCHAIN_SERVICE,
    account: KEYCHAIN_ACCOUNT,
  });
}

/**
 * Store the key in the keychain and verify it reads back identically.
 * Returns true only when the round trip succeeded — the caller must NOT
 * delete any file copy otherwise (losing this key = losing all encrypted data).
 */
async function keychainSetVerified(rawKeyB64: string): Promise<boolean> {
  try {
    await invoke("keychain_set_secret", {
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT,
      value: rawKeyB64,
    });
    const readBack = await keychainGet();
    return readBack === rawKeyB64;
  } catch {
    return false;
  }
}

async function loadOrCreateRawKey(): Promise<string> {
  // 1. Keychain is the primary store.
  let keychainAvailable = true;
  try {
    const fromKeychain = await keychainGet();
    if (fromKeychain) {
      // Migration tail: if the legacy plaintext file still exists and holds the
      // same key, it is now redundant — remove it.
      try {
        if (await exists(KEY_FILE_NAME, FS_OPTIONS)) {
          const fileKey = (await readTextFile(KEY_FILE_NAME, FS_OPTIONS)).trim();
          if (fileKey === fromKeychain) {
            await remove(KEY_FILE_NAME, FS_OPTIONS);
            console.info("[crypto] Removed legacy melo.key file (key lives in OS keychain)");
          }
        }
      } catch {
        // File cleanup is best-effort; the keychain copy is authoritative.
      }
      return fromKeychain;
    }
  } catch (err) {
    // Keychain unusable (no OS store / access denied) — fall back to the file.
    keychainAvailable = false;
    console.warn("[crypto] OS keychain unavailable, using file-based key:", err);
  }

  // 2. Legacy file key → migrate to keychain (read-back-verified before delete).
  if (await exists(KEY_FILE_NAME, FS_OPTIONS)) {
    const fileKey = (await readTextFile(KEY_FILE_NAME, FS_OPTIONS)).trim();
    if (keychainAvailable && (await keychainSetVerified(fileKey))) {
      try {
        await remove(KEY_FILE_NAME, FS_OPTIONS);
        console.info("[crypto] Migrated encryption key from melo.key to OS keychain");
      } catch {
        // Deletion failed — key is in both places; retried on next launch.
      }
    }
    return fileKey;
  }

  // 3. First launch: generate. Prefer the keychain; file only as last resort.
  const rawKey = new Uint8Array(KEY_LENGTH / 8);
  crypto.getRandomValues(rawKey);
  const rawKeyB64 = base64Encode(rawKey);
  if (!(keychainAvailable && (await keychainSetVerified(rawKeyB64)))) {
    await ensureAppDataDir();
    await writeTextFile(KEY_FILE_NAME, rawKeyB64, FS_OPTIONS);
  }
  return rawKeyB64;
}

async function getOrCreateKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  const rawKeyB64 = await loadOrCreateRawKey();

  const rawKey = base64Decode(rawKeyB64);
  cachedKey = await crypto.subtle.importKey(
    "raw",
    asBufferSource(rawKey),
    { name: ALGORITHM },
    false,
    ["encrypt", "decrypt"],
  );

  return cachedKey;
}

/**
 * Encrypt a plaintext string. Returns a base64 string in the format: iv:ciphertext
 * (GCM tag is appended to ciphertext by the Web Crypto API)
 */
export async function encryptValue(plaintext: string): Promise<string> {
  const key = await getOrCreateKey();
  const iv = new Uint8Array(IV_LENGTH);
  crypto.getRandomValues(iv);

  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv: asBufferSource(iv) },
    key,
    asBufferSource(data),
  );

  const ivB64 = base64Encode(iv);
  const ciphertextB64 = base64Encode(new Uint8Array(encrypted));
  return `${ivB64}:${ciphertextB64}`;
}

/**
 * Decrypt a value produced by encryptValue. Returns the original plaintext.
 */
export async function decryptValue(encrypted: string): Promise<string> {
  const key = await getOrCreateKey();

  const parts = encrypted.split(":");
  if (parts.length !== 2) {
    throw new Error("Invalid encrypted value format");
  }
  const [ivB64, ciphertextB64] = parts;
  if (!ivB64 || !ciphertextB64) {
    throw new Error("Invalid encrypted value format");
  }

  const iv = base64Decode(ivB64);
  const ciphertext = base64Decode(ciphertextB64);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: asBufferSource(iv) },
    key,
    asBufferSource(ciphertext),
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

/**
 * Check if a value looks like it's already encrypted (base64:base64 format).
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(":");
  if (parts.length !== 2) return false;
  try {
    atob(parts[0]!);
    atob(parts[1]!);
    // Encrypted values have a 12-byte IV (16 chars base64) and substantial ciphertext
    return parts[0]!.length === 16;
  } catch {
    return false;
  }
}
