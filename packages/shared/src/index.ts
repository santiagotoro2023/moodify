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
const courseScopeIsCoherent = (v: { scope: string; courseId: number | null }) =>
  v.scope !== 'course' || v.courseId !== null;
const courseScopeError = {
  message: 'courseId is required when scope is "course"',
  path: ['courseId'],
};

export const completionTableConfig = z
  .object({
    ...courseScope,
    sortBy: z.enum(['name', 'course', 'percent']).default('name'),
    sortDir: z.enum(['asc', 'desc']).default('asc'),
    includeStaff: z.boolean().default(false),
  })
  .refine(courseScopeIsCoherent, courseScopeError);

export const badgeCardsConfig = z
  .object({
    /** 'user' renders one card per badge for a single user; 'course' renders a card per enrolled student. */
    scope: z.enum(['user', 'course']).default('course'),
    userId: userId.nullable().default(null),
    courseId: courseId.nullable().default(null),
    includeStaff: z.boolean().default(false),
  })
  .refine((v) => (v.scope === 'user' ? v.userId !== null : v.courseId !== null), {
    message: 'Pick a user when scope is "user", or a course when scope is "course"',
    path: ['scope'],
  });

export const courseOverviewConfig = z.object({
  courseId,
  includeStaff: z.boolean().default(false),
});

export const leaderboardConfig = z
  .object({
    ...courseScope,
    limit: z.number().int().min(1).max(100).default(10),
    includeStaff: z.boolean().default(false),
  })
  .refine(courseScopeIsCoherent, courseScopeError);

export const userListConfig = z
  .object({
    userId,
    ...courseScope,
  })
  .refine(courseScopeIsCoherent, courseScopeError);

export const WIDGET_CONFIG_SCHEMAS = {
  completion_table: completionTableConfig,
  badge_cards: badgeCardsConfig,
  course_overview: courseOverviewConfig,
  leaderboard: leaderboardConfig,
  user_list: userListConfig,
} satisfies Record<WidgetType, z.ZodTypeAny>;

export type WidgetConfig = {
  completion_table: z.infer<typeof completionTableConfig>;
  badge_cards: z.infer<typeof badgeCardsConfig>;
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
  badge_cards: { config: { scope: 'course' }, w: 4, h: 5, title: 'Badges' },
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
}

export interface CompletionTableData {
  type: 'completion_table';
  courses: Course[];
  rows: { user: MoodleUser; cells: CompletionEntry[] }[];
}

export interface BadgeCardsData {
  type: 'badge_cards';
  users: { user: MoodleUser; badges: Badge[] }[];
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
