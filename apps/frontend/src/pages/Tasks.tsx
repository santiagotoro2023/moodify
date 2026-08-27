import { useCallback, useEffect, useState } from 'react';
import {
  DEADLINE_WS_FUNCTIONS,
  MONTH_NAMES,
  WEEKDAY_NAMES,
  describeDeadlineRule,
  formatDay,
  type Cohort,
  type Course,
  type CourseActivity,
  type Deadline,
  type NotificationRuleDto,
  type TaskRecipient,
} from '@moodify/shared';
import { CalendarClock, Send, Trash2 } from 'lucide-react';
import { api, cn, errorMessage } from '@/lib/api';
import { Button, Card, Dialog, EmptyState, ErrorNote, Label, Select, Spinner } from '@/ui';

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
 *
 * Tasks are listed and picked in Moodle's own course-section order, subsections included,
 * because that is the order the person setting them up sees in Moodle itself.
 */

const DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
/** Last year through five ahead: enough for a school year, short enough to scroll. */
const YEARS = Array.from({ length: 7 }, (_, index) => new Date().getFullYear() - 1 + index);

/**
 * yyyy-mm-dd from the three pickers. A day the month does not have (31 February) is
 * clamped by Date itself rather than rejected — picking 31 and then switching to
 * February should not silently submit 3 March.
 */
function isoDate(year: string, month: string, day: string): string {
  const lastOfMonth = new Date(Number(year), Number(month), 0).getDate();
  const safe = Math.min(Number(day), lastOfMonth);
  return `${year}-${month.padStart(2, '0')}-${`${safe}`.padStart(2, '0')}`;
}

/**
 * Groups consecutive items under a heading. Both callers arrive already sorted the way
 * they want to be grouped — by section order from Moodle, not alphabetically — so this
 * walks the list rather than bucketing it, and the order survives.
 */
function groupRuns<T>(items: readonly T[], keyOf: (item: T) => string): [string, T[]][] {
  const groups: [string, T[]][] = [];
  for (const item of items) {
    const key = keyOf(item);
    const last = groups[groups.length - 1];
    if (last !== undefined && last[0] === key) last[1].push(item);
    else groups.push([key, [item]]);
  }
  return groups;
}

const groupBySection = (activities: readonly CourseActivity[]) =>
  groupRuns(activities, (activity) => activity.section);

const groupByCourseSection = (deadlines: readonly Deadline[]) =>
  groupRuns(deadlines, (deadline) =>
    deadline.section === ''
      ? deadline.courseName
      : `${deadline.courseName} › ${deadline.section}`,
  );

/**
 * The date a task is actually about: the occurrence in force if it has passed, otherwise
 * the next one. Past dates are smaller numbers, so sorting on this puts the overdue work
 * at the top on its own, without a second comparator to say so. A task whose one-off date
 * has gone and will not come round again sorts last rather than first.
 */
function dueKey(deadline: Deadline): number {
  const at = deadline.dueAt ?? deadline.nextDueAt;
  return at === null ? Number.POSITIVE_INFINITY : new Date(at).getTime();
}

/** Reads as the admin thinks of it — "5 days before" — not as the row is stored. */
function ruleLabel(rule: NotificationRuleDto): string {
  const when = rule.kind === 'overdue' ? 'When overdue' : `${rule.daysBefore} days before`;
  return rule.enabled ? when : `${when} (off)`;
}

/**
 * Sending one task's reminder by hand.
 *
 * Deliberately not "send to everyone who is behind" — that is what the scheduled pass is
 * for. This is for the single student who needs a nudge, so the recipients are listed by
 * name and ticked individually, with whoever already finished the work shown but not
 * selectable: mailing them is never the intent, and hiding them would look like the list
 * had lost people.
 */
function SendDialog({
  deadline,
  rules,
  onClose,
}: {
  deadline: Deadline;
  rules: NotificationRuleDto[];
  onClose: () => void;
}) {
  const [recipients, setRecipients] = useState<TaskRecipient[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [ruleId, setRuleId] = useState(String(rules[0]?.id ?? ''));
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .get<TaskRecipient[]>(`/api/deadlines/${deadline.id}/recipients`)
      .then((list) => {
        setRecipients(list);
        // Everyone who could actually receive it, which is the common case; untick from
        // there rather than hunting for the one person in a class of thirty.
        setChosen(
          new Set(list.filter((one) => !one.completed && one.email !== null).map((one) => one.userId)),
        );
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [deadline.id]);

  const toggle = (userId: number) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (!next.delete(userId)) next.add(userId);
      return next;
    });

  const send = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await api.post<{ sent: number }>(`/api/deadlines/${deadline.id}/notify`, {
        ruleId: Number(ruleId),
        userIds: [...chosen],
      });
      setNote(`Sent ${result.sent} ${result.sent === 1 ? 'message' : 'messages'}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Send a reminder — ${deadline.activityName}`}>
      <div className="space-y-4">
        {rules.length === 0 ? (
          <ErrorNote message="No reminder rules exist yet. Add one in Settings first — its wording is what gets sent." />
        ) : (
          <div>
            <Label htmlFor="send-rule">Wording</Label>
            <Select id="send-rule" value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
              {rules.map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {ruleLabel(rule)}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-muted">
              Goes out now, whatever the rule's own timing says, and is recorded so the
              scheduled pass does not send the same thing again.
            </p>
          </div>
        )}

        {recipients === null ? (
          <Spinner className="h-6 w-6" />
        ) : recipients.length === 0 ? (
          <p className="text-sm text-muted">Nobody is enrolled for this task.</p>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-auto">
            {recipients.map((one) => {
              const blocked = one.completed || one.email === null;
              return (
                <li key={one.userId}>
                  <label
                    className={cn(
                      'flex items-center gap-2 rounded-lg px-2 py-1 text-sm',
                      blocked ? 'text-muted' : 'hover:bg-white/5',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--color-progress)]"
                      checked={chosen.has(one.userId)}
                      disabled={blocked}
                      onChange={() => toggle(one.userId)}
                    />
                    <span className="min-w-0 flex-1 truncate">{one.fullname}</span>
                    {one.completed ? (
                      <span className="shrink-0 text-xs text-good">done</span>
                    ) : one.email === null ? (
                      <span className="shrink-0 text-xs text-warn">no address</span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {error ? <ErrorNote message={error} /> : null}
        {note ? <p className="text-sm text-good">{note}</p> : null}

        <div className="flex justify-end gap-2">
          <Button variant="subtle" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void send()} disabled={busy || chosen.size === 0 || ruleId === ''}>
            {busy ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            Send to {chosen.size}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export default function Tasks() {
  const [deadlines, setDeadlines] = useState<Deadline[] | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [activities, setActivities] = useState<CourseActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState<NotificationRuleDto[]>([]);
  const [sending, setSending] = useState<Deadline | null>(null);
  const [byCourse, setByCourse] = useState('');
  /** '' = everything, 'everyone' = the course-wide tasks, otherwise a cohort id. */
  const [byCohort, setByCohort] = useState('');
  const [sortBy, setSortBy] = useState<'moodle' | 'due'>('moodle');

  const [courseId, setCourseId] = useState('');
  const [cmid, setCmid] = useState('');
  const [cohortId, setCohortId] = useState('');
  const [mode, setMode] = useState<'date' | 'yearly'>('date');
  const [day, setDay] = useState(String(new Date().getDate()));
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [nth, setNth] = useState('1');
  const [weekday, setWeekday] = useState('1');
  const [month, setMonth] = useState(String(new Date().getMonth() + 1));

  const load = useCallback(async () => {
    try {
      const [d, c, co, r] = await Promise.all([
        api.get<Deadline[]>('/api/deadlines'),
        api.get<Course[]>('/api/courses'),
        api.get<Cohort[]>('/api/cohorts'),
        api.get<NotificationRuleDto[]>('/api/notifications/rules'),
      ]);
      setDeadlines(d);
      setCourses(c);
      setCohorts(co);
      setRules(r);
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
          ? { date: isoDate(year, month, day) }
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

  const complete = courseId !== '' && cmid !== '';

  const shown = (deadlines ?? []).filter(
    (deadline) =>
      (byCourse === '' || deadline.courseId === Number(byCourse)) &&
      (byCohort === '' ||
        (byCohort === 'everyone'
          ? deadline.cohortId === null
          : deadline.cohortId === Number(byCohort))),
  );
  // Sorting by date cuts across courses and sections, so the grouping that carries the
  // course name has to go with it — one flat list, and the card names its own course.
  const grouped: [string, Deadline[]][] =
    sortBy === 'due'
      ? [['Soonest first', [...shown].sort((a, b) => dueKey(a) - dueKey(b) || a.activityName.localeCompare(b.activityName))]]
      : groupByCourseSection(shown);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <h1 className="text-xl font-semibold">Tasks</h1>

      {/* The form is a fixed-width column beside the list rather than a block above it:
          it is the same eight fields whatever the window is, and stacking it on top
          pushed the thing you came to look at below the fold on a wide screen. It sticks,
          so adding the tenth task does not mean scrolling back up for the form. */}
      <div className="grid items-start gap-5 lg:grid-cols-[24rem_minmax(0,1fr)]">
      <Card className="space-y-4 lg:sticky lg:top-20">
        <h2 className="flex items-center gap-2 font-medium">
          <CalendarClock className="h-4 w-4 text-muted" />
          New task
        </h2>
        <p className="text-xs text-muted">
          Needs {DEADLINE_WS_FUNCTIONS.map((fn) => <code key={fn}>{fn} </code>)} on the Moodle
          External Service, then a full re-sync.
        </p>

        <div className="grid gap-3">
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
              {groupBySection(activities).map(([section, items]) => (
                <optgroup key={section} label={section === '' ? 'Course' : section}>
                  {items.map((activity) => (
                    <option key={activity.cmid} value={activity.cmid}>
                      {activity.name}
                    </option>
                  ))}
                </optgroup>
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
            /* Three selects rather than <input type="date">. That control renders in the
               browser's own locale — mm/dd/yyyy on a US-configured machine — and neither
               the lang attribute nor CSS can change it. A named month cannot be misread. */
            <div className="grid grid-cols-3 gap-2">
              <Select value={day} onChange={(e) => setDay(e.target.value)}>
                {DAYS.map((value) => (
                  <option key={value} value={value}>
                    {value}
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
              <Select value={year} onChange={(e) => setYear(e.target.value)}>
                {YEARS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </div>
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
              ? `${formatDay(isoDate(year, month, day))} — counts as overdue from the end of that day.`
              : 'Takes effect at its first occurrence after you add it, then repeats yearly.'}
          </p>
        </div>

        {error ? <ErrorNote message={error} /> : null}
        <Button onClick={() => void add()} disabled={!complete || busy}>
          {busy ? <Spinner className="h-4 w-4" /> : null}
          Add task
        </Button>
      </Card>

      <div className="space-y-5">
      {/* Filters sit over the list, not over the page: they say nothing about the form
          beside them, and a control that looks like it applies to both is worse than no
          control. Hidden until there is more than a handful to sift through. */}
      {deadlines !== null && deadlines.length > 3 ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <Select
            aria-label="Filter by course"
            value={byCourse}
            onChange={(e) => setByCourse(e.target.value)}
          >
            <option value="">All courses</option>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.fullname}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by who it applies to"
            value={byCohort}
            onChange={(e) => setByCohort(e.target.value)}
          >
            <option value="">Anyone</option>
            <option value="everyone">Whole course only</option>
            {cohorts.map((cohort) => (
              <option key={cohort.id} value={cohort.id}>
                {cohort.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Sort tasks"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value === 'due' ? 'due' : 'moodle')}
          >
            <option value="moodle">Moodle order</option>
            <option value="due">Soonest due first</option>
          </Select>
        </div>
      ) : null}

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
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="h-6 w-6" />}
          title="Nothing matches"
          hint="No task fits the filters above."
        />
      ) : (
        grouped.map(([heading, items]) => (
          <section key={heading} className="space-y-2">
            <h2 className="px-1 text-xs font-medium uppercase tracking-wide text-muted">
              {heading}
            </h2>
            <ul className="grid gap-2 xl:grid-cols-2">
              {items.map((deadline) => (
                <li key={deadline.id}>
                  <Card className="flex items-start gap-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{deadline.activityName}</p>
                      <p className="truncate text-xs text-muted">
                        {sortBy === 'due' ? `${deadline.courseName} · ` : ''}
                        {deadline.cohortName ?? 'Everyone'} · {describeDeadlineRule(deadline)}
                      </p>
                      <p
                        className={cn(
                          'text-xs',
                          deadline.dueAt === null ? 'text-muted' : 'text-warn',
                        )}
                      >
                        {deadline.dueAt === null
                          ? deadline.nextDueAt === null
                            ? 'No date'
                            : `Due ${formatDay(deadline.nextDueAt)}`
                          : `Due since ${formatDay(deadline.dueAt)}`}
                        {deadline.dueAt !== null && deadline.nextDueAt !== null
                          ? ` · next ${formatDay(deadline.nextDueAt)}`
                          : ''}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Send a reminder now"
                      onClick={() => setSending(deadline)}
                    >
                      <Send className="h-4 w-4" />
                    </Button>
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
          </section>
        ))
      )}
      </div>
      </div>

      {sending ? (
        <SendDialog deadline={sending} rules={rules} onClose={() => setSending(null)} />
      ) : null}
    </div>
  );
}
