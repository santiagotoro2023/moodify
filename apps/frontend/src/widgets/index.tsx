import { useCallback, useEffect, useState } from 'react';
import type {
  BadgeCardsData,
  BadgeListData,
  Badge as BadgeType,
  CompletionEntry,
  CompletionTableData,
  CourseOverviewData,
  LeaderboardData,
  UserListData,
  Widget,
  WidgetData,
  WidgetDataError,
} from '@moodify/shared';
import { Award, BookOpen, Medal, Table2, Trophy, User } from 'lucide-react';
import { api, assetUrl, cn, errorMessage } from '@/lib/api';
import { Button, EmptyState, ErrorNote, Spinner } from '@/ui';

type Payload = WidgetData | WidgetDataError;

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

function BadgeImage({ badge }: { badge: BadgeType }) {
  const [failed, setFailed] = useState(false);
  const url = assetUrl(badge.imageUrl);

  if (!url || failed) {
    return (
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/8">
        <Award className="h-5 w-5 text-muted" aria-hidden="true" />
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      className="h-9 w-9 shrink-0 object-contain"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Icon + full name as one chip. Names sit beside the icon rather than under it, so
 * they show in full without each badge costing a whole block of height.
 */
function BadgeList({ badges }: { badges: BadgeType[] }) {
  if (badges.length === 0) {
    return <p className="text-xs text-muted">No badges yet</p>;
  }
  return (
    <ul className="flex flex-wrap gap-2">
      {badges.map((badge) => (
        <li
          key={badge.id}
          className="flex items-center gap-2 rounded-full bg-white/6 py-1 pl-1 pr-3"
          title={badge.description ?? badge.name}
        >
          <BadgeImage badge={badge} />
          <span className="text-xs leading-snug">{badge.name}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The five renderers
// ---------------------------------------------------------------------------

function CompletionTable({ data }: { data: CompletionTableData }) {
  if (data.rows.length === 0) {
    return <EmptyState icon={<Table2 className="h-6 w-6" />} title="No enrolled students yet" />;
  }
  return (
    // Scrolls inside the widget so a wide table never makes the page scroll sideways.
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-ground-soft/95 backdrop-blur">
          <tr>
            <th className="p-2 text-left font-medium text-muted">Student</th>
            {data.courses.map((course) => (
              <th
                key={course.id}
                className="min-w-32 p-2 text-left font-medium text-muted"
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
              <td className="p-2 whitespace-nowrap">{row.user.fullname}</td>
              {data.courses.map((course) => {
                const cell = row.cells.find((c) => c.courseId === course.id);
                return (
                  <td key={course.id} className="p-2">
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
}: {
  data: BadgeCardsData | BadgeListData;
  showProgress: boolean;
}) {
  if (data.users.length === 0) {
    return <EmptyState icon={<Award className="h-6 w-6" />} title="Nobody enrolled yet" />;
  }

  // Rows are pre-sorted by badge count, but only award a trophy to someone who
  // actually holds badges — otherwise an empty course hands out three trophies.
  return (
    <div className="space-y-3">
      {data.users.map((entry, index) => {
        const place = entry.badges.length > 0 ? PLACE_STYLES[index] : undefined;
        return (
          <div
            key={entry.user.id}
            className={cn(
              'space-y-3 rounded-xl border bg-white/3 p-4',
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
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
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

            <div className="border-t border-edge/60 pt-3">
              <BadgeList badges={entry.badges} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CourseOverview({ data }: { data: CourseOverviewData }) {
  const untracked = data.averagePercent === null;
  return (
    <div className="flex h-full flex-col justify-center gap-3">
      <div>
        <p className="text-4xl font-semibold tabular-nums">
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

function Leaderboard({ data }: { data: LeaderboardData }) {
  if (data.entries.length === 0) {
    return <EmptyState icon={<Trophy className="h-6 w-6" />} title="No badges awarded yet" />;
  }
  const medal = ['text-amber-300', 'text-slate-300', 'text-amber-600'];
  return (
    <ol className="space-y-1 overflow-auto">
      {data.entries.map((entry, index) => (
        <li
          key={entry.user.id}
          className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm odd:bg-white/3"
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

function UserList({ data }: { data: UserListData }) {
  return (
    <div className="space-y-4 overflow-auto">
      <p className="text-sm font-medium">{data.user.fullname}</p>
      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-muted">Badges</p>
        <BadgeList badges={data.badges} />
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
    }
  }
  const labels: Record<Widget['type'], string> = {
    completion_table: 'Completion',
    badge_cards: 'Badges & progress',
    badge_list: 'Badges',
    course_overview: 'Course overview',
    leaderboard: 'Leaderboard',
    user_list: 'User',
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

  switch (data.type) {
    case 'completion_table':
      return <CompletionTable data={data} />;
    case 'badge_cards':
      return <BadgeCards data={data} showProgress />;
    case 'badge_list':
      return <BadgeCards data={data} showProgress={false} />;
    case 'course_overview':
      return <CourseOverview data={data} />;
    case 'leaderboard':
      return <Leaderboard data={data} />;
    case 'user_list':
      return <UserList data={data} />;
    default:
      return null;
  }
}
