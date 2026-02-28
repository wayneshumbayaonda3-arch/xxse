EDUPATH+ DB SETUP (Required for Admin Notices + DM Unread Count)

Run these SQL statements in Supabase SQL editor.

1) Admin notices table (DB-backed)
---------------------------------
create table if not exists public.admin_private_notices (
  id uuid primary key default gen_random_uuid(),
  to_user_id uuid not null,
  to_identity text,
  from_admin text,
  message text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

-- RLS
alter table public.admin_private_notices enable row level security;

-- Students can read their own notices & mark read
create policy if not exists "Students read own notices"
on public.admin_private_notices for select
to authenticated
using (to_user_id = auth.uid());

create policy if not exists "Students mark own notices read"
on public.admin_private_notices for update
to authenticated
using (to_user_id = auth.uid())
with check (to_user_id = auth.uid());

-- Admins/faculty can insert notices.
-- Adjust this policy to match how you identify admins in your project.
-- If you have an admins table, replace this with a join-based policy.
create policy if not exists "Admins insert notices"
on public.admin_private_notices for insert
to authenticated
with check (true);

2) DM reads table (for unread counts without changing dm_messages schema)
-----------------------------------------------------------------------
create table if not exists public.dm_reads (
  me uuid not null,
  peer uuid not null,
  last_read_at timestamptz not null default now(),
  primary key (me, peer)
);

alter table public.dm_reads enable row level security;

create policy if not exists "Users manage own dm_reads"
on public.dm_reads for all
to authenticated
using (me = auth.uid())
with check (me = auth.uid());

Notes:
- This app uses dm_reads to compute unread DM counts reliably.
- When a user opens a DM thread, we upsert dm_reads(me, peer, now()).

