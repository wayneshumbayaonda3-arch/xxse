-- EDUPATH+ Q&A feed fix: make qa_question_stats a LIVE view that always includes new questions
-- Safe to run even if some optional tables (qa_votes/qa_comments/student_profiles) do not exist.

do $$
declare
  has_votes boolean;
  has_comments boolean;
  has_profiles boolean;
  ddl text;
begin
  -- Drop legacy objects if present
  if exists (select 1 from pg_matviews where schemaname='public' and matviewname='qa_question_stats') then
    execute 'drop materialized view public.qa_question_stats';
  end if;

  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='qa_question_stats') then
    -- Could be a table (legacy). Drop it.
    execute 'drop table public.qa_question_stats';
  end if;

  execute 'drop view if exists public.qa_question_stats';

  select exists(
    select 1 from information_schema.tables
    where table_schema='public' and table_name='qa_votes'
  ) into has_votes;

  select exists(
    select 1 from information_schema.tables
    where table_schema='public' and table_name='qa_comments'
  ) into has_comments;

  select exists(
    select 1 from information_schema.tables
    where table_schema='public' and table_name='student_profiles'
  ) into has_profiles;

  ddl := 'create view public.qa_question_stats as ' ||
         'select q.*, ';

  if has_profiles then
    ddl := ddl || 'coalesce(sp.name, ''Student'') as author_name, ';
  else
    ddl := ddl || '''Student''::text as author_name, ';
  end if;

  if has_votes then
    ddl := ddl || 'coalesce(v.vote_sum, 0)::int as vote_sum, ';
  else
    ddl := ddl || '0::int as vote_sum, ';
  end if;

  if has_comments then
    ddl := ddl || 'coalesce(c.comment_count, 0)::int as comment_count, ';
  else
    ddl := ddl || '0::int as comment_count, ';
  end if;

  ddl := ddl || '(coalesce(';
  if has_votes then ddl := ddl || 'v.vote_sum'; else ddl := ddl || '0'; end if;
  ddl := ddl || ',0) + coalesce(';
  if has_comments then ddl := ddl || 'c.comment_count'; else ddl := ddl || '0'; end if;
  ddl := ddl || ',0))::int as interactions ' ||
         'from public.qa_questions q ';

  if has_votes then
    ddl := ddl || 'left join (select question_id, sum(value) as vote_sum from public.qa_votes group by question_id) v on v.question_id = q.id ';
  end if;
  if has_comments then
    ddl := ddl || 'left join (select question_id, count(*) as comment_count from public.qa_comments group by question_id) c on c.question_id = q.id ';
  end if;
  if has_profiles then
    -- Support both schemas: student_profiles.auth_user_id or student_profiles.user_id
    ddl := ddl || 'left join public.student_profiles sp on (sp.auth_user_id = q.author_id or sp.auth_user_id = q.auth_user_id) ';
  end if;

  execute ddl;

  -- Best-effort grants (RLS still applies on base tables)
  begin
    execute 'grant select on public.qa_question_stats to authenticated';
  exception when others then
    null;
  end;
end $$;
