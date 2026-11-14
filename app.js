'use strict';
/* Diario — pizarras + diario, todo guardado en el dispositivo (IndexedDB), funciona sin internet.
   Cada registro lleva `updated` y `deleted` para poder sincronizar después (última edición gana). */

const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const now = () => Date.now();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- IndexedDB ---------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('diario', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('boards', { keyPath: 'id' });
      d.createObjectStore('items', { keyPath: 'id' }).createIndex('boardId', 'boardId');
      d.createObjectStore('blobs', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const store = (n, m = 'readonly') => db.transaction(n, m).objectStore(n);
const dbPut = (n, v, quiet) => {
  const r = rq(store(n, 'readwrite').put(v));
  if (!quiet && (n === 'items' || n === 'boards') && window.Sync) Sync.touch();   // avisa a la sincronización
  return r;
};
const dbAll = n => rq(store(n).getAll());
const dbGet = (n, k) => rq(store(n).get(k));
const dbDel = (n, k) => rq(store(n, 'readwrite').delete(k));

/* ---------- Estado ---------- */
let boards = [], allItems = [], cur = null, sel = null, mode = 'board';
let view = { x: 0, y: 0, k: 1 };
const urls = new Map();

const curBoard = () => boards.find(b => b.id === cur);
const findItem = id => allItems.find(i => i.id === id);
const cardEl = id => document.querySelector(`.card[data-id="${id}"]`);
const vp = $('#viewport'), layer = $('#layer');

async function blobURL(id) {
  if (urls.has(id)) return urls.get(id);
  const rec = await dbGet('blobs', id);
  if (!rec) return null;
  const u = URL.createObjectURL(rec.blob);
  urls.set(id, u);
  return u;
}

/* ---------- Pizarras ---------- */
async function newBoard(name, auto) {
  const b = { id: uid(), name: name || 'Nueva pizarra', created: now(), updated: now(), view: { x: 0, y: 0, k: 1 } };
  if (auto) b.auto = true;   // pizarra inicial automática
  boards.push(b);
  await dbPut('boards', b);
  return b;
}

async function openBoard(id) {
  saveViewNow();
  cur = id;
  const b = curBoard();
  view = { ...(b.view || { x: 0, y: 0, k: 1 }) };
  localStorage.setItem('lastBoard', id);
  sel = null;
  $('#boardName').value = b.name;
  renderBoards();
  await renderLayer();
  setMode('board');
}

function renderBoards() {
  const nav = $('#boards');
  nav.innerHTML = '';
  for (const b of boards) {
    const el = document.createElement('button');
    el.className = 'bd' + (b.id === cur ? ' on' : '');
    el.textContent = b.name || 'Sin nombre';
    el.onclick = () => { closeDrawer(); openBoard(b.id); };
    nav.append(el);
  }
  const f = $('#diaryFilter'), prev = f.value;
  f.innerHTML = '<option value="">Todas las pizarras</option>' +
    boards.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  f.value = prev;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

$('#newBoard').onclick = async () => {
  const b = await newBoard();
  closeDrawer();
  await openBoard(b.id);
  const inp = $('#boardName'); inp.focus(); inp.select();
};

$('#boardName').onchange = async e => {
  const b = curBoard(); if (!b) return;
  b.name = e.target.value.trim() || 'Sin nombre';
  e.target.value = b.name;
  b.updated = now();
  await dbPut('boards', b);
  renderBoards();
};
$('#boardName').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };

$('#more').onclick = async () => {
  const b = curBoard(); if (!b) return;
  if (!confirm(`¿Eliminar la pizarra "${b.name}" y todo su contenido?`)) return;
  for (const it of allItems.filter(i => i.boardId === b.id)) await removeItemData(it);
  allItems = allItems.filter(i => i.boardId !== b.id);
  b.deleted = true; b.updated = now();
  await dbPut('boards', b);
  boards = boards.filter(x => x.id !== b.id);
  if (!boards.length) await newBoard('Mi primera pizarra');
  cur = null;
  await openBoard(boards[0].id);
};

/* ---------- Lienzo ---------- */
function applyView() {
  layer.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`;
  const s = 24 * view.k;
  vp.style.backgroundSize = `${s}px ${s}px`;
  vp.style.backgroundPosition = `${view.x}px ${view.y}px`;
  placeBar();
}

let viewTimer;
function saveView() { clearTimeout(viewTimer); viewTimer = setTimeout(saveViewNow, 400); }
function saveViewNow() {
  clearTimeout(viewTimer);
  const b = curBoard(); if (!b) return;
  b.view = { ...view };
  dbPut('boards', b, true);   // la vista es propia de cada dispositivo: no se sincroniza
}

async function renderLayer() {
  layer.querySelectorAll('.card').forEach(c => c.remove());
  const list = allItems.filter(i => i.boardId === cur && i.type !== 'conn');
  const els = await Promise.all(list.map(makeCard));
  els.forEach(e => e && layer.append(e));
  $('#empty').hidden = list.length > 0;
  applyView();
  drawLines();
}

async function makeCard(it) {
  const el = document.createElement('div');
  el.className = 'card ' + it.type;
  el.dataset.id = it.id;
  el.style.left = it.x + 'px';
  el.style.top = it.y + 'px';
  el.style.width = it.w + 'px';
  if (it.type === 'text') {
    const t = document.createElement('div');
    t.className = 'txt';
    el.append(t);
    paintText(el, it);
  } else {
    const u = await blobURL(it.blobId);
    if (!u) return null;
    const m = document.createElement(it.type === 'image' ? 'img' : 'video');
    m.src = u;
    if (it.type === 'image') { m.draggable = false; m.alt = ''; }
    else { m.controls = true; m.preload = 'metadata'; m.playsInline = true; }
    el.append(m);
  }
  const rs = document.createElement('div'); rs.className = 'rs';
  const del = document.createElement('button'); del.className = 'del'; del.textContent = '×'; del.setAttribute('aria-label', 'Eliminar');
  del.onclick = () => deleteItem(it.id);
  const tools = document.createElement('div');
  tools.className = 'tools';
  tools.innerHTML = '<button class="t-conn">Conectar</button><button class="t-child">+ Idea</button>';
  tools.querySelector('.t-conn').onclick = () => startConnect(it.id);
  tools.querySelector('.t-child').onclick = () => addChild(it.id);
  el.append(rs, del, tools);
  ro.observe(el);                           // si la tarjeta cambia de alto (foto cargada, texto), la línea la sigue
  if (it.id === sel) el.classList.add('sel');
  return el;
}

function select(id) {
  if (selConn) selectConn(null);
  sel = id;
  document.querySelectorAll('.card.sel').forEach(c => c.classList.remove('sel'));
  if (id) cardEl(id)?.classList.add('sel');
}

async function saveItem(it) { it.updated = now(); await dbPut('items', it); }

async function removeItemData(it) {
  it.deleted = true; it.updated = now();
  await dbPut('items', it);
  if (it.blobId) {
    await dbDel('blobs', it.blobId);
    const u = urls.get(it.blobId);
    if (u) { URL.revokeObjectURL(u); urls.delete(it.blobId); }
  }
}

async function deleteItem(id) {
  const it = findItem(id); if (!it) return;
  if (it.type !== 'conn') {
    for (const c of allItems.filter(i => i.type === 'conn' && (i.a === id || i.b === id))) {
      allItems = allItems.filter(i => i !== c);
      await removeItemData(c);
    }
  }
  cardEl(id)?.remove();
  allItems = allItems.filter(i => i.id !== id);
  if (sel === id) sel = null;
  if (selConn === id) selConn = null;
  await removeItemData(it);
  $('#empty').hidden = allItems.some(i => i.boardId === cur && i.type !== 'conn');
  drawLines();
}

function viewCenter() {
  return { x: (vp.clientWidth / 2 - view.x) / view.k, y: (vp.clientHeight / 2 - view.y) / view.k };
}

/* ---------- Gestos: arrastrar, mover, redimensionar, pellizcar ---------- */
const ptrs = new Map();
let g = null;

vp.addEventListener('pointerdown', e => {
  if (e.target.closest('.txt.editing')) return;
  if (e.target.closest('#cbar, #hint')) return;
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains('editing')) ae.blur();
  if (connectFrom) {                          // modo conectar: el siguiente toque elige la tarjeta destino
    const card = e.target.closest('.card'), from = connectFrom;
    endConnect();
    if (card && card.dataset.id !== from) addConn(from, card.dataset.id);
    return;
  }
  const cn = e.target.closest('.cn');         // tocar una línea la selecciona
  if (cn) { select(null); selectConn(cn.dataset.id); return; }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) { startPinch(); return; }
  if (ptrs.size > 2) return;
  if (e.target.closest('.del, .tools')) return;
  const card = e.target.closest('.card');
  if (card) {
    const id = card.dataset.id, it = findItem(id);
    const wasSel = sel === id;
    select(id);
    g = { type: e.target.closest('.rs') ? 'resize' : 'drag', id, pid: e.pointerId, sx: e.clientX, sy: e.clientY,
      ox: it.x, oy: it.y, ow: it.w, moved: false, wasSel, onLink: !!e.target.closest('a, .embed') };
  } else {
    select(null);
    g = { type: 'pan', pid: e.pointerId, sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
  }
});

vp.addEventListener('pointermove', e => {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!g) return;
  if (g.type === 'pinch') { doPinch(); return; }
  if (e.pointerId !== g.pid) return;
  const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
  if (!g.moved) {
    if (Math.hypot(dx, dy) < 5) return;
    g.moved = true;
    try { vp.setPointerCapture(e.pointerId); } catch {}
  }
  if (g.type === 'pan') { view.x = g.ox + dx; view.y = g.oy + dy; applyView(); return; }
  const it = findItem(g.id), el = cardEl(g.id);
  if (!it || !el) return;
  if (g.type === 'drag') {
    it.x = g.ox + dx / view.k; it.y = g.oy + dy / view.k;
    el.style.left = it.x + 'px'; el.style.top = it.y + 'px';
    scheduleLines();
  } else {
    it.w = Math.max(90, g.ow + dx / view.k);
    el.style.width = it.w + 'px';
    scheduleLines();
  }
});

function endPointer(e) {
  ptrs.delete(e.pointerId);
  if (!g) return;
  if (g.type === 'pinch') { if (ptrs.size < 2) { g = null; saveView(); } return; }
  if (e.pointerId !== g.pid) return;
  if (g.moved) {
    if (g.type === 'pan') saveView(); else { const it = findItem(g.id); it && saveItem(it); }
  } else if (g.type === 'drag' && g.wasSel && !g.onLink) {
    const it = findItem(g.id);
    if (it && it.type === 'text') editText(it.id);
  }
  g = null;
}
vp.addEventListener('pointerup', endPointer);
vp.addEventListener('pointercancel', endPointer);

function pinchMetrics() {
  const [a, b] = [...ptrs.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}
function startPinch() {
  if (g && g.moved && g.type !== 'pan') { const it = findItem(g.id); it && saveItem(it); }
  const m = pinchMetrics(), r = vp.getBoundingClientRect();
  g = { type: 'pinch', d0: m.d, k0: view.k, wx: (m.mx - r.left - view.x) / view.k, wy: (m.my - r.top - view.y) / view.k };
}
function doPinch() {
  if (ptrs.size < 2) return;
  const m = pinchMetrics(), r = vp.getBoundingClientRect();
  const k = clamp(g.k0 * m.d / g.d0, .15, 4);
  view.k = k;
  view.x = m.mx - r.left - g.wx * k;
  view.y = m.my - r.top - g.wy * k;
  applyView();
}

vp.addEventListener('wheel', e => {
  e.preventDefault();
  const r = vp.getBoundingClientRect();
  const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
  const k = clamp(view.k * f, .15, 4);
  const px = e.clientX - r.left, py = e.clientY - r.top;
  view.x = px - (px - view.x) * (k / view.k);
  view.y = py - (py - view.y) * (k / view.k);
  view.k = k;
  applyView(); saveView();
}, { passive: false });

/* ---------- Conectores: unir tarjetas con líneas para armar mapas ---------- */
const SVGNS = 'http://www.w3.org/2000/svg';
let selConn = null, connectFrom = null, selMid = null, linesQueued = false;
const ro = new ResizeObserver(() => scheduleLines());

function scheduleLines() {
  if (linesQueued) return;
  linesQueued = true;
  requestAnimationFrame(() => { linesQueued = false; drawLines(); });
}
function edge(r, d) {                         // punto medio de un lado de la tarjeta + hacia dónde sale la línea
  if (d === 'r') return { x: r.x + r.w, y: r.y + r.h / 2, dx: 1, dy: 0 };
  if (d === 'l') return { x: r.x, y: r.y + r.h / 2, dx: -1, dy: 0 };
  if (d === 'b') return { x: r.x + r.w / 2, y: r.y + r.h, dx: 0, dy: 1 };
  return { x: r.x + r.w / 2, y: r.y, dx: 0, dy: -1 };
}
function geometry(ra, rb) {
  const dx = (rb.x + rb.w / 2) - (ra.x + ra.w / 2), dy = (rb.y + rb.h / 2) - (ra.y + ra.h / 2);
  let da, db;
  if (Math.abs(dx) * (ra.h + rb.h) >= Math.abs(dy) * (ra.w + rb.w)) [da, db] = dx >= 0 ? ['r', 'l'] : ['l', 'r'];
  else [da, db] = dy >= 0 ? ['b', 't'] : ['t', 'b'];
  const p1 = edge(ra, da), p2 = edge(rb, db);
  const d = clamp(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2.5, 30, 170);
  return { p1, p2, c1: { x: p1.x + p1.dx * d, y: p1.y + p1.dy * d }, c2: { x: p2.x + p2.dx * d, y: p2.y + p2.dy * d } };
}
function svgPath(d, cls) {
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', d); p.setAttribute('class', cls);
  return p;
}
function drawLines() {
  const svg = $('#lines'); if (!svg) return;
  svg.textContent = '';
  selMid = null;
  for (const c of allItems) {
    if (c.type !== 'conn' || c.boardId !== cur) continue;
    const a = findItem(c.a), b = findItem(c.b), ea = a && cardEl(c.a), eb = b && cardEl(c.b);
    if (!ea || !eb) continue;
    const m = geometry({ x: a.x, y: a.y, w: a.w, h: ea.offsetHeight }, { x: b.x, y: b.y, w: b.w, h: eb.offsetHeight });
    const d = `M${m.p1.x} ${m.p1.y} C${m.c1.x} ${m.c1.y} ${m.c2.x} ${m.c2.y} ${m.p2.x} ${m.p2.y}`;
    const gr = document.createElementNS(SVGNS, 'g');
    gr.setAttribute('class', 'cn' + (c.id === selConn ? ' sel' : ''));
    gr.dataset.id = c.id;
    gr.append(svgPath(d, 'hit'), svgPath(d, 'ln'));
    if (c.arrow) {                            // punta de flecha en el extremo final
      const ux = -m.p2.dx, uy = -m.p2.dy, bx = m.p2.x - ux * 13, by = m.p2.y - uy * 13, px = -uy * 6.5, py = ux * 6.5;
      gr.append(svgPath(`M${m.p2.x} ${m.p2.y} L${bx + px} ${by + py} L${bx - px} ${by - py}Z`, 'ah'));
    }
    svg.append(gr);
    if (c.id === selConn) selMid = { x: (m.p1.x + 3 * m.c1.x + 3 * m.c2.x + m.p2.x) / 8, y: (m.p1.y + 3 * m.c1.y + 3 * m.c2.y + m.p2.y) / 8 };
  }
  if (!selMid && selConn && !findItem(selConn)) selConn = null;
  const sc = selConn && findItem(selConn);
  if (sc) $('#cArrow').textContent = sc.arrow ? 'Quitar flecha' : 'Flecha';
  placeBar();
}
function placeBar() {
  const bar = $('#cbar'); if (!bar) return;
  bar.hidden = !selMid;
  if (selMid) { bar.style.left = (view.x + selMid.x * view.k) + 'px'; bar.style.top = (view.y + selMid.y * view.k) + 'px'; }
}
function selectConn(id) { selConn = id; drawLines(); }

async function addConn(a, b, pick = true) {
  if (!findItem(a) || !findItem(b)) return null;
  const dup = allItems.find(i => i.type === 'conn' && i.boardId === cur && ((i.a === a && i.b === b) || (i.a === b && i.b === a)));
  if (dup) { if (pick) { select(null); selectConn(dup.id); } return dup; }
  const c = { id: uid(), boardId: cur, type: 'conn', a, b, arrow: false, x: 0, y: 0, w: 0, created: now(), updated: now() };
  allItems.push(c);
  if (pick) { select(null); selConn = c.id; }
  drawLines();
  await dbPut('items', c);
  return c;
}
function startConnect(id) {
  connectFrom = id;
  document.body.classList.add('connecting');
  $('#hint').hidden = false;
}
function endConnect() {
  connectFrom = null;
  document.body.classList.remove('connecting');
  $('#hint').hidden = true;
}
async function addChild(id) {                 // "+ Idea": tarjeta nueva a la derecha, ya unida, lista para escribir
  const src = findItem(id); if (!src) return;
  const kids = allItems.filter(i => i.type === 'conn' && i.a === id).length;
  const it = { id: uid(), boardId: cur, type: 'text', x: src.x + src.w + 90, y: src.y + kids * 110, w: 220, text: '', created: now(), updated: now() };
  allItems.push(it);
  layer.append(await makeCard(it));
  $('#empty').hidden = true;
  select(it.id);
  editText(it.id);
  await dbPut('items', it);
  await addConn(id, it.id, false);
}
$('#hintCancel').onclick = endConnect;
$('#cArrow').onclick = async () => {
  const c = findItem(selConn); if (!c) return;
  c.arrow = !c.arrow; await saveItem(c); drawLines();
};
$('#cDel').onclick = () => { if (selConn) deleteItem(selConn); };

/* ---------- Enlaces: se pueden abrir y se reproducen dentro de la nota ---------- */
const URL_RE = /https?:\/\/[^\s<>"]+/gi;
function splitUrl(m) {                       // quita signos finales como "." o ")" que no son del enlace
  const t = m.match(/[.,;:!?)\]'”»]+$/);
  return t ? [m.slice(0, -t[0].length), t[0]] : [m, ''];
}
function renderText(el, text) {
  el.textContent = '';
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const [u] = splitUrl(m[0]);
    if (m.index > last) el.append(text.slice(last, m.index));
    const a = document.createElement('a');
    a.href = u; a.textContent = u; a.target = '_blank'; a.rel = 'noopener noreferrer';
    el.append(a);
    last = m.index + u.length;
  }
  if (last < text.length) el.append(text.slice(last));
}
function startSeconds(x) {                   // ?t=90 · ?t=1m30s · ?start=90
  const t = x.searchParams.get('t') || x.searchParams.get('start') || '';
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}
function frameEmbed(kind, src, thumb) {      // se carga al tocar, para no gastar datos hasta que lo pidas
  const d = document.createElement('div');
  d.className = 'embed ' + kind;
  if (thumb) d.style.backgroundImage = `url("${thumb}")`;
  d.innerHTML = '<span class="play">▶</span>';
  d.onclick = ev => {
    ev.stopPropagation();   // el toque es solo del reproductor (no abre la entrada del Diario)
    if (d.querySelector('iframe')) return;
    const f = document.createElement('iframe');
    f.src = src;
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    d.textContent = ''; d.append(f); d.classList.add('on');
  };
  return d;
}
function mediaEmbed(tag, url) {
  const d = document.createElement('div');
  d.className = 'embed media ' + tag;
  const m = document.createElement(tag);
  m.src = url;
  if (tag === 'img') { m.loading = 'lazy'; m.alt = ''; m.draggable = false; }
  else { m.controls = true; m.preload = 'metadata'; if (tag === 'video') m.playsInline = true; }
  d.append(m);
  return d;
}
function embedFor(text) {
  for (const m of text.matchAll(URL_RE)) {
    const u = splitUrl(m[0])[0];
    let x; try { x = new URL(u); } catch { continue; }
    const h = x.hostname.replace(/^(www|m)\./, '');
    let id = null;
    if (h === 'youtu.be') id = x.pathname.slice(1).split('/')[0];
    else if (h === 'youtube.com' || h === 'youtube-nocookie.com')
      id = x.pathname === '/watch' ? x.searchParams.get('v') : (x.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/) || [])[1];
    if (id && /^[\w-]{6,}$/.test(id)) {
      const st = startSeconds(x);
      return frameEmbed('yt', `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0${st ? '&start=' + st : ''}`,
        `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
    }
    if (h === 'vimeo.com') {
      const v = x.pathname.match(/^\/(?:video\/)?(\d+)/);
      if (v) return frameEmbed('vimeo', `https://player.vimeo.com/video/${v[1]}?autoplay=1`);
    }
    const ext = ((x.pathname.match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
    if (/^(mp4|webm|mov|m4v|ogv)$/.test(ext)) return mediaEmbed('video', u);
    if (/^(mp3|m4a|oga|ogg|wav|aac|opus|flac)$/.test(ext)) return mediaEmbed('audio', u);
    if (/^(jpe?g|png|gif|webp|avif|svg)$/.test(ext)) return mediaEmbed('img', u);
  }
  return null;
}
function paintText(card, it) {               // dibuja el texto con enlaces + el reproductor del primer enlace
  const t = card.querySelector('.txt');
  renderText(t, it.text || '');
  card.querySelector('.embed')?.remove();
  const em = embedFor(it.text || '');
  if (em) t.after(em);
}

/* ---------- Texto ---------- */
function editText(id) {
  const el = cardEl(id)?.querySelector('.txt'); if (!el) return;
  el.textContent = findItem(id)?.text || '';   // mientras se edita se ve el texto plano
  el.contentEditable = 'true';
  el.classList.add('editing');
  el.focus();
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  el.onblur = async () => {
    el.contentEditable = 'false';
    el.classList.remove('editing');
    el.onblur = null;
    const it = findItem(id); if (!it) return;
    const t = el.innerText.replace(/\n$/, '');
    if (!t.trim()) { deleteItem(id); return; }
    if (t !== it.text) { it.text = t; await saveItem(it); }
    const c = cardEl(id); if (c) paintText(c, it);
  };
}

async function addText(text = '', edit = true) {
  const c = viewCenter();
  const it = { id: uid(), boardId: cur, type: 'text', x: c.x - 130 + (Math.random() * 30 - 15), y: c.y - 40 + (Math.random() * 30 - 15), w: 260, text, created: now(), updated: now() };
  allItems.push(it);
  const el = await makeCard(it);          // sin esperas lentas: el foco debe llegar al instante
  layer.append(el);
  $('#empty').hidden = true;
  select(it.id);
  if (edit) editText(it.id);
  await dbPut('items', it);
  return it;
}

/* ---------- Imágenes y videos ---------- */
async function shrinkImage(file, max = 1800) {
  if (/gif|svg/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (s === 1 && file.size < 1.5e6) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .86));
    return blob || file;
  } catch { return file; }
}

async function addMedia(file, boardId = cur, offset = 0) {
  const isImg = file.type.startsWith('image/'), isVid = file.type.startsWith('video/');
  if (!isImg && !isVid) return null;
  const blob = isImg ? await shrinkImage(file) : file;
  const blobId = uid();
  await dbPut('blobs', { id: blobId, blob });
  const c = boardId === cur ? viewCenter() : { x: 0, y: 0 };
  const w = isImg ? 300 : 380;
  const j = () => Math.random() * 40 - 20;
  const it = { id: uid(), boardId, type: isImg ? 'image' : 'video', blobId, x: c.x - w / 2 + offset * 28 + j(), y: c.y - 100 + offset * 28 + j(), w, created: now(), updated: now() };
  allItems.push(it);
  await dbPut('items', it);
  if (boardId === cur) {
    const el = await makeCard(it);
    if (el) layer.append(el);
    $('#empty').hidden = true;
    select(it.id);
  }
  return it;
}

async function addFiles(files) {
  let i = 0;
  for (const f of files) if (await addMedia(f, cur, i)) i++;
}

for (const [btn, input] of [['#addImg', '#fileImg'], ['#addVid', '#fileVid'], ['#addCam', '#fileCam']]) {
  $(btn).onclick = () => $(input).click();
  $(input).onchange = async e => { await addFiles([...e.target.files]); e.target.value = ''; };
}
$('#addText').onclick = () => addText();

/* pegar (Ctrl+V) y arrastrar archivos desde el PC */
document.addEventListener('paste', async e => {
  if (mode !== 'board' || e.target.closest?.('.txt.editing') || e.target.id === 'boardName') return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); await addFiles(files); return; }
  const t = e.clipboardData?.getData('text/plain');
  if (t && t.trim()) { e.preventDefault(); await addText(t.trim(), false); }
});
vp.addEventListener('dragover', e => e.preventDefault());
vp.addEventListener('drop', async e => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) await addFiles([...e.dataTransfer.files]);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && connectFrom) { endConnect(); return; }
  if (mode !== 'board') return;
  if (e.target.closest?.('.txt.editing') || e.target.id === 'boardName') return;
  if (selConn && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); deleteItem(selConn); return; }
  if (!sel) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteItem(sel); }
});

/* ---------- Diario (línea de tiempo) ---------- */
function setMode(m) {
  mode = m;
  $('#tabBoard').classList.toggle('on', m === 'board');
  $('#tabDiary').classList.toggle('on', m === 'diary');
  vp.hidden = m !== 'board';
  $('#dock').hidden = m !== 'board';
  $('#diary').hidden = m !== 'diary';
  if (m === 'diary') renderDiary();
  else applyView();
}
$('#tabBoard').onclick = () => setMode('board');
$('#tabDiary').onclick = () => setMode('diary');
$('#diaryFilter').onchange = renderDiary;

async function renderDiary() {
  const box = $('#diaryList');
  box.innerHTML = '';
  const f = $('#diaryFilter').value;
  const names = Object.fromEntries(boards.map(b => [b.id, b.name]));
  const list = allItems.filter(i => i.type !== 'conn' && names[i.boardId] !== undefined && (!f || i.boardId === f))
    .sort((a, b) => b.created - a.created);
  if (!list.length) { box.innerHTML = '<div class="diary-empty">Aún no hay entradas.</div>'; return; }
  let day = '';
  for (const it of list) {
    const d = new Date(it.created);
    const label = d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (label !== day) {
      day = label;
      const h = document.createElement('div'); h.className = 'day'; h.textContent = label; box.append(h);
    }
    const e = document.createElement('div');
    e.className = 'entry';
    const time = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    e.innerHTML = `<div class="meta"><span>${time}</span><span>· ${esc(names[it.boardId])}</span></div>`;
    const body = document.createElement('div'); body.className = 'body';
    if (it.type === 'text') {
      renderText(body, it.text || '');
      const em = embedFor(it.text || ''); if (em) body.append(em);
    }
    else {
      const u = await blobURL(it.blobId);
      if (!u) continue;
      const m = document.createElement(it.type === 'image' ? 'img' : 'video');
      m.src = u;
      if (it.type === 'video') { m.controls = true; m.preload = 'metadata'; m.playsInline = true; }
      body.append(m);
    }
    e.append(body);
    e.onclick = ev => { if (!ev.target.closest('a, .embed, video, audio')) focusItem(it); };
    box.append(e);
  }
}

async function focusItem(it) {
  await openBoard(it.boardId);
  const k = 1;
  view = { k, x: vp.clientWidth / 2 - (it.x + it.w / 2) * k, y: vp.clientHeight / 2 - (it.y + 60) * k };
  applyView(); saveView();
  select(it.id);
}

/* ---------- Tema ---------- */
function applyTheme(t) {
  const r = document.documentElement;
  if (t === 'auto') r.removeAttribute('data-theme'); else r.dataset.theme = t;
  localStorage.setItem('theme', t);
  document.querySelectorAll('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme:dark)').matches);
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = dark ? '#161615' : '#fafaf8';
}
document.querySelectorAll('#themeSeg button').forEach(b => b.onclick = () => applyTheme(b.dataset.t));
matchMedia('(prefers-color-scheme:dark)').addEventListener('change', () => applyTheme(localStorage.getItem('theme') || 'light'));
applyTheme(localStorage.getItem('theme') || 'light');

/* ---------- Menú lateral (móvil) ---------- */
const closeDrawer = () => document.body.classList.remove('drawer');
$('#menu').onclick = () => document.body.classList.toggle('drawer');
$('#scrim').onclick = closeDrawer;

/* ---------- Compartir hacia la app (Android: Compartir → Diario) ---------- */
async function importShared() {
  if (!/[?&]shared=1/.test(location.search) || !('caches' in window)) return;
  const c = await caches.open('share');
  const m = await c.match('/__shared/meta');
  history.replaceState(null, '', location.pathname);
  if (!m) return;
  const meta = await m.json();
  let inbox = boards.find(b => b.name === 'Bandeja de entrada');
  if (!inbox) inbox = await newBoard('Bandeja de entrada');
  for (let i = 0; i < meta.n; i++) {
    const r = await c.match('/__shared/' + i);
    if (!r) continue;
    const blob = await r.blob();
    await addMedia(new File([blob], 'compartido', { type: blob.type }), inbox.id, i);
  }
  const txt = [meta.title, meta.text, meta.url].filter(Boolean).join('\n');
  if (txt.trim()) {
    const prev = cur; cur = inbox.id;
    const saved = view; view = { x: 0, y: 0, k: 1 };
    await addText(txt, false);
    view = saved; cur = prev;
  }
  for (const k of await c.keys()) await c.delete(k);
  await openBoard(inbox.id);
}

/* ---------- Inicio ---------- */
(async function init() {
  db = await openDB();
  boards = (await dbAll('boards')).filter(b => !b.deleted).sort((a, b) => a.created - b.created);
  allItems = (await dbAll('items')).filter(i => !i.deleted);
  if (!boards.length) await newBoard('Mi primera pizarra', true);
  const last = localStorage.getItem('lastBoard');
  await openBoard(boards.find(b => b.id === last)?.id || boards[0].id);
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  await importShared();
  window.__ready = true;
  if (window.Sync) Sync.init();
})();

window.addEventListener('pagehide', saveViewNow);
