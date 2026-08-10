import type { BootstrapState, ConnectionState, SyncStatus } from '@moodify/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentAdminId, endSession, startSession } from '../auth.ts';
import { ASSETS_URL_PREFIX } from '../config.ts';
import { decryptSecret, hashPassword, tokenHint, verifyPassword } from '../crypto.ts';
import { sql } from '../db.ts';

/**
 * The pre-login surface: everything the SPA can reach before (or without) a
 * session — first-run detection, admin creation, login, logout.
 *
 * Nothing here uses requireAdmin. /api/bootstrap in particular is deliberately
 * public so the login screen can ask "is this a fresh install?" — which means it
 * must be careful never to answer anything else for an anonymous caller.
 */

// ---------------------------------------------------------------------------
// Branding (§11)
// ---------------------------------------------------------------------------

/** The generated wordmark shipped with the frontend. Never overwritten by uploads. */
export const DEFAULT_LOGO_URL = '/brand/moodify-logo.svg';

const CUSTOM_LOGO_KEY = 'custom_logo_path';

/**
 * `custom ?? default` as required by §11: a custom upload is an extra row in
 * app_settings, so removing it restores the bundled asset with no file surgery.
 */
export async function currentLogoUrl(): Promise<string> {
  const { rows } = await sql<{ value: string | null }>(
    'select value from app_settings where key = $1',
    [CUSTOM_LOGO_KEY],
  );
  const stored = rows[0]?.value ?? null;
  if (stored === null) return DEFAULT_LOGO_URL;
  const relative = stored.trim().replace(/^\/+/, '');
  if (relative === '') return DEFAULT_LOGO_URL;
  return `${ASSETS_URL_PREFIX}/${relative}`;
}

// ---------------------------------------------------------------------------
// Connection state (read-only view; writes live in routes/connection.ts)
// ---------------------------------------------------------------------------

interface ConnectionRow {
  base_url: string;
  ws_token: string;
  service_shortname: string | null;
  poll_interval_seconds: number;
  last_sync_at: Date | string | null;
  last_sync_status: string;
  last_sync_error: string | null;
}

const SYNC_STATUSES: readonly string[] = ['never', 'ok', 'error', 'running'];

function toSyncStatus(raw: string): SyncStatus {
  return SYNC_STATUSES.includes(raw) ? (raw as SyncStatus) : 'never';
}

function toIsoString(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Masked hint only — the token itself never leaves the backend (§9.5). */
function safeTokenHint(ciphertext: string): string | null {
  try {
    return tokenHint(decryptSecret(ciphertext));
  } catch {
    // Almost always a changed ENCRYPTION_KEY. Bootstrap still has to answer so the
    // UI can render and offer "replace token", so degrade to no hint instead of 500.
    return null;
  }
}

/** v1 stores exactly one connection; the lowest id is it. */
async function readConnectionState(): Promise<ConnectionState | null> {
  const { rows } = await sql<ConnectionRow>(
    `select base_url, ws_token, service_shortname, poll_interval_seconds,
            last_sync_at, last_sync_status, last_sync_error
       from moodle_connection
      order by id
      limit 1`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    configured: true,
    baseUrl: row.base_url,
    tokenHint: safeTokenHint(row.ws_token),
    serviceShortname: row.service_shortname,
    pollIntervalSeconds: row.poll_interval_seconds,
    lastSyncAt: toIsoString(row.last_sync_at),
    lastSyncStatus: toSyncStatus(row.last_sync_status),
    lastSyncError: row.last_sync_error,
  };
}

async function adminExists(): Promise<boolean> {
  const { rows } = await sql<{ present: boolean }>(
    'select exists (select 1 from admin_users) as present',
  );
  return rows[0]?.present === true;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const createAdminSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(100, 'Username must be at most 100 characters'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200, 'Password must be at most 200 characters'),
});

// Login is deliberately lenient about shape: a too-short password must come back
// as "invalid credentials", not as a validation error that behaves differently.
const loginSchema = z.object({
  username: z.string().trim().max(200),
  password: z.string().max(1000),
});

const INVALID_CREDENTIALS = 'Invalid username or password';

/**
 * A structurally valid scrypt record (16-byte salt, 64-byte key, both all zeroes)
 * that no password can ever match. Verifying against it when the username is
 * unknown makes that path do the same scrypt work as a wrong-password attempt, so
 * response timing does not reveal which usernames exist.
 */
const DUMMY_PASSWORD_HASH = `scrypt$${'A'.repeat(22)}==$${'A'.repeat(86)}==`;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What the SPA asks for before rendering anything: wizard or login, and which
   * logo to draw. Connection details are admin-only even though the endpoint is
   * public — an anonymous caller learns only whether an admin account exists.
   */
  app.get('/api/bootstrap', async (request: FastifyRequest): Promise<BootstrapState> => {
    const hasAdmin = await adminExists();
    const logoUrl = await currentLogoUrl();
    const adminId = hasAdmin ? await currentAdminId(request) : null;
    const connection = adminId === null ? null : await readConnectionState();
    return { hasAdmin, connection, logoUrl };
  });

  /**
   * Wizard step 1 (§8). The existence check and the insert are one statement on
   * purpose: two concurrent first-run requests cannot both see an empty table and
   * both create an admin, which a select-then-insert would allow.
   */
  app.post('/api/setup/admin', async (request: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = createAdminSchema.parse(request.body);
    const passwordHash = await hashPassword(password);

    const { rows } = await sql<{ id: number }>(
      `insert into admin_users (username, password_hash)
       select $1, $2
        where not exists (select 1 from admin_users)
       returning id`,
      [username, passwordHash],
    );

    const created = rows[0];
    if (!created) {
      return reply.code(409).send({ error: 'An administrator already exists' });
    }

    // Sign the new admin straight in so the wizard continues without a login detour.
    startSession(request, reply, created.id);
    return { ok: true };
  });

  app.post('/api/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = loginSchema.parse(request.body);

    const { rows } = await sql<{ id: number; password_hash: string }>(
      'select id, password_hash from admin_users where username = $1',
      [username],
    );
    const admin = rows[0];

    // Always hash, even for an unknown username — see DUMMY_PASSWORD_HASH.
    const passwordOk = await verifyPassword(
      password,
      admin ? admin.password_hash : DUMMY_PASSWORD_HASH,
    );

    if (!admin || !passwordOk) {
      // Same message either way: never confirm that a username exists.
      return reply.code(401).send({ error: INVALID_CREDENTIALS });
    }

    await sql('update admin_users set last_login_at = now() where id = $1', [admin.id]);
    startSession(request, reply, admin.id);
    return { ok: true };
  });

  app.post('/api/logout', async (_request: FastifyRequest, reply: FastifyReply) => {
    endSession(reply);
    return { ok: true };
  });
}
