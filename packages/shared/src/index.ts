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

export const WIDGET_CONFIG_SCHEMAS = {
  completion_table: completionTableConfig,
  badge_cards: badgeCardsConfig,
  badge_list: badgeListConfig,
  course_overview: courseOverviewConfig,
  leaderboard: leaderboardConfig,
  user_list: userListConfig,
} satisfies Record<WidgetType, z.ZodTypeAny>;

export type WidgetConfig = {
  completion_table: z.infer<typeof completionTableConfig>;
  badge_cards: z.infer<typeof badgeCardsConfig>;
  badge_list: z.infer<typeof badgeListConfig>;
  course_overview: z.infer<typeof courseOverviewConfig>;
  leaderboard: z.infer<typeof leaderboardConfig>;
  user_list: z.infer<typeof userListConfig>;
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
}

export interface Badge {
  id: number;
  name: string;
  description: string | null;
  courseId: number | null;
  imageUrl: string | null;
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
   * null keeps its "not tracked" meaning.
   */
  users: { user: MoodleUser; badges: Badge[]; percent: number | null }[];
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

export type WidgetData =
  | CompletionTableData
  | BadgeCardsData
  | BadgeListData
  | CourseOverviewData
  | LeaderboardData
  | UserListData;

/** Widget data resolution failed (e.g. its course was deleted in Moodle). */
export interface WidgetDataError {
  type: 'error';
  message: string;
}

/** Web Service functions the Moodle-side External Service must expose (§9.1). */
export const REQUIRED_WS_FUNCTIONS = [
  'core_webservice_get_site_info',
  'core_course_get_courses',
  'core_enrol_get_enrolled_users',
  'core_completion_get_activities_completion_status',
  'core_badges_get_user_badges',
] as const;
