-- Lets an admin delete a violation type that already has violations recorded.
-- Its violations are deleted, then any incident left with no violations, then
-- the type. Admins have no delete rights on violations or incidents directly,
-- so this runs as security definer and checks the caller itself.
create function public.delete_violation_type(p_type_id uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare
    v_incident_ids uuid[];
    v_violations int;
    v_incidents int;
begin
    if not private.is_admin() or not exists (
        select 1 from public.violation_types where id = p_type_id and org_id = private.current_org_id()
    ) then
        raise exception 'Not allowed' using errcode = '42501';
    end if;

    with deleted as (
        delete from public.violations where violation_type_id = p_type_id returning incident_id
    )
    select array_agg(distinct incident_id), count(*) into v_incident_ids, v_violations from deleted;

    delete from public.incidents i
    where i.id = any(coalesce(v_incident_ids, '{}'))
      and not exists (select 1 from public.violations v where v.incident_id = i.id);
    get diagnostics v_incidents = row_count;

    delete from public.violation_types where id = p_type_id;

    return json_build_object('violations', v_violations, 'incidents', v_incidents);
end;
$$;

revoke all on function public.delete_violation_type(uuid) from public, anon;
grant execute on function public.delete_violation_type(uuid) to authenticated;
