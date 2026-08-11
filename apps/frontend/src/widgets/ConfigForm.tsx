import { useEffect, useState } from 'react';
import type { Course, MoodleUser, Widget } from '@moodify/shared';
import { api, errorMessage } from '@/lib/api';
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const [c, u] = await Promise.all([
          api.get<Course[]>('/api/courses'),
          api.get<MoodleUser[]>('/api/users'),
        ]);
        setCourses(c);
        setUsers(u);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const set = (key: string, value: unknown) => setConfig((prev) => ({ ...prev, [key]: value }));

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
            </Select>
            <p className="mt-1 text-xs text-muted">
              A week is the maximum: samples older than that are deleted, so the chart
              always shows the last seven days rather than emptying itself.
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

      {widget.type === 'progress_chart' ? null : densityPicker()}
      {widget.type === 'badge_cards' || widget.type === 'badge_list' || widget.type === 'user_list'
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
