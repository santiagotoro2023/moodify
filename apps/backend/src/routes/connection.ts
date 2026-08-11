import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ConnectionState, Course, MoodleUser, SyncProgress, SyncStatus } from '@moodify/shared';
import { REQUIRED_WS_FUNCTIONS } from '@moodify/shared';
import { requireAdmin } from '../auth.ts';
import { DEFAULT_POLL_INTERVAL_SECONDS } from '../config.ts';
import { decryptSecret, encryptSecret, tokenHint } from '../crypto.ts';
import { sql } from '../db.ts';
import { MoodleError, fetchToken, getSiteInfo, normalizeBaseUrl } from '../moodle.ts';
import { fetchAndStoreBadgeImage, getSyncProgress, loadConnection, triggerSync } from '../sync.ts';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** Declared as a type alias, not an interface: pg's QueryResultRow constraint
 *  needs an implicit index signature, which interfaces do not get. */
type ConnectionRow = {
  id: number;
  base_url: string;
  ws_token: string;
  service_shortname: string | null;
  poll_interval_seconds: number;
  last_sync_at: Date | string | null;
  last_sync_status: string;
  last_sync_error: string | null;
};

type CourseRow = {
  id: number;
  shortname: string;
  fullname: string;
  visible: boolean;
};

type UserRow = {
  id: number;
  fullname: string;
  email: string | null;
};

const CONNECTION_COLUMNS = `id, base_url, ws_token, service_shortname, poll_interval_seconds,
                            last_sync_at, last_sync_status, last_sync_error`;

/** v1 stores exactly one connection; the lowest id is it (§6). */
async function readConnectionRow(): Promise<ConnectionRow | null> {
  const { rows } = await sql<ConnectionRow>(
    `select ${CONNECTION_COLUMNS} from moodle_connection order by id limit 1`,
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SYNC_STATUSES: readonly SyncStatus[] = ['never', 'ok', 'error', 'running'];

function toSyncStatus(raw: string): SyncStatus {
  for (const status of SYNC_STATUSES) {
    if (status === raw) return status;
  }
  return 'never';
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * The token is stored encrypted; a failed decrypt almost always means ENCRYPTION_KEY
 * changed in .env. Degrade to "no hint" rather than 500-ing the whole Settings page —
 * the admin can still see the connection and replace the token.
 */
function safeDecrypt(ciphertext: string): string | null {
  try {
    return decryptSecret(ciphertext);
  } catch {
    return null;
  }
}

function buildState(row: ConnectionRow): ConnectionState {
  const plain = safeDecrypt(row.ws_token);
  return {
    configured: true,
    baseUrl: row.base_url,
    // Masked only — the token itself never leaves the backend (§9.5).
    tokenHint: plain === null ? null : tokenHint(plain),
    serviceShortname: row.service_shortname,
    pollIntervalSeconds: row.poll_interval_seconds,
    lastSyncAt: toIso(row.last_sync_at),
    lastSyncStatus: toSyncStatus(row.last_sync_status),
    lastSyncError: row.last_sync_error,
  };
}

function emptyState(): ConnectionState {
  return {
    configured: false,
    baseUrl: null,
    tokenHint: null,
    serviceShortname: null,
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
    lastSyncAt: null,
    lastSyncStatus: 'never',
    lastSyncError: null,
  };
}

/**
 * moodle.ts already redacts secrets and reduces URLs to hostnames in its messages,
 * so a MoodleError message is safe to hand straight to the UI.
 */
function readableError(err: unknown): string {
  if (err instanceof MoodleError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unexpected error while contacting Moodle.';
}

/** Errorcodes that mean "this function is not on the External Service", as opposed
 *  to a bad token or an unreachable host. */
const MISSING_FUNCTION_CODES = new Set([
  'accessexception',
  'webservice_access_exception',
  'invalidfunction',
  'unknownfunction',
  'invalidrecord',
]);

/** When the very first call fails because its own function is not exposed, name it —
 *  the UI can then point at the exact row to tick in the External Service. */
function missingFromError(err: unknown): string[] | undefined {
  if (!(err instanceof MoodleError)) return undefined;
  const fn = err.wsfunction;
  if (fn === null) return undefined;
  if (!MISSING_FUNCTION_CODES.has(err.errorcode.toLowerCase())) return undefined;
  const required: readonly string[] = REQUIRED_WS_FUNCTIONS;
  return required.includes(fn) ? [fn] : undefined;
}

function missingFunctions(available: string[]): string[] {
  const have = new Set(available);
  const missing: string[] = [];
  for (const fn of REQUIRED_WS_FUNCTIONS) {
    if (!have.has(fn)) missing.push(fn);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const connectBodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('token'),
    baseUrl: z.string().url(),
    token: z.string().min(10),
  }),
  z.object({
    mode: z.literal('credentials'),
    baseUrl: z.string().url(),
    username: z.string().min(1),
    password: z.string().min(1),
    serviceShortname: z.string().min(1),
  }),
]);

type ConnectBody = z.infer<typeof connectBodySchema>;

/**
 * Resolve the token (pasted, or fetched with credentials) and prove it works, without
 * touching the database. Returns a result object rather than throwing so the caller
 * needs no definite-assignment gymnastics around a try/catch.
 */
type VerifyResult =
  | { ok: true; baseUrl: string; token: string; functions: string[]; downloadFiles: boolean }
  | { ok: false; error: string; missingFunctions: string[] | undefined };

async function verifyConnection(body: ConnectBody): Promise<VerifyResult> {
  try {
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const token =
      body.mode === 'credentials'
        ? await fetchToken(baseUrl, body.username, body.password, body.serviceShortname)
        : body.token.trim();
    const siteInfo = await getSiteInfo({ baseUrl, token });
    return { ok: true, baseUrl, token, functions: siteInfo.functions, downloadFiles: siteInfo.downloadFiles };
  } catch (err) {
    return { ok: false, error: readableError(err), missingFunctions: missingFromError(err) };
  }
}

const pollIntervalSchema = z.object({
  // Floor of 15s: anything lower hammers Moodle harder than it can answer — a single
  // light sync fans out to one call per user-course pair, which already takes seconds.
  pollIntervalSeconds: z.number().int().min(15).max(86_400),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/connection', { preHandler: requireAdmin }, async (): Promise<ConnectionState> => {
    const row = await readConnectionRow();
    return row === null ? emptyState() : buildState(row);
  });

  /** The wizard's "Connect Moodle" step (§8 steps 2-3): everything is verified against
   *  the live Moodle site before a single column is written. */
  app.post('/api/connection', { preHandler: requireAdmin }, async (request, reply) => {
    const body = connectBodySchema.parse(request.body);

    // Test before proceeding (§8 step 3) — nothing is persisted if this fails.
    const verified = await verifyConnection(body);
    if (verified.ok === false) {
      return reply.code(400).send(
        verified.missingFunctions === undefined
          ? { error: verified.error }
          : { error: verified.error, missingFunctions: verified.missingFunctions },
      );
    }
    const baseUrl = verified.baseUrl;
    const token = verified.token;

    const existing = await readConnectionRow();
    // AES-GCM re-encrypts with a fresh IV every time, so ciphertexts are never
    // comparable — compare the plaintexts instead.
    const changed =
      existing === null ||
      existing.base_url !== baseUrl ||
      safeDecrypt(existing.ws_token) !== token;

    // A pasted token carries no service shortname, and keeping a stale one from an
    // earlier credentials flow would misdescribe the connection in Settings.
    const serviceShortname = body.mode === 'credentials' ? body.serviceShortname : null;
    const encrypted = encryptSecret(token);

    let saved: ConnectionRow | undefined;
    if (existing === null) {
      const { rows } = await sql<ConnectionRow>(
        `insert into moodle_connection (base_url, ws_token, service_shortname, poll_interval_seconds)
         values ($1, $2, $3, $4)
         returning ${CONNECTION_COLUMNS}`,
        [baseUrl, encrypted, serviceShortname, DEFAULT_POLL_INTERVAL_SECONDS],
      );
      saved = rows[0];
    } else {
      // poll_interval_seconds is deliberately absent: reconnecting must not reset it.
      // When the URL or token changed, the old sync outcome describes a different
      // connection, so status/error/timestamp are cleared together.
      const { rows } = await sql<ConnectionRow>(
        `update moodle_connection
            set base_url          = $1,
                ws_token          = $2,
                service_shortname = $3,
                last_sync_status  = case when $4::boolean then 'never' else last_sync_status end,
                last_sync_error   = case when $4::boolean then null    else last_sync_error  end,
                last_sync_at      = case when $4::boolean then null    else last_sync_at     end
          where id = $5
          returning ${CONNECTION_COLUMNS}`,
        [baseUrl, encrypted, serviceShortname, changed, existing.id],
      );
      saved = rows[0];
    }

    if (saved === undefined) {
      return reply.code(500).send({ error: 'Failed to save the Moodle connection.' });
    }

    // Saved even when functions are missing: the token works, and the admin needs the
    // connection stored so Settings can tell them precisely what to enable in Moodle.
    const missing = missingFunctions(verified.functions);
    const state = { ...buildState(saved), canDownloadFiles: verified.downloadFiles };
    return missing.length === 0 ? state : { ...state, missingFunctions: missing };
  });

  /** Tests the STORED connection. A failure is a normal 200 so the UI renders it inline. */
  app.post('/api/connection/test', { preHandler: requireAdmin }, async (_request, reply) => {
    try {
      const conn = await loadConnection();
      if (conn === null) {
        return reply.code(400).send({ ok: false, error: 'No Moodle connection configured' });
      }
      const info = await getSiteInfo(conn);
      // Reported separately from the function list: a service can be allowed to call
      // every function Moodify needs and still refuse to serve badge images.
      return { ok: true, siteName: info.sitename, canDownloadFiles: info.downloadFiles };
    } catch (err) {
      return { ok: false, error: readableError(err) };
    }
  });

  app.patch('/api/connection', { preHandler: requireAdmin }, async (request, reply) => {
    const { pollIntervalSeconds } = pollIntervalSchema.parse(request.body);
    const existing = await readConnectionRow();
    if (existing === null) {
      return reply.code(400).send({ error: 'No Moodle connection configured' });
    }
    const { rows } = await sql<ConnectionRow>(
      `update moodle_connection set poll_interval_seconds = $1 where id = $2
       returning ${CONNECTION_COLUMNS}`,
      [pollIntervalSeconds, existing.id],
    );
    const saved = rows[0];
    if (saved === undefined) {
      return reply.code(500).send({ error: 'Failed to save the poll interval.' });
    }
    return buildState(saved);
  });

  /** "Re-sync now" (§9.4). Kicks off a full discovery and answers immediately; the
   *  wizard and Settings poll /api/sync/progress for live counters. */
  app.post('/api/sync', { preHandler: requireAdmin }, async (_request, reply) => {
    let hasConnection = false;
    try {
      hasConnection = (await loadConnection()) !== null;
    } catch (err) {
      // Stored token present but undecryptable — treat as unusable, and say why.
      return reply.code(409).send({ error: readableError(err) });
    }
    if (!hasConnection) {
      return reply.code(409).send({ error: 'No Moodle connection configured' });
    }

    // Not awaited: triggerSync marks the run as in-progress before its first await,
    // so /api/sync/progress already reports 'running' by the time this responds.
    void triggerSync(app.log).catch((err: unknown) => {
      app.log.error({ err: readableError(err) }, 'manual sync trigger failed');
    });
    return { started: true };
  });

  app.get('/api/sync/progress', { preHandler: requireAdmin }, async (): Promise<SyncProgress> => {
    return getSyncProgress();
  });

  /**
   * Badge image diagnostics: retries every badge whose image is still missing and
   * reports what Moodle said. A failed image is silent in the UI (widgets just show a
   * placeholder), so this is the only way to see the reason without reading logs.
   */
  app.get('/api/badges/images', { preHandler: requireAdmin }, async (_request, reply) => {
    const conn = await loadConnection().catch(() => null);
    if (conn === null) return reply.code(409).send({ error: 'No Moodle connection configured' });

    const { rows } = await sql<{ id: number; name: string; cached: string | null; url: string | null }>(
      `select moodle_badge_id as id, name, cached_image_path as cached, source_url as url
         from badges order by name`,
    );
    const results = [];
    for (const row of rows) {
      if (row.cached !== null) {
        results.push({ id: row.id, name: row.name, status: 'cached' });
      } else if (row.url === null) {
        results.push({ id: row.id, name: row.name, status: 'no image url from Moodle — re-sync first' });
      } else {
        try {
          await fetchAndStoreBadgeImage(conn, row.id, row.url);
          results.push({ id: row.id, name: row.name, status: 'downloaded now' });
        } catch (err) {
          results.push({ id: row.id, name: row.name, status: `failed: ${readableError(err)}`, url: row.url });
        }
      }
    }
    return results;
  });

  app.get('/api/courses', { preHandler: requireAdmin }, async (): Promise<Course[]> => {
    const { rows } = await sql<CourseRow>(
      `select moodle_course_id as id, shortname, fullname, visible
         from courses
        order by fullname asc`,
    );
    return rows.map((row) => ({
      id: row.id,
      shortname: row.shortname,
      fullname: row.fullname,
      visible: row.visible,
    }));
  });

  app.get('/api/users', { preHandler: requireAdmin }, async (): Promise<MoodleUser[]> => {
    const { rows } = await sql<UserRow>(
      `select moodle_user_id as id, fullname, email
         from moodle_users
        order by fullname asc`,
    );
    return rows.map((row) => ({ id: row.id, fullname: row.fullname, email: row.email }));
  });
}
