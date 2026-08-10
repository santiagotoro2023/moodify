-- Moodify initial schema (spec §6).
--
-- Moodle's own IDs are used as primary keys for synced entities: they are stable,
-- already unique, and let a dashboard config survive a database wipe + re-sync.
-- Only Moodify-owned entities (dashboards, widgets, admins) get surrogate keys.

create table admin_users (
  id            serial primary key,
  username      text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- One row in v1. Deliberately NOT constrained to a singleton so a second
-- instance can be added later without a migration (spec §1).
create table moodle_connection (
  id                    serial primary key,
  base_url              text not null,
  ws_token              text not null,   -- AES-256-GCM ciphertext, never plaintext (§9.5)
  service_shortname     text,
  poll_interval_seconds int  not null default 60,
  last_sync_at          timestamptz,
  last_sync_status      text not null default 'never',
  last_sync_error       text,
  created_at            timestamptz not null default now()
);

create table courses (
  moodle_course_id int primary key,
  shortname        text not null,
  fullname         text not null,
  visible          boolean not null default true,
  last_seen_at     timestamptz not null default now()
);

create table moodle_users (
  moodle_user_id int primary key,
  fullname       text not null,
  email          text,
  last_seen_at   timestamptz not null default now()
);

-- Roles are kept for everyone Moodle reports; widgets filter to students by
-- default so teachers don't skew averages and leaderboards.
create table enrollments (
  moodle_course_id int not null references courses(moodle_course_id) on delete cascade,
  moodle_user_id   int not null references moodle_users(moodle_user_id) on delete cascade,
  roles            text[] not null default '{}',
  last_seen_at     timestamptz not null default now(),
  primary key (moodle_course_id, moodle_user_id)
);

-- Live snapshot only: one row per user-course, overwritten each sync (§6, §1).
create table completion_snapshot (
  moodle_course_id     int not null references courses(moodle_course_id) on delete cascade,
  moodle_user_id       int not null references moodle_users(moodle_user_id) on delete cascade,
  activities_total     int not null default 0,
  activities_completed int not null default 0,
  -- NULL means the course has no completion-tracked activities at all.
  -- Distinct from 0.00, which means "tracked, none done yet" (§9.2).
  percent_complete     numeric(5,2),
  updated_at           timestamptz not null default now(),
  primary key (moodle_course_id, moodle_user_id)
);

create table badges (
  moodle_badge_id   int primary key,
  moodle_course_id  int references courses(moodle_course_id) on delete set null, -- NULL = site-wide badge
  name              text not null,
  description       text,
  cached_image_path text
);

create table badge_issued (
  moodle_badge_id int not null references badges(moodle_badge_id) on delete cascade,
  moodle_user_id  int not null references moodle_users(moodle_user_id) on delete cascade,
  date_issued     timestamptz,
  primary key (moodle_badge_id, moodle_user_id)
);

create table dashboards (
  id                    serial primary key,
  name                  text not null,
  background_image_path text,
  is_public             boolean not null default false,
  public_share_token    text unique,
  anonymize_on_public   boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Grid geometry lives here rather than in a dashboards.layout JSON blob so
-- there is exactly one source of truth for widget position (see README).
create table widgets (
  id           serial primary key,
  dashboard_id int not null references dashboards(id) on delete cascade,
  type         text not null check (type in (
                 'completion_table', 'badge_cards', 'course_overview',
                 'leaderboard', 'user_list')),
  title        text,            -- NULL = use the auto-generated title
  config       jsonb not null default '{}'::jsonb,
  position_x   int not null default 0,
  position_y   int not null default 0,
  position_w   int not null default 4,
  position_h   int not null default 4,
  is_collapsed boolean not null default false,
  created_at   timestamptz not null default now()
);

create table app_settings (
  key   text primary key,
  value text
);

create index enrollments_user_idx  on enrollments (moodle_user_id);
create index badge_issued_user_idx on badge_issued (moodle_user_id);
create index widgets_dashboard_idx on widgets (dashboard_id);
