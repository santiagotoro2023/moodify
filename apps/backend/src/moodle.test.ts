import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEntities } from './moodle.ts';

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
