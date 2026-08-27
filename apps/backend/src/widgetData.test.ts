import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type {
  BadgeCardsData,
  CompletionRingsData,
  CompletionTableData,
  CourseOverviewData,
  LeaderboardData,
  MoodleUser,
  ProgressChartData,
  UserListData,
} from '@moodify/shared';
import { deadlineDueAt, deadlineNextDueAt, nthWeekdayOf } from '@moodify/shared';
import { anonymizeUsers, anonymizeWidgetData } from './anonymize.ts';
import { sectionMatches } from '@moodify/shared';
import { foldDeadlines, foldEvents, ringComparator, targetPercent } from './widgetData.ts';

/**
 * Pure unit tests for the public-route anonymisation rules. The SQL side of
 * widgetData.ts needs a live Postgres and is not covered here.
 */

function user(id: number, fullname: string): MoodleUser {
  return { id, fullname, email: `${fullname.toLowerCase()}@example.test` };
}

const course = { id: 5, shortname: 'C1', fullname: 'Course One', visible: true };

test('anonymizeUsers numbers by id ascending, not by input order', () => {
  const out = anonymizeUsers([user(30, 'Cara'), user(10, 'Ana'), user(20, 'Bo')]);
  assert.deepEqual(
    out.map((u) => u.fullname),
    ['Student 3', 'Student 1', 'Student 2'],
  );
});

test('anonymizeUsers preserves the caller ordering and strips emails', () => {
  const out = anonymizeUsers([user(30, 'Cara'), user(10, 'Ana'), user(20, 'Bo')]);
  assert.deepEqual(
    out.map((u) => u.id),
    [30, 10, 20],
  );
  assert.deepEqual(
    out.map((u) => u.email),
    [null, null, null],
  );
});

test('anonymizeUsers does not mutate its input', () => {
  const input = [user(2, 'Bo'), user(1, 'Ana')];
  anonymizeUsers(input);
  assert.deepEqual(
    input.map((u) => u.fullname),
    ['Bo', 'Ana'],
  );
  assert.deepEqual(
    input.map((u) => u.email),
    ['bo@example.test', 'ana@example.test'],
  );
});

test('anonymizeUsers gives one id one label even when it repeats', () => {
  const out = anonymizeUsers([user(9, 'Nia'), user(4, 'Ben'), user(9, 'Nia')]);
  assert.deepEqual(
    out.map((u) => u.fullname),
    ['Student 2', 'Student 1', 'Student 2'],
  );
});

test('completion_table rows are relabelled in place, cells untouched', () => {
  const data: CompletionTableData = {
    type: 'completion_table',
    courses: [course],
    rows: [
      {
        user: user(7, 'Zoe'),
        cells: [{ courseId: 5, activitiesTotal: 4, activitiesCompleted: 2, percent: 50, overdue: 0 }],
      },
      {
        user: user(3, 'Amir'),
        cells: [{ courseId: 5, activitiesTotal: 0, activitiesCompleted: 0, percent: null, overdue: 0 }],
      },
    ],
  };

  const anon = anonymizeWidgetData(data);
  if (anon.type !== 'completion_table') throw new Error('variant changed');

  assert.deepEqual(
    anon.rows.map((r) => r.user.fullname),
    ['Student 2', 'Student 1'],
  );
  assert.deepEqual(
    anon.rows.map((r) => r.user.email),
    [null, null],
  );
  // Untracked stays untracked; nothing about the data itself changes.
  assert.deepEqual(
    anon.rows.map((r) => r.cells.map((c) => c.percent)),
    [[50], [null]],
  );
  assert.deepEqual(anon.courses, [course]);
});

test('one user keeps one label across every array in a single call', () => {
  const data: BadgeCardsData = {
    type: 'badge_cards',
    users: [
      { user: user(9, 'Nia'), badges: [], percent: null, overdue: 0 },
      {
        user: user(4, 'Ben'),
        badges: [{ id: 1, name: 'Starter', description: null, courseId: null, imageUrl: null }],
        percent: null,
        overdue: 0,
      },
      // Same person again — e.g. holding both a course and a site-wide badge.
      { user: user(9, 'Nia'), badges: [], percent: null, overdue: 0 },
    ],
  };

  const anon = anonymizeWidgetData(data);
  if (anon.type !== 'badge_cards') throw new Error('variant changed');

  assert.deepEqual(
    anon.users.map((entry) => entry.user.fullname),
    ['Student 2', 'Student 1', 'Student 2'],
  );
  assert.deepEqual(
    anon.users.map((entry) => entry.badges.length),
    [0, 1, 0],
  );
});

test('labels depend only on ids, so a reordered payload agrees with the first', () => {
  const build = (users: MoodleUser[]): LeaderboardData => ({
    type: 'leaderboard',
    entries: users.map((u, i) => ({ user: u, badgeCount: i })),
  });

  const first = anonymizeWidgetData(build([user(11, 'Ann'), user(2, 'Bob'), user(40, 'Cy')]));
  const second = anonymizeWidgetData(build([user(40, 'Cy'), user(11, 'Ann'), user(2, 'Bob')]));
  if (first.type !== 'leaderboard' || second.type !== 'leaderboard') {
    throw new Error('variant changed');
  }

  const labelById = (data: LeaderboardData): Record<number, string> => {
    const out: Record<number, string> = {};
    for (const entry of data.entries) out[entry.user.id] = entry.user.fullname;
    return out;
  };
  assert.deepEqual(labelById(first), { 2: 'Student 1', 11: 'Student 2', 40: 'Student 3' });
  assert.deepEqual(labelById(first), labelById(second));
  assert.deepEqual(
    first.entries.map((e) => e.badgeCount),
    [0, 1, 2],
  );
});

test('user_list relabels its single user and keeps badges and completion', () => {
  const data: UserListData = {
    type: 'user_list',
    user: user(42, 'Rafa'),
    badges: [{ id: 3, name: 'Finisher', description: 'Done', courseId: 5, imageUrl: null }],
    completion: [
      {
        course,
        entry: { courseId: 5, activitiesTotal: 3, activitiesCompleted: 3, percent: 100, overdue: 0 },
      },
    ],
  };

  const anon = anonymizeWidgetData(data);
  if (anon.type !== 'user_list') throw new Error('variant changed');

  assert.equal(anon.user.fullname, 'Student 1');
  assert.equal(anon.user.email, null);
  assert.equal(anon.user.id, 42);
  assert.deepEqual(anon.badges, data.badges);
  assert.deepEqual(anon.completion, data.completion);
});

test('progress_chart is relabelled and stripped of profile pictures', () => {
  const data: ProgressChartData = {
    type: 'progress_chart',
    metric: 'badges',
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-08T00:00:00.000Z',
    step: false,
    series: [
      {
        user: { ...user(7, 'Zoe'), avatarUrl: '/api/public/tok/user-image/7' },
        points: [{ t: '2026-08-01T00:00:00.000Z', v: 2 }],
      },
      { user: { ...user(3, 'Amir'), avatarUrl: null }, points: [] },
    ],
  };

  const anon = anonymizeWidgetData(data);
  if (anon.type !== 'progress_chart') throw new Error('variant changed');

  assert.deepEqual(
    anon.series.map((s) => s.user.fullname),
    ['Student 2', 'Student 1'],
  );
  // THE assertion in this file: a face identifies a person as well as a name does, so
  // an anonymised public dashboard must not carry a URL that resolves to one.
  assert.deepEqual(
    anon.series.map((s) => s.user.avatarUrl),
    [null, null],
  );
  assert.deepEqual(anon.series[0]?.points, data.series[0]?.points);
});

test('every anonymised variant nulls avatarUrl, not just the chart', () => {
  const withAvatar = { ...user(1, 'Ana'), avatarUrl: '/api/user-image/1' };
  const board = anonymizeWidgetData({
    type: 'leaderboard',
    entries: [{ user: withAvatar, badgeCount: 3 }],
  });
  if (board.type !== 'leaderboard') throw new Error('variant changed');
  assert.equal(board.entries[0]?.user.avatarUrl, null);
});

// ---------------------------------------------------------------------------
// foldEvents — the all-time chart's reconstruction of history from Moodle's own
// timestamps. The SQL either side of it needs a live Postgres; this does not.
// ---------------------------------------------------------------------------

const BUCKET = 0;
const countAll = (counts: ReadonlyMap<number, number>) => counts.get(BUCKET) ?? 0;
const at = (iso: string) => new Date(iso);
const FROM = at('2026-01-01T00:00:00.000Z');
const TO = at('2026-01-31T00:00:00.000Z');

test('foldEvents counts cumulatively and carries the last value to the right edge', () => {
  const points = foldEvents(
    [
      { at: at('2026-01-10T00:00:00.000Z'), key: BUCKET },
      { at: at('2026-01-05T00:00:00.000Z'), key: BUCKET },
    ],
    countAll,
    FROM,
    TO,
  );
  assert.deepEqual(points, [
    { t: FROM.toISOString(), v: 0 },
    { t: '2026-01-05T00:00:00.000Z', v: 1 },
    { t: '2026-01-10T00:00:00.000Z', v: 2 },
    // Nothing happened after the 10th, but the line still reaches today.
    { t: TO.toISOString(), v: 2 },
  ]);
});

test('foldEvents folds undated events into the opening value', () => {
  // A badge Moodle has no issue date for, or a completion restored from a backup: it
  // happened, at an unknown time before the chart starts. Dropping it would understate
  // the total forever; dating it to now would invent a spike today.
  const points = foldEvents(
    [
      { at: null, key: BUCKET },
      { at: null, key: BUCKET },
      { at: at('2026-01-05T00:00:00.000Z'), key: BUCKET },
    ],
    countAll,
    FROM,
    TO,
  );
  assert.deepEqual(
    points.map((p) => p.v),
    [2, 3, 3],
  );
});

test('foldEvents collapses events sharing a timestamp into one step', () => {
  const same = at('2026-01-05T00:00:00.000Z');
  const points = foldEvents(
    [
      { at: same, key: BUCKET },
      { at: same, key: BUCKET },
      { at: same, key: BUCKET },
    ],
    countAll,
    FROM,
    TO,
  );
  assert.equal(points.length, 3); // from, the one step, to
  assert.deepEqual(
    points.map((p) => p.v),
    [0, 3, 3],
  );
});

test('foldEvents averages per-course percentages rather than pooling activities', () => {
  // Course 1 has 2 tracked activities, course 2 has 8. Completing one activity in the
  // small course is +50% there and +25% overall — pooling would have called it +10%,
  // and would disagree with what every other widget reports for the same student.
  const totals = new Map([
    [1, 2],
    [2, 8],
  ]);
  const mean = (counts: ReadonlyMap<number, number>) => {
    let sum = 0;
    for (const [courseId, total] of totals) sum += Math.min(counts.get(courseId) ?? 0, total) / total;
    return Math.round((sum / totals.size) * 10000) / 100;
  };

  const points = foldEvents(
    [
      { at: at('2026-01-05T00:00:00.000Z'), key: 1 },
      { at: at('2026-01-06T00:00:00.000Z'), key: 2 },
    ],
    mean,
    FROM,
    TO,
  );
  assert.deepEqual(
    points.map((p) => p.v),
    [0, 25, 31.25, 31.25],
  );
});

test('course_overview carries no personal data and passes through unchanged', () => {
  const data: CourseOverviewData = {
    type: 'course_overview',
    course,
    enrolledCount: 12,
    averagePercent: 61.5,
    trackedActivityCount: 8,
  };
  assert.deepEqual(anonymizeWidgetData(data), data);
});

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

const SEPTEMBER_FIRST_MONDAY = { month: 9, weekday: 1, nth: 1 };
const DECEMBER_FIRST_MONDAY = { month: 12, weekday: 1, nth: 1 };
/** A one-off calendar date needs no anchoring — it says exactly what it means. */
const FIXED_DATE = { date: '2026-03-15' };

/** Local midday, so the assertions are not a timezone puzzle. */
const day = (iso: string): Date => new Date(`${iso}T12:00:00`);

test('nthWeekdayOf finds the first Monday in September across years', () => {
  // 2026-09-07, 2025-09-01 and 2024-09-02 are all the first Monday of their September.
  assert.equal(nthWeekdayOf(2026, SEPTEMBER_FIRST_MONDAY).getDate(), 7);
  assert.equal(nthWeekdayOf(2025, SEPTEMBER_FIRST_MONDAY).getDate(), 1);
  assert.equal(nthWeekdayOf(2024, SEPTEMBER_FIRST_MONDAY).getDate(), 2);
  // End of the day: "by the first Monday" includes all of that Monday.
  assert.equal(nthWeekdayOf(2026, SEPTEMBER_FIRST_MONDAY).getHours(), 23);
});

test('nthWeekdayOf handles "last" and clamps an nth the month does not have', () => {
  assert.equal(nthWeekdayOf(2026, { month: 9, weekday: 1, nth: -1 }).getDate(), 28);
  // September 2026 has four Mondays; a fifth clamps to the fourth rather than spilling
  // into October, which would silently move the deadline a month.
  assert.equal(nthWeekdayOf(2026, { month: 9, weekday: 1, nth: 5 }).getDate(), 28);
});

test('a rule only comes into force at its first occurrence after it was created', () => {
  const created = day('2026-06-01');
  // Still June: the September occurrence has not happened, and last September predates
  // the rule — so nothing is due yet.
  assert.equal(deadlineDueAt(SEPTEMBER_FIRST_MONDAY, created, day('2026-06-15')), null);
  // October: this year's occurrence has passed and it is after created_at.
  const due = deadlineDueAt(SEPTEMBER_FIRST_MONDAY, created, day('2026-10-01'));
  assert.equal(due?.getFullYear(), 2026);
  // Next June, the rule is still measured against September 2026, not reset.
  assert.equal(
    deadlineDueAt(SEPTEMBER_FIRST_MONDAY, created, day('2027-06-15'))?.getFullYear(),
    2026,
  );
});

test('deadlineNextDueAt rolls a yearly rule forward and expires a one-off date', () => {
  assert.equal(deadlineNextDueAt(SEPTEMBER_FIRST_MONDAY, day('2026-06-15'))?.getFullYear(), 2026);
  assert.equal(deadlineNextDueAt(SEPTEMBER_FIRST_MONDAY, day('2026-10-01'))?.getFullYear(), 2027);
  assert.equal(deadlineNextDueAt(FIXED_DATE, day('2026-01-01'))?.getDate(), 15);
  assert.equal(deadlineNextDueAt(FIXED_DATE, day('2026-04-01')), null);
});

test('a one-off date is due from the end of that day, whenever it was created', () => {
  // Created today, dated yesterday: overdue immediately, unlike a yearly rule. An
  // explicit date is not something the anchor should second-guess.
  assert.notEqual(deadlineDueAt(FIXED_DATE, day('2026-06-01'), day('2026-06-01')), null);
  // Still the morning of the 15th → not yet due; "by the 15th" includes all of it.
  assert.equal(deadlineDueAt(FIXED_DATE, day('2026-01-01'), day('2026-03-15')), null);
  assert.notEqual(deadlineDueAt(FIXED_DATE, day('2026-01-01'), day('2026-03-16')), null);
});

test('foldDeadlines counts due and overdue activities per course and user', () => {
  const created = day('2025-01-01');
  const facts = foldDeadlines(
    [
      // Past its date and not done → overdue.
      { segment: '5', userId: 7, cmid: 1, name: 'Activity 1', rule: SEPTEMBER_FIRST_MONDAY, createdAt: created, completed: false },
      // Past its date but done → due, not overdue.
      { segment: '5', userId: 7, cmid: 2, name: 'Activity 2', rule: SEPTEMBER_FIRST_MONDAY, createdAt: created, completed: true },
      // Written down in January, first December still ahead → a deadline, but not due.
      { segment: '5', userId: 7, cmid: 3, name: 'Activity 3', rule: DECEMBER_FIRST_MONDAY, createdAt: day('2026-01-15'), completed: false },
    ],
    day('2026-10-01'),
  );
  assert.deepEqual(facts.get('5:7'), {
    total: 3,
    due: 2,
    overdue: 1,
    earlyDone: 0,
    overdueNames: ['Activity 1'],
  });
});

test('a parent section gathers its subsections, and a sibling is left out', () => {
  // The reported bug: "Grundkurse" holds nothing but subsections, so no activity is filed
  // under that bare label and it was unselectable while all its children were listed.
  assert.equal(sectionMatches('Grundkurse', 'Grundkurse'), true);
  assert.equal(sectionMatches('Grundkurse › Woche 2', 'Grundkurse'), true);
  assert.equal(sectionMatches('Grundkurse › Woche 2 › Teil A', 'Grundkurse'), true);
  // A sibling that merely starts with the same letters is a different section.
  assert.equal(sectionMatches('Grundkurse II', 'Grundkurse'), false);
  assert.equal(sectionMatches('Lernumgebungen › Woche 2', 'Grundkurse'), false);
  // Picking the child still narrows to the child.
  assert.equal(sectionMatches('Grundkurse › Woche 2', 'Grundkurse › Woche 2'), true);
  assert.equal(sectionMatches('Grundkurse › Woche 3', 'Grundkurse › Woche 2'), false);
});

test('foldDeadlines keeps two sections of one course apart', () => {
  // The rings widget hands in `courseId:section` when a course is split. Two activities
  // in the same course must then land in different buckets, not be summed into one.
  const facts = foldDeadlines(
    [
      { segment: '5:Theorie', userId: 7, cmid: 1, name: 'ISO/OSI', rule: SEPTEMBER_FIRST_MONDAY, createdAt: day('2025-01-01'), completed: false },
      { segment: '5:Praxis', userId: 7, cmid: 2, name: 'Patchen', rule: SEPTEMBER_FIRST_MONDAY, createdAt: day('2025-01-01'), completed: true },
    ],
    day('2026-10-01'),
  );
  assert.equal(facts.get('5:Theorie:7')?.overdue, 1);
  assert.equal(facts.get('5:Praxis:7')?.overdue, 0);
  assert.equal(facts.get('5:7'), undefined);
});

test('foldDeadlines lets the strictest cohort win when two claim one activity', () => {
  const rows = [
    // Same activity via a cohort whose deadline is not in force yet...
    { segment: '5', userId: 7, cmid: 1, name: 'Activity 1', rule: DECEMBER_FIRST_MONDAY, createdAt: day('2026-01-15'), completed: false },
    // ...and via one whose deadline has passed. Two groups must not buy an extension.
    { segment: '5', userId: 7, cmid: 1, name: 'Activity 1', rule: SEPTEMBER_FIRST_MONDAY, createdAt: day('2025-01-01'), completed: false },
  ];
  const expected = { total: 1, due: 1, overdue: 1, earlyDone: 0, overdueNames: ['Activity 1'] };
  assert.deepEqual(foldDeadlines(rows, day('2026-10-01')).get('5:7'), expected);
  // Order of the rows must not change the verdict.
  assert.deepEqual(foldDeadlines([...rows].reverse(), day('2026-10-01')).get('5:7'), expected);
});

test('completion_rings anonymises names and strips the profile picture', () => {
  const data: CompletionRingsData = {
    type: 'completion_rings',
    legend: [{ key: '1', label: course.shortname, title: course.fullname }],
    entries: [
      {
        user: { ...user(7, 'Zoe'), avatarUrl: '/api/user-image/7' },
        segments: [
          {
            key: '1',
            label: course.shortname,
            title: course.fullname,
            percent: 50,
            targetPercent: 75,
            overdue: 1,
            overdueActivities: ['ISO/OSI'],
          },
        ],
        overdue: 1,
        earlyDone: 0,
        percent: 50,
        badges: [],
      },
    ],
  };
  const anon = anonymizeWidgetData(data) as CompletionRingsData;
  assert.equal(anon.entries[0]?.user.fullname, 'Student 1');
  assert.equal(anon.entries[0]?.user.email, null);
  assert.equal(anon.entries[0]?.user.avatarUrl, null);
  assert.equal(anon.entries[0]?.segments[0]?.percent, 50);
});

test('every enrollments query is aliased e, as studentFilter requires', () => {
  // studentFilter/excludeFilter emit `e.roles` and `e.moodle_user_id`, so a query that
  // selects `from enrollments` without the alias is not a style slip — Postgres rejects
  // it outright and the widget answers 500. That shipped once; this is a two-line guard
  // rather than the live-Postgres test suite this repo deliberately does not have.
  const source = readFileSync(new URL('./widgetData.ts', import.meta.url), 'utf8');
  assert.deepEqual(source.match(/\b(from|join)\s+enrollments(?!\s+e\b)/g), null);
});

test('the target mark sits ahead of the fill by exactly the overdue work', () => {
  const facts = { total: 4, due: 4, overdue: 3, earlyDone: 0, overdueNames: [] };
  // 12 of 40 done is a 30% fill; three overdue means the mark belongs at 37.5%, in
  // front of it. The first version divided due deadlines by activity count and put the
  // mark at 10% — behind the fill, for someone who had missed three deadlines.
  assert.equal(targetPercent(facts, 12, 40), 37.5);
  // Nothing overdue and nothing early: the mark would land exactly on the end of the fill
  // and say nothing.
  assert.equal(targetPercent({ ...facts, overdue: 0 }, 12, 40), null);
  // It can never point past a full ring.
  assert.equal(targetPercent(facts, 39, 40), 100);

  // Ahead of schedule is the same measurement read the other way: two activities finished
  // before their date puts the mark two behind the fill, at 25% against a 30% fill.
  assert.equal(targetPercent({ ...facts, overdue: 0, earlyDone: 2 }, 12, 40), 25);
  // Missing as much as they finished early is being exactly on schedule.
  assert.equal(targetPercent({ ...facts, overdue: 2, earlyDone: 2 }, 12, 40), null);
  // And it can never point behind the start of the ring.
  assert.equal(targetPercent({ ...facts, overdue: 0, earlyDone: 9 }, 4, 40), 0);
});

test('ring tiles sort by the chosen key, then by completion, then by name', () => {
  const tile = (name: string, courses: number, percent: number | null, overdue = 0) => ({
    user: user(name.charCodeAt(0), name),
    segments: Array.from({ length: courses }, (_, i) => ({
      key: `${i}`,
      label: `C${i}`,
      title: `Course ${i}`,
      percent,
      targetPercent: null,
      overdue: 0,
      overdueActivities: [],
    })),
    overdue,
    earlyDone: 0,
    percent,
    badges: [],
  });

  // Most courses first; inside each group the furthest along comes first.
  const people = [tile('Ana', 2, 90), tile('Bo', 4, 30), tile('Cy', 4, 80), tile('Di', 2, 10)];
  assert.deepEqual(
    [...people].sort(ringComparator('courses', 'desc')).map((e) => e.user.fullname),
    ['Cy', 'Bo', 'Ana', 'Di'],
  );
  // Fewest courses first, still highest completion first within the group.
  assert.deepEqual(
    [...people].sort(ringComparator('courses', 'asc')).map((e) => e.user.fullname),
    ['Ana', 'Di', 'Cy', 'Bo'],
  );

  // Untracked people sort last whichever way completion itself is pointed.
  const untracked = [tile('Ana', 1, null), tile('Bo', 1, 50)];
  for (const dir of ['asc', 'desc'] as const) {
    assert.equal(
      [...untracked].sort(ringComparator('percent', dir)).at(-1)?.user.fullname,
      'Ana',
      `untracked last when sorting ${dir}`,
    );
  }
});
