import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { WIDGET_TYPES, type Dashboard, type WidgetType } from '@moodify/shared';
import { Copy, Plus, RefreshCw, Settings2, ShieldAlert, Trash2 } from 'lucide-react';
import { api, assetUrl, cn, errorMessage } from '@/lib/api';
import { Button, Card, Dialog, ErrorNote, Input, Label, Spinner, Switch } from '@/ui';
import { DashboardGrid, StickyBackground } from '@/components/DashboardGrid';
import { WIDGET_META } from '@/widgets';

export default function DashboardPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [dashboards, setDashboards] = useState<Dashboard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setDashboards(await api.get<Dashboard[]>('/api/dashboards'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !dashboards) {
    return (
      <Card className="mx-auto max-w-md text-center">
        <p className="mb-3 text-sm text-muted">{error}</p>
        <Button onClick={() => void load()}>Retry</Button>
      </Card>
    );
  }

  if (!dashboards) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const create = async (name: string) => {
    const created = await api.post<Dashboard>('/api/dashboards', { name });
    await load();
    navigate(`/dashboards/${created.id}`);
  };

  if (dashboards.length === 0) {
    return (
      <Card className="mx-auto max-w-md">
        <h1 className="mb-1 text-lg font-semibold">Create your first dashboard</h1>
        <p className="mb-4 text-sm text-muted">
          A dashboard holds widgets showing completion and badges.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (newName.trim()) void create(newName.trim()).catch((e) => setError(errorMessage(e)));
          }}
        >
          <Input
            value={newName}
            placeholder="Dashboard name"
            onChange={(e) => setNewName(e.target.value)}
            required
          />
          <Button type="submit">Create</Button>
        </form>
        {error ? <ErrorNote message={error} className="mt-3" /> : null}
      </Card>
    );
  }

  const current = dashboards.find((d) => String(d.id) === id) ?? dashboards[0];
  if (!current) return null;

  return (
    <>
      <StickyBackground imageUrl={assetUrl(current.backgroundImagePath)} />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <nav className="flex flex-wrap gap-1">
          {dashboards.map((dashboard) => (
            <button
              key={dashboard.id}
              onClick={() => navigate(`/dashboards/${dashboard.id}`)}
              className={cn(
                'rounded-xl px-3 py-1.5 text-sm transition',
                dashboard.id === current.id
                  ? 'bg-surface-strong text-ink'
                  : 'text-muted hover:bg-surface hover:text-ink',
              )}
            >
              {dashboard.name}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="subtle" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            Add widget
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dashboard settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <DashboardGrid dashboard={current} onChanged={() => void load()} />

      <AddWidgetDialog
        open={adding}
        onClose={() => setAdding(false)}
        dashboardId={current.id}
        onAdded={() => {
          setAdding(false);
          void load();
        }}
      />

      <DashboardSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        dashboard={current}
        onChanged={load}
        onDeleted={() => {
          setSettingsOpen(false);
          navigate('/dashboards');
          void load();
        }}
      />

      <div className="mt-6">
        <NewDashboardInline onCreate={create} />
      </div>
    </>
  );
}

function NewDashboardInline({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  return (
    <form
      className="flex max-w-sm gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        void onCreate(name.trim());
        setName('');
      }}
    >
      <Input
        value={name}
        placeholder="New dashboard…"
        onChange={(e) => setName(e.target.value)}
        className="text-xs"
      />
      <Button type="submit" variant="subtle" size="sm">
        Add
      </Button>
    </form>
  );
}

function AddWidgetDialog({
  open,
  onClose,
  dashboardId,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  dashboardId: number;
  onAdded: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const add = async (type: WidgetType) => {
    try {
      await api.post(`/api/dashboards/${dashboardId}/widgets`, { type });
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add a widget">
      <div className="space-y-2">
        {WIDGET_TYPES.map((type) => {
          const meta = WIDGET_META[type];
          const Icon = meta.icon;
          return (
            <button
              key={type}
              onClick={() => void add(type)}
              className="flex w-full items-start gap-3 rounded-xl border border-edge p-3 text-left transition hover:bg-surface"
            >
              <Icon className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <span>
                <span className="block text-sm font-medium">{meta.label}</span>
                <span className="block text-xs text-muted">{meta.description}</span>
              </span>
            </button>
          );
        })}
      </div>
      {error ? <ErrorNote message={error} /> : null}
    </Dialog>
  );
}

function DashboardSettingsDialog({
  open,
  onClose,
  dashboard,
  onChanged,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  dashboard: Dashboard;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(dashboard.name);
  const [error, setError] = useState<string | null>(null);
  const [confirmShare, setConfirmShare] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState('');

  useEffect(() => setName(dashboard.name), [dashboard.name]);

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api.patch(`/api/dashboards/${dashboard.id}`, body);
      await onChanged();
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const shareUrl = dashboard.publicShareToken
    ? `${window.location.origin}/public/${dashboard.publicShareToken}`
    : null;

  return (
    <Dialog open={open} onClose={onClose} title="Dashboard settings">
      <div>
        <Label htmlFor="dash-name">Name</Label>
        <div className="flex gap-2">
          <Input id="dash-name" value={name} onChange={(e) => setName(e.target.value)} />
          <Button variant="subtle" onClick={() => void patch({ name: name.trim() })}>
            Save
          </Button>
        </div>
      </div>

      <div>
        <Label htmlFor="dash-bg">Background image</Label>
        <div className="flex items-center gap-2">
          <input
            id="dash-bg"
            type="file"
            accept="image/*"
            className="w-full text-xs text-muted file:mr-2 file:rounded-lg file:border-0 file:bg-surface-strong file:px-3 file:py-1.5 file:text-ink"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              try {
                await api.upload(`/api/dashboards/${dashboard.id}/background`, file);
                await onChanged();
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          />
          {dashboard.backgroundImagePath ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove background"
              onClick={async () => {
                await api.del(`/api/dashboards/${dashboard.id}/background`);
                await onChanged();
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-edge p-3">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="dash-public" className="mb-0">
            Public share link
            <span className="mt-0.5 block text-xs font-normal text-muted">
              Anyone with the link can view this dashboard.
            </span>
          </Label>
          <Switch
            id="dash-public"
            checked={dashboard.isPublic}
            onCheckedChange={(value) => {
              // §12: make the data-protection tradeoff visible before it is switched on.
              if (value && !dashboard.isPublic) setConfirmShare(true);
              else void patch({ isPublic: value });
            }}
          />
        </div>

        {confirmShare ? (
          <div className="space-y-3 rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs">
            <p className="flex items-center gap-1.5 font-medium text-warn">
              <ShieldAlert className="h-4 w-4" />
              This link has no access control
            </p>
            <p className="text-muted">
              Anyone who obtains the URL can see it — there is no password and no login. Student
              names, badges and completion figures are personal data; under the Swiss FADP,
              publishing them is your responsibility as the operator.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setConfirmShare(false);
                  void patch({ isPublic: true, anonymizeOnPublic: true });
                }}
              >
                Enable, anonymised
              </Button>
              <Button
                size="sm"
                variant="subtle"
                onClick={() => {
                  setConfirmShare(false);
                  void patch({ isPublic: true, anonymizeOnPublic: false });
                }}
              >
                Enable with real names
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmShare(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="dash-anon" className="mb-0">
            Anonymise names
            <span className="mt-0.5 block text-xs font-normal text-muted">
              Names become Student 1, Student 2, … on the public link only.
            </span>
          </Label>
          <Switch
            id="dash-anon"
            checked={dashboard.anonymizeOnPublic}
            onCheckedChange={(value) => void patch({ anonymizeOnPublic: value })}
          />
        </div>

        {dashboard.isPublic && shareUrl ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input readOnly value={shareUrl} className="text-xs" onFocus={(e) => e.target.select()} />
              <Button
                variant="subtle"
                size="icon"
                aria-label="Copy share link"
                onClick={() => void navigator.clipboard?.writeText(shareUrl)}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (!confirm('Regenerate the link? The current URL stops working immediately.')) return;
                await api.post(`/api/dashboards/${dashboard.id}/share/regenerate`);
                await onChanged();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Regenerate link
            </Button>
          </div>
        ) : null}
      </div>

      {error ? <ErrorNote message={error} /> : null}

      <div className="rounded-xl border border-bad/40 p-3">
        <p className="mb-2 text-xs text-muted">
          Type <code className="text-ink">{dashboard.name}</code> to delete this dashboard.
        </p>
        <div className="flex gap-2">
          <Input
            value={confirmDelete}
            onChange={(e) => setConfirmDelete(e.target.value)}
            placeholder={dashboard.name}
            className="text-xs"
          />
          <Button
            variant="danger"
            disabled={confirmDelete !== dashboard.name}
            onClick={async () => {
              await api.del(`/api/dashboards/${dashboard.id}`);
              onDeleted();
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
