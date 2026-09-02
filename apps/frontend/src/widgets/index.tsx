import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  BadgeCardsData,
  BadgeListData,
  Badge as BadgeType,
  CompletionEntry,
  CompletionRingsData,
  CompletionRingsEntry,
  CompletionTableData,
  CourseOverviewData,
  LeaderboardData,
  ProgressChartData,
  UserListData,
  Widget,
  WidgetData,
  WidgetDataError,
} from '@moodify/shared';
import {
  Award,
  BookOpen,
  Check,
  CircleDashed,
  LineChart,
  Medal,
  Table2,
  TrendingUp,
  Trophy,
  User,
  X,
} from 'lucide-react';
import type {
  BadgeSize,
  ChartMarker,
  Density,
  RingLegendItem,
  RingMarker,
  RingSize,
} from '@moodify/shared';
import { badgeSectionsOf, type BadgeSection } from '@moodify/shared';
import { createPortal } from 'react-dom';
import { api, assetUrl, cn, errorMessage } from '@/lib/api';
import { Button, Dialog, EmptyState, ErrorNote, Spinner } from '@/ui';

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

/**
 * Badge icon size, set per widget and independent of row size. `track` is the minimum
 * column width where the grid picks its own column count; a fixed count ignores it and
 * shrinks the text instead — see badgeNameFontSize.
 */
const BADGE_SIZE: Record<BadgeSize, { icon: string; text: string; pad: string; track: string }> = {
  small: { icon: 'h-9 w-9', text: 'text-xs', pad: 'p-1 pr-3', track: '11rem' },
  medium: { icon: 'h-12 w-12', text: 'text-sm', pad: 'p-1.5 pr-3.5', track: '13rem' },
  large: { icon: 'h-16 w-16', text: 'text-base', pad: 'p-2 pr-4', track: '15rem' },
};

/** Name size where badges share a tile with a ring and its rows — one step down. */
const BADGE_TEXT_TIGHT: Record<BadgeSize, string> = {
  small: 'text-[10px]',
  medium: 'text-xs',
  large: 'text-sm',
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

/**
 * Colour for a completion bar: light blue for progress, red when a deadline has been
 * missed. Deliberately not a red/amber/green band — see --color-progress in index.css.
 */
function barClass(overdue: number): string {
  return overdue > 0 ? 'bg-bad' : 'bg-progress';
}

function overdueLabel(overdue: number): string {
  return `${overdue} overdue ${overdue === 1 ? 'activity' : 'activities'}`;
}

function ProgressBar({ entry }: { entry: CompletionEntry }) {
  // A course with nothing to complete reads as 0%, not as a dash. The distinction the
  // spec asks for is kept where it matters — percent_complete stays NULL in the database,
  // so course_overview still averages tracked courses only — but on a wall display a row
  // of dashes just looks broken. The 0/0 in the tooltip is what says "nothing tracked".
  const percent = entry.percent ?? 0;
  const activities = `${entry.activitiesCompleted}/${entry.activitiesTotal} activities`;
  return (
    <span
      className="flex items-center gap-2"
      title={entry.overdue > 0 ? `${activities} — ${overdueLabel(entry.overdue)}` : activities}
    >
      <span className="h-1.5 w-full min-w-10 overflow-hidden rounded-full bg-white/10">
        <span
          className={cn('block h-full rounded-full', barClass(entry.overdue))}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="shrink-0 tabular-nums text-xs text-muted">{Math.round(percent)}%</span>
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
 * Icon + full name as one chip. Names sit beside the icon rather than under it, so they
 * show in full without each badge costing a whole block of height.
 *
 * `uniform` swaps the flex wrap for a grid, so every chip is the same width whatever its
 * name is. Under a ring that matters: a row of chips at four different widths reads as
 * clutter. Left alone elsewhere, where a chip hugging its name is the better shape.
 *
 * `columns` fixes the count — two under a ring, whatever the tile's width, because that
 * is what keeps a person with fifteen badges to a readable block instead of a column
 * fifteen rows tall. The column width is therefore not negotiable, so the *text* is what
 * gives: the name is set at whatever size makes its longest word fit on one line, down to
 * a floor. That is the only way to have both a fixed column count and no "Netzwerktech /
 * nik" mid-word break, which is the one failure that makes a wall of badges unreadable.
 */

/** Roughly how wide one character is, as a fraction of the font size, in the UI stack. */
const CHAR_WIDTH = 0.62;

/** Font size in rem for each badge-name step, matching BADGE_SIZE / BADGE_TEXT_TIGHT. */
const BADGE_FONT_REM: Record<BadgeSize, number> = { small: 0.75, medium: 0.875, large: 1 };
const BADGE_FONT_TIGHT_REM: Record<BadgeSize, number> = { small: 0.625, medium: 0.75, large: 0.875 };

/** Icon diameter plus the chip's own padding and gap, in rem — the width the name cannot use. */
const BADGE_CHIP_CHROME: Record<BadgeSize, number> = { small: 3.5, medium: 4.5, large: 5.75 };

/** Never shrink past this, however long the word. Below it nothing is readable anyway. */
const BADGE_FONT_FLOOR_REM = 0.5;

/**
 * A font size that makes the longest word in `names` fit one line of a chip, expressed
 * against the chip's own width.
 *
 * `cqw` is 1% of the container's inline size, so this needs no measurement in JS and
 * re-solves itself when the widget is resized. One size for the whole list rather than
 * per chip: every column is the same width, so differing sizes would only read as
 * sloppiness. Where container queries are unsupported the whole declaration is invalid
 * and the Tailwind text class it sits on top of takes over — with word breaking, but
 * legible.
 */
export function badgeNameFontSize(
  names: readonly string[],
  badgeSize: BadgeSize,
  tight: boolean,
): string {
  const longest = names.reduce(
    (max, name) => name.split(/\s+/).reduce((inner, word) => Math.max(inner, word.length), max),
    1,
  );
  const base = tight ? BADGE_FONT_TIGHT_REM[badgeSize] : BADGE_FONT_REM[badgeSize];
  const chrome = BADGE_CHIP_CHROME[badgeSize];
  const room = (longest * CHAR_WIDTH).toFixed(2);
  return `clamp(${BADGE_FONT_FLOOR_REM}rem, calc((100cqw - ${chrome}rem) / ${room}), ${base}rem)`;
}

function BadgeList({
  badges,
  badgeSize,
  uniform,
  columns,
  tight,
  onSelect,
  names,
  padTo,
}: {
  badges: BadgeType[];
  badgeSize: BadgeSize;
  uniform?: boolean;
  /** Fixed column count. Without it the uniform grid fits as many as the width allows. */
  columns?: number;
  /** Drops the name a text step. Set where badges share a tile with everything else. */
  tight?: boolean;
  /** Makes each chip a button. Unset leaves them plain text, which is what most callers want. */
  onSelect?: (badge: BadgeType) => void;
  /** Names the text scales against. Set it to a superset when several lists must match. */
  names?: readonly string[];
  /** Reserve this many chip slots, filling the spare ones with blanks. */
  padTo?: number;
}) {
  const blanks = Math.max(0, (padTo ?? 0) - badges.length);
  if (badges.length === 0 && blanks === 0) {
    return <p className="text-xs text-muted">No badges yet</p>;
  }
  const { icon, text, pad, track } = BADGE_SIZE[badgeSize];
  const grid = uniform || columns !== undefined;
  const fontSize = badgeNameFontSize(
    names ?? badges.map((badge) => badge.name),
    badgeSize,
    tight === true,
  );
  const Chip = onSelect === undefined ? 'span' : 'button';
  return (
    <ul
      className={cn('gap-2', grid ? 'grid' : 'flex flex-wrap')}
      style={
        grid
          ? {
              gridTemplateColumns:
                columns === undefined
                  ? `repeat(auto-fill, minmax(${track}, 1fr))`
                  : `repeat(${columns}, minmax(0, 1fr))`,
            }
          : undefined
      }
    >
      {badges.map((badge) => (
        // The chip is the query container the name sizes itself against.
        <li key={badge.id} className={cn(grid && 'min-w-0')} style={grid ? { containerType: 'inline-size' } : undefined}>
          <Chip
            type={onSelect === undefined ? undefined : 'button'}
            onClick={onSelect === undefined ? undefined : () => onSelect(badge)}
            className={cn(
              'flex w-full items-center gap-2 rounded-full bg-white/6 text-left',
              pad,
              onSelect === undefined ? '' : 'transition hover:bg-white/12',
            )}
            title={badge.customDescription ?? badge.description ?? badge.name}
          >
            <BadgeImage badge={badge} size={icon} />
            <span
              className={cn('min-w-0 leading-snug break-words', tight ? BADGE_TEXT_TIGHT[badgeSize] : text)}
              style={grid ? { fontSize } : undefined}
            >
              {badge.name}
            </span>
          </Chip>
        </li>
      ))}
      {/* Reserved slots. Same markup as a chip, invisible: an empty box of a guessed
          height would drift out of step with the real ones the moment a size changed. */}
      {Array.from({ length: blanks }, (_, index) => (
        <li key={`blank-${index}`} className={cn(grid && 'min-w-0', 'invisible')} aria-hidden="true">
          <span className={cn('flex w-full items-center gap-2 rounded-full', pad)}>
            <span className={cn('shrink-0 rounded-full', icon)} />
            <span
              className={cn('leading-snug', tight ? BADGE_TEXT_TIGHT[badgeSize] : text)}
              style={grid ? { fontSize } : undefined}
            >
              &nbsp;
            </span>
          </span>
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

/** The one red in the app. In a ring it means overdue and nothing else. */
const OVERDUE_COLOR = '#f43f5e';

/** The schedule mark. Pink rather than white: present without competing with the fill. */
const TARGET_COLOR = '#ffc2e0';
export { TARGET_COLOR as DEFAULT_TARGET_COLOR };

/**
 * Segment colours, generated from the number of courses on screen rather than picked
 * from a fixed list.
 *
 * A fixed list has to wrap, and any list long enough not to wrap immediately ends up
 * holding four things that all read as "blue" — sky, cyan, indigo and teal are distinct
 * on a swatch and identical in a 12px arc across the room. Spacing the hues evenly over
 * however many courses are actually shown guarantees the largest gap the palette can
 * give: four courses land 75° apart, eight land 37° apart.
 *
 * The band runs 30°–330°, so nothing ever lands in the red the overdue state owns. The
 * alternating lightness is for the high end, where neighbouring hues get close enough
 * that a brightness step does more work than the hue difference does.
 *
 * Adding a course therefore re-colours the ring. The legend is generated from the same
 * function, so it always agrees — and a wrapping list would have re-coloured things too,
 * just less predictably.
 */
const RING_HUE_START = 30;
const RING_HUE_SPAN = 300;
const RING_MAX_HUES = 12;

export function ringColorAt(index: number, total: number): string {
  const step = RING_HUE_SPAN / Math.min(Math.max(total, 1), RING_MAX_HUES);
  const hue = (RING_HUE_START + index * step) % 360;
  return `hsl(${hue.toFixed(1)} 78% ${index % 2 === 0 ? 62 : 72}%)`;
}

/**
 * The colour of each segment, by key.
 *
 * Manual mode falls back to the generated hue for anything left unset rather than to a
 * placeholder: picking a colour for one segment out of six is a normal half-finished
 * state, and it should look unfinished, not broken.
 */
function ringColorMap(
  legend: RingLegendItem[],
  options: Pick<RingOptions, 'colorMode' | 'colors'>,
): Map<string, string> {
  return new Map(
    legend.map((item, index) => [
      item.key,
      (options.colorMode === 'manual' ? options.colors[item.key] : undefined) ??
        ringColorAt(index, legend.length),
    ]),
  );
}

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

  /**
   * Instance prefix for the clipPath ids below.
   *
   * SVG ids are document-global. Two charts on one dashboard showing the same student
   * both defined `#avatar-7`, and `url(#avatar-7)` resolves to whichever came first in
   * the document — so the second chart clipped its faces against the first chart's
   * circle, at the first chart's coordinates. Same size and position: invisible clip,
   * looks fine. Different size or position: the picture is cut off, or clipped away
   * entirely leaving the bare disc behind it. Colons are stripped because React's ids
   * contain them and they have no business in a url() fragment.
   */
  const instance = useId().replace(/:/g, '');

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
                    <clipPath id={`${instance}-avatar-${entry.user.id}`}>
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
                        clipPath={`url(#${instance}-avatar-${entry.user.id})`}
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
              // Full width: the bar is the headline number of this widget. Nothing
              // tracked reads as 0%, same as everywhere else.
              <div className="flex items-center gap-3">
                <span className={cn('flex-1 overflow-hidden rounded-full bg-white/10', bar)}>
                  <span
                    className={cn('block h-full rounded-full', barClass(entry.overdue))}
                    style={{ width: `${entry.percent ?? 0}%` }}
                  />
                </span>
                <span className="w-10 shrink-0 text-right text-sm tabular-nums text-muted">
                  {Math.round(entry.percent ?? 0)}%
                </span>
              </div>
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
      {/* barClass(0): a class average is nobody's deadline, so no one here can be overdue. */}
      {!untracked ? (
        <div className="h-2 overflow-hidden rounded-full bg-white/10">
          <div
            className={cn('h-full rounded-full', barClass(0))}
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
// completion_rings
// ---------------------------------------------------------------------------

/**
 * The minimum width of one person's tile, which is what "ring size" now controls: how
 * densely the wall packs before it wraps. The ring itself fills whatever width the column
 * ends up with, so a wider widget means bigger rings rather than more empty space.
 *
 * Doubles as the SVG's viewBox extent — an arbitrary coordinate space, kept equal to the
 * minimum so strokes and text are proportioned for the smallest size they will be drawn at.
 */
const RING_PX: Record<RingSize, number> = { small: 96, medium: 128, large: 172 };

interface RingOptions {
  ringSize: RingSize;
  colorMode: 'auto' | 'manual';
  /** Segment key -> hex. Only read in manual mode; missing keys fall back to the hue. */
  colors: Record<string, string>;
  marker: RingMarker;
  showTarget: boolean;
  targetColor: string;
  showBadges: boolean;
  badgeSize: BadgeSize;
  badgeSections: BadgeSection[];
}

function ringOptionsOf(config: unknown): RingOptions {
  const raw = (config ?? {}) as Record<string, unknown>;
  const size = raw.ringSize;
  const marker = raw.marker;
  const badge = raw.badgeSize;
  return {
    ringSize: (size === 'small' || size === 'large' ? size : 'medium') as RingSize,
    colorMode: raw.colorMode === 'manual' ? 'manual' : 'auto',
    colors:
      typeof raw.colors === 'object' && raw.colors !== null
        ? (raw.colors as Record<string, string>)
        : {},
    marker: (marker === 'avatar' || marker === 'both' ? marker : 'name') as RingMarker,
    showTarget: raw.showTarget !== false,
    targetColor:
      typeof raw.targetColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.targetColor)
        ? raw.targetColor
        : TARGET_COLOR,
    showBadges: raw.showBadges === true,
    badgeSize: (badge === 'medium' || badge === 'large' ? badge : 'small') as BadgeSize,
    badgeSections: Array.isArray(raw.badgeSections) ? (raw.badgeSections as BadgeSection[]) : [],
  };
}


/**
 * An arc of `r` around (cx, cy), from `from` to `to` in radians measured clockwise from
 * twelve o'clock. Never called with a full turn — the inter-segment gap always leaves a
 * sliver, and a 360° arc would collapse to a zero-length path because its two endpoints
 * are the same point.
 */
function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const at = (angle: number) =>
    `${(cx + r * Math.sin(angle)).toFixed(2)} ${(cy - r * Math.cos(angle)).toFixed(2)}`;
  return `M ${at(from)} A ${r} ${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${at(to)}`;
}

/**
 * The verdict under the name.
 *
 * Overdue outranks everything, as one red chip counting the activities. It used to list
 * them by name, which was the more useful thing to read and the worse thing to look at:
 * the block grew with the backlog, so the tiles it appeared on stood a line or four
 * taller than the rest and the wall stopped lining up. The names live on in the chip's
 * tooltip, where they cost no height.
 *
 * The old percentage-based "ahead of plan / behind plan" is gone. It was derived from a
 * target that projected deadline compliance onto the completion axis, which is not a
 * scale anything can be ahead on — with per-activity dates there is no pace to beat.
 * What remains is true and checkable: work finished before its date came round.
 *
 * Ahead of time gets the same weight on the tile as overdue does — a chip rather than a
 * bare grey line — because the two are the same measurement in opposite directions, and
 * only one of them being worth looking at is a claim about the students, not the data.
 */
function earlyLabel(earlyDone: number): string {
  return `${earlyDone} ${earlyDone === 1 ? 'activity' : 'activities'} completed ahead of time`;
}

/**
 * Per-course rows: colour, course, percentage.
 *
 * No overdue count. It used to sit in a fourth column as a red "!3", and between the red
 * segment in the ring and the red chip under the name the tile already says so twice —
 * the exclamation mark only added something to flinch at. The count survives as the
 * row's tooltip.
 *
 * Laid out as one grid with fixed side columns, not as flex rows, so the numbers sit at
 * the same x on every tile — a table read across a wall of them, without the ruled lines
 * an actual table would bring. `rows` pads every tile out to the busiest person's course
 * count, which keeps the tiles the same height and lines the badges up underneath.
 */
function SegmentRows({
  entry,
  colorOf,
  rows,
}: {
  entry: CompletionRingsEntry;
  colorOf: (segmentKey: string) => string;
  rows: number;
}) {
  const padding = Math.max(0, rows - entry.segments.length);
  return (
    <dl
      className="grid w-full items-center gap-x-1.5 gap-y-0.5 text-[11px]"
      style={{ gridTemplateColumns: 'auto minmax(0, 1fr) 2.4rem' }}
    >
      {entry.segments.map((segment) => (
        <Fragment key={segment.key}>
          <span className="h-2 w-2 rounded-full" style={{ background: colorOf(segment.key) }} />
          <dt className="truncate text-muted" title={segment.title}>
            {segment.label}
          </dt>
          <dd
            className="text-right tabular-nums"
            title={segment.overdue > 0 ? overdueLabel(segment.overdue) : undefined}
          >
            {Math.round(segment.percent ?? 0)}%
          </dd>
        </Fragment>
      ))}
      {/* Blank rows so every tile is the same height whatever its course count. A
          non-breaking space rather than a height: the filler is the same font at the
          same size as a real row, so it is exactly as tall as one — a hand-picked em
          height was close but never equal, and the drift showed up as tiles whose
          badges sat a pixel or two off from their neighbours'. */}
      {Array.from({ length: padding }, (_, index) => (
        <span key={`pad-${index}`} className="col-span-3" aria-hidden="true">
          &nbsp;
        </span>
      ))}
    </dl>
  );
}

/**
 * One person: a ring cut into a segment per course they are enrolled in, each filled to
 * that course's completion in that course's colour. A segment holding an overdue
 * activity is drawn in red — the only thing here that is a judgement rather than a
 * reading — and a tick marks where their deadlines say they should be by today.
 */
function PersonRing({
  entry,
  colorOf,
  options,
  instance,
  rows,
  badgeSlots,
  onBadge,
}: {
  entry: CompletionRingsEntry;
  colorOf: (segmentKey: string) => string;
  /** Segment count of the busiest person, so every tile reserves the same room. */
  rows: number;
  /** Chip slots to reserve per badge section — the busiest tile's count, per section. */
  badgeSlots: number[];
  options: RingOptions;
  instance: string;
  onBadge: (badge: BadgeType) => void;
}) {
  const size = RING_PX[options.ringSize];
  const stroke = Math.max(8, Math.round(size * 0.11));
  const radius = (size - stroke) / 2;
  const center = size / 2;
  const inner = size - stroke * 2 - 6;
  const slice = (Math.PI * 2) / Math.max(1, entry.segments.length);
  // Enough of a gap to read the segments apart, but never so much that a two-course
  // ring looks like two unrelated arcs.
  const gap = Math.min(0.12, slice * 0.14);

  const withAvatar = options.marker === 'avatar' || options.marker === 'both';
  // Flattened across the segments and de-duplicated: the same activity cannot be in two
  // courses, but a person reachable through two cohorts would otherwise be listed twice.
  const overdueActivities = [
    ...new Set(entry.segments.flatMap((segment) => segment.overdueActivities)),
  ];
  const avatar = entry.user.avatarUrl ? assetUrl(entry.user.avatarUrl) : null;

  // Percentages live in the middle of the ring — unless a face is sitting there, in
  // which case they move to the rows underneath and nothing is lost.
  const centreFont = withAvatar
    ? 0
    : Math.min(inner * 0.3, (inner * 0.86) / (entry.segments.length * 1.3));
  const centreLine = centreFont * 1.3;

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-1 rounded-xl border p-3 text-center',
        entry.overdue > 0 ? 'border-bad/40 bg-bad/5' : 'border-edge/60 bg-white/3',
      )}
    >
      {/* No width/height: the viewBox is a coordinate space, and w-full lets the ring grow
          to whatever the column gives it. Everything inside — stroke, text, avatar — is
          expressed in those units, so the whole tile scales as one piece. */}
      <svg className="aspect-square w-full" viewBox={`0 0 ${size} ${size}`} role="img">
        <title>
          {entry.user.fullname}
          {entry.overdue > 0 ? ` — ${overdueLabel(entry.overdue)}` : ''}
        </title>
        {entry.segments.map((segment, index) => {
          const from = index * slice + gap / 2;
          const to = (index + 1) * slice - gap / 2;
          const span = to - from;
          // Colour comes from the segment, not from where it lands in this person's ring:
          // someone enrolled in only the third course must still get the third colour.
          const color = segment.overdue > 0 ? OVERDUE_COLOR : colorOf(segment.key);
          const fraction = (segment.percent ?? 0) / 100;
          const target = (segment.targetPercent ?? 0) / 100;

          return (
            <g key={segment.key}>
              <path
                d={arcPath(center, center, radius, from, to)}
                fill="none"
                stroke="rgba(255,255,255,0.09)"
                strokeWidth={stroke}
              />
              {/* The fill owns the inner half of the stroke and the schedule bar the
                  outer half, always — a fill at full width would read as "ahead" purely
                  by being fatter than the plan beside it, which is a difference in
                  meaning drawn as a difference in thickness. Two half-width tracks from
                  the same start compare by length and nothing else. */}
              {fraction > 0 ? (
                <path
                  d={arcPath(
                    center,
                    center,
                    radius - stroke / 4,
                    from,
                    from + span * Math.min(1, fraction),
                  )}
                  fill="none"
                  stroke={color}
                  strokeWidth={stroke / 2}
                >
                  <title>
                    {`${segment.title}: ${Math.round(segment.percent ?? 0)}%`}
                    {segment.targetPercent === null
                      ? ''
                      : ` (on schedule: ${Math.round(segment.targetPercent)}%)`}
                    {segment.overdue > 0 ? ` — ${overdueLabel(segment.overdue)}` : ''}
                  </title>
                </path>
              ) : null}
              {/* The plan, as a bar rather than a mark: it runs from the start of the
                  segment to where the deadlines say this person should be by today. A
                  tick said where the plan ends and nothing about how far it runs, which
                  is the half of the comparison the eye actually does. */}
              {options.showTarget && target > 0 ? (
                <path
                  d={arcPath(
                    center,
                    center,
                    radius + stroke / 4,
                    from,
                    from + span * Math.min(1, target),
                  )}
                  fill="none"
                  stroke={options.targetColor}
                  strokeWidth={stroke / 2}
                />
              ) : null}
            </g>
          );
        })}

        {withAvatar ? (
          <>
            {/* Instance-scoped id: SVG ids are document-global, so two ring widgets on
                one dashboard would otherwise clip every face against the first one. */}
            <clipPath id={`${instance}-ring-${entry.user.id}`}>
              <circle cx={center} cy={center} r={inner / 2} />
            </clipPath>
            <circle cx={center} cy={center} r={inner / 2} fill="rgba(255,255,255,0.07)" />
            {avatar ? (
              <image
                href={avatar}
                x={center - inner / 2}
                y={center - inner / 2}
                width={inner}
                height={inner}
                preserveAspectRatio="xMidYMid slice"
                clipPath={`url(#${instance}-ring-${entry.user.id})`}
              />
            ) : (
              <text
                x={center}
                y={center}
                textAnchor="middle"
                dominantBaseline="central"
                className="fill-ink font-medium"
                fontSize={Math.round(inner * 0.34)}
              >
                {initials(entry.user.fullname)}
              </text>
            )}
          </>
        ) : (
          entry.segments.map((segment, index) => {
            const y = center - ((entry.segments.length - 1) * centreLine) / 2 + index * centreLine;
            const blockW = centreFont * 3.4;
            return (
              <g key={segment.key}>
                <circle
                  cx={center - blockW / 2 + centreFont * 0.3}
                  cy={y}
                  r={centreFont * 0.22}
                  fill={segment.overdue > 0 ? OVERDUE_COLOR : colorOf(segment.key)}
                />
                <text
                  x={center - blockW / 2 + centreFont}
                  y={y}
                  dominantBaseline="central"
                  className={cn('font-medium tabular-nums', segment.overdue > 0 ? 'fill-bad' : 'fill-ink')}
                  fontSize={centreFont}
                >
                  {Math.round(segment.percent ?? 0)}%
                  <title>{segment.title}</title>
                </text>
              </g>
            );
          })
        )}
      </svg>

      {options.marker === 'avatar' ? null : (
        <p className="max-w-full truncate text-sm font-medium" title={entry.user.fullname}>
          {entry.user.fullname}
        </p>
      )}
      {/* Its own breathing room, top and bottom: the status is the one line that belongs
          to neither the ring nor the legend, and with only the tile's gap around it it
          reads as part of whichever it happens to sit closest to. */}
      <div className="my-1.5 w-full text-center">
      {entry.overdue > 0 ? (
        <p
          className="inline-flex max-w-full items-center gap-1 rounded-full bg-bad/12 px-2 py-0.5 text-[11px] font-medium text-bad"
          title={overdueActivities.join(', ')}
        >
          <X className="h-3 w-3 shrink-0" />
          <span className="truncate">{overdueLabel(entry.overdue)}</span>
        </p>
      ) : entry.earlyDone > 0 ? (
        <p className="inline-flex max-w-full items-center gap-1 rounded-full bg-good/12 px-2 py-0.5 text-[11px] font-medium text-good">
          <Check className="h-3 w-3 shrink-0" />
          <span className="truncate">{earlyLabel(entry.earlyDone)}</span>
        </p>
      ) : (
        // Blank rather than absent: a status line that appears on some tiles and not
        // others shifts everything below it out of alignment across the grid.
        <p className="text-[11px] text-muted">On track</p>
      )}
      </div>
      {withAvatar ? <SegmentRows entry={entry} colorOf={colorOf} rows={rows} /> : null}
      {options.showBadges ? (
        <div className="mt-3 w-full space-y-2">
          {/* Sections nobody in the whole widget holds a badge in are dropped; the rest
              are drawn on every tile, padded to the busiest tile's count, so a section
              starts at the same height whichever person you are looking at. */}
          {badgeSectionsOf(entry.badges, options.badgeSections)
            .map((section, index) => ({ section, slots: badgeSlots[index] ?? 0 }))
            .filter(({ slots }) => slots > 0)
            .map(({ section, slots }, index) => (
              <div key={`${index}-${section.name}`}>
                {section.name === '' ? null : (
                  <p className="mb-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                    {section.name}
                  </p>
                )}
                <BadgeList
                  badges={section.badges}
                  badgeSize={options.badgeSize}
                  uniform
                  columns={2}
                  tight
                  padTo={slots}
                  /* Every section on the tile sizes its text against the same set, so a
                     section of short names does not end up in bigger type than the one
                     above it. */
                  names={entry.badges.map((badge) => badge.name)}
                  onSelect={onBadge}
                />
              </div>
            ))}
          {badgeSlots.every((slot) => slot === 0) ? (
            <BadgeList badges={[]} badgeSize={options.badgeSize} uniform columns={2} tight />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CompletionRings({ data, config }: { data: CompletionRingsData; config: RingOptions }) {
  const instance = useId().replace(/:/g, '');
  const [openBadge, setOpenBadge] = useState<BadgeType | null>(null);
  const colors = ringColorMap(data.legend, config);
  const colorOf = (segmentKey: string) => colors.get(segmentKey) ?? '#38bdf8';

  if (data.entries.length === 0) {
    return (
      <EmptyState
        icon={<CircleDashed className="h-6 w-6" />}
        title="Nobody to show"
        hint="No student is enrolled in the selected courses, or nobody is in the selected cohorts."
      />
    );
  }

  const tile = RING_PX[config.ringSize] + 40;
  const rows = Math.max(...data.entries.map((entry) => entry.segments.length));
  // Per section, the most badges anybody holds in it. Sections are the same list for
  // every entry, so index i means the same section on every tile.
  const badgeSlots = data.entries
    .map((entry) => badgeSectionsOf(entry.badges, config.badgeSections))
    .reduce<number[]>(
      (most, groups) => groups.map((group, index) => Math.max(most[index] ?? 0, group.badges.length)),
      [],
    );

  return (
    // A flex column so the legend takes its own height and the grid gets the rest: with
    // the grid on min-h-full instead, the two together came to more than the widget and
    // every tile scrolled by the height of one line.
    <div className="flex h-full flex-col">
      {/* auto-fit, not auto-fill: empty tracks collapse, so three people on a full-width
          widget stretch across it and their rings grow with it, rather than huddling at
          the minimum width with dead space to the right. Ring size sets that minimum —
          how densely the wall packs — and no longer the literal pixel diameter.

          The courses have no legend above the wall: every tile already carries one, either
          in the middle of the ring or as the rows under it, so a second copy at the top
          said nothing the reader did not have in front of them. The schedule bar is the
          exception — see the line above the grid. */}
      {/* The one legend line left at the top. The courses lost theirs — every tile
          already names them — but the schedule bar is the same pink on every tile and
          names itself nowhere, so without this it is just a second bar in a colour. */}
      {config.showTarget ? (
        <p className="mb-2 flex shrink-0 items-center gap-2 text-[11px] text-muted">
          <span
            className="h-1.5 w-6 shrink-0 rounded-full"
            style={{ background: config.targetColor }}
          />
          Should be done by now
        </p>
      ) : null}
      <div
        className="grid flex-1 gap-3"
        style={{
          gridTemplateColumns: `repeat(auto-fit, minmax(${tile}px, 1fr))`,
          // min-content floor, 1fr ceiling: a row is never shorter than its tallest tile,
          // and any height the widget has spare is split between the rows instead of
          // pooling as dead space under the last one. A plain 1fr would squash the tiles
          // when the widget is smaller than its contents.
          gridAutoRows: 'minmax(min-content, 1fr)',
        }}
      >
        {data.entries.map((entry) => (
          <PersonRing
            key={entry.user.id}
            entry={entry}
            colorOf={colorOf}
            options={config}
            instance={instance}
            rows={rows}
            badgeSlots={badgeSlots}
            onBadge={setOpenBadge}
          />
        ))}
      </div>

      <BadgeDialog badge={openBadge} onClose={() => setOpenBadge(null)} />
    </div>
  );
}

/**
 * One badge, full size, with whatever description it has been given on the Badges page.
 *
 * Portalled to <body> because a react-grid-layout item positions itself with a CSS
 * transform, and a transformed ancestor makes `position: fixed` resolve against *it*
 * rather than the viewport — the overlay would be trapped inside the widget it came from,
 * clipped by its overflow, at the wrong place on screen.
 */
function BadgeDialog({ badge, onClose }: { badge: BadgeType | null; onClose: () => void }) {
  if (badge === null) return null;
  const image = assetUrl(badge.imageUrl);
  const text = badge.customDescription ?? badge.description;
  return createPortal(
    <Dialog open onClose={onClose} title={badge.name}>
      {image ? (
        <img
          src={image}
          alt=""
          className="mx-auto h-40 w-40 object-contain sm:h-52 sm:w-52"
        />
      ) : (
        <span className="mx-auto grid h-40 w-40 place-items-center rounded-full bg-white/8">
          <Award className="h-16 w-16 text-muted" aria-hidden="true" />
        </span>
      )}
      {text ? (
        <p className="whitespace-pre-wrap text-center text-sm text-muted">{text}</p>
      ) : (
        <p className="text-center text-sm text-muted">
          No description yet — one can be written on the Badges page.
        </p>
      )}
    </Dialog>,
    document.body,
  );
}

// ---------------------------------------------------------------------------

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
  completion_rings: {
    label: 'Progress rings',
    description:
      'One ring per person, split into a coloured segment per course — with overdue activities in red and a tick for where their cohort should be by now.',
    icon: CircleDashed,
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
    case 'completion_rings':
      return <CompletionRings data={data} config={ringOptionsOf(widget.config)} />;
    default:
      return null;
  }
}
