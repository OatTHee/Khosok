-- =========================================================
-- ตัวเลือกรางวัลต่องาน (2026-09-21) — ใช้กับ Supabase แล้ว
-- - give_points / give_exp: งานนี้แจกแต้มแลกการ์ด / EXP หรือไม่ (ค่าเริ่มต้น = แจก)
-- - reward_config: ตารางแต้ม/EXP ที่สตาฟตั้งเอง (null = เกณฑ์มาตรฐาน)
-- - other_rewards: ของรางวัลอื่น (แสดงผลอย่างเดียว แอดมินแจกเองนอกระบบ)
-- - แยก "แจก EXP" (t_award_exp) ออกจาก "ปิดจ็อบ บันทึกประวัติ" (t_close)
--   t_finish ตัวเดิมยังอยู่ เพื่อให้บอทเวอร์ชันเก่าที่ยังไม่ได้ deploy ใช้ได้จนกว่าจะอัปเดต
-- =========================================================
alter table public.tournaments
  add column if not exists give_points boolean not null default true,
  add column if not exists give_exp boolean not null default true,
  add column if not exists other_rewards text check (other_rewards is null or length(other_rewards) <= 500),
  add column if not exists reward_config jsonb,
  add column if not exists exp_awarded_at timestamptz,
  add column if not exists closed_v2 boolean not null default false;
comment on column public.tournaments.closed_v2 is 'true = ปิดจ็อบด้วย t_close (ไม่แจก EXP ตอนปิด) · false + finished = ปิดด้วย t_finish เดิมซึ่งแจก EXP ไปแล้ว';

comment on column public.tournaments.reward_config is
  '{"points":{"ranks":[10,5,5,5,5],"base_top":3,"expand_min_players":10,"expand_top":5},"exp":{"ranks":[50,30,30,20,20],"join":10,"full_play":10}} — null = เกณฑ์มาตรฐาน';

-- แจก EXP (กดได้ครั้งเดียว ก่อนหรือหลังปิดจ็อบก็ได้ แต่ต้องกรอกผลครบทุกแมตช์)
create or replace function public.t_award_exp(p_tournament_id uuid, p_results jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  t record; r jsonb; p record; v_res text; v_exp int; v_rank int;
  v_done jsonb := '[]'::jsonb; v_skip jsonb := '[]'::jsonb;
begin
  select * into t from tournaments where id = p_tournament_id for update;
  if not found then raise exception 'ไม่พบงานแข่งนี้'; end if;
  if t.status not in ('running','finished') then raise exception 'งานนี้ยังไม่เริ่มแข่ง'; end if;
  if not t.give_exp then raise exception 'งานนี้ตั้งค่าไว้ว่าไม่แจก EXP'; end if;
  if t.status = 'finished' and not t.closed_v2 then raise exception 'งานนี้ปิดจ็อบด้วยระบบเดิม ซึ่งแจก EXP ไปพร้อมกันแล้ว'; end if;
  if t.exp_awarded_at is not null then raise exception 'งานนี้แจก EXP ไปแล้ว'; end if;
  if exists (select 1 from tournament_matches where tournament_id = t.id and status <> 'complete') then
    raise exception 'ยังมีแมตช์ที่ยังไม่กรอกผล';
  end if;

  for r in select value from jsonb_array_elements(coalesce(p_results,'[]'::jsonb)) loop
    select * into p from tournament_players where id = (r->>'player_id')::uuid and tournament_id = t.id;
    if not found then continue; end if;
    v_rank := (r->>'rank')::int;
    v_exp  := coalesce((r->>'exp')::int, 0);

    update tournament_players
       set played_all = coalesce((r->>'played_all')::boolean, played_all)
     where id = p.id;

    if v_exp <= 0 or not coalesce((r->>'played')::boolean, false) then continue; end if;

    v_res := t_wallet_apply(p.customer_id, p.discord_id, 0, v_exp,
               'EXP ทัวร์นาเมนต์: ' || t.name || ' (อันดับ ' || v_rank || ')', t.id);
    if v_res = 'skipped' then
      v_skip := v_skip || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'exp', v_exp, 'rank', v_rank);
    else
      v_done := v_done || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'exp', v_exp, 'rank', v_rank, 'target', v_res);
    end if;
  end loop;

  update tournaments set exp_awarded_at = now() where id = t.id;
  return jsonb_build_object('awarded', v_done, 'skipped', v_skip);
end $$;

-- ปิดจ็อบ บันทึกประวัติ + สถิติ (ไม่แจก EXP)
create or replace function public.t_close(
  p_tournament_id uuid, p_results jsonb, p_participants_list text, p_match_history text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  t record; r jsonb; p record; v_rank int; v_uid uuid;
  v_history uuid; v_done jsonb := '[]'::jsonb; v_skip jsonb := '[]'::jsonb;
  v_count int;
begin
  select * into t from tournaments where id = p_tournament_id for update;
  if not found then raise exception 'ไม่พบงานแข่งนี้'; end if;
  if t.status = 'finished' then raise exception 'งานนี้ปิดจ็อบไปแล้ว'; end if;
  if t.status <> 'running' then raise exception 'งานนี้ยังไม่เริ่มแข่ง'; end if;
  if exists (select 1 from tournament_matches where tournament_id = t.id and status <> 'complete') then
    raise exception 'ยังมีแมตช์ที่ยังไม่กรอกผล';
  end if;

  select count(*) into v_count from tournament_players where tournament_id = t.id;

  insert into tournament_history (tournament_name, participants_list, match_history, player_count)
  values (t.name, p_participants_list, p_match_history, v_count)
  returning id into v_history;

  for r in select value from jsonb_array_elements(coalesce(p_results,'[]'::jsonb)) loop
    select * into p from tournament_players where id = (r->>'player_id')::uuid and tournament_id = t.id;
    if not found then continue; end if;
    v_rank := (r->>'rank')::int;

    update tournament_players set final_rank = v_rank where id = p.id;

    if not coalesce((r->>'played')::boolean, false) then continue; end if;

    v_uid := null;
    if p.customer_id is not null then
      select id into v_uid from customers where id = p.customer_id;
    end if;
    if v_uid is null and p.discord_id is not null then
      select id into v_uid from customers where discord_id = p.discord_id limit 1;
    end if;

    if v_uid is not null then
      insert into player_stats (user_id, duels, champion, top3, top5, last_active, updated_at)
      values (v_uid, 1, (v_rank = 1)::int, (v_rank <= 3)::int, (v_rank <= 5)::int, t.name, now())
      on conflict (user_id) do update set
        duels = player_stats.duels + 1,
        champion = player_stats.champion + (v_rank = 1)::int,
        top3 = player_stats.top3 + (v_rank <= 3)::int,
        top5 = player_stats.top5 + (v_rank <= 5)::int,
        last_active = t.name, updated_at = now();
      v_done := v_done || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'rank', v_rank, 'target', 'customer');
    elsif p.discord_id is not null and exists (select 1 from legacy_accounts where discord_id = p.discord_id) then
      update legacy_accounts set
        duels = duels + 1,
        champion = champion + (v_rank = 1)::int,
        top3 = top3 + (v_rank <= 3)::int,
        top5 = top5 + (v_rank <= 5)::int,
        last_active = t.name
      where discord_id = p.discord_id;
      v_done := v_done || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'rank', v_rank, 'target', 'legacy');
    else
      v_skip := v_skip || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'rank', v_rank);
    end if;
  end loop;

  update tournaments
     set status = 'finished', finished_at = now(), history_id = v_history, round_ends_at = null, closed_v2 = true
   where id = t.id;

  return jsonb_build_object('history_id', v_history, 'recorded', v_done, 'skipped', v_skip);
end $$;

revoke all on function public.t_award_exp(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.t_close(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.t_award_exp(uuid, jsonb) to service_role;
grant execute on function public.t_close(uuid, jsonb, text, text) to service_role;
