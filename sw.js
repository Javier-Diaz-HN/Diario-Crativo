const CACHE = 'diario-v1';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith('diario-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Android "Compartir → Diario": guarda lo recibido y abre la app
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const fd = await req.formData();
      const c = await caches.open('share');
      for (const k of await c.keys()) await c.delete(k);
      const files = fd.getAll('files').filter(f => f && f.size);
      let i = 0;
      for (const f of files) {
        await c.put('/__shared/' + i++, new Response(f, { headers: { 'Content-Type': f.type } }));
      }
      const meta = { title: fd.get('title') || '', text: fd.get('text') || '', url: fd.get('url') || '', n: i };
      await c.put('/__shared/meta', new Response(JSON.stringify(meta)));
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // Primero lo guardado (rápido y sin internet); actualiza en segundo plano
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const refresh = fetch(req).then(r => { if (r.ok) cache.put(req, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    return (await refresh) || new Response('Sin conexión', { status: 503 });
  })());
});
