import { ZodError } from 'zod';
import {
  deadlineDueAt,
  parseWidgetConfig,
  sectionMatches,
  type Badge,
  type ChartWindow,
  type CompletionEntry,
  type CompletionRingsEntry,
  type Course,
  type DeadlineRule,
  type MoodleUser,
  type RingLegendItem,
  type RingSegment,
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
  custom_description: string | null;
  cached_image_path: string | null;
};

type UserBadgeRow = BadgeRow & { moodle_user_id: number };

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
/**
 * Sorts `badges` in place into the widget's configured order.
 *
 * Anything not in `order` keeps the position it already had and follows the ordered
 * badges, so a badge awarded for the first time after the order was saved appears at the
 * end rather than disappearing.
 */
export function orderBadges(badges: Badge[], order: readonly number[]): Badge[] {
  const rank = new Map(order.map((badgeId, index) => [badgeId, index]));
  // MAX_SAFE_INTEGER rather than Infinity: two unlisted badges would subtract to NaN,
  // which makes the comparator meaningless rather than merely equal.
  const at = (badge: Badge) => rank.get(badge.id) ?? Number.MAX_SAFE_INTEGER;
  return badges.sort((a, b) => at(a) - at(b));
}

function toBadge(row: BadgeRow): Badge {
  return {
    id: row.moodle_badge_id,
    name: row.name,
    description: row.description,
    customDescription: row.custom_description,
    courseId: row.moodle_course_id,
    // Always the proxy, never the cached path directly: it redirects to the cached
    // file when there is one and downloads it on the spot when there is not, so a
    // badge whose image failed during sync heals on first view.
    imageUrl: `/api/badge-image/${row.moodle_badge_id}`,
  };
}

function emptyEntry(courseId: number): CompletionEntry {
  return { courseId, activitiesTotal: 0, activitiesCompleted: 0, percent: null, overdue: 0 };
}

// ---------------------------------------------------------------------------
// Deadlines
//
// A deadline is a yearly recurrence rule attached to (activity, cohort). Whether it has
// passed is decided in TypeScript rather than SQL: "the first Monday in September" is
// two lines of Date arithmetic and an unreadable pile of generate_series, and the same
// function then serves the Settings page, so there is exactly one definition of when a
// deadline falls.
// ---------------------------------------------------------------------------

type DeadlineRow = {
  moodle_course_id: number;
  moodle_user_id: number;
  cmid: number;
  name: string;
  section: string;
  due_date: Date | null;
  month: number | null;
  weekday: number | null;
  nth: number | null;
  created_at: Date;
  completed: boolean;
};

export interface DeadlineFacts {
  /** Deadlines applying to this (course, user) at all. 0 → no target can be computed. */
  total: number;
  /** Of those, the ones already past their date. */
  due: number;
  /** Of the due ones, the ones still not completed. */
  overdue: number;
  /** Not due yet and already done — the only honest reading of "ahead". */
  earlyDone: number;
  /** Names of the overdue activities, for the list on a ring tile. */
  overdueNames: string[];
}

/**
 * Folds raw (deadline × cohort member) rows into one set of counters per (course, user).
 *
 * A person can reach the same activity through several cohorts. The earliest deadline in
 * force wins: being in two groups cannot buy you an extension.
 */
export function foldDeadlines(
  rows: readonly {
    /**
     * What the deadline counts towards: the course id for a whole-course segment, or
     * `courseId:section` when the ring splits that course up. Opaque to the fold.
     */
    segment: string;
    userId: number;
    cmid: number;
    name: string;
    rule: DeadlineRule;
    createdAt: Date;
    completed: boolean;
  }[],
  now: Date,
): Map<string, DeadlineFacts> {
  const perActivity = new Map<
    string,
    { pair: string; name: string; due: Date | null; completed: boolean }
  >();
  for (const row of rows) {
    const key = `${row.segment}:${row.userId}:${row.cmid}`;
    const due = deadlineDueAt(row.rule, row.createdAt, now);
    const seen = perActivity.get(key);
    if (seen === undefined) {
      perActivity.set(key, {
        pair: `${row.segment}:${row.userId}`,
        name: row.name,
        due,
        completed: row.completed,
      });
    } else if (due !== null && (seen.due === null || due < seen.due)) {
      seen.due = due;
    }
  }

  const out = new Map<string, DeadlineFacts>();
  for (const item of perActivity.values()) {
    const facts =
      out.get(item.pair) ?? { total: 0, due: 0, overdue: 0, earlyDone: 0, overdueNames: [] };
    facts.total += 1;
    if (item.due === null) {
      if (item.completed) facts.earlyDone += 1;
    } else {
      facts.due += 1;
      if (!item.completed) {
        facts.overdue += 1;
        facts.overdueNames.push(item.name);
      }
    }
    out.set(item.pair, facts);
  }
  for (const facts of out.values()) facts.overdueNames.sort((a, b) => a.localeCompare(b));
  return out;
}

const NO_DEADLINES: DeadlineFacts = {
  total: 0,
  due: 0,
  overdue: 0,
  earlyDone: 0,
  overdueNames: [],
};

/**
 * Every deadline fact for the given courses (null = all), keyed `segment:userId` — which
 * is `courseId:userId` unless the caller says otherwise.
 *
 * `segmentsOf` exists for the rings widget, where a course can be cut into one segment per
 * section: an activity's deadline then has to count towards its own section rather than
 * the course as a whole, and only the section knows which that is. It returns a list
 * because a parent section and one of its subsections can both be selected, in which case
 * an activity inside the subsection genuinely belongs to both bars — and it can return
 * nothing, because an activity in a section nobody picked belongs to no bar at all.
 *
 * ponytail: reads the whole join and folds in memory. At the documented scale (<50
 * users, <20 courses, a handful of deadlines) that is a few hundred rows; push the
 * aggregation into SQL if a deployment ever outgrows that.
 */
async function loadDeadlineFacts(
  courseIds: number[] | null,
  segmentsOf: (courseId: number, section: string) => string[] = (courseId) => [String(courseId)],
): Promise<Map<string, DeadlineFacts>> {
  // Driven off enrollments, not cohort membership: a task is only somebody's problem if
  // they are actually in the course. A cohort — when the task names one — narrows that
  // further; a task with no cohort applies to everyone enrolled.
  const { rows } = await sql<DeadlineRow>(
    `select d.moodle_course_id, e.moodle_user_id, d.cmid, ca.name, ca.section,
            d.due_date, d.month, d.weekday, d.nth, d.created_at,
            (ac.cmid is not null) as completed
       from deadlines d
       join enrollments e on e.moodle_course_id = d.moodle_course_id
       join course_activities ca
         on ca.moodle_course_id = d.moodle_course_id and ca.cmid = d.cmid
       left join activity_completion ac
         on ac.moodle_course_id = d.moodle_course_id
        and ac.moodle_user_id   = e.moodle_user_id
        and ac.cmid             = d.cmid
      where ($1::int[] is null or d.moodle_course_id = any($1::int[]))
        and (d.moodle_cohort_id is null
             or exists (select 1 from cohort_members cm
                         where cm.moodle_cohort_id = d.moodle_cohort_id
                           and cm.moodle_user_id = e.moodle_user_id))`,
    [courseIds],
  );

  return foldDeadlines(
    rows.flatMap((row) => {
      const rule = {
        date:
          row.due_date === null
            ? null
            : `${row.due_date.getFullYear()}-${`${row.due_date.getMonth() + 1}`.padStart(2, '0')}-${`${row.due_date.getDate()}`.padStart(2, '0')}`,
        month: row.month,
        weekday: row.weekday,
        nth: row.nth,
      };
      return segmentsOf(row.moodle_course_id, row.section).map((segment) => ({
        segment,
        userId: row.moodle_user_id,
        cmid: row.cmid,
        name: row.name,
        rule,
        createdAt: row.created_at,
        completed: row.completed,
      }));
    }),
    new Date(),
  );
}

/**
 * Where the fill would be if this person had done exactly the work whose date has come
 * round: what they have completed, plus what they have missed, minus what they finished
 * before it was due. The gap between the fill and this mark is the whole story, and it
 * reads in both directions — the mark ahead of the fill is work owed, the mark behind it
 * is work done early.
 *
 * The first version divided the *due deadlines* by the course's activity count, so one
 * task among forty activities put the mark at 2.5% — at the very start of the segment,
 * behind the fill, for someone who had missed it. Completion and deadline compliance are
 * different axes; projecting one onto the other produced a number that meant nothing.
 *
 * Drawn even when it coincides with the fill. It used to be suppressed there, on the
 * grounds that a mark on the end of the fill says nothing — but that also hid it for
 * everybody who had not started yet and had nothing due, so the one group most worth
 * showing a plan to was the one group that never saw one.
 *
 * Null when there is no plan to draw: a segment with no tasks set on it at all, or one
 * tracking no completable activities. A mark for a course nobody has given a deadline is
 * not a schedule, it is a line at whatever the fill happens to be.
 */
/**
 * The schedule bar's reach per segment, read as one plan running through the segments in
 * the widget's configured order rather than as one plan per course.
 *
 * The frontier is the last segment holding a deadline whose date has passed. Everything
 * before it is work that should already be finished, so it fills; the frontier gets its
 * own target; anything after it has nothing due yet and draws no bar at all. That is the
 * whole point of ordering the courses: a deadline in course three says courses one and
 * two were meant to be behind you, whatever their own deadlines say — or whether they
 * carry any.
 *
 * `due` counts deadlines that have come round, not ones that were missed. A course
 * finished on time is still a course whose dates have passed.
 */
export function cumulativeTargets(
  targets: readonly (number | null)[],
  due: readonly number[],
): (number | null)[] {
  const frontier = due.reduce((last, count, index) => (count > 0 ? index : last), -1);
  return targets.map((target, index) =>
    index < frontier ? 100 : index === frontier ? target : null,
  );
}

export function targetPercent(
  facts: DeadlineFacts,
  activitiesCompleted: number,
  activitiesTotal: number,
): number | null {
  if (activitiesTotal === 0 || facts.total === 0) return null;
  const shift = facts.overdue - facts.earlyDone;
  const scheduled = Math.min(Math.max(activitiesCompleted + shift, 0), activitiesTotal);
  return Math.round((scheduled / activitiesTotal) * 10000) / 100;
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

  const deadlines = await loadDeadlineFacts(courseIds);

  const byPair = new Map<string, CompletionEntry>();
  for (const row of cellRows) {
    const key = `${row.moodle_course_id}:${row.moodle_user_id}`;
    byPair.set(key, {
      courseId: row.moodle_course_id,
      activitiesTotal: row.activities_total,
      activitiesCompleted: row.activities_completed,
      percent: row.percent_complete,
      overdue: (deadlines.get(key) ?? NO_DEADLINES).overdue,
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

type BadgeCard = { user: MoodleUser; badges: Badge[]; percent: number | null; overdue: number };

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
      `select b.moodle_badge_id, b.moodle_course_id, b.name, b.description, b.custom_description, b.cached_image_path
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
    // Scope 'user' spans every course, so the bar goes red if anything anywhere is overdue.
    const deadlines = await loadDeadlineFacts(null);
    let overdue = 0;
    for (const [key, facts] of deadlines) {
      if (key.endsWith(`:${user.id}`)) overdue += facts.overdue;
    }
    return {
      type,
      users: [{ user, badges: rows.map(toBadge), percent: pct[0]?.percent ?? null, overdue }],
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
            b.name, b.description, b.custom_description, b.cached_image_path
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

  const deadlines = await loadDeadlineFacts([course.id]);

  // Users with no badges are kept: the card renders an empty state.
  const cards = users.map((user) => ({
    user,
    badges: byUser.get(user.id) ?? [],
    percent: percentByUser.get(user.id) ?? null,
    overdue: (deadlines.get(`${course.id}:${user.id}`) ?? NO_DEADLINES).overdue,
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
    `select b.moodle_badge_id, b.moodle_course_id, b.name, b.description, b.custom_description, b.cached_image_path
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

  const deadlines = await loadDeadlineFacts(null);
  const completion = courseRows.map((row) => ({
    course: toCourse(row),
    entry: {
      courseId: row.moodle_course_id,
      activitiesTotal: row.activities_total ?? 0,
      activitiesCompleted: row.activities_completed ?? 0,
      percent: row.percent_complete,
      overdue: (deadlines.get(`${row.moodle_course_id}:${user.id}`) ?? NO_DEADLINES).overdue,
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
// completion_rings — one ring per person, one segment per course.
// ---------------------------------------------------------------------------

/**
 * People with nothing tracked sort last, and stay last when the direction flips — kept
 * apart from the completion comparison for exactly that reason: negating a comparator
 * that had already folded the nulls in would send them to the top on an ascending sort.
 * 0 when both are tracked, leaving the decision to the caller.
 */
function untrackedLast(a: CompletionRingsEntry, b: CompletionRingsEntry): number {
  if (a.percent === null && b.percent === null) return 0;
  if (a.percent === null) return 1;
  if (b.percent === null) return -1;
  return 0;
}

/** Completion, highest first. Only meaningful once untrackedLast has passed. */
function byRingPercent(a: CompletionRingsEntry, b: CompletionRingsEntry): number {
  return (b.percent ?? 0) - (a.percent ?? 0);
}

/**
 * How the tiles are ordered: the chosen key first, then completion, then the name.
 *
 * Completion is the tie-break under every other key rather than the name, because the
 * groups the other keys produce are wide — "four courses" or "no overdue tasks" can be
 * most of a class — and inside such a group the only thing anyone reads for is who is
 * furthest along. It stays highest-first regardless of sortDir: flipping it would order
 * the groups descending while their contents ascend, which reads as a bug rather than a
 * setting. The name is the last resort, so the order is total and a reload cannot
 * reshuffle two people who match on everything.
 */
export function ringComparator(
  sortBy: WidgetConfig['completion_rings']['sortBy'],
  sortDir: 'asc' | 'desc',
): (a: CompletionRingsEntry, b: CompletionRingsEntry) => number {
  const dir = sortDir === 'desc' ? -1 : 1;
  return (a, b) => {
    const byName = a.user.fullname.localeCompare(b.user.fullname) || a.user.id - b.user.id;
    if (sortBy === 'name') return dir * byName;
    if (sortBy === 'percent') {
      return untrackedLast(a, b) || -dir * byRingPercent(a, b) || byName;
    }
    const byCompletion = untrackedLast(a, b) || byRingPercent(a, b);
    if (sortBy === 'overdue') return dir * (a.overdue - b.overdue) || byCompletion || byName;
    // Segment count, i.e. how much of the ring this person's enrolments actually fill.
    return dir * (a.segments.length - b.segments.length) || byCompletion || byName;
  };
}

async function completionRings(
  config: WidgetConfig['completion_rings'],
  avatarBase: string,
): Promise<WidgetData | WidgetDataError> {
  // No selection = every visible course, as with `scope: all` elsewhere. Each person's
  // ring is filtered to their own enrolments below, so "all courses" is not the mess it
  // would be if everyone got every segment.
  const all = config.courseIds.length === 0;
  const { rows: courseRows } = await sql<CourseRow>(
    `select moodle_course_id, shortname, fullname, visible
       from courses
      where ($2::boolean and visible = true) or moodle_course_id = any($1::int[])
      order by fullname asc`,
    [config.courseIds, all],
  );
  const byId = new Map(courseRows.map((row) => [row.moodle_course_id, toCourse(row)]));
  // Configured order is the segment order and the legend order, so the colours stay put
  // when a course is added; SQL order would reshuffle the whole ring.
  const courses = all
    ? courseRows.map(toCourse)
    : config.courseIds
        .map((id) => byId.get(id))
        .filter((course): course is Course => course !== undefined);
  if (courses.length === 0) {
    return fail(
      all
        ? 'No visible courses have been synced from Moodle yet.'
        : 'The selected courses are no longer in Moodle. Pick others in the widget settings.',
    );
  }
  const courseIds = courses.map((course) => course.id);

  // A course either contributes one whole-course segment or one segment per selected
  // section — never both, and never a leftover for the sections not picked.
  const splits = new Map(
    Object.entries(config.splits)
      .map(([id, sections]) => [Number(id), sections] as const)
      .filter(([id, sections]) => Number.isFinite(id) && sections.length > 0),
  );
  // A custom label only renames the legend; the title keeps naming the real course and
  // section, so a segment renamed to something short stays traceable to what it is.
  const named = (key: string, fallback: string) => {
    const custom = config.labels[key];
    return custom === undefined || custom === '' ? fallback : custom;
  };
  const plan: { courseId: number; section: string | null; item: RingLegendItem }[] = [];
  for (const course of courses) {
    const sections = splits.get(course.id);
    if (sections === undefined) {
      plan.push({
        courseId: course.id,
        section: null,
        item: {
          key: `${course.id}`,
          label: named(`${course.id}`, course.shortname),
          title: course.fullname,
        },
      });
      continue;
    }
    for (const split of sections) {
      const key = `${course.id}:${split.section}`;
      plan.push({
        courseId: course.id,
        section: split.section,
        item: {
          key,
          // split.label is the pre-`labels` storage, read only so labels saved before the
          // two merged still show up. Nothing writes it any more.
          label: named(key, split.label === '' ? split.section : split.label),
          title: `${course.fullname} — ${split.section}`,
        },
      });
    }
  }
  const legend = plan.map((entry) => entry.item);

  const { rows: userRows } = await sql<UserRow>(
    `select distinct u.moodle_user_id, u.fullname, u.email, u.avatar_image_path
       from enrollments e
       join moodle_users u on u.moodle_user_id = e.moodle_user_id
      where e.moodle_course_id = any($1::int[])
        and ${studentFilter('$2')}
        and ${excludeFilter('$3')}
        and (cardinality($4::int[]) = 0
             or exists (select 1 from cohort_members m
                         where m.moodle_user_id = u.moodle_user_id
                           and m.moodle_cohort_id = any($4::int[])))
      order by u.fullname asc, u.moodle_user_id asc`,
    [courseIds, config.includeStaff, config.excludeUserIds, config.cohortIds],
  );
  if (userRows.length === 0) return { type: 'completion_rings', legend, entries: [] };
  const userIds = userRows.map((row) => row.moodle_user_id);

  // Which of the selected courses each person is actually in. A ring must only show
  // courses its owner can open — three empty segments for courses they were never
  // enrolled in read as "has done nothing", which is the opposite of the truth.
  const { rows: enrolled } = await sql<{ moodle_course_id: number; moodle_user_id: number }>(
    // Aliased `e` because studentFilter emits `e.roles` — without it Postgres rejects the
    // whole query with "missing FROM-clause entry for table e" and the widget 500s.
    `select e.moodle_course_id, e.moodle_user_id
       from enrollments e
      where e.moodle_course_id = any($1::int[]) and e.moodle_user_id = any($2::int[])
        and ${studentFilter('$3')}`,
    [courseIds, userIds, config.includeStaff],
  );
  const isEnrolled = new Set(enrolled.map((row) => `${row.moodle_course_id}:${row.moodle_user_id}`));

  const { rows: cellRows } = await sql<CellRow>(
    `select moodle_course_id, moodle_user_id, activities_total, activities_completed, percent_complete
       from completion_snapshot
      where moodle_course_id = any($1::int[])
        and moodle_user_id = any($2::int[])`,
    [courseIds, userIds],
  );
  const cells = new Map(cellRows.map((row) => [`${row.moodle_course_id}:${row.moodle_user_id}`, row]));

  // Per-section counts, only for the courses that are actually split.
  //
  // ponytail: activity_completion is only rewritten on a full discovery, so a section bar
  // lags the whole-course bar next to it by up to one full-sync interval. Move the write
  // into refreshPair if that ever reads as a bug rather than a delay.
  const splitCourseIds = [...new Set(plan.filter((e) => e.section !== null).map((e) => e.courseId))];
  const sectionCells = new Map<string, { total: number; completed: number }>();
  if (splitCourseIds.length > 0) {
    const { rows } = await sql<{
      moodle_course_id: number;
      section: string;
      moodle_user_id: number;
      total: number;
      completed: number;
    }>(
      // No studentFilter: userIds is already the filtered set, so the join is a plain
      // membership test and needs no roles column.
      `select ca.moodle_course_id, ca.section, e.moodle_user_id,
              count(*)::int as total, count(ac.cmid)::int as completed
         from course_activities ca
         join enrollments e on e.moodle_course_id = ca.moodle_course_id
         left join activity_completion ac
           on ac.moodle_course_id = ca.moodle_course_id
          and ac.cmid             = ca.cmid
          and ac.moodle_user_id   = e.moodle_user_id
        where ca.moodle_course_id = any($1::int[]) and e.moodle_user_id = any($2::int[])
        group by ca.moodle_course_id, ca.section, e.moodle_user_id`,
      [splitCourseIds, userIds],
    );
    // Folded by *chosen* section, not by the section the activity is filed under: picking
    // "Grundkurse" has to gather everything nested beneath it, which is the only way to
    // select a section that holds nothing but subsections and therefore owns no activities
    // of its own. A row lands in every chosen section it matches, so a parent and one of
    // its children can both be drawn.
    for (const row of rows) {
      for (const split of splits.get(row.moodle_course_id) ?? []) {
        if (!sectionMatches(row.section, split.section)) continue;
        const key = `${row.moodle_course_id}:${split.section}:${row.moodle_user_id}`;
        const seen = sectionCells.get(key) ?? { total: 0, completed: 0 };
        seen.total += row.total;
        seen.completed += row.completed;
        sectionCells.set(key, seen);
      }
    }
  }

  // A deadline counts towards the segment holding its activity, which for a split course
  // means its own section. An activity in a section nobody selected yields a key no
  // segment uses, so it is simply never read.
  const deadlines = await loadDeadlineFacts(courseIds, (courseId, section) => {
    const chosen = splits.get(courseId);
    if (chosen === undefined) return [`${courseId}`];
    return chosen
      .filter((split) => sectionMatches(section, split.section))
      .map((split) => `${courseId}:${split.section}`);
  });

  const badgesByUser = new Map<number, Badge[]>();
  if (config.showBadges) {
    const { rows: badgeRows } = await sql<UserBadgeRow>(
      `select bi.moodle_user_id, b.moodle_badge_id, b.moodle_course_id,
              b.name, b.description, b.custom_description, b.cached_image_path
         from badge_issued bi
         join badges b on b.moodle_badge_id = bi.moodle_badge_id
        where bi.moodle_user_id = any($1::int[])
          and (b.moodle_course_id = any($2::int[]) or b.moodle_course_id is null)
        order by b.name asc, b.moodle_badge_id asc`,
      [userIds, courseIds],
    );
    for (const row of badgeRows) {
      const list = badgesByUser.get(row.moodle_user_id) ?? [];
      list.push(toBadge(row));
      badgesByUser.set(row.moodle_user_id, list);
    }
    if (config.badgeOrder.length > 0) {
      for (const list of badgesByUser.values()) orderBadges(list, config.badgeOrder);
    }
  }

  const entries: CompletionRingsEntry[] = userRows.map((row) => {
    const userId = row.moodle_user_id;
    const segments: RingSegment[] = plan
      .filter((entry) => isEnrolled.has(`${entry.courseId}:${userId}`))
      .map(({ courseId, section, item }) => {
        // A section counts its own activities; a whole course reuses the snapshot the
        // poller already keeps, which is both fresher and the number every other widget
        // shows for that course.
        const cell = section === null ? cells.get(`${courseId}:${userId}`) : undefined;
        const part =
          section === null ? undefined : sectionCells.get(`${courseId}:${section}:${userId}`);
        const total = cell?.activities_total ?? part?.total ?? 0;
        const completed = cell?.activities_completed ?? part?.completed ?? 0;
        const percent =
          section === null
            ? cell?.percent_complete ?? null
            : total === 0
              ? null
              : Math.round((completed / total) * 10000) / 100;
        const facts = deadlines.get(`${item.key}:${userId}`) ?? NO_DEADLINES;
        return {
          ...item,
          percent,
          targetPercent: targetPercent(facts, completed, total),
          overdue: facts.overdue,
          overdueActivities: facts.overdueNames,
        };
      });

    // One plan across the ordered segments, not one per course — see cumulativeTargets.
    const reach = cumulativeTargets(
      segments.map((segment) => segment.targetPercent),
      segments.map((segment) => deadlines.get(`${segment.key}:${userId}`)?.due ?? 0),
    );
    segments.forEach((segment, index) => {
      segment.targetPercent = reach[index] ?? null;
    });

    const tracked = segments
      .map((segment) => segment.percent)
      .filter((percent): percent is number => percent !== null);

    return {
      user: toUserWithAvatar(row, avatarBase),
      segments,
      overdue: segments.reduce((sum, segment) => sum + segment.overdue, 0),
      earlyDone: segments.reduce(
        (sum, segment) => sum + (deadlines.get(`${segment.key}:${userId}`)?.earlyDone ?? 0),
        0,
      ),
      // Unweighted mean of the tracked courses, matching every other widget: a
      // 40-activity course does not count more than a 4-activity one.
      percent:
        tracked.length === 0
          ? null
          : Math.round((tracked.reduce((sum, value) => sum + value, 0) / tracked.length) * 100) / 100,
      badges: badgesByUser.get(userId) ?? [],
    };
  });

  entries.sort(ringComparator(config.sortBy, config.sortDir));

  return { type: 'completion_rings', legend, entries };
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
      case 'completion_rings':
        return await completionRings(
          parseWidgetConfig('completion_rings', widget.config),
          avatarBase,
        );
      default:
        return fail(`Unknown widget type "${String(widget.type)}".`);
    }
  } catch (err) {
    if (err instanceof ZodError) return fail(configMessage(err));
    throw err;
  }
}
