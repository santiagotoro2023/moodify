import { useState, type ReactNode } from 'react';
import RGL, { WidthProvider, type Layout } from 'react-grid-layout';
import type { Dashboard, Widget, WidgetData, WidgetDataError } from '@moodify/shared';
import { ChevronDown, ChevronUp, GripVertical, Pencil, Settings2, Trash2 } from 'lucide-react';
import { api, cn, errorMessage } from '@/lib/api';
import { Button, Dialog } from '@/ui';
import { WIDGET_META, WidgetBody, autoTitle } from '@/widgets';
import { WidgetConfigForm } from '@/widgets/ConfigForm';

const GridLayout = WidthProvider(RGL);

/**
 * A dashboard has ONE layout, authored at twelve columns, and it is kept at twelve
 * columns on every screen — the widgets get narrower, never rearranged.
 *
 * This was `Responsive` with cols {lg:12, md:10, sm:6, xs:4, xxs:2} and the same layout
 * array handed to all five breakpoints. react-grid-layout does not just *display* a
 * layout that overflows the current column count, it rewrites it — two six-wide widgets
 * side by side do not fit in ten columns, so the second one gets clamped and pushed
 * underneath. That correction came straight back through onLayoutChange and was saved,
 * so merely opening the dashboard on a narrower window silently destroyed the arrangement
 * and the widths with it. A fixed column count makes that structurally impossible.
 *
 * The grid props below are the rest of that story: a widget goes where it is put and
 * stays the size it was given. Nothing in this component may move a widget on its own.
 */
const COLS = 12;
const COLLAPSED_H = 1;

/**
 * The dashboard background.
 *
 * `background-attachment: fixed` is not used: iOS Safari either ignores it or
 * repaints it with visible jitter while scrolling. A separate fixed-position layer
 * behind the scrolling content behaves identically everywhere.
 */
export function StickyBackground({ imageUrl }: { imageUrl: string | null }) {
  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 -z-10 bg-ground"
      style={
        imageUrl
          ? {
              backgroundImage: `linear-gradient(rgba(11,15,20,0.72), rgba(11,15,20,0.82)), url(${JSON.stringify(imageUrl)})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }
          : undefined
      }
    />
  );
}

function WidgetFrame({
  title,
  icon,
  collapsed,
  readOnly,
  onToggleCollapse,
  onRename,
  onConfigure,
  onRemove,
  children,
}: {
  title: string;
  icon?: ReactNode;
  collapsed: boolean;
  readOnly?: boolean;
  onToggleCollapse?: () => void;
  onRename?: (title: string) => void;
  onConfigure?: () => void;
  onRemove?: () => void;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) onRename?.(next);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[14px] border border-edge bg-surface shadow-[var(--shadow-widget)] backdrop-blur-xl">
      <header className="flex items-center gap-1.5 px-3 py-2">
        {/* Only this element carries the drag class, so the buttons stay clickable. */}
        {!readOnly ? (
          <span className="widget-drag-handle -ml-1 p-1 text-muted/60 hover:text-muted">
            <GripVertical className="h-4 w-4" />
          </span>
        ) : null}
        {icon ? <span className="text-muted">{icon}</span> : null}

        {editing ? (
          <input
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setDraft(title);
                setEditing(false);
              }
            }}
            className="min-w-0 flex-1 rounded-md bg-ground-soft px-1.5 py-0.5 text-sm outline-none ring-1 ring-accent"
          />
        ) : (
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>
            {title}
          </h3>
        )}

        {!readOnly ? (
          <span className="flex shrink-0 items-center">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Rename widget"
              onClick={() => {
                setDraft(title);
                setEditing(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Configure widget" onClick={onConfigure}>
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={collapsed ? 'Expand widget' : 'Collapse widget'}
              onClick={onToggleCollapse}
            >
              {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
            </Button>
            <Button variant="ghost" size="icon" aria-label="Remove widget" onClick={onRemove}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </span>
        ) : null}
      </header>

      {!collapsed ? <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">{children}</div> : null}
    </div>
  );
}

export function DashboardGrid({
  dashboard,
  readOnly,
  publicToken,
  onChanged,
}: {
  dashboard: Dashboard;
  readOnly?: boolean;
  publicToken?: string;
  onChanged: () => void;
}) {
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [configuring, setConfiguring] = useState<Widget | null>(null);
  /** Set when saving the arrangement failed — losing it silently is the worst outcome. */
  const [saveError, setSaveError] = useState<string | null>(null);

  const layout: Layout[] = dashboard.widgets.map((widget) => ({
    i: String(widget.id),
    x: widget.x,
    y: widget.y,
    w: widget.w,
    h: widget.isCollapsed ? COLLAPSED_H : widget.h,
    minW: 2,
    minH: widget.isCollapsed ? COLLAPSED_H : 2,
    maxH: widget.isCollapsed ? COLLAPSED_H : undefined,
    isResizable: !readOnly && !widget.isCollapsed,
  }));

  /**
   * Writes the arrangement, immediately, on the two events that mean the user moved
   * something. Everything about the old version of this was wrong in the same direction:
   *
   *  - It was debounced by 500ms, and the unmount cleanup cleared the pending timer. So
   *    arranging widgets and clicking away inside half a second — which is what "put them
   *    side by side, then leave the page" actually is — threw the arrangement away. A
   *    drag-stop is one discrete action, not a stream; there was nothing to coalesce.
   *  - It was also wired to onLayoutChange, which fires for react-grid-layout's own
   *    bounds corrections and compaction, not just for edits. That is how a computed
   *    layout ends up overwriting the one the user authored.
   *  - It swallowed failures with `void`, so a rejected write looked exactly like a
   *    successful one until the next reload.
   */
  const persist = (next: Layout[]) => {
    if (readOnly) return;

    const items = next.map((item) => {
      const widget = dashboard.widgets.find((w) => w.id === Number(item.i));
      return {
        id: Number(item.i),
        x: item.x,
        y: item.y,
        w: item.w,
        // Never persist the collapsed placeholder height as the real height.
        h: widget?.isCollapsed ? (widget.h ?? item.h) : item.h,
      };
    });

    api
      .put(`/api/dashboards/${dashboard.id}/layout`, { items })
      .then(() => setSaveError(null))
      .catch((err: unknown) => setSaveError(errorMessage(err)));
  };

  const patch = async (widget: Widget, body: Record<string, unknown>) => {
    await api.patch(`/api/widgets/${widget.id}`, body);
    onChanged();
  };

  if (dashboard.widgets.length === 0) {
    return (
      <p className="rounded-[14px] border border-dashed border-edge p-10 text-center text-sm text-muted">
        {readOnly ? 'This dashboard has no widgets yet.' : 'No widgets yet — add one to get started.'}
      </p>
    );
  }

  return (
    <>
      {saveError ? (
        <p className="mb-3 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm">
          Could not save the layout: {saveError}
        </p>
      ) : null}
      <GridLayout
        className="layout"
        layout={layout}
        cols={COLS}
        rowHeight={56}
        margin={[16, 16]}
        containerPadding={[0, 0]}
        draggableHandle=".widget-drag-handle"
        isDraggable={!readOnly}
        isResizable={!readOnly}
        // Free placement. `compactType="vertical"` is gravity: react-grid-layout runs
        // compact() inside synchronizeLayoutWithChildren on EVERY mount, so a widget
        // stored at y=3 was dragged up to y=0 on every single page load, and the next
        // drag then saved that. Put two widgets side by side one row down and reload:
        // they move. That is the "snapping back". With null, a stored layout renders
        // exactly as stored.
        compactType={null}
        // And with no gravity to resolve overlaps, a drag must not shove its neighbour
        // out of the way either — an occupied cell simply refuses the drop.
        preventCollision
        // Render only once the container has been measured. Without this the first paint
        // uses WidthProvider's hardcoded 1280px, so on a wider screen the grid draws
        // narrower than the page and every drag distance is computed against the wrong
        // column width.
        measureBeforeMount
        onDragStop={persist}
        onResizeStop={persist}
      >
        {dashboard.widgets.map((widget) => {
          const Icon = WIDGET_META[widget.type].icon;
          return (
            <div key={String(widget.id)}>
              <WidgetFrame
                title={widget.title ?? titles[widget.id] ?? autoTitle(widget, null)}
                icon={<Icon className="h-4 w-4" />}
                collapsed={widget.isCollapsed}
                readOnly={readOnly}
                onToggleCollapse={() => void patch(widget, { isCollapsed: !widget.isCollapsed })}
                onRename={(title) => void patch(widget, { title })}
                onConfigure={() => setConfiguring(widget)}
                onRemove={() => {
                  if (!confirm('Remove this widget?')) return;
                  void api.del(`/api/widgets/${widget.id}`).then(onChanged);
                }}
              >
                <WidgetBody
                  widget={widget}
                  publicToken={publicToken}
                  onData={(data: WidgetData | WidgetDataError) =>
                    setTitles((prev) =>
                      prev[widget.id] === autoTitle(widget, data)
                        ? prev
                        : { ...prev, [widget.id]: autoTitle(widget, data) },
                    )
                  }
                />
              </WidgetFrame>
            </div>
          );
        })}
      </GridLayout>

      <Dialog
        open={configuring !== null}
        onClose={() => setConfiguring(null)}
        title="Configure widget"
      >
        {configuring ? (
          <WidgetConfigForm
            widget={configuring}
            onCancel={() => setConfiguring(null)}
            onSaved={() => {
              setConfiguring(null);
              onChanged();
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}

export { WidgetFrame };
