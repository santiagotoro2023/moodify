-- Microsoft 365 as a second way out, beside SMTP.
--
-- Delegated OAuth against one mailbox: the admin signs in as themselves, consents once,
-- and Moodify keeps a refresh token that can do exactly one thing — send mail as that
-- person. No client secret (the app registration is a public client, so there is nothing
-- to leak), no mailbox password, and no tenant-wide switch to flip. This exists because
-- Microsoft is retiring basic authentication for SMTP client submission; smtp.office365.com
-- with a username and password is on its way out, and the settings that keep it alive are
-- tenant settings, not something a mailbox owner can grant themselves.
alter table smtp_settings
  add column transport text not null default 'smtp' check (transport in ('smtp', 'graph')),
  -- Directory (tenant) and Application (client) id of the admin's own app registration.
  -- Not secrets: a public client id is published to the browser by design.
  add column graph_tenant_id text not null default '',
  add column graph_client_id text not null default '',
  -- The signed-in mailbox, for display. Mail always goes out as this address, whatever
  -- from_email says — a delegated token cannot send as anyone else.
  add column graph_account text,
  -- AES-256-GCM, same key as the Moodle token and the SMTP password (§9.5). Rotated by
  -- Microsoft on nearly every refresh, so this column is written far more often than the
  -- others; it is never returned to the frontend.
  add column graph_refresh_token_encrypted text;
