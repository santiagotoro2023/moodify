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

      {widget.type === 'badge_cards' ? (
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
          {staffToggle()}
          {excludePicker()}
        </>
      ) : null}

      {widget.type === 'user_list' ? (
        <>
          {userPicker()}
          {scopePicker()}
          {scope === 'course' ? coursePicker() : null}
        </>
      ) : null}

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
