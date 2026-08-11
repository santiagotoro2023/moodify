import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BadgeCardsData,
  BadgeListData,
  Badge as BadgeType,
  CompletionEntry,
  CompletionTableData,
  CourseOverviewData,
  LeaderboardData,
  ProgressChartData,
  UserListData,
  Widget,
  WidgetData,
  WidgetDataError,
} from '@moodify/shared';
import { Award, BookOpen, LineChart, Medal, Table2, TrendingUp, Trophy, User } from 'lucide-react';
import type { BadgeSize, ChartMarker, Density } from '@moodify/shared';
import { api, assetUrl, cn, errorMessage } from '@/lib/api';
import { Button, EmptyState, ErrorNote, Spinner } from '@/ui';

type Payload = WidgetData | WidgetDataError;

/**
 * Row size, set per widget in its settings. One scale drives every renderer so a
 * dashboard set to "compact" is compact everywhere, not just in the table.
 */
const DENSITY: Record<Density, {
  gap: string;
  pad: string;
  cell: string;
  text: string;
  icon: string;
  bar: string;
}> = {
  compact: { gap: 'space-y-1.5', pad: 'p-2.5', cell: 'px-2 py-1', text: 'text-xs', icon: 'h-6 w-6', bar: 'h-1.5' },
  normal: { gap: 'space-y-3', pad: 'p-4', cell: 'px-2 py-2', text: 'text-sm', icon: 'h-9 w-9', bar: 'h-2' },
  roomy: { gap: 'space-y-4', pad: 'p-5', cell: 'px-3 py-3.5', text: 'text-base', icon: 'h-12 w-12', bar: 'h-2.5' },
};

/** Badge icon size, set per widget and independent of row size. */
const BADGE_SIZE: Record<BadgeSize, { icon: string; text: string; pad: string }> = {
  small: { icon: 'h-9 w-9', text: 'text-xs', pad: 'p-1 pr-3' },
  medium: { icon: 'h-12 w-12', text: 'text-sm', pad: 'p-1.5 pr-3.5' },
  large: { icon: 'h-16 w-16', text: 'text-base', pad: 'p-2 pr-4' },
};

/** Widget configs are stored as opaque JSON; only the display fields matter here. */
function densityOf(config: unknown): Density {
  const value = (config as { density?: unknown } | null)?.density;
  return value === 'compact' || value === 'roomy' ? value : 'normal';
}

function badgeSizeOf(config: unknown): BadgeSize {
  const value = (config as { badgeSize?: unknown } | null)?.badgeSize;
  return value === 'medium' || value === 'large' ? value : 'small';
}

/** The chart's display-only settings, defaulted the same way the zod schema does. */
function chartOptionsOf(config: unknown) {
  const raw = (config ?? {}) as Record<string, unknown>;
  const marker = raw.marker;
  const avatarSize = raw.avatarSize;
  return {
    marker: (marker === 'avatar' || marker === 'both' || marker === 'none'
      ? marker
      : 'name') as ChartMarker,
    avatarSize: (avatarSize === 'small' || avatarSize === 'large'
      ? avatarSize
      : 'medium') as BadgeSize,
    showLegend: raw.showLegend !== false,
    showArea: raw.showArea === true,
  };
}

/** Colour band for a completion bar. Untracked never reaches here. */
function bandClass(percent: number): string {
  if (percent < 34) return 'bg-bad';
  if (percent < 67) return 'bg-warn';
  return 'bg-good';
}

function ProgressBar({ entry }: { entry: CompletionEntry }) {
  if (entry.percent === null) {
    return (
      <span className="text-muted" title="This course does not track activity completion">
        —
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-2"
      title={`${entry.activitiesCompleted}/${entry.activitiesTotal} activities`}
    >
      <span className="h-1.5 w-full min-w-10 overflow-hidden rounded-full bg-white/10">
        <span
          className={cn('block h-full rounded-full', bandClass(entry.percent))}
          style={{ width: `${entry.percent}%` }}
        />
      </span>
      <span className="shrink-0 tabular-nums text-xs text-muted">{Math.round(entry.percent)}%</span>
    </span>
  );
}

function BadgeImage({ badge, size }: { badge: BadgeType; size: string }) {
  const [failed, setFailed] = useState(false);
  const url = assetUrl(badge.imageUrl);

  // rounded-full, not rounded-lg: the image sits inside a pill, and a squarer corner
  // radius on the inner element reads as an unfinished edge.
  if (!url || failed) {
    return (
      <span className={cn('grid shrink-0 place-items-center rounded-full bg-white/8', size)}>
        <Award className="h-1/2 w-1/2 text-muted" aria-hidden="true" />
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      className={cn('shrink-0 rounded-full object-contain', size)}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Icon + full name as one chip. Names sit beside the icon rather than under it, so
 * they show in full without each badge costing a whole block of height.
 */
function BadgeList({ badges, badgeSize }: { badges: BadgeType[]; badgeSize: BadgeSize }) {
  if (badges.length === 0) {
    return <p className="text-xs text-muted">No badges yet</p>;
  }
  const { icon, text, pad } = BADGE_SIZE[badgeSize];
  return (
    <ul className="flex flex-wrap gap-2">
      {badges.map((badge) => (
        <li
          key={badge.id}
          className={cn('flex items-center gap-2 rounded-full bg-white/6', pad)}
          title={badge.description ?? badge.name}
        >
          <BadgeImage badge={badge} size={icon} />
          <span className={cn('leading-snug', text)}>{badge.name}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// progress_chart
// ---------------------------------------------------------------------------

/** Distinct hues, in a fixed order so a student keeps their colour between reloads. */
const LINE_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#f43f5e',
  '#38bdf8', '#a855f7', '#84cc16', '#fb923c',
];

/** Diameter of the avatar marker, in px. Same three steps as the badge icons. */
const AVATAR_PX: Record<BadgeSize, number> = { small: 20, medium: 30, large: 44 };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => [...part][0] ?? '').join('').toUpperCase() || '?';
}

/** Width of the room the marker needs on the right, so a line never runs off the edge. */
function markerRoom(marker: ChartMarker, avatar: number): number {
  if (marker === 'none') return 8;
  if (marker === 'avatar') return avatar + 8;
  return marker === 'both' ? avatar + 78 : 78;
}

/**
 * The sample time closest to `targetMs`, or null if there are none.
 *
 * Takes the timestamps pre-parsed (see the useMemo in ProgressChart): all-time mode can
 * carry thousands of event times, and re-parsing them on every mousemove is the one
 * thing in this chart that would actually be felt. Scanning that many *numbers* is not,
 * so it stays a linear scan rather than a binary search.
 */
function nearestStop(stops: { iso: string[]; ms: number[] }, targetMs: number): string | null {
  let best: string | null = null;
  let bestGap = Infinity;
  for (let i = 0; i < stops.ms.length; i += 1) {
    const time = stops.ms[i];
    const iso = stops.iso[i];
    if (time === undefined || iso === undefined) continue;
    const gap = Math.abs(time - targetMs);
    if (gap >= bestGap) continue;
    bestGap = gap;
    best = iso;
  }
  return best;
}

const HOURS_36 = 36 * 60 * 60 * 1000;
const DAYS_60 = 60 * 24 * 60 * 60 * 1000;

/** All-time spans months or years, so the axis has to widen its units with the range. */
/**
 * The newest point at or before `iso`, or undefined if the line had not started yet.
 * Both strings come from toISOString(), which is fixed-width UTC — so comparing them
 * as text is comparing them as time, without parsing 700 dates on every mousemove.
 */
function lastAtOrBefore(
  points: readonly { t: string; v: number }[],
  iso: string,
): { t: string; v: number } | undefined {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const point = points[i];
    if (point !== undefined && point.t <= iso) return point;
  }
  return undefined;
}

function axisLabel(iso: string, spanMs: number): string {
  const date = new Date(iso);
  if (spanMs <= HOURS_36) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (spanMs <= DAYS_60) {
    return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/** The crosshair's own label — finer than the axis, since it names one exact moment. */
function stopLabel(iso: string, spanMs: number): string {
  const date = new Date(iso);
  return spanMs <= HOURS_36
    ? date.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        year: spanMs > DAYS_60 ? 'numeric' : undefined,
        hour: '2-digit',
        minute: '2-digit',
      });
}

/**
 * Hand-drawn SVG rather than a charting library: one dependency-free component covers
 * the two metrics this widget has, and the markers (a face at the end of each line) are
 * not something a stock line chart does anyway.
 *
 * Sized from a measured container instead of a scaled viewBox — a viewBox would stretch
 * the text and squash the avatars out of round.
 */
function ProgressChart({
  data,
  config,
}: {
  data: ProgressChartData;
  config: {
    marker: ChartMarker;
    avatarSize: BadgeSize;
    showLegend: boolean;
    showArea: boolean;
  };
}) {
  const plotted = data.series.filter((entry) => entry.points.length > 0);
  const hasData = plotted.length > 0;

  const [box, setBox] = useState({ w: 0, h: 0 });
  /** Cursor position within the plot area, in px from its left edge. */
  const [hover, setHover] = useState<number | null>(null);

  // Every distinct sample time across all lines: the crosshair snaps to these rather
  // than reading a value off the drawn line, so the tooltip only ever shows numbers that
  // were actually measured. Memoised on the payload because moving the mouse re-renders,
  // and re-deriving thousands of all-time event times per frame would not be free.
  const stops = useMemo(() => {
    const iso = [...new Set(data.series.flatMap((entry) => entry.points.map((p) => p.t)))].sort();
    return { iso, ms: iso.map((t) => new Date(t).getTime()) };
  }, [data]);
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = hostRef.current;
    if (node === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBox({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
    // hasData decides whether the host element exists at all.
  }, [hasData]);

  if (!hasData) {
    return (
      <EmptyState
        icon={<LineChart className="h-6 w-6" />}
        title="Collecting data"
        // Both branches are honest about the wait rather than standing in for
        // "something went wrong": the sampler writes a point every 15 minutes, and the
        // all-time source is filled by the full discovery pass on the same cadence.
        hint={
          data.step
            ? 'All-time history is read from Moodle during a full sync — give it up to 15 minutes, or press Re-sync now in Settings.'
            : 'The chart fills in as Moodify samples progress — the first points appear within about 15 minutes.'
        }
      />
    );
  }

  const avatar = AVATAR_PX[config.avatarSize];
  const padding = {
    left: data.metric === 'percent' ? 34 : 26,
    right: markerRoom(config.marker, avatar),
    top: avatar / 2 + 4,
    bottom: 20,
  };
  const width = Math.max(box.w, 160);
  const height = Math.max(box.h, 120);
  const plotW = Math.max(width - padding.left - padding.right, 10);
  const plotH = Math.max(height - padding.top - padding.bottom, 10);

  const t0 = new Date(data.from).getTime();
  const t1 = new Date(data.to).getTime();
  const spanMs = Math.max(t1 - t0, 1);
  const maxValue =
    data.metric === 'percent'
      ? 100
      : // Badge counts have no ceiling; round up so the top line is not glued to the frame.
        Math.max(1, ...plotted.flatMap((entry) => entry.points.map((point) => point.v)));

  const x = (iso: string) => padding.left + ((new Date(iso).getTime() - t0) / spanMs) * plotW;
  const y = (value: number) => padding.top + plotH - (value / maxValue) * plotH;

  /**
   * Event data holds its value flat until the next event, so it is drawn as steps —
   * sloping from two badges to three would draw two and a half badges on Wednesday.
   * Clock-driven samples slope normally.
   */
  const linePath = (points: { t: string; v: number }[]) =>
    points
      .map((p, i) =>
        i === 0
          ? `M${x(p.t)},${y(p.v)}`
          : data.step
            ? `H${x(p.t)}V${y(p.v)}`
            : `L${x(p.t)},${y(p.v)}`,
      )
      .join(' ');

  const ticks = [0, 0.5, 1].map((fraction) => Math.round(maxValue * fraction));

  const format = (value: number) =>
    data.metric === 'percent' ? `${Math.round(value * 10) / 10}%` : String(value);

  const hoveredAt = hover === null ? null : nearestStop(stops, t0 + (hover / plotW) * spanMs);
  // Each line's newest point at or before the crosshair — not an exact time match. In
  // all-time mode every student's events land on their own timestamps, so nothing would
  // ever match exactly. A line that had not started by then is left out; 0 would be a lie.
  const readings =
    hoveredAt === null
      ? []
      : plotted
          .map((entry, index) => ({
            name: entry.user.fullname,
            color: LINE_COLORS[index % LINE_COLORS.length] ?? '#6366f1',
            point: lastAtOrBefore(entry.points, hoveredAt),
          }))
          .filter((row): row is typeof row & { point: { t: string; v: number } } =>
            row.point !== undefined,
          );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* overflow-hidden matters: the SVG is sized *from* this box, so letting it push
          the box wider would feed the ResizeObserver its own output. */}
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden">
        <svg
          width={width}
          height={height}
          className="block"
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const px = event.clientX - rect.left - padding.left;
            // Outside the plot area (over the axis labels, or the room reserved for
            // markers) there is nothing to read, so drop the crosshair entirely.
            setHover(px >= 0 && px <= plotW ? px : null);
          }}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={padding.left}
                x2={padding.left + plotW}
                y1={y(tick)}
                y2={y(tick)}
                stroke="currentColor"
                strokeWidth={1}
                className="text-white/8"
              />
              <text x={padding.left - 6} y={y(tick) + 4} textAnchor="end" className="fill-current text-[10px] text-muted">
                {data.metric === 'percent' ? `${tick}%` : tick}
              </text>
            </g>
          ))}
          <text x={padding.left} y={height - 4} className="fill-current text-[10px] text-muted">
            {axisLabel(data.from, spanMs)}
          </text>
          <text x={padding.left + plotW} y={height - 4} textAnchor="end" className="fill-current text-[10px] text-muted">
            {axisLabel(data.to, spanMs)}
          </text>

          {/* Pass 1: every line. Drawn before every marker so that one student's line
              cannot cut across another student's face — SVG has no z-index, paint
              order is the only ordering there is. */}
          {plotted.map((entry, index) => {
            const color = LINE_COLORS[index % LINE_COLORS.length] ?? '#6366f1';
            const path = linePath(entry.points);
            const last = entry.points[entry.points.length - 1];
            if (last === undefined) return null;
            return (
              <g key={entry.user.id}>
                {config.showArea ? (
                  <path
                    d={`${path} L${x(last.t)},${padding.top + plotH} L${x(entry.points[0]?.t ?? data.from)},${padding.top + plotH} Z`}
                    fill={color}
                    opacity={0.12}
                  />
                ) : null}
                <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            );
          })}

          {hoveredAt !== null ? (
            <>
              <line
                x1={x(hoveredAt)}
                x2={x(hoveredAt)}
                y1={padding.top}
                y2={padding.top + plotH}
                stroke="currentColor"
                strokeWidth={1}
                className="text-white/25"
              />
              {readings.map((row) => (
                <circle
                  key={row.name}
                  // On the crosshair, not on the point that set the value: with step
                  // lines that is exactly where the line is, and with sampled data the
                  // two coincide anyway.
                  cx={x(hoveredAt)}
                  cy={y(row.point.v)}
                  r={3.5}
                  fill={row.color}
                  stroke="var(--color-ground-soft)"
                  strokeWidth={1.5}
                />
              ))}
            </>
          ) : null}

          {/* Pass 2: the markers, on top of everything. */}
          {plotted.map((entry, index) => {
            const color = LINE_COLORS[index % LINE_COLORS.length] ?? '#6366f1';
            const last = entry.points[entry.points.length - 1];
            if (last === undefined) return null;
            const lastX = x(last.t);
            const lastY = y(last.v);
            const avatarUrl = assetUrl(entry.user.avatarUrl ?? null);
            const drawAvatar = config.marker === 'avatar' || config.marker === 'both';
            const drawName = config.marker === 'name' || config.marker === 'both';
            const labelX = lastX + (drawAvatar ? avatar / 2 + 6 : 8);

            return (
              <g key={entry.user.id}>
                {/* A single sample is a dot, not a line — without this it renders as nothing. */}
                {drawAvatar ? null : <circle cx={lastX} cy={lastY} r={3} fill={color} />}

                {drawAvatar ? (
                  <>
                    <clipPath id={`avatar-${entry.user.id}`}>
                      <circle cx={lastX} cy={lastY} r={avatar / 2} />
                    </clipPath>
                    {/* Opaque disc underneath, always: the tint below is translucent and
                        an image may have transparent corners, and either way the line
                        must not show through the marker sitting on top of it. */}
                    <circle cx={lastX} cy={lastY} r={avatar / 2} fill="var(--color-ground-soft)" />
                    {avatarUrl ? (
                      <image
                        href={avatarUrl}
                        x={lastX - avatar / 2}
                        y={lastY - avatar / 2}
                        width={avatar}
                        height={avatar}
                        preserveAspectRatio="xMidYMid slice"
                        clipPath={`url(#avatar-${entry.user.id})`}
                      />
                    ) : (
                      // No picture synced: initials keep the marker readable instead of
                      // dropping to an anonymous dot.
                      <>
                        <circle cx={lastX} cy={lastY} r={avatar / 2} fill={color} opacity={0.25} />
                        <text
                          x={lastX}
                          y={lastY + avatar * 0.14}
                          textAnchor="middle"
                          fill={color}
                          style={{ fontSize: avatar * 0.42 }}
                        >
                          {initials(entry.user.fullname)}
                        </text>
                      </>
                    )}
                    <circle cx={lastX} cy={lastY} r={avatar / 2} fill="none" stroke={color} strokeWidth={2} />
                  </>
                ) : null}

                {drawName ? (
                  <text x={labelX} y={lastY + 4} fill={color} className="text-[11px]">
                    {entry.user.fullname.length > 12
                      ? `${entry.user.fullname.slice(0, 11)}…`
                      : entry.user.fullname}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>

        {hoveredAt !== null && readings.length > 0 ? (
          // Plain HTML rather than SVG text: wrapping, padding and a backdrop are free
          // here and each costs a hand-measured rect in SVG. Flipped to the left of the
          // cursor once it gets close to the right edge so it never leaves the widget.
          <div
            className="pointer-events-none absolute z-10 rounded-lg border border-edge bg-ground-soft/95 px-2 py-1.5 text-xs shadow-widget"
            style={{
              left: x(hoveredAt) + (x(hoveredAt) > width - 150 ? -8 : 8),
              top: padding.top,
              transform: x(hoveredAt) > width - 150 ? 'translateX(-100%)' : undefined,
            }}
          >
            <p className="mb-1 text-[10px] text-muted">{stopLabel(hoveredAt, spanMs)}</p>
            <ul className="space-y-0.5">
              {readings.map((row) => (
                <li key={row.name} className="flex items-center gap-1.5 whitespace-nowrap">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: row.color }}
                  />
                  <span className="max-w-28 truncate">{row.name}</span>
                  <span className="ml-auto pl-2 tabular-nums">{format(row.point.v)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {config.showLegend ? (
        <ul className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 text-xs">
          {plotted.map((entry, index) => (
            <li key={entry.user.id} className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: LINE_COLORS[index % LINE_COLORS.length] }}
              />
              <span className="truncate">{entry.user.fullname}</span>
              <span className="tabular-nums text-muted">
                {data.metric === 'percent'
                  ? `${Math.round(entry.points[entry.points.length - 1]?.v ?? 0)}%`
                  : (entry.points[entry.points.length - 1]?.v ?? 0)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The other renderers
// ---------------------------------------------------------------------------

function CompletionTable({ data, density }: { data: CompletionTableData; density: Density }) {
  // `cellPad`, not `cell`: the row loop below binds `cell` to the completion entry.
  const { cell: cellPad, text } = DENSITY[density];
  if (data.rows.length === 0) {
    return <EmptyState icon={<Table2 className="h-6 w-6" />} title="No enrolled students yet" />;
  }
  return (
    // Scrolls inside the widget so a wide table never makes the page scroll sideways.
    <div className="h-full overflow-auto">
      <table className={cn('w-full border-collapse', text)}>
        <thead className="sticky top-0 bg-ground-soft/95 backdrop-blur">
          <tr>
            <th className={cn('text-left font-medium text-muted', cellPad)}>Student</th>
            {data.courses.map((course) => (
              <th
                key={course.id}
                className={cn('min-w-32 text-left font-medium text-muted', cellPad)}
                title={course.fullname}
              >
                {course.shortname}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.user.id} className="border-t border-edge/60">
              <td className={cn('whitespace-nowrap', cellPad)}>{row.user.fullname}</td>
              {data.courses.map((course) => {
                const cell = row.cells.find((c) => c.courseId === course.id);
                return (
                  <td key={course.id} className={cellPad}>
                    {cell ? (
                      <ProgressBar entry={cell} />
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Gold / silver / bronze for the top three badge counts. The accent lives on the
 * card's own border rather than a ring: a ring is a box-shadow, so it gets clipped
 * by the scroll container and the top and bottom rows look cut off.
 */
const PLACE_STYLES = [
  { border: 'border-amber-400/50', text: 'text-amber-300', label: '1st' },
  { border: 'border-slate-300/40', text: 'text-slate-300', label: '2nd' },
  { border: 'border-amber-700/60', text: 'text-amber-600', label: '3rd' },
];

/**
 * One card per student, stacked in bands: who, then how far along, then which badges.
 * `showProgress` is the only difference between the two badge widgets.
 */
function BadgeCards({
  data,
  showProgress,
  density,
  badgeSize,
}: {
  data: BadgeCardsData | BadgeListData;
  showProgress: boolean;
  density: Density;
  badgeSize: BadgeSize;
}) {
  const { gap, pad, bar } = DENSITY[density];
  if (data.users.length === 0) {
    return <EmptyState icon={<Award className="h-6 w-6" />} title="Nobody enrolled yet" />;
  }

  // Rows are pre-sorted by badge count, but only award a trophy to someone who
  // actually holds badges — otherwise an empty course hands out three trophies.
  return (
    <div className={gap}>
      {data.users.map((entry, index) => {
        const place = entry.badges.length > 0 ? PLACE_STYLES[index] : undefined;
        return (
          <div
            key={entry.user.id}
            className={cn(
              'rounded-xl border bg-white/3',
              gap,
              pad,
              place ? place.border : 'border-edge',
            )}
          >
            <div className="flex items-center gap-2">
              {place ? (
                <span className={cn('flex shrink-0 items-center gap-1.5 text-xs', place.text)}>
                  <Trophy className="h-4 w-4" />
                  {place.label}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate font-medium">{entry.user.fullname}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted">
                {entry.badges.length} {entry.badges.length === 1 ? 'badge' : 'badges'}
              </span>
            </div>

            {showProgress ? (
              entry.percent === null ? (
                <p className="text-xs text-muted">Completion not tracked</p>
              ) : (
                // Full width: the bar is the headline number of this widget.
                <div className="flex items-center gap-3">
                  <span className={cn('flex-1 overflow-hidden rounded-full bg-white/10', bar)}>
                    <span
                      className={cn('block h-full rounded-full', bandClass(entry.percent))}
                      style={{ width: `${entry.percent}%` }}
                    />
                  </span>
                  <span className="w-10 shrink-0 text-right text-sm tabular-nums text-muted">
                    {Math.round(entry.percent)}%
                  </span>
                </div>
              )
            ) : null}

            <div className={cn('border-t border-edge/60', density === 'compact' ? 'pt-1.5' : 'pt-3')}>
              <BadgeList badges={entry.badges} badgeSize={badgeSize} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CourseOverview({ data, density }: { data: CourseOverviewData; density: Density }) {
  const untracked = data.averagePercent === null;
  return (
    <div className="flex h-full flex-col justify-center gap-3">
      <div>
        <p className={cn('font-semibold tabular-nums',
          density === 'compact' ? 'text-3xl' : density === 'roomy' ? 'text-5xl' : 'text-4xl')}>
          {untracked ? 'Not tracked' : `${Math.round(data.averagePercent ?? 0)}%`}
        </p>
        <p className="text-xs text-muted">
          {untracked ? 'This course has no completion-tracked activities' : 'Class average'}
        </p>
      </div>
      {!untracked ? (
        <div className="h-2 overflow-hidden rounded-full bg-white/10">
          <div
            className={cn('h-full rounded-full', bandClass(data.averagePercent ?? 0))}
            style={{ width: `${data.averagePercent ?? 0}%` }}
          />
        </div>
      ) : null}
      <dl className="flex gap-6 text-sm">
        <div>
          <dt className="text-xs text-muted">Students</dt>
          <dd className="tabular-nums">{data.enrolledCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Tracked activities</dt>
          <dd className="tabular-nums">{data.trackedActivityCount}</dd>
        </div>
      </dl>
    </div>
  );
}

function Leaderboard({ data, density }: { data: LeaderboardData; density: Density }) {
  const { cell, text } = DENSITY[density];
  if (data.entries.length === 0) {
    return <EmptyState icon={<Trophy className="h-6 w-6" />} title="No badges awarded yet" />;
  }
  const medal = ['text-amber-300', 'text-slate-300', 'text-amber-600'];
  return (
    <ol className="space-y-1 overflow-auto">
      {data.entries.map((entry, index) => (
        <li
          key={entry.user.id}
          className={cn('flex items-center gap-3 rounded-lg odd:bg-white/3', cell, text)}
        >
          <span
            className={cn('w-5 shrink-0 text-center tabular-nums', medal[index] ?? 'text-muted')}
          >
            {index < 3 ? <Trophy className="mx-auto h-4 w-4" /> : index + 1}
          </span>
          <span className="flex-1 truncate">{entry.user.fullname}</span>
          <span className="shrink-0 tabular-nums text-muted">{entry.badgeCount}</span>
        </li>
      ))}
    </ol>
  );
}

function UserList({
  data,
  density,
  badgeSize,
}: {
  data: UserListData;
  density: Density;
  badgeSize: BadgeSize;
}) {
  return (
    <div className={cn('overflow-auto', DENSITY[density].gap)}>
      <p className="text-sm font-medium">{data.user.fullname}</p>
      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-muted">Badges</p>
        <BadgeList badges={data.badges} badgeSize={badgeSize} />
      </div>
      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-muted">Completion</p>
        {data.completion.length === 0 ? (
          <p className="text-xs text-muted">Not enrolled in any course in scope</p>
        ) : (
          <ul className="space-y-2">
            {data.completion.map(({ course, entry }) => (
              <li key={course.id} className="text-sm">
                <p className="mb-1 truncate text-xs text-muted" title={course.fullname}>
                  {course.fullname}
                </p>
                <ProgressBar entry={entry} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function autoTitle(widget: Widget, data: Payload | null): string {
  if (data && data.type !== 'error') {
    switch (data.type) {
      case 'completion_table':
        return data.courses.length === 1 && data.courses[0]
          ? `Completion — ${data.courses[0].fullname}`
          : 'Completion — all courses';
      case 'badge_cards':
      case 'badge_list':
        return data.users.length === 1 && data.users[0]
          ? `Badges — ${data.users[0].user.fullname}`
          : 'Badges';
      case 'course_overview':
        return `${data.course.shortname} overview`;
      case 'leaderboard':
        return 'Leaderboard';
      case 'user_list':
        return data.user.fullname;
      case 'progress_chart':
        return data.metric === 'badges' ? 'Badges over time' : 'Completion over time';
    }
  }
  const labels: Record<Widget['type'], string> = {
    completion_table: 'Completion',
    badge_cards: 'Badges & progress',
    badge_list: 'Badges',
    course_overview: 'Course overview',
    leaderboard: 'Leaderboard',
    user_list: 'User',
    progress_chart: 'Over time',
  };
  return labels[widget.type];
}

export const WIDGET_META: Record<
  Widget['type'],
  { label: string; description: string; icon: typeof Table2 }
> = {
  completion_table: {
    label: 'Completion table',
    description: 'Students against courses, as completion percentages.',
    icon: Table2,
  },
  badge_cards: {
    label: 'Badges & progress',
    description:
      'A row per student: completion, every badge they hold, and gold/silver/bronze for the top three.',
    icon: Award,
  },
  badge_list: {
    label: 'Badges',
    description: 'The same rows without the completion bar — badges only.',
    icon: Medal,
  },
  course_overview: {
    label: 'Course overview',
    description: 'Class-average completion and enrolment for one course.',
    icon: BookOpen,
  },
  leaderboard: {
    label: 'Leaderboard',
    description: 'Students ranked by how many badges they hold.',
    icon: Trophy,
  },
  user_list: {
    label: 'User',
    description: 'One student: their badges and completion across courses.',
    icon: User,
  },
  progress_chart: {
    label: 'Over time',
    description:
      'Badges or completion plotted over the last week, one line per student — names or profile pictures at the front of each line.',
    icon: TrendingUp,
  },
};

/** Fetches and renders a widget's own data, refreshing it periodically. */
export function WidgetBody({
  widget,
  publicToken,
  onData,
}: {
  widget: Widget;
  publicToken?: string;
  onData?: (data: Payload) => void;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const path = publicToken
    ? `/api/public/${publicToken}/widgets/${widget.id}/data`
    : `/api/widgets/${widget.id}/data`;

  // Config is compared by value: the object identity changes on every render.
  const configKey = JSON.stringify(widget.config);

  const load = useCallback(async () => {
    try {
      const next = await api.get<Payload>(path);
      setData(next);
      setError(null);
      onData?.(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
    // onData is intentionally excluded — callers pass an inline closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, configKey]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading && !data) {
    return (
      <div className="grid h-full min-h-20 place-items-center">
        <Spinner />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="space-y-2 p-2">
        <ErrorNote message={error} />
        <Button variant="subtle" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!data) return null;

  // A widget pointing at a course that was deleted in Moodle degrades to a note.
  if (data.type === 'error') {
    return <EmptyState title={data.message} />;
  }

  const density = densityOf(widget.config);
  const badgeSize = badgeSizeOf(widget.config);

  switch (data.type) {
    case 'completion_table':
      return <CompletionTable data={data} density={density} />;
    case 'badge_cards':
      return <BadgeCards data={data} showProgress density={density} badgeSize={badgeSize} />;
    case 'badge_list':
      return <BadgeCards data={data} showProgress={false} density={density} badgeSize={badgeSize} />;
    case 'course_overview':
      return <CourseOverview data={data} density={density} />;
    case 'leaderboard':
      return <Leaderboard data={data} density={density} />;
    case 'user_list':
      return <UserList data={data} density={density} badgeSize={badgeSize} />;
    case 'progress_chart':
      return <ProgressChart data={data} config={chartOptionsOf(widget.config)} />;
    default:
      return null;
  }
}
