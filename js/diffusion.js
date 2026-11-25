// Écran de diffusion : capturé dans le logiciel de live (1920 x 1080).
import { configOk } from './supa.js';
import { el, synchroniser, propositions, enteteTour, minuteur, maintenant, LETTRES, COULEURS_JOUEURS } from './jeu.js';
import { elementMedia } from './media.js';

const $ = (s) => document.querySelector(s);
let etat = null;
let cleCentre = null;
let attenteFin = null;

// mise à l'échelle de la scène 1920x1080 dans la fenêtre
function ajuster() {
  const k = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  $('#scene').style.transform = `translate(-50%, -50%) scale(${k})`;
}
window.addEventListener('resize', ajuster);
ajuster();

const couleur = (i) => COULEURS_JOUEURS[i % COULEURS_JOUEURS.length];

function afficherJoueurs() {
  const tour = etat?.tour;
  const revele = tour?.etape === 'revelee';
  $('#d-joueurs').replaceChildren(...(etat?.joueurs ?? []).map((j, i) => {
    let etiquette = null;
    if (tour && !revele) {
      etiquette = tour.ont_repondu.includes(j.id) ? el('span', { class: 'puce ok' }, 'A répondu') : el('span', { class: 'puce' }, '…');
    } else if (revele) {
      const r = tour.reponses?.find(x => x.joueur_id === j.id);
      etiquette = !r ? el('span', { class: 'puce' }, '—')
        : el('span', { class: `puce ${r.correct ? 'ok' : 'ko'}` }, `${LETTRES[r.choix]} ${r.points > 0 ? `+${r.points}` : ''}`);
    }
    return el('div', { class: 'd-joueur', style: `--c:${couleur(i)}` },
      el('div', { class: 'd-joueur-nom' }, j.nom),
      el('div', { class: 'd-joueur-score' }, String(j.score)),
      etiquette);
  }));
  $('#d-viewers').textContent = etat?.nb_viewers ? `${etat.nb_viewers} viewer${etat.nb_viewers > 1 ? 's' : ''}` : '';
}

function ecranAccueil() {
  const url = `${location.origin}${location.pathname.replace(/diffusion\.html$/, '')}viewer.html`;
  return el('div', { class: 'd-accueil' },
    el('div', { class: 'logo geant' }, 'Quiz du ', el('span', {}, 'Multivers')),
    el('p', { class: 'd-sous-titre' }, '100% Marvel · Saga du Multivers'),
    el('p', { class: 'd-invite' }, 'Jouez avec nous : ', el('b', {}, url.replace(/^https?:\/\//, ''))));
}

function ecranClassement() {
  const joueurs = (etat.joueurs ?? []).map((j, i) => ({ ...j, c: couleur(i) })).sort((a, b) => b.score - a.score);
  const max = Math.max(1, ...joueurs.map(j => j.score));
  return el('div', { class: 'd-classement' },
    el('h2', {}, 'Classement'),
    joueurs.map((j, rang) => el('div', { class: 'd-ligne', style: `--c:${j.c}` },
      el('span', { class: 'd-rang' }, String(rang + 1)),
      el('span', { class: 'd-nom' }, j.nom),
      el('span', { class: 'd-barre' }, el('span', { style: `width:${(j.score / max) * 100}%` })),
      el('span', { class: 'd-pts' }, `${j.score} pts`),
      el('span', { class: 'd-equipe' }, `${j.nb_viewers} viewer${j.nb_viewers > 1 ? 's' : ''}`))));
}

function ecranQuestion(tour) {
  const revele = tour.etape === 'revelee';
  const ouvertViewers = !revele && maintenant() < Date.parse(tour.fin_viewers);
  const media = tour.media ? elementMedia(tour.type, tour.media, { controles: false, lecture: true }) : null;
  if (media && (media.tagName === 'AUDIO' || media.tagName === 'VIDEO')) {
    media.play?.().catch(() => { $('#activer-son').hidden = false; });
    if (media.tagName === 'AUDIO') media.classList.add('cache');
  }
  const viewersVotent = etat.nb_viewers > 0;
  return el('div', { class: `d-question ${media && media.tagName !== 'AUDIO' ? 'avec-media' : ''}` },
    media && media.tagName !== 'AUDIO' ? el('div', { class: 'd-media' }, media) : media,
    el('div', { class: 'd-texte' },
      el('h1', {}, tour.question),
      propositions(tour, { bonne: revele ? tour.bonne_index : null, stats: revele && viewersVotent ? tour.stats_viewers : null }),
      revele && viewersVotent ? el('p', { class: 'd-legende' }, 'Pourcentages : réponses des viewers') : null,
      ouvertViewers && viewersVotent ? minuteur(tour.ouverte_le, tour.fin_viewers) : null,
      !revele && tour.etape === 'fermee' ? el('p', { class: 'd-legende' }, 'Réponses fermées') : null));
}

function afficher() {
  const tour = etat?.tour;
  $('#d-meta').textContent = tour && etat.partie?.ecran !== 'classement' ? enteteTour(tour) : '';
  afficherJoueurs();

  // on ne reconstruit le centre que s'il change (évite de relancer médias et minuteur)
  const ouvertViewers = tour && tour.etape !== 'revelee' && maintenant() < Date.parse(tour.fin_viewers);
  const cle = !etat?.partie ? 'vide'
    : etat.partie.ecran === 'classement' ? `classement-${etat.version}`
      : !tour ? `accueil-${etat.partie.statut}`
        : `${tour.id}-${tour.etape}-${ouvertViewers}`;
  if (cle === cleCentre) return;
  const memeQuestion = cleCentre?.startsWith(`${tour?.id}-`) && tour && etat.partie.ecran !== 'classement';
  cleCentre = cle;

  const centre = $('#d-centre');
  if (memeQuestion && centre.querySelector('.d-question')) {
    // même question : on ne remplace que le texte (le média continue)
    const ancien = centre.querySelector('.d-texte');
    const neuf = ecranQuestion(tour).querySelector('.d-texte');
    ancien.replaceWith(neuf);
  } else {
    centre.replaceChildren(
      !etat?.partie || !tour ? ecranAccueil()
        : etat.partie.ecran === 'classement' ? ecranClassement()
          : ecranQuestion(tour));
  }

  clearTimeout(attenteFin);
  if (ouvertViewers) attenteFin = setTimeout(afficher, Date.parse(tour.fin_viewers) - maintenant() + 50);
}

$('#activer-son').addEventListener('click', () => {
  $('#activer-son').hidden = true;
  document.querySelectorAll('audio, video').forEach(m => m.play().catch(() => {}));
});

if (configOk) {
  synchroniser({
    canal: 'quiz-plateau',
    onEtat: (e) => { etat = e; afficher(); },
    secours: 2000,
    garde: 15000,
  });
} else {
  $('#d-centre').textContent = 'Supabase non configuré.';
}
