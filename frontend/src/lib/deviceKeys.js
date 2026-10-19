/*
 * Device keys are generated in the admin's browser and shown once. Only their
 * SHA-256 hash is stored, which is what the ingest endpoint compares against.
 */

// 32 random bytes, base64url without padding (43 characters).
export function generateDeviceKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
