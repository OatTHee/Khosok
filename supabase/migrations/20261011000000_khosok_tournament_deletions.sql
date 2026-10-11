-- =========================================================
-- บันทึกการลบห้องแข่ง (ห้องถูกลบถาวร → tournament_audit ของห้องนั้นหายตาม cascade
-- จึงต้องเก็บสรุปไว้ตารางแยก) — ลบแล้วกู้คืนไม่ได้
-- ห้องที่ปิดจ็อบแล้ว: ไม่ถอยสถิติผู้เล่น และไม่ลบ tournament_history (เก็บไว้เป็นประวัติ)
-- =========================================================
create table if not exists public.tournament_deletions (
  id bigint generated always as identity primary key,
  tournament_id uuid not null,
  code int,
  name text,
  status text,
  format text,
  player_count int,
  match_count int,
  history_id uuid,
  reason text check (reason is null or length(reason) <= 500),
  actor_id text,
  actor_name text,
  snapshot jsonb,
  deleted_at timestamptz not null default now()
);
create index if not exists tournament_deletions_deleted_at_idx on public.tournament_deletions (deleted_at desc);
alter table public.tournament_deletions enable row level security;
revoke all on public.tournament_deletions from anon, authenticated;
grant all on public.tournament_deletions to service_role;
