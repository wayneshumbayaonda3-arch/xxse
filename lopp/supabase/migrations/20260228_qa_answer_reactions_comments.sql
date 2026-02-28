-- EDUPATH+ Q&A Answers: DB-backed Like/Dislike + Comments
-- Creates:
--  - public.qa_answer_reactions (answer_id, user_id, value)
--  - public.qa_answer_comments  (id, answer_id, author_id, body)
-- Works whether qa_answers.id is BIGINT or UUID.

create extension if not exists pgcrypto;

do $$
declare
  id_type text;
begin
  select data_type into id_type
  from information_schema.columns
  where table_schema='public' and table_name='qa_answers' and column_name='id';

  if id_type is null then
    raise exception 'qa_answers.id not found';
  end if;

  if id_type = 'bigint' then
    execute $q$
      create table if not exists public.qa_answer_reactions (
        answer_id bigint not null references public.qa_answers(id) on delete cascade,
        user_id uuid not null references auth.users(id) on delete cascade,
        value int not null check (value in (-1,1)),
        created_at timestamptz not null default now(),
        primary key(answer_id, user_id)
      );

      create table if not exists public.qa_answer_comments (
        id uuid primary key default gen_random_uuid(),
        answer_id bigint not null references public.qa_answers(id) on delete cascade,
        author_id uuid not null references auth.users(id) on delete cascade,
        body text not null,
        created_at timestamptz not null default now()
      );
    $q$;
  else
    -- default to uuid
    execute $q$
      create table if not exists public.qa_answer_reactions (
        answer_id uuid not null references public.qa_answers(id) on delete cascade,
        user_id uuid not null references auth.users(id) on delete cascade,
        value int not null check (value in (-1,1)),
        created_at timestamptz not null default now(),
        primary key(answer_id, user_id)
      );

      create table if not exists public.qa_answer_comments (
        id uuid primary key default gen_random_uuid(),
        answer_id uuid not null references public.qa_answers(id) on delete cascade,
        author_id uuid not null references auth.users(id) on delete cascade,
        body text not null,
        created_at timestamptz not null default now()
      );
    $q$;
  end if;
end $$;

-- Indexes
create index if not exists idx_qa_ans_react_answer on public.qa_answer_reactions(answer_id);
create index if not exists idx_qa_ans_comm_answer on public.qa_answer_comments(answer_id, created_at);

-- RLS
alter table public.qa_answer_reactions enable row level security;
alter table public.qa_answer_comments enable row level security;

drop policy if exists qa_answer_reactions_read on public.qa_answer_reactions;
create policy qa_answer_reactions_read
on public.qa_answer_reactions
for select to authenticated
using (true);

drop policy if exists qa_answer_reactions_write_self on public.qa_answer_reactions;
create policy qa_answer_reactions_write_self
on public.qa_answer_reactions
for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists qa_answer_comments_read on public.qa_answer_comments;
create policy qa_answer_comments_read
on public.qa_answer_comments
for select to authenticated
using (true);

drop policy if exists qa_answer_comments_insert_self on public.qa_answer_comments;
create policy qa_answer_comments_insert_self
on public.qa_answer_comments
for insert to authenticated
with check (author_id = auth.uid());

drop policy if exists qa_answer_comments_delete_self on public.qa_answer_comments;
create policy qa_answer_comments_delete_self
on public.qa_answer_comments
for delete to authenticated
using (author_id = auth.uid());
