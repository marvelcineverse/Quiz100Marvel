import { rpc, stockage, configOk } from './supa.js';
import { lireFichier, lireGoogleSheet } from './import.js';
import { elementMedia } from './media.js';

const $ = (sel) => document.querySelector(sel);
const CLE_CODE = 'quiz_code_admin';
const CLE_GSHEET = 'quiz_url_gsheet';

let code = null;
let questions = [];

// ---------------------------------------------------------------- utilitaires
function toast(msg, erreur = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('erreur', erreur);
  t.hidden = false;
  clearTimeout(toast.minuteur);
  toast.minuteur = setTimeout(() => { t.hidden = true; }, erreur ? 6000 : 3000);
}

function el(tag, attrs = {}, ...enfants) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of enfants.flat()) if (c !== null && c !== undefined) e.append(c);
  return e;
}

function localLire(cle) { try { return localStorage.getItem(cle); } catch { return null; } }
function localEcrire(cle, v) { try { localStorage.setItem(cle, v); } catch { /* ignoré */ } }

// ---------------------------------------------------------------- connexion
async function connecter(c) {
  await rpc('quiz_admin_connexion', { p_code: c });
  code = c;
  stockage.ecrire(CLE_CODE, c);
  $('#ecran-connexion').hidden = true;
  $('#ecran-admin').hidden = false;
  window.dispatchEvent(new CustomEvent('quiz:connecte', { detail: { code } }));
  await chargerQuestions();
}

$('#form-connexion').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#erreur-connexion');
  err.hidden = true;
  try {
    await connecter($('#code-admin').value);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('#btn-deconnexion').addEventListener('click', () => {
  stockage.effacer(CLE_CODE);
  location.reload();
});

// ---------------------------------------------------------------- onglets
function ouvrirOnglet(nom) {
  document.querySelectorAll('.onglet').forEach(x => x.classList.toggle('actif', x.dataset.onglet === nom));
  document.querySelectorAll('.panneau').forEach(p => { p.hidden = p.id !== `onglet-${nom}`; });
  localEcrire('quiz_onglet_admin', nom);
}
document.querySelectorAll('.onglet').forEach(b => b.addEventListener('click', () => ouvrirOnglet(b.dataset.onglet)));
if (['questions', 'partie', 'reglages'].includes(localLire('quiz_onglet_admin'))) ouvrirOnglet(localLire('quiz_onglet_admin'));

// ---------------------------------------------------------------- import
async function importer(lecture, source) {
  const zone = $('#rapport-import');
  zone.hidden = false;
  zone.className = 'rapport';
  zone.textContent = 'Lecture du tableau…';
  try {
    const r = await lecture();
    if (r.colonnesManquantes.length) {
      throw new Error(`Colonnes manquantes : ${r.colonnesManquantes.join(', ')}`);
    }
    zone.textContent = `${r.lignes.length} questions lues, envoi en base…`;
    const res = await rpc('quiz_admin_importer', {
      p_code: code,
      p_lignes: r.lignes,
      p_ecraser_corrections: $('#ecraser-corrections').checked,
    });
    zone.replaceChildren(
      el('strong', {}, `Import réussi (${source})`),
      el('ul', {},
        el('li', {}, `${res.inserees} nouvelles, ${res.mises_a_jour} mises à jour`),
        res.preservees ? el('li', {}, `${res.preservees} corrections de l'appli préservées`) : null,
        res.retirees ? el('li', {}, `${res.retirees} questions absentes du tableau (marquées « retirées »)`) : null,
        r.exemples ? el('li', {}, `${r.exemples} lignes « Exemple » ignorées`) : null,
        r.doublons.length ? el('li', { class: 'erreur' }, `ID en double ignorés : ${r.doublons.join(', ')}`) : null,
        r.colonnesIgnorees.length ? el('li', { class: 'discret' }, `Colonnes non utilisées : ${r.colonnesIgnorees.join(', ')}`) : null,
      ),
    );
    await chargerQuestions();
  } catch (ex) {
    zone.classList.add('erreur');
    zone.textContent = ex.message;
  }
}

$('#url-gsheet').value = localLire(CLE_GSHEET) || '';
$('#form-gsheet').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#url-gsheet').value.trim();
  localEcrire(CLE_GSHEET, url);
  importer(() => lireGoogleSheet(url, $('#onglet-gsheet').value.trim() || 'Questions'), 'Google Sheets');
});

$('#fichier').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) importer(() => lireFichier(f), f.name);
  e.target.value = '';
});

// ---------------------------------------------------------------- données
async function chargerQuestions() {
  questions = await rpc('quiz_admin_questions', { p_code: code }) ?? [];
  window.dispatchEvent(new CustomEvent('quiz:questions', { detail: { questions } }));
  remplirFiltres();
  afficherBilan();
  afficherListe();
}
$('#btn-recharger').addEventListener('click', () => chargerQuestions().then(() => toast('Liste à jour')));

const actives = () => questions.filter(q => !q.retiree);
const uniques = (vals) => [...new Set(vals.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));

function remplirFiltres() {
  for (const [sel, champ] of [['#f-phase', 'phase_jeu'], ['#f-theme', 'theme']]) {
    const s = $(sel);
    const garde = s.value;
    s.replaceChildren(s.options[0], ...uniques(questions.map(q => q[champ])).map(v => el('option', { value: v }, v)));
    s.value = garde;
  }
}

// ---------------------------------------------------------------- bilan
function afficherBilan() {
  const a = actives();
  const chiffre = (n, libelle, cls = '') => el('div', { class: `chiffre ${cls}` }, el('b', {}, String(n)), el('span', {}, libelle));
  $('#bilan-chiffres').replaceChildren(
    chiffre(a.length, 'questions'),
    chiffre(a.filter(q => q.jouable).length, 'jouables', 'ok'),
    chiffre(a.filter(q => !q.jouable).length, 'à compléter', a.some(q => !q.jouable) ? 'alerte' : ''),
    chiffre(a.filter(q => q.reserve).length, 'réserves'),
    chiffre(a.filter(q => q.modifie_admin).length, 'corrigées ici'),
  );

  const detail = $('#bilan-detail');
  detail.replaceChildren();
  if (!a.length) return;

  // Par phase : manche x zone, nombre de questions jouables hors réserve
  for (const phase of uniques(a.map(q => q.phase_jeu))) {
    const qs = a.filter(q => q.phase_jeu === phase);
    const zones = uniques(qs.map(q => q.manche_zone));
    const manches = uniques(qs.map(q => q.manche_auto != null ? String(q.manche_auto) : null));
    if (!zones.length || zones.length > 12) continue;
    const cellule = (m, z) => {
      const l = qs.filter(q => q.manche_zone === z && (m === null || String(q.manche_auto) === m) && !q.reserve);
      const j = l.filter(q => q.jouable).length;
      return el('td', { class: j < l.length ? 'alerte' : '' }, l.length ? `${j}/${l.length}` : '–');
    };
    detail.append(
      el('h3', {}, phase),
      el('div', { class: 'table-defile' }, el('table', { class: 'mini' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Manche'), zones.map(z => el('th', {}, z)))),
        el('tbody', {}, (manches.length ? manches : [null]).map(m =>
          el('tr', {}, el('th', {}, m ?? 'Toutes'), zones.map(z => cellule(m, z)))))),
      ),
    );
  }

  // Par thème : jouables hors réserve (8 minimum pour la Phase 2 à 4 joueurs)
  const themes = uniques(a.map(q => q.theme));
  if (themes.length) {
    detail.append(
      el('h3', {}, 'Thèmes (jouables hors réserve)'),
      el('div', { class: 'pastilles' }, themes.map(t => {
        const n = a.filter(q => q.theme === t && q.jouable && !q.reserve).length;
        return el('span', { class: `pastille ${n < 8 ? 'alerte' : 'ok'}`, title: n < 8 ? 'Moins de 8 questions' : '' }, `${t} · ${n}`);
      })),
    );
  }
  detail.append(el('p', { class: 'discret' }, 'Une cellule « 2/3 » = 2 jouables sur 3. En orange : questions à compléter, ou thème de moins de 8 questions.'));
}

// ---------------------------------------------------------------- liste
['#f-texte', '#f-phase', '#f-theme', '#f-etat'].forEach(s => $(s).addEventListener('input', afficherListe));

function etatDe(q) {
  if (q.retiree) return el('span', { class: 'etat retiree' }, 'Retirée');
  const badges = [];
  badges.push(q.jouable
    ? el('span', { class: 'etat ok' }, '✓')
    : el('span', { class: 'etat alerte', title: q.problemes.join('\n') }, `⚠ ${q.problemes.length}`));
  if (q.reserve) badges.push(el('span', { class: 'etat' }, 'Réserve'));
  if (q.modifie_admin) badges.push(el('span', { class: 'etat corrigee', title: "Corrigée dans l'appli" }, '✎'));
  return badges;
}

function afficherListe() {
  const t = $('#f-texte').value.trim().toLowerCase();
  const phase = $('#f-phase').value;
  const theme = $('#f-theme').value;
  const etat = $('#f-etat').value;

  const liste = questions.filter(q => {
    if (etat !== 'retiree' && q.retiree) return false;
    if (phase && q.phase_jeu !== phase) return false;
    if (theme && q.theme !== theme) return false;
    if (etat === 'jouable' && !q.jouable) return false;
    if (etat === 'probleme' && q.jouable) return false;
    if (etat === 'reserve' && !q.reserve) return false;
    if (etat === 'corrigee' && !q.modifie_admin) return false;
    if (etat === 'retiree' && !q.retiree) return false;
    if (t) {
      const champs = [q.id, q.question, q.bonne_reponse, q.mauvaise_1, q.mauvaise_2, q.mauvaise_3, q.programme, q.theme, q.notes];
      if (!champs.some(c => c && String(c).toLowerCase().includes(t))) return false;
    }
    return true;
  });

  $('#nb-affichees').textContent = `(${liste.length})`;
  $('#liste-vide').hidden = questions.length > 0;
  $('#table-questions tbody').replaceChildren(...liste.map(q => el('tr', {
    class: q.retiree ? 'grise' : '',
    tabindex: '0',
    onclick: () => ouvrirFiche(q.id),
    onkeydown: (e) => { if (e.key === 'Enter') ouvrirFiche(q.id); },
  },
    el('td', { class: 'mono' }, q.id),
    el('td', {}, q.phase_jeu ?? ''),
    el('td', {}, q.manche_auto ?? ''),
    el('td', {}, q.manche_zone ?? ''),
    el('td', {}, q.theme ?? ''),
    el('td', {}, q.type ?? ''),
    el('td', { class: 'texte-long' }, q.question ?? '—'),
    el('td', { class: 'bonne' }, q.bonne_reponse ?? '—'),
    el('td', { class: 'etats' }, etatDe(q)),
  )));
}

// ---------------------------------------------------------------- fiche
const fiche = $('#fiche');
const form = $('#form-fiche');
let ficheId = null;

function valeursFiche() {
  const v = {};
  for (const champ of form.elements) {
    if (!champ.name) continue;
    if (champ.type === 'checkbox') v[champ.name] = champ.checked;
    else if (champ.type === 'number') v[champ.name] = champ.value === '' ? null : Number(champ.value);
    else v[champ.name] = champ.value.trim() === '' ? null : champ.value.trim();
  }
  return v;
}

function apercu() {
  const v = valeursFiche();
  const zone = $('#apercu');
  const media = v.media ? elementMedia(v.type, v.media) : null;
  zone.replaceChildren(
    el('div', { class: 'apercu-meta' }, [v.phase_jeu, v.manche_zone, v.theme, v.type].filter(Boolean).join(' · ')),
    ...(media ? [media] : []),
    el('p', { class: 'apercu-question' }, v.question ?? '(question vide)'),
    el('div', { class: 'propositions' },
      [['bonne', v.bonne_reponse], ['', v.mauvaise_1], ['', v.mauvaise_2], ['', v.mauvaise_3]]
        .map(([cls, txt], i) => el('div', { class: `proposition ${cls} ${txt ? '' : 'vide'}` },
          el('b', {}, 'ABCD'[i]), txt ?? '(vide)'))),
    el('p', { class: 'discret' }, "En jeu, l'ordre des propositions est mélangé."),
  );
}
form.addEventListener('input', () => { clearTimeout(apercu.t); apercu.t = setTimeout(apercu, 250); });

function ouvrirFiche(id) {
  const q = questions.find(x => x.id === id);
  if (!q) return;
  ficheId = id;
  $('#fiche-id').textContent = id;
  for (const champ of form.elements) {
    if (!champ.name) continue;
    if (champ.type === 'checkbox') champ.checked = !!q[champ.name];
    else champ.value = q[champ.name] ?? '';
  }
  $('#fiche-problemes').replaceChildren(...(q.problemes ?? []).map(p => el('div', { class: 'probleme' }, `⚠ ${p}`)));
  $('#msg-fiche').textContent = q.modifie_admin
    ? "Déjà corrigée dans l'appli : un prochain import ne l'écrasera pas (sauf option cochée)."
    : '';
  apercu();
  fiche.showModal();
}

fiche.querySelectorAll('[data-fermer]').forEach(b => b.addEventListener('click', () => fiche.close()));

$('#btn-enregistrer').addEventListener('click', async () => {
  const bouton = $('#btn-enregistrer');
  bouton.disabled = true;
  try {
    const maj = await rpc('quiz_admin_modifier_question', { p_code: code, p_id: ficheId, p_champs: valeursFiche() });
    const i = questions.findIndex(q => q.id === ficheId);
    if (i >= 0) questions[i] = maj;
    afficherBilan();
    afficherListe();
    fiche.close();
    toast(maj.jouable ? `${ficheId} enregistrée` : `${ficheId} enregistrée, mais encore incomplète`, !maj.jouable);
  } catch (ex) {
    toast(ex.message, true);
  } finally {
    bouton.disabled = false;
  }
});

// ---------------------------------------------------------------- réglages
$('#form-code').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#msg-code');
  const nouveau = $('#nouveau-code').value;
  try {
    await rpc('quiz_admin_changer_code', { p_code: code, p_nouveau: nouveau });
    code = nouveau;
    stockage.ecrire(CLE_CODE, nouveau);
    window.dispatchEvent(new CustomEvent('quiz:connecte', { detail: { code } }));
    msg.textContent = 'Code modifié.';
    $('#nouveau-code').value = '';
  } catch (ex) {
    msg.textContent = ex.message;
  }
  msg.hidden = false;
});

// ---------------------------------------------------------------- démarrage
if (!configOk) {
  const err = $('#erreur-connexion');
  err.textContent = 'Supabase non configuré : renseigne js/config.js (URL et clé anon).';
  err.hidden = false;
} else {
  const memo = stockage.lire(CLE_CODE);
  if (memo) connecter(memo).catch(() => stockage.effacer(CLE_CODE));
}
