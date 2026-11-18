// Lecture du tableau de questions (Google Sheets, xlsx ou csv).
// Les fonctions "pures" (sans navigateur) sont testables avec Node.

// En-tête du tableau (normalisé) -> colonne en base
const CORRESPONDANCE = {
  'id': 'id',
  'phase du jeu': 'phase_jeu',
  'manche zone': 'manche_zone',
  'theme': 'theme',
  'programme': 'programme',
  'programme tag': 'programme',
  'type': 'type',
  'difficulte': 'difficulte',
  'question': 'question',
  'bonne reponse': 'bonne_reponse',
  'mauvaise proposition 1': 'mauvaise_1',
  'mauvaise proposition 2': 'mauvaise_2',
  'mauvaise proposition 3': 'mauvaise_3',
  'media': 'media',
  'source': 'source',
  'statut': 'statut',
  'reserve': 'reserve',
  'notes': 'notes',
  'manche auto': 'manche_auto',
};

const COLONNES_REQUISES = ['id', 'question', 'bonne_reponse', 'mauvaise_1', 'mauvaise_2', 'mauvaise_3'];

export function normaliserEntete(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function texte(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export function versBooleen(v) {
  const s = normaliserEntete(v);
  return ['oui', 'o', 'x', 'vrai', 'true', '1', 'yes', 'y', 'reserve'].includes(s) || String(v).trim() === '✓';
}

export function versEntier(v) {
  const m = String(v ?? '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// rows : tableau de tableaux (première ligne d'en-tête quelque part dans les 10 premières)
export function lignesDepuisTableau(rows) {
  const rapport = { lignes: [], exemples: 0, vides: 0, doublons: [], colonnesManquantes: [], colonnesIgnorees: [] };

  const idxEntete = rows.slice(0, 10).findIndex(r => {
    const n = (r || []).map(normaliserEntete);
    return n.includes('id') && n.includes('question');
  });
  if (idxEntete < 0) {
    throw new Error('En-tête introuvable : il faut au moins les colonnes "ID" et "Question".');
  }

  const entetes = rows[idxEntete].map(normaliserEntete);
  const colonnes = entetes.map(e => CORRESPONDANCE[e] ?? null);
  rapport.colonnesIgnorees = rows[idxEntete].filter((e, i) => texte(e) && !colonnes[i]).map(String);
  rapport.colonnesManquantes = COLONNES_REQUISES.filter(c => !colonnes.includes(c));

  const vus = new Set();
  rows.slice(idxEntete + 1).forEach((r, i) => {
    const brut = {};
    colonnes.forEach((col, j) => { if (col && brut[col] == null) brut[col] = r?.[j]; });

    const q = {
      ordre: i + 1,
      id: texte(brut.id),
      phase_jeu: texte(brut.phase_jeu),
      manche_zone: texte(brut.manche_zone),
      theme: texte(brut.theme),
      programme: texte(brut.programme),
      type: texte(brut.type),
      difficulte: texte(brut.difficulte),
      question: texte(brut.question),
      bonne_reponse: texte(brut.bonne_reponse),
      mauvaise_1: texte(brut.mauvaise_1),
      mauvaise_2: texte(brut.mauvaise_2),
      mauvaise_3: texte(brut.mauvaise_3),
      media: texte(brut.media),
      source: texte(brut.source),
      statut: texte(brut.statut),
      reserve: versBooleen(brut.reserve),
      notes: texte(brut.notes),
      manche_auto: versEntier(brut.manche_auto),
    };

    if (!q.id && !q.question) { rapport.vides++; return; }
    if (normaliserEntete(q.statut) === 'exemple') { rapport.exemples++; return; }
    if (!q.id) { q.id = `SANS-ID-${i + 1}`; }
    if (vus.has(q.id)) { rapport.doublons.push(q.id); return; }
    vus.add(q.id);
    rapport.lignes.push(q);
  });

  return rapport;
}

// Lien Google Sheets -> URL d'export CSV de l'onglet voulu
export function urlCsvGoogleSheet(url, onglet = 'Questions') {
  const id = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1];
  if (!id) throw new Error('Lien Google Sheets non reconnu.');
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(onglet)}`;
}

// --- Fonctions navigateur (utilisent window.XLSX, chargé dans admin.html) ---

function lignesDepuisClasseur(classeur) {
  const nom = classeur.SheetNames.find(n => normaliserEntete(n) === 'questions') ?? classeur.SheetNames[0];
  const feuille = classeur.Sheets[nom];
  return window.XLSX.utils.sheet_to_json(feuille, { header: 1, defval: '', raw: false, blankrows: false });
}

export async function lireFichier(fichier) {
  // CSV lu comme texte UTF-8 (sinon les accents des en-têtes sont perdus)
  const classeur = /\.(csv|tsv|txt)$/i.test(fichier.name)
    ? window.XLSX.read((await fichier.text()).replace(/^﻿/, ''), { type: 'string', raw: true })
    : window.XLSX.read(await fichier.arrayBuffer(), { type: 'array' });
  return lignesDepuisTableau(lignesDepuisClasseur(classeur));
}

export async function lireGoogleSheet(url, onglet = 'Questions') {
  let rep;
  try {
    rep = await fetch(urlCsvGoogleSheet(url, onglet));
  } catch {
    throw new Error('Google Sheets inaccessible. Le tableau est-il partagé en "Tous les utilisateurs disposant du lien" ?');
  }
  const csv = await rep.text();
  if (!rep.ok || /^\s*<!DOCTYPE|<html/i.test(csv)) {
    throw new Error(`Lecture impossible (onglet "${onglet}" absent ou tableau non partagé par lien).`);
  }
  const classeur = window.XLSX.read(csv, { type: 'string', raw: true });
  return lignesDepuisTableau(lignesDepuisClasseur(classeur));
}
