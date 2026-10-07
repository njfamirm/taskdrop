/**
 * End-to-End Encryption (E2EE) utilities using AES-GCM 256-bit via Web Crypto API
 */

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Derive a 256-bit AES-GCM CryptoKey from user passphrase using PBKDF2 (100k iterations) */
async function deriveKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, [
    "deriveKey",
  ]);

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt plain text using AES-GCM 256-bit with random 16-byte salt and 12-byte IV */
export async function encryptData(plainText: string, secretKey: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const key = await deriveKey(secretKey, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plainText),
  );

  const payload = {
    salt: bufferToBase64(salt.buffer),
    iv: bufferToBase64(iv.buffer),
    cipher: bufferToBase64(encrypted),
  };

  return JSON.stringify(payload);
}

/** Decrypt AES-GCM ciphertext payload back to original plain text string */
export async function decryptData(cipherJson: string, secretKey: string): Promise<string> {
  const payload = JSON.parse(cipherJson);
  const salt = new Uint8Array(base64ToBuffer(payload.salt));
  const iv = new Uint8Array(base64ToBuffer(payload.iv));
  const encrypted = base64ToBuffer(payload.cipher);

  const key = await deriveKey(secretKey, salt);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);

  const dec = new TextDecoder();
  return dec.decode(decrypted);
}

/* ---------------------------------------------------------------------------
 * Per-record encryption for sync protocol v2.
 * The AES key is derived once per (vault, secret) with a salt bound to the vault id,
 * then reused for every record; each record gets a fresh random IV and is bound to its
 * record key via AES-GCM additional data so the relay cannot swap ciphertexts between keys.
 * ------------------------------------------------------------------------- */

const vaultKeyCache = new Map<string, Promise<CryptoKey>>();

function getVaultKey(secret: string, vaultId: string): Promise<CryptoKey> {
  const cacheId = `${vaultId}\u0000${secret}`;
  let key = vaultKeyCache.get(cacheId);
  if (!key) {
    key = (async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`taskdrop-v2:${vaultId}`),
      );
      return deriveKey(secret, new Uint8Array(digest).slice(0, 16));
    })();
    key.catch(() => vaultKeyCache.delete(cacheId));
    vaultKeyCache.set(cacheId, key);
  }
  return key;
}

export async function encryptRecord(
  plainText: string,
  secret: string,
  vaultId: string,
  recordKey: string,
): Promise<string> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getVaultKey(secret, vaultId);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(recordKey) },
      key,
      enc.encode(plainText),
    ),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return bufferToBase64(out.buffer);
}

export async function decryptRecord(
  blob: string,
  secret: string,
  vaultId: string,
  recordKey: string,
): Promise<string> {
  const raw = new Uint8Array(base64ToBuffer(blob));
  const key = await getVaultKey(secret, vaultId);
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: raw.slice(0, 12),
      additionalData: new TextEncoder().encode(recordKey),
    },
    key,
    raw.slice(12),
  );
  return new TextDecoder().decode(plain);
}
