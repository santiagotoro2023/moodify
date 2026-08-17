import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DEADLINE_WS_FUNCTIONS, REQUIRED_WS_FUNCTIONS, type SyncProgress } from '@moodify/shared';
import { CheckCircle2, Info } from 'lucide-react';
import { ApiError, api, cn, errorMessage } from '@/lib/api';
import { Button, Card, ErrorNote, Input, Label, Spinner } from '@/ui';

const STEPS = ['Administrator', 'Connect Moodle', 'Test', 'First sync'] as const;

interface ConnectResponse {
  missingFunctions?: string[];
}

export default function Wizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 1 — kept in state across steps so nothing is lost on a failed submit.
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [adminExists, setAdminExists] = useState(false);

  // Step 2
  const [baseUrl, setBaseUrl] = useState('');
  const [mode, setMode] = useState<'token' | 'credentials'>('token');
  const [token, setToken] = useState('');
  const [moodleUser, setMoodleUser] = useState('');
  const [moodlePass, setMoodlePass] = useState('');
  const [service, setService] = useState('moodle_mobile_app');
  const [missing, setMissing] = useState<string[]>([]);

  // Step 3
  const [siteName, setSiteName] = useState<string | null>(null);

  const createAdmin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (password !== confirm) return setError('The two passwords do not match.');

    setBusy(true);
    try {
      await api.post('/api/setup/admin', { username, password });
      setStep(1);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setAdminExists(true);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body =
        mode === 'token'
          ? { baseUrl, mode, token }
          : { baseUrl, mode, username: moodleUser, password: moodlePass, serviceShortname: service };
      const result = await api.post<ConnectResponse>('/api/connection', body);
      setMissing(result.missingFunctions ?? []);
      setStep(2);
    } catch (err) {
      // Stay on this step so the user can fix the value they just typed (§8).
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await api.post<{ ok: boolean; siteName?: string; error?: string }>(
        '/api/connection/test',
      );
      if (result.ok) {
        setSiteName(result.siteName ?? 'your Moodle site');
        setStep(3);
      } else {
        setError(result.error ?? 'The connection test failed.');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center p-6">
      <Card className="w-full max-w-xl">
        <img src="/brand/moodify-logo.svg" alt="Moodify" className="mx-auto mb-6 h-10 w-auto" />

        <ol className="mb-6 flex items-center gap-2 text-xs">
          {STEPS.map((label, index) => (
            <li key={label} className="flex flex-1 items-center gap-2">
              <span
                className={cn(
                  'grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px]',
                  index < step && 'border-good bg-good/20 text-good',
                  index === step && 'border-accent bg-accent/20 text-ink',
                  index > step && 'border-edge text-muted',
                )}
              >
                {index < step ? <CheckCircle2 className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <span className={cn('truncate', index === step ? 'text-ink' : 'text-muted')}>
                {label}
              </span>
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <form onSubmit={createAdmin} className="space-y-4">
            <h1 className="text-lg font-semibold">Create your administrator account</h1>
            <div>
              <Label htmlFor="wiz-user">Username</Label>
              <Input
                id="wiz-user"
                value={username}
                autoComplete="username"
                autoFocus
                minLength={3}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="wiz-pass">Password</Label>
              <Input
                id="wiz-pass"
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <p className="mt-1 text-xs text-muted">At least 8 characters.</p>
            </div>
            <div>
              <Label htmlFor="wiz-confirm">Confirm password</Label>
              <Input
                id="wiz-confirm"
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>
            {error ? <ErrorNote message={error} /> : null}
            {adminExists ? (
              <p className="text-sm text-muted">
                Already set up?{' '}
                <Link to="/login" className="text-accent underline underline-offset-2">
                  Sign in instead
                </Link>
              </p>
            ) : null}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? <Spinner className="h-4 w-4" /> : null}
              Continue
            </Button>
          </form>
        ) : null}

        {step === 1 ? (
          <form onSubmit={connect} className="space-y-4">
            <h1 className="text-lg font-semibold">Connect your Moodle</h1>
            <div>
              <Label htmlFor="wiz-url">Moodle base URL</Label>
              <Input
                id="wiz-url"
                value={baseUrl}
                placeholder="https://moodle.example.ch"
                autoFocus
                onChange={(e) => setBaseUrl(e.target.value)}
                required
              />
            </div>

            <div className="flex gap-2">
              {(['token', 'credentials'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setMode(option)}
                  className={cn(
                    'flex-1 rounded-xl border px-3 py-2 text-sm transition',
                    mode === option
                      ? 'border-accent bg-accent/15 text-ink'
                      : 'border-edge text-muted hover:text-ink',
                  )}
                >
                  {option === 'token' ? 'Paste a token' : 'Fetch one for me'}
                </button>
              ))}
            </div>

            {mode === 'token' ? (
              <div>
                <Label htmlFor="wiz-token">Web service token</Label>
                <Input
                  id="wiz-token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                />
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <Label htmlFor="wiz-muser">Moodle username</Label>
                  <Input
                    id="wiz-muser"
                    value={moodleUser}
                    onChange={(e) => setMoodleUser(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="wiz-mpass">Moodle password</Label>
                  <Input
                    id="wiz-mpass"
                    type="password"
                    value={moodlePass}
                    onChange={(e) => setMoodlePass(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="wiz-service">External service shortname</Label>
                  <Input
                    id="wiz-service"
                    value={service}
                    onChange={(e) => setService(e.target.value)}
                    required
                  />
                </div>
              </div>
            )}

            <div className="rounded-xl border border-edge bg-ground-soft/60 p-3 text-xs text-muted">
              <p className="mb-2 flex items-center gap-1.5 font-medium text-ink">
                <Info className="h-3.5 w-3.5" />
                One-time Moodle-side setup
              </p>
              <p className="mb-2">
                Moodify cannot configure Moodle remotely. A Moodle administrator must enable web
                services and the REST protocol, create an External Service, and authorise the
                account you use here. The service needs these functions:
              </p>
              <ul className="space-y-0.5">
                {REQUIRED_WS_FUNCTIONS.map((fn) => (
                  <li key={fn}>
                    <code className="rounded bg-black/40 px-1 py-0.5 text-[11px] text-ink">{fn}</code>
                  </li>
                ))}
              </ul>
              <p className="mt-2">
                Optional, only for deadline tracking — add them now and you will not have to
                come back to Moodle later:
              </p>
              <ul className="space-y-0.5">
                {DEADLINE_WS_FUNCTIONS.map((fn) => (
                  <li key={fn}>
                    <code className="rounded bg-black/40 px-1 py-0.5 text-[11px] text-ink">{fn}</code>
                  </li>
                ))}
              </ul>
            </div>

            {error ? <ErrorNote message={error} /> : null}
            <div className="flex gap-2">
              <Button variant="subtle" onClick={() => setStep(0)} className="flex-1">
                Back
              </Button>
              <Button type="submit" disabled={busy} className="flex-1">
                {busy ? <Spinner className="h-4 w-4" /> : null}
                Connect
              </Button>
            </div>
          </form>
        ) : null}

        {step === 2 ? (
          <div className="space-y-4">
            <h1 className="text-lg font-semibold">Test the connection</h1>
            {missing.length > 0 ? (
              <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
                <p className="mb-1 font-medium">
                  These functions are not enabled on the External Service:
                </p>
                <ul>
                  {missing.map((fn) => (
                    <li key={fn}>
                      <code>{fn}</code>
                    </li>
                  ))}
                </ul>
                <p className="mt-1">Discovery will be incomplete until they are added.</p>
              </div>
            ) : null}
            <p className="text-sm text-muted">
              Moodify will call <code>core_webservice_get_site_info</code> to confirm the token works.
            </p>
            {error ? <ErrorNote message={error} /> : null}
            <div className="flex gap-2">
              <Button variant="subtle" onClick={() => setStep(1)} className="flex-1">
                Back
              </Button>
              <Button onClick={testConnection} disabled={busy} className="flex-1">
                {busy ? <Spinner className="h-4 w-4" /> : null}
                Test connection
              </Button>
            </div>
          </div>
        ) : null}

        {step === 3 ? <FirstSync siteName={siteName} onDone={() => navigate('/dashboards')} /> : null}
      </Card>
    </div>
  );
}

/** Step 4: kick off discovery and show live counters until it settles (§8). */
function FirstSync({ siteName, onDone }: { siteName: string | null; onDone: () => void }) {
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void api.post('/api/sync').catch((err: unknown) => setError(errorMessage(err)));

    const timer = setInterval(async () => {
      try {
        const next = await api.get<SyncProgress>('/api/sync/progress');
        setProgress(next);
        if (next.status === 'ok' || next.status === 'error') clearInterval(timer);
      } catch (err) {
        setError(errorMessage(err));
        clearInterval(timer);
      }
    }, 1500);

    return () => clearInterval(timer);
  }, []);

  const running = progress === null || progress.status === 'running';

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">
        {siteName ? `Connected to ${siteName}` : 'First sync'}
      </h1>

      <div className="grid grid-cols-3 gap-3">
        {(
          [
            ['Courses', progress?.courses ?? 0],
            ['Users', progress?.users ?? 0],
            ['Badges', progress?.badges ?? 0],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-xl border border-edge bg-ground-soft/60 p-3 text-center">
            <p className="text-2xl font-semibold tabular-nums">{value}</p>
            <p className="text-xs text-muted">{label}</p>
          </div>
        ))}
      </div>

      <p className="flex items-center gap-2 text-sm text-muted">
        {running ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4 text-good" />}
        {progress?.phase ?? (running ? 'Starting discovery…' : 'Discovery finished.')}
      </p>

      {progress?.error ? <ErrorNote message={progress.error} /> : null}
      {error ? <ErrorNote message={error} /> : null}

      <Button onClick={onDone} className="w-full" disabled={running}>
        Create your first dashboard
      </Button>
      {running ? (
        <button onClick={onDone} className="w-full text-xs text-muted underline underline-offset-2">
          Skip and continue in the background
        </button>
      ) : null}
    </div>
  );
}
