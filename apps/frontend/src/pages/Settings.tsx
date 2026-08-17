import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEADLINE_WS_FUNCTIONS,
  DEFAULT_LOGO_HEIGHT,
  MONTH_NAMES,
  REQUIRED_WS_FUNCTIONS,
  WEEKDAY_NAMES,
  describeDeadlineRule,
  type BootstrapState,
  type Cohort,
  type ConnectionState,
  type Course,
  type CourseActivity,
  type Deadline,
  type SyncProgress,
} from '@moodify/shared';
import { CalendarClock, CheckCircle2, RefreshCw, Trash2 } from 'lucide-react';
import { api, cn, errorMessage, relativeTime } from '@/lib/api';
import { Button, Card, ErrorNote, Input, Label, Select, Spinner } from '@/ui';

const STATUS_STYLES: Record<string, string> = {
  ok: 'border-good/40 bg-good/10 text-good',
  error: 'border-bad/40 bg-bad/10 text-bad',
  running: 'border-accent/40 bg-accent/10 text-accent',
  never: 'border-edge bg-surface text-muted',
};

export default function Settings() {
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [logoUrl, setLogoUrl] = useState('/brand/moodify-logo.svg');
  const [logoHeight, setLogoHeight] = useState(DEFAULT_LOGO_HEIGHT);
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [conn, boot] = await Promise.all([
        api.get<ConnectionState>('/api/connection'),
        api.get<BootstrapState>('/api/bootstrap'),
      ]);
      setConnection(conn);
      setLogoUrl(boot.logoUrl);
      setLogoHeight(boot.logoHeight);
      setPublicBaseUrl(boot.publicBaseUrl);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!connection) {
    return (
      <div className="grid place-items-center py-20">
        {error ? <ErrorNote message={error} /> : <Spinner className="h-8 w-8" />}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-xl font-semibold">Settings</h1>
      {error ? <ErrorNote message={error} /> : null}

      <ConnectionCard connection={connection} onChanged={load} />
      <SyncCard connection={connection} onChanged={load} />
      <DeadlinesCard />
      <AccessCard publicBaseUrl={publicBaseUrl} onChanged={load} />
      <BrandingCard logoUrl={logoUrl} logoHeight={logoHeight} onChanged={load} />
    </div>
  );
}

function ConnectionCard({
  connection,
  onChanged,
}: {
  connection: ConnectionState;
  onChanged: () => Promise<void>;
}) {
  const [replacing, setReplacing] = useState(false);
  const [mode, setMode] = useState<'token' | 'credentials'>('token');
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? '');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [service, setService] = useState(connection.serviceShortname ?? 'moodle_mobile_app');
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body =
        mode === 'token'
          ? { baseUrl, mode, token }
          : { baseUrl, mode, username, password, serviceShortname: service };
      const result = await api.post<{ missingFunctions?: string[] }>('/api/connection', body);
      setMissing(result.missingFunctions ?? []);
      setReplacing(false);
      setToken('');
      setPassword('');
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4">
      <h2 className="font-medium">Moodle connection</h2>

      {connection.configured ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Site</dt>
          <dd className="truncate">{connection.baseUrl}</dd>
          <dt className="text-muted">Service</dt>
          <dd>{connection.serviceShortname ?? '—'}</dd>
          <dt className="text-muted">Token</dt>
          <dd className="font-mono text-xs">{connection.tokenHint}</dd>
        </dl>
      ) : (
        <p className="text-sm text-muted">No Moodle connection configured yet.</p>
      )}

      {missing.length > 0 ? (
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
          <p className="mb-1 font-medium">Not enabled on the External Service:</p>
          <ul>
            {missing.map((fn) => (
              <li key={fn}>
                <code>{fn}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {test ? (
        <p
          className={cn(
            'rounded-xl border px-3 py-2 text-sm',
            test.ok ? STATUS_STYLES.ok : STATUS_STYLES.error,
          )}
        >
          {test.message}
        </p>
      ) : null}

      {replacing ? (
        <form onSubmit={save} className="space-y-3 border-t border-edge pt-4">
          <div>
            <Label htmlFor="set-url">Moodle base URL</Label>
            <Input id="set-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="set-mode">Method</Label>
            <Select
              id="set-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as 'token' | 'credentials')}
            >
              <option value="token">Paste a web service token</option>
              <option value="credentials">Fetch a token with Moodle credentials</option>
            </Select>
          </div>
          {mode === 'token' ? (
            <div>
              <Label htmlFor="set-token">Token</Label>
              <Input id="set-token" value={token} onChange={(e) => setToken(e.target.value)} required />
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="set-user">Moodle username</Label>
                <Input id="set-user" value={username} onChange={(e) => setUsername(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="set-pass">Moodle password</Label>
                <Input
                  id="set-pass"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="set-service">Service shortname</Label>
                <Input id="set-service" value={service} onChange={(e) => setService(e.target.value)} required />
              </div>
            </>
          )}
          <p className="text-xs text-muted">
            The service needs: {REQUIRED_WS_FUNCTIONS.join(', ')}.
          </p>
          {error ? <ErrorNote message={error} /> : null}
          <div className="flex gap-2">
            <Button variant="subtle" onClick={() => setReplacing(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner className="h-4 w-4" /> : null}
              Save connection
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="subtle" size="sm" onClick={() => setReplacing(true)}>
            {connection.configured ? 'Replace token' : 'Connect Moodle'}
          </Button>
          {connection.configured ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                setTest(null);
                const result = await api.post<{
                  ok: boolean;
                  siteName?: string;
                  canDownloadFiles?: boolean;
                  error?: string;
                }>('/api/connection/test');
                // "Connected" is not the whole story: the service can answer every
                // function and still refuse files, which is what breaks badge images.
                const filesBlocked = result.ok && result.canDownloadFiles === false;
                setTest({
                  ok: result.ok && !filesBlocked,
                  message: !result.ok
                    ? (result.error ?? 'The connection test failed.')
                    : filesBlocked
                      ? `Connected to ${result.siteName ?? 'Moodle'}, but badge images cannot be ` +
                        'downloaded: this web service is not allowed to download files. In Moodle go to ' +
                        'Site administration → Server → Web services → External services → edit your ' +
                        'Moodify service → Show more… → tick "Can download files" → Save, then re-sync.'
                      : `Connected to ${result.siteName ?? 'Moodle'}.`,
                });
              }}
            >
              Test connection
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function SyncCard({
  connection,
  onChanged,
}: {
  connection: ConnectionState;
  onChanged: () => Promise<void>;
}) {
  const [interval, setIntervalSeconds] = useState(connection.pollIntervalSeconds);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const resync = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/sync');
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(async () => {
        const next = await api.get<SyncProgress>('/api/sync/progress');
        setProgress(next);
        if (next.status !== 'running' && timer.current) {
          clearInterval(timer.current);
          void onChanged();
        }
      }, 1500);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const status = connection.lastSyncStatus;

  return (
    <Card className="space-y-4">
      <h2 className="font-medium">Sync</h2>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className={cn('rounded-full border px-2.5 py-0.5 text-xs', STATUS_STYLES[status])}>
          {status}
        </span>
        <span className="text-muted" title={connection.lastSyncAt ?? undefined}>
          Last sync {relativeTime(connection.lastSyncAt)}
        </span>
      </div>

      {connection.lastSyncError ? <ErrorNote message={connection.lastSyncError} /> : null}

      {progress ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          {progress.status === 'running' ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-good" />
          )}
          {progress.phase ?? progress.status} — {progress.courses} courses, {progress.users} users,{' '}
          {progress.badges} badges
        </p>
      ) : null}

      <div>
        <Label htmlFor="poll">Poll interval (seconds)</Label>
        <div className="flex gap-2">
          <Input
            id="poll"
            type="number"
            min={15}
            max={86400}
            value={interval}
            onChange={(e) => setIntervalSeconds(Number(e.target.value))}
          />
          <Button
            variant="subtle"
            onClick={async () => {
              try {
                await api.patch('/api/connection', { pollIntervalSeconds: interval });
                await onChanged();
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            Save
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted">
          A light refresh of completion and badges runs at this interval. A full re-discovery of new
          courses, users and enrolments runs every 15 minutes. Minimum 15 seconds.
        </p>
      </div>

      {error ? <ErrorNote message={error} /> : null}

      <Button variant="subtle" size="sm" onClick={resync} disabled={busy || !connection.configured}>
        <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
        Re-sync now
      </Button>
    </Card>
  );
}

/** Where Moodify is reached from outside — public share links are built from this. */
/**
 * Deadlines: "this activity, for this cohort, by the first Monday in September".
 *
 * Stored as a recurrence rule rather than a date so it rolls into the next year on its
 * own, measured against whoever is in the cohort at that point. A rule takes effect at
 * its first occurrence after it was saved — otherwise entering one in June would report
 * the whole class overdue since last September the moment you pressed Add.
 */
function DeadlinesCard() {
  const [deadlines, setDeadlines] = useState<Deadline[] | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [activities, setActivities] = useState<CourseActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [courseId, setCourseId] = useState('');
  const [cmid, setCmid] = useState('');
  const [cohortId, setCohortId] = useState('');
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
        cohortId: Number(cohortId),
        month: Number(month),
        weekday: Number(weekday),
        nth: Number(nth),
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

  const complete = courseId !== '' && cmid !== '' && cohortId !== '';

  return (
    <Card className="space-y-4">
      <h2 className="flex items-center gap-2 font-medium">
        <CalendarClock className="h-4 w-4 text-muted" />
        Deadlines
      </h2>
      <p className="text-xs text-muted">
        An activity that has to be finished by a given date, per cohort. Anything past its
        date and not completed turns the student's completion bar and ring segment red, and
        sets the target mark on the Progress rings widget. Needs{' '}
        {DEADLINE_WS_FUNCTIONS.join(', ')} on the Moodle External Service.
      </p>

      {cohorts.length === 0 ? (
        <p className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
          No cohorts have been synced yet, so there is nothing to set a deadline for. Add
          the three functions above to the External Service in Moodle, then run a full
          re-sync.
        </p>
      ) : (
        <div className="space-y-3 rounded-xl border border-edge p-3">
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
            <Label htmlFor="dl-cohort">Cohort</Label>
            <Select id="dl-cohort" value={cohortId} onChange={(e) => setCohortId(e.target.value)}>
              <option value="">Select a cohort…</option>
              {cohorts.map((cohort) => (
                <option key={cohort.id} value={cohort.id}>
                  {cohort.name} ({cohort.memberCount})
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="dl-nth">Due, every year</Label>
            <div className="grid grid-cols-3 gap-2">
              <Select id="dl-nth" value={nth} onChange={(e) => setNth(e.target.value)}>
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
            <p className="mt-1 text-xs text-muted">
              Takes effect at its first occurrence after you add it, then repeats yearly.
            </p>
          </div>

          <Button onClick={() => void add()} disabled={!complete || busy}>
            {busy ? <Spinner className="h-4 w-4" /> : null}
            Add deadline
          </Button>
        </div>
      )}

      {deadlines === null ? (
        <Spinner />
      ) : deadlines.length === 0 ? (
        <p className="text-xs text-muted">No deadlines set.</p>
      ) : (
        <ul className="space-y-2">
          {deadlines.map((deadline) => (
            <li
              key={deadline.id}
              className="flex items-start gap-3 rounded-xl border border-edge p-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{deadline.activityName}</p>
                <p className="truncate text-xs text-muted">
                  {deadline.courseName} · {deadline.cohortName} ·{' '}
                  {describeDeadlineRule(deadline)}
                </p>
                <p className="text-xs text-muted">
                  {deadline.dueAt === null
                    ? `Not in force yet — first due ${new Date(deadline.nextDueAt).toLocaleDateString()}`
                    : `Due since ${new Date(deadline.dueAt).toLocaleDateString()} · next ${new Date(deadline.nextDueAt).toLocaleDateString()}`}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete deadline"
                onClick={() => void remove(deadline.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {error ? <ErrorNote message={error} /> : null}
    </Card>
  );
}

function AccessCard({
  publicBaseUrl,
  onChanged,
}: {
  publicBaseUrl: string;
  onChanged: () => Promise<void>;
}) {
  const [value, setValue] = useState(publicBaseUrl);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setValue(publicBaseUrl), [publicBaseUrl]);

  return (
    <Card className="space-y-4">
      <h2 className="font-medium">Public address</h2>
      <div>
        <Label htmlFor="public-url">External URL</Label>
        <div className="flex gap-2">
          <Input
            id="public-url"
            value={value}
            placeholder="https://moodify.example.ch"
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
          />
          <Button
            variant="subtle"
            onClick={async () => {
              try {
                await api.patch('/api/settings', { publicBaseUrl: value.trim() });
                await onChanged();
                setError(null);
                setSaved(true);
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            Save
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted">
          The address your reverse proxy serves Moodify on. Share links are built from it, so
          without it they point at the internal host and port. Leave blank to use whatever
          address the browser is currently on.
        </p>
        {saved ? <p className="mt-1 text-xs text-good">Saved.</p> : null}
        {error ? <ErrorNote message={error} className="mt-2" /> : null}
      </div>
    </Card>
  );
}

function BrandingCard({
  logoUrl,
  logoHeight,
  onChanged,
}: {
  logoUrl: string;
  logoHeight: number;
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(logoHeight);

  useEffect(() => setHeight(logoHeight), [logoHeight]);

  return (
    <Card className="space-y-4">
      <h2 className="font-medium">Branding</h2>

      <div className="flex items-center gap-4">
        <img src={logoUrl} alt="Current logo" style={{ height: `${height}px` }} className="w-auto" />
        <div className="flex-1">
          <input
            type="file"
            accept="image/*"
            aria-label="Upload a custom logo"
            className="w-full text-xs text-muted file:mr-2 file:rounded-lg file:border-0 file:bg-surface-strong file:px-3 file:py-1.5 file:text-ink"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              try {
                await api.upload('/api/settings/logo', file);
                await onChanged();
                setError(null);
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await api.del('/api/settings/logo');
            await onChanged();
          }}
        >
          Reset
        </Button>
      </div>

      <div>
        <Label htmlFor="logo-height">Logo height ({height}px)</Label>
        <div className="flex items-center gap-3">
          <input
            id="logo-height"
            type="range"
            min={16}
            max={160}
            step={2}
            value={height}
            className="w-full accent-accent"
            onChange={(e) => setHeight(Number(e.target.value))}
            onMouseUp={async () => {
              await api.patch('/api/settings', { logoHeight: height }).catch(() => undefined);
              await onChanged();
            }}
            onTouchEnd={async () => {
              await api.patch('/api/settings', { logoHeight: height }).catch(() => undefined);
              await onChanged();
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              setHeight(DEFAULT_LOGO_HEIGHT);
              await api.patch('/api/settings', { logoHeight: DEFAULT_LOGO_HEIGHT });
              await onChanged();
            }}
          >
            Default
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted">
          Applies to the header logo. The preview above updates as you drag.
        </p>
      </div>

      <p className="text-xs text-muted">
        The bundled Moodify logo is never overwritten — a custom logo simply takes precedence, and
        resetting brings the original back. A custom logo is also used as the browser tab icon.
      </p>

      {error ? <ErrorNote message={error} /> : null}
    </Card>
  );
}
