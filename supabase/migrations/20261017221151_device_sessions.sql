-- One row per detection session a device reports: a processed recording, or one
-- run of the live tracker. Written only by the ingest edge function.
create table device_sessions (
    id uuid primary key,
    device_id uuid not null references devices (id) on delete cascade,
    recording text,
    started_at timestamptz not null,
    ended_at timestamptz,
    people_observed int not null default 0 check (people_observed >= 0),
    created_at timestamptz not null default now()
);

alter table device_sessions enable row level security;

-- Rebuilds a site's people observed for one local day from its devices' sessions,
-- so a session reported twice is never counted twice.
create function public.refresh_site_daily_stats(p_site_id uuid, p_day date) returns void
language sql security definer set search_path = '' as $$
    insert into public.site_daily_stats (site_id, day, people_observed)
    select p_site_id, p_day, coalesce(sum(s.people_observed), 0)::int
    from public.device_sessions s
    join public.devices d on d.id = s.device_id
    join public.zones z on z.id = d.zone_id
    join public.sites st on st.id = z.site_id
    where z.site_id = p_site_id
      and (s.started_at at time zone st.timezone)::date = p_day
    on conflict (site_id, day) do update set people_observed = excluded.people_observed
$$;

revoke all on function public.refresh_site_daily_stats(uuid, date) from public, anon, authenticated;
grant execute on function public.refresh_site_daily_stats(uuid, date) to service_role;
