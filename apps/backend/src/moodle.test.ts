import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEntities, liveBadges, type UserBadge } from './moodle.ts';

/**
 * Moodle HTML-escapes every string it returns from the web service (format_string),
 * so anything that reaches the database must be decoded first — React escapes again
 * on output, and a double-escaped name renders as "Firewalls &amp; Sicherheit".
 */
test('decodeEntities unescapes what Moodle escapes, and leaves the rest alone', () => {
  assert.equal(decodeEntities('Firewalls &amp; Sicherheit'), 'Firewalls & Sicherheit');
  assert.equal(decodeEntities('&lt;script&gt;'), '<script>');
  assert.equal(decodeEntities('Sch&#252;ler'), 'Schüler');
  assert.equal(decodeEntities('Sch&#xFC;ler'), 'Schüler');
  assert.equal(decodeEntities('&quot;Netzwerke&quot;'), '"Netzwerke"');

  // Already-plain UTF-8 is the common case and must survive untouched.
  assert.equal(decodeEntities('Übungen für Anfänger'), 'Übungen für Anfänger');
  // An unknown entity is left as written rather than silently dropped.
  assert.equal(decodeEntities('100 &widget; ok'), '100 &widget; ok');
  // A bare ampersand is not an entity.
  assert.equal(decodeEntities('R&D'), 'R&D');
});

/**
 * Moodle's "delete and keep existing issues" archives a badge instead of deleting it and
 * goes on reporting it to every holder, so a badge deleted and recreated under the same
 * name shows up twice. Archived is deleted, and so is anything from a course that is gone.
 */
test('liveBadges drops archived badges and badges from courses that are gone', () => {
  const badge = (id: number, courseid: number | null, status: number | null): UserBadge => ({
    id,
    name: `Badge ${id}`,
    description: null,
    courseid,
    dateissued: null,
    badgeurl: null,
    status,
  });
  const known = new Set([10, 20]);

  assert.deepEqual(
    liveBadges(known, [
      badge(1, 10, 1), // active, live course
      badge(2, 10, 4), // archived — the old copy of a recreated badge
      badge(3, 99, 1), // course Moodify no longer has
      badge(4, null, 1), // site-wide
      badge(5, null, null), // Moodle version that omits status
      badge(6, 20, 3), // active and locked
    ]).map((entry) => entry.id),
    [1, 4, 5, 6],
  );

  // No courses known at all still keeps site-wide badges.
  assert.deepEqual(liveBadges(new Set(), [badge(1, 10, 1), badge(2, null, 1)]).map((b) => b.id), [2]);
});
