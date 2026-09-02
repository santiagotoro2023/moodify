import { z } from 'zod';

/**
 * Shared API contracts between backend and frontend.
 *
 * Course and user references in widget configs use Moodle's own IDs
 * (moodle_course_id / moodle_user_id) rather than surrogate keys, so a
 * dashboard survives a database wipe followed by a fresh re-sync.
 */

export const WIDGET_TYPES = [
  'completion_table',
  'badge_cards',
  'badge_list',
  'course_overview',
  'leaderboard',
  'user_list',
  'progress_chart',
  'completion_rings',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

const courseId = z.number().int().positive();
const userId = z.number().int().positive();

/** Scope shared by widgets that read "all courses" or one specific course. */
const courseScope = {
  scope: z.enum(['all', 'course']).default('all'),
  courseId: courseId.nullable().default(null),
};
/**
 * A freshly dropped widget has nothing selected yet, so course/user references are
 * always nullable and no schema demands one. The data resolver reports what is still
 * missing ("No course selected for this widget.") — a widget you cannot add until it
 * is already configured is a widget you cannot add.
 */

/** Students to leave out of a widget, e.g. a test account holding every badge. */
const excludeUserIds = z.array(userId).max(500).default([]);

/**
 * Row height. Every widget carries it so a dashboard meant for a wall display can be
 * tightened without shrinking the one on someone's laptop.
 */
export const DENSITIES = ['compact', 'normal', 'roomy'] as const;
export type Density = (typeof DENSITIES)[number];
const density = z.enum(DENSITIES).default('normal');

const sortDir = z.enum(['asc', 'desc']).default('asc');

/**
 * Badge icon size, on the widgets that render badges. Deliberately independent of
 * row size: a wall display often wants tight rows with big, readable icons.
 */
export const BADGE_SIZES = ['small', 'medium', 'large'] as const;
export type BadgeSize = (typeof BADGE_SIZES)[number];
const badgeSize = z.enum(BADGE_SIZES).default('small');

export const completionTableConfig = z.object({
  ...courseScope,
  sortBy: z.enum(['name', 'course', 'percent']).default('name'),
  sortDir,
  includeStaff: z.boolean().default(false),
  excludeUserIds,
  density,
});

export const badgeCardsConfig = z.object({
  /** 'user' renders a single card; 'course' renders one card per enrolled student. */
  scope: z.enum(['user', 'course']).default('course'),
  userId: userId.nullable().default(null),
  courseId: courseId.nullable().default(null),
  sortBy: z.enum(['badges', 'percent', 'name']).default('badges'),
  // Badge counts and percentages read best highest-first; names read best A-Z.
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  includeStaff: z.boolean().default(false),
  excludeUserIds,
  density,
  badgeSize,
});

/** Same scoping as badge_cards; the widget just omits the completion bar. */
export const badgeListConfig = badgeCardsConfig;

export const courseOverviewConfig = z.object({
  courseId: courseId.nullable().default(null),
  includeStaff: z.boolean().default(false),
  excludeUserIds,
  density,
});

export const leaderboardConfig = z.object({
  ...courseScope,
  limit: z.number().int().min(1).max(100).default(10),
  /** 'desc' is the leaderboard proper; 'asc' surfaces whoever needs a nudge. */
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  includeStaff: z.boolean().default(false),
  excludeUserIds,
  density,
});

export const userListConfig = z.object({
  userId: userId.nullable().default(null),
  ...courseScope,
  /** Orders the course-completion list under the badges. */
  sortBy: z.enum(['course', 'percent']).default('course'),
  sortDir,
  density,
  badgeSize,
});

/**
 * "X over time". The only widget that reads history rather than the live snapshot
 * (§1 non-goals said live-only; this was added later on request).
 *
 * The window scales outward on its own — a fresh install plots the hour it has, and
 * grows to the full week of retained samples. Older samples are pruned, so the chart
 * rolls rather than emptying itself every Monday.
 *
 * 'all' is the exception: instead of Moodify's own samples it reconstructs the series
 * from Moodle's badge-issue and activity-completion timestamps, so it reaches back to
 * before Moodify was installed.
 */
export const CHART_WINDOWS = ['auto', '6h', '24h', '7d', 'all'] as const;
export type ChartWindow = (typeof CHART_WINDOWS)[number];

/** How each line says whose it is, at its newest point. */
export const CHART_MARKERS = ['name', 'avatar', 'both', 'none'] as const;
export type ChartMarker = (typeof CHART_MARKERS)[number];

export const progressChartConfig = z.object({
  metric: z.enum(['badges', 'percent']).default('badges'),
  ...courseScope,
  /** Empty = everyone in scope, trimmed to `limit` by the metric's current value. */
  userIds: z.array(userId).max(50).default([]),
  window: z.enum(CHART_WINDOWS).default('auto'),
  /**
   * Draw the whole chosen span even where there is no data yet, so the lines advance
   * across a fixed axis instead of the axis shrinking to fit them. Ignored when the
   * window is 'auto', which is the growing behaviour by definition.
   */
  fullWindow: z.boolean().default(false),
  limit: z.number().int().min(1).max(20).default(8),
  marker: z.enum(CHART_MARKERS).default('name'),
  /** Only meaningful when `marker` draws an avatar. Same three steps as badge icons. */
  avatarSize: z.enum(BADGE_SIZES).default('medium'),
  showLegend: z.boolean().default(true),
  /** Fills under each line. Reads well with one or two students, muddy with eight. */
  showArea: z.boolean().default(false),
  includeStaff: z.boolean().default(false),
  excludeUserIds,
  // No `density`: a chart has no rows to make shorter, and avatarSize already covers
  // "make it readable from across the room".
});

/**
 * The colours a segment may be painted when the widget is set to manual colours.
 *
 * A fixed, curated set rather than a free colour picker: every value here is legible as a
 * thin arc on the dark surface, and none of them reads as the red that means overdue —
 * a picker would let one be chosen and quietly break the only colour that is a judgement
 * rather than a label. The first is the same light blue the progress bars use.
 */
export const RING_COLORS = [
  '#38bdf8', '#2563eb', '#6366f1', '#a855f7', '#d946ef', '#2dd4bf',
  '#10b981', '#84cc16', '#eab308', '#f97316', '#94a3b8',
] as const;
export type RingColor = (typeof RING_COLORS)[number];

export const RING_COLOR_LABELS: Record<RingColor, string> = {
  '#38bdf8': 'Sky',
  '#2563eb': 'Blue',
  '#6366f1': 'Indigo',
  '#a855f7': 'Violet',
  '#d946ef': 'Fuchsia',
  '#2dd4bf': 'Teal',
  '#10b981': 'Emerald',
  '#84cc16': 'Lime',
  '#eab308': 'Yellow',
  '#f97316': 'Orange',
  '#94a3b8': 'Slate',
};

/**
 * What joins a parent section to a subsection in a stored section label.
 *
 * Moodle 4.5 returns a subsection as its own top-level section, so the parent is only
 * recoverable at sync time; the label is composed once there and every later reader —
 * the Tasks picker, the ring split matching — treats it as a path.
 */
export const SECTION_SEPARATOR = ' › ';

/** Whether `section` is `chosen` itself or nested somewhere under it. */
export function sectionMatches(section: string, chosen: string): boolean {
  return section === chosen || section.startsWith(chosen + SECTION_SEPARATOR);
}

/**
 * One section of a course, drawn as its own segment instead of the course as a whole.
 *
 * Sections not listed here simply do not appear: splitting a course is a statement about
 * what is worth watching, and carrying the rest along as a leftover segment would make
 * the ring less readable, which is the opposite of the point.
 */
export const ringSectionSplit = z.object({
  /**
   * A section path: either a full label as stored on course_activities, or a parent
   * section's name. A parent matches everything nested under it, which is the only way to
   * pick a section that holds nothing but subsections — it owns no activities of its own,
   * so it would otherwise be unselectable.
   */
  section: z.string().min(1).max(255),
  /**
   * @deprecated Superseded by `completionRingsConfig.labels`, which names whole courses
   * and sections through one mechanism. Still read so labels saved before that existed
   * are not silently dropped; nothing writes it any more.
   */
  label: z.string().max(40).default(''),
});
export type RingSectionSplit = z.infer<typeof ringSectionSplit>;

/** Diameter of one person's ring. */
export const RING_SIZES = ['small', 'medium', 'large'] as const;
export type RingSize = (typeof RING_SIZES)[number];

/**
 * How a ring says whose it is. With 'name' the middle of the ring is free for the
 * per-course percentages; the avatar modes take that space, so the percentages move to a
 * list under the name.
 */
export const RING_MARKERS = ['name', 'avatar', 'both'] as const;
export type RingMarker = (typeof RING_MARKERS)[number];

/**
 * One ring per person, split into one segment per selected course. Each segment is
 * filled to that course's completion in that course's own colour, so a person who has
 * finished everything shows a full, fully coloured ring.
 *
 * Unlike every other widget this one is deadline-aware: a segment holding an overdue
 * activity turns red, and a tick marks where the person's cohort should be by today.
 */
export const completionRingsConfig = z.object({
  /**
   * Segments, in this order. Empty means every visible course, matching the `scope: all`
   * default the other widgets use — combined with the per-person enrolment filter that
   * is already the useful default, so a freshly dropped widget shows something real.
   */
  courseIds: z.array(courseId).max(12).default([]),
  /** Whose rings are drawn. Empty = every student enrolled in the selected courses. */
  cohortIds: z.array(z.number().int().positive()).max(20).default([]),
  /**
   * Course id (as a string key) -> the sections of that course to draw as their own
   * segments. A course with no entry, or an empty one, stays a single whole-course
   * segment. Section completion is counted from the activities in that section, so a
   * course split into two sections gives two independently tracked bars.
   */
  splits: z.record(z.string(), z.array(ringSectionSplit).max(12)).default({}),
  /**
   * Course id (as a string key) -> the cohort whose members are currently working on it.
   * That is what tells the schedule bar where somebody stands in the course order when
   * their own deadlines cannot: a third-year has no deadline in the first-year course,
   * because those name the first-year cohort, but being in the third-year cohort says
   * the first two years were meant to be behind them. Courses left unmapped fall back to
   * their deadlines alone.
   */
  cohortByCourse: z.record(z.string(), z.number().int().positive()).default({}),
  /**
   * 'auto' spaces the hues evenly over however many segments are on screen; 'manual'
   * takes each segment's colour from `colors`, falling back to the auto hue for any
   * segment left unset, so nothing is ever drawn colourless.
   */
  colorMode: z.enum(['auto', 'manual']).default('auto'),
  /**
   * Segment key (`courseId`, or `courseId:section`) -> colour. Only read in 'manual'.
   *
   * Any 6-digit hex, not just RING_COLORS: the curated set is what the picker offers,
   * not what the widget accepts. Red included — an overdue segment still overrides it,
   * so the worst a red segment costs is that "overdue" stops standing out on that one.
   */
  colors: z.record(z.string(), z.string().regex(/^#[0-9a-fA-F]{6}$/)).default({}),
  /**
   * Segment key -> legend text, for whole courses and sections alike. Unset falls back to
   * the course's shortname or the section's name in Moodle.
   *
   * Only the label changes: the tooltip keeps naming the real course and section, so a
   * segment renamed to something short is still traceable back to what it actually is.
   */
  labels: z.record(z.string(), z.string().max(40)).default({}),
  sortBy: z.enum(['name', 'percent', 'overdue', 'courses']).default('name'),
  sortDir,
  ringSize: z.enum(RING_SIZES).default('medium'),
  marker: z.enum(RING_MARKERS).default('name'),
  /** Draw the "where you should be by now" bar along each segment's outer half. */
  showTarget: z.boolean().default(true),
  /** Colour of that bar. */
  targetColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ffc2e0'),
  /** List every badge the person holds under their ring. */
  showBadges: z.boolean().default(false),
  /**
   * Badge ids, in the order they should be laid out. Badges not listed follow, A-Z, so
   * a badge created in Moodle after the order was set appears rather than vanishing.
   */
  badgeOrder: z.array(z.number().int().positive()).max(200).default([]),
  /**
   * Named groups of badges, laid out top to bottom in this array's order, with anything
   * unassigned following underneath. A badge named by two sections belongs to the first
   * that claims it; order inside a section is `badgeOrder`, so one sequence still drives
   * the whole layout.
   */
  badgeSections: z
    .array(
      z.object({
        name: z.string().trim().max(60),
        badgeIds: z.array(z.number().int().positive()).max(200),
      }),
    )
    .max(20)
    .default([]),
  badgeSize,
  includeStaff: z.boolean().default(false),
  excludeUserIds,
});

export const WIDGET_CONFIG_SCHEMAS = {
  completion_table: completionTableConfig,
  badge_cards: badgeCardsConfig,
  badge_list: badgeListConfig,
  course_overview: courseOverviewConfig,
  leaderboard: leaderboardConfig,
  user_list: userListConfig,
  progress_chart: progressChartConfig,
  completion_rings: completionRingsConfig,
} satisfies Record<WidgetType, z.ZodTypeAny>;

export type WidgetConfig = {
  completion_table: z.infer<typeof completionTableConfig>;
  badge_cards: z.infer<typeof badgeCardsConfig>;
  badge_list: z.infer<typeof badgeListConfig>;
  course_overview: z.infer<typeof courseOverviewConfig>;
  leaderboard: z.infer<typeof leaderboardConfig>;
  user_list: z.infer<typeof userListConfig>;
  progress_chart: z.infer<typeof progressChartConfig>;
  completion_rings: z.infer<typeof completionRingsConfig>;
};

/** Parses an untrusted config blob against the schema for `type`. Throws ZodError. */
export function parseWidgetConfig<T extends WidgetType>(
  type: T,
  config: unknown,
): WidgetConfig[T] {
  return WIDGET_CONFIG_SCHEMAS[type].parse(config) as WidgetConfig[T];
}

/** Defaults used when a widget is first dropped on the grid. */
export const WIDGET_DEFAULTS: {
  [T in WidgetType]: { config: unknown; w: number; h: number; title: string };
} = {
  completion_table: { config: { scope: 'all' }, w: 6, h: 6, title: 'Completion' },
  badge_cards: { config: { scope: 'course' }, w: 4, h: 4, title: 'Badges & progress' },
  badge_list: { config: { scope: 'course' }, w: 4, h: 4, title: 'Badges' },
  course_overview: { config: {}, w: 3, h: 3, title: 'Course overview' },
  leaderboard: { config: { scope: 'all', limit: 10 }, w: 3, h: 5, title: 'Leaderboard' },
  user_list: { config: { scope: 'all' }, w: 4, h: 5, title: 'User' },
  // Wider than tall: a line chart needs horizontal room before it needs vertical.
  progress_chart: { config: { scope: 'all', metric: 'badges' }, w: 6, h: 5, title: 'Over time' },
  // Built to be the whole screen: a wall of rings only reads as "who is where" when
  // everyone is on it at once.
  completion_rings: { config: {}, w: 12, h: 8, title: 'Progress rings' },
};

// ---------------------------------------------------------------------------
// Entities returned by the API
// ---------------------------------------------------------------------------

export interface Course {
  id: number;
  shortname: string;
  fullname: string;
  visible: boolean;
}

export interface MoodleUser {
  id: number;
  fullname: string;
  email: string | null;
  /**
   * Moodify's own proxy for the Moodle profile picture, or null when there is none
   * cached. Always null on an anonymized public view — a face is a name.
   */
  avatarUrl?: string | null;
}

/** A Moodle site-wide cohort, e.g. "1. Lehrjahr". Deadlines are set per cohort. */
export interface Cohort {
  id: number;
  name: string;
  idnumber: string | null;
  memberCount: number;
}

/**
 * One section of a course, for the ring's split picker.
 *
 * Every section, including those with nothing trackable in them — unlike CourseActivity,
 * which by construction only knows about sections that own a tracked activity.
 */
export interface CourseSection {
  /** Already "Parent SECTION_SEPARATOR Subsection" where Moodle nests them. */
  name: string;
  /** Moodle's own ordering within the course. */
  order: number;
}

/** One completion-trackable activity in a course, for the task picker. */
export interface CourseActivity {
  courseId: number;
  cmid: number;
  name: string;
  modname: string;
  /** Course section, already "Parent SECTION_SEPARATOR Subsection" where Moodle nests them. */
  section: string;
  /** Moodle's own ordering of that section within the course. */
  sectionOrder: number;
}

export interface Badge {
  id: number;
  name: string;
  description: string | null;
  /** Written in Moodify, on the Badges page. Shown in the badge pop-up. */
  customDescription: string | null;
  courseId: number | null;
  imageUrl: string | null;
}

/** A badge as listed on the Badges page, with the context needed to tell two apart. */
export interface BadgeAdmin extends Badge {
  courseName: string | null;
  /** How many students hold it. Moodify only knows badges that were actually awarded. */
  holders: number;
}

/** `percent` is null when a course has no completion-tracked activities (§9.2). */
export interface CompletionCell {
  courseId: number;
  userId: number;
  activitiesTotal: number;
  activitiesCompleted: number;
  percent: number | null;
}

export interface GridPosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Widget extends GridPosition {
  id: number;
  dashboardId: number;
  type: WidgetType;
  /** null means "fall back to the auto-generated title". */
  title: string | null;
  config: unknown;
  isCollapsed: boolean;
}

export interface Dashboard {
  id: number;
  name: string;
  /**
   * The two headings shown either side of the centred logo above the grid. The
   * dashboard's own `name` stays internal — it labels the tab in the admin UI.
   */
  titleLeft: string | null;
  titleRight: string | null;
  /** Gap in px between each title and the logo. Null = DEFAULT_TITLE_GAP. */
  titleGap: number | null;
  /** Logo height in px above this dashboard only. Null = the site-wide logo height. */
  logoHeight: number | null;
  /** Heading text size in px. Null = derived from the logo height (see titleSizeFor). */
  titleSize: number | null;
  backgroundImagePath: string | null;
  isPublic: boolean;
  publicShareToken: string | null;
  anonymizeOnPublic: boolean;
  widgets: Widget[];
}

export type SyncStatus = 'never' | 'ok' | 'error' | 'running';

export interface ConnectionState {
  configured: boolean;
  baseUrl: string | null;
  /** Masked for display only — the token itself never leaves the backend (§9.5). */
  tokenHint: string | null;
  serviceShortname: string | null;
  pollIntervalSeconds: number;
  lastSyncAt: string | null;
  lastSyncStatus: SyncStatus;
  lastSyncError: string | null;
}

/** Live counters shown during the wizard's first discovery run (§8 step 4). */
export interface SyncProgress {
  status: SyncStatus;
  phase: string | null;
  courses: number;
  users: number;
  badges: number;
  error: string | null;
}

export interface BootstrapState {
  /** False until the first admin account exists — the app renders the wizard instead of a login. */
  hasAdmin: boolean;
  connection: ConnectionState | null;
  logoUrl: string;
  /** Rendered height of the header logo in pixels. */
  logoHeight: number;
  /**
   * External origin Moodify is reached on, e.g. https://moodify.example.ch.
   * Public share links are built from this; empty means "use the browser's origin".
   */
  publicBaseUrl: string;
}

export const DEFAULT_LOGO_HEIGHT = 32;

/**
 * Space between the logo and each heading beside it, in px.
 *
 * Small on purpose: the three read as one heading, not as three things that happen to
 * share a row. The outer grid tracks are what centre the logo, so this is the only gap
 * that is actually visible.
 */
export interface BadgeSection {
  name: string;
  badgeIds: number[];
}

/**
 * A person's badges split into the sections configured on the widget, in the configured
 * order, with whatever no section claims trailing under a blank heading.
 *
 * Membership is exclusive — the first section to name a badge keeps it — so a badge
 * listed twice cannot be drawn twice. Every configured section comes back, empty ones
 * included: whether to draw a section this person holds nothing in is the caller's
 * decision, not this function's, because dropping it per person is exactly what knocks
 * a wall of tiles out of alignment. The rings widget keeps a section that anybody in
 * the widget has a badge in and pads the rest of the tiles out to match.
 */
export function badgeSectionsOf(
  badges: Badge[],
  sections: readonly BadgeSection[],
): { name: string; badges: Badge[] }[] {
  if (sections.length === 0) return [{ name: '', badges }];
  const claimed = new Set<number>();
  const groups = sections.map((section) => ({
    name: section.name,
    badges: badges.filter((badge) => {
      if (claimed.has(badge.id) || !section.badgeIds.includes(badge.id)) return false;
      claimed.add(badge.id);
      return true;
    }),
  }));
  groups.push({ name: '', badges: badges.filter((badge) => !claimed.has(badge.id)) });
  return groups;
}

export const DEFAULT_TITLE_GAP = 16;

/**
 * Heading size when the dashboard sets none: 60% of the logo's height.
 *
 * Cap-height rather than font-size is what the eye compares, and a heading set to the
 * logo's full pixel height reads considerably taller than the mark beside it.
 */
export function titleSizeFor(logoHeight: number): number {
  return Math.round(logoHeight * 0.6);
}

// ---------------------------------------------------------------------------
// Widget data payloads — what GET /api/widgets/:id/data returns per type.
// The public route returns the same shapes with names already anonymized.
// ---------------------------------------------------------------------------

export interface CompletionEntry {
  courseId: number;
  activitiesTotal: number;
  activitiesCompleted: number;
  /** null = course has no completion-tracked activities. Render as "not tracked". */
  percent: number | null;
  /**
   * Activities in this course whose deadline for one of the user's cohorts has passed
   * and which are still not completed. 0 when nothing is overdue, which is also what a
   * course with no deadlines configured always reports.
   */
  overdue: number;
}

export interface CompletionTableData {
  type: 'completion_table';
  courses: Course[];
  rows: { user: MoodleUser; cells: CompletionEntry[] }[];
}

export interface BadgeCardsData {
  type: 'badge_cards';
  /**
   * Ordered by badge count descending, so index 0/1/2 are the gold/silver/bronze
   * places the UI decorates. `percent` is completion for the scoped course, or the
   * mean across the user's enrolled courses when the widget covers all courses;
   * null keeps its "not tracked" meaning. `overdue` counts activities past a deadline
   * for one of the user's cohorts, which turns the completion bar red.
   */
  users: { user: MoodleUser; badges: Badge[]; percent: number | null; overdue: number }[];
}

/** Same rows as badge_cards, rendered without the completion bar. */
export interface BadgeListData extends Omit<BadgeCardsData, 'type'> {
  type: 'badge_list';
}

export interface CourseOverviewData {
  type: 'course_overview';
  course: Course;
  enrolledCount: number;
  /** null when no enrolled student has tracked completion data. */
  averagePercent: number | null;
  trackedActivityCount: number;
}

export interface LeaderboardData {
  type: 'leaderboard';
  entries: { user: MoodleUser; badgeCount: number }[];
}

export interface UserListData {
  type: 'user_list';
  user: MoodleUser;
  badges: Badge[];
  completion: { course: Course; entry: CompletionEntry }[];
}

/**
 * One student's line. `points` is ordered oldest-first and may be shorter than another
 * series' — a student who enrolled yesterday has no samples from last week.
 */
export interface ProgressSeries {
  user: MoodleUser;
  points: { t: string; v: number }[];
}

export interface ProgressChartData {
  type: 'progress_chart';
  metric: 'badges' | 'percent';
  /** ISO bounds of the window actually plotted, so the axis is the same for every line. */
  from: string;
  to: string;
  /**
   * True when the points are events (a badge issued, an activity completed) rather than
   * readings taken on a clock. The value holds flat until the next event, so the line is
   * drawn as steps — sloping between two badges would imply half a badge in between.
   */
  step: boolean;
  /** Ordered by newest value descending — whoever is winning is first in the legend. */
  series: ProgressSeries[];
}

/**
 * What one slice of the ring stands for: a whole course, or one section of one.
 *
 * Identified by an opaque key rather than a course id because a split course produces
 * several slices from the same course. The key is what colours are stored against, so a
 * segment keeps its colour when its neighbours change.
 */
export interface RingLegendItem {
  /** `courseId` for a whole course, `courseId:section` for a section. */
  key: string;
  /** Short text, for the legend and the per-segment rows. */
  label: string;
  /** Full text, for tooltips. */
  title: string;
}

/** One segment of a person's ring. */
export interface RingSegment extends RingLegendItem {
  /** null = nothing here tracks completion; the segment is drawn as an empty track. */
  percent: number | null;
  /**
   * How far the schedule bar reaches: where the fill would be with nothing overdue —
   * completed work plus the work whose date has passed — read across the segments as one
   * plan, so a segment before the last one with a passed deadline reads 100. Null where
   * there is no bar: nothing due yet in this segment or any after it, or no activities.
   */
  targetPercent: number | null;
  overdue: number;
  /** Names of the overdue activities, newest-first is not meaningful so A-Z. */
  overdueActivities: string[];
}

export interface CompletionRingsEntry {
  user: MoodleUser;
  /**
   * Only the segments this person can actually reach, in the widget's configured order.
   * Someone in one course out of four gets a single full ring rather than three empty
   * segments for courses they cannot even open.
   */
  segments: RingSegment[];
  /** Total overdue across the segments, for sorting and the tile's status line. */
  overdue: number;
  /** Tasks finished before their date came round — the only honest reading of "ahead". */
  earlyDone: number;
  /** Mean of the tracked segments. Used for sorting, not shown as a headline. */
  percent: number | null;
  /** Empty unless the widget has `showBadges` on. */
  badges: Badge[];
}

export interface CompletionRingsData {
  type: 'completion_rings';
  /**
   * Every segment the widget can draw, in configured order — the legend, and the source
   * of each segment's colour. An entry's segments are a subset of these.
   */
  legend: RingLegendItem[];
  entries: CompletionRingsEntry[];
}

export type WidgetData =
  | CompletionTableData
  | BadgeCardsData
  | BadgeListData
  | CourseOverviewData
  | LeaderboardData
  | UserListData
  | ProgressChartData
  | CompletionRingsData;

/** Widget data resolution failed (e.g. its course was deleted in Moodle). */
export interface WidgetDataError {
  type: 'error';
  message: string;
}

// ---------------------------------------------------------------------------
// Email notifications
// ---------------------------------------------------------------------------

/**
 * Placeholders a rule's subject and body may use. Anything else is left as typed.
 *
 * `{is}` exists because one placeholder cannot agree with its own verb: `{activity}` is
 * "ISO/OSI" for one activity and "7 activities" for seven, and "7 activities is due"
 * reads as a bug in the software. Written as "{activity} {is} due", both are right.
 */
export const TEMPLATE_FIELDS = ['name', 'activity', 'course', 'due', 'days', 'count', 'is'] as const;

export interface SmtpState {
  enabled: boolean;
  /** 'smtp' = a mail server. 'graph' = Microsoft 365, sending as the connected mailbox. */
  transport: 'smtp' | 'graph';
  graphTenantId: string;
  graphClientId: string;
  /** The connected mailbox, or null when nobody has signed in yet. */
  graphAccount: string | null;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  /** Masked for display only — the password itself never leaves the backend (§9.5). */
  passwordSet: boolean;
  fromName: string;
  fromEmail: string;
  adminEmail: string;
  dailyReport: boolean;
  dailyReportHour: number;
  /** Hour of day the reminders go out, so everything arrives in one batch. */
  sendHour: number;
  mailFont: string;
  mailFontSize: number;
  mailTextColor: string;
  mailAccentColor: string;
  /** Send everything owed the moment mailing is switched on, rather than at sendHour. */
  jumpStart: boolean;
  jumpStartDays: number;
  lastSentAt: string | null;
  lastError: string | null;
  /** Students Moodle gave no address for; they are skipped rather than guessed at. */
  usersWithoutEmail: string[];
}

/**
 * Fonts a reminder can be set in. Every stack ends in a generic family, because the only
 * safe assumption about a mail client is that it has one of the five.
 */
export const MAIL_FONTS = [
  { id: 'system', label: 'System', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif' },
  { id: 'sans', label: 'Sans (Helvetica)', stack: 'Helvetica, Arial, sans-serif' },
  { id: 'serif', label: 'Serif (Georgia)', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', label: 'Monospace', stack: '"SF Mono", Consolas, "Courier New", monospace' },
  // Only renders as itself where the reader has it installed — mail clients do not fetch
  // web fonts, Apple Mail aside. The fallback is what most inboxes will actually show.
  { id: 'grotesk', label: 'Space Grotesk', stack: '"Space Grotesk", "Segoe UI", Helvetica, sans-serif' },
] as const;

export type MailFont = (typeof MAIL_FONTS)[number]['id'];

export function mailFontStack(id: string): string {
  return (MAIL_FONTS.find((font) => font.id === id) ?? MAIL_FONTS[0]).stack;
}

/** Somebody a task's reminder could reach, for the manual send dialog on the Tasks page. */
export interface TaskRecipient {
  userId: number;
  fullname: string;
  email: string | null;
  completed: boolean;
}

export interface NotificationRuleDto {
  id: number;
  kind: 'before' | 'overdue';
  /** Days ahead of the due date, for `kind: 'before'`. Null for `overdue`. */
  daysBefore: number | null;
  subject: string;
  body: string;
  enabled: boolean;
}

/** Web Service functions the Moodle-side External Service must expose (§9.1). */
export const REQUIRED_WS_FUNCTIONS = [
  'core_webservice_get_site_info',
  'core_course_get_courses',
  'core_enrol_get_enrolled_users',
  'core_completion_get_activities_completion_status',
  'core_badges_get_user_badges',
] as const;

/**
 * Extra functions the deadline tracking needs. Deliberately NOT in the required list:
 * an existing install whose External Service predates this feature must keep working,
 * and the connection test must not start failing because of a feature nobody uses.
 * Without them there are simply no cohorts and no activity names to attach a deadline
 * to, and Settings says so.
 */
export const DEADLINE_WS_FUNCTIONS = [
  'core_cohort_get_cohorts',
  'core_cohort_get_cohort_members',
  'core_course_get_contents',
] as const;

// ---------------------------------------------------------------------------
// Deadlines
//
// A deadline is a yearly recurrence rule, not a date: "the first Monday in September,
// every year". The occurrence is computed on read so it rolls into the next year on
// its own, against whoever is in the cohort at that point.
// ---------------------------------------------------------------------------

/** Sunday = 0, matching Date#getDay. */
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** The yearly half of a rule: "the nth weekday of a month". */
export interface YearlyRule {
  /** 1-12. */
  month: number;
  /** 0-6, Sunday = 0. */
  weekday: number;
  /** 1-5, or -1 for "the last one in the month". */
  nth: number;
}

/**
 * When a task is due. Exactly one of the two forms is filled in:
 *  - `date` set → a one-off calendar date, "done by 15 March 2027".
 *  - the yearly fields set → "the first Monday in September, every year".
 */
export interface DeadlineRule {
  /** yyyy-mm-dd, or null when this is a yearly rule. */
  date?: string | null;
  month?: number | null;
  weekday?: number | null;
  nth?: number | null;
}

function isYearly(rule: DeadlineRule): rule is DeadlineRule & YearlyRule {
  return (
    typeof rule.month === 'number' &&
    typeof rule.weekday === 'number' &&
    typeof rule.nth === 'number'
  );
}

export interface Deadline extends DeadlineRule {
  id: number;
  courseId: number;
  courseName: string;
  cmid: number;
  /** From course_activities; falls back to "Activity <cmid>" if the sync has not seen it. */
  activityName: string;
  /** Course section the activity is in — the Tasks page groups by it. */
  section: string;
  sectionOrder: number;
  /** null = the task applies to every student in the course, not one cohort. */
  cohortId: number | null;
  cohortName: string | null;
  /** The occurrence currently in force (ISO), or null while it is still upcoming. */
  dueAt: string | null;
  /** The next occurrence (ISO), or null for a one-off date that has already passed. */
  nextDueAt: string | null;
}

/**
 * dd/mm/yyyy, everywhere a date is shown.
 *
 * Not toLocaleDateString: that follows the browser's locale, so the same dashboard on a
 * machine set to en-US reads 09/07/2026 as 7 September and the reader has no way to tell.
 * A deadline is not a place to be ambiguous about which number is the month.
 */
export function formatDay(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  const day = `${date.getDate()}`.padStart(2, '0');
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

/** End of a yyyy-mm-dd day in local time — "by the 15th" includes all of the 15th. */
function endOfDay(date: string): Date | null {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  // Not new Date('2026-09-07'): that is parsed as UTC midnight, which lands on the 6th
  // for anyone west of Greenwich.
  return new Date(year, month - 1, day, 23, 59, 59, 999);
}

/**
 * The nth `weekday` of `month` in `year`, at the end of that day — "by the first Monday
 * in September" includes all of that Monday.
 *
 * An nth that does not exist (a fifth Monday in a month with four) clamps to the last
 * one, which is the only reading that does not silently skip a year.
 */
export function nthWeekdayOf(year: number, rule: YearlyRule): Date {
  const first = new Date(year, rule.month - 1, 1);
  const offset = (rule.weekday - first.getDay() + 7) % 7;
  const lastOfMonth = new Date(year, rule.month, 0).getDate();

  let day: number;
  if (rule.nth < 0) {
    day = 1 + offset + Math.floor((lastOfMonth - 1 - offset) / 7) * 7;
  } else {
    day = 1 + offset + (rule.nth - 1) * 7;
    while (day > lastOfMonth) day -= 7;
  }
  return new Date(year, rule.month - 1, day, 23, 59, 59, 999);
}

/**
 * The moment a task is currently being measured against, or null when it has none yet.
 * Everything before this instant is due; everything after it is not.
 *
 * A one-off date needs no anchor — it says exactly what it means. A yearly rule does:
 * mathematically it has always already occurred, so without one a rule entered in June
 * would report the whole cohort overdue since last September the moment it was saved.
 * `createdAt` makes it take effect at its first occurrence after it was written down.
 */
export function deadlineDueAt(rule: DeadlineRule, createdAt: Date, now: Date): Date | null {
  if (rule.date != null) {
    const at = endOfDay(rule.date);
    return at !== null && at <= now ? at : null;
  }
  if (!isYearly(rule)) return null;
  const thisYear = nthWeekdayOf(now.getFullYear(), rule);
  const inForce = thisYear <= now ? thisYear : nthWeekdayOf(now.getFullYear() - 1, rule);
  return inForce > createdAt ? inForce : null;
}

/** The next occurrence, or null for a one-off date that is already behind us. */
export function deadlineNextDueAt(rule: DeadlineRule, now: Date): Date | null {
  if (rule.date != null) {
    const at = endOfDay(rule.date);
    return at !== null && at > now ? at : null;
  }
  if (!isYearly(rule)) return null;
  const thisYear = nthWeekdayOf(now.getFullYear(), rule);
  return thisYear > now ? thisYear : nthWeekdayOf(now.getFullYear() + 1, rule);
}

export function describeDeadlineRule(rule: DeadlineRule): string {
  if (rule.date != null) {
    const at = endOfDay(rule.date);
    return at === null ? rule.date : formatDay(at);
  }
  if (!isYearly(rule)) return 'no date set';
  const which = rule.nth < 0 ? 'last' : ['first', 'second', 'third', 'fourth', 'fifth'][rule.nth - 1];
  return `${which ?? rule.nth} ${WEEKDAY_NAMES[rule.weekday] ?? '?'} in ${MONTH_NAMES[rule.month - 1] ?? '?'}, yearly`;
}
