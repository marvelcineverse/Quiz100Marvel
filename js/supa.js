import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const configOk = !SUPABASE_URL.includes('VOTRE-PROJET.') && !SUPABASE_ANON_KEY.includes('VOTRE-CLE');

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

// Appelle une fonction SQL et renvoie son résultat, ou lève une Error lisible.
export async function rpc(nom, args = {}) {
  const { data, error } = await sb.rpc(nom, args);
  if (error) throw new Error(error.message || String(error));
  return data;
}

// Petit stockage local tolérant aux navigateurs qui le bloquent.
export const stockage = {
  lire(cle) { try { return sessionStorage.getItem(cle); } catch { return null; } },
  ecrire(cle, v) { try { sessionStorage.setItem(cle, v); } catch { /* ignoré */ } },
  effacer(cle) { try { sessionStorage.removeItem(cle); } catch { /* ignoré */ } },
};
