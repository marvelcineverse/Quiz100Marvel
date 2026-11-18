// Affichage des médias (image, audio, vidéo) à partir d'une URL.

// Convertit les liens de partage Google Drive en liens affichables.
export function urlAffichable(url, genre) {
  if (!url) return null;
  const drive = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:.*&)?id=)([a-zA-Z0-9_-]+)/);
  if (drive) {
    return genre === 'image'
      ? `https://lh3.googleusercontent.com/d/${drive[1]}`
      : `https://drive.google.com/uc?export=download&id=${drive[1]}`;
  }
  return url;
}

// Devine le genre de média depuis le type de question puis l'extension.
export function genreMedia(type, url) {
  if (!url) return null;
  const t = String(type || '').toLowerCase();
  if (t.startsWith('image')) return 'image';
  if (t.startsWith('audio')) return 'audio';
  if (t.startsWith('vid')) return 'video';
  const ext = url.split('?')[0].split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'opus'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  return 'image';
}

// Crée l'élément HTML du média (ou null)
export function elementMedia(type, url, { controles = true, lecture = false } = {}) {
  const genre = genreMedia(type, url);
  if (!genre) return null;
  const src = urlAffichable(url, genre);
  let el;
  if (genre === 'image') {
    el = document.createElement('img');
    el.alt = '';
    el.referrerPolicy = 'no-referrer';
  } else if (genre === 'youtube') {
    const id = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{6,})/)?.[1];
    el = document.createElement('iframe');
    el.src = `https://www.youtube-nocookie.com/embed/${id}${lecture ? '?autoplay=1' : ''}`;
    el.allow = 'autoplay; encrypted-media';
    el.className = 'media media-youtube';
    return el;
  } else {
    el = document.createElement(genre);
    el.controls = controles;
    el.autoplay = lecture;
    el.preload = 'auto';
  }
  el.src = src;
  el.className = `media media-${genre}`;
  el.addEventListener('error', () => {
    const msg = document.createElement('div');
    msg.className = 'media-erreur';
    msg.textContent = `Média illisible : ${url}`;
    el.replaceWith(msg);
  }, { once: true });
  return el;
}
