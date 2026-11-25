// Onglet "Partie" de l'admin : création, joueurs, pilotage des questions.
import { rpc } from './supa.js';
import { el, remplir, synchroniser, propositions, enteteTour, minuteur, maintenant, voyant, LETTRES, CATEGORIES, COULEURS_JOUEURS } from './jeu.js';
import { elementMedia } from './media.js';

const $ = (s) => document.querySelector(s);
let code = null;
let questions = [];
let etat = null;
let sync = null;
let suivi = null;
let cleTour = null;

function toast(msg, erreur = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('erreur', erreur);
  t.hidden = false;
  clearTimeout(toast.m);
  toast.m = setTimeout(() => { t.hidden = true; }, erreur ? 6000 : 2500);
}

// Appelle une action admin, applique l'état renvoyé
async function action(nom, args = {}, bouton = null) {
  if (bouton) bouton.disabled = true;
  try {
    const e = await rpc(nom, { p_code: code, ...args });
    sync.appliquer(e);
    return e;
  } catch (ex) {
    toast(ex.message, true);
    return null;
  } finally {
    if (bouton) bouton.disabled = false;
  }
}

// ------------------------------------------------------------ partie et joueurs
function afficherPartie() {
  const p = etat?.partie;
  const statut = { lobby: 'Inscriptions ouvertes', en_cours: 'En cours', terminee: 'Terminée' }[p?.statut] ?? 'Aucune partie';
  $('#p-infos').replaceChildren(
    p ? el('div', {}, el('div', { class: 'discret' }, 'Code joueurs'), el('div', { class: 'code-partie' }, etat.code ?? '')) : null,
    el('p', {}, el('b', {}, statut), p ? ` · ${etat.nb_viewers} viewers` : ''),
  );
  $('#btn-lancer').hidden = p?.statut !== 'lobby';
  $('#duree-viewers').value = p?.duree_viewers ?? 15;

  $('#p-joueurs').replaceChildren(...(etat?.joueurs ?? []).map((j, i) => el('li', { style: `--c:${COULEURS_JOUEURS[i % COULEURS_JOUEURS.length]}` },
    el('span', {}, j.nom),
    el('span', { class: 'discret', title: 'Viewers dans son équipe' }, `👥 ${j.nb_viewers}`),
    el('b', {}, `${j.score} pts`),
    p?.statut === 'lobby' ? el('button', {
      class: 'btn btn-discret btn-petit', title: 'Retirer',
      onclick: (e) => confirm(`Retirer ${j.nom} ?`) && action('quiz_admin_retirer_joueur', { p_joueur: j.id }, e.target),
    }, '✕') : null,
  )));
  if (!etat?.joueurs?.length) $('#p-joueurs').append(el('li', { class: 'discret' }, 'Aucun joueur pour l\'instant'));
}

$('#btn-nouvelle').addEventListener('click', (e) => {
  if (etat?.partie && !confirm('Terminer la partie actuelle et en créer une nouvelle ? Les joueurs et viewers devront rejoindre à nouveau.')) return;
  action('quiz_admin_nouvelle_partie', {}, e.target);
});
$('#btn-lancer').addEventListener('click', (e) => {
  if (!confirm(`Lancer la partie avec ${etat?.joueurs?.length ?? 0} joueur(s) ? La liste des joueurs sera figée et les viewers répartis en équipes.`)) return;
  action('quiz_admin_lancer', {}, e.target);
});
$('#form-duree').addEventListener('submit', (e) => {
  e.preventDefault();
  action('quiz_admin_duree_viewers', { p_secondes: Number($('#duree-viewers').value) }).then(r => r && toast('Minuteur enregistré'));
});
$('#btn-ecran-question').addEventListener('click', (e) => action('quiz_admin_ecran', { p_ecran: 'question' }, e.target));
$('#btn-ecran-classement').addEventListener('click', (e) => action('quiz_admin_ecran', { p_ecran: 'classement' }, e.target));

// ------------------------------------------------------------ question en cours
function afficherTour() {
  const t = etat?.tour;
  const corps = $('#t-corps');
  $('#btn-ecran-question').classList.toggle('btn-secondaire', etat?.partie?.ecran !== 'classement');
  $('#btn-ecran-classement').classList.toggle('btn-secondaire', etat?.partie?.ecran === 'classement');

  $('#btn-fermer').hidden = t?.etape !== 'question';
  $('#btn-reveler').hidden = !t || t.etape === 'revelee';
  $('#btn-annuler').hidden = !t;

  if (!t) {
    $('#t-titre').textContent = 'Question en cours';
    remplir(corps, el('p', { class: 'discret' }, etat?.partie?.statut === 'en_cours'
      ? 'Choisis une question dans la liste ci-dessous.'
      : 'Crée une partie, attends les joueurs, puis lance-la.'));
    return;
  }

  $('#t-titre').textContent = enteteTour(t);
  const joueurs = etat.joueurs ?? [];
  const totalViewers = (t.stats_viewers ?? []).reduce((a, b) => a + b, 0);
  const viewersOuverts = t.etape !== 'revelee' && maintenant() < Date.parse(t.fin_viewers);

  // le minuteur et le média ne sont reconstruits qu'au changement de question / étape
  const cle = `${t.id}-${t.etape}-${viewersOuverts}`;
  const reconstruire = cle !== cleTour;
  cleTour = cle;

  const lignes = joueurs.map((j, i) => {
    const r = t.reponses?.find(x => x.joueur_id === j.id);
    const gagnant = t.gagnant_id === j.id;
    return el('tr', {},
      el('td', { style: `border-left:4px solid ${COULEURS_JOUEURS[i % COULEURS_JOUEURS.length]}` }, j.nom),
      el('td', {}, r ? `${LETTRES[r.choix]} · ${t.propositions[r.choix]}` : el('span', { class: 'discret' }, 'en réflexion…')),
      el('td', { class: r ? (r.correct ? 'ok' : 'ko') : '' }, r ? (r.correct ? '✓' : '✗') : ''),
      el('td', { class: 'discret' }, r ? `${(r.temps_ms / 1000).toFixed(1)} s` : ''),
      el('td', {}, t.etape === 'revelee' && r ? `${r.points > 0 ? '+' : ''}${r.points}${gagnant ? ' ⚡' : ''}` : ''),
    );
  });

  const blocMinuteur = viewersOuverts
    ? (reconstruire ? minuteur(t.ouverte_le, t.fin_viewers) : corps.querySelector('.minuteur'))
    : el('p', { class: 'discret' }, `Viewers : ${totalViewers} réponse${totalViewers > 1 ? 's' : ''}${t.etape === 'revelee' ? '' : ' · vote terminé'}`);

  const media = reconstruire
    ? (t.media ? elementMedia(t.type, t.media, { controles: true }) : null)
    : corps.querySelector('.media');

  remplir(corps, 
    media,
    el('p', { class: 'apercu-question' }, t.question),
    propositions(t, { bonne: t.bonne_index, stats: totalViewers ? t.stats_viewers : null }),
    blocMinuteur,
    el('table', { class: 'reponses-joueurs' }, el('tbody', {}, lignes)),
  );
}

$('#btn-fermer').addEventListener('click', (e) => action('quiz_admin_fermer', {}, e.target));
$('#btn-reveler').addEventListener('click', (e) => {
  const t = etat?.tour;
  const reste = t ? Math.ceil((Date.parse(t.fin_viewers) - maintenant()) / 1000) : 0;
  const manquants = (etat?.joueurs?.length ?? 0) - (t?.reponses?.length ?? 0);
  const alertes = [];
  if (reste > 0 && etat.nb_viewers > 0) alertes.push(`les viewers ont encore ${reste} s`);
  if (manquants > 0) alertes.push(`${manquants} joueur(s) n'ont pas répondu`);
  if (alertes.length && !confirm(`Révéler maintenant ? Attention : ${alertes.join(' et ')}.`)) return;
  action('quiz_admin_reveler', {}, e.target);
});
$('#btn-annuler').addEventListener('click', (e) => {
  const revelee = etat?.tour?.etape === 'revelee';
  if (!confirm(revelee
    ? 'Annuler cette question ? Les points donnés seront retirés aux joueurs et aux viewers.'
    : 'Annuler cette question ? Les réponses déjà données seront effacées.')) return;
  action('quiz_admin_annuler', {}, e.target);
});

// ------------------------------------------------------------ questions à jouer
function groupeDe(q) {
  if (q.reserve) return 'Réserves / départage';
  return [q.phase_jeu || 'Sans phase', q.manche_auto ? `manche ${q.manche_auto}` : null].filter(Boolean).join(' · ');
}

function afficherListe() {
  const jouables = questions.filter(q => q.jouable && !q.retiree);
  const groupes = [...new Set(jouables.map(groupeDe))].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
  const sel = $('#f-jouer');
  const garde = sel.value || groupes.find(g => g.startsWith('Phase 1')) || '';
  sel.replaceChildren(el('option', { value: '' }, 'Toutes'), ...groupes.map(g => el('option', { value: g }, g)));
  sel.value = groupes.includes(garde) ? garde : '';

  const jouees = new Set(etat?.questions_jouees ?? []);
  const enCours = etat?.tour && etat.tour.etape !== 'revelee';
  const peutOuvrir = etat?.partie?.statut === 'en_cours' && !enCours;
  const filtre = sel.value;
  const liste = jouables.filter(q => !filtre || groupeDe(q) === filtre);

  const zone = $('#liste-a-jouer');
  remplir(zone, );
  let groupe = null;
  for (const q of liste) {
    const g = groupeDe(q);
    if (g !== groupe && !filtre) { zone.append(el('div', { class: 'groupe' }, g)); groupe = g; }
    const deja = jouees.has(q.id);
    zone.append(el('div', { class: `a-jouer ${deja ? 'jouee' : ''}`, title: q.question },
      el('span', { class: 'mono' }, q.id),
      el('span', { class: 'cat' }, q.manche_zone ?? ''),
      el('span', { class: 'q' }, q.question),
      el('button', {
        class: `btn btn-petit ${deja ? 'btn-discret' : 'btn-principal'}`,
        disabled: !peutOuvrir,
        title: peutOuvrir ? '' : (enCours ? 'Révèle ou annule d\'abord la question en cours' : 'Lance d\'abord la partie'),
        onclick: (e) => (!deja || confirm(`${q.id} a déjà été jouée. La rejouer ?`)) && action('quiz_admin_ouvrir', { p_question: q.id }, e.target),
      }, deja ? 'Rejouer' : 'Ouvrir'),
    ));
  }
  const nonJouables = questions.filter(q => !q.jouable && !q.retiree).length;
  if (nonJouables) zone.append(el('p', { class: 'discret' }, `${nonJouables} question(s) incomplète(s) masquée(s) : voir l'onglet Questions.`));
  if (!liste.length) zone.append(el('p', { class: 'discret' }, 'Aucune question jouable. Importe le tableau dans l\'onglet Questions.'));
}
$('#f-jouer').addEventListener('change', afficherListe);

// ------------------------------------------------------------ synchro
function surEtat(e) {
  etat = e;
  afficherPartie();
  afficherTour();
  afficherListe();
  // pendant une question : suivi rapproché des votes (1 seul client, l'admin)
  clearInterval(suivi);
  if (e?.tour && e.tour.etape !== 'revelee') suivi = setInterval(() => sync.rafraichir(), 1500);
}

window.addEventListener('quiz:questions', (e) => { questions = e.detail.questions; afficherListe(); });
window.addEventListener('quiz:connecte', (e) => {
  code = e.detail.code;
  if (sync) { sync.rafraichir(); return; }
  sync = synchroniser({
    canal: 'quiz-plateau',
    charger: () => rpc('quiz_admin_etat', { p_code: code }),
    onEtat: surEtat,
    onConnexion: voyant,
    rechargerSurMessage: true,
    secours: 2000,
    garde: 10000,
  });
});
