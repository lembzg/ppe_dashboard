create table site_daily_stats (
    site_id uuid not null references sites (id) on delete cascade,
    day date not null,
    people_observed int not null check (people_observed >= 0),
    primary key (site_id, day)
);

alter table site_daily_stats enable row level security;

create policy "members read site daily stats" on site_daily_stats for select to authenticated
    using (private.site_in_org(site_id));
create policy "admins manage site daily stats" on site_daily_stats for all to authenticated
    using (private.is_admin() and private.site_in_org(site_id))
    with check (private.is_admin() and private.site_in_org(site_id));
