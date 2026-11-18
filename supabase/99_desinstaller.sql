-- ============================================================================
-- Quiz du Multivers : suppression complète (après le live)
-- Supprime uniquement les objets préfixés "quiz_". Irréversible.
-- ============================================================================
do $$
declare r record;
begin
  for r in
    select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'quiz\_%'
  loop
    execute format('drop function if exists %I.%I(%s) cascade', r.nspname, r.proname, r.args);
  end loop;

  for r in
    select tablename from pg_tables
    where schemaname = 'public' and tablename like 'quiz\_%'
  loop
    execute format('drop table if exists public.%I cascade', r.tablename);
  end loop;
end;
$$;
