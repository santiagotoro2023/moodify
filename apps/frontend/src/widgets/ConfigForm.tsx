import { useEffect, useState } from 'react';
import {
  RING_COLORS,
  RING_COLOR_LABELS,
  SECTION_SEPARATOR,
  type Cohort,
  type Course,
  type CourseSection,
  type MoodleUser,
  type RingSectionSplit,
  type Widget,
} from '@moodify/shared';
import { api, cn, errorMessage } from '@/lib/api';
import { ringColorAt } from './index';
import { Button, ErrorNote, Input, Label, Select, Spinner, Switch } from '@/ui';

type Config = Record<string, unknown>;

const num = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/** Per-type configuration form, mirroring the zod schemas in @moodify/shared. */
export function WidgetConfigForm({
  widget,
  onSaved,
  onCancel,
}: {
  widget: Widget;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [config, setConfig] = useState<Config>((widget.config as Config) ?? {});
  const [courses, setCourses] = useState<Course[]>([]);
  const [users, setUsers] = useState<MoodleUser[]>([]);
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  /** Course id -> its section names in Moodle's order. Loaded only for ticked courses. */
  const [sections, setSections] = useState<Record<number, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const [c, u, co] = await Promise.all([
          api.get<Course[]>('/api/courses'),
          api.get<MoodleUser[]>('/api/users'),
          api.get<Cohort[]>('/api/cohorts'),
        ]);
        setCourses(c);
        setUsers(u);
        setCohorts(co);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const set = (key: string, value: unknown) => setConfig((prev) => ({ ...prev, [key]: value }));

  // Section names for whichever courses are currently ticked in the rings widget. Fetched
  // here rather than shipped with /api/courses because only this one widget needs them,
  // and only for the handful of courses actually in the ring. The endpoint asks Moodle
  // directly, so sections with nothing completion-tracked in them are listed too.
  const ringCourseIdsRaw = Array.isArray(config.courseIds) ? (config.courseIds as number[]) : [];
  const ringCourseKey = ringCourseIdsRaw.join(',');
  useEffect(() => {
    if (widget.type !== 'completion_rings' || ringCourseKey === '') return;
    void (async () => {
      const wanted = ringCourseKey.split(',').map(Number);
      const loaded = await Promise.all(
        wanted.map(async (courseId) => {
          // Moodle returns a subsection as a section in its own right, so this list
          // already holds both the parents and their children — no need to reconstruct
          // ancestors out of the labels.
          const found = await api.get<CourseSection[]>(`/api/courses/${courseId}/sections`);
          return [courseId, found.map((section) => section.name)] as [number, string[]];
        }),
      );
      setSections(Object.fromEntries(loaded));
    })().catch(() => {
      // A failed section list only costs the split picker; the rest of the form works.
      setSections({});
    });
  }, [widget.type, ringCourseKey]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/widgets/${widget.id}`, { config });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner />;

  const scope = String(config.scope ?? 'all');
  const id = (suffix: string) => `w${widget.id}-${suffix}`;

  const coursePicker = (label = 'Course') => (
    <div>
      <Label htmlFor={id('course')}>{label}</Label>
      <Select
        id={id('course')}
        value={String(config.courseId ?? '')}
        onChange={(e) => set('courseId', num(e.target.value))}
      >
        <option value="">Select a course…</option>
        {courses.map((course) => (
          <option key={course.id} value={course.id}>
            {course.fullname}
          </option>
        ))}
      </Select>
    </div>
  );

  const userPicker = () => (
    <div>
      <Label htmlFor={id('user')}>Student</Label>
      <Select
        id={id('user')}
        value={String(config.userId ?? '')}
        onChange={(e) => set('userId', num(e.target.value))}
      >
        <option value="">Select a student…</option>
        {users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.fullname}
          </option>
        ))}
      </Select>
    </div>
  );

  const scopePicker = () => (
    <div>
      <Label htmlFor={id('scope')}>Scope</Label>
      <Select id={id('scope')} value={scope} onChange={(e) => set('scope', e.target.value)}>
        <option value="all">All courses</option>
        <option value="course">A specific course</option>
      </Select>
    </div>
  );

  const excluded = Array.isArray(config.excludeUserIds) ? (config.excludeUserIds as number[]) : [];
  const toggleExcluded = (uid: number) =>
    set(
      'excludeUserIds',
      excluded.includes(uid) ? excluded.filter((x) => x !== uid) : [...excluded, uid],
    );

  /** Opt-out list: everyone is shown unless explicitly ticked here. */
  const excludePicker = () => (
    <div>
      <Label>Exclude students</Label>
      <p className="mb-2 text-xs text-muted">
        Ticked students are hidden from this widget and left out of its averages and
        rankings — useful for test accounts.
      </p>
      {users.length === 0 ? (
        <p className="text-xs text-muted">No students synced yet.</p>
      ) : (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-edge p-2">
          {users.map((user) => (
            <label
              key={user.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-surface"
            >
              <input
                type="checkbox"
                className="accent-accent"
                checked={excluded.includes(user.id)}
                onChange={() => toggleExcluded(user.id)}
              />
              <span className="truncate">{user.fullname}</span>
            </label>
          ))}
        </div>
      )}
      {excluded.length > 0 ? (
        <button
          type="button"
          onClick={() => set('excludeUserIds', [])}
          className="mt-1 text-xs text-accent underline underline-offset-2"
        >
          Clear {excluded.length} exclusion{excluded.length === 1 ? '' : 's'}
        </button>
      ) : null}
    </div>
  );

  const chartUserIds = Array.isArray(config.userIds) ? (config.userIds as number[]) : [];
  const toggleChartUser = (uid: number) =>
    set(
      'userIds',
      chartUserIds.includes(uid)
        ? chartUserIds.filter((x) => x !== uid)
        : [...chartUserIds, uid],
    );

  /** Opt-IN list, the mirror of excludePicker: nothing ticked means "everyone". */
  const chartUserPicker = () => (
    <div>
      <Label>Students on the chart</Label>
      <p className="mb-2 text-xs text-muted">
        Tick nobody to chart everyone in scope, or pick exactly who should race.
      </p>
      {users.length === 0 ? (
        <p className="text-xs text-muted">No students synced yet.</p>
      ) : (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-edge p-2">
          {users.map((user) => (
            <label
              key={user.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-surface"
            >
              <input
                type="checkbox"
                className="accent-accent"
                checked={chartUserIds.includes(user.id)}
                onChange={() => toggleChartUser(user.id)}
              />
              <span className="truncate">{user.fullname}</span>
            </label>
          ))}
        </div>
      )}
      {chartUserIds.length > 0 ? (
        <button
          type="button"
          onClick={() => set('userIds', [])}
          className="mt-1 text-xs text-accent underline underline-offset-2"
        >
          Clear selection — chart everyone
        </button>
      ) : null}
    </div>
  );

  const ringCourseIds = Array.isArray(config.courseIds) ? (config.courseIds as number[]) : [];
  const ringCohortIds = Array.isArray(config.cohortIds) ? (config.cohortIds as number[]) : [];

  /**
   * Ordered multi-select: ticking appends, so the list order is the segment order
   * around the ring and therefore the colour each course gets. Untick and re-tick to
   * move a course to the end.
   */
  const ringCoursePicker = () => (
    <div>
      <Label>Courses in the ring</Label>
      <p className="mb-2 text-xs text-muted">
        Each course becomes one segment, in the order you tick them — which is also the
        order of the colours. Tick nothing for every visible course; either way a person's
        ring only shows the courses they are actually enrolled in.
      </p>
      {courses.length === 0 ? (
        <p className="text-xs text-muted">No courses synced yet.</p>
      ) : (
        <div className="max-h-44 space-y-1 overflow-y-auto rounded-xl border border-edge p-2">
          {courses.map((course) => {
            const position = ringCourseIds.indexOf(course.id);
            return (
              <label
                key={course.id}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-surface"
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={position >= 0}
                  onChange={() =>
                    set(
                      'courseIds',
                      position >= 0
                        ? ringCourseIds.filter((x) => x !== course.id)
                        : [...ringCourseIds, course.id],
                    )
                  }
                />
                <span className="truncate">{course.fullname}</span>
                {position >= 0 ? (
                  <span className="ml-auto shrink-0 text-xs text-muted">#{position + 1}</span>
                ) : null}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );

  const ringSplits: Record<string, RingSectionSplit[]> =
    typeof config.splits === 'object' && config.splits !== null
      ? (config.splits as Record<string, RingSectionSplit[]>)
      : {};
  const splitOf = (courseId: number) => ringSplits[String(courseId)] ?? [];
  const setSplit = (courseId: number, next: RingSectionSplit[]) => {
    const copy = { ...ringSplits };
    // Drop the key rather than storing an empty array: "no entry" is what the backend
    // reads as "keep this course whole", and two ways of saying it is one too many.
    if (next.length === 0) delete copy[String(courseId)];
    else copy[String(courseId)] = next;
    set('splits', copy);
  };

  /** Per-course section split: tick the sections that deserve a bar of their own. */
  const ringSplitPicker = () => (
    <div>
      <Label>Split courses into sections</Label>
      <p className="mb-2 text-xs text-muted">
        A course you leave alone is one bar for the whole course. Tick sections instead and
        that course becomes one bar per ticked section, each with its own completion and its
        own tasks — sections you do not tick simply do not appear. Ticking a parent section
        gathers everything nested under it, so you can have one bar for all of it or one per
        subsection. Only courses ticked above can be split. A section with nothing
        completion-tracked in it can be ticked too — its bar just stays empty until an
        activity in it gets completion turned on in Moodle. Naming happens further down,
        under Segments, where whole courses are named the same way.
      </p>
      {ringCourseIds.length === 0 ? (
        <p className="text-xs text-muted">Tick some courses above first.</p>
      ) : (
        <div className="space-y-2">
          {ringCourseIds.map((courseId) => {
            const course = courses.find((c) => c.id === courseId);
            const available = sections[courseId];
            const chosen = splitOf(courseId);
            return (
              <div key={courseId} className="rounded-xl border border-edge p-2">
                <p className="mb-1 truncate text-sm font-medium">
                  {course?.fullname ?? `Course ${courseId}`}
                </p>
                {available === undefined ? (
                  <p className="text-xs text-muted">Loading sections…</p>
                ) : available.length === 0 ? (
                  <p className="text-xs text-muted">
                    No completion-tracked activities synced for this course yet.
                  </p>
                ) : (
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {available.map((section) => {
                      const picked = chosen.find((entry) => entry.section === section);
                      const parts = section.split(SECTION_SEPARATOR);
                      const leaf = parts[parts.length - 1] ?? section;
                      return (
                        <div
                          key={section}
                          className="flex items-center gap-2 text-sm"
                          style={{ paddingLeft: `${(parts.length - 1) * 0.9}rem` }}
                        >
                          <input
                            type="checkbox"
                            className="accent-accent"
                            checked={picked !== undefined}
                            onChange={() =>
                              setSplit(
                                courseId,
                                picked === undefined
                                  ? [...chosen, { section, label: '' }]
                                  : chosen.filter((entry) => entry.section !== section),
                              )
                            }
                          />
                          <span className="min-w-0 flex-1 truncate" title={section}>
                            {leaf}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  /**
   * The segments this config will produce, in the order the ring draws them — the same
   * rule the backend applies, so the colour keys here are the ones it will look up.
   */
  const ringColors: Record<string, string> =
    typeof config.colors === 'object' && config.colors !== null
      ? (config.colors as Record<string, string>)
      : {};

  const ringLabels: Record<string, string> =
    typeof config.labels === 'object' && config.labels !== null
      ? (config.labels as Record<string, string>)
      : {};

  const ringSegments = ringCourseIds
    .flatMap((courseId) => {
      const course = courses.find((c) => c.id === courseId);
      const name = course?.fullname ?? `Course ${courseId}`;
      const chosen = splitOf(courseId);
      // `fallback` is what the legend shows with no override — the same choice the
      // backend makes, so the placeholder is never a lie about what you will get.
      if (chosen.length === 0) {
        return [{ key: String(courseId), title: name, fallback: course?.shortname ?? name }];
      }
      return chosen.map((entry) => ({
        key: `${courseId}:${entry.section}`,
        title: `${name} — ${entry.section}`,
        fallback: entry.label === '' ? entry.section : entry.label,
      }));
    })
    // Same rule the widget applies, so the preview swatch is the colour actually drawn.
    .map((segment, index, all) => ({
      ...segment,
      color:
        (config.colorMode === 'manual' ? ringColors[segment.key] : undefined) ??
        ringColorAt(index, all.length),
    }));

  /**
   * One row per segment: what it is called, and what colour it is drawn in. Both are
   * per-segment overrides of the same thing, so they belong on the same row — a course
   * and a section of a course are named through one mechanism rather than two.
   */
  const ringSegmentPicker = () => (
    <div>
      <Label htmlFor={id('colorMode')}>Segments</Label>
      <Select
        id={id('colorMode')}
        value={String(config.colorMode ?? 'auto')}
        onChange={(e) => set('colorMode', e.target.value)}
      >
        <option value="auto">Automatic colours — spaced as far apart as the count allows</option>
        <option value="manual">Pick a colour per segment</option>
      </Select>
      {ringSegments.length === 0 ? (
        <p className="mt-2 text-xs text-muted">
          Tick some courses above to name and colour them. With no course ticked the ring
          shows every visible course under its Moodle short name, coloured automatically.
        </p>
      ) : (
        <div className="mt-2 space-y-3">
          <p className="text-xs text-muted">
            Rename any segment for the legend — the tooltip still shows the real course and
            section, so a short name stays traceable.{' '}
            {config.colorMode === 'manual'
              ? 'Any colour you leave unset stays automatic.'
              : 'The first swatch is the colour the ring generates; click another to override it.'}{' '}
            Red is not on the list — in a ring it means an overdue task and nothing else.
          </p>
          {ringSegments.map((segment) => (
            <div key={segment.key}>
              <p className="mb-1 truncate text-xs text-muted" title={segment.title}>
                {segment.title}
              </p>
              <Input
                className="mb-1 py-1 text-xs"
                value={ringLabels[segment.key] ?? ''}
                maxLength={40}
                placeholder={segment.fallback}
                aria-label={`Legend text for ${segment.title}`}
                onChange={(e) => {
                  const next = { ...ringLabels };
                  // Delete rather than store '': an empty override and no override mean
                  // the same thing, and two ways to say it is one too many.
                  if (e.target.value === '') delete next[segment.key];
                  else next[segment.key] = e.target.value;
                  set('labels', next);
                }}
              />
              <div className="flex flex-wrap items-center gap-1">
                {/* The colour the ring is drawing today, whichever mode is on: the swatch
                    row doubles as a preview, so it is worth showing before you commit to
                    overriding anything. */}
                <span
                  className="mr-1 h-6 w-6 shrink-0 rounded-full ring-1 ring-edge"
                  title="Currently drawn"
                  style={{ background: segment.color }}
                />
                {RING_COLORS.map((color) => {
                  const picked = config.colorMode === 'manual' && ringColors[segment.key] === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      title={RING_COLOR_LABELS[color]}
                      aria-label={`${RING_COLOR_LABELS[color]} for ${segment.title}`}
                      aria-pressed={picked}
                      // Also flips the mode: hiding the swatches behind the dropdown made
                      // them impossible to find, and clicking a colour can only mean one
                      // thing anyway.
                      onClick={() =>
                        setConfig((prev) => ({
                          ...prev,
                          colorMode: 'manual',
                          colors: { ...ringColors, [segment.key]: color },
                        }))
                      }
                      className={cn(
                        'h-6 w-6 rounded-full border-2 transition',
                        picked ? 'border-ink scale-110' : 'border-transparent hover:scale-110',
                      )}
                      style={{ background: color }}
                    />
                  );
                })}
                {ringColors[segment.key] === undefined ? null : (
                  <button
                    type="button"
                    onClick={() => {
                      const next = { ...ringColors };
                      delete next[segment.key];
                      set('colors', next);
                    }}
                    className="ml-1 text-xs text-accent underline underline-offset-2"
                  >
                    Auto
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const ringCohortPicker = () => (
    <div>
      <Label>Cohorts</Label>
      <p className="mb-2 text-xs text-muted">
        Tick nobody to show every student in those courses, or pick one or more cohorts —
        e.g. just the first-year class.
      </p>
      {cohorts.length === 0 ? (
        <p className="text-xs text-muted">
          No cohorts synced. They need <code>core_cohort_get_cohorts</code> and{' '}
          <code>core_cohort_get_cohort_members</code> on the Moodle External Service.
        </p>
      ) : (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-edge p-2">
          {cohorts.map((cohort) => (
            <label
              key={cohort.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-surface"
            >
              <input
                type="checkbox"
                className="accent-accent"
                checked={ringCohortIds.includes(cohort.id)}
                onChange={() =>
                  set(
                    'cohortIds',
                    ringCohortIds.includes(cohort.id)
                      ? ringCohortIds.filter((x) => x !== cohort.id)
                      : [...ringCohortIds, cohort.id],
                  )
                }
              />
              <span className="truncate">{cohort.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted">{cohort.memberCount}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );

  /** Sort control shared by the widgets that render a list of rows. */
  const sortPicker = (
    options: { value: string; label: string }[],
    fallback: string,
    dirFallback: 'asc' | 'desc',
  ) => (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <Label htmlFor={id('sortBy')}>Sort by</Label>
        <Select
          id={id('sortBy')}
          value={String(config.sortBy ?? fallback)}
          onChange={(e) => set('sortBy', e.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      {dirPicker(dirFallback)}
    </div>
  );

  const dirPicker = (fallback: 'asc' | 'desc') => (
    <div>
      <Label htmlFor={id('sortDir')}>Direction</Label>
      <Select
        id={id('sortDir')}
        value={String(config.sortDir ?? fallback)}
        onChange={(e) => set('sortDir', e.target.value)}
      >
        <option value="asc">Ascending</option>
        <option value="desc">Descending</option>
      </Select>
    </div>
  );

  /** Badge icon size. Only on the widgets that draw badges. */
  const badgeSizePicker = () => (
    <div>
      <Label htmlFor={id('badgeSize')}>Badge size</Label>
      <Select
        id={id('badgeSize')}
        value={String(config.badgeSize ?? 'small')}
        onChange={(e) => set('badgeSize', e.target.value)}
      >
        <option value="small">Small</option>
        <option value="medium">Medium</option>
        <option value="large">Large</option>
      </Select>
    </div>
  );

  /** Row height. Offered on every widget type (see WIDGET_CONFIG_SCHEMAS). */
  const densityPicker = () => (
    <div>
      <Label htmlFor={id('density')}>Row size</Label>
      <Select
        id={id('density')}
        value={String(config.density ?? 'normal')}
        onChange={(e) => set('density', e.target.value)}
      >
        <option value="compact">Compact — fits the most rows</option>
        <option value="normal">Normal</option>
        <option value="roomy">Roomy — easiest to read from a distance</option>
      </Select>
    </div>
  );

  const staffToggle = () => (
    <div className="flex items-center justify-between gap-4">
      <Label htmlFor={id('staff')} className="mb-0">
        Include teachers and staff
        <span className="mt-0.5 block text-xs font-normal text-muted">
          Off by default, so staff do not skew averages.
        </span>
      </Label>
      <Switch
        id={id('staff')}
        checked={Boolean(config.includeStaff)}
        onCheckedChange={(v) => set('includeStaff', v)}
      />
    </div>
  );

  return (
    <div className="space-y-4">
      {widget.type === 'completion_table' ? (
        <>
          {scopePicker()}
          {scope === 'course' ? coursePicker() : null}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor={id('sortBy')}>Sort by</Label>
              <Select
                id={id('sortBy')}
                value={String(config.sortBy ?? 'name')}
                onChange={(e) => set('sortBy', e.target.value)}
              >
                <option value="name">Name</option>
                <option value="percent">Completion</option>
                <option value="course">Course</option>
              </Select>
            </div>
            <div>
              <Label htmlFor={id('sortDir')}>Direction</Label>
              <Select
                id={id('sortDir')}
                value={String(config.sortDir ?? 'asc')}
                onChange={(e) => set('sortDir', e.target.value)}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </Select>
            </div>
          </div>
          {staffToggle()}
          {excludePicker()}
        </>
      ) : null}

      {widget.type === 'badge_cards' || widget.type === 'badge_list' ? (
        <>
          <div>
            <Label htmlFor={id('bscope')}>Scope</Label>
            <Select
              id={id('bscope')}
              value={String(config.scope ?? 'course')}
              onChange={(e) => set('scope', e.target.value)}
            >
              <option value="course">Everyone in a course</option>
              <option value="user">One student</option>
            </Select>
          </div>
          {config.scope === 'user' ? userPicker() : coursePicker()}
          {config.scope !== 'user'
            ? sortPicker(
                [
                  { value: 'badges', label: 'Badge count' },
                  { value: 'percent', label: 'Completion' },
                  { value: 'name', label: 'Name' },
                ],
                'badges',
                'desc',
              )
            : null}
          {config.scope !== 'user' ? staffToggle() : null}
          {config.scope !== 'user' ? excludePicker() : null}
        </>
      ) : null}

      {widget.type === 'course_overview' ? (
        <>
          {coursePicker()}
          {staffToggle()}
          {excludePicker()}
        </>
      ) : null}

      {widget.type === 'leaderboard' ? (
        <>
          {scopePicker()}
          {scope === 'course' ? coursePicker() : null}
          <div>
            <Label htmlFor={id('limit')}>Show top</Label>
            <Input
              id={id('limit')}
              type="number"
              min={1}
              max={100}
              value={String(config.limit ?? 10)}
              onChange={(e) => set('limit', Number(e.target.value))}
            />
          </div>
          {dirPicker('desc')}
          {staffToggle()}
          {excludePicker()}
        </>
      ) : null}

      {widget.type === 'progress_chart' ? (
        <>
          <div>
            <Label htmlFor={id('metric')}>Show</Label>
            <Select
              id={id('metric')}
              value={String(config.metric ?? 'badges')}
              onChange={(e) => set('metric', e.target.value)}
            >
              <option value="badges">Badges over time</option>
              <option value="percent">Completion over time</option>
            </Select>
          </div>
          {scopePicker()}
          {scope === 'course' ? coursePicker() : null}
          <div>
            <Label htmlFor={id('window')}>Time span</Label>
            <Select
              id={id('window')}
              value={String(config.window ?? 'auto')}
              onChange={(e) => set('window', e.target.value)}
            >
              <option value="auto">Automatic — grows to a week, then rolls</option>
              <option value="6h">Last 6 hours</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="all">All time — including before Moodify</option>
            </Select>
            <p className="mt-1 text-xs text-muted">
              {config.window === 'all'
                ? 'Rebuilt from the dates Moodle itself recorded against each badge and each ' +
                  'completed activity, so it covers the whole course, not just since Moodify ' +
                  'was installed. Past percentages are measured against the activities the ' +
                  'course has today.'
                : 'A week is the maximum for the live samples Moodify records: older ones are ' +
                  'deleted, so the chart shows the last seven days rather than emptying itself.'}
            </p>
          </div>
          {config.window !== undefined && config.window !== 'auto' ? (
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor={id('fullWindow')} className="mb-0">
                Draw the whole span
                <span className="mt-0.5 block text-xs font-normal text-muted">
                  Keeps the time axis fixed and lets the lines advance across it, instead
                  of the axis shrinking to fit however much data exists.
                </span>
              </Label>
              <Switch
                id={id('fullWindow')}
                checked={config.fullWindow === true}
                onCheckedChange={(v) => set('fullWindow', v)}
              />
            </div>
          ) : null}
          {chartUserPicker()}
          {chartUserIds.length === 0 ? (
            <div>
              <Label htmlFor={id('limit')}>Show top</Label>
              <Input
                id={id('limit')}
                type="number"
                min={1}
                max={20}
                value={String(config.limit ?? 8)}
                onChange={(e) => set('limit', Number(e.target.value))}
              />
              <p className="mt-1 text-xs text-muted">
                Ranked by their current value, so the chart stays readable in a big class.
              </p>
            </div>
          ) : null}
          <div>
            <Label htmlFor={id('marker')}>Label each line with</Label>
            <Select
              id={id('marker')}
              value={String(config.marker ?? 'name')}
              onChange={(e) => set('marker', e.target.value)}
            >
              <option value="name">Their name</option>
              <option value="avatar">Their profile picture</option>
              <option value="both">Picture and name</option>
              <option value="none">Nothing — legend only</option>
            </Select>
            <p className="mt-1 text-xs text-muted">
              Students with no picture in Moodle get their initials instead. Profile
              pictures are always hidden on an anonymised public dashboard.
            </p>
          </div>
          {config.marker === 'avatar' || config.marker === 'both' ? (
            <div>
              <Label htmlFor={id('avatarSize')}>Picture size</Label>
              <Select
                id={id('avatarSize')}
                value={String(config.avatarSize ?? 'medium')}
                onChange={(e) => set('avatarSize', e.target.value)}
              >
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </Select>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor={id('legend')} className="mb-0">
              Show legend
            </Label>
            <Switch
              id={id('legend')}
              checked={config.showLegend !== false}
              onCheckedChange={(v) => set('showLegend', v)}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor={id('area')} className="mb-0">
              Fill under the lines
              <span className="mt-0.5 block text-xs font-normal text-muted">
                Reads well with a few students, muddy with eight.
              </span>
            </Label>
            <Switch
              id={id('area')}
              checked={config.showArea === true}
              onCheckedChange={(v) => set('showArea', v)}
            />
          </div>
          {staffToggle()}
          {excludePicker()}
        </>
      ) : null}

      {widget.type === 'user_list' ? (
        <>
          {userPicker()}
          {scopePicker()}
          {scope === 'course' ? coursePicker() : null}
          {sortPicker(
            [
              { value: 'course', label: 'Course name' },
              { value: 'percent', label: 'Completion' },
            ],
            'course',
            'asc',
          )}
        </>
      ) : null}

      {widget.type === 'completion_rings' ? (
        <>
          {ringCoursePicker()}
          {ringSplitPicker()}
          {ringSegmentPicker()}
          {ringCohortPicker()}
          {sortPicker(
            [
              { value: 'name', label: 'Name' },
              { value: 'percent', label: 'Overall completion' },
              { value: 'overdue', label: 'Overdue activities' },
              { value: 'courses', label: 'Number of segments' },
            ],
            'name',
            'asc',
          )}
          <p className="-mt-1 text-xs text-muted">
            People who tie on the chosen key are ordered by overall completion, highest
            first, and then by name — so sorting by segment count descending puts the
            busiest people first and, within them, whoever is furthest along.
          </p>
          <div>
            <Label htmlFor={id('ringSize')}>Ring size</Label>
            <Select
              id={id('ringSize')}
              value={String(config.ringSize ?? 'medium')}
              onChange={(e) => set('ringSize', e.target.value)}
            >
              <option value="small">Small — most people on screen</option>
              <option value="medium">Medium</option>
              <option value="large">Large — readable across a room</option>
            </Select>
            <p className="mt-1 text-xs text-muted">
              Sets how densely the rings pack before wrapping. Each ring then fills the
              width it gets, so widening the widget grows the rings rather than the gaps.
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor={id('showTarget')} className="mb-0">
              Show the target mark
              <span className="mt-0.5 block text-xs font-normal text-muted">
                A tick inside each segment for how far the person should be by today,
                from the Tasks page. Nothing is drawn for a course with no tasks.
              </span>
            </Label>
            <Switch
              id={id('showTarget')}
              checked={config.showTarget !== false}
              onCheckedChange={(v) => set('showTarget', v)}
            />
          </div>
          <div>
            <Label htmlFor={id('ringMarker')}>Identify each ring by</Label>
            <Select
              id={id('ringMarker')}
              value={String(config.marker ?? 'name')}
              onChange={(e) => set('marker', e.target.value)}
            >
              <option value="name">Name — percentages in the middle</option>
              <option value="avatar">Profile picture only</option>
              <option value="both">Profile picture and name</option>
            </Select>
            <p className="mt-1 text-xs text-muted">
              A picture takes the middle of the ring, so the per-course percentages move to a
              list underneath. Students with no picture in Moodle get their initials, and
              pictures are always hidden on an anonymised public dashboard.
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor={id('ringLegend')} className="mb-0">
              Show legend
            </Label>
            <Switch
              id={id('ringLegend')}
              checked={config.showLegend !== false}
              onCheckedChange={(v) => set('showLegend', v)}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor={id('ringBadges')} className="mb-0">
              List badges under each ring
              <span className="mt-0.5 block text-xs font-normal text-muted">
                Everything about a person on one tile. Costs a lot of height in a big class.
              </span>
            </Label>
            <Switch
              id={id('ringBadges')}
              checked={config.showBadges === true}
              onCheckedChange={(v) => set('showBadges', v)}
            />
          </div>
          {staffToggle()}
          {excludePicker()}
        </>
      ) : null}

      {widget.type === 'progress_chart' || widget.type === 'completion_rings'
        ? null
        : densityPicker()}
      {widget.type === 'badge_cards' ||
      widget.type === 'badge_list' ||
      widget.type === 'user_list' ||
      (widget.type === 'completion_rings' && config.showBadges === true)
        ? badgeSizePicker()
        : null}

      {error ? <ErrorNote message={error} /> : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={save} disabled={busy}>
          {busy ? <Spinner className="h-4 w-4" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}
