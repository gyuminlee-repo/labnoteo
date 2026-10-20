(() => {
  'use strict';

  const lang = document.body.dataset.lang || 'ko';
  const media = document.body.dataset.media || 'media/';
  const text = {
    ko: {
      pending: '영상 준비 중',
      screenPending: '화면 사진 준비 중',
      recorded: (v, s) => `labnoteo ${v} · ${s}초`,
      captions: '한국어',
      versions: (vs) => `영상은 labnoteo ${vs} 기준입니다.`,
    },
    en: {
      pending: 'Clip coming soon',
      screenPending: 'Screenshot coming soon',
      recorded: (v, s) => `labnoteo ${v} · ${s}s`,
      captions: 'English',
      versions: (vs) => `Clips recorded with labnoteo ${vs}.`,
    },
  }[lang];

  function placeholder(el, label) {
    const box = document.createElement('div');
    box.className = 'placeholder';
    box.textContent = label;
    el.prepend(box);
    el.classList.add('pending');
  }

  function videoFor(id, clip) {
    const base = `${media}${lang}/${id}`;
    const v = document.createElement('video');
    v.controls = true;
    v.muted = true;
    v.playsInline = true;
    v.preload = 'none';
    v.poster = `${base}.jpg`;
    v.width = 1280;
    v.height = 860;
    const src = document.createElement('source');
    src.src = `${base}.mp4`;
    src.type = 'video/mp4';
    const track = document.createElement('track');
    track.kind = 'captions';
    track.srclang = lang;
    track.label = text.captions;
    track.src = `${base}.vtt`;
    v.append(src, track);
    const meta = document.createElement('span');
    meta.className = 'clip-meta';
    meta.textContent = text.recorded(clip.version, Math.round(clip.durationSec));
    return { v, meta };
  }

  function renderClips(clips) {
    const byId = new Map(clips.filter(c => c.lang === lang).map(c => [c.id, c]));
    for (const fig of document.querySelectorAll('figure.clip[data-clip]')) {
      const clip = byId.get(fig.dataset.clip);
      if (!clip) {
        placeholder(fig, text.pending);
        continue;
      }
      const { v, meta } = videoFor(fig.dataset.clip, clip);
      fig.prepend(v);
      const cap = fig.querySelector('figcaption');
      if (cap) cap.append(' ', meta);
    }
    const versions = [...new Set([...byId.values()].map(c => c.version))].sort();
    const note = document.querySelector('[data-recorded-version]');
    if (note && versions.length) note.textContent = text.versions(versions.join(', '));
  }

  function renderScreens() {
    for (const fig of document.querySelectorAll('figure.screen[data-screen]')) {
      const img = new Image();
      img.alt = fig.querySelector('figcaption')?.textContent || '';
      img.loading = 'lazy';
      img.onerror = () => {
        img.remove();
        placeholder(fig, text.screenPending);
      };
      img.src = `${media}screens/${fig.dataset.screen}.png`;
      fig.prepend(img);
    }
  }

  function trackToc() {
    const links = new Map(
      [...document.querySelectorAll('.toc a[href^="#"]')].map(a => [a.getAttribute('href').slice(1), a]),
    );
    const sections = [...links.keys()].map(id => document.getElementById(id)).filter(Boolean);
    if (!('IntersectionObserver' in window) || !sections.length) return;
    const visible = new Set();
    const io = new IntersectionObserver(entries => {
      for (const e of entries) (e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id));
      const current = sections.find(s => visible.has(s.id));
      if (!current) return;
      for (const [id, a] of links) a.classList.toggle('active', id === current.id);
    }, { rootMargin: '-15% 0px -70% 0px' });
    sections.forEach(s => io.observe(s));
  }

  function keepHashOnLanguageSwitch() {
    const sw = document.querySelector('[data-lang-switch]');
    if (!sw) return;
    sw.addEventListener('click', () => {
      if (location.hash) sw.setAttribute('href', sw.getAttribute('href').split('#')[0] + location.hash);
    });
  }

  fetch(`${media}manifest.json`, { cache: 'no-cache' })
    .then(r => (r.ok ? r.json() : { clips: [] }))
    .catch(() => ({ clips: [] }))
    .then(m => renderClips(Array.isArray(m.clips) ? m.clips : []));
  renderScreens();
  trackToc();
  keepHashOnLanguageSwitch();
})();
