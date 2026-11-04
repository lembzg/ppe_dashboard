-- Preserve separate event episodes for the same person in one session.
-- Older clients retain their original one-incident-per-track behaviour.
alter table public.incidents add column episode_id text;
update public.incidents set episode_id = 'track:' || track_id::text;
alter table public.incidents alter column episode_id set not null;
alter table public.incidents
    drop constraint incidents_device_id_session_id_track_id_key;
alter table public.incidents
    add constraint incidents_device_session_episode_key
    unique (device_id, session_id, episode_id);
