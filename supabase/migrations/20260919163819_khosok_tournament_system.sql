-- =========================================================
-- ระบบทัวร์นาเมนต์ของ Khosok (แทน Challonge)
-- เขียน/อ่านผ่านเซิร์ฟเวอร์บอท (service_role) เท่านั้น
-- (ใช้กับ Supabase โปรเจกต์ DMT Shop ไปแล้วเมื่อ 2026-09-19 — ไฟล์นี้เก็บไว้เป็นหลักฐาน)
-- =========================================================
create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  code serial unique,
  name text not null check (length(trim(name)) > 0),
  format text not null default 'swiss' check (format in ('swiss','single_elim')),
  status text not null default 'registration' check (status in ('registration','running','finished','cancelled')),
  swiss_rounds int check (swiss_rounds is null or swiss_rounds between 1 and 20),
  current_round int not null default 0,
  round_minutes int not null default 40 check (round_minutes between 1 and 240),
  round_ends_at timestamptz,
  start_at timestamptz,
  discord_channel_id text,
  setup_message_id text,
  current_message_id text,
  points_awarded_at timestamptz,
  history_id uuid references public.tournament_history(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
comment on table public.tournaments is 'งานแข่งของระบบทัวร์นาเมนต์ Khosok (แทน Challonge) code = เลขสั้นใช้กับ !setup';

create table public.tournament_players (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  customer_id uuid references public.customers(id),
  discord_id text,
  display_name text not null check (length(trim(display_name)) > 0),
  seed int,
  dropped_at timestamptz,
  played_all boolean not null default true,
  final_rank int,
  created_at timestamptz not null default now(),
  unique (tournament_id, discord_id),
  unique (tournament_id, customer_id)
);
create index on public.tournament_players (tournament_id);
comment on column public.tournament_players.customer_id is 'null = walk-in หรือยังไม่ได้ claim บัญชี (จะหาจาก discord_id ตอนแจกรางวัล)';

create table public.tournament_matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  round int not null check (round >= 1),
  slot int not null check (slot >= 1),
  player1_id uuid references public.tournament_players(id) on delete cascade,
  player2_id uuid references public.tournament_players(id) on delete cascade,
  winner_id uuid references public.tournament_players(id) on delete set null,
  score1 int,
  score2 int,
  is_bye boolean not null default false,
  forfeit_player_id uuid references public.tournament_players(id) on delete set null,
  status text not null default 'open' check (status in ('pending','open','complete')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tournament_id, round, slot)
);
create index on public.tournament_matches (tournament_id);
comment on column public.tournament_matches.slot is 'Swiss = เลขโต๊ะ, แพ้คัดออก = ตำแหน่งในสาย (ผู้ชนะไป slot ceil(slot/2) ของรอบถัดไป)';

alter table public.tournaments enable row level security;
alter table public.tournament_players enable row level security;
alter table public.tournament_matches enable row level security;
revoke all on public.tournaments, public.tournament_players, public.tournament_matches from anon, authenticated;
revoke all on sequence public.tournaments_code_seq from anon, authenticated;

create or replace function public.t_wallet_apply(
  p_customer_id uuid, p_discord_id text, p_points int, p_exp int, p_reason text, p_ref uuid
) returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid := p_customer_id;
begin
  if v_id is null and p_discord_id is not null then
    select id into v_id from customers where discord_id = p_discord_id limit 1;
  end if;

  if v_id is not null then
    update customers
       set points = coalesce(points,0) + coalesce(p_points,0),
           exp    = coalesce(exp,0)    + coalesce(p_exp,0)
     where id = v_id;
    if not found then return 'skipped'; end if;
    update wallet_transactions
       set reason = p_reason, ref_type = 'tournament', ref_id = p_ref
     where user_id = v_id and ref_type = 'manual' and created_at = now();
    return 'customer';
  end if;

  if p_discord_id is not null and exists (select 1 from legacy_accounts where discord_id = p_discord_id) then
    update legacy_accounts
       set points = points + coalesce(p_points,0), exp = exp + coalesce(p_exp,0)
     where discord_id = p_discord_id;
    return 'legacy';
  end if;

  return 'skipped';
end $$;

create or replace function public.t_award_points(p_tournament_id uuid, p_awards jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  t record; a jsonb; p record; v_res text; v_pts int;
  v_done jsonb := '[]'::jsonb; v_skip jsonb := '[]'::jsonb;
begin
  select * into t from tournaments where id = p_tournament_id for update;
  if not found then raise exception 'ไม่พบงานแข่งนี้'; end if;
  if t.status not in ('running','finished') then raise exception 'งานนี้ยังไม่เริ่มแข่ง'; end if;
  if t.points_awarded_at is not null then raise exception 'งานนี้แจกแต้มไปแล้ว'; end if;

  for a in select value from jsonb_array_elements(coalesce(p_awards,'[]'::jsonb)) loop
    v_pts := coalesce((a->>'points')::int, 0);
    if v_pts <= 0 then continue; end if;
    select * into p from tournament_players where id = (a->>'player_id')::uuid and tournament_id = p_tournament_id;
    if not found then continue; end if;
    v_res := t_wallet_apply(p.customer_id, p.discord_id, v_pts, 0,
               'แต้มทัวร์นาเมนต์: ' || t.name || ' (อันดับ ' || coalesce(a->>'rank','-') || ')', t.id);
    if v_res = 'skipped' then
      v_skip := v_skip || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'points', v_pts);
    else
      v_done := v_done || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'points', v_pts, 'target', v_res);
    end if;
  end loop;

  update tournaments set points_awarded_at = now() where id = t.id;
  return jsonb_build_object('awarded', v_done, 'skipped', v_skip);
end $$;

create or replace function public.t_finish(
  p_tournament_id uuid, p_results jsonb, p_participants_list text, p_match_history text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  t record; r jsonb; p record; v_res text; v_exp int; v_rank int; v_uid uuid;
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
    v_exp  := coalesce((r->>'exp')::int, 0);

    update tournament_players
       set final_rank = v_rank, played_all = coalesce((r->>'played_all')::boolean, played_all)
     where id = p.id;

    if v_exp <= 0 or not coalesce((r->>'played')::boolean, false) then continue; end if;

    v_res := t_wallet_apply(p.customer_id, p.discord_id, 0, v_exp,
               'จบทัวร์นาเมนต์: ' || t.name || ' (อันดับ ' || v_rank || ')', t.id);

    if v_res = 'customer' then
      v_uid := p.customer_id;
      if v_uid is null then select id into v_uid from customers where discord_id = p.discord_id limit 1; end if;
      insert into player_stats (user_id, duels, champion, top3, top5, last_active, updated_at)
      values (v_uid, 1, (v_rank = 1)::int, (v_rank <= 3)::int, (v_rank <= 5)::int, t.name, now())
      on conflict (user_id) do update set
        duels = player_stats.duels + 1,
        champion = player_stats.champion + (v_rank = 1)::int,
        top3 = player_stats.top3 + (v_rank <= 3)::int,
        top5 = player_stats.top5 + (v_rank <= 5)::int,
        last_active = t.name, updated_at = now();
      v_done := v_done || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'exp', v_exp, 'rank', v_rank, 'target', v_res);
    elsif v_res = 'legacy' then
      update legacy_accounts set
        duels = duels + 1,
        champion = champion + (v_rank = 1)::int,
        top3 = top3 + (v_rank <= 3)::int,
        top5 = top5 + (v_rank <= 5)::int,
        last_active = t.name
      where discord_id = p.discord_id;
      v_done := v_done || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'exp', v_exp, 'rank', v_rank, 'target', v_res);
    else
      v_skip := v_skip || jsonb_build_object('player_id', p.id, 'name', p.display_name, 'exp', v_exp, 'rank', v_rank);
    end if;
  end loop;

  update tournaments
     set status = 'finished', finished_at = now(), history_id = v_history, round_ends_at = null
   where id = t.id;

  return jsonb_build_object('history_id', v_history, 'awarded', v_done, 'skipped', v_skip);
end $$;

revoke all on function public.t_wallet_apply(uuid, text, int, int, text, uuid) from public, anon, authenticated;
revoke all on function public.t_award_points(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.t_finish(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.t_wallet_apply(uuid, text, int, int, text, uuid) to service_role;
grant execute on function public.t_award_points(uuid, jsonb) to service_role;
grant execute on function public.t_finish(uuid, jsonb, text, text) to service_role;
