-- ============================================================================
-- Quiz du Multivers : étape 2 (partie, joueurs, viewers, Phase 1)
-- À coller dans Supabase > SQL Editor APRÈS 01_socle.sql, puis "Run".
-- Script rejouable (ne supprime aucune donnée).
--
-- Temps réel : chaque changement d'état est diffusé par la base elle-même
-- (realtime.send) sur deux canaux publics :
--   quiz-plateau : admin, joueurs, écran de diffusion (tous les changements)
--   quiz-public  : viewers (uniquement ouverture / révélation / lancement)
-- Les viewers reçoivent donc ~3 messages par question.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.quiz_parties (
  id            uuid primary key default gen_random_uuid(),
  code          text not null,                       -- code donné aux joueurs
  statut        text not null default 'lobby' check (statut in ('lobby','en_cours','terminee')),
  ecran         text not null default 'question' check (ecran in ('question','classement')),
  tour_courant  bigint,
  duree_viewers integer not null default 15,
  version       integer not null default 0,
  cree_le       timestamptz not null default now()
);

create table if not exists public.quiz_joueurs (
  id         uuid primary key default gen_random_uuid(),
  partie_id  uuid not null references public.quiz_parties on delete cascade,
  nom        text not null,
  ordre      integer not null,
  jeton      uuid not null default gen_random_uuid() unique,
  score      integer not null default 0,
  rejoint_le timestamptz not null default now(),
  unique (partie_id, nom)
);

create table if not exists public.quiz_viewers (
  id         uuid primary key default gen_random_uuid(),
  partie_id  uuid not null references public.quiz_parties on delete cascade,
  pseudo     text not null,
  equipe     uuid references public.quiz_joueurs on delete set null,
  jeton      uuid not null default gen_random_uuid() unique,
  score      integer not null default 0,
  rejoint_le timestamptz not null default now()
);
create index if not exists quiz_viewers_equipe_idx on public.quiz_viewers (partie_id, equipe);

create table if not exists public.quiz_tours (
  id            bigserial primary key,
  partie_id     uuid not null references public.quiz_parties on delete cascade,
  numero        integer not null,
  question_id   text references public.quiz_questions on delete set null,
  categorie     text not null,
  manche        integer,
  points        integer not null,
  question      text not null,
  type          text,
  media         text,
  propositions  jsonb not null,      -- 4 textes, ordre mélangé
  bonne_index   integer not null,    -- 0..3, jamais envoyé avant la révélation
  etape         text not null default 'question' check (etape in ('question','fermee','revelee')),
  gagnant_id    uuid,                -- Éclair / départage : premier juste
  ouverte_le    timestamptz not null default clock_timestamp(),
  fin_viewers   timestamptz not null,
  fermee_le     timestamptz,
  revelee_le    timestamptz
);
create index if not exists quiz_tours_partie_idx on public.quiz_tours (partie_id);

create table if not exists public.quiz_reponses_joueurs (
  tour_id    bigint not null references public.quiz_tours on delete cascade,
  joueur_id  uuid not null references public.quiz_joueurs on delete cascade,
  choix      integer not null check (choix between 0 and 3),
  repondu_le timestamptz not null default clock_timestamp(),
  temps_ms   integer,
  correct    boolean,
  points     integer not null default 0,
  primary key (tour_id, joueur_id)
);

create table if not exists public.quiz_reponses_viewers (
  tour_id    bigint not null references public.quiz_tours on delete cascade,
  viewer_id  uuid not null references public.quiz_viewers on delete cascade,
  choix      integer not null check (choix between 0 and 3),
  repondu_le timestamptz not null default clock_timestamp(),
  correct    boolean,
  points     integer not null default 0,
  primary key (tour_id, viewer_id)
);

alter table public.quiz_parties          enable row level security;
alter table public.quiz_joueurs          enable row level security;
alter table public.quiz_viewers          enable row level security;
alter table public.quiz_tours            enable row level security;
alter table public.quiz_reponses_joueurs enable row level security;
alter table public.quiz_reponses_viewers enable row level security;
revoke all on public.quiz_parties, public.quiz_joueurs, public.quiz_viewers, public.quiz_tours,
  public.quiz_reponses_joueurs, public.quiz_reponses_viewers from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Outils internes
-- ---------------------------------------------------------------------------
create or replace function public.quiz_partie_active()
returns uuid language sql stable security definer set search_path = public as $$
  select id from quiz_parties where statut <> 'terminee' order by cree_le desc limit 1;
$$;

-- "Manche / Zone" du tableau -> catégorie de jeu
create or replace function public.quiz_categorie(p_zone text, p_phase text)
returns text language sql immutable as $$
  select case
    when z like 'eclair%'   then 'eclair'
    when z like 'ident%'    then 'identification'
    when z like 'point%'    then 'pointue'
    when z like 'variante%' then 'variante'
    when z like 'depart%' or ph like 'depart%' then 'departage'
    else 'autre' end
  from (select translate(lower(btrim(coalesce(p_zone, ''))), 'éèêëàâîïôûùç', 'eeeeaaiiouuc') as z,
               translate(lower(btrim(coalesce(p_phase, ''))), 'éèêëàâîïôûùç', 'eeeeaaiiouuc') as ph) s;
$$;

create or replace function public.quiz_points_categorie(p_categorie text)
returns integer language sql immutable as $$
  select case p_categorie
    when 'eclair' then 1 when 'identification' then 2
    when 'pointue' then 3 when 'variante' then 3
    when 'departage' then 0 else 1 end;
$$;

-- État public (sans bonne réponse avant révélation)
create or replace function public.quiz_etat_json(p_partie uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  p quiz_parties;
  t quiz_tours;
  v jsonb;
begin
  select * into p from quiz_parties where id = p_partie;
  if not found then
    return jsonb_build_object('version', 0, 'maintenant', clock_timestamp(), 'partie', null, 'joueurs', '[]'::jsonb, 'tour', null);
  end if;

  v := jsonb_build_object(
    'version', p.version,
    'maintenant', clock_timestamp(),
    'partie', jsonb_build_object('id', p.id, 'statut', p.statut, 'ecran', p.ecran, 'duree_viewers', p.duree_viewers),
    'joueurs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', j.id, 'nom', j.nom, 'ordre', j.ordre, 'score', j.score,
        'nb_viewers', (select count(*) from quiz_viewers w where w.partie_id = p.id and w.equipe = j.id))
        order by j.ordre)
      from quiz_joueurs j where j.partie_id = p.id), '[]'::jsonb),
    'nb_viewers', (select count(*) from quiz_viewers where partie_id = p.id),
    'tour', null);

  select * into t from quiz_tours where id = p.tour_courant;
  if found then
    v := jsonb_set(v, '{tour}', jsonb_build_object(
      'id', t.id, 'numero', t.numero, 'categorie', t.categorie, 'manche', t.manche,
      'points', t.points, 'question', t.question, 'type', t.type, 'media', t.media,
      'propositions', t.propositions, 'etape', t.etape,
      'ouverte_le', t.ouverte_le, 'fin_viewers', t.fin_viewers,
      'ont_repondu', coalesce((select jsonb_agg(joueur_id) from quiz_reponses_joueurs where tour_id = t.id), '[]'::jsonb)));
    if t.etape = 'revelee' then
      v := jsonb_set(v, '{tour,bonne_index}', to_jsonb(t.bonne_index));
      v := jsonb_set(v, '{tour,gagnant_id}', coalesce(to_jsonb(t.gagnant_id), 'null'::jsonb));
      v := jsonb_set(v, '{tour,reponses}', coalesce((
        select jsonb_agg(jsonb_build_object('joueur_id', joueur_id, 'choix', choix, 'correct', correct,
                                            'points', points, 'temps_ms', temps_ms))
        from quiz_reponses_joueurs where tour_id = t.id), '[]'::jsonb));
      v := jsonb_set(v, '{tour,stats_viewers}', (
        select jsonb_build_array(
          count(*) filter (where choix = 0), count(*) filter (where choix = 1),
          count(*) filter (where choix = 2), count(*) filter (where choix = 3))
        from quiz_reponses_viewers where tour_id = t.id));
    end if;
  end if;
  return v;
end;
$$;

-- Incrémente la version et diffuse l'état. Ne bloque jamais le jeu :
-- si le temps réel échoue, les écrans se resynchronisent par interrogation.
create or replace function public.quiz_diffuser(p_partie uuid, p_viewers boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  update quiz_parties set version = version + 1 where id = p_partie;
  v := quiz_etat_json(p_partie);
  begin
    perform realtime.send(v, 'etat', 'quiz-plateau', false);
    if p_viewers then
      perform realtime.send(v, 'etat', 'quiz-public', false);
    end if;
  exception when others then
    raise notice 'Diffusion temps réel impossible : %', sqlerrm;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lecture publique de l'état (chargement initial / secours)
-- ---------------------------------------------------------------------------
create or replace function public.quiz_etat()
returns jsonb language sql stable security definer set search_path = public as $$
  select quiz_etat_json(quiz_partie_active());
$$;

-- ---------------------------------------------------------------------------
-- Joueurs
-- ---------------------------------------------------------------------------
create or replace function public.quiz_joueur_rejoindre(p_code text, p_nom text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_partie quiz_parties;
  v_nom    text := left(btrim(coalesce(p_nom, '')), 20);
  v_j      quiz_joueurs;
begin
  select * into v_partie from quiz_parties
  where id = quiz_partie_active() and upper(code) = upper(btrim(coalesce(p_code, '')));
  if not found then raise exception 'Code de partie inconnu'; end if;
  if v_partie.statut <> 'lobby' then raise exception 'La partie a déjà commencé : demande à l''admin'; end if;
  if v_nom = '' then raise exception 'Choisis un nom'; end if;
  if exists (select 1 from quiz_joueurs where partie_id = v_partie.id and lower(nom) = lower(v_nom)) then
    raise exception 'Ce nom est déjà pris';
  end if;
  if (select count(*) from quiz_joueurs where partie_id = v_partie.id) >= 5 then
    raise exception 'La partie est complète (5 joueurs)';
  end if;

  insert into quiz_joueurs (partie_id, nom, ordre)
  values (v_partie.id, v_nom,
          coalesce((select max(ordre) from quiz_joueurs where partie_id = v_partie.id), 0) + 1)
  returning * into v_j;

  perform quiz_diffuser(v_partie.id, true);
  return jsonb_build_object('jeton', v_j.jeton, 'id', v_j.id, 'nom', v_j.nom);
end;
$$;

-- Infos privées du joueur : identité + sa réponse à la question en cours
create or replace function public.quiz_joueur_moi(p_jeton uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_j quiz_joueurs;
  v_p quiz_parties;
  v_r quiz_reponses_joueurs;
begin
  select * into v_j from quiz_joueurs where jeton = p_jeton;
  if not found then raise exception 'Joueur inconnu'; end if;
  select * into v_p from quiz_parties where id = v_j.partie_id;
  if v_p.statut = 'terminee' then raise exception 'Partie terminée'; end if;
  select * into v_r from quiz_reponses_joueurs where joueur_id = v_j.id and tour_id = v_p.tour_courant;
  return jsonb_build_object('id', v_j.id, 'nom', v_j.nom, 'score', v_j.score,
    'tour_id', v_p.tour_courant, 'choix', v_r.choix);
end;
$$;

create or replace function public.quiz_joueur_repondre(p_jeton uuid, p_tour bigint, p_choix integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_j   quiz_joueurs;
  v_t   quiz_tours;
  v_nb  integer;
begin
  select * into v_j from quiz_joueurs where jeton = p_jeton;
  if not found then raise exception 'Joueur inconnu'; end if;
  select * into v_t from quiz_tours where id = p_tour for update;
  if not found or v_t.id is distinct from (select tour_courant from quiz_parties where id = v_j.partie_id) then
    raise exception 'Cette question n''est plus en cours';
  end if;
  if v_t.etape <> 'question' then raise exception 'Les réponses sont fermées'; end if;
  if p_choix not between 0 and 3 then raise exception 'Choix invalide'; end if;

  insert into quiz_reponses_joueurs (tour_id, joueur_id, choix, temps_ms)
  values (v_t.id, v_j.id, p_choix,
          (extract(epoch from clock_timestamp() - v_t.ouverte_le) * 1000)::int)
  on conflict do nothing;
  if not found then raise exception 'Tu as déjà répondu'; end if;

  -- tout le monde a répondu : fermeture automatique
  select count(*) into v_nb from quiz_joueurs j
  where j.partie_id = v_j.partie_id
    and not exists (select 1 from quiz_reponses_joueurs r where r.tour_id = v_t.id and r.joueur_id = j.id);
  if v_nb = 0 then
    update quiz_tours set etape = 'fermee', fermee_le = clock_timestamp() where id = v_t.id;
  end if;

  perform quiz_diffuser(v_j.partie_id, false);
  return jsonb_build_object('choix', p_choix);
end;
$$;

-- ---------------------------------------------------------------------------
-- Viewers
-- ---------------------------------------------------------------------------
-- Équipe la moins fournie (égalité : au hasard). Appelée sous verrou.
create or replace function public.quiz_equipe_libre(p_partie uuid)
returns uuid language sql volatile security definer set search_path = public as $$
  select j.id from quiz_joueurs j
  where j.partie_id = p_partie
  order by (select count(*) from quiz_viewers w where w.partie_id = p_partie and w.equipe = j.id), random()
  limit 1;
$$;

-- Rejoindre, ou se reconnecter avec son jeton
create or replace function public.quiz_viewer_rejoindre(p_pseudo text, p_jeton uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_partie uuid := quiz_partie_active();
  v_statut text;
  v_w      quiz_viewers;
  v_pseudo text := left(btrim(coalesce(p_pseudo, '')), 24);
  v_choix  integer;
begin
  if v_partie is null then raise exception 'Aucune partie en cours'; end if;
  select statut into v_statut from quiz_parties where id = v_partie;

  if p_jeton is not null then
    select * into v_w from quiz_viewers where jeton = p_jeton and partie_id = v_partie;
  end if;

  if v_w.id is null then
    if v_pseudo = '' then raise exception 'Choisis un pseudo'; end if;
    insert into quiz_viewers (partie_id, pseudo) values (v_partie, v_pseudo) returning * into v_w;
  end if;

  -- affectation d'équipe dès que la partie est lancée
  if v_w.equipe is null and v_statut = 'en_cours' then
    perform pg_advisory_xact_lock(hashtext('quiz_equipes'));
    update quiz_viewers set equipe = quiz_equipe_libre(v_partie) where id = v_w.id returning * into v_w;
  end if;

  select r.choix into v_choix from quiz_reponses_viewers r
  where r.viewer_id = v_w.id and r.tour_id = (select tour_courant from quiz_parties where id = v_partie);

  return jsonb_build_object(
    'jeton', v_w.jeton, 'id', v_w.id, 'pseudo', v_w.pseudo, 'score', v_w.score,
    'equipe', v_w.equipe, 'equipe_nom', (select nom from quiz_joueurs where id = v_w.equipe),
    'choix', v_choix);
end;
$$;

create or replace function public.quiz_viewer_voter(p_jeton uuid, p_tour bigint, p_choix integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_w quiz_viewers;
  v_t quiz_tours;
begin
  select * into v_w from quiz_viewers where jeton = p_jeton;
  if not found then raise exception 'Viewer inconnu'; end if;
  select * into v_t from quiz_tours where id = p_tour;
  if not found or v_t.partie_id <> v_w.partie_id then raise exception 'Question inconnue'; end if;
  if v_t.etape = 'revelee' or clock_timestamp() > v_t.fin_viewers + interval '1.5 seconds' then
    raise exception 'Temps écoulé';
  end if;
  if p_choix not between 0 and 3 then raise exception 'Choix invalide'; end if;
  insert into quiz_reponses_viewers (tour_id, viewer_id, choix) values (v_t.id, v_w.id, p_choix)
  on conflict do nothing;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------
create or replace function public.quiz_admin_etat(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_partie uuid := quiz_partie_active();
  v_t      quiz_tours;
  v        jsonb;
begin
  perform quiz_verifier_admin(p_code);
  v := quiz_etat_json(v_partie);
  if v_partie is null then return v; end if;

  v := v || jsonb_build_object(
    'code', (select code from quiz_parties where id = v_partie),
    'questions_jouees', coalesce((select jsonb_agg(question_id) from quiz_tours where partie_id = v_partie and question_id is not null), '[]'::jsonb));

  select t.* into v_t from quiz_tours t join quiz_parties p on p.tour_courant = t.id where p.id = v_partie;
  if found then
    v := jsonb_set(v, '{tour,bonne_index}', to_jsonb(v_t.bonne_index));
    v := jsonb_set(v, '{tour,question_id}', to_jsonb(v_t.question_id));
    v := jsonb_set(v, '{tour,reponses}', coalesce((
      select jsonb_agg(jsonb_build_object('joueur_id', joueur_id, 'choix', choix, 'temps_ms', temps_ms,
                                          'correct', coalesce(correct, choix = v_t.bonne_index), 'points', points)
                       order by repondu_le)
      from quiz_reponses_joueurs where tour_id = v_t.id), '[]'::jsonb));
    v := jsonb_set(v, '{tour,stats_viewers}', (
      select jsonb_build_array(
        count(*) filter (where choix = 0), count(*) filter (where choix = 1),
        count(*) filter (where choix = 2), count(*) filter (where choix = 3))
      from quiz_reponses_viewers where tour_id = v_t.id));
  end if;
  return v;
end;
$$;

create or replace function public.quiz_admin_nouvelle_partie(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_code text;
  v_id   uuid;
begin
  perform quiz_verifier_admin(p_code);
  update quiz_parties set statut = 'terminee' where statut <> 'terminee';
  -- 4 lettres sans caractères ambigus
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ', (random() * 23)::int + 1, 1), '')
    into v_code from generate_series(1, 4);
  insert into quiz_parties (code) values (v_code) returning id into v_id;
  perform quiz_diffuser(v_id, true);
  return quiz_admin_etat(p_code);
end;
$$;

create or replace function public.quiz_admin_retirer_joueur(p_code text, p_joueur uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_partie uuid := quiz_partie_active();
begin
  perform quiz_verifier_admin(p_code);
  if (select statut from quiz_parties where id = v_partie) <> 'lobby' then
    raise exception 'Impossible de retirer un joueur une fois la partie lancée';
  end if;
  delete from quiz_joueurs where id = p_joueur and partie_id = v_partie;
  perform quiz_diffuser(v_partie, true);
  return quiz_admin_etat(p_code);
end;
$$;

-- Lance la partie : fige les joueurs et répartit les viewers déjà inscrits
create or replace function public.quiz_admin_lancer(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_partie uuid := quiz_partie_active();
  v_w      record;
begin
  perform quiz_verifier_admin(p_code);
  if v_partie is null then raise exception 'Aucune partie : crée-en une'; end if;
  if not exists (select 1 from quiz_joueurs where partie_id = v_partie) then
    raise exception 'Aucun joueur n''a rejoint la partie';
  end if;
  perform pg_advisory_xact_lock(hashtext('quiz_equipes'));
  update quiz_parties set statut = 'en_cours' where id = v_partie;
  for v_w in select id from quiz_viewers where partie_id = v_partie and equipe is null order by random() loop
    update quiz_viewers set equipe = quiz_equipe_libre(v_partie) where id = v_w.id;
  end loop;
  perform quiz_diffuser(v_partie, true);
  return quiz_admin_etat(p_code);
end;
$$;

create or replace function public.quiz_admin_ouvrir(p_code text, p_question text, p_points integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_partie uuid := quiz_partie_active();
  v_p      quiz_parties;
  v_q      quiz_questions;
  v_cat    text;
  v_props  jsonb;
  v_bonne  integer;
  v_id     bigint;
begin
  perform quiz_verifier_admin(p_code);
  select * into v_p from quiz_parties where id = v_partie;
  if v_p.statut is distinct from 'en_cours' then raise exception 'Lance d''abord la partie'; end if;
  if exists (select 1 from quiz_tours where id = v_p.tour_courant and etape <> 'revelee') then
    raise exception 'Révèle ou annule d''abord la question en cours';
  end if;
  select * into v_q from quiz_questions where id = p_question;
  if not found then raise exception 'Question % introuvable', p_question; end if;
  if not v_q.jouable then raise exception 'Question % incomplète : %', p_question, array_to_string(v_q.problemes, ', '); end if;

  v_cat := quiz_categorie(v_q.manche_zone, v_q.phase_jeu);

  -- mélange des 4 propositions
  with props(txt) as (values (v_q.bonne_reponse), (v_q.mauvaise_1), (v_q.mauvaise_2), (v_q.mauvaise_3)),
       melange as (select txt, row_number() over (order by random()) - 1 as i from props)
  select jsonb_agg(txt order by i), min(i) filter (where txt = v_q.bonne_reponse)
    into v_props, v_bonne from melange;

  insert into quiz_tours (partie_id, numero, question_id, categorie, manche, points, question, type, media,
                          propositions, bonne_index, fin_viewers)
  values (v_partie, (select count(*) + 1 from quiz_tours where partie_id = v_partie), v_q.id, v_cat,
          v_q.manche_auto, coalesce(p_points, quiz_points_categorie(v_cat)), v_q.question, v_q.type, v_q.media,
          v_props, v_bonne, clock_timestamp() + make_interval(secs => v_p.duree_viewers))
  returning id into v_id;

  update quiz_parties set tour_courant = v_id, ecran = 'question' where id = v_partie;
  perform quiz_diffuser(v_partie, true);
  return quiz_admin_etat(p_code);
end;
$$;

create or replace function public.quiz_admin_fermer(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_partie uuid := quiz_partie_active();
begin
  perform quiz_verifier_admin(p_code);
  update quiz_tours set etape = 'fermee', fermee_le = clock_timestamp()
  where id = (select tour_courant from quiz_parties where id = v_partie) and etape = 'question';
  perform quiz_diffuser(v_partie, false);
  return quiz_admin_etat(p_code);
end;
$$;

-- Révélation : calcule les points des joueurs et des viewers
create or replace function public.quiz_admin_reveler(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_partie  uuid := quiz_partie_active();
  v_t       quiz_tours;
  v_gagnant uuid;
begin
  perform quiz_verifier_admin(p_code);
  select t.* into v_t from quiz_tours t join quiz_parties p on p.tour_courant = t.id
  where p.id = v_partie for update of t;
  if not found then raise exception 'Aucune question en cours'; end if;
  if v_t.etape = 'revelee' then raise exception 'Déjà révélée'; end if;

  update quiz_reponses_joueurs set correct = (choix = v_t.bonne_index) where tour_id = v_t.id;

  if v_t.categorie in ('eclair', 'departage') then
    -- le premier joueur qui a répondu juste (heure du serveur)
    select joueur_id into v_gagnant from quiz_reponses_joueurs
    where tour_id = v_t.id and correct order by repondu_le limit 1;
    update quiz_reponses_joueurs set points = case when joueur_id = v_gagnant then v_t.points else 0 end
    where tour_id = v_t.id;
  else
    update quiz_reponses_joueurs set points = case when correct then v_t.points else 0 end
    where tour_id = v_t.id;
  end if;

  update quiz_joueurs j set score = j.score + r.points
  from quiz_reponses_joueurs r where r.tour_id = v_t.id and r.joueur_id = j.id and r.points <> 0;

  update quiz_reponses_viewers set correct = (choix = v_t.bonne_index),
    points = case when choix = v_t.bonne_index then v_t.points else 0 end
  where tour_id = v_t.id;
  update quiz_viewers w set score = w.score + r.points
  from quiz_reponses_viewers r where r.tour_id = v_t.id and r.viewer_id = w.id and r.points <> 0;

  update quiz_tours set etape = 'revelee', revelee_le = clock_timestamp(),
    fermee_le = coalesce(fermee_le, clock_timestamp()), gagnant_id = v_gagnant
  where id = v_t.id;

  perform quiz_diffuser(v_partie, true);
  return quiz_admin_etat(p_code);
end;
$$;

-- Annule la question en cours (et retire ses points si elle était révélée)
create or replace function public.quiz_admin_annuler(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_partie uuid := quiz_partie_active();
  v_t      quiz_tours;
begin
  perform quiz_verifier_admin(p_code);
  select t.* into v_t from quiz_tours t join quiz_parties p on p.tour_courant = t.id where p.id = v_partie;
  if not found then raise exception 'Aucune question à annuler'; end if;

  update quiz_joueurs j set score = j.score - r.points
  from quiz_reponses_joueurs r where r.tour_id = v_t.id and r.joueur_id = j.id and r.points <> 0;
  update quiz_viewers w set score = w.score - r.points
  from quiz_reponses_viewers r where r.tour_id = v_t.id and r.viewer_id = w.id and r.points <> 0;

  update quiz_parties set tour_courant = null where id = v_partie;
  delete from quiz_tours where id = v_t.id;
  perform quiz_diffuser(v_partie, true);
  return quiz_admin_etat(p_code);
end;
$$;

create or replace function public.quiz_admin_ecran(p_code text, p_ecran text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_partie uuid := quiz_partie_active();
begin
  perform quiz_verifier_admin(p_code);
  update quiz_parties set ecran = p_ecran where id = v_partie;
  perform quiz_diffuser(v_partie, false);
  return quiz_admin_etat(p_code);
end;
$$;

create or replace function public.quiz_admin_duree_viewers(p_code text, p_secondes integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_partie uuid := quiz_partie_active();
begin
  perform quiz_verifier_admin(p_code);
  if p_secondes not between 5 and 120 then raise exception 'Durée entre 5 et 120 secondes'; end if;
  update quiz_parties set duree_viewers = p_secondes where id = v_partie;
  perform quiz_diffuser(v_partie, false);
  return quiz_admin_etat(p_code);
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits : seules ces fonctions sont appelables depuis le web
-- ---------------------------------------------------------------------------
revoke all on function public.quiz_diffuser(uuid, boolean), public.quiz_etat_json(uuid),
  public.quiz_equipe_libre(uuid), public.quiz_partie_active() from public, anon, authenticated;

grant execute on function
  public.quiz_etat(),
  public.quiz_joueur_rejoindre(text, text),
  public.quiz_joueur_moi(uuid),
  public.quiz_joueur_repondre(uuid, bigint, integer),
  public.quiz_viewer_rejoindre(text, uuid),
  public.quiz_viewer_voter(uuid, bigint, integer),
  public.quiz_admin_etat(text),
  public.quiz_admin_nouvelle_partie(text),
  public.quiz_admin_retirer_joueur(text, uuid),
  public.quiz_admin_lancer(text),
  public.quiz_admin_ouvrir(text, text, integer),
  public.quiz_admin_fermer(text),
  public.quiz_admin_reveler(text),
  public.quiz_admin_annuler(text),
  public.quiz_admin_ecran(text, text),
  public.quiz_admin_duree_viewers(text, integer)
to anon, authenticated;
