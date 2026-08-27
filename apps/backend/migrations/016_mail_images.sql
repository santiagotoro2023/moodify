-- The logo-at-the-top toggle is gone.
--
-- It needed a publicly reachable Moodify to serve the image from, which a self-hosted
-- install behind a LAN or a VPN does not have, and even with one most clients block
-- remote images until the reader asks for them. Images are now uploaded into the message
-- editor and travel with the mail as attachments, which needs no public address and no
-- setting — and puts the logo wherever the admin wants it rather than always at the top.
alter table smtp_settings drop column mail_show_logo;
