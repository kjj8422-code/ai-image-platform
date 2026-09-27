-- Apply before deploying the reorder API. One transaction: all positions move or none do.
create or replace function public.reorder_video_scenes(
  p_job_id uuid, p_order uuid[], p_expected_order uuid[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_ids uuid[];
  lowest_index integer;
  item record;
begin
  perform 1 from public.video_jobs where id = p_job_id for update;
  if not found then raise exception 'Job not found'; end if;
  perform 1 from public.video_scenes where job_id = p_job_id order by id for update;
  select array_agg(id order by scene_index), min(scene_index)
    into current_ids, lowest_index from public.video_scenes where job_id = p_job_id;
  if p_order is null or current_ids is null or cardinality(p_order) <> cardinality(current_ids)
     or cardinality(p_order) <> (select count(distinct v) from unnest(p_order) v)
     or not (p_order @> current_ids and current_ids @> p_order) then
    raise exception 'Invalid scene order';
  end if;
  if p_expected_order is distinct from current_ids then
    raise exception 'Scene order changed. Refresh and retry.';
  end if;
  if exists(select 1 from public.video_scenes where job_id=p_job_id and status='generating') then
    raise exception 'Wait for scene generation before reordering.';
  end if;
  -- Temporary values are strictly below every current index, even after an old partial failure.
  for item in select id, ord from unnest(p_order) with ordinality as t(id, ord) loop
    update public.video_scenes set scene_index=least(lowest_index, 0)-item.ord
      where id=item.id and job_id=p_job_id;
  end loop;
  for item in select id, ord from unnest(p_order) with ordinality as t(id, ord) loop
    update public.video_scenes set scene_index=item.ord, updated_at=now()
      where id=item.id and job_id=p_job_id;
  end loop;
end;
$$;
revoke all on function public.reorder_video_scenes(uuid,uuid[],uuid[]) from public, anon, authenticated;
grant execute on function public.reorder_video_scenes(uuid,uuid[],uuid[]) to service_role;
