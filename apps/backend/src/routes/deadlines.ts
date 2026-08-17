import type { FastifyInstance } from 'fastify';
import {
  deadlineDueAt,
  deadlineNextDueAt,
  type Cohort,
  type CourseActivity,
  type Deadline,
} from '@moodify/shared';
import { z } from 'zod';
import { requireAdmin } from '../auth.ts';
import { sql } from '../db.ts';

/**
 * Deadline administration: "this activity must be done by the first Monday in
 * September, for this cohort".
 *
 * Read-only against Moodle — the cohorts and activity names come from the sync, and
 * nothing here is written back. The occurrence dates are computed on read (see
 * deadlineDueAt in packages/shared) so a rule rolls into the next year by itself.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });
const courseIdParam = z.object({ courseId: z.coerce.number().int().positive() });

const deadlineBodySchema = z.object({
  courseId: z.number().int().positive(),
  cmid: z.number().int().positive(),
  cohortId: z.number().int().positive(),
  month: z.number().int().min(1).max(12),
  /** Sunday = 0, matching Date#getDay. */
  weekday: z.number().int().min(0).max(6),
  /** 1-5, or -1 for "the last one in the month". */
  nth: z.number().int().min(-1).max(5).refine((value) => value !== 0, 'nth cannot be 0'),
});

type DeadlineRow = {
  id: number;
  moodle_course_id: number;
  course_name: string;
  cmid: number;
  activity_name: string;
  moodle_cohort_id: number;
  cohort_name: string;
  month: number;
  weekday: number;
  nth: number;
  created_at: Date;
};

function toDeadline(row: DeadlineRow, now: Date): Deadline {
  const rule = { month: row.month, weekday: row.weekday, nth: row.nth };
  const due = deadlineDueAt(rule, row.created_at, now);
  return {
    id: row.id,
    courseId: row.moodle_course_id,
    courseName: row.course_name,
    cmid: row.cmid,
    activityName: row.activity_name,
    cohortId: row.moodle_cohort_id,
    cohortName: row.cohort_name,
    ...rule,
    dueAt: due === null ? null : due.toISOString(),
    nextDueAt: deadlineNextDueAt(rule, now).toISOString(),
  };
}

export async function deadlineRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAdmin };

  app.get('/api/cohorts', auth, async (): Promise<Cohort[]> => {
    const { rows } = await sql<{
      moodle_cohort_id: number;
      name: string;
      idnumber: string | null;
      member_count: number;
    }>(
      `select c.moodle_cohort_id, c.name, c.idnumber,
              (select count(*) from cohort_members m
                where m.moodle_cohort_id = c.moodle_cohort_id)::int as member_count
         from cohorts c
        order by c.name asc`,
    );
    return rows.map((row) => ({
      id: row.moodle_cohort_id,
      name: row.name,
      idnumber: row.idnumber,
      memberCount: row.member_count,
    }));
  });

  app.get('/api/courses/:courseId/activities', auth, async (request, reply) => {
    const parsed = courseIdParam.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid course id.' });

    const { rows } = await sql<{ cmid: number; name: string; modname: string }>(
      `select cmid, name, modname
         from course_activities
        where moodle_course_id = $1
        order by name asc`,
      [parsed.data.courseId],
    );
    const activities: CourseActivity[] = rows.map((row) => ({
      courseId: parsed.data.courseId,
      cmid: row.cmid,
      name: row.name,
      modname: row.modname,
    }));
    return activities;
  });

  app.get('/api/deadlines', auth, async (): Promise<Deadline[]> => {
    const { rows } = await sql<DeadlineRow>(
      `select d.id, d.moodle_course_id, co.fullname as course_name,
              d.cmid, ca.name as activity_name,
              d.moodle_cohort_id, ch.name as cohort_name,
              d.month, d.weekday, d.nth, d.created_at
         from deadlines d
         join courses co on co.moodle_course_id = d.moodle_course_id
         join course_activities ca
           on ca.moodle_course_id = d.moodle_course_id and ca.cmid = d.cmid
         join cohorts ch on ch.moodle_cohort_id = d.moodle_cohort_id
        order by co.fullname asc, ca.name asc, ch.name asc`,
    );
    const now = new Date();
    return rows.map((row) => toDeadline(row, now));
  });

  app.post('/api/deadlines', auth, async (request, reply) => {
    const parsed = deadlineBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid deadline.' });
    }
    const body = parsed.data;

    // The FKs would already reject these, but a 409 naming the missing side is far more
    // actionable than a Postgres constraint name — and "the sync has not seen this
    // activity yet" is a normal state right after adding a course in Moodle.
    const { rows: activity } = await sql<{ ok: number }>(
      `select 1 as ok from course_activities where moodle_course_id = $1 and cmid = $2`,
      [body.courseId, body.cmid],
    );
    if (activity.length === 0) {
      return reply.code(409).send({
        error: 'Moodify does not know that activity. Run a full re-sync, then try again.',
      });
    }
    const { rows: cohort } = await sql<{ ok: number }>(
      `select 1 as ok from cohorts where moodle_cohort_id = $1`,
      [body.cohortId],
    );
    if (cohort.length === 0) {
      return reply.code(409).send({ error: 'That cohort no longer exists in Moodle.' });
    }

    const { rows } = await sql<{ id: number }>(
      `insert into deadlines (moodle_course_id, cmid, moodle_cohort_id, month, weekday, nth)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (moodle_course_id, cmid, moodle_cohort_id) do update
          set month = excluded.month, weekday = excluded.weekday, nth = excluded.nth
       returning id`,
      [body.courseId, body.cmid, body.cohortId, body.month, body.weekday, body.nth],
    );
    return reply.code(201).send({ id: rows[0]?.id ?? null });
  });

  app.delete('/api/deadlines/:id', auth, async (request, reply) => {
    const parsed = idParam.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid deadline id.' });
    const result = await sql('delete from deadlines where id = $1', [parsed.data.id]);
    if (result.rowCount === 0) return reply.code(404).send({ error: 'No such deadline.' });
    return reply.code(204).send();
  });
}
