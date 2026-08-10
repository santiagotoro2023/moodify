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

**Sync split.** A light pass refreshes completion and badges for already-known user/course pairs on
the configured poll interval (default 60s, minimum 15s). A full re-discovery — new courses, new
enrolments, new users — runs every 15 minutes, and on demand via **Re-sync now** in Settings.

**Sync failure.** A failed sync never crashes the worker and never blanks a widget. The error is
stored on `moodle_connection.last_sync_error`, surfaced as a banner in the admin UI, and the last
known-good snapshot keeps rendering.

**Deletions.** Courses and users that vanish from Moodle are not hard-deleted — that would cascade
their completion snapshots away, sometimes because of a transient API hiccup. They simply stop
having `last_seen_at` refreshed.

**Anonymization.** With *Anonymize names* on, the public route replaces names with `Student 1`,
`Student 2`, … numbered by ascending Moodle user id so the labels stay stable across reloads, and
strips email entirely. Initials were rejected: they are frequently re-identifying in a class of
thirty. Substitution happens on the server — real names are never sent to a public client. The
admin view always shows real names.

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
