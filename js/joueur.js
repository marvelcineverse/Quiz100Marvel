import { rpc, configOk } from './supa.js';
import { el, remplir, local, synchroniser, propositions, enteteTour, voyant, COULEURS_JOUEURS } from './jeu.js';
import { elementMedia } from './media.js';

const $ = (s) => document.querySelector(s);
const CLE = 'quiz_joueur_jeton';

let moi = null;            // { id, nom, jeton }
let etat = null;
const reponses = new Map(); // tour_id -> choix
let envoiEnCours = false;
let cleAffichee = null;

async function chargerMoi(jeton) {
  const m = await rpc('quiz_joueur_moi', { p_jeton: jeton });
  moi = { ...m, jeton };
  if (m.tour_id && m.choix !== null && m.choix !== undefined) reponses.set(m.tour_id, m.choix);
  local.ecrire(CLE, jeton);
  $('#ecran-rejoindre').hidden = true;
  $('#ecran-jeu').hidden = false;
}

$('#form-rejoindre').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#erreur-rejoindre');
  err.hidden = true;
  try {
    const r = await rpc('quiz_joueur_rejoindre', { p_code: $('#code').value, p_nom: $('#nom').value });
    await chargerMoi(r.jeton);
    afficher(true);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

async function repondre(tour, i) {
  if (envoiEnCours || reponses.has(tour.id)) return;
  envoiEnCours = true;
  reponses.set(tour.id, i);
  afficher(true);
  try {
    await rpc('quiz_joueur_repondre', { p_jeton: moi.jeton, p_tour: tour.id, p_choix: i });
  } catch (ex) {
    if (!/déjà répondu/.test(ex.message)) reponses.delete(tour.id);
    afficher(true);
    const m = el('p', { class: 'flash' }, ex.message);
    $('#zone').prepend(m);
    setTimeout(() => m.remove(), 4000);
  } finally {
    envoiEnCours = false;
  }
}

function afficher(force = false) {
  if (!moi || !etat) return;
  const zone = $('#zone');
  const joueurs = etat.joueurs ?? [];
  const idx = joueurs.findIndex(j => j.id === moi.id);
  const moiEtat = joueurs[idx];

  // bandeau
  $('#moi-nom').textContent = moi.nom;
  $('#moi-score').textContent = moiEtat?.score ?? 0;
  const classement = [...joueurs].sort((a, b) => b.score - a.score);
  const rang = classement.findIndex(j => j.id === moi.id) + 1;
  $('#moi-rang').textContent = rang && etat.partie?.statut === 'en_cours' ? `${rang}${rang === 1 ? 'er' : 'e'} sur ${joueurs.length}` : '';
  document.body.style.setProperty('--equipe', idx >= 0 ? COULEURS_JOUEURS[idx % COULEURS_JOUEURS.length] : 'var(--violet)');

  if (idx < 0) {
    remplir(zone, el('div', { class: 'attente' }, el('h2', {}, "Tu ne fais plus partie de la partie"),
      el('button', { class: 'btn btn-secondaire', onclick: () => { local.effacer(CLE); location.reload(); } }, 'Rejoindre à nouveau')));
    return;
  }

  const tour = etat.tour;
  const cle = tour ? `${tour.id}-${tour.etape}-${reponses.get(tour.id)}-${tour.ont_repondu.length}` : `attente-${etat.partie?.statut}-${joueurs.length}`;
  if (!force && cle === cleAffichee) return;
  cleAffichee = cle;

  if (!tour) {
    remplir(zone, el('div', { class: 'attente' },
      el('h2', {}, etat.partie?.statut === 'lobby' ? 'Tu es bien inscrit !' : 'Prochaine question dans un instant…'),
      el('p', { class: 'discret' }, etat.partie?.statut === 'lobby'
        ? `Joueurs : ${joueurs.map(j => j.nom).join(', ')}`
        : 'Garde cette page ouverte.')));
    return;
  }

  const monChoix = reponses.has(tour.id) ? reponses.get(tour.id) : null;
  const revele = tour.etape === 'revelee';
  const ouvert = tour.etape === 'question' && monChoix === null;
  const media = tour.media && !/^audio/i.test(tour.type ?? '') ? elementMedia(tour.type, tour.media, { controles: false }) : null;

  let statut;
  if (revele) {
    const r = tour.reponses?.find(x => x.joueur_id === moi.id);
    statut = !r ? el('p', { class: 'statut' }, 'Pas de réponse.')
      : r.points > 0 ? el('p', { class: 'statut ok' }, `Bonne réponse ! +${r.points} pt${r.points > 1 ? 's' : ''}`)
        : r.correct ? el('p', { class: 'statut' }, 'Juste, mais quelqu\'un a été plus rapide !')
          : el('p', { class: 'statut ko' }, 'Raté !');
  } else if (monChoix !== null) {
    const attendus = joueurs.length - tour.ont_repondu.length;
    statut = el('p', { class: 'statut' }, attendus > 0 ? `Réponse envoyée ✓ · ${attendus} joueur${attendus > 1 ? 's' : ''} en réflexion` : 'Réponse envoyée ✓');
  } else if (tour.etape === 'fermee') {
    statut = el('p', { class: 'statut ko' }, 'Réponses fermées');
  } else {
    statut = el('p', { class: 'statut' }, tour.categorie === 'eclair' ? 'Éclair : le premier qui répond juste marque !' : 'À toi de jouer');
  }

  remplir(zone, 
    el('div', { class: 'meta' }, enteteTour(tour)),
    media,
    el('h2', { class: 'question' }, tour.question),
    propositions(tour, { choix: monChoix, bonne: revele ? tour.bonne_index : null, actif: ouvert, onChoisir: (i) => repondre(tour, i) }),
    statut,
  );
}

function surEtat(nouvel) {
  if (etat?.partie?.id && nouvel.partie?.id !== etat.partie.id) {
    local.effacer(CLE);
    location.reload();
    return;
  }
  etat = nouvel;
  afficher();
}

async function demarrer() {
  if (!configOk) { document.body.textContent = 'Supabase non configuré.'; return; }
  const jeton = local.lire(CLE);
  if (jeton) {
    try { await chargerMoi(jeton); } catch { local.effacer(CLE); moi = null; }
  }
  if (!moi) $('#ecran-rejoindre').hidden = false;
  const code = new URLSearchParams(location.search).get('code');
  if (code) $('#code').value = code;
  synchroniser({ canal: 'quiz-plateau', onEtat: surEtat, onConnexion: voyant, secours: 3000, garde: 20000 });
}
demarrer();
