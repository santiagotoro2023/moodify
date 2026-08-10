import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from './db.ts';

const COOKIE = 'moodify_session';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Sessions are a signed cookie holding the admin id — no server-side store.
 * With a single admin account there is nothing a session table would buy us.
 */
export function startSession(request: FastifyRequest, reply: FastifyReply, adminId: number): void {
  reply.setCookie(COOKIE, String(adminId), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    maxAge: MAX_AGE_SECONDS,
    // Only mark Secure when the request actually arrived over TLS, otherwise
    // login breaks on the plain-HTTP address the installer prints (§2).
    secure: (request.headers['x-forwarded-proto'] ?? request.protocol) === 'https',
  });
}

export function endSession(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' });
}

export async function currentAdminId(request: FastifyRequest): Promise<number | null> {
  const raw = request.cookies[COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  const id = Number(unsigned.value);
  if (!Number.isInteger(id)) return null;
  const { rows } = await sql('select 1 from admin_users where id = $1', [id]);
  return rows.length ? id : null;
}

/** Fastify preHandler for every admin-only route. Public routes never use this. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = await currentAdminId(request);
  if (id === null) {
    await reply.code(401).send({ error: 'Not signed in' });
    return;
  }
  request.adminId = id;
}

declare module 'fastify' {
  interface FastifyRequest {
    adminId?: number;
  }
}
