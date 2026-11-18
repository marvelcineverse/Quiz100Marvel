-- ============================================================================
-- Quiz du Multivers : étape 1 (socle)
-- À coller dans Supabase > SQL Editor, puis "Run". Script rejouable.
--
-- Tous les objets sont préfixés "quiz_" : le script peut tourner dans un
-- projet existant (ex. Erreur404) sans toucher aux autres tables.
-- Pour tout supprimer à la fin : supabase/99_desinstaller.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Configuration (code admin). Aucune lecture possible depuis le navigateur.
-- ---------------------------------------------------------------------------
create table if not exists public.quiz_config (
  cle    text primary key,
  valeur text not null
);
alter table public.quiz_config enable row level security;

-- >>> CHOISIS TON CODE ADMIN ICI (modifiable ensuite depuis la page admin) <<<
insert into public.quiz_config (cle, valeur)
values ('code_admin', 'A_CHANGER')
on conflict (cle) do nothing;

create or replace function public.quiz_verifier_admin(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_code is null or not exists (
    select 1 from quiz_config where cle = 'code_admin' and valeur = p_code
  ) then
    raise exception 'Code admin invalide' using errcode = '28000';
  end if;
end;
$$;
revoke all on function public.quiz_verifier_admin(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Questions (une ligne = une ligne de l'onglet "Questions" du tableau)
-- Illisible depuis le navigateur : les bonnes réponses ne fuient pas.
-- ---------------------------------------------------------------------------
create table if not exists public.quiz_questions (
  id             text primary key,
  ordre          integer,
  phase_jeu      text,
  manche_zone    text,
  theme          text,
  programme      text,
  type           text,
  difficulte     text,
  question       text,
  bonne_reponse  text,
  mauvaise_1     text,
  mauvaise_2     text,
  mauvaise_3     text,
  media          text,
  source         text,
  statut         text,
  reserve        boolean not null default false,
  notes          text,
  manche_auto    integer,
  -- calculés automatiquement (trigger) :
  jouable        boolean not null default false,
  problemes      text[]  not null default '{}',
  -- suivi :
  modifie_admin  boolean not null default false,  -- corrigée dans l'appli
  retiree        boolean not null default false,  -- absente du dernier import
  cree_le        timestamptz not null default now(),
  maj_le         timestamptz not null default now()
);
alter table public.quiz_questions enable row level security;
-- (aucune policy : seul l'accès via les fonctions ci-dessous est possible)

create index if not exists quiz_questions_theme_idx on public.quiz_questions (theme);

-- Contrôle de chaque question : remplit "problemes" et "jouable".
create or replace function public.quiz_questions_controler()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_pb    text[] := '{}';
  v_props text[];
  v_type  text := lower(coalesce(new.type, ''));
begin
  -- nettoyage des espaces
  new.question      := nullif(btrim(new.question), '');
  new.bonne_reponse := nullif(btrim(new.bonne_reponse), '');
  new.mauvaise_1    := nullif(btrim(new.mauvaise_1), '');
  new.mauvaise_2    := nullif(btrim(new.mauvaise_2), '');
  new.mauvaise_3    := nullif(btrim(new.mauvaise_3), '');
  new.media         := nullif(btrim(new.media), '');

  if new.question is null then v_pb := array_append(v_pb, 'Question vide'); end if;
  if new.bonne_reponse is null then v_pb := array_append(v_pb, 'Bonne réponse vide'); end if;
  if new.mauvaise_1 is null or new.mauvaise_2 is null or new.mauvaise_3 is null then
    v_pb := array_append(v_pb, 'Il manque des mauvaises propositions (3 attendues)');
  end if;

  v_props := array_remove(array[
    lower(new.bonne_reponse), lower(new.mauvaise_1),
    lower(new.mauvaise_2), lower(new.mauvaise_3)], null);
  if cardinality(v_props) <> (select count(distinct p) from unnest(v_props) p) then
    v_pb := array_append(v_pb, 'Deux propositions identiques');
  end if;

  if (v_type like 'image%' or v_type like 'audio%' or v_type like 'vid%')
     and new.media is null then
    v_pb := array_append(v_pb, ('Type ' || new.type || ' sans URL de média'));
  end if;

  if new.retiree then v_pb := array_append(v_pb, 'Absente du dernier import'); end if;

  new.problemes := v_pb;
  new.jouable   := cardinality(v_pb) = 0;
  new.maj_le    := now();
  return new;
end;
$$;

drop trigger if exists quiz_questions_controle on public.quiz_questions;
create trigger quiz_questions_controle
before insert or update on public.quiz_questions
for each row execute function public.quiz_questions_controler();

-- ---------------------------------------------------------------------------
-- Fonctions admin (appelées depuis admin.html avec le code admin)
-- ---------------------------------------------------------------------------

-- Vérifie le code (connexion à la page admin)
create or replace function public.quiz_admin_connexion(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform quiz_verifier_admin(p_code);
  if p_code = 'A_CHANGER' then
    raise exception 'Choisis d''abord un vrai code admin dans le script SQL (ligne code_admin)';
  end if;
  return true;
end;
$$;

create or replace function public.quiz_admin_changer_code(p_code text, p_nouveau text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform quiz_verifier_admin(p_code);
  if length(coalesce(p_nouveau, '')) < 6 then
    raise exception 'Le nouveau code doit faire au moins 6 caractères';
  end if;
  update quiz_config set valeur = p_nouveau where cle = 'code_admin';
  return true;
end;
$$;

-- Liste complète des questions
create or replace function public.quiz_admin_questions(p_code text)
returns setof public.quiz_questions
language plpgsql
security definer
set search_path = public
as $$
begin
  perform quiz_verifier_admin(p_code);
  return query select * from quiz_questions order by retiree, ordre nulls last, id;
end;
$$;

-- Import : p_lignes = tableau JSON d'objets {id, phase_jeu, ...}
-- Les questions corrigées dans l'appli sont préservées, sauf si
-- p_ecraser_corrections = true. Les questions absentes du tableau sont
-- marquées "retirée" (jamais supprimées).
create or replace function public.quiz_admin_importer(
  p_code text,
  p_lignes jsonb,
  p_ecraser_corrections boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ligne      jsonb;
  v_q          quiz_questions;
  v_existante  quiz_questions;
  v_ids        text[] := '{}';
  v_inserees   int := 0;
  v_maj        int := 0;
  v_preservees int := 0;
  v_retirees   int := 0;
begin
  perform quiz_verifier_admin(p_code);
  if jsonb_typeof(p_lignes) <> 'array' then
    raise exception 'Format d''import invalide';
  end if;

  for v_ligne in select * from jsonb_array_elements(p_lignes) loop
    v_q := jsonb_populate_record(null::quiz_questions, v_ligne);
    v_q.id := nullif(btrim(v_q.id), '');
    continue when v_q.id is null;
    v_ids := array_append(v_ids, v_q.id);

    select * into v_existante from quiz_questions where id = v_q.id;

    if not found then
      insert into quiz_questions (
        id, ordre, phase_jeu, manche_zone, theme, programme, type, difficulte,
        question, bonne_reponse, mauvaise_1, mauvaise_2, mauvaise_3,
        media, source, statut, reserve, notes, manche_auto)
      values (
        v_q.id, v_q.ordre, v_q.phase_jeu, v_q.manche_zone, v_q.theme, v_q.programme,
        v_q.type, v_q.difficulte, v_q.question, v_q.bonne_reponse, v_q.mauvaise_1,
        v_q.mauvaise_2, v_q.mauvaise_3, v_q.media, v_q.source, v_q.statut,
        coalesce(v_q.reserve, false), v_q.notes, v_q.manche_auto);
      v_inserees := v_inserees + 1;

    elsif v_existante.modifie_admin and not p_ecraser_corrections then
      -- on garde la correction faite dans l'appli, on met juste l'ordre à jour
      update quiz_questions set ordre = v_q.ordre, retiree = false where id = v_q.id;
      v_preservees := v_preservees + 1;

    else
      update quiz_questions set
        ordre = v_q.ordre, phase_jeu = v_q.phase_jeu, manche_zone = v_q.manche_zone,
        theme = v_q.theme, programme = v_q.programme, type = v_q.type,
        difficulte = v_q.difficulte, question = v_q.question,
        bonne_reponse = v_q.bonne_reponse, mauvaise_1 = v_q.mauvaise_1,
        mauvaise_2 = v_q.mauvaise_2, mauvaise_3 = v_q.mauvaise_3, media = v_q.media,
        source = v_q.source, statut = v_q.statut, reserve = coalesce(v_q.reserve, false),
        notes = v_q.notes, manche_auto = v_q.manche_auto,
        modifie_admin = false, retiree = false
      where id = v_q.id;
      v_maj := v_maj + 1;
    end if;
  end loop;

  update quiz_questions set retiree = true
  where not retiree and not (id = any (v_ids));
  get diagnostics v_retirees = row_count;

  return jsonb_build_object(
    'inserees', v_inserees, 'mises_a_jour', v_maj,
    'preservees', v_preservees, 'retirees', v_retirees,
    'total', cardinality(v_ids));
end;
$$;

-- Correction manuelle d'une question depuis l'appli
create or replace function public.quiz_admin_modifier_question(
  p_code text, p_id text, p_champs jsonb
)
returns public.quiz_questions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_avant quiz_questions;
  v_r     quiz_questions;
begin
  perform quiz_verifier_admin(p_code);
  select * into v_avant from quiz_questions where id = p_id;
  if not found then raise exception 'Question % introuvable', p_id; end if;

  -- seuls les champs de contenu sont modifiables
  v_r := jsonb_populate_record(v_avant, p_champs - array[
    'id','jouable','problemes','modifie_admin','retiree','cree_le','maj_le','ordre']);

  update quiz_questions set
    phase_jeu = v_r.phase_jeu, manche_zone = v_r.manche_zone, theme = v_r.theme,
    programme = v_r.programme, type = v_r.type, difficulte = v_r.difficulte,
    question = v_r.question, bonne_reponse = v_r.bonne_reponse,
    mauvaise_1 = v_r.mauvaise_1, mauvaise_2 = v_r.mauvaise_2,
    mauvaise_3 = v_r.mauvaise_3, media = v_r.media, source = v_r.source,
    statut = v_r.statut, reserve = coalesce(v_r.reserve, false), notes = v_r.notes,
    manche_auto = v_r.manche_auto, modifie_admin = true
  where id = p_id
  returning * into v_r;
  return v_r;
end;
$$;

-- Droits : seules les fonctions "quiz_admin_*" sont appelables depuis le web
revoke all on public.quiz_config, public.quiz_questions from anon, authenticated;
grant execute on function
  public.quiz_admin_connexion(text),
  public.quiz_admin_changer_code(text, text),
  public.quiz_admin_questions(text),
  public.quiz_admin_importer(text, jsonb, boolean),
  public.quiz_admin_modifier_question(text, text, jsonb)
to anon, authenticated;
