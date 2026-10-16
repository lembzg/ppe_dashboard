create table organisations (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    created_at timestamptz not null default now()
);

create table profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    org_id uuid not null references organisations (id) on delete cascade,
    email text not null,
    role text not null check (role in ('admin', 'customer')),
    created_at timestamptz not null default now()
);

create table sites (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organisations (id) on delete cascade,
    name text not null,
    timezone text not null default 'Europe/London'
);

create table zones (
    id uuid primary key default gen_random_uuid(),
    site_id uuid not null references sites (id) on delete cascade,
    name text not null,
    zone_type text
);

create table devices (
    id uuid primary key default gen_random_uuid(),
    zone_id uuid not null references zones (id) on delete cascade,
    serial text not null unique,
    model text,
    key_hash text not null,
    last_heartbeat timestamptz
);

create table shifts (
    id uuid primary key default gen_random_uuid(),
    site_id uuid not null references sites (id) on delete cascade,
    name text not null,
    starts_at time not null,
    ends_at time not null
);

create table violation_types (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references organisations (id) on delete cascade,
    code text not null,
    label text not null,
    severity_points int not null check (severity_points >= 0),
    unique (org_id, code)
);

create table score_configs (
    id uuid primary key default gen_random_uuid(),
    site_id uuid not null unique references sites (id) on delete cascade,
    baseline_score int not null default 100,
    score_window text not null check (score_window in ('daily', 'weekly'))
);

create table incidents (
    id uuid primary key default gen_random_uuid(),
    zone_id uuid not null references zones (id) on delete cascade,
    device_id uuid not null references devices (id) on delete cascade,
    shift_id uuid references shifts (id) on delete set null,
    session_id uuid not null,
    track_id int not null,
    started_at timestamptz not null,
    ended_at timestamptz,
    status text not null default 'open' check (status in ('open', 'closed')),
    unique (device_id, session_id, track_id)
);

create table violations (
    id uuid primary key default gen_random_uuid(),
    incident_id uuid not null references incidents (id) on delete cascade,
    violation_type_id uuid not null references violation_types (id),
    first_seen_at timestamptz not null,
    last_seen_at timestamptz not null,
    confidence double precision check (confidence between 0 and 1),
    vote_ratio double precision check (vote_ratio between 0 and 1),
    unique (incident_id, violation_type_id)
);

create table incident_clips (
    id uuid primary key default gen_random_uuid(),
    incident_id uuid not null references incidents (id) on delete cascade,
    storage_path text not null unique,
    duration_s int,
    blurred bool not null default false
);

alter table organisations enable row level security;
alter table profiles enable row level security;
alter table sites enable row level security;
alter table zones enable row level security;
alter table devices enable row level security;
alter table shifts enable row level security;
alter table violation_types enable row level security;
alter table score_configs enable row level security;
alter table incidents enable row level security;
alter table violations enable row level security;
alter table incident_clips enable row level security;

insert into storage.buckets (id, name, public)
values ('incident-clips', 'incident-clips', false);
