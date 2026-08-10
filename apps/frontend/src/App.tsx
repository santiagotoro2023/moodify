import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { BootstrapState } from '@moodify/shared';
import { AlertTriangle, LayoutDashboard, LogOut, PlugZap, RefreshCw, Settings as Cog } from 'lucide-react';
import { api, cn, errorMessage, relativeTime } from '@/lib/api';
import { Button, Card, ErrorNote, Spinner } from '@/ui';
import DashboardPage from '@/pages/DashboardPage';
import Login from '@/pages/Login';
import PublicDashboard from '@/pages/PublicDashboard';
import Settings from '@/pages/Settings';
import Wizard from '@/pages/Wizard';

const DEFAULT_LOGO = '/brand/moodify-logo.svg';

export function useBootstrap(pollMs?: number) {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setState(await api.get<BootstrapState>('/api/bootstrap'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(() => void reload(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, reload]);

  return { state, loading, error, reload };
}

/** Full-page states, so a broken backend never renders a blank screen (§13). */
function Centered({ children }: { children: ReactNode }) {
  return <div className="grid min-h-screen place-items-center p-6">{children}</div>;
}

function AppLayout({ children }: { children: ReactNode }) {
  const { state, error, reload } = useBootstrap(30_000);
  const navigate = useNavigate();
  const location = useLocation();
  const [resyncing, setResyncing] = useState(false);

  // Any 401 from the periodic bootstrap means the session lapsed.
  useEffect(() => {
    if (state && !state.hasAdmin) navigate('/setup', { replace: true });
  }, [state, navigate]);

  const connection = state?.connection ?? null;
  const syncFailed = connection?.lastSyncStatus === 'error';

  const resync = async () => {
    setResyncing(true);
    try {
      await api.post('/api/sync');
      await reload();
    } catch {
      /* the banner already shows the underlying problem */
    } finally {
      setResyncing(false);
    }
  };

  const navLink = (to: string, label: string, icon: ReactNode) => (
    <Link
      to={to}
      className={cn(
        'flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition',
        location.pathname.startsWith(to)
          ? 'bg-surface-strong text-ink'
          : 'text-muted hover:bg-surface hover:text-ink',
      )}
    >
      {icon}
      {label}
    </Link>
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-edge bg-ground/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-5 py-3">
          <img
            src={state?.logoUrl || DEFAULT_LOGO}
            alt="Moodify"
            className="h-8 w-auto"
            onError={(event) => {
              event.currentTarget.src = DEFAULT_LOGO;
            }}
          />
          <nav className="flex items-center gap-1">
            {navLink('/dashboards', 'Dashboards', <LayoutDashboard className="h-4 w-4" />)}
            {navLink('/settings', 'Settings', <Cog className="h-4 w-4" />)}
          </nav>
          <div className="ml-auto">
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await api.post('/api/logout').catch(() => undefined);
                navigate('/login', { replace: true });
              }}
            >
              <LogOut className="h-4 w-4" />
              Log out
            </Button>
          </div>
        </div>

        {syncFailed ? (
          <div className="border-t border-warn/30 bg-warn/10 px-5 py-2">
            <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0 text-warn" />
              <span className="text-warn">
                Last sync failed: {connection?.lastSyncError ?? 'unknown error'} (
                {relativeTime(connection?.lastSyncAt ?? null)})
              </span>
              <Button variant="subtle" size="sm" onClick={resync} disabled={resyncing} className="ml-auto">
                <RefreshCw className={cn('h-3.5 w-3.5', resyncing && 'animate-spin')} />
                Re-sync now
              </Button>
            </div>
          </div>
        ) : null}

        {state && !connection ? (
          <div className="border-t border-edge bg-surface px-5 py-2">
            <div className="mx-auto flex max-w-[1600px] items-center gap-3 text-sm text-muted">
              <PlugZap className="h-4 w-4 shrink-0" />
              No Moodle connection configured.
              <Link to="/settings" className="text-accent underline underline-offset-2">
                Connect one
              </Link>
            </div>
          </div>
        ) : null}
      </header>

      <main className="mx-auto max-w-[1600px] px-5 py-6">
        {error ? <ErrorNote message={error} className="mb-4" /> : null}
        {children}
      </main>
    </div>
  );
}

/** Gates the admin surface on first-run and session state. */
function AdminRoute({ children }: { children: ReactNode }) {
  const { state, loading, error, reload } = useBootstrap();

  if (loading) {
    return (
      <Centered>
        <Spinner className="h-8 w-8" />
      </Centered>
    );
  }

  if (error) {
    return (
      <Centered>
        <Card className="max-w-md text-center">
          <h1 className="mb-2 text-lg font-semibold">Moodify is not responding</h1>
          <p className="mb-4 text-sm text-muted">{error}</p>
          <Button onClick={() => void reload()}>Retry</Button>
        </Card>
      </Centered>
    );
  }

  // §4: the very first run lands on the wizard, never on a login form.
  if (state && !state.hasAdmin) return <Navigate to="/setup" replace />;

  return <AppLayout>{children}</AppLayout>;
}

export default function App() {
  return (
    <Routes>
      {/* Public share links bypass every gate — they must work with no session. */}
      <Route path="/public/:token" element={<PublicDashboard />} />
      <Route path="/setup" element={<Wizard />} />
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Navigate to="/dashboards" replace />} />
      <Route
        path="/dashboards"
        element={
          <AdminRoute>
            <DashboardPage />
          </AdminRoute>
        }
      />
      <Route
        path="/dashboards/:id"
        element={
          <AdminRoute>
            <DashboardPage />
          </AdminRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <AdminRoute>
            <Settings />
          </AdminRoute>
        }
      />
      <Route
        path="*"
        element={
          <Centered>
            <Card className="max-w-sm text-center">
              <h1 className="mb-2 text-lg font-semibold">Page not found</h1>
              <Link to="/dashboards" className="text-sm text-accent underline underline-offset-2">
                Back to dashboards
              </Link>
            </Card>
          </Centered>
        }
      />
    </Routes>
  );
}
