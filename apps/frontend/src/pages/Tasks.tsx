import { useCallback, useEffect, useState } from 'react';
import {
  DEADLINE_WS_FUNCTIONS,
  MONTH_NAMES,
  WEEKDAY_NAMES,
  describeDeadlineRule,
  type Cohort,
  type Course,
  type CourseActivity,
  type Deadline,
} from '@moodify/shared';
import { CalendarClock, Trash2 } from 'lucide-react';
import { api, cn, errorMessage } from '@/lib/api';
import { Button, Card, EmptyState, ErrorNote, Input, Label, Select, Spinner } from '@/ui';

/**
 * Tasks: "this activity has to be done by this date".
 *
 * Two ways to say when. A fixed date is the common one and means exactly what it says.
 * A yearly rule — "the first Monday in September" — rolls forward on its own and is
 * measured against whoever is in the cohort that year, which is what a recurring
 * apprenticeship deadline actually needs.
 *
 * A task with no cohort applies to everyone enrolled in the course. Overdue tasks turn
 * the completion bars and ring segments red; the ones already due set the target mark on
 * the Progress rings widget.
 */
export default function Tasks() {
  const [deadlines, setDeadlines] = useState<Deadline[] | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [activities, setActivities] = useState<CourseActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [courseId, setCourseId] = useState('');
  const [cmid, setCmid] = useState('');
  const [cohortId, setCohortId] = useState('');
  const [mode, setMode] = useState<'date' | 'yearly'>('date');
  const [date, setDate] = useState('');
  const [nth, setNth] = useState('1');
  const [weekday, setWeekday] = useState('1');
  const [month, setMonth] = useState('9');

  const load = useCallback(async () => {
    try {
      const [d, c, co] = await Promise.all([
        api.get<Deadline[]>('/api/deadlines'),
        api.get<Course[]>('/api/courses'),
        api.get<Cohort[]>('/api/cohorts'),
      ]);
      setDeadlines(d);
      setCourses(c);
      setCohorts(co);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Activities belong to one course, so the second dropdown reloads whenever the first
  // changes — and the chosen activity is cleared, since it cannot survive the move.
  useEffect(() => {
    setCmid('');
    if (courseId === '') {
      setActivities([]);
      return;
    }
    void api
      .get<CourseActivity[]>(`/api/courses/${courseId}/activities`)
      .then(setActivities)
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [courseId]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/deadlines', {
        courseId: Number(courseId),
        cmid: Number(cmid),
        cohortId: cohortId === '' ? null : Number(cohortId),
        ...(mode === 'date'
          ? { date }
          : { month: Number(month), weekday: Number(weekday), nth: Number(nth) }),
      });
      setCmid('');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await api.del(`/api/deadlines/${id}`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const complete = courseId !== '' && cmid !== '' && (mode === 'yearly' || date !== '');

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-xl font-semibold">Tasks</h1>

      <Card className="space-y-4">
        <h2 className="flex items-center gap-2 font-medium">
          <CalendarClock className="h-4 w-4 text-muted" />
          New task
        </h2>
        <p className="text-xs text-muted">
          Needs {DEADLINE_WS_FUNCTIONS.map((fn) => <code key={fn}>{fn} </code>)} on the Moodle
          External Service, then a full re-sync.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="dl-course">Course</Label>
            <Select id="dl-course" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
              <option value="">Select a course…</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.fullname}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="dl-activity">Activity</Label>
            <Select
              id="dl-activity"
              value={cmid}
              disabled={courseId === ''}
              onChange={(e) => setCmid(e.target.value)}
            >
              <option value="">
                {courseId === ''
                  ? 'Pick a course first'
                  : activities.length === 0
                    ? 'No activities synced for this course'
                    : 'Select an activity…'}
              </option>
              {activities.map((activity) => (
                <option key={activity.cmid} value={activity.cmid}>
                  {activity.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div>
          <Label htmlFor="dl-cohort">Applies to</Label>
          <Select id="dl-cohort" value={cohortId} onChange={(e) => setCohortId(e.target.value)}>
            <option value="">Everyone in the course</option>
            {cohorts.map((cohort) => (
              <option key={cohort.id} value={cohort.id}>
                {cohort.name} ({cohort.memberCount})
              </option>
            ))}
          </Select>
          {cohorts.length === 0 ? (
            <p className="mt-1 text-xs text-muted">
              No cohorts synced yet — a task can still apply to the whole course.
            </p>
          ) : null}
        </div>

        <div>
          <Label>Due</Label>
          <div className="mb-2 flex gap-2">
            {(
              [
                ['date', 'On a date'],
                ['yearly', 'Every year'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={cn(
                  'flex-1 rounded-xl border px-3 py-2 text-sm transition',
                  mode === value
                    ? 'border-accent bg-accent/15 text-ink'
                    : 'border-edge text-muted hover:text-ink',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === 'date' ? (
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <Select value={nth} onChange={(e) => setNth(e.target.value)}>
                <option value="1">First</option>
                <option value="2">Second</option>
                <option value="3">Third</option>
                <option value="4">Fourth</option>
                <option value="5">Fifth</option>
                <option value="-1">Last</option>
              </Select>
              <Select value={weekday} onChange={(e) => setWeekday(e.target.value)}>
                {WEEKDAY_NAMES.map((name, index) => (
                  <option key={name} value={index}>
                    {name}
                  </option>
                ))}
              </Select>
              <Select value={month} onChange={(e) => setMonth(e.target.value)}>
                {MONTH_NAMES.map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <p className="mt-1 text-xs text-muted">
            {mode === 'date'
              ? 'Counts as overdue from the end of that day.'
              : 'Takes effect at its first occurrence after you add it, then repeats yearly.'}
          </p>
        </div>

        {error ? <ErrorNote message={error} /> : null}
        <Button onClick={() => void add()} disabled={!complete || busy}>
          {busy ? <Spinner className="h-4 w-4" /> : null}
          Add task
        </Button>
      </Card>

      {deadlines === null ? (
        <div className="grid place-items-center py-10">
          <Spinner className="h-8 w-8" />
        </div>
      ) : deadlines.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="h-6 w-6" />}
          title="No tasks yet"
          hint="Nothing is being tracked against a date, so nothing can be overdue."
        />
      ) : (
        <ul className="space-y-2">
          {deadlines.map((deadline) => (
            <li key={deadline.id}>
              <Card className="flex items-start gap-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{deadline.activityName}</p>
                  <p className="truncate text-xs text-muted">
                    {deadline.courseName} · {deadline.cohortName ?? 'Everyone'} ·{' '}
                    {describeDeadlineRule(deadline)}
                  </p>
                  <p className={cn('text-xs', deadline.dueAt === null ? 'text-muted' : 'text-warn')}>
                    {deadline.dueAt === null
                      ? deadline.nextDueAt === null
                        ? 'No date'
                        : `Due ${new Date(deadline.nextDueAt).toLocaleDateString()}`
                      : `Due since ${new Date(deadline.dueAt).toLocaleDateString()}`}
                    {deadline.dueAt !== null && deadline.nextDueAt !== null
                      ? ` · next ${new Date(deadline.nextDueAt).toLocaleDateString()}`
                      : ''}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Delete task"
                  onClick={() => void remove(deadline.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
