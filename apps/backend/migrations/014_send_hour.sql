-- When the day's reminders go out.
--
-- The pass runs every fifteen minutes and used to mail the moment a rule matched, which
-- meant a student could be told at 03:00 that something is due tomorrow. One hour a day
-- for everything is both kinder and easier to reason about: eligibility changes at
-- midnight, and the first pass at or after this hour sends the lot.
--
-- Default 7 rather than "keep sending immediately": an install that has been mailing at
-- arbitrary hours was not choosing that, and 07:00 is the least surprising hour to
-- receive school mail.
alter table smtp_settings add column send_hour int not null default 7
  check (send_hour between 0 and 23);
