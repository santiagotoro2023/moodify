-- How the reminders look, and nothing about what they say.
--
-- Mail clients ignore stylesheets and <style> blocks with varying enthusiasm, so these
-- become inline styles on a wrapper at send time rather than a class anywhere. Kept as
-- four settings instead of a free-form CSS box: the body already accepts HTML for
-- anything specific, and a stylesheet field is a support request waiting to happen.
alter table smtp_settings
  add column mail_font text not null default 'system',
  add column mail_font_size int not null default 15
    check (mail_font_size between 10 and 28),
  add column mail_text_color text not null default '#1f2933',
  -- Links, and the rule under the header. The one colour a reader will actually notice.
  add column mail_accent_color text not null default '#2563eb',
  -- The logo already uploaded in Settings, at the top of every message. Off by default:
  -- it needs the public base URL set, or the image is a broken box in every inbox.
  add column mail_show_logo boolean not null default false;
