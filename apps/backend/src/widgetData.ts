import { ZodError } from 'zod';
import {
  parseWidgetConfig,
  type Badge,
  type ChartWindow,
  type CompletionEntry,
  type Course,
  type MoodleUser,
  type WidgetConfig,
  type WidgetData,
  type WidgetDataError,
  type WidgetType,
} from '@moodify/shared';
import { sql } from './db.ts';

/**
 * Read side of the widget system: turns a stored widget row into the payload
 * `GET /api/widgets/:id/data` (and its public twin) returns.
 *
 * Two rules run through every query here:
 *  - Students only, unless the widget config opts staff back in, so teachers
 *    never skew a course average or a leaderboard.
 *  - `percent_complete IS NULL` means "this course tracks no activities", which
 *    is NOT 0%. Untracked rows are excluded from averages and never coerced.
 *
 * A widget pointing at a course or user that has since disappeared from Moodle
 * degrades to a WidgetDataError rather than throwing — one stale widget must not
 * take down a whole dashboard.
 */

// ---------------------------------------------------------------------------
// Row shapes. These are type aliases rather than interfaces on purpose: pg's
// `query<R extends QueryResultRow>` requires an implicit index signature, which
// interfaces do not get.
// ---------------------------------------------------------------------------

type CourseRow = {
  moodle_course_id: number;
  shortname: string;
  fullname: string;
  visible: boolean;
};

type UserRow = {
  moodle_user_id: number;
  fullname: string;
  email: string | null;
  avatar_image_path?: string | null;
};

type BadgeRow = {
  moodle_badge_id: number;
  moodle_course_id: number | null;
  name: string;
  description: string | null;
  cached_image_path: string | null;
};

type UserBadgeRow = {
  moodle_user_id: number;
  moodle_badge_id: number;
  moodle_course_id: number | null;
  name: string;
  description: string | null;
  cached_image_path: string | null;
};

type CellRow = {
  moodle_course_id: number;
  moodle_user_id: number;
  activities_total: number;
  activities_completed: number;
  percent_complete: number | null;
};

type OverviewRow = {
  enrolled_count: number;
  average_percent: number | null;
  tracked_activity_count: number | null;
};

type LeaderboardRow = {
  moodle_user_id: number;
  fullname: string;
  email: string | null;
  badge_count: number;
};

type UserCourseRow = {
  moodle_course_id: number;
  shortname: string;
  fullname: string;
  visible: boolean;
  activities_total: number | null;
  activities_completed: number | null;
  percent_complete: number | null;
};

type TableRow = { user: MoodleUser; cells: CompletionEntry[] };

// ---------------------------------------------------------------------------
// Shared fragments and mappers
// ---------------------------------------------------------------------------

/**
 * The students-only predicate. `param` is the placeholder bound to
 * `config.includeStaff`, and the `enrollments` table must be aliased `e` in the
 * surrounding query. Kept in one place so every widget filters identically.
 */
function studentFilter(param: string): string {
  return `(${param}::boolean or 'student' = any(e.roles))`;
}

/**
 * Excluded-user predicate, appended wherever studentFilter is used so a widget's
 * exclusion list applies to rows, averages and rankings alike. `param` is bound to
 * config.excludeUserIds; an empty array excludes nobody.
 */
function excludeFilter(param: string): string {
  return `e.moodle_user_id <> all(${param}::int[])`;
}

function fail(message: string): WidgetDataError {
  return { type: 'error', message };
}

const COURSE_GONE = 'That course is no longer in Moodle. Pick another one in the widget settings.';
const USER_GONE = 'That user is no longer in Moodle. Pick another one in the widget settings.';

function toCourse(row: CourseRow): Course {
  return {
    id: row.moodle_course_id,
    shortname: row.shortname,
    fullname: row.fullname,
    visible: row.visible,
  };
}

function toUser(row: UserRow): MoodleUser {
  return { id: row.moodle_user_id, fullname: row.fullname, email: row.email };
}

/**
 * Like toUser, but with the profile picture attached. `base` is the route prefix the
 * caller is allowed to serve avatars from — public dashboards get a token-scoped one so
 * a share link cannot be turned into a directory of faces (§12).
 *
 * Only ever set when the file is actually cached: a null tells the frontend to draw
 * initials rather than fire a request that 404s.
 */
function toUserWithAvatar(row: UserRow, base: string): MoodleUser {
  return {
    ...toUser(row),
    avatarUrl: row.avatar_image_path ? `${base}/${row.moodle_user_id}` : null,
  };
}

/**
 * Badge images are served by Moodify itself — Moodle's pluginfile.php needs the web
 * service token, so it can never be hotlinked from the frontend (§9.3).
 */
function toBadge(row: BadgeRow): Badge {
  return {
    id: row.moodle_badge_id,
    name: row.name,
    description: row.description,
    courseId: row.moodle_course_id,
    // Always the proxy, never the cached path directly: it redirects to the cached
    // file when there is one and downloads it on the spot when there is not, so a
    // badge whose image failed during sync heals on first view.
    imageUrl: `/api/badge-image/${row.moodle_badge_id}`,
  };
}

function emptyEntry(courseId: number): CompletionEntry {
  return { courseId, activitiesTotal: 0, activitiesCompleted: 0, percent: null };
}

async function findCourse(courseId: number): Promise<Course | null> {
  const { rows } = await sql<CourseRow>(
    `select moodle_course_id, shortname, fullname, visible
       from courses
      where moodle_course_id = $1`,
    [courseId],
  );
  const row = rows[0];
  return row === undefined ? null : toCourse(row);
}

async function findUser(userId: number): Promise<MoodleUser | null> {
  const { rows } = await sql<UserRow>(
    `select moodle_user_id, fullname, email
       from moodle_users
      where moodle_user_id = $1`,
    [userId],
  );
  const row = rows[0];
  return row === undefined ? null : toUser(row);
}

// ---------------------------------------------------------------------------
// completion_table
// ---------------------------------------------------------------------------

function meanPercent(cells: CompletionEntry[]): number | null {
  let sum = 0;
  let count = 0;
  for (const cell of cells) {
    if (cell.percent !== null) {
      sum += cell.percent;
      count += 1;
    }
  }
  return count === 0 ? null : sum / count;
}

function compareNames(a: TableRow, b: TableRow): number {
  const byName = a.user.fullname.localeCompare(b.user.fullname);
  return byName !== 0 ? byName : a.user.id - b.user.id;
}

/** `percent` sorts on the user's mean; `course` sorts on the first in-scope course. */
function sortKey(row: TableRow, sortBy: 'name' | 'course' | 'percent'): number | null {
  if (sortBy === 'percent') return meanPercent(row.cells);
  const first = row.cells[0];
  return first === undefined ? null : first.percent;
}

function sortRows(
  rows: TableRow[],
  sortBy: 'name' | 'course' | 'percent',
  sortDir: 'asc' | 'desc',
): void {
  const dir = sortDir === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    if (sortBy === 'name') return dir * compareNames(a, b);
    const av = sortKey(a, sortBy);
    const bv = sortKey(b, sortBy);
    // Users with no tracked data sort last whichever direction is chosen —
    // "no data" is not a low score.
    if (av === null && bv === null) return compareNames(a, b);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return dir * (av - bv);
    return compareNames(a, b);
  });
}

async function completionTable(
  config: WidgetConfig['completion_table'],
): Promise<WidgetData | WidgetDataError> {
  let courses: Course[];
  if (config.scope === 'course') {
    if (config.courseId === null) return fail('No course selected for this widget.');
    const course = await findCourse(config.courseId);
    if (course === null) return fail(COURSE_GONE);
    courses = [course];
  } else {
    const { rows } = await sql<CourseRow>(
      `select moodle_course_id, shortname, fullname, visible
         from courses
        where visible = true
        order by fullname asc`,
    );
    courses = rows.map(toCourse);
  }

  if (courses.length === 0) return { type: 'completion_table', courses, rows: [] };
  const courseIds = courses.map((course) => course.id);

  const { rows: userRows } = await sql<UserRow>(
    `select distinct u.moodle_user_id, u.fullname, u.email
       from enrollments e
       join moodle_users u on u.moodle_user_id = e.moodle_user_id
      where e.moodle_course_id = any($1::int[])
        and ${studentFilter('$2')}
        and ${excludeFilter('$3')}
      order by u.fullname asc, u.moodle_user_id asc`,
    [courseIds, config.includeStaff, config.excludeUserIds],
  );
  const users = userRows.map(toUser);
  if (users.length === 0) return { type: 'completion_table', courses, rows: [] };

  const { rows: cellRows } = await sql<CellRow>(
    `select moodle_course_id, moodle_user_id, activities_total, activities_completed, percent_complete
       from completion_snapshot
      where moodle_course_id = any($1::int[])
        and moodle_user_id = any($2::int[])`,
    [courseIds, users.map((user) => user.id)],
  );

  const byPair = new Map<string, CompletionEntry>();
  for (const row of cellRows) {
    byPair.set(`${row.moodle_course_id}:${row.moodle_user_id}`, {
      courseId: row.moodle_course_id,
      activitiesTotal: row.activities_total,
      activitiesCompleted: row.activities_completed,
      percent: row.percent_complete,
    });
  }

  // A pair with no snapshot row yet (user enrolled between syncs) reads as
  // untracked rather than 0%.
  const rows: TableRow[] = users.map((user) => ({
    user,
    cells: courses.map(
      (course) => byPair.get(`${course.id}:${user.id}`) ?? emptyEntry(course.id),
    ),
  }));
  sortRows(rows, config.sortBy, config.sortDir);

  return { type: 'completion_table', courses, rows };
}

// ---------------------------------------------------------------------------
// badge_cards
// ---------------------------------------------------------------------------

type BadgeCard = { user: MoodleUser; badges: Badge[]; percent: number | null };

/**
 * Orders the badge widgets. Name is always the tie-break so equal counts keep a
 * stable order, and "no tracked completion" sorts last in both directions — an
 * absent percentage is not a low one.
 */
function sortCards(
  cards: BadgeCard[],
  sortBy: 'badges' | 'percent' | 'name',
  sortDir: 'asc' | 'desc',
): void {
  const dir = sortDir === 'desc' ? -1 : 1;
  cards.sort((a, b) => {
    const byName = a.user.fullname.localeCompare(b.user.fullname);
    if (sortBy === 'name') return dir * (byName !== 0 ? byName : a.user.id - b.user.id);
    if (sortBy === 'badges') {
      return dir * (a.badges.length - b.badges.length) || byName;
    }
    if (a.percent === null && b.percent === null) return byName;
    if (a.percent === null) return 1;
    if (b.percent === null) return -1;
    return dir * (a.percent - b.percent) || byName;
  });
}

async function badgeCards(
  config: WidgetConfig['badge_cards'],
  type: 'badge_cards' | 'badge_list' = 'badge_cards',
): Promise<WidgetData | WidgetDataError> {
  if (config.scope === 'user') {
    if (config.userId === null) return fail('No user selected for this widget.');
    const user = await findUser(config.userId);
    if (user === null) return fail(USER_GONE);

    const { rows } = await sql<BadgeRow>(
      `select b.moodle_badge_id, b.moodle_course_id, b.name, b.description, b.cached_image_path
         from badge_issued bi
         join badges b on b.moodle_badge_id = bi.moodle_badge_id
        where bi.moodle_user_id = $1
        order by b.name asc, b.moodle_badge_id asc`,
      [user.id],
    );
    const { rows: pct } = await sql<{ percent: number | null }>(
      `select avg(percent_complete) as percent
         from completion_snapshot
        where moodle_user_id = $1 and percent_complete is not null`,
      [user.id],
    );
    return {
      type,
      users: [{ user, badges: rows.map(toBadge), percent: pct[0]?.percent ?? null }],
    };
  }

  if (config.courseId === null) return fail('No course selected for this widget.');
  const course = await findCourse(config.courseId);
  if (course === null) return fail(COURSE_GONE);

  const { rows: userRows } = await sql<UserRow>(
    `select u.moodle_user_id, u.fullname, u.email
       from enrollments e
       join moodle_users u on u.moodle_user_id = e.moodle_user_id
      where e.moodle_course_id = $1
        and ${studentFilter('$2')}
        and ${excludeFilter('$3')}
      order by u.fullname asc, u.moodle_user_id asc`,
    [course.id, config.includeStaff, config.excludeUserIds],
  );
  const users = userRows.map(toUser);
  if (users.length === 0) return { type, users: [] };

  const { rows: completionRows } = await sql<{ moodle_user_id: number; percent: number | null }>(
    `select moodle_user_id, percent_complete as percent
       from completion_snapshot
      where moodle_course_id = $1 and moodle_user_id = any($2::int[])`,
    [course.id, users.map((user) => user.id)],
  );
  const percentByUser = new Map(completionRows.map((row) => [row.moodle_user_id, row.percent]));

  // Badges attributed to this course, plus site-wide badges the user holds.
  const { rows: badgeRows } = await sql<UserBadgeRow>(
    `select bi.moodle_user_id, b.moodle_badge_id, b.moodle_course_id,
            b.name, b.description, b.cached_image_path
       from badge_issued bi
       join badges b on b.moodle_badge_id = bi.moodle_badge_id
      where bi.moodle_user_id = any($1::int[])
        and (b.moodle_course_id = $2::int or b.moodle_course_id is null)
      order by b.name asc, b.moodle_badge_id asc`,
    [users.map((user) => user.id), course.id],
  );

  const byUser = new Map<number, Badge[]>();
  for (const user of users) byUser.set(user.id, []);
  for (const row of badgeRows) {
    const list = byUser.get(row.moodle_user_id);
    if (list !== undefined) list.push(toBadge(row));
  }

  // Users with no badges are kept: the card renders an empty state.
  const cards = users.map((user) => ({
    user,
    badges: byUser.get(user.id) ?? [],
    percent: percentByUser.get(user.id) ?? null,
  }));
  sortCards(cards, config.sortBy, config.sortDir);

  return { type, users: cards };
}

// ---------------------------------------------------------------------------
// course_overview
// ---------------------------------------------------------------------------

async function courseOverview(
  config: WidgetConfig['course_overview'],
): Promise<WidgetData | WidgetDataError> {
  if (config.courseId === null) return fail('No course selected for this widget.');
  const course = await findCourse(config.courseId);
  if (course === null) return fail(COURSE_GONE);

  // The average deliberately ignores untracked rows instead of reading them as 0%.
  const { rows } = await sql<OverviewRow>(
    `select count(*)::int as enrolled_count,
            avg(cs.percent_complete) filter (where cs.percent_complete is not null)
              as average_percent,
            max(cs.activities_total) filter (where cs.percent_complete is not null)
              as tracked_activity_count
       from enrollments e
       left join completion_snapshot cs
         on cs.moodle_course_id = e.moodle_course_id
        and cs.moodle_user_id = e.moodle_user_id
      where e.moodle_course_id = $1
        and ${studentFilter('$2')}
        and ${excludeFilter('$3')}`,
    [course.id, config.includeStaff, config.excludeUserIds],
  );

  const row = rows[0];
  const average =
    row !== undefined && row.average_percent !== null
      ? Math.round(row.average_percent * 100) / 100
      : null;

  return {
    type: 'course_overview',
    course,
    enrolledCount: row === undefined ? 0 : row.enrolled_count,
    averagePercent: average,
    trackedActivityCount: row === undefined ? 0 : (row.tracked_activity_count ?? 0),
  };
}

// ---------------------------------------------------------------------------
// leaderboard
// ---------------------------------------------------------------------------

async function leaderboard(
  config: WidgetConfig['leaderboard'],
): Promise<WidgetData | WidgetDataError> {
  let scopedCourseId: number | null = null;
  if (config.scope === 'course') {
    if (config.courseId === null) return fail('No course selected for this widget.');
    const course = await findCourse(config.courseId);
    if (course === null) return fail(COURSE_GONE);
    scopedCourseId = course.id;
  }

  // Candidates are everyone enrolled in scope; the badge count is scoped to the
  // same course (plus site-wide badges) when a course is selected.
  const { rows } = await sql<LeaderboardRow>(
    `select u.moodle_user_id, u.fullname, u.email,
            (select count(*)
               from badge_issued bi
               join badges b on b.moodle_badge_id = bi.moodle_badge_id
              where bi.moodle_user_id = u.moodle_user_id
                and ($2::int is null
                     or b.moodle_course_id = $2::int
                     or b.moodle_course_id is null))::int as badge_count
       from moodle_users u
      where exists (
        select 1
          from enrollments e
         where e.moodle_user_id = u.moodle_user_id
           and ($2::int is null or e.moodle_course_id = $2::int)
           and ${studentFilter('$1')}
           and ${excludeFilter('$3')}
      )
      order by badge_count ${config.sortDir === 'asc' ? 'asc' : 'desc'},
               u.fullname asc, u.moodle_user_id asc`,
    [config.includeStaff, scopedCourseId, config.excludeUserIds],
  );

  const all = rows.map((row) => ({ user: toUser(row), badgeCount: row.badge_count }));
  const withBadges = all.filter((entry) => entry.badgeCount > 0);
  // Zero-badge users pad the board only when there aren't enough badge holders
  // to fill it — otherwise a fresh install shows an empty widget.
  const ranked = withBadges.length >= config.limit ? withBadges : all;

  return { type: 'leaderboard', entries: ranked.slice(0, config.limit) };
}

// ---------------------------------------------------------------------------
// user_list
// ---------------------------------------------------------------------------

async function userList(config: WidgetConfig['user_list']): Promise<WidgetData | WidgetDataError> {
  if (config.userId === null) return fail('No student selected for this widget.');
  const user = await findUser(config.userId);
  if (user === null) return fail(USER_GONE);

  let scopedCourseId: number | null = null;
  if (config.scope === 'course') {
    if (config.courseId === null) return fail('No course selected for this widget.');
    const course = await findCourse(config.courseId);
    if (course === null) return fail(COURSE_GONE);
    scopedCourseId = course.id;
  }

  const { rows: badgeRows } = await sql<BadgeRow>(
    `select b.moodle_badge_id, b.moodle_course_id, b.name, b.description, b.cached_image_path
       from badge_issued bi
       join badges b on b.moodle_badge_id = bi.moodle_badge_id
      where bi.moodle_user_id = $1
      order by b.name asc, b.moodle_badge_id asc`,
    [user.id],
  );

  // Only courses the user is actually enrolled in. An explicitly selected course
  // shows even if hidden; the "all" scope sticks to visible courses.
  const { rows: courseRows } = await sql<UserCourseRow>(
    `select c.moodle_course_id, c.shortname, c.fullname, c.visible,
            cs.activities_total, cs.activities_completed, cs.percent_complete
       from enrollments e
       join courses c on c.moodle_course_id = e.moodle_course_id
       left join completion_snapshot cs
         on cs.moodle_course_id = c.moodle_course_id
        and cs.moodle_user_id = e.moodle_user_id
      where e.moodle_user_id = $1
        and ($2::int is null or c.moodle_course_id = $2::int)
        and (c.visible = true or c.moodle_course_id = $2::int)
      order by c.fullname asc, c.moodle_course_id asc`,
    [user.id, scopedCourseId],
  );

  const completion = courseRows.map((row) => ({
    course: toCourse(row),
    entry: {
      courseId: row.moodle_course_id,
      activitiesTotal: row.activities_total ?? 0,
      activitiesCompleted: row.activities_completed ?? 0,
      percent: row.percent_complete,
    },
  }));

  // Course name comes back ordered from SQL; percent needs the same untracked-last
  // rule the other widgets use, so both directions are applied here.
  const dir = config.sortDir === 'desc' ? -1 : 1;
  completion.sort((a, b) => {
    const byName = a.course.fullname.localeCompare(b.course.fullname);
    if (config.sortBy === 'course') return dir * (byName !== 0 ? byName : a.course.id - b.course.id);
    if (a.entry.percent === null && b.entry.percent === null) return byName;
    if (a.entry.percent === null) return 1;
    if (b.entry.percent === null) return -1;
    return dir * (a.entry.percent - b.entry.percent) || byName;
  });

  return { type: 'user_list', user, badges: badgeRows.map(toBadge), completion };
}

// ---------------------------------------------------------------------------
// progress_chart — the only widget that reads metric_history instead of the
// live snapshot.
// ---------------------------------------------------------------------------

type HistoryRow = {
  moodle_user_id: number;
  recorded_at: Date;
  badge_count: number;
  percent_complete: number | null;
};

const WINDOW_MS: Record<Exclude<ChartWindow, 'auto' | 'all'>, number> = {
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/**
 * Turns a bag of dated events into a cumulative series.
 *
 * `key` buckets an event (a course id for completion, a constant for badges) and
 * `valueOf` reads the current bucket counts as the plotted number, which is what lets
 * one fold serve both "count them all up" and "average the per-course percentages".
 *
 * Exported for the unit test — the SQL either side of it needs a live Postgres.
 */
export function foldEvents(
  events: readonly { at: Date | null; key: number }[],
  valueOf: (counts: ReadonlyMap<number, number>) => number,
  from: Date,
  to: Date,
): { t: string; v: number }[] {
  const counts = new Map<number, number>();
  const bump = (key: number): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  // An undated event — a badge Moodle has no issue date for, a completion restored from
  // a course backup — happened at an unknown time before the chart starts, so it belongs
  // in the opening value rather than being dropped or dated to now.
  const dated: { at: Date; key: number }[] = [];
  for (const event of events) {
    if (event.at === null) bump(event.key);
    else dated.push({ at: event.at, key: event.key });
  }
  dated.sort((a, b) => a.at.getTime() - b.at.getTime());

  const points = [{ t: from.toISOString(), v: valueOf(counts) }];
  for (let i = 0; i < dated.length; i += 1) {
    const event = dated[i];
    if (event === undefined) continue;
    bump(event.key);
    // Everything completed in the same second is one step, not several stacked points.
    if (dated[i + 1]?.at.getTime() === event.at.getTime()) continue;
    points.push({ t: event.at.toISOString(), v: valueOf(counts) });
  }
  // Carry the final value to the right edge, so a student who earned nothing this month
  // still has a line running to today rather than stopping mid-chart.
  points.push({ t: to.toISOString(), v: valueOf(counts) });
  return points;
}

/** Single bucket: badges are just counted, whatever course they came from. */
const ONE_BUCKET = 0;

/** Newest value first: the legend reads as the standings. Nobody-yet sorts last. */
function sortByLatest(series: { user: MoodleUser; points: { t: string; v: number }[] }[]): void {
  const latest = (entry: (typeof series)[number]): number =>
    entry.points[entry.points.length - 1]?.v ?? -1;
  series.sort((a, b) => latest(b) - latest(a) || a.user.fullname.localeCompare(b.user.fullname));
}

/**
 * Rebuilds every user's series from Moodle's own timestamps rather than from Moodify's
 * samples, which is what makes "all time" reach back to before Moodify was installed.
 *
 * The one approximation: a past percentage is computed against *today's* number of
 * completion-tracked activities. Moodle does not report when an activity was added to a
 * course, so if the teacher added activities later, early percentages read a little
 * lower than they appeared at the time. Progress toward the course as it stands now is
 * the more useful reading for a leaderboard anyway.
 */
async function allTimeSeries(
  config: WidgetConfig['progress_chart'],
  userIds: readonly number[],
  scopedCourseId: number | null,
  now: Date,
): Promise<{ from: Date; points: Map<number, { t: string; v: number }[]> }> {
  type EventRow = { moodle_user_id: number; moodle_course_id: number; at: Date | null };

  const events = new Map<number, { at: Date | null; key: number }[]>();
  const push = (userId: number, event: { at: Date | null; key: number }): void => {
    const list = events.get(userId);
    if (list === undefined) events.set(userId, [event]);
    else list.push(event);
  };

  // Tracked-activity counts per (user, course). Only courses with tracked completion
  // appear, so they are exactly the courses that belong in the average.
  const totals = new Map<number, Map<number, number>>();

  if (config.metric === 'badges') {
    const { rows } = await sql<{ moodle_user_id: number; at: Date | null }>(
      `select bi.moodle_user_id, bi.date_issued as at
         from badge_issued bi
         join badges b on b.moodle_badge_id = bi.moodle_badge_id
        where bi.moodle_user_id = any($1::int[])
          and ($2::int is null or b.moodle_course_id = $2::int or b.moodle_course_id is null)`,
      [userIds, scopedCourseId],
    );
    for (const row of rows) push(row.moodle_user_id, { at: row.at, key: ONE_BUCKET });
  } else {
    const { rows: totalRows } = await sql<{
      moodle_user_id: number;
      moodle_course_id: number;
      activities_total: number;
    }>(
      `select moodle_user_id, moodle_course_id, activities_total
         from completion_snapshot
        where moodle_user_id = any($1::int[])
          and ($2::int is null or moodle_course_id = $2::int)
          and percent_complete is not null`,
      [userIds, scopedCourseId],
    );
    for (const row of totalRows) {
      if (row.activities_total <= 0) continue;
      const byCourse = totals.get(row.moodle_user_id) ?? new Map<number, number>();
      byCourse.set(row.moodle_course_id, row.activities_total);
      totals.set(row.moodle_user_id, byCourse);
    }

    const { rows } = await sql<EventRow>(
      `select moodle_user_id, moodle_course_id, completed_at as at
         from activity_completion
        where moodle_user_id = any($1::int[])
          and ($2::int is null or moodle_course_id = $2::int)`,
      [userIds, scopedCourseId],
    );
    for (const row of rows) {
      // An activity in a course that tracks nothing today cannot be scored against a
      // denominator, so it is left out rather than counted against zero.
      if (totals.get(row.moodle_user_id)?.has(row.moodle_course_id) !== true) continue;
      push(row.moodle_user_id, { at: row.at, key: row.moodle_course_id });
    }
  }

  // The axis opens at the oldest thing that ever happened, or a day back when nothing has.
  let earliest = Number.POSITIVE_INFINITY;
  for (const list of events.values()) {
    for (const event of list) {
      if (event.at !== null) earliest = Math.min(earliest, event.at.getTime());
    }
  }
  const from = new Date(
    Number.isFinite(earliest) ? earliest : now.getTime() - 24 * 60 * 60 * 1000,
  );

  const points = new Map<number, { t: string; v: number }[]>();
  for (const userId of userIds) {
    const list = events.get(userId) ?? [];
    if (config.metric === 'badges') {
      points.set(
        userId,
        foldEvents(list, (counts) => counts.get(ONE_BUCKET) ?? 0, from, now),
      );
      continue;
    }
    const byCourse = totals.get(userId);
    // No tracked course in scope means no percentage exists — same as `percent IS NULL`
    // everywhere else, and an empty series drops the student off the chart.
    if (byCourse === undefined || byCourse.size === 0) continue;
    points.set(
      userId,
      foldEvents(
        list,
        (counts) => {
          let sum = 0;
          for (const [courseId, total] of byCourse) {
            sum += Math.min(counts.get(courseId) ?? 0, total) / total;
          }
          // The unweighted mean of the per-course percentages, matching what
          // completion_snapshot averaging does everywhere else in this file.
          return Math.round((sum / byCourse.size) * 10000) / 100;
        },
        from,
        now,
      ),
    );
  }

  return { from, points };
}

/** Matches HISTORY_RETENTION_DAYS in sync.ts — nothing older than this exists. */
const MAX_WINDOW_MS = WINDOW_MS['7d'];

async function progressChart(
  config: WidgetConfig['progress_chart'],
  avatarBase: string,
): Promise<WidgetData | WidgetDataError> {
  let scopedCourseId: number | null = null;
  if (config.scope === 'course') {
    if (config.courseId === null) return fail('No course selected for this widget.');
    const course = await findCourse(config.courseId);
    if (course === null) return fail(COURSE_GONE);
    scopedCourseId = course.id;
  }

  const now = new Date();
  // 'auto' grows with the data — an install two hours old plots two hours — but can
  // never reach past what sync.ts still retains. 'all' ignores this entirely and works
  // out its own start from the oldest event Moodle knows about.
  const from = new Date(
    now.getTime() -
      (config.window === 'auto' || config.window === 'all'
        ? MAX_WINDOW_MS
        : WINDOW_MS[config.window]),
  );

  const { rows: userRows } = await sql<UserRow>(
    `select distinct u.moodle_user_id, u.fullname, u.email, u.avatar_image_path
       from enrollments e
       join moodle_users u on u.moodle_user_id = e.moodle_user_id
      where ($1::int is null or e.moodle_course_id = $1::int)
        and ${studentFilter('$2')}
        and ${excludeFilter('$3')}
        and ($4::int[] = '{}'::int[] or u.moodle_user_id = any($4::int[]))
      order by u.fullname asc, u.moodle_user_id asc`,
    [scopedCourseId, config.includeStaff, config.excludeUserIds, config.userIds],
  );
  if (userRows.length === 0) {
    return {
      type: 'progress_chart',
      metric: config.metric,
      from: from.toISOString(),
      to: now.toISOString(),
      step: config.window === 'all',
      series: [],
    };
  }

  if (config.window === 'all') {
    const all = await allTimeSeries(config, userRows.map((row) => row.moodle_user_id), scopedCourseId, now);
    const series = userRows
      .map((row) => ({
        user: toUserWithAvatar(row, avatarBase),
        points: all.points.get(row.moodle_user_id) ?? [],
      }))
      .filter((entry) => entry.points.length > 0);
    sortByLatest(series);
    return {
      type: 'progress_chart',
      metric: config.metric,
      from: all.from.toISOString(),
      to: now.toISOString(),
      step: true,
      series: config.userIds.length > 0 ? series : series.slice(0, config.limit),
    };
  }

  const { rows: history } = await sql<HistoryRow>(
    `select moodle_user_id, recorded_at, badge_count, percent_complete
       from metric_history
      where moodle_user_id = any($1::int[])
        and moodle_course_id is not distinct from $2::int
        and recorded_at >= $3
      order by recorded_at asc`,
    [userRows.map((row) => row.moodle_user_id), scopedCourseId, from],
  );

  const points = new Map<number, { t: string; v: number }[]>();
  for (const row of history) {
    // An untracked completion is not a zero, so it is left out of the line entirely.
    const value = config.metric === 'badges' ? row.badge_count : row.percent_complete;
    if (value === null) continue;
    const list = points.get(row.moodle_user_id);
    const point = { t: row.recorded_at.toISOString(), v: Number(value) };
    if (list === undefined) points.set(row.moodle_user_id, [point]);
    else list.push(point);
  }

  const series = userRows.map((row) => ({
    user: toUserWithAvatar(row, avatarBase),
    points: points.get(row.moodle_user_id) ?? [],
  }));
  sortByLatest(series);

  // An explicit pick of students is honoured in full; `limit` only trims "everyone".
  const trimmed = config.userIds.length > 0 ? series : series.slice(0, config.limit);

  // By default the axis starts where the data does, so a two-hour-old install is not
  // 95% blank. With fullWindow the chosen span is drawn in full and the lines advance
  // across it — which is the point of picking "last 7 days" for a wall display.
  const earliest = history[0]?.recorded_at;
  const start = !config.fullWindow && earliest !== undefined && earliest > from ? earliest : from;
  return {
    type: 'progress_chart',
    metric: config.metric,
    from: start.toISOString(),
    to: now.toISOString(),
    // Clock-driven samples, so the line may slope between them.
    step: false,
    series: trimmed,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function configMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'This widget is not configured correctly.';
  const path = issue.path.join('.');
  return path === ''
    ? `This widget is not configured correctly: ${issue.message}`
    : `This widget is not configured correctly: ${path} — ${issue.message}`;
}

/**
 * Resolves one widget's data. Returns a WidgetDataError (never throws) for a bad
 * or stale config; genuine infrastructure failures still throw so the route can
 * answer with a 500.
 */
export async function resolveWidgetData(
  widget: {
    id: number;
    type: WidgetType;
    config: unknown;
  },
  /** Route prefix avatars are served from for this caller. See toUserWithAvatar. */
  avatarBase = '/api/user-image',
): Promise<WidgetData | WidgetDataError> {
  try {
    switch (widget.type) {
      case 'completion_table':
        return await completionTable(parseWidgetConfig('completion_table', widget.config));
      case 'badge_cards':
        return await badgeCards(parseWidgetConfig('badge_cards', widget.config));
      case 'badge_list':
        return await badgeCards(parseWidgetConfig('badge_list', widget.config), 'badge_list');
      case 'course_overview':
        return await courseOverview(parseWidgetConfig('course_overview', widget.config));
      case 'leaderboard':
        return await leaderboard(parseWidgetConfig('leaderboard', widget.config));
      case 'user_list':
        return await userList(parseWidgetConfig('user_list', widget.config));
      case 'progress_chart':
        return await progressChart(parseWidgetConfig('progress_chart', widget.config), avatarBase);
      default:
        return fail(`Unknown widget type "${String(widget.type)}".`);
    }
  } catch (err) {
    if (err instanceof ZodError) return fail(configMessage(err));
    throw err;
  }
}
