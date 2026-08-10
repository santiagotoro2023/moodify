import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BadgeCardsData,
  CompletionTableData,
  CourseOverviewData,
  LeaderboardData,
  MoodleUser,
  UserListData,
} from '@moodify/shared';
import { anonymizeUsers, anonymizeWidgetData } from './anonymize.ts';

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
        cells: [{ courseId: 5, activitiesTotal: 4, activitiesCompleted: 2, percent: 50 }],
      },
      {
        user: user(3, 'Amir'),
        cells: [{ courseId: 5, activitiesTotal: 0, activitiesCompleted: 0, percent: null }],
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
      { user: user(9, 'Nia'), badges: [], percent: null },
      {
        user: user(4, 'Ben'),
        badges: [{ id: 1, name: 'Starter', description: null, courseId: null, imageUrl: null }],
        percent: null,
      },
      // Same person again — e.g. holding both a course and a site-wide badge.
      { user: user(9, 'Nia'), badges: [], percent: null },
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
        entry: { courseId: 5, activitiesTotal: 3, activitiesCompleted: 3, percent: 100 },
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
