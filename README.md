# Quiz du Multivers

Application de quiz Marvel (Saga du Multivers) pour le « 100% Marvel » de La Chaîne du Geek.
Pages web statiques + Supabase (base, temps réel). Aucune étape de compilation.

## Écrans

| Page | Pour qui | État |
|---|---|---|
| `admin.html` | Lucas : import, correction, création de partie, pilotage des questions | ✔ |
| `joueur.html` | Joueurs : code de partie + nom, QCM sans limite de temps | ✔ |
| `viewer.html` | Viewers : pseudo, équipe attribuée automatiquement, minuteur 15 s | ✔ |
| `diffusion.html` | Capture plein écran (1920×1080) dans le logiciel de live | ✔ |

## Installation

1. **Supabase** : ouvrir *SQL Editor*, coller `supabase/01_socle.sql`, puis `supabase/02_partie.sql`.
   Avant de lancer le premier script, remplacer `A_CHANGER` par le code admin choisi. Puis *Run*.
   Les scripts peuvent être relancés sans risque. Tous les objets sont préfixés `quiz_` :
   il peut cohabiter avec d'autres tables dans un projet existant.
2. **Connexion** : dans `js/config.js`, renseigner l'URL du projet et la clé `anon public`
   (*Project Settings > API*). Ne jamais y mettre la clé `service_role`.
3. **Hébergement** : Vercel (preset *Other*, aucune commande de build, dossier racine).
   Chaque envoi sur `main` republie le site.

En local : `python3 -m http.server` à la racine, puis http://localhost:8000/admin.html.

## Import des questions

Depuis l'admin, onglet *Questions* :
- **Google Sheets** : coller le lien. Le tableau doit être partagé en lecture à « Tous les utilisateurs disposant du lien ». L'onglet lu par défaut s'appelle `Questions`.
- **Fichier** : xlsx, ods ou csv (UTF-8).

Colonnes reconnues (accents et casse indifférents) : ID, Phase du jeu, Manche / Zone, Thème,
Programme (tag), Type, Difficulté, Question, Bonne réponse, Mauvaise proposition 1 à 3, Média,
Source, Statut, Réserve ?, Notes, Manche (auto).

Règles d'import :
- les lignes au statut `Exemple` et les lignes vides sont ignorées ;
- l'import se fait par ID : relancer l'import met à jour les questions existantes ;
- une question corrigée dans l'appli n'est pas écrasée par l'import suivant (sauf case cochée) ;
- une question absente du tableau n'est pas supprimée : elle est marquée « retirée » et ne sera pas jouée.

Une question est **jouable** si elle a une question, une bonne réponse, 3 mauvaises propositions
toutes différentes, et une URL de média quand son type est Image, Audio ou Vidéo.
Les liens de partage Google Drive sont convertis automatiquement pour l'affichage.

`exemples/questions_demo.csv` contient un jeu de questions de démonstration.

## Déroulé d'une partie (Phase 1)

1. Admin, onglet *Partie* : **Nouvelle partie** → un code de 4 lettres s'affiche.
2. Les joueurs ouvrent `joueur.html`, saisissent le code et leur nom (5 maximum).
   Les viewers ouvrent `viewer.html` et choisissent un pseudo.
3. **Lancer la partie** : la liste des joueurs est figée, les viewers sont répartis
   en équipes (une par joueur). Les nouveaux viewers rejoignent l'équipe la moins fournie.
4. Pour chaque question : **Ouvrir** dans la liste → les joueurs répondent sans limite de temps
   (fermeture automatique quand tous ont répondu), les viewers ont 15 s →
   **Révéler** : points calculés automatiquement.
   - Éclair et départage : seul le premier joueur qui répond juste marque (heure du serveur).
   - Autres questions : tous les joueurs qui ont juste marquent.
   - Points : Éclair 1, Identification 2, Pointue 3, Variante 3 (d'après la colonne *Manche / Zone*).
   - Les viewers marquent les points de la question s'ils ont juste.
5. **Annuler la question** retire les points qu'elle a donnés.
6. **Écran : classement** affiche le classement sur l'écran de diffusion.

Rechargement de page : joueurs et viewers retrouvent leur place et leur équipe (jeton mémorisé dans le navigateur).

## Temps réel

La base diffuse elle-même chaque changement d'état (`realtime.send`) sur deux canaux publics :
`quiz-plateau` (admin, joueurs, diffusion) et `quiz-public` (viewers, ~3 messages par question).
Si le temps réel est coupé, les écrans se resynchronisent automatiquement par interrogation
(voyant orange dans le bandeau).

## Sécurité

- Les tables ne sont pas lisibles depuis le navigateur (RLS sans policy) : les bonnes réponses ne fuient pas.
- La bonne réponse n'est envoyée aux écrans qu'au moment de la révélation ; l'ordre des propositions est mélangé côté serveur.
- Toute action admin passe par une fonction SQL qui vérifie le code admin.

## Après le live

`supabase/99_desinstaller.sql` supprime toutes les tables et fonctions `quiz_*` (irréversible).
