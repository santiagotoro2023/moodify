import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

// ---------------------------------------------------------------------------
// Password hashing — scrypt from the standard library, no bcrypt dependency.
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Moodle token encryption at rest — AES-256-GCM (§9.5).
// ---------------------------------------------------------------------------

let cachedKey: Buffer | null = null;

/** Fails fast at boot rather than at first token write. */
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const hex = process.env.ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). ' +
        'The installer generates one; check your .env file.',
    );
  }
  cachedKey = Buffer.from(hex, 'hex');
  return cachedKey;
}

export function assertEncryptionKey(): void {
  encryptionKey();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(blob: string): string {
  const [ivB64, tagB64, ctB64] = blob.split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Display-only hint for Settings — never the full token (§9.5). */
export function tokenHint(plaintext: string): string {
  return `••••${plaintext.slice(-4)}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
