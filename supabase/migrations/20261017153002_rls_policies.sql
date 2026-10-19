create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create function private.current_org_id() returns uuid
language sql stable security definer set search_path = '' as $$
    select org_id from public.profiles where id = (select auth.uid())
$$;

create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce((select role = 'admin' from public.profiles where id = (select auth.uid())), false)
$$;

create function private.site_in_org(p_site_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.sites where id = p_site_id and org_id = private.current_org_id())
$$;

create function private.zone_in_org(p_zone_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.zones where id = p_zone_id and private.site_in_org(site_id))
$$;

create function private.incident_in_org(p_incident_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.incidents where id = p_incident_id and private.zone_in_org(zone_id))
$$;

revoke all on all functions in schema private from public;
grant execute on all functions in schema private to authenticated;

-- organisations
create policy "members read own org" on organisations for select to authenticated
    using (id = private.current_org_id());

-- profiles
create policy "members read org profiles" on profiles for select to authenticated
    using (org_id = private.current_org_id());
create policy "admins manage org profiles" on profiles for all to authenticated
    using (private.is_admin() and org_id = private.current_org_id())
    with check (private.is_admin() and org_id = private.current_org_id());

-- sites
create policy "members read sites" on sites for select to authenticated
    using (org_id = private.current_org_id());
create policy "admins manage sites" on sites for all to authenticated
    using (private.is_admin() and org_id = private.current_org_id())
    with check (private.is_admin() and org_id = private.current_org_id());

-- zones
create policy "members read zones" on zones for select to authenticated
    using (private.site_in_org(site_id));
create policy "admins manage zones" on zones for all to authenticated
    using (private.is_admin() and private.site_in_org(site_id))
    with check (private.is_admin() and private.site_in_org(site_id));

-- devices (key_hash never exposed to clients)
create policy "members read devices" on devices for select to authenticated
    using (private.zone_in_org(zone_id));
create policy "admins manage devices" on devices for all to authenticated
    using (private.is_admin() and private.zone_in_org(zone_id))
    with check (private.is_admin() and private.zone_in_org(zone_id));
revoke select (key_hash) on devices from authenticated, anon;

-- shifts
create policy "members read shifts" on shifts for select to authenticated
    using (private.site_in_org(site_id));
create policy "admins manage shifts" on shifts for all to authenticated
    using (private.is_admin() and private.site_in_org(site_id))
    with check (private.is_admin() and private.site_in_org(site_id));

-- score_configs
create policy "members read score configs" on score_configs for select to authenticated
    using (private.site_in_org(site_id));
create policy "admins manage score configs" on score_configs for all to authenticated
    using (private.is_admin() and private.site_in_org(site_id))
    with check (private.is_admin() and private.site_in_org(site_id));

-- violation_types
create policy "members read violation types" on violation_types for select to authenticated
    using (org_id = private.current_org_id());
create policy "admins manage violation types" on violation_types for all to authenticated
    using (private.is_admin() and org_id = private.current_org_id())
    with check (private.is_admin() and org_id = private.current_org_id());

-- incidents, violations, incident_clips: read-only for clients (written by service role)
create policy "members read incidents" on incidents for select to authenticated
    using (private.zone_in_org(zone_id));
create policy "members read violations" on violations for select to authenticated
    using (private.incident_in_org(incident_id));
create policy "members read incident clips" on incident_clips for select to authenticated
    using (private.incident_in_org(incident_id));

-- storage: members may read clip files belonging to their org's incidents
create policy "members read incident clip files" on storage.objects for select to authenticated
    using (
        bucket_id = 'incident-clips'
        and exists (
            select 1 from public.incident_clips c
            where c.storage_path = name and private.incident_in_org(c.incident_id)
        )
    );
