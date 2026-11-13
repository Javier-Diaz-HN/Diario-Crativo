'use strict';
/* Sincronización con Supabase.
   - Local primero: todo se guarda en el dispositivo y se sube cuando hay internet.
   - Si dos dispositivos editan lo mismo, gana la edición más reciente.
   - Las posiciones de vista (zoom/desplazamiento) son propias de cada dispositivo y no se sincronizan.
   Usa las variables de app.js (boards, allItems, dbPut, renderLayer, …). */
(function () {
  const cfg = window.SYNC_CONFIG || {};
  const BUCKET = 'media';
  const S = { enabled: false, state: 'off', msg: '', email: '' };
  let sb = null, userId = null, running = false, rerun = false, timer = null, chan = null;
  const missed = new Set();
  const LS = k => 'sync.' + k;
  const g$ = id => document.getElementById(id);
  const path = blobId => userId + '/' + blobId;

  /* ----- estado visible ----- */
  const LABEL = {
    off: 'Sincronización no configurada',
    login: 'Inicia sesión para sincronizar',
    sync: 'Sincronizando…',
    ok: 'Sincronizado',
    offline: 'Sin conexión: se sincronizará al volver',
    error: 'No se pudo sincronizar'
  };
  function setState(st, msg) { S.state = st; S.msg = msg || ''; renderUI(); }
  function renderUI() {
    const b = g$('syncBtn'); if (!b) return;
    b.dataset.state = S.state;
    b.title = LABEL[S.state] || '';
    const m = g$('syncMsg');
    if (m) m.textContent = (LABEL[S.state] || '') + (S.state === 'error' && S.msg ? ' — ' + S.msg : '') + (S.email && S.state !== 'login' ? '\n' + S.email : '');
    g$('loginForm').hidden = !(S.enabled && S.state === 'login');
    g$('syncActions').hidden = !(S.enabled && S.state !== 'login');
  }

  /* ----- conversión local ↔ servidor ----- */
  const toRB = b => ({ id: b.id, name: b.name, created: b.created, updated: b.updated, deleted: !!b.deleted });
  const toRI = i => ({
    id: i.id, board_id: i.boardId, type: i.type, x: i.x, y: i.y, w: i.w, text: i.text ?? null,
    blob_id: i.blobId ?? null, created: i.created, updated: i.updated, deleted: !!i.deleted
  });
  const fromRI = r => ({
    id: r.id, boardId: r.board_id, type: r.type, x: r.x, y: r.y, w: r.w, text: r.text ?? undefined,
    blobId: r.blob_id ?? undefined, created: Number(r.created), updated: Number(r.updated), deleted: !!r.deleted
  });
  const tooBig = e => e && (/exceed|too large|payload|size/i.test(e.message || '') || e.statusCode == 413 || e.status == 413);

  /* ----- subir ----- */
  async function push() {
    const t0 = Date.now();
    const last = Number(localStorage.getItem(LS('push')) || 0);
    const lb = (await dbAll('boards')).filter(b => b.updated > last);
    const li = (await dbAll('items')).filter(i => i.updated > last);
    if (!lb.length && !li.length) { localStorage.setItem(LS('push'), t0); return; }

    for (const it of li) {
      if (!it.blobId) continue;
      if (it.deleted) { try { await sb.storage.from(BUCKET).remove([path(it.blobId)]); } catch {} continue; }
      const rec = await dbGet('blobs', it.blobId);
      if (rec && !rec.up) {
        const { error } = await sb.storage.from(BUCKET).upload(path(it.blobId), rec.blob, { upsert: true, contentType: rec.blob.type || undefined });
        if (error && !tooBig(error)) throw error;
        rec.up = error ? 'skip' : true;
        await dbPut('blobs', rec, true);
      }
    }
    if (lb.length) {
      const { error } = await sb.from('boards').upsert(lb.map(toRB), { onConflict: 'id' });
      if (error) throw error;
    }
    for (let i = 0; i < li.length; i += 200) {
      const { error } = await sb.from('items').upsert(li.slice(i, i + 200).map(toRI), { onConflict: 'id' });
      if (error) throw error;
    }
    localStorage.setItem(LS('push'), t0);
  }

  /* ----- bajar ----- */
  async function applyBoard(r) {
    const l = await dbGet('boards', r.id);
    if (l && l.updated >= Number(r.updated)) return false;
    await dbPut('boards', {
      id: r.id, name: r.name, created: Number(r.created), updated: Number(r.updated), deleted: !!r.deleted,
      view: (l && l.view) || { x: 0, y: 0, k: 1 }
    }, true);
    return true;
  }
  async function applyItem(r) {
    const l = await dbGet('items', r.id);
    if (l && l.updated >= Number(r.updated)) return false;
    const it = fromRI(r);
    await dbPut('items', it, true);
    if (it.deleted && it.blobId) {
      await dbDel('blobs', it.blobId);
      const u = urls.get(it.blobId);
      if (u) { URL.revokeObjectURL(u); urls.delete(it.blobId); }
    }
    return true;
  }
  async function pull() {
    let changed = false;
    for (const [table, apply] of [['boards', applyBoard], ['items', applyItem]]) {
      let cur = localStorage.getItem(LS('cur.' + table)) || '1970-01-01T00:00:00+00:00';
      for (;;) {
        const { data, error } = await sb.from(table).select('*').gt('srv', cur).order('srv', { ascending: true }).limit(500);
        if (error) throw error;
        if (!data.length) break;
        for (const r of data) if (await apply(r)) changed = true;
        cur = data[data.length - 1].srv;
        localStorage.setItem(LS('cur.' + table), cur);
        if (data.length < 500) break;
      }
    }
    return changed;
  }
  async function ensureBlobs() {
    let got = false;
    for (const it of (await dbAll('items')).filter(i => i.blobId && !i.deleted)) {
      if (missed.has(it.blobId) || await dbGet('blobs', it.blobId)) continue;
      const { data, error } = await sb.storage.from(BUCKET).download(path(it.blobId));
      if (error || !data) { missed.add(it.blobId); continue; }
      await dbPut('blobs', { id: it.blobId, blob: data, up: true }, true);
      got = true;
    }
    return got;
  }

  /* En un dispositivo nuevo la app crea una pizarra vacía; tras la primera sincronización se quita sola. */
  async function firstSyncCleanup() {
    if (localStorage.getItem(LS('first'))) return false;
    localStorage.setItem(LS('first'), '1');
    const all = (await dbAll('boards')).filter(b => !b.deleted);
    const items = (await dbAll('items')).filter(i => !i.deleted);
    let changed = false;
    for (const b of all) {
      if (b.auto && all.length > 1 && !items.some(i => i.boardId === b.id)) {
        b.deleted = true; b.updated = Date.now();
        await dbPut('boards', b, true);
        changed = true;
      }
    }
    return changed;
  }

  /* ----- refrescar pantalla tras recibir cambios ----- */
  function busy() { return !!g || !!document.querySelector('.txt.editing'); }
  async function refreshUI() {
    if (busy()) { setTimeout(refreshUI, 1200); return; }
    boards = (await dbAll('boards')).filter(b => !b.deleted).sort((a, b) => a.created - b.created);
    allItems = (await dbAll('items')).filter(i => !i.deleted);
    if (!boards.length) await newBoard('Mi primera pizarra', true);
    if (!boards.find(b => b.id === cur)) { await openBoard(boards[0].id); return; }
    renderBoards();
    const nm = g$('boardName');
    if (document.activeElement !== nm) nm.value = curBoard().name;
    if (mode === 'board') await renderLayer(); else await renderDiary();
  }

  /* ----- ciclo principal ----- */
  async function run() {
    if (!S.enabled || !sb) return;
    if (running) { rerun = true; return; }
    running = true;
    try {
      const { data } = await sb.auth.getSession();
      const session = data && data.session;
      if (!session) { setState('login'); return; }
      userId = session.user.id; S.email = session.user.email || '';
      setState('sync');
      let changed = await pull();
      if (await ensureBlobs()) changed = true;
      if (await firstSyncCleanup()) changed = true;
      await push();
      setState('ok');
      if (changed) await refreshUI();
      listen();
    } catch (e) {
      console.warn('sync:', e);
      setState(navigator.onLine === false ? 'offline' : 'error', (e && e.message) || String(e));
    } finally {
      running = false;
      if (rerun) { rerun = false; schedule(500); }
    }
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(run, ms); }

  function listen() {
    if (chan || !sb.channel) return;
    try {
      chan = sb.channel('diario-cambios')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, () => schedule(400))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'boards' }, () => schedule(400))
        .subscribe();
    } catch (e) { console.warn('realtime:', e); }
  }

  /* ----- pantalla de sincronización ----- */
  function bindUI() {
    g$('syncBtn').onclick = () => { renderUI(); g$('syncModal').hidden = false; };
    g$('syncClose').onclick = () => { g$('syncModal').hidden = true; };
    g$('syncModal').onclick = e => { if (e.target.id === 'syncModal') g$('syncModal').hidden = true; };
    g$('loginForm').onsubmit = async e => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      const { error } = await sb.auth.signInWithPassword({ email: g$('syEmail').value.trim(), password: g$('syPass').value });
      btn.disabled = false;
      if (error) { g$('syncMsg').textContent = 'No se pudo entrar: ' + error.message; return; }
      g$('syPass').value = '';
      g$('syncModal').hidden = true;
      schedule(100);
    };
    g$('syncNow').onclick = () => { missed.clear(); g$('syncModal').hidden = true; schedule(0); };
    g$('syncOut').onclick = async () => {
      await sb.auth.signOut();
      chan && sb.removeChannel && sb.removeChannel(chan); chan = null;
      setState('login');
    };
  }

  window.Sync = {
    state: () => S.state,
    now: () => { missed.clear(); return run(); },
    touch: () => { if (S.enabled) schedule(1500); },
    init() {
      bindUI();
      if (!cfg.url || !cfg.key || !window.supabase) { renderUI(); return; }
      S.enabled = true;
      sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'diario-auth' } });
      sb.auth.onAuthStateChange(ev => {
        if (ev === 'SIGNED_OUT') setState('login');
        else if (ev === 'SIGNED_IN' || ev === 'TOKEN_REFRESHED') schedule(300);
      });
      window.addEventListener('online', () => { missed.clear(); schedule(300); });
      window.addEventListener('offline', () => setState('offline'));
      document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(300); });
      setInterval(() => { if (!document.hidden) schedule(0); }, 45000);
      setState('sync');
      schedule(100);
    }
  };
})();
