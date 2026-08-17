# Moodify

A self-hosted, CLI-free dashboard for a Moodle instance. It connects over Moodle's Web Service
API, tracks per-user course completion and badges, and renders them on customizable, Homarr-style
widget dashboards — including public share links.

Read-only: Moodify never writes anything back to Moodle.

## Install

On a fresh Debian 12/13 box:

```sh
git clone https://github.com/santiagotoro2023/moodify.git
cd moodify
sudo ./scripts/install.sh
```

That is the only command you ever need to type. The installer detects Debian, installs Docker from
the official Docker apt repository if it is missing, generates `.env` with random secrets, starts
the stack, and prints the URL to open. Everything else — the Moodle connection, dashboards,
widgets, users, branding — is configured in the browser.

Re-running `install.sh` is safe. It never regenerates existing secrets, because rotating
`ENCRYPTION_KEY` would orphan the stored Moodle token.

To remove it: `sudo ./scripts/uninstall.sh` (asks before deleting any data, defaults to keeping it).

### Reverse proxy

Moodify exposes exactly one HTTP port (default 8080) and does not terminate TLS. Point your
existing nginx/Caddy at it:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`X-Forwarded-Proto` matters: the session cookie is only marked `Secure` when Moodify can see that
the request arrived over HTTPS. Without that header you stay on a non-Secure cookie.

## What you need to set up in Moodle first

Moodify cannot configure Moodle remotely. A Moodle administrator has to do this once:

1. **Site administration → Server → Web services → Overview**: enable web services and the REST
   protocol.
2. **External services**: add a service (any shortname, e.g. `moodify`), and tick
   *Can be downloaded* / authorised-user access as appropriate.
3. Add these functions to that service:

   | Function | Used for |
   |---|---|
   | `core_webservice_get_site_info` | connection test |
   | `core_course_get_courses` | course discovery |
   | `core_enrol_get_enrolled_users` | enrolled users per course |
   | `core_completion_get_activities_completion_status` | per-user activity completion |
   | `core_badges_get_user_badges` | badges awarded to a user |

   Optional, and only needed for the *Tasks* page and the *Progress rings* widget. Without
   them everything else works unchanged; there are simply no cohorts and no activity names
   to hang a task on. Only `core_course_get_contents` is strictly required for tasks — the
   two cohort functions just let a task target one year group instead of the whole course.

   | Function | Used for |
   |---|---|
   | `core_course_get_contents` | activity **names** — the completion endpoint only returns cmids |
   | `core_cohort_get_cohorts` | the cohorts a task can target, e.g. "1. Lehrjahr" |
   | `core_cohort_get_cohort_members` | who is in them |

4. Create a token for a Moodle account that can see the courses you care about, **or** authorise
   that account on the service and let Moodify fetch a token for you via `login/token.php` in the
   setup wizard.

The wizard shows this list in-app as well.

## Design decisions

The build spec left a number of choices open. Here is what was picked and why.

### Architecture

| Decision | Choice | Reasoning |
|---|---|---|
| Grid library | `react-grid-layout` | Drag, resize, responsive breakpoints and layout persistence in one library. `dnd-kit` only does drag — resize and grid maths would have been hand-rolled. **`dnd-kit` is not installed; do not mix the two.** |
| Worker | Runs inside the backend process | At <50 users and <20 courses the sync is a few hundred HTTP calls a minute at worst. A separate container would mean a second image, a second health check and shared-state coordination for no benefit. |
| Scheduler | `setTimeout`, re-armed after each run | Not `node-cron`: cron expressions cannot express "every N seconds" where N is an arbitrary number configured in the database. Re-arming after completion also makes it impossible for a slow sync to overlap itself, which `setInterval` would allow. |
| Auth | Signed `httpOnly` cookie holding the admin id | One admin account. A session table would add a migration and a cleanup job to solve a problem that does not exist here. |
| Password hashing | `crypto.scrypt` from the Node standard library | No bcrypt/argon2 native dependency to compile in the image. |
| Database access | `pg` with raw SQL | Twelve tables and a fixed query set. An ORM would add a codegen step and a migration DSL for no gain. |
| Migrations | Numbered `.sql` files applied at boot | Idempotent, transactional, and readable. |
| Container layout | `moodify-app` + `moodify-postgres` | The backend serves the built SPA, so the stack exposes one port. There is no separate frontend container. |

### Product behaviour

**Percent complete.** `completed / total` counted only over activities where completion tracking is
actually enabled (`tracking !== 0`). A `complete-fail` state counts as not completed. When a course
has **zero** completion-tracked activities the stored percent is `NULL`, and every widget renders
that as "not tracked" rather than 0% — the two mean very different things and conflating them
misreports a course as universally failing.

**Who appears in widgets.** `core_enrol_get_enrolled_users` returns teachers and managers alongside
students. Every widget filters to enrolments carrying the `student` role by default, so a teacher
sitting at 0% cannot drag down a class average or occupy a leaderboard slot. Roles are stored for
everyone, and each widget has an `includeStaff` toggle if you want them back.

**"Badges in a course".** Moodle has no endpoint that lists the badges *configured* for a course —
only the badges a given user has *earned*. So for Moodify's purposes, the badges in a course are the
union of badges actually awarded to its enrolled users. A configured-but-never-awarded badge is
invisible to Moodify. This is a Moodle API limitation, not a bug.

**Excluding students.** Each widget carries an opt-out list: everyone appears unless you tick
them out. Exclusions apply to rows, class averages and leaderboard rankings alike, so a test
account holding every badge can be removed without deleting anything in Moodle.

**Public address.** Share links are built from the external URL set in Settings → Public address.
Without it Moodify only knows the host and port it is bound to, which is wrong the moment it sits
behind a reverse proxy. Blank falls back to whatever address the browser is on.

**The grid never moves a widget by itself.** Free placement: no gravity, no compaction, no
breakpoints, and a drag cannot shove its neighbour aside. Where you drop a widget and how big you
made it is exactly what gets stored and exactly what renders next time.

This took three attempts to get right, so the reasoning is worth keeping. `compactType="vertical"`
is gravity, and react-grid-layout applies it inside `synchronizeLayoutWithChildren` on *every*
mount — not just on edits. A widget stored at `y=3` was pulled to `y=0` on every page load, and the
next drag saved the pulled-up version. Verified directly against the library's own `compact()`:
`{y:3},{y:3}` comes back `{y:0},{y:0}` under `"vertical"` and untouched under `null`. On top of that
`WidthProvider` paints once at a hardcoded 1280px before it measures, so on a wider screen the first
render was narrower than the page and drag distances were computed against the wrong column width —
hence `measureBeforeMount`. And the save itself was debounced behind a 500ms timer that the unmount
cleanup cancelled, so arranging widgets and immediately leaving the page discarded the arrangement.

Layout writes now happen immediately, only on drag-stop and resize-stop, and the server returns 409
if the update matched fewer widgets than were sent — a partly-saved arrangement looks exactly like
the grid moving things by itself, so it is reported rather than swallowed.

**Unconfigured widgets.** A widget is created with nothing selected and reports what it still
needs. Requiring a course before a widget could be added made three of the five impossible to add
at all.

**Sync split.** A light pass refreshes completion and badges for already-known user/course pairs on
the configured poll interval (default 60s, minimum 15s). A full re-discovery — new courses, new
enrolments, new users — runs every 15 minutes, and on demand via **Re-sync now** in Settings.

**Sync failure.** A failed sync never crashes the worker and never blanks a widget. The error is
stored on `moodle_connection.last_sync_error`, surfaced as a banner in the admin UI, and the last
known-good snapshot keeps rendering.

**Deletions.** Courses and users that vanish from Moodle are not hard-deleted — that would cascade
their completion snapshots away, sometimes because of a transient API hiccup. They simply stop
having `last_seen_at` refreshed.

**History, and the one exception to "live snapshot only".** Everything except the *Over time*
widget reads a snapshot that each sync overwrites. That widget needs a trail, so `metric_history`
gets one sample of every student's badge count and completion **every 15 minutes**, independent of
the poll interval, and anything older than **7 days** is deleted. The window therefore scales
outward on its own — a two-hour-old install charts two hours — up to a week, and then rolls forward
a sample at a time rather than emptying itself. Both bounds are constants in `sync.ts`. Sampling is
gated on the newest row in the table, not on a timer in the process, so restarting the container
does not restart the cadence. *Draw the whole span* turns the growing axis off: the chosen window is
drawn in full and the lines advance across a fixed axis instead, which is what a wall display
usually wants. Hovering the plot snaps a crosshair to the nearest real sample and reads every line's
value there — snapped rather than interpolated, so the tooltip only shows numbers that were actually
measured.

**All-time history, without a log store.** The *All time* window does not read
`metric_history` at all — it reconstructs the series from timestamps Moodle has been keeping since
long before Moodify was installed. `badge_issued.date_issued` is Moodle's own issue date, and
`core_completion_get_activities_completion_status` returns a `timecompleted` per activity, which
`activity_completion` now stores. Both come from calls the poller already makes, so this needs no
extra web service function, no log-store access and no additional Moodle permission — and an
install that is an hour old can chart a course that started last year.

Two things follow from that. Only *completed* activities get a row, since an incomplete one
contributes nothing to a cumulative history, and un-completing something in Moodle deletes its row
so the line can go down again. And a past percentage is measured against the activities the course
has **today**: Moodle does not report when an activity was added, so if the teacher added some
later, early percentages read slightly lower than they did at the time. Progress toward the course
as it now stands is the more useful reading for a leaderboard anyway. Timestamps are refreshed on
the full discovery pass only, not every poll — they are historical facts that do not change, so
re-reading them every 60 seconds would rewrite thousands of rows to learn nothing.

**Tasks.** A task attaches a date to one activity: *Tasks* in the top bar, pick a course, an
activity, optionally a cohort, and a date. Moodle's own "expected completion" dates are not
imported — Moodle has no notion of a different date per year group, which is the whole point here.

Both the activity picker and the task list are grouped by **course section**, in Moodle's own
section order rather than alphabetically, because that is the order the person setting them up
sees in Moodle itself. Moodle 4.5 subsections are not nested in the API response — a subsection
comes back as its own top-level section pointing at the `mod_subsection` instance hosting it — so
the sync resolves that link and stores the label as `Grundlagen › Woche 2`. A bare `Woche 2` could
be any of four.

Dates are always **dd/mm/yyyy**, never `toLocaleDateString`. That follows the browser's locale, so
the same board on a machine set to en-US reads 09/07/2026 as 7 September and the reader has no way
to tell which number is the month. A deadline is not a place to be ambiguous about that. Entering
one uses three dropdowns rather than `<input type="date">` for the same reason: that control renders
in the browser's own locale and neither `lang` nor CSS can override it, whereas a named month cannot
be misread.

Two ways to say when. A **fixed date** means exactly what it says and counts as overdue from the
end of that day. A **yearly rule** — "the first Monday in September" — stores (month, weekday, nth)
and computes the occurrence on read, so it rolls into the next year by itself and is measured
against whoever is in the cohort at that point: a student who moves from first year to second picks
up the second year's dates automatically. Exactly one of the two forms is stored; a database
constraint enforces it, because a task with no date at all can never come due and would read as a
bug forever.

`created_at` is load-bearing for the yearly form. Such a rule has, mathematically, always already
occurred, so without an anchor a rule entered in June would report the entire cohort overdue since
last September the instant it was saved. It takes effect at its first occurrence *after* it was
written down. A fixed date needs no anchor.

A task with no cohort applies to everyone enrolled in the course. One person reachable through two
cohorts is measured against the earliest deadline in force: being in two groups cannot buy an
extension. Either way enrolment is required — a cohort member who is not in the course is not
behind on its work.

An activity counts as overdue when its deadline has passed and `activity_completion` holds no row
for it. That table is refreshed on the full discovery pass, not every poll, so "overdue" can lag a
completion by up to fifteen minutes — day-granularity deadlines do not need better than that.

**Completion bars are one colour.** Light blue for progress, red only when something is overdue.
Not red/amber/green: a student at 20% in October is not failing, they are early, and colouring them
red beside someone at 70% states a verdict Moodify has no basis for. A missed deadline *is* a
verdict, so that is what gets red — in the completion table, the badge cards, and the ring segments
alike.

**Progress rings.** One ring per person, cut into an equal segment per course, each filled to that
course's completion in that course's colour — finish everything and the ring is a full circle of
colour.

A ring only shows courses its owner is **actually enrolled in**. Select four year-group courses and
a first-year student gets a single full ring for theirs, not three empty segments for courses they
cannot even open — empty reads as "has done nothing", the opposite of the truth. Colour therefore
comes from the course's position in the widget's list, never from where the segment happens to land
in one person's ring, so the legend holds for everybody. Selecting no courses at all means every
visible one, matching the `scope: all` default the other widgets use; with the per-person filter on
top, that is already a sensible board.

**Red is not a completion colour in a ring.** Segment colours are generated from the number of
courses on screen rather than taken from a list: hues spaced evenly across a 30°–330° band, so four
courses land 75° apart and eight land 37° apart, and nothing ever falls in the red the overdue state
owns. A fixed list has to wrap, and any list long enough not to wrap ends up holding four things
that all read as "blue" — sky, cyan, indigo and teal are distinct on a swatch and identical in a
12px arc across the room. If a course were simply coloured red, a class where everyone is on track
would look identical to a class where everyone has failed that course.

**Rings fill their column.** The SVG carries a viewBox and no fixed pixel size, and the grid uses
`auto-fit`, so empty tracks collapse and widening the widget grows the rings instead of the gaps.
"Ring size" therefore sets how densely the wall packs before it wraps, not a literal diameter.
Everything inside — stroke, text, avatar — is expressed in viewBox units, so a tile scales as one
piece. The per-course rows under each ring are a grid with fixed side columns padded out to the
busiest person's course count, so the numbers line up across every tile and the badges start at the
same height: a table read across a wall, without the ruled lines.

The tick inside a segment marks where the fill would reach with nothing overdue: work already done
plus work whose date has passed. The gap between fill and tick is exactly the missing work, and the
tick is therefore always ahead of the fill or absent. The first version divided *due deadlines* by
the course's activity count, which put one missed task among forty activities at 2.5% — at the very
start of the segment, behind the fill, for the person who had missed it. Completion and deadline
compliance are different axes; projecting one onto the other produced a number that meant nothing.

Under the name, overdue activities are listed by name rather than counted: "1 overdue activity"
says a problem exists and nothing about what to do. When nothing is overdue the line reads "on
track", or names how much was finished before its date came round. The old percentage "ahead of
plan / behind plan" is gone with the target it was derived from — with per-activity dates there is
no pace to be ahead of, only work done early.

Percentages sit in the middle of the ring, one line per course. Switching the ring to profile
pictures gives that space to the face and moves the percentages to a list underneath, so no
information is traded away for the nicer look. Badges can be listed under each ring too, for a
board that shows everything about a person on one tile.

**Email reminders.** Addresses come from Moodle and are never invented: a student Moodle gave no
address for is skipped, and Settings names them, because a reminder nobody receives is worse than
one that was never configured. Rules are global — "5 days before" is written once and applies to
every task, and several lead-time rules can coexist. The overdue rule fires once per occurrence.

`notification_log` is what makes "once" true across restarts, manual re-syncs and the fifteen-minute
poll. Its key includes the due date, not just the task: a yearly task comes round again next
September and has to be allowed to notify again, and the date is what makes this year's reminder a
different thing from last year's. Rows are written only for mail that actually left, so a send that
failed is retried — a duplicate is a smaller problem than a reminder nobody ever gets.

Several activities falling due on the same day for the same person become one message; different
days stay separate, because `{due}` in a template has to mean something. Days are counted midnight
to midnight rather than by subtracting instants — a deadline is stored as the *end* of its day, so
the raw difference would say "in 4 days" on the calendar's third.

The SMTP password is encrypted at rest with the same key as the Moodle token, is never logged, and
is write-only from the UI's side. A mail server that is down never fails a sync or raises the Moodle
banner; the error lands in Settings.

**Profile picture resolution.** `core_enrol_get_enrolled_users` always reports the `f1` variant,
100px, which is visibly soft once a ring fills a wide column. The avatar download asks for `f3`
first — the 250px retina variant Moodle has generated since 3.2 — and falls back through the other
sizes where it does not exist. Badge icons keep asking for whatever the exporter handed back first,
because there the given URL is the one known to work.

**Profile pictures.** Synced from `core_enrol_get_enrolled_users` and cached locally, for the same
reason badge icons are: `pluginfile.php` needs the web service token, so Moodle can never be
hotlinked. Moodle sends a URL even for users who never uploaded one — it points at the theme's
generic silhouette rather than `pluginfile.php`, and those are ignored so the chart can fall back to
initials instead of a row of identical strangers. Unlike badge icons, a face is personal data:
avatars are served only to a logged-in admin (`/api/user-image/:id`) or through a share token whose
dashboard is **not** anonymised (`/api/public/:token/user-image/:id`).

**Anonymization.** With *Anonymize names* on, the public route replaces names with `Student 1`,
`Student 2`, … numbered by ascending Moodle user id so the labels stay stable across reloads, and
strips email entirely, along with the profile picture — a face identifies someone at least as well
as a name, so "Student 3" beside their photo anonymises nothing. Initials were rejected for the
same reason: they are frequently re-identifying in a class of thirty. Substitution happens on the
server — real names are never sent to a public client. The admin view always shows real names.

**Public dashboards and personal data.** A public dashboard has no access control whatsoever once
the link exists. Names, badges and completion figures are personal data; under the Swiss FADP,
publishing them is the operator's responsibility. Moodify shows this warning before the toggle
flips, and does not block the feature.

### Schema note

The spec listed both a `dashboards.layout` JSON blob and `position_x/y/w/h` columns on `widgets`.
Those are two sources of truth for the same fact, which reliably drift. Grid geometry lives on
`widgets` only — the normalised form, and the one the spec described in more detail.

### Provisional

The dark theme (background `#0b0f14`, indigo `#6366f1` → violet `#8b5cf6` accent, 14px widget radius)
is a placeholder pending the Homarr reference screenshot, which is the visual source of truth once
provided.

## Development

Requires Node 22+ and a Postgres instance.

```sh
npm install
export DATABASE_URL=postgres://moodify:moodify@localhost:5432/moodify
export SESSION_SECRET=$(openssl rand -hex 32)
export ENCRYPTION_KEY=$(openssl rand -hex 32)

npm run dev      # backend on :8080, Vite dev server on :5173 proxying /api
npm run check    # typecheck both apps
npm test         # unit tests
```

## Repository layout

```
apps/backend      Fastify API, Moodle client, sync worker, migrations
apps/frontend     React + TypeScript SPA (Vite, Tailwind v4)
packages/shared   Types and widget config schemas shared by both
scripts           install.sh, uninstall.sh, generate-icons.sh
docs              the build spec
```
