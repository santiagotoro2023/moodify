/**
 * Moodle poller (spec §9.2 discovery, §9.3 badge images, §9.4 scheduling & failure).
 *
 * Two passes:
 *   - Full discovery: courses → enrolled users → per-(user,course) completion + badges.
 *     Expensive, so it runs on FULL_DISCOVERY_INTERVAL_MS (15 min) or on demand.
 *   - Light sync: the same completion/badge refresh, but only for (user,course) pairs
 *     already in `enrollments`. No course/user discovery. This is what the configurable
 *     poll interval (default 60s) actually runs.
 *
 * Invariants this file must never break:
 *   - A Moodle failure must never crash the process or reject out of the scheduler.
 *     Errors land in moodle_connection.last_sync_error and the UI keeps rendering the
 *     previous snapshot rows, which are never cleared on failure (§9.4).
 *   - The web service token is never logged and never leaves the backend (§9.5).
 *   - percent_complete stays NULL for courses with no completion-tracked activities;
 *     it is never coerced to 0 (§9.2).
 *
 * DELETIONS: entities that vanish from Moodle are deliberately NOT hard-deleted. The
 * FKs cascade, so removing a course mid-sync would silently wipe its completion and
 * badge rows — a transient Moodle permission glitch would destroy real data. Instead a
 * disappeared course/user simply stops having its `last_seen_at` refreshed, which is
 * enough for a future "stale entities" cleanup to be an explicit, admin-triggered action.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { SyncProgress } from '@moodify/shared';
import { ASSETS_DIR, DEFAULT_POLL_INTERVAL_SECONDS, FULL_DISCOVERY_INTERVAL_MS } from './config.ts';
import { decryptSecret } from './crypto.ts';
import { sql } from './db.ts';
import {
  computeCompletion,
  downloadImage,
  getActivitiesCompletion,
  getCohortMembers,
  getCohorts,
  getCourseContents,
  getCourses,
  getEnrolledUsers,
  getUserBadges,
  MoodleError,
  type ActivityCompletionStatus,
  type MoodleConnection,
  type UserBadge,
} from './moodle.ts';

/** Simultaneous Moodle requests. <50 users × <20 courses is ~1000 calls per full run;
 *  firing them all at once would hammer a small Moodle box into refusing connections. */
const CONCURRENCY = 4;

/** Defensive bounds on the DB-configured interval so a bad value can never spin the loop. */
const MIN_POLL_INTERVAL_SECONDS = 10;
const MAX_POLL_INTERVAL_SECONDS = 24 * 60 * 60;

/** Let the container settle (and the wizard appear) before the first poll. */
const FIRST_TICK_DELAY_MS = 5_000;

/** last_sync_error is rendered in a banner; keep it readable. */
const MAX_ERROR_LENGTH = 1_000;

// ---------------------------------------------------------------------------
// Row shapes. Type aliases, not interfaces: pg's `query<R extends QueryResultRow>`
// needs an implicit index signature, which interfaces do not get.
// ---------------------------------------------------------------------------

type ConnectionRow = {
  id: number;
  base_url: string;
  ws_token: string;
  poll_interval_seconds: number;
};

type EnrollmentRow = {
  moodle_course_id: number;
  moodle_user_id: number;
};

type CachedImageRow = {
  cached_image_path: string | null;
};

// ---------------------------------------------------------------------------
// In-memory progress (§8 step 4). Deliberately not persisted — it describes the
// run happening right now, and a restart means there is no run happening.
// ---------------------------------------------------------------------------

const progress: SyncProgress = {
  status: 'never',
  phase: null,
  courses: 0,
  users: 0,
  badges: 0,
  error: null,
};

export function getSyncProgress(): SyncProgress {
  return { ...progress };
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** v1 stores exactly one connection; the lowest id is it. */
async function readConnectionRow(): Promise<ConnectionRow | null> {
  const { rows } = await sql<ConnectionRow>(
    `select id, base_url, ws_token, poll_interval_seconds
       from moodle_connection
      order by id
      limit 1`,
  );
  return rows[0] ?? null;
}

function decryptToken(ciphertext: string): string {
  try {
    return decryptSecret(ciphertext);
  } catch {
    // Almost always a changed ENCRYPTION_KEY. Say so instead of leaking crypto internals.
    throw new Error(
      'The stored Moodle token could not be decrypted. This normally means ENCRYPTION_KEY ' +
        'in .env changed since the token was saved — re-enter the token in Settings.',
    );
  }
}

/**
 * The decrypted Moodle connection, or null when Moodify has not been connected yet.
 * The token is returned in memory only: never log this object.
 */
export async function loadConnection(): Promise<MoodleConnection | null> {
  const row = await readConnectionRow();
  if (row === null) return null;
  return { baseUrl: row.base_url, token: decryptToken(row.ws_token) };
}

function clampPollInterval(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_POLL_INTERVAL_SECONDS;
  return Math.min(MAX_POLL_INTERVAL_SECONDS, Math.max(MIN_POLL_INTERVAL_SECONDS, Math.trunc(seconds)));
}

// ---------------------------------------------------------------------------
// Status bookkeeping
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
  const raw =
    err instanceof MoodleError
      ? err.message
      : err instanceof Error && err.message !== ''
        ? err.message
        : String(err);
  return raw.length > MAX_ERROR_LENGTH ? `${raw.slice(0, MAX_ERROR_LENGTH)}…` : raw;
}

async function markRunning(connectionId: number): Promise<void> {
  await sql(`update moodle_connection set last_sync_status = 'running' where id = $1`, [connectionId]);
}

async function markSuccess(connectionId: number): Promise<void> {
  await sql(
    `update moodle_connection
        set last_sync_status = 'ok', last_sync_error = null, last_sync_at = now()
      where id = $1`,
    [connectionId],
  );
}

/** last_sync_at means "when the last sync attempt finished", so the failure banner
 *  can say *when* it failed; last_sync_status disambiguates success from failure. */
async function markFailure(connectionId: number, message: string): Promise<void> {
  await sql(
    `update moodle_connection
        set last_sync_status = 'error', last_sync_error = $2, last_sync_at = now()
      where id = $1`,
    [connectionId, message],
  );
}

// ---------------------------------------------------------------------------
// Upserts. Every synced row is an upsert on its natural (Moodle) primary key, so a
// re-sync overwrites in place and the snapshot stays live rather than historical.
// ---------------------------------------------------------------------------

async function upsertCourse(course: {
  id: number;
  shortname: string;
  fullname: string;
  visible: boolean;
}): Promise<void> {
  await sql(
    `insert into courses (moodle_course_id, shortname, fullname, visible, last_seen_at)
     values ($1, $2, $3, $4, now())
     on conflict (moodle_course_id) do update
        set shortname    = excluded.shortname,
            fullname     = excluded.fullname,
            visible      = excluded.visible,
            last_seen_at = now()`,
    [course.id, course.shortname, course.fullname, course.visible],
  );
}

/** Upserts the user and reports whether their avatar still needs downloading. */
async function upsertUser(user: {
  id: number;
  fullname: string;
  email: string | null;
  profileImageUrl?: string | null;
}): Promise<{ avatarUrl: string | null; cached: string | null }> {
  // Moodle hides email in some course contexts, so a null must not erase a known address.
  // Same for the avatar URL, which only the enrolled-users call carries.
  const { rows } = await sql<{ avatar_source_url: string | null; avatar_image_path: string | null }>(
    `insert into moodle_users (moodle_user_id, fullname, email, avatar_source_url, last_seen_at)
     values ($1, $2, $3, $4, now())
     on conflict (moodle_user_id) do update
        set fullname          = excluded.fullname,
            email             = coalesce(excluded.email, moodle_users.email),
            avatar_source_url = coalesce(excluded.avatar_source_url, moodle_users.avatar_source_url),
            -- Moodle bumps ?rev= in the URL when someone changes their picture, so a
            -- changed URL means the cached file is stale: drop it and it re-downloads.
            avatar_image_path = case
              when excluded.avatar_source_url is not null
               and excluded.avatar_source_url is distinct from moodle_users.avatar_source_url
              then null else moodle_users.avatar_image_path end,
            last_seen_at      = now()
     returning avatar_source_url, avatar_image_path`,
    [user.id, user.fullname, user.email, user.profileImageUrl ?? null],
  );
  return {
    avatarUrl: rows[0]?.avatar_source_url ?? null,
    cached: rows[0]?.avatar_image_path ?? null,
  };
}

async function upsertEnrollment(courseId: number, userId: number, roles: string[]): Promise<void> {
  await sql(
    `insert into enrollments (moodle_course_id, moodle_user_id, roles, last_seen_at)
     values ($1, $2, $3::text[], now())
     on conflict (moodle_course_id, moodle_user_id) do update
        set roles        = excluded.roles,
            last_seen_at = now()`,
    [courseId, userId, roles],
  );
}

async function upsertCompletion(
  courseId: number,
  userId: number,
  total: number,
  completed: number,
  percent: number | null,
): Promise<void> {
  // percent is NULL when the course tracks no activities — that is "not tracked", not 0%.
  await sql(
    `insert into completion_snapshot
       (moodle_course_id, moodle_user_id, activities_total, activities_completed, percent_complete, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (moodle_course_id, moodle_user_id) do update
        set activities_total     = excluded.activities_total,
            activities_completed = excluded.activities_completed,
            percent_complete     = excluded.percent_complete,
            updated_at           = now()`,
    [courseId, userId, total, completed, percent],
  );
}

/** Upserts the badge definition and reports whether its image is already cached. */
async function upsertBadge(badge: UserBadge): Promise<string | null> {
  // badges.moodle_course_id is a FK: resolving it through a subquery yields NULL for a
  // course Moodify has not discovered (hidden, or deleted since), instead of an FK error.
  // coalesce keeps a previously-learned course id when a site-wide lookup omits it.
  const { rows } = await sql<CachedImageRow>(
    `insert into badges (moodle_badge_id, moodle_course_id, name, description, source_url)
     values ($1, (select moodle_course_id from courses where moodle_course_id = $2), $3, $4, $5)
     on conflict (moodle_badge_id) do update
        set moodle_course_id = coalesce(excluded.moodle_course_id, badges.moodle_course_id),
            name             = excluded.name,
            description      = excluded.description,
            source_url       = coalesce(excluded.source_url, badges.source_url)
     returning cached_image_path`,
    [badge.id, badge.courseid, badge.name, badge.description, badge.badgeurl],
  );
  return rows[0]?.cached_image_path ?? null;
}

async function upsertBadgeIssued(badgeId: number, userId: number, issuedAt: Date | null): Promise<void> {
  await sql(
    `insert into badge_issued (moodle_badge_id, moodle_user_id, date_issued)
     values ($1, $2, $3)
     on conflict (moodle_badge_id, moodle_user_id) do update
        set date_issued = coalesce(excluded.date_issued, badge_issued.date_issued)`,
    [badgeId, userId, issuedAt],
  );
}

// ---------------------------------------------------------------------------
// Badge images (§9.3): fetched once through the token, then served by Moodify.
// ---------------------------------------------------------------------------

function extensionFor(contentType: string): string {
  const type = contentType.toLowerCase();
  if (type.includes('svg')) return 'svg';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('gif')) return 'gif';
  if (type.includes('webp')) return 'webp';
  return 'png';
}

// ---------------------------------------------------------------------------
// Run context
// ---------------------------------------------------------------------------

type SyncMode = 'full' | 'light';

interface RunContext {
  mode: SyncMode;
  conn: MoodleConnection;
  logger: FastifyBaseLogger;
  courseIds: Set<number>;
  userIds: Set<number>;
  badgeIds: Set<number>;
  /** Badge ids whose image download was already started this run (dedupes shared badges). */
  imagesHandled: Set<number>;
  /** Same, for profile pictures (dedupes a student enrolled in several courses). */
  avatarsHandled: Set<number>;
  attempted: number;
  failures: number;
  firstError: string | null;
}

/**
 * A single Moodle call failing (one student with a hidden profile, one course the token
 * cannot read) must not abandon the other 999 calls — it is counted and the run continues,
 * then reported as a partial failure at the end.
 */
function recordFailure(ctx: RunContext, err: unknown, detail: Record<string, unknown>): void {
  const message = describeError(err);
  ctx.failures += 1;
  if (ctx.firstError === null) ctx.firstError = message;
  ctx.logger.warn({ ...detail, err: message }, 'moodle sync step failed');
}

/** Full runs publish counters live so the wizard can watch them climb. */
function publishCounters(ctx: RunContext, force = false): void {
  if (!force && ctx.mode !== 'full') return;
  progress.courses = ctx.courseIds.size;
  progress.users = ctx.userIds.size;
  progress.badges = ctx.badgeIds.size;
}

/** Downloads one badge image and records it. Throws — callers decide how loud to be. */
export async function fetchAndStoreBadgeImage(
  conn: MoodleConnection,
  badgeId: number,
  imageUrl: string,
): Promise<void> {
  const { buffer, contentType } = await downloadImage(conn, imageUrl);
  const filename = `${badgeId}.${extensionFor(contentType)}`;
  const directory = join(ASSETS_DIR, 'badges');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), buffer);
  // Stored relative to ASSETS_DIR; the API prefixes it with ASSETS_URL_PREFIX.
  await sql('update badges set cached_image_path = $2 where moodle_badge_id = $1', [
    badgeId,
    `badges/${filename}`,
  ]);
}

/** Same deal for profile pictures. Throws — callers decide how loud to be. */
export async function fetchAndStoreAvatar(
  conn: MoodleConnection,
  userId: number,
  imageUrl: string,
): Promise<void> {
  const { buffer, contentType } = await downloadImage(conn, imageUrl);
  const filename = `${userId}.${extensionFor(contentType)}`;
  const directory = join(ASSETS_DIR, 'avatars');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), buffer);
  await sql('update moodle_users set avatar_image_path = $2 where moodle_user_id = $1', [
    userId,
    `avatars/${filename}`,
  ]);
}

async function cacheBadgeImage(ctx: RunContext, badgeId: number, imageUrl: string): Promise<void> {
  try {
    await fetchAndStoreBadgeImage(ctx.conn, badgeId, imageUrl);
  } catch (err) {
    // §9.3: a broken image is cosmetic. Never let it fail the sync — but log loudly,
    // since the only symptom in the UI is a generic placeholder icon.
    ctx.logger.error(
      { badgeId, imageUrl, err: describeError(err) },
      'badge image download failed — widgets will show a placeholder icon',
    );
  }
}

async function cacheAvatar(ctx: RunContext, userId: number, imageUrl: string): Promise<void> {
  try {
    await fetchAndStoreAvatar(ctx.conn, userId, imageUrl);
  } catch (err) {
    // Cosmetic, exactly like a badge image: the chart falls back to initials.
    ctx.logger.warn({ userId, err: describeError(err) }, 'profile picture download failed');
  }
}

async function storeBadges(ctx: RunContext, userId: number, badges: readonly UserBadge[]): Promise<void> {
  for (const badge of badges) {
    const cachedPath = await upsertBadge(badge);
    await upsertBadgeIssued(
      badge.id,
      userId,
      badge.dateissued === null ? null : new Date(badge.dateissued * 1000),
    );
    ctx.badgeIds.add(badge.id);
    publishCounters(ctx);

    if (cachedPath === null && badge.badgeurl !== null && !ctx.imagesHandled.has(badge.id)) {
      ctx.imagesHandled.add(badge.id);
      await cacheBadgeImage(ctx, badge.id, badge.badgeurl);
    }
  }
}

// ---------------------------------------------------------------------------
// Work units
// ---------------------------------------------------------------------------

type SyncTask =
  | { kind: 'pair'; courseId: number; userId: number }
  | { kind: 'user'; userId: number };

/**
 * Mirrors the *completed* activities of one (course, user) pair, with Moodle's own
 * completion timestamps, into activity_completion.
 *
 * Full runs only. The timestamps are historical facts that do not change between polls,
 * so re-reading them every 60 seconds would rewrite 20k rows a minute to learn nothing;
 * once per full discovery is plenty, and metric_history already covers the live end of
 * the chart at a finer grain.
 *
 * Un-completing an activity in Moodle has to remove its row, otherwise the all-time line
 * only ever goes up — hence the delete of anything no longer in the completed set.
 */
async function storeCompletedActivities(
  courseId: number,
  userId: number,
  statuses: readonly ActivityCompletionStatus[],
): Promise<void> {
  const cmids: number[] = [];
  const times: (Date | null)[] = [];
  for (const status of statuses) {
    if (status.tracking === 0) continue;
    // 3 = complete-fail, which computeCompletion also declines to count as completed.
    if (status.state !== 1 && status.state !== 2) continue;
    cmids.push(status.cmid);
    times.push(status.timecompleted === null ? null : new Date(status.timecompleted * 1000));
  }

  await sql(
    `delete from activity_completion
      where moodle_course_id = $1 and moodle_user_id = $2 and cmid <> all($3::int[])`,
    [courseId, userId, cmids],
  );
  if (cmids.length === 0) return;

  await sql(
    `insert into activity_completion (moodle_course_id, moodle_user_id, cmid, completed_at)
     select $1, $2, entry.cmid, entry.at
       from unnest($3::int[], $4::timestamptz[]) as entry(cmid, at)
     on conflict (moodle_course_id, moodle_user_id, cmid)
        do update set completed_at = excluded.completed_at`,
    [courseId, userId, cmids, times],
  );
}

async function refreshPair(ctx: RunContext, courseId: number, userId: number): Promise<void> {
  const statuses = await getActivitiesCompletion(ctx.conn, courseId, userId);
  const summary = computeCompletion(statuses);
  if (ctx.mode === 'full') await storeCompletedActivities(courseId, userId, statuses);
  await upsertCompletion(
    courseId,
    userId,
    summary.activitiesTotal,
    summary.activitiesCompleted,
    summary.percent,
  );

  // §9.2: "badges in a course" is the union of badges actually awarded to its enrolled
  // users — Moodle exposes no endpoint listing the badges *configured* for a course.
  const badges = await getUserBadges(ctx.conn, userId, courseId);
  await storeBadges(ctx, userId, badges);
}

/** Unscoped lookup, which is the only way site-wide (non-course) badges show up. */
async function refreshUserBadges(ctx: RunContext, userId: number): Promise<void> {
  const badges = await getUserBadges(ctx.conn, userId);
  await storeBadges(ctx, userId, badges);
}

/**
 * Hand-rolled bounded worker pool: `limit` runners pull from a shared index until the
 * list is exhausted. No dependency, and no possibility of firing 1000 requests at once.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runnerCount = Math.max(1, Math.min(limit, items.length));
  const runners: Promise<void>[] = [];

  for (let i = 0; i < runnerCount; i += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= items.length) return;
          const item = items[index];
          if (item === undefined) continue; // noUncheckedIndexedAccess
          await worker(item);
        }
      })(),
    );
  }

  await Promise.all(runners);
}

async function processTasks(ctx: RunContext, tasks: readonly SyncTask[]): Promise<void> {
  const total = tasks.length;
  let done = 0;
  progress.phase = total === 0 ? 'Nothing to refresh yet' : `Reading completion & badges (0/${total})`;

  await runWithConcurrency(tasks, CONCURRENCY, async (task) => {
    ctx.attempted += 1;
    try {
      if (task.kind === 'pair') {
        await refreshPair(ctx, task.courseId, task.userId);
      } else {
        await refreshUserBadges(ctx, task.userId);
      }
    } catch (err) {
      recordFailure(ctx, err, { ...task });
    } finally {
      done += 1;
      progress.phase = `Reading completion & badges (${done}/${total})`;
    }
  });
}

// ---------------------------------------------------------------------------
// Deadline tracking inputs: cohorts, cohort membership and activity names.
//
// All three ride on optional web service functions. An External Service that predates
// the feature simply does not expose them, and that is not a sync failure — it means no
// deadlines can be configured, which Settings explains. So these are logged and skipped,
// never counted through recordFailure, which would raise the connection error banner
// over a feature the admin may not use.
// ---------------------------------------------------------------------------

function skipOptional(ctx: RunContext, err: unknown, detail: Record<string, unknown>): void {
  ctx.logger.info({ ...detail, err: describeError(err) }, 'deadline data unavailable, skipping');
}

async function syncCohorts(ctx: RunContext): Promise<void> {
  progress.phase = 'Discovering cohorts';
  let cohorts;
  try {
    cohorts = await getCohorts(ctx.conn);
  } catch (err) {
    skipOptional(ctx, err, { step: 'cohorts' });
    return;
  }

  for (const cohort of cohorts) {
    await sql(
      `insert into cohorts (moodle_cohort_id, name, idnumber, last_seen_at)
       values ($1, $2, $3, now())
       on conflict (moodle_cohort_id) do update
          set name = excluded.name, idnumber = excluded.idnumber, last_seen_at = now()`,
      [cohort.id, cohort.name, cohort.idnumber],
    );
  }

  let members;
  try {
    members = await getCohortMembers(ctx.conn, cohorts.map((c) => c.id));
  } catch (err) {
    skipOptional(ctx, err, { step: 'cohort members' });
    return;
  }

  for (const [cohortId, userIds] of members) {
    // Membership is the one thing here that must mirror Moodle exactly: someone moved
    // out of "1. Lehrjahr" must stop being measured against its deadlines immediately.
    // Deleting a membership row costs nothing — unlike a user or course, it cascades to
    // nothing — so a full replace is safe where hard deletion elsewhere is not.
    await sql(`delete from cohort_members where moodle_cohort_id = $1 and moodle_user_id <> all($2::int[])`, [
      cohortId,
      userIds,
    ]);
    if (userIds.length === 0) continue;
    // Only users Moodify already knows: a cohort routinely contains people enrolled in
    // no tracked course, and the FK would reject them.
    await sql(
      `insert into cohort_members (moodle_cohort_id, moodle_user_id)
       select $1, id from unnest($2::int[]) as id
        where exists (select 1 from moodle_users u where u.moodle_user_id = id)
       on conflict do nothing`,
      [cohortId, userIds],
    );
  }
}

/** Activity names for one course. Never deletes: a deadline FKs to these rows. */
async function syncCourseActivities(ctx: RunContext, courseId: number): Promise<void> {
  let modules;
  try {
    modules = await getCourseContents(ctx.conn, courseId);
  } catch (err) {
    skipOptional(ctx, err, { step: 'course contents', courseId });
    return;
  }
  for (const module of modules) {
    await sql(
      `insert into course_activities
         (moodle_course_id, cmid, name, modname, section, section_order, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (moodle_course_id, cmid) do update
          set name          = excluded.name,
              modname       = excluded.modname,
              section       = excluded.section,
              section_order = excluded.section_order,
              last_seen_at  = now()`,
      [courseId, module.cmid, module.name, module.modname, module.section, module.sectionOrder],
    );
  }
}

// ---------------------------------------------------------------------------
// Discovery (§9.2)
// ---------------------------------------------------------------------------

async function discoverEntities(ctx: RunContext): Promise<SyncTask[]> {
  progress.phase = 'Discovering courses';
  const courses = await getCourses(ctx.conn); // fatal if it fails: there is nothing to sync
  for (const course of courses) {
    await upsertCourse(course);
    ctx.courseIds.add(course.id);
    await syncCourseActivities(ctx, course.id);
  }
  publishCounters(ctx);

  const pairs: SyncTask[] = [];
  let index = 0;
  for (const course of courses) {
    index += 1;
    progress.phase = `Discovering enrolled users (${index}/${courses.length})`;
    ctx.attempted += 1;
    try {
      const users = await getEnrolledUsers(ctx.conn, course.id);
      for (const user of users) {
        const avatar = await upsertUser(user);
        // Once per run, however many courses the same student turns up in.
        if (avatar.cached === null && avatar.avatarUrl !== null && !ctx.avatarsHandled.has(user.id)) {
          ctx.avatarsHandled.add(user.id);
          await cacheAvatar(ctx, user.id, avatar.avatarUrl);
        }
        await upsertEnrollment(course.id, user.id, user.roles);
        ctx.userIds.add(user.id);
        pairs.push({ kind: 'pair', courseId: course.id, userId: user.id });
      }
      publishCounters(ctx);
    } catch (err) {
      // One unreadable course should not cost us the other nineteen.
      recordFailure(ctx, err, { courseId: course.id });
    }
  }

  // After the users exist: cohort_members has a FK onto moodle_users, and a cohort
  // routinely lists people who are not enrolled in anything Moodify tracks.
  await syncCohorts(ctx);

  const tasks: SyncTask[] = [...pairs];
  for (const userId of ctx.userIds) tasks.push({ kind: 'user', userId });
  return tasks;
}

/** Light pass: work only from what discovery already found — no course/user lookups. */
async function loadKnownTasks(ctx: RunContext): Promise<SyncTask[]> {
  const { rows } = await sql<EnrollmentRow>(
    `select moodle_course_id, moodle_user_id
       from enrollments
      order by moodle_course_id, moodle_user_id`,
  );

  const tasks: SyncTask[] = [];
  for (const row of rows) {
    ctx.courseIds.add(row.moodle_course_id);
    ctx.userIds.add(row.moodle_user_id);
    tasks.push({ kind: 'pair', courseId: row.moodle_course_id, userId: row.moodle_user_id });
  }
  for (const userId of ctx.userIds) tasks.push({ kind: 'user', userId });
  return tasks;
}

// ---------------------------------------------------------------------------
// History samples, for the progress_chart widget. Everything else in Moodify is a
// live snapshot; this is the one table that keeps a trail.
// ---------------------------------------------------------------------------

/** How often a sample is written, regardless of how often the poll runs. */
const SAMPLE_INTERVAL_MS = 15 * 60 * 1000;
/** How far back the chart can ever reach. Older samples are deleted, so the window
 *  rolls forward instead of the chart going blank on the seventh day. */
const HISTORY_RETENTION_DAYS = 7;

/**
 * Appends one sample of every student's badge count and completion, if the last one is
 * old enough, and prunes anything past the retention window.
 *
 * Sampling is time-gated off the table rather than a module variable so that restarting
 * the container does not restart the cadence — 60s polls would otherwise write a sample
 * every minute for as long as the process happens to live.
 *
 * The counts are computed in SQL to match the widgets exactly: a course-scoped row counts
 * that course's badges plus site-wide ones (as badge_cards does), and the all-courses row
 * counts every badge held and averages completion over tracked courses only (§9.2).
 */
async function recordHistorySample(logger: FastifyBaseLogger): Promise<void> {
  const { rows } = await sql<{ due: boolean }>(
    // ::text on the parameter is load-bearing: without it `$1 || ' milliseconds'` is two
    // unknowns and Postgres rejects the operator as ambiguous.
    `select coalesce(max(recorded_at) < now() - ($1::text || ' milliseconds')::interval, true) as due
       from metric_history`,
    [SAMPLE_INTERVAL_MS],
  );
  if (rows[0]?.due !== true) return;

  // One timestamp for the whole sample, so every student's point lines up on the axis.
  const { rows: stamp } = await sql<{ now: Date }>('select now() as now');
  const at = stamp[0]?.now ?? new Date();

  await sql(
    `insert into metric_history (moodle_user_id, moodle_course_id, recorded_at, percent_complete, badge_count)
     select e.moodle_user_id, e.moodle_course_id, $1, cs.percent_complete,
            (select count(*)
               from badge_issued bi
               join badges b on b.moodle_badge_id = bi.moodle_badge_id
              where bi.moodle_user_id = e.moodle_user_id
                and (b.moodle_course_id = e.moodle_course_id or b.moodle_course_id is null))::int
       from enrollments e
       left join completion_snapshot cs
         on cs.moodle_course_id = e.moodle_course_id
        and cs.moodle_user_id = e.moodle_user_id`,
    [at],
  );

  await sql(
    `insert into metric_history (moodle_user_id, moodle_course_id, recorded_at, percent_complete, badge_count)
     select u.moodle_user_id, null, $1,
            (select avg(cs.percent_complete)
               from completion_snapshot cs
              where cs.moodle_user_id = u.moodle_user_id and cs.percent_complete is not null),
            (select count(*) from badge_issued bi where bi.moodle_user_id = u.moodle_user_id)::int
       from moodle_users u`,
    [at],
  );

  const pruned = await sql(
    `delete from metric_history where recorded_at < now() - ($1::text || ' days')::interval`,
    [HISTORY_RETENTION_DAYS],
  );
  logger.info({ prunedRows: pruned.rowCount ?? 0 }, 'history sample recorded');
}

// ---------------------------------------------------------------------------
// Run driver — the single place that catches everything.
// ---------------------------------------------------------------------------

async function executeRun(logger: FastifyBaseLogger, mode: SyncMode): Promise<void> {
  let connectionId: number | null = null;

  try {
    const row = await readConnectionRow();
    if (row === null) {
      // Not connected yet: nothing to sync, and no row to record a status on.
      progress.status = 'never';
      progress.phase = null;
      return;
    }
    connectionId = row.id;

    const ctx: RunContext = {
      mode,
      conn: { baseUrl: row.base_url, token: decryptToken(row.ws_token) },
      logger,
      courseIds: new Set<number>(),
      userIds: new Set<number>(),
      badgeIds: new Set<number>(),
      imagesHandled: new Set<number>(),
      avatarsHandled: new Set<number>(),
      attempted: 0,
      failures: 0,
      firstError: null,
    };

    progress.status = 'running';
    progress.error = null;
    progress.phase = mode === 'full' ? 'Starting full discovery' : 'Refreshing completion & badges';
    if (mode === 'full') {
      progress.courses = 0;
      progress.users = 0;
      progress.badges = 0;
    }
    await markRunning(row.id);

    const started = Date.now();
    const tasks = mode === 'full' ? await discoverEntities(ctx) : await loadKnownTasks(ctx);
    await processTasks(ctx, tasks);
    publishCounters(ctx, true);

    // After the snapshot is up to date, never before. A failure here is not a sync
    // failure: the chart losing a point must not raise the connection banner.
    try {
      await recordHistorySample(logger);
    } catch (err) {
      logger.warn({ err: describeError(err) }, 'history sample failed');
    }

    const durationMs = Date.now() - started;
    progress.phase = null;

    if (ctx.failures > 0) {
      const summary =
        `${ctx.failures} of ${ctx.attempted} Moodle calls failed during the last sync. ` +
        `First error: ${ctx.firstError ?? 'unknown'}`;
      progress.status = 'error';
      progress.error = summary;
      await markFailure(row.id, summary);
      logger.warn({ mode, failures: ctx.failures, attempted: ctx.attempted, durationMs }, 'sync finished with errors');
      return;
    }

    progress.status = 'ok';
    progress.error = null;
    await markSuccess(row.id);
    logger.info(
      { mode, courses: progress.courses, users: progress.users, badges: progress.badges, durationMs },
      'sync complete',
    );
  } catch (err) {
    // §9.4: the worker must survive anything Moodle (or the network) does. Existing
    // snapshot rows are left untouched so widgets keep showing last-known-good data.
    const message = describeError(err);
    progress.status = 'error';
    progress.phase = null;
    progress.error = message;
    logger.warn({ mode, err: message }, 'sync failed');
    if (connectionId !== null) {
      try {
        await markFailure(connectionId, message);
      } catch (dbErr) {
        logger.error({ err: describeError(dbErr) }, 'could not record sync failure');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** One run at a time: the timer and a manual "Re-sync now" must never overlap. */
let isRunning = false;
let lastFullDiscoveryAt = 0;
let schedulerStarted = false;

export async function runFullDiscovery(logger: FastifyBaseLogger): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    await executeRun(logger, 'full');
  } finally {
    // Recorded even on failure, so a broken Moodle is not re-crawled every poll tick.
    lastFullDiscoveryAt = Date.now();
    isRunning = false;
  }
}

export async function runLightSync(logger: FastifyBaseLogger): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    await executeRun(logger, 'light');
  } finally {
    isRunning = false;
  }
}

/** POST /api/sync — kicks off a full discovery and answers immediately; the wizard and
 *  Settings poll GET /api/sync/progress for the live counters. */
export async function triggerSync(logger: FastifyBaseLogger): Promise<void> {
  if (isRunning) {
    logger.info('sync already in progress; manual trigger ignored');
    return;
  }
  // Intentionally not awaited. runFullDiscovery sets isRunning synchronously before its
  // first await, so /api/sync/progress already reports 'running' when this returns.
  void runFullDiscovery(logger).catch((err: unknown) => {
    logger.error({ err: describeError(err) }, 'manual sync crashed');
  });
}

async function tick(logger: FastifyBaseLogger): Promise<void> {
  let nextDelayMs = DEFAULT_POLL_INTERVAL_SECONDS * 1000;

  try {
    const row = await readConnectionRow();
    if (row !== null) {
      // Re-read every tick so changing the interval in Settings takes effect without a restart.
      nextDelayMs = clampPollInterval(row.poll_interval_seconds) * 1000;
      if (Date.now() - lastFullDiscoveryAt >= FULL_DISCOVERY_INTERVAL_MS) {
        await runFullDiscovery(logger);
      } else {
        await runLightSync(logger);
      }
    }
    // No connection row: skip silently and re-arm. The wizard has not run yet.
  } catch (err) {
    // executeRun swallows its own errors; this only catches DB failures around it.
    logger.warn({ err: describeError(err) }, 'sync tick failed');
  } finally {
    arm(logger, nextDelayMs);
  }
}

function arm(logger: FastifyBaseLogger, delayMs: number): void {
  const handle = setTimeout(() => {
    void tick(logger);
  }, delayMs);
  handle.unref(); // never hold the process open on shutdown
}

/**
 * Re-armed setTimeout rather than setInterval or node-cron, on purpose:
 *  - setInterval would queue a second run while a slow sync is still going, so a sync
 *    that takes longer than the interval would overlap itself. Re-arming only after a
 *    run finishes makes that structurally impossible.
 *  - node-cron cannot express "every N seconds" where N is an arbitrary number read from
 *    the database at runtime (cron has no field for it, and a 137s interval has no
 *    expression at all), and the poll interval is a Settings field, not a build constant.
 */
export function startSyncScheduler(logger: FastifyBaseLogger): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  arm(logger, FIRST_TICK_DELAY_MS);
}
