// Outils communs aux écrans de jeu : synchronisation temps réel, horloge, rendu.
import { sb, rpc } from './supa.js';

export const LETTRES = ['A', 'B', 'C', 'D'];
export const CATEGORIES = {
  eclair: 'Éclair', identification: 'Identification', pointue: 'Pointue',
  variante: 'Variante', departage: 'Départage', autre: 'Question',
};
export const COULEURS_JOUEURS = ['#e62429', '#2f7bff', '#2fbf71', '#f0a030', '#b25cff'];

export function el(tag, attrs = {}, ...enfants) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of enfants.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

// Remplace le contenu d'un élément en ignorant les valeurs vides
export function remplir(parent, ...enfants) {
  parent.replaceChildren(...enfants.flat().filter(c => c !== null && c !== undefined && c !== false));
}

export const local = {
  lire(cle) { try { return localStorage.getItem(cle); } catch { return null; } },
  ecrire(cle, v) { try { localStorage.setItem(cle, v); } catch { /* ignoré */ } },
  effacer(cle) { try { localStorage.removeItem(cle); } catch { /* ignoré */ } },
};

// --------------------------------------------------------------- horloge
let decalage = 0; // heure serveur - heure locale (ms)
export const maintenant = () => Date.now() + decalage;
export function secondesRestantes(finIso) {
  return Math.max(0, (Date.parse(finIso) - maintenant()) / 1000);
}

// --------------------------------------------------------------- synchro
// canal : 'quiz-plateau' (admin, joueurs, diffusion) ou 'quiz-public' (viewers)
// secours : intervalle d'interrogation quand le temps réel est coupé (ms)
// garde : interrogation de sécurité même connecté (ms, 0 = jamais)
// rechargerSurMessage : au lieu d'utiliser le message reçu, relire l'état via charger() (admin)
export function synchroniser({ canal, onEtat, onConnexion = () => {}, secours = 5000, garde = 0, charger = () => rpc('quiz_etat'), rechargerSurMessage = false }) {
  let etat = null;
  let connecte = false;
  let dernier = 0;
  let enCours = null;

  function appliquer(nouvel) {
    if (!nouvel) return;
    const memePartie = etat?.partie?.id && etat.partie.id === nouvel.partie?.id;
    if (memePartie && nouvel.version < etat.version) return; // message en retard
    if (nouvel.maintenant) decalage = Date.parse(nouvel.maintenant) - Date.now();
    dernier = Date.now();
    etat = nouvel;
    onEtat(etat);
  }

  async function rafraichir() {
    if (enCours) return enCours;
    enCours = charger().then(appliquer).catch(e => console.warn('Rafraîchissement impossible', e.message))
      .finally(() => { enCours = null; });
    return enCours;
  }

  sb.channel(canal, { config: { private: false } })
    .on('broadcast', { event: 'etat' }, (m) => (rechargerSurMessage ? rafraichir() : appliquer(m.payload)))
    .subscribe((statut) => {
      const avant = connecte;
      connecte = statut === 'SUBSCRIBED';
      onConnexion(connecte);
      if (connecte && !avant) rafraichir(); // rattrape ce qui a été manqué
    });

  // interrogation de secours (avec un peu d'aléa pour étaler la charge)
  const pas = Math.min(secours, garde || secours);
  setInterval(() => {
    const age = Date.now() - dernier;
    if ((!connecte && age > secours) || (garde && age > garde)) rafraichir();
  }, pas / 2 + Math.random() * 1000);

  document.addEventListener('visibilitychange', () => { if (!document.hidden) rafraichir(); });
  rafraichir();

  return { rafraichir, appliquer, get etat() { return etat; } };
}

// --------------------------------------------------------------- rendu QCM
// options : { choix, bonne, actif, onChoisir, stats, compactes }
export function propositions(tour, { choix = null, bonne = null, actif = false, onChoisir = null, stats = null } = {}) {
  const total = stats ? stats.reduce((a, b) => a + b, 0) : 0;
  return el('div', { class: 'qcm' }, tour.propositions.map((txt, i) => {
    const classes = ['choix'];
    if (choix === i) classes.push('choisi');
    if (bonne !== null && bonne !== undefined) classes.push(i === bonne ? 'juste' : 'faux');
    const pct = total ? Math.round((stats[i] / total) * 100) : null;
    return el('button', {
      class: classes.join(' '),
      type: 'button',
      disabled: !actif,
      onclick: () => actif && onChoisir && onChoisir(i),
    },
      pct !== null ? el('span', { class: 'jauge', style: `width:${pct}%` }) : null,
      el('b', {}, LETTRES[i]),
      el('span', { class: 'txt' }, txt),
      pct !== null ? el('span', { class: 'pct' }, `${pct} %`) : null,
    );
  }));
}

export function enteteTour(tour) {
  return [
    `Question ${tour.numero}`,
    CATEGORIES[tour.categorie] ?? 'Question',
    tour.manche ? `Manche ${tour.manche}` : null,
    tour.points ? `${tour.points} pt${tour.points > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' · ');
}

// Barre de minuteur animée jusqu'à finIso ; renvoie l'élément.
export function minuteur(debutIso, finIso) {
  const barre = el('div', { class: 'minuteur' }, el('span', { class: 'reste' }), el('b', {}));
  const total = Math.max(1, Date.parse(finIso) - Date.parse(debutIso));
  const maj = () => {
    if (!barre.isConnected) return;
    const reste = Math.max(0, Date.parse(finIso) - maintenant());
    barre.firstChild.style.width = `${(reste / total) * 100}%`;
    barre.lastChild.textContent = reste > 0 ? `${Math.ceil(reste / 1000)} s` : 'Temps écoulé';
    barre.classList.toggle('urgent', reste > 0 && reste < 5000);
    if (reste > 0) requestAnimationFrame(maj);
  };
  requestAnimationFrame(maj);
  return barre;
}

export function voyant(connecte) {
  const v = document.getElementById('voyant');
  if (!v) return;
  v.classList.toggle('ok', connecte);
  v.title = connecte ? 'Temps réel connecté' : 'Temps réel coupé : mise à jour toutes les quelques secondes';
}
