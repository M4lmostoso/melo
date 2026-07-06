/**
 * Decode a base64 string into bytes using the browser's native data-URL
 * fetch decoder instead of a JS atob()+charCodeAt() loop. For large payloads
 * (multi-MB attachments) the manual loop runs synchronously on the main
 * thread and can take seconds; this offloads decoding to native code.
 */
export async function base64ToBytes(base64: string): Promise<Uint8Array> {
  const res = await fetch(`data:application/octet-stream;base64,${base64}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Read a File as base64-encoded string (without data URL prefix).
 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix (e.g., "data:image/png;base64,")
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
