-- badge_list: the badge grid without the completion bar (badge_cards keeps both).
alter table widgets drop constraint widgets_type_check;
alter table widgets add constraint widgets_type_check check (type in (
  'completion_table', 'badge_cards', 'badge_list', 'course_overview',
  'leaderboard', 'user_list'));
