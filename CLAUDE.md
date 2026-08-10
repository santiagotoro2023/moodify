Moodify — Build Specification for Claude Code
Product name: Moodify
One-liner: A self-hosted, CLI-free dashboard that connects to a Moodle instance via its Web Service API, tracks per-user course completion % and badges, and displays them on fully customizable, Homarr-style widget dashboards — including public share links.
---
0. READ THIS FIRST — Working Agreement
This spec is intentionally detailed, but it will not cover every implementation decision. Whenever anything is ambiguous, underspecified, or you have to make an assumption that materially affects behavior, data model, security, or UX — stop and ask the user before writing code. Do not silently pick a default and move on. Examples of "ask, don't assume": exact color hex values beyond what's specified, naming of DB columns not listed here, how to handle a Moodle API error case not described below, whether a setting belongs in the wizard vs. Settings page if not stated, etc. Guessing wrong here is expensive to unwind later — asking costs one message.
This applies for the entire build, not just the first session.
---
1. Goals & Non-Goals
Goals (v1):
Connect to exactly one Moodle instance (architecture should not hard-block adding more later, but do not build multi-instance UI/logic now).
Auto-discover courses, enrolled users, and awarded badges from that Moodle instance via the Web Service API — no manual entry of course/user data.
Poll Moodle on a configurable interval (default 60s) and keep a live (non-historical) snapshot of: per-user-per-course activity completion %, and per-user badges (with cached images).
Let the user build one or more dashboards from widgets (completion table, badge cards, course overview, leaderboard, user list), arrange them in a grid, collapse/expand widgets, set per-widget titles, and set a per-dashboard background image and site logo.
Public, unauthenticated share links per dashboard, with an optional "anonymize names" toggle.
Entirely manageable from the browser after a single install command — no CLI use for any ongoing configuration, connection management, dashboard editing, or user management.
Runs on Debian via Docker Compose.
Non-goals (v1 — do not build unless asked):
Multi-Moodle-instance support in the UI.
Historical trend charts / time-series storage of completion over time (explicitly live-snapshot only).
Writing data back to Moodle (this is read-only, one-directional).
Multi-admin-user roles/permissions beyond a single admin account type (see §6).
Native mobile app.
---
2. Target Environment
OS: Debian (12/13). Assume a fresh minimal Debian server with sudo access, no Docker pre-installed. Also tolerate Docker already being present.
Deployment: Docker Compose, multi-container.
Reverse proxy: Assume Moodify sits behind an external reverse proxy (e.g., nginx) that terminates TLS. Moodify itself only needs to expose one HTTP port. Do not build TLS termination into Moodify.
Persistence: A named Docker volume for Postgres data, and a named volume (or bind mount) for uploaded/generated assets (logos, backgrounds, cached badge images).
---
3. Tech Stack (locked)
Layer	Choice
Frontend	React + TypeScript SPA (Vite)
UI styling	Tailwind CSS + shadcn/ui components
Grid/drag-drop	`dnd-kit` (or `react-grid-layout` — pick one, document the choice in the repo README, do not silently mix both)
Icons	`lucide-react`
Backend	Node.js, TypeScript, Fastify (preferred) or Express
Poller/worker	Same Node codebase, scheduled via `node-cron`, can run in the same container as the API or a separate `worker` service in Compose — your call, document it
Database	PostgreSQL
Auth	Session cookie or JWT — your call, but must support a distinct unauthenticated route class for public dashboards (see §10)
Containerization	Docker Compose (services: `frontend` or served statically by backend, `backend`, `worker` if split, `postgres`)
If any of these choices turn out to conflict with something else in this spec, ask before deviating.
---
4. Core Product Principles (apply throughout)
Zero ongoing CLI. Every setting that could plausibly be a CLI flag or `.env` edit must instead be a form field in the web app, editable after install. The only CLI interaction a user ever has is running the installer once, and optionally the uninstaller.
Wizard-first setup. First run always lands on a setup wizard, not a login screen or blank dashboard.
Ask-before-assuming applies to runtime UX too, in the sense that the app should never silently fail — connection errors, sync failures, permission errors from Moodle, etc. must surface clearly in the UI (see §9.4), not just in logs.
Modern, Homarr-inspired design: dark theme, large rounded corners (12–16px radius), soft shadows / subtle glass effect on cards, generous spacing, icon-forward UI, no sharp edges anywhere. The user will provide a reference screenshot of their own Homarr setup — treat it as the visual source of truth for spacing/radius/color-depth conventions once provided; use the guidance in §11 until then.
---
5. Repository Structure (proposed)
```
moodify/
├── apps/
│   ├── frontend/          # React + TS SPA
│   ├── backend/           # Fastify/Express API + auth + dashboard/widget logic
│   └── worker/            # Moodle poller/sync (or merged into backend — document choice)
├── packages/
│   └── shared/            # Shared TS types between frontend/backend (API contracts, widget config schemas)
├── scripts/
│   ├── install.sh
│   └── uninstall.sh
├── docker-compose.yml
├── .env.example
├── docs/
│   └── MOODIFY_BUILD_SPEC.md   # this file, kept in-repo for reference
└── README.md
```
---
6. Data Model (PostgreSQL)
This is the required minimum schema. Exact column types/naming conventions are up to you as long as the entities and relationships below are represented. Ask if you need to add an entity not listed here.
admin_users — id, email/username, password_hash, created_at, last_login_at. Single role type for v1 (no RBAC (Role-Based Access Control) tiers).
moodle_connection — single row (or small table designed to extend to many later): base_url, ws_token (encrypted at rest, see §9.5), service_shortname, last_sync_at, last_sync_status, last_sync_error, poll_interval_seconds (default 60).
courses — moodle_course_id, shortname, fullname, visible, last_seen_at.
moodle_users — moodle_user_id, fullname, email (nullable), last_seen_at.
enrollments — course_id (FK), moodle_user_id (FK), role info if available.
completion_snapshot — course_id, moodle_user_id, activities_total, activities_completed, percent_complete, updated_at. One row per user-course, overwritten each sync (live snapshot only — no history table).
badges — moodle_badge_id, course_id (nullable — badges can be site-wide), name, description, cached_image_path.
badge_issued — badge_id (FK), moodle_user_id (FK), date_issued.
dashboards — id, name, layout (JSON: widget positions/sizes), background_image_path (nullable), is_public (bool), public_share_token (nullable, unique), anonymize_on_public (bool, default false), created_at, updated_at.
widgets — id, dashboard_id (FK), type (enum: `completion_table`, `badge_cards`, `course_overview`, `leaderboard`, `user_list`), title (nullable — user-set override), config (JSON — widget-specific, see §10), position_x/y/w/h, is_collapsed (bool), created_at.
app_settings — key/value store for: site logo path (nullable), generated default logo path, favicon path, other global settings.
---
7. Installer (`scripts/install.sh`)
Must run non-interactively where possible, with sane defaults, and must be idempotent (safe to re-run).
Steps:
Detect OS (must be Debian-family; warn but don't hard-block if it's Ubuntu, since it's Debian-based).
Check for Docker + Docker Compose plugin. If missing, install via the official Docker apt repository (not the distro's outdated `docker.io` package). Ask before falling back to any other install method if the official repo approach fails.
Create an install directory (e.g., `/opt/moodify`), pull or copy the repo contents there if not already running from within it.
Generate a `.env` file automatically: random Postgres password, random JWT/session secret, random encryption key for the Moodle token (see §9.5). Never prompt the user for secrets here — all human-facing setup happens in the browser wizard, not the installer.
`docker compose up -d`.
Wait for the backend health check to pass.
Print: the URL to open (e.g., `http://<host-ip>:<port>`), and remind the user this is the only CLI step required.
Set `restart: unless-stopped` on all Compose services so the stack survives reboots without needing a systemd unit.
Uninstaller (`scripts/uninstall.sh`):
`docker compose down`.
Ask (interactively, since this is destructive and rare) whether to also remove the Postgres volume and uploaded assets, or preserve them for a future reinstall. Default to preserving.
Optionally remove the install directory.
---
8. First-Run Setup Wizard (browser)
Triggered automatically when the app detects no `admin_users` row exists yet. Steps, in order:
Create admin account — username/email + password.
Connect Moodle — form fields: Moodle base URL, and a choice between:
Paste an existing Web Service token (baseline, always works) — user pastes a token they generated manually in Moodle admin.
Auto-provision via `login/token.php` — Moodify base_url + username + password + service shortname, calling Moodle's standard token endpoint (`/login/token.php?username=...&password=...&service=...`) to fetch and store a token. Mark this path clearly as requiring the Moodle admin to have already created a dedicated External Service in Moodle with the needed functions enabled and "can be downloaded/mobile-service-style token auth" turned on for that account — this is unavoidable one-time Moodle-side config, not something Moodify can do remotely. Show this as in-app help text, including the specific Web Service functions the External Service needs (see §9.1).
Test connection — call a lightweight Moodle WS function (e.g., `core_webservice_get_site_info`) to confirm the token works before proceeding. Show a clear error if it fails (bad URL, bad token, function not enabled, etc.) and let the user go back and fix it — don't dead-end.
Run first discovery/sync — trigger the full discovery flow (§9.2), show live progress (courses found, users found, badges found), land on completion.
Redirect to "create your first dashboard."
---
9. Moodle Integration Layer
9.1 Required Web Service functions
The Moodle-side External Service (created by the admin per the wizard instructions) must expose:
`core_webservice_get_site_info` — connection test.
`core_course_get_courses` (or `core_course_get_courses_by_field`) — course discovery.
`core_enrol_get_enrolled_users` — per-course user discovery.
`core_completion_get_activities_completion_status` — per-user-per-course activity completion states.
`core_completion_get_course_completion_status` — aggregate course completion (optional, nice-to-have alongside the activity-level calc).
`core_badges_get_user_badges` — per-user (optionally scoped `courseid`) badge list.
9.2 Discovery flow
`core_course_get_courses` → list all visible courses.
Per course: `core_enrol_get_enrolled_users` → enrolled users.
Per user-course pair: `core_completion_get_activities_completion_status` → compute `percent_complete = completed_activities_with_completion_enabled / total_activities_with_completion_enabled * 100`. If a course has zero completion-tracked activities, store `null`/"not tracked" rather than 0% or 100% — surface this distinctly in the UI (§10).
Per user-course pair: `core_badges_get_user_badges(userid, courseid)` → badges earned in that course. There is no Moodle endpoint listing all badges configured for a course — "badges in a course" for Moodify's purposes is defined as the union of badges actually awarded to enrolled users in that course. Document this assumption in the README so it's not mistaken for a bug later.
9.3 Badge images
Moodle serves badge images via `pluginfile.php`, which requires authentication — do not hotlink Moodle URLs directly in the frontend. On sync, download each new badge's image once, store it locally (filesystem or DB blob — your call), and serve it from Moodify's own backend.
9.4 Sync scheduling & failure handling
Poll interval configurable in Settings (default 60s), stored in `moodle_connection.poll_interval_seconds`.
Full re-discovery (new courses/users/badges) does not need to happen every single poll — a lighter "refresh completion + badges for known entities" pass can run on the configured interval, with full discovery on a longer interval (e.g., every 15 min) or a manual "Re-sync now" button in Settings. Pick a reasonable split and document it; ask if unsure.
On any Moodle API failure (network error, auth error, permission error, function disabled), do not crash the worker. Log the error, store it on `moodle_connection.last_sync_error`, and surface a visible banner in the admin UI ("Last sync failed: <reason>, at <time>"). Widgets should keep showing the last-known-good data rather than going blank.
9.5 Credential security
The Moodle Web Service token must be encrypted at rest in Postgres (e.g., AES-256-GCM using the key generated into `.env` at install time), not stored in plaintext. Never log the token. Never expose it to the frontend after initial entry (write-only from the UI's perspective — Settings can show "token configured, last 4 chars: ••••ab12" and a "replace token" action, not the full value).
---
10. Dashboard & Widget System
Multiple dashboards, each with a name, its own grid layout, its own background image, and its own public/private + anonymize settings.
Grid: draggable and resizable widgets, positions persisted per dashboard.
Widget chrome: every widget has a consistent frame — user-editable title (defaults to a sensible auto-title like "Completion — Course X" but overridable), a collapse/expand toggle that persists state, and a drag handle. Collapsed state persists across reloads.
Sticky background: the dashboard's background image/color is fixed to the viewport (`position: fixed` or `background-attachment: fixed` equivalent implemented in a way that also works cleanly on mobile Safari, which has known quirks with `background-attachment: fixed` — verify actual behavior rather than assuming it works, and use a fixed-position background layer element as a fallback if needed). Only the widget grid in front of it scrolls/moves. The background must never scroll with the content.
Widget types (v1):
Widget	Shows	Config options
`completion_table`	User × course completion % as a table	Scope: all courses or a specific course; sortable columns
`badge_cards`	Per-user cards showing badge image + name for earned badges	Scope: specific user, or all users in a course
`course_overview`	Class-average completion % for a course, enrolled count	Course selector
`leaderboard`	Users ranked by badge count (descending)	Scope: all courses or a specific course; limit (top N)
`user_list`	A user, their badges (image + name), and completion % across all courses or one specific course	User selector; course scope selector (all vs. specific)
Each widget's `config` JSON should be validated against a shared TypeScript type/schema (in `packages/shared`) so frontend and backend agree on shape.
---
11. Branding & Design System
Name: Moodify. Use it consistently in the UI header, page titles, favicon alt text, README, Docker image/container names (e.g., `moodify-backend`, `moodify-frontend`, `moodify-postgres`), and the Compose project name.
Default logo/favicon: As part of the build (not as a runtime feature), design and generate a simple, modern SVG-based Moodify wordmark/monogram (e.g., a rounded "M" mark or abstract badge-like shape, reflecting the product's subject matter without literally copying Moodle's branding) and export it as the default logo and favicon (multiple sizes: 16/32/180/512px plus the source SVG). This generated asset is the fallback used everywhere a logo/favicon is needed. At runtime, Settings must let the admin upload a custom logo; whenever a custom logo is present, use it instead of the generated default — implement this as explicit fallback logic (`custom_logo_path ?? default_logo_path`), not by overwriting the default asset.
Theme: dark background, rounded corners (12–16px on cards/widgets, larger on modals), soft shadows or subtle translucency on widget surfaces, generous internal padding. Icon set: `lucide-react` throughout (nav, widget headers, buttons, empty states).
Reference: the user will share a screenshot of their existing Homarr dashboard as the visual reference for exact spacing/color-depth/corner-radius conventions — once provided, treat it as authoritative over the general description above; ask if the two conflict.
---
12. Auth & Access Model
Admin side (connection management, dashboard editing, settings, user management): simple built-in login (the single admin account created in the wizard; supporting additional admin accounts later is fine to build if trivial, but not required for v1).
Public dashboards: a dashboard with `is_public = true` is reachable via an unguessable share-token URL (e.g., `/public/<token>`) with no login required, rendered read-only (no edit controls, no navigation into admin areas). Regenerating the token must invalidate the old URL immediately.
Anonymization: when `anonymize_on_public = true` on a dashboard, the public render must replace real names with a non-reversible-looking label (e.g., initials or "Student 1", "Student 2" — pick one and document it) consistently within that dashboard view. This only affects the public route; the admin view always shows real names.
Flag to the user in-app (e.g., a one-time notice when first enabling public sharing) that a public dashboard exposing real names/badges/completion data is personal data with no access control once the link exists — this is a data-protection consideration (Switzerland: FADP (Federal Act on Data Protection)), not just a technical toggle. Don't block the feature, just make sure the tradeoff is visible before the admin flips it on.
---
13. Non-Functional Requirements
Scale target: <50 users, <20 courses. Design for this scale — do not over-engineer for high concurrency/large datasets, but don't paint yourself into a corner that makes future growth impossible either.
Resilience: the app (frontend + widgets) must degrade gracefully if the Moodle connection is broken or mid-first-sync — never a blank crash screen; show connection/sync status instead.
No required internet access at runtime beyond reaching the configured Moodle URL (don't introduce external API dependencies for core functionality).
---
14. Suggested Build Order
Repo scaffold, Docker Compose skeleton, install/uninstall scripts, empty health-check endpoint. Verify the install script works on a clean Debian box before building features on top of it.
DB schema + migrations.
Admin auth + setup wizard steps 1–3 (account creation, Moodle connection, connection test).
Moodle integration layer + discovery/sync worker (§9), wizard step 4.
Dashboard/widget CRUD backend + shared config schemas.
Frontend: dashboard grid, all five widget types, sticky background behavior.
Branding: generated default logo/favicon, Settings upload flows for custom logo/background.
Public sharing + anonymization.
Settings polish: connection management, re-sync button, poll interval control, sync status/log viewer, backup/export.
Design pass against the Homarr reference screenshot once provided.
---
15. Explicit Reminder
If at any point during this build a requirement in this document is ambiguous, missing, or seems to conflict with something else here — stop and ask the user rather than guessing. This is a standing instruction for the whole project, not just the first session.
