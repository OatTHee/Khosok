-- =========================================================
-- แก้ผลย้อนหลัง / เปิดงานใหม่ / รีเซ็ตผล (2026-09-23)
-- - ไม่แตะแต้มแลกการ์ดและ EXP เลย (แจกไปแล้วก็คงไว้ ไม่แจกซ้ำ)
-- - tournament_audit: บันทึกทุกการแก้ไขผล ใครทำ ค่าเดิม/ค่าใหม่ เหตุผล
-- - tournament_players.stats_applied: สถิติที่ t_close บวกให้คนนี้ (เอาไว้หักคืนตอนเปิดงานใหม่ได้ตรงตัว)
-- - t_close: เก็บ stats_applied + ถ้างานเคยปิดแล้ว (เปิดใหม่) อัปเดตประวัติแถวเดิมแทนการสร้างแถวใหม่
-- - t_reopen: ปิดจ็อบแล้ว → กลับมาแข่งต่อ (หักสถิติที่เคยบวก)
-- - t_reset: ล้างผลทั้งงาน กลับไปเปิดรับสมัคร (คงรายชื่อผู้เล่น)
-- =========================================================

create table if not exists public.tournament_audit (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  match_id uuid,
  action text not null,
  reason text check (reason is null or length(reason) <= 500),
  actor_id uuid,
  actor_name text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index if not exists tournament_audit_tournament_idx on public.tournament_audit (tournament_id, created_at desc);
alter table public.tournament_audit enable row level security;
revoke all on public.tournament_audit from anon, authenticated;
comment on table public.tournament_audit is 'บันทึกการแก้ผล/ย้อนรอบ/เปิดงานใหม่/รีเซ็ต ของเว็บจัดทัวร์ Khosok (เขียนผ่าน service_role เท่านั้น)';

alter table public.tournament_players
  add column if not exists stats_applied jsonb;
comment on column public.tournament_players.stats_applied is
  'สถิติที่ t_close บวกให้ {"target":"customer","user_id":..,"champion":0|1,"top3":0|1,"top5":0|1} หรือ {"target":"legacy","discord_id":..,...} · null = ไม่ได้บวก';

alter table public.tournaments
  add column if not exists stats_snapshot boolean not null default false,
  add column if not exists reopened_at timestamptz,
  add column if not exists reopen_count int not null default 0;
comment on column public.tournaments.stats_snapshot is 'true = ปิดจ็อบด้วย t_close รุ่นที่เก็บ stats_applied (หักคืนได้ตรงตัว) · false = ปิดก่อนมีระบบนี้ (หักคืนโดยคำนวณจาก final_rank)';

-- ---------------------------------------------------------
-- หักสถิติที่เคยบวกตอนปิดจ็อบ (ใช้ร่วมกันระหว่าง t_reopen / t_reset)
-- ---------------------------------------------------------
create or replace function public.t_reverse_stats(p_tournament_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  t record; p record; s jsonb; v_uid uuid; v_rank int; v_played boolean;
  v_done jsonb := '[]'::jsonb;
begin
  select * into t from tournaments where id = p_tournament_id;
  if not found then raise exception 'ไม่พบงานแข่งนี้'; end if;
  if t.status <> 'finished' then return v_done; end if;

  for p in select * from tournament_players where tournament_id = t.id loop
    s := null;
    if t.stats_snapshot then
      s := p.stats_applied;
    elsif p.final_rank is not null then
      -- ปิดก่อนมีระบบนี้: คำนวณจากอันดับตอนปิด + เคยลงแข่งจริง (เหมือนเงื่อนไขใน t_close / t_finish)
      v_rank := p.final_rank;
      select exists (
        select 1 from tournament_matches m
         where m.tournament_id = t.id and m.status = 'complete' and not m.is_bye
           and (m.player1_id = p.id or m.player2_id = p.id)
      ) into v_played;
      if v_played then
        v_uid := null;
        if p.customer_id is not null then select id into v_uid from customers where id = p.customer_id; end if;
        if v_uid is null and p.discord_id is not null then select id into v_uid from customers where discord_id = p.discord_id limit 1; end if;
        if v_uid is not null then
          s := jsonb_build_object('target','customer','user_id',v_uid);
        elsif p.discord_id is not null and exists (select 1 from legacy_accounts where discord_id = p.discord_id) then
          s := jsonb_build_object('target','legacy','discord_id',p.discord_id);
        end if;
        if s is not null then
          s := s || jsonb_build_object('champion',(v_rank = 1)::int,'top3',(v_rank <= 3)::int,'top5',(v_rank <= 5)::int);
        end if;
      end if;
    end if;

    if s is null then continue; end if;

    if s->>'target' = 'customer' then
      update player_stats set
        duels    = greatest(0, duels - 1),
        champion = greatest(0, champion - coalesce((s->>'champion')::int,0)),
        top3     = greatest(0, top3 - coalesce((s->>'top3')::int,0)),
        top5     = greatest(0, top5 - coalesce((s->>'top5')::int,0)),
        updated_at = now()
      where user_id = (s->>'user_id')::uuid;
    elsif s->>'target' = 'legacy' then
      update legacy_accounts set
        duels    = greatest(0, duels - 1),
        champion = greatest(0, champion - coalesce((s->>'champion')::int,0)),
        top3     = greatest(0, top3 - coalesce((s->>'top3')::int,0)),
        top5     = greatest(0, top5 - coalesce((s->>'top5')::int,0))
      where discord_id = s->>'discord_id';
    end if;
    v_done := v_done || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'target', s->>'target');
  end loop;

  update tournament_players set stats_applied = null where tournament_id = t.id;
  return v_done;
end $$;

-- ---------------------------------------------------------
-- ปิดจ็อบ (รุ่นใหม่): เหมือนเดิม + เก็บ stats_applied + ใช้ประวัติแถวเดิมถ้าเคยปิดแล้ว
-- ---------------------------------------------------------
create or replace function public.t_close(
  p_tournament_id uuid, p_results jsonb, p_participants_list text, p_match_history text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  t record; r jsonb; p record; v_rank int; v_uid uuid;
  v_history uuid; v_done jsonb := '[]'::jsonb; v_skip jsonb := '[]'::jsonb;
  v_count int; v_stat jsonb;
begin
  select * into t from tournaments where id = p_tournament_id for update;
  if not found then raise exception 'ไม่พบงานแข่งนี้'; end if;
  if t.status = 'finished' then raise exception 'งานนี้ปิดจ็อบไปแล้ว'; end if;
  if t.status <> 'running' then raise exception 'งานนี้ยังไม่เริ่มแข่ง'; end if;
  if exists (select 1 from tournament_matches where tournament_id = t.id and status <> 'complete') then
    raise exception 'ยังมีแมตช์ที่ยังไม่กรอกผล';
  end if;

  select count(*) into v_count from tournament_players where tournament_id = t.id;

  -- เคยปิดแล้ว (เปิดงานใหม่มาแก้ผล) → เขียนทับประวัติแถวเดิม
  if t.history_id is not null then
    update tournament_history
       set tournament_name = t.name, participants_list = p_participants_list,
           match_history = p_match_history, player_count = v_count
     where id = t.history_id
    returning id into v_history;
  end if;
  if v_history is null then
    insert into tournament_history (tournament_name, participants_list, match_history, player_count)
    values (t.name, p_participants_list, p_match_history, v_count)
    returning id into v_history;
  end if;

  update tournament_players set stats_applied = null where tournament_id = t.id;

  for r in select value from jsonb_array_elements(coalesce(p_results,'[]'::jsonb)) loop
    select * into p from tournament_players where id = (r->>'player_id')::uuid and tournament_id = t.id;
    if not found then continue; end if;
    v_rank := (r->>'rank')::int;

    update tournament_players set final_rank = v_rank where id = p.id;

    if not coalesce((r->>'played')::boolean, false) then continue; end if;

    v_stat := jsonb_build_object('champion',(v_rank = 1)::int,'top3',(v_rank <= 3)::int,'top5',(v_rank <= 5)::int);

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
      update tournament_players
         set stats_applied = v_stat || jsonb_build_object('target','customer','user_id',v_uid)
       where id = p.id;
      v_done := v_done || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'rank', v_rank, 'target', 'customer');
    elsif p.discord_id is not null and exists (select 1 from legacy_accounts where discord_id = p.discord_id) then
      update legacy_accounts set
        duels = duels + 1,
        champion = champion + (v_rank = 1)::int,
        top3 = top3 + (v_rank <= 3)::int,
        top5 = top5 + (v_rank <= 5)::int,
        last_active = t.name
      where discord_id = p.discord_id;
      update tournament_players
         set stats_applied = v_stat || jsonb_build_object('target','legacy','discord_id',p.discord_id)
       where id = p.id;
      v_done := v_done || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'rank', v_rank, 'target', 'legacy');
    else
      v_skip := v_skip || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'rank', v_rank);
    end if;
  end loop;

  update tournaments
     set status = 'finished', finished_at = now(), history_id = v_history, round_ends_at = null,
         closed_v2 = true, stats_snapshot = true
   where id = t.id;

  return jsonb_build_object('history_id', v_history, 'recorded', v_done, 'skipped', v_skip);
end $$;

-- ---------------------------------------------------------
-- เปิดงานใหม่: finished → running (หักสถิติคืน ไม่แตะแต้ม/EXP)
-- ---------------------------------------------------------
create or replace function public.t_reopen(p_tournament_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare t record; v_rev jsonb;
begin
  select * into t from tournaments where id = p_tournament_id for update;
  if not found then raise exception 'ไม่พบงานแข่งนี้'; end if;
  if t.status <> 'finished' then raise exception 'เปิดงานใหม่ได้เฉพาะงานที่ปิดจ็อบแล้ว'; end if;

  v_rev := t_reverse_stats(t.id);

  update tournaments set
    status = 'running', finished_at = null, round_ends_at = null,
    -- ปิดด้วย t_finish เดิม = แจก EXP ไปพร้อมตอนปิดแล้ว → ตั้งเวลาแจกไว้ กันปุ่มแจก EXP โผล่มาแจกซ้ำ
    exp_awarded_at = case when not t.closed_v2 and t.give_exp then coalesce(t.exp_awarded_at, t.finished_at, now()) else t.exp_awarded_at end,
    closed_v2 = true,
    reopened_at = now(), reopen_count = t.reopen_count + 1
  where id = t.id;

  return jsonb_build_object('stats_reversed', v_rev);
end $$;

-- ---------------------------------------------------------
-- รีเซ็ตผลทั้งงาน: ลบทุกแมตช์ กลับไปเปิดรับสมัคร คงรายชื่อผู้เล่น (ไม่แตะแต้ม/EXP)
-- ---------------------------------------------------------
create or replace function public.t_reset(p_tournament_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare t record; v_rev jsonb := '[]'::jsonb; v_deleted int;
begin
  select * into t from tournaments where id = p_tournament_id for update;
  if not found then raise exception 'ไม่พบงานแข่งนี้'; end if;
  if t.status not in ('running','finished') then raise exception 'รีเซ็ตได้เฉพาะงานที่เริ่มแข่งแล้ว'; end if;

  if t.status = 'finished' then v_rev := t_reverse_stats(t.id); end if;

  delete from tournament_matches where tournament_id = t.id;
  get diagnostics v_deleted = row_count;

  update tournament_players
     set seed = null, dropped_at = null, played_all = true, final_rank = null, stats_applied = null
   where tournament_id = t.id;

  update tournaments set
    status = 'registration', current_round = 0, started_at = null, finished_at = null, round_ends_at = null,
    exp_awarded_at = case when t.status = 'finished' and not t.closed_v2 and t.give_exp then coalesce(t.exp_awarded_at, t.finished_at, now()) else t.exp_awarded_at end,
    closed_v2 = true,
    reopened_at = now(), reopen_count = t.reopen_count + 1
  where id = t.id;

  return jsonb_build_object('matches_deleted', v_deleted, 'stats_reversed', v_rev);
end $$;

revoke all on function public.t_reverse_stats(uuid) from public, anon, authenticated;
revoke all on function public.t_reopen(uuid) from public, anon, authenticated;
revoke all on function public.t_reset(uuid) from public, anon, authenticated;
revoke all on function public.t_close(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.t_reverse_stats(uuid) to service_role;
grant execute on function public.t_reopen(uuid) to service_role;
grant execute on function public.t_reset(uuid) to service_role;
grant execute on function public.t_close(uuid, jsonb, text, text) to service_role;
