import type { WidgetData } from '@moodify/shared';
import { sql } from './db.ts';

/**
 * Public-route anonymisation (§12).
 *
 * Real names are replaced with "Student 1", "Student 2", … numbered by
 * moodle_user_id ascending so the same person carries the same label everywhere
 * inside one dashboard view, and email addresses are dropped entirely. This is
 * applied ONLY on the unauthenticated `/api/public/...` routes — the admin views
 * always render real names.
 */

type Anonymisable = {
  id: number;
  fullname: string;
  email: string | null;
  avatarUrl?: string | null;
};

/**
 * id -> label map, numbered by id ascending over the *distinct* ids present.
 * Built from every user in a payload at once so one person cannot end up with
 * two different labels in the same widget.
 */
function buildLabels(users: readonly { id: number }[]): Map<number, string> {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const user of users) {
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    ids.push(user.id);
  }
  ids.sort((a, b) => a - b);

  const labels = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (id === undefined) continue;
    labels.set(id, `Student ${i + 1}`);
  }
  return labels;
}

/**
 * Returns a copy of `user` with its label swapped in and the email removed.
 * Falls back to a bare "Student" if the id is somehow missing from the map:
 * failing closed is better than leaking a real name on a public page.
 */
function relabel<T extends Anonymisable>(user: T, labels: Map<number, string>): T {
  const label = labels.get(user.id) ?? 'Student';
  // avatarUrl goes too: a profile photo identifies a person at least as well as
  // their name does, so "Student 3" beside their face anonymises nothing.
  return { ...user, fullname: label, email: null, avatarUrl: null } as T;
}

/**
 * Replaces every fullname with a stable "Student N" label and nulls every email.
 *
 * Numbering is derived from a *copy* sorted by id ascending, so it does not
 * depend on the order the caller happens to pass users in; the returned array
 * keeps the caller's original ordering and only the labels change.
 */
export function anonymizeUsers<T extends Anonymisable>(users: T[]): T[] {
  const labels = buildLabels(users);
  return users.map((user) => relabel(user, labels));
}

/**
 * Labels numbered across *every* known Moodle user, not just the ones in one payload.
 *
 * Each widget fetches its own data through a separate request, so per-payload numbering
 * would label the same person "Student 1" in a user_list and "Student 7" in the
 * leaderboard beside it. §12 requires the label to be consistent within the dashboard
 * view, which means the numbering has to come from an ordering both requests share.
 * Ranking by moodle_user_id ascending across the whole table gives that, and stays
 * stable across page loads too.
 *
 * <50 users, so this is a trivial query; it is re-read per request rather than cached
 * to avoid serving a stale label right after a sync adds someone.
 */
export async function globalStudentLabels(): Promise<Map<number, string>> {
  const { rows } = await sql<{ moodle_user_id: number }>(
    'select moodle_user_id from moodle_users order by moodle_user_id asc',
  );
  return buildLabels(rows.map((row) => ({ id: row.moodle_user_id })));
}

/**
 * Anonymises whichever user-bearing field the widget payload variant carries.
 *
 * Pass the map from globalStudentLabels() so labels agree across every widget on the
 * dashboard. Without it the numbering falls back to the payload's own users, which is
 * self-consistent but only within that single widget.
 */
export function anonymizeWidgetData(data: WidgetData, shared?: Map<number, string>): WidgetData {
  const buildLabelsFor = (users: readonly { id: number }[]): Map<number, string> =>
    shared ?? buildLabels(users);

  switch (data.type) {
    case 'completion_table': {
      const labels = buildLabelsFor(data.rows.map((row) => row.user));
      return {
        ...data,
        rows: data.rows.map((row) => ({ ...row, user: relabel(row.user, labels) })),
      };
    }
    case 'badge_cards':
    case 'badge_list': {
      const labels = buildLabelsFor(data.users.map((entry) => entry.user));
      return {
        ...data,
        users: data.users.map((entry) => ({ ...entry, user: relabel(entry.user, labels) })),
      };
    }
    case 'leaderboard': {
      const labels = buildLabelsFor(data.entries.map((entry) => entry.user));
      return {
        ...data,
        entries: data.entries.map((entry) => ({ ...entry, user: relabel(entry.user, labels) })),
      };
    }
    case 'user_list': {
      const labels = buildLabelsFor([data.user]);
      return { ...data, user: relabel(data.user, labels) };
    }
    case 'progress_chart': {
      const labels = buildLabelsFor(data.series.map((entry) => entry.user));
      return {
        ...data,
        series: data.series.map((entry) => ({ ...entry, user: relabel(entry.user, labels) })),
      };
    }
    case 'course_overview':
      // Aggregate only — carries no names or emails.
      return data;
    default:
      return data;
  }
}
