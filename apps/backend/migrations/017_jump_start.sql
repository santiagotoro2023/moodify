-- Catching up when mailing is switched on.
--
-- The scheduled pass only ever looks forward: switch mailing on the evening before a
-- deadline and the five-day reminder for it never goes out, because the day it was owed
-- has already passed. Going live is exactly when everyone most needs telling.
--
-- Off by default. A first sync on a busy Moodle can leave a lot of tasks overdue, and
-- discovering that by mailing a hundred students is not a discovery anyone wants.
alter table smtp_settings
  add column jump_start boolean not null default false,
  -- How far ahead the catch-up reaches, over and above what each rule's own window says.
  add column jump_start_days int not null default 5
    check (jump_start_days between 1 and 60);
