import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planNotifications, type Candidate, type NotificationRule } from './notify.ts';

/**
 * The send decision, without an SMTP server or a database.
 *
 * Two failure modes matter more than the rest: mailing a class twice, and mailing
 * somebody who has already done the work. Both are covered here.
 */

const BEFORE: NotificationRule = {
  id: 1,
  kind: 'before',
  daysBefore: 5,
  subject: 'Due soon: {activity}',
  body: '{name}: {activity} — due {due}, in {days} day(s).',
};

const OVERDUE: NotificationRule = {
  id: 2,
  kind: 'overdue',
  daysBefore: null,
  subject: 'Overdue: {activity}',
  body: '{name}: {activity} was due {due}.',
};

const NOW = new Date(2026, 2, 10, 9, 0, 0);

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    deadlineId: 1,
    courseName: 'Netzwerktechnik',
    activityName: 'ISO/OSI',
    userId: 7,
    fullname: 'Zoe',
    email: 'zoe@example.test',
    rule: { date: '2026-03-13' },
    createdAt: new Date(2026, 0, 1),
    completed: false,
    ...over,
  };
}

test('a lead-time rule fires inside its window and not outside it', () => {
  // Due on the 13th, today is the 10th: three days out, inside a five-day window.
  const inside = planNotifications([BEFORE], [candidate()], new Set(), NOW);
  assert.equal(inside.length, 1);
  assert.equal(inside[0]?.subject, 'Due soon: ISO/OSI');
  assert.match(inside[0]?.text ?? '', /in 3 day\(s\)/);
  assert.equal(inside[0]?.dueOn, '2026-03-13');

  // Same rule, a date three weeks out: nothing yet.
  const outside = planNotifications(
    [BEFORE],
    [candidate({ rule: { date: '2026-03-31' } })],
    new Set(),
    NOW,
  );
  assert.deepEqual(outside, []);
});

test('nothing goes out twice', () => {
  const sent = new Set(['1:1:7:2026-03-13']);
  assert.deepEqual(planNotifications([BEFORE], [candidate()], sent, NOW), []);
});

test('completed work and missing addresses are skipped', () => {
  assert.deepEqual(planNotifications([BEFORE], [candidate({ completed: true })], new Set(), NOW), []);
  assert.deepEqual(planNotifications([BEFORE], [candidate({ email: null })], new Set(), NOW), []);
});

test('activities due the same day become one mail, other days stay separate', () => {
  const together = planNotifications(
    [BEFORE],
    [candidate(), candidate({ deadlineId: 2, activityName: 'Subnetting' })],
    new Set(),
    NOW,
  );
  assert.equal(together.length, 1);
  // The subject cannot hold a bullet list, so it counts instead of naming one of two.
  assert.equal(together[0]?.subject, 'Due soon: 2 activities');
  assert.match(together[0]?.text ?? '', /• ISO\/OSI \(Netzwerktechnik\)/);
  assert.match(together[0]?.text ?? '', /• Subnetting \(Netzwerktechnik\)/);
  // Both are logged, so neither can be re-sent by the next pass.
  assert.deepEqual(together[0]?.deadlineIds, [1, 2]);

  const apart = planNotifications(
    [BEFORE],
    [candidate(), candidate({ deadlineId: 2, rule: { date: '2026-03-12' } })],
    new Set(),
    NOW,
  );
  assert.equal(apart.length, 2);
});

test('an overdue rule fires on a date that has passed, not on one still ahead', () => {
  const past = planNotifications(
    [OVERDUE],
    [candidate({ rule: { date: '2026-03-01' } })],
    new Set(),
    NOW,
  );
  assert.equal(past.length, 1);
  assert.equal(past[0]?.subject, 'Overdue: ISO/OSI');
  assert.equal(past[0]?.dueOn, '2026-03-01');

  assert.deepEqual(planNotifications([OVERDUE], [candidate()], new Set(), NOW), []);
});

test('a yearly rule notifies again the next time it comes round', () => {
  const yearly = candidate({ rule: { month: 9, weekday: 1, nth: 1 }, createdAt: new Date(2025, 0, 1) });
  // Last September's mail has gone out already; this September's has not.
  const sent = new Set(['2:1:7:2025-09-01']);
  const planned = planNotifications([OVERDUE], [yearly], sent, new Date(2026, 9, 1));
  assert.equal(planned.length, 1);
  assert.equal(planned[0]?.dueOn, '2026-09-07');
});
