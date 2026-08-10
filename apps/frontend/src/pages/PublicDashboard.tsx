import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Dashboard } from '@moodify/shared';
import { EyeOff } from 'lucide-react';
import { api, assetUrl, errorMessage } from '@/lib/api';
import { Button, Card, Spinner } from '@/ui';
import { DashboardGrid, StickyBackground } from '@/components/DashboardGrid';

interface PublicPayload {
  dashboard: Dashboard;
  anonymized: boolean;
}

/**
 * Read-only public render (§12). Deliberately renders no navigation, no logout and
 * no links into the admin UI — a visitor holding a share link must not be able to
 * reach anything else from here.
 */
export default function PublicDashboard() {
  const { token } = useParams();
  const [payload, setPayload] = useState<PublicPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const next = await api.get<PublicPayload>(`/api/public/${token}`);
      setPayload(next);
      setError(null);
      document.title = `${next.dashboard.name} — Moodify`;
    } catch (err) {
      // A 404 is indistinguishable from "sharing switched off" by design.
      if (err instanceof Error && 'status' in err && (err as { status: number }).status === 404) {
        setNotFound(true);
      } else {
        setError(errorMessage(err));
      }
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (notFound) {
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <Card className="max-w-sm text-center">
          <h1 className="mb-1 text-lg font-semibold">This dashboard is not available</h1>
          <p className="text-sm text-muted">
            The link may have been changed or sharing may have been switched off.
          </p>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <Card className="max-w-sm text-center">
          <p className="mb-3 text-sm text-muted">{error}</p>
          <Button onClick={() => void load()}>Retry</Button>
        </Card>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <StickyBackground imageUrl={assetUrl(payload.dashboard.backgroundImagePath)} />

      <header className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-5 py-5">
        <img src="/brand/moodify-logo.svg" alt="Moodify" className="h-7 w-auto opacity-80" />
        <h1 className="text-lg font-semibold">{payload.dashboard.name}</h1>
        {payload.anonymized ? (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted">
            <EyeOff className="h-3.5 w-3.5" />
            Names on this page are anonymised.
          </span>
        ) : null}
      </header>

      <main className="mx-auto max-w-[1600px] px-5 pb-10">
        <DashboardGrid
          dashboard={payload.dashboard}
          readOnly
          publicToken={token}
          onChanged={() => undefined}
        />
      </main>
    </div>
  );
}
