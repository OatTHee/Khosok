-- สตาฟจัดทัวร์ (แต่งตั้งโดยแอดมิน DMT Shop ผ่านเว็บจัดทัวร์) ระบุตัวด้วย Discord ID
create table public.tournament_staff (
  discord_id text primary key check (discord_id ~ '^[0-9]{17,20}$'),
  note text,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
comment on table public.tournament_staff is 'สตาฟที่จัดการทัวร์ได้ (ไม่ใช่แอดมินร้าน) แอดมินร้านเพิ่ม/ลบผ่านเว็บจัดทัวร์';
alter table public.tournament_staff enable row level security;
revoke all on public.tournament_staff from anon, authenticated;
