import { rpc, configOk } from './supa.js';
import { el, remplir, local, synchroniser, propositions, enteteTour, minuteur, maintenant, voyant, COULEURS_JOUEURS } from './jeu.js';
import { elementMedia } from './media.js';

const $ = (s) => document.querySelector(s);
const CLE = 'quiz_viewer_jeton';

let moi = null;              // { jeton, id, pseudo, score, equipe, equipe_nom, choix }
let etat = null;
const votes = new Map();     // tour_id -> choix
const comptes = new Set();   // tours déjà ajoutés au score affiché
let tourAffiche = null;
let etapeAffichee = null;
let attenteFin = null;

// ------------------------------------------------------------ inscription
async function rejoindre(pseudo, jeton) {
  moi = await rpc('quiz_viewer_rejoindre', { p_pseudo: pseudo ?? '', p_jeton: jeton ?? null });
  local.ecrire(CLE, moi.jeton);
  if (moi.choix !== null && moi.choix !== undefined && etat?.tour) votes.set(etat.tour.id, moi.choix);
  $('#ecran-rejoindre').hidden = true;
  $('#ecran-jeu').hidden = false;
  afficherBandeau();
}

$('#form-rejoindre').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#erreur-rejoindre');
  err.hidden = true;
  try {
    await rejoindre($('#pseudo').value);
    if (etat) afficher(true);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

function afficherBandeau() {
  $('#moi-pseudo').textContent = moi.pseudo;
  const idx = etat?.joueurs?.findIndex(j => j.id === moi.equipe) ?? -1;
  $('#moi-equipe').textContent = moi.equipe_nom ? `Équipe ${moi.equipe_nom}` : 'Équipe attribuée au lancement';
  document.body.style.setProperty('--equipe', idx >= 0 ? COULEURS_JOUEURS[idx % COULEURS_JOUEURS.length] : 'var(--violet)');
  $('#moi-score').textContent = moi.score;
}

// ------------------------------------------------------------ vote
async function voter(tour, i) {
  if (votes.has(tour.id)) return;
  votes.set(tour.id, i);
  afficher(true);
  try {
    await rpc('quiz_viewer_voter', { p_jeton: moi.jeton, p_tour: tour.id, p_choix: i });
  } catch (ex) {
    votes.delete(tour.id);
    afficher(true);
    message(ex.message);
  }
}

function message(txt) {
  const m = el('p', { class: 'flash' }, txt);
  $('#zone').prepend(m);
  setTimeout(() => m.remove(), 4000);
}

// ------------------------------------------------------------ affichage
function afficher(force = false) {
  if (!moi) return;
  const zone = $('#zone');
  const tour = etat?.tour;
  const partie = etat?.partie;

  if (!partie) {
    remplir(zone, el('div', { class: 'attente' }, el('h2', {}, 'Aucune partie en cours'), el('p', { class: 'discret' }, 'Reste sur cette page, elle se mettra à jour toute seule.')));
    tourAffiche = null;
    return;
  }

  const ouvert = tour && tour.etape !== 'revelee' && maintenant() < Date.parse(tour.fin_viewers);
  const cleAffichage = tour ? `${tour.id}-${tour.etape}-${ouvert}-${votes.get(tour.id)}` : `attente-${partie.statut}`;
  if (!force && cleAffichage === etapeAffichee) return;
  etapeAffichee = cleAffichage;
  tourAffiche = tour?.id ?? null;

  if (!tour) {
    remplir(zone, el('div', { class: 'attente' },
      el('h2', {}, partie.statut === 'lobby' ? 'La partie va bientôt commencer' : 'Prochaine question dans un instant…'),
      el('p', { class: 'discret' }, `${etat.nb_viewers} viewers connectés`)));
    return;
  }

  const monChoix = votes.has(tour.id) ? votes.get(tour.id) : null;
  const revele = tour.etape === 'revelee';
  const media = tour.media && !/^audio/i.test(tour.type ?? '') ? elementMedia(tour.type, tour.media, { controles: false }) : null;

  let statut;
  if (revele) {
    const juste = monChoix === tour.bonne_index;
    statut = monChoix === null
      ? el('p', { class: 'statut' }, 'Pas de réponse cette fois.')
      : el('p', { class: `statut ${juste ? 'ok' : 'ko'}` }, juste ? `Bonne réponse ! +${tour.points} pt${tour.points > 1 ? 's' : ''}` : 'Raté !');
  } else if (ouvert) {
    statut = monChoix === null ? minuteur(tour.ouverte_le, tour.fin_viewers) : el('p', { class: 'statut' }, 'Réponse enregistrée ✓');
  } else {
    statut = el('p', { class: 'statut' }, monChoix === null ? 'Temps écoulé' : 'Réponse enregistrée ✓ · En attente de la révélation');
  }

  remplir(zone, 
    el('div', { class: 'meta' }, enteteTour(tour)),
    media,
    el('h2', { class: 'question' }, tour.question),
    propositions(tour, {
      choix: monChoix,
      bonne: revele ? tour.bonne_index : null,
      actif: ouvert && monChoix === null,
      onChoisir: (i) => voter(tour, i),
    }),
    statut,
  );

  // fin du minuteur : réafficher sans attendre de message
  clearTimeout(attenteFin);
  if (ouvert) attenteFin = setTimeout(() => afficher(), Date.parse(tour.fin_viewers) - maintenant() + 50);
}

function surEtat(nouvel) {
  const ancien = etat;
  etat = nouvel;
  if (!moi) return;

  // partie relancée : on repart de zéro
  if (ancien?.partie?.id && nouvel.partie?.id !== ancien.partie.id) {
    local.effacer(CLE);
    location.reload();
    return;
  }
  // équipe attribuée au lancement : on la récupère (étalé sur 3 s)
  if (!moi.equipe && nouvel.partie?.statut === 'en_cours' && !surEtat.demandeEquipe) {
    surEtat.demandeEquipe = true;
    setTimeout(() => rejoindre('', moi.jeton).then(() => afficher(true)).catch(() => {})
      .finally(() => { surEtat.demandeEquipe = false; }), Math.random() * 3000);
  }
  // points gagnés à la révélation
  const t = nouvel.tour;
  if (t?.etape === 'revelee' && !comptes.has(t.id)) {
    comptes.add(t.id);
    if (votes.get(t.id) === t.bonne_index) moi.score += t.points;
  }
  afficherBandeau();
  afficher();
}

// ------------------------------------------------------------ démarrage
async function demarrer() {
  if (!configOk) { document.body.textContent = 'Supabase non configuré.'; return; }
  const sync = synchroniser({ canal: 'quiz-public', onEtat: surEtat, onConnexion: voyant, secours: 8000 });
  const jeton = local.lire(CLE);
  if (jeton) {
    try {
      await sync.rafraichir();
      await rejoindre('', jeton);
      // une question déjà révélée au chargement est déjà dans le score serveur
      if (etat?.tour?.etape === 'revelee') comptes.add(etat.tour.id);
      afficher(true);
      return;
    } catch {
      local.effacer(CLE);
    }
  }
  $('#ecran-rejoindre').hidden = false;
}
demarrer();
