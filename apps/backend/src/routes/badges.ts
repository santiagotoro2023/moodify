import type { FastifyInstance } from 'fastify';
import type { BadgeAdmin } from '@moodify/shared';
import { z } from 'zod';
import { requireAdmin } from '../auth.ts';
import { sql } from '../db.ts';

/**
 * The badge catalogue, and the descriptions Moodify keeps for them.
 *
 * "Every badge" here means every badge somebody currently holds: Moodle exposes no
 * endpoint listing the badges a course merely *has* (see §9.2 and the README), so an
 * unearned badge is invisible until the first student earns it.
 *
 * That inner join is also what keeps deleted badges out. Revoking or deleting a badge in
 * Moodle drops its badge_issued rows on the next sync, and a badge nobody holds is a
 * badge Moodify has no evidence for — listing it would offer a description for something
 * that no longer exists. Every other reader already joins through badge_issued, so this
 * is the one place the rule had to be stated.
 *
 * ponytail: the badges row itself is left behind, holding its custom description. It
 * costs a row and means a re-created badge keeps its text. Prune in the sync if that
 * table ever grows enough to notice.
 *
 * The custom description lives in its own column rather than overwriting Moodle's, which
 * every discovery run rewrites from the source.
 */
export async function badgeRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAdmin };

  app.get('/api/badges', auth, async () => {
    const { rows } = await sql<{
      moodle_badge_id: number;
      moodle_course_id: number | null;
      name: string;
      description: string | null;
      custom_description: string | null;
      course_name: string | null;
      holders: string;
    }>(
      `select b.moodle_badge_id, b.moodle_course_id, b.name, b.description,
              b.custom_description, c.fullname as course_name,
              count(bi.moodle_user_id) as holders
         from badges b
         left join courses c on c.moodle_course_id = b.moodle_course_id
         join badge_issued bi on bi.moodle_badge_id = b.moodle_badge_id
        group by b.moodle_badge_id, c.fullname
        order by c.fullname nulls first, b.name`,
    );
    return rows.map(
      (row): BadgeAdmin => ({
        id: row.moodle_badge_id,
        name: row.name,
        description: row.description,
        customDescription: row.custom_description,
        courseId: row.moodle_course_id,
        courseName: row.course_name,
        // count() comes back as a string from pg for bigint.
        holders: Number(row.holders),
        imageUrl: `/api/badge-image/${row.moodle_badge_id}`,
      }),
    );
  });

  app.patch('/api/badges/:id', auth, async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const { customDescription } = z
      .object({ customDescription: z.string().max(2000) })
      .parse(request.body);
    // Blank means "no custom description", stored as NULL rather than '' so the pop-up
    // has one thing to test rather than two.
    const text = customDescription.trim() === '' ? null : customDescription;
    const { rows } = await sql<{ moodle_badge_id: number }>(
      `update badges set custom_description = $2
        where moodle_badge_id = $1 returning moodle_badge_id`,
      [id, text],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'No such badge' });
    return { customDescription: text };
  });
}
