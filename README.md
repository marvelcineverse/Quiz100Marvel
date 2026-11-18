# Quiz du Multivers

Application de quiz Marvel (Saga du Multivers) pour le « 100% Marvel » de La Chaîne du Geek.
Pages web statiques + Supabase (base, temps réel). Aucune étape de compilation.

## Écrans

| Page | Pour qui | État |
|---|---|---|
| `admin.html` | Lucas : import des questions, aperçu, correction, pilotage | Étape 1 ✔ (pilotage : étape 2) |
| `joueur.html` | Joueurs (code de partie, QCM) | Étape 2 |
| `viewer.html` | Viewers (équipes, minuteur 15 s) | Étape 2 |
| `diffusion.html` | Capture plein écran dans le logiciel de live | Étape 2 |

## Installation

1. **Supabase** : ouvrir *SQL Editor*, coller `supabase/01_socle.sql`.
   Avant de lancer le script, remplacer `A_CHANGER` par le code admin choisi. Puis *Run*.
   Le script peut être relancé sans risque. Tous les objets sont préfixés `quiz_` :
   il peut cohabiter avec d'autres tables dans un projet existant.
2. **Connexion** : dans `js/config.js`, renseigner l'URL du projet et la clé `anon public`
   (*Project Settings > API*). Ne jamais y mettre la clé `service_role`.
3. **Hébergement** : GitHub Pages (*Settings > Pages > Deploy from branch > main / root*),
   ou n'importe quel hébergeur de fichiers statiques.

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

## Sécurité

- Les tables ne sont pas lisibles depuis le navigateur (RLS sans policy) : les bonnes réponses ne fuient pas.
- Toute action admin passe par une fonction SQL qui vérifie le code admin.

## Après le live

`supabase/99_desinstaller.sql` supprime toutes les tables et fonctions `quiz_*` (irréversible).
