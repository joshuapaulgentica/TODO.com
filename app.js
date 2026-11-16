/* app.js - TODO dashboard (monday-style board) on Supabase */
const $ = (s) => document.querySelector(s);
const esc = (v = '') => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const BUCKET = 'task-files';
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file
const OK_TYPES = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation))$/;
let tasks = [];
let view = 'table';
let query = '';
let sfilter = 'all';
let openId = null;
let board = 'Main board';
let allTasks = [];
let sortKey = '';
let sortDir = 1;
let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let myName = 'Friend';
const collapsed = new Set();

/* ---------- Supabase connection ---------- */
// 1) In Supabase open Project Settings > API (or the Connect button).
// 2) Paste your Project URL and your anon / publishable key below.
const SUPABASE_URL = 'https://cfadwunwdrkjhighrxwh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_N4YKvlyib7YGOFBxcGL6Ww_5pHGlqd-';

const LIB_OK = !!(window.supabase && window.supabase.createClient);
const sb = (SUPABASE_URL.includes('YOUR-PROJECT') || !LIB_OK) ? null : window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const nameOf = (u) => (u && u.user_metadata && (u.user_metadata.name || u.user_metadata.full_name)) || (u && u.email) || 'Friend';

// Same function names as before, but now every action talks to Supabase
async function api(action, data = {}) {
  if (!sb) throw new Error(LIB_OK ? 'Add your Supabase URL and key at the top of app.js.' : 'The Supabase library did not load. Check your internet, and check that index.html has the supabase-js script line above app.js.');
  try {
    if (action === 'register') {
      const { data: d, error } = await sb.auth.signUp({
        email: data.email.trim().toLowerCase(), password: data.password,
        options: { data: { name: data.name.trim() } }
      });
      if (error) throw error;
      if (!d.session) throw new Error('Account created! Check your email to confirm it, then log in.');
      return { name: nameOf(d.user) };
    }
    if (action === 'login') {
      const { data: d, error } = await sb.auth.signInWithPassword({ email: data.email.trim().toLowerCase(), password: data.password });
      if (error) throw error;
      return { name: nameOf(d.user) };
    }
    if (action === 'logout') { await sb.auth.signOut(); return { ok: true }; }
    if (action === 'me') {
      const { data: d } = await sb.auth.getSession();
      return { name: d.session ? nameOf(d.session.user) : null };
    }
    if (action === 'list') {
      const { data: rows, error } = await sb.from('tasks').select('id, title, notes, progress, priority, status, due_date, group_name, board, task_files(id, path, name, mime, size), subitems(id, title, done)').order('created_at', { ascending: true });
      if (error) throw error;
      const paths = rows.flatMap((r) => r.task_files.map((f) => f.path));
      const urls = {};
      if (paths.length) {
        const { data: signed } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
        (signed || []).forEach((x) => { if (x.signedUrl) urls[x.path] = x.signedUrl; });
      }
      rows.forEach((r) => r.task_files.forEach((f) => { f.url = urls[f.path] || ''; }));
      return rows;
    }
    if (action === 'add' || action === 'update') {
      const row = {};
      if ('title' in data) { row.title = String(data.title).trim(); if (!row.title) throw new Error('Item name is required.'); }
      if ('notes' in data) row.notes = String(data.notes || '').trim();
      if ('progress' in data) row.progress = Math.max(0, Math.min(100, Number(data.progress) || 0));
      if ('priority' in data) row.priority = ['low', 'medium', 'high'].includes(data.priority) ? data.priority : 'medium';
      if ('status' in data) row.status = ['todo', 'working', 'stuck', 'done'].includes(data.status) ? data.status : 'todo';
      if ('due_date' in data) row.due_date = data.due_date || null;
      if ('group_name' in data) row.group_name = String(data.group_name || '').trim().slice(0, 40) || 'My tasks';
      if ('board' in data) row.board = String(data.board || '').trim().slice(0, 40) || 'Main board';
      let id = data.id;
      let error;
      if (action === 'add') {
        if (!row.title) throw new Error('Item name is required.');
        const r = await sb.from('tasks').insert(row).select('id').single();
        error = r.error;
        id = r.data && r.data.id;
      } else {
        ({ error } = await sb.from('tasks').update(row).eq('id', data.id));
      }
      if (error) throw error;
      return { ok: true, id };
    }
    if (action === 'renamegroup') {
      const { error } = await sb.from('tasks').update({ group_name: String(data.to).trim().slice(0, 40) }).eq('group_name', data.from).eq('board', board);
      if (error) throw error;
      return { ok: true };
    }
    if (action === 'deletegroup') {
      const { data: ts } = await sb.from('tasks').select('id').eq('group_name', data.name).eq('board', board);
      const ids = (ts || []).map((x) => x.id);
      if (ids.length) {
        const { data: files } = await sb.from('task_files').select('path').in('task_id', ids);
        if (files && files.length) await sb.storage.from(BUCKET).remove(files.map((f) => f.path));
        const { error } = await sb.from('tasks').delete().in('id', ids);
        if (error) throw error;
      }
      return { ok: true };
    }
    if (action === 'subadd') {
      const { error } = await sb.from('subitems').insert({ task_id: data.taskId, title: String(data.title).trim().slice(0, 120) });
      if (error) throw error;
      return { ok: true };
    }
    if (action === 'subset') {
      const { error } = await sb.from('subitems').update({ done: !!data.done }).eq('id', data.id);
      if (error) throw error;
      return { ok: true };
    }
    if (action === 'subdel') {
      const { error } = await sb.from('subitems').delete().eq('id', data.id);
      if (error) throw error;
      return { ok: true };
    }
    if (action === 'upload') {
      const { data: u } = await sb.auth.getUser();
      for (const f of data.files) {
        const safe = f.name.replace(/[^\w.\-]+/g, '_').slice(-80);
        const path = `${u.user.id}/${data.taskId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safe}`;
        const up = await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type });
        if (up.error) throw up.error;
        const ins = await sb.from('task_files').insert({ task_id: data.taskId, path, name: f.name, mime: f.type, size: f.size });
        if (ins.error) { await sb.storage.from(BUCKET).remove([path]); throw ins.error; }
      }
      return { ok: true };
    }
    if (action === 'removefile') {
      await sb.storage.from(BUCKET).remove([data.path]);
      const { error } = await sb.from('task_files').delete().eq('id', data.id);
      if (error) throw error;
      return { ok: true };
    }
    if (action === 'delete') {
      const { data: files } = await sb.from('task_files').select('path').eq('task_id', data.id);
      if (files && files.length) await sb.storage.from(BUCKET).remove(files.map((f) => f.path));
      const { error } = await sb.from('tasks').delete().eq('id', data.id);
      if (error) throw error;
      return { ok: true };
    }
  } catch (error) {
    throw new Error(error.message || 'Something went wrong.');
  }
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 5000);
}

/* ---------- Login / register ---------- */
function showTab(login) {
  $('#login-form').hidden = !login;
  $('#register-form').hidden = login;
  $('#tab-login').classList.toggle('active', login);
  $('#tab-register').classList.toggle('active', !login);
  $('#auth-msg').textContent = '';
}
$('#tab-login').addEventListener('click', () => showTab(true));
$('#tab-register').addEventListener('click', () => showTab(false));

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('login', { email: $('#l-email').value, password: $('#l-pass').value });
    showApp(r.name);
  } catch (err) { $('#auth-msg').textContent = err.message; }
});

/* ---------- Password rules ---------- */
const PW_RULES = {
  len: (p) => p.length >= 8,
  upper: (p) => /[A-Z]/.test(p),
  lower: (p) => /[a-z]/.test(p),
  num: (p) => /[0-9]/.test(p),
  sym: (p) => /[^A-Za-z0-9\s]/.test(p)
};
function checkPassword(p) {
  let ok = true;
  document.querySelectorAll('#pw-rules li').forEach((li) => {
    const pass = PW_RULES[li.dataset.rule](p);
    li.classList.toggle('ok', pass);
    if (!pass) ok = false;
  });
  return ok;
}
$('#r-pass').addEventListener('input', (e) => checkPassword(e.target.value));

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!checkPassword($('#r-pass').value)) { $('#auth-msg').textContent = 'Your password does not meet all the requirements yet.'; return; }
  try {
    const r = await api('register', { name: $('#r-name').value, email: $('#r-email').value, password: $('#r-pass').value });
    showApp(r.name);
  } catch (err) { $('#auth-msg').textContent = err.message; }
});

$('#logout').addEventListener('click', async () => {
  await api('logout', {});
  location.reload();
});

/* ---------- Photos and files ---------- */
let pending = [];
const dropEl = $('#drop');
const fileInput = $('#file-input');
const pendingEl = $('#pending');
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

function fileHtml(t) {
  const items = (t.task_files || []).map((f) => {
    const rm = `<button type="button" class="x" data-rmfile="${f.id}" data-path="${esc(f.path)}" aria-label="Remove file">×</button>`;
    const link = `href="${esc(f.url)}" target="_blank" rel="noopener noreferrer"`;
    return f.mime.startsWith('image/')
      ? `<span class="fi"><a ${link}><img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy"></a>${rm}</span>`
      : `<span class="fi doc"><a ${link}>📄 ${esc(f.name)} <small>${fmtSize(f.size)}</small></a>${rm}</span>`;
  }).join('');
  return items ? `<div class="files">${items}</div>` : '';
}

function addFiles(list) {
  if (!openId) { toast('Open an item first, then add the file'); return; }
  for (const f of list) {
    if (pending.length >= 10) { toast('Maximum 10 files at a time'); break; }
    if (!OK_TYPES.test(f.type)) { toast('Not allowed: ' + (f.name || 'this file type')); continue; }
    if (f.size > MAX_BYTES) { toast((f.name || 'File') + ' is bigger than 5 MB'); continue; }
    // Pasted screenshots are all called "image.png", so give them unique names
    const ext = f.type.split('/')[1].replace('jpeg', 'jpg');
    pending.push(f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${pending.length}.${ext}`, { type: f.type }));
  }
  renderPending();
}

function renderPending() {
  pendingEl.innerHTML = pending.map((f, i) => `
    <div class="pf">
      ${f.type.startsWith('image/') ? `<img src="${URL.createObjectURL(f)}" alt="">` : '<span class="ficon">📄</span>'}
      <small>${esc(f.name)}</small>
      <button type="button" class="x" data-rm="${i}" aria-label="Remove">×</button>
    </div>`).join('');
}

pendingEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  pending.splice(Number(b.dataset.rm), 1);
  renderPending();
});

dropEl.addEventListener('click', () => fileInput.click());
dropEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

// Ctrl+V: paste a copied photo or file anywhere on the homepage
document.addEventListener('paste', (e) => {
  if ($('#app').hidden) return;
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
  toast('Added ' + files.length + ' file(s). Press Save to upload.');
});

// Drag and drop files anywhere on the homepage
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
  if ($('#app').hidden || !hasFiles(e)) return;
  e.preventDefault();
  dropEl.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, () => dropEl.classList.remove('over')));
document.addEventListener('drop', (e) => {
  if ($('#app').hidden || !hasFiles(e)) return;
  e.preventDefault();
  addFiles(e.dataTransfer.files);
});

// Remove a saved file from a task
$('#p-files').addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-rmfile]');
  if (!rm || !confirm('Remove this file?')) return;
  try {
    await api('removefile', { id: Number(rm.dataset.rmfile), path: rm.dataset.path });
    await loadTasks();
    toast('File removed');
  } catch (err) { toast(err.message); }
});

/* ---------- Board (monday-style) ---------- */
const STATUS = { todo: ['Not started', '#9a9aa5'], working: ['In progress', '#e0a030'], stuck: ['Stuck', '#d2475f'], done: ['Done', '#3fa57c'] };
const PRI = { low: ['Low', '#9a9aa5'], medium: ['Medium', '#7c8de0'], high: ['High', '#d2475f'] };
const GCOLORS = ['#c9577f', '#7c8de0', '#3fa57c', '#e0a030', '#9a9aa5'];
const initial = () => (myName[0] || '?').toUpperCase();
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const isLate = (t) => t.due_date && t.due_date < ymd(new Date()) && t.status !== 'done';

function showApp(name) {
  myName = name;
  document.body.classList.add('in');
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#hello').textContent = name;
  $('#avatar').textContent = initial();
  loadTasks();
}

async function loadTasks() {
  try {
    allTasks = await api('list');
    allTasks.forEach((t) => { t.status = t.status || 'todo'; t.group_name = t.group_name || 'My tasks'; t.board = t.board || 'Main board'; t.subitems = (t.subitems || []).sort((a, b) => a.id - b.id); });
    tasks = allTasks.filter((t) => t.board === board);
    renderBoards();
    render();
    refreshPanel();
  } catch (err) { toast(err.message); }
}

function visible() {
  const q = query.trim().toLowerCase();
  return sorted(tasks.filter((t) => (sfilter === 'all' || (sfilter === 'late' ? isLate(t) : t.status === sfilter)) && (!q || t.title.toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q))));
}

function render() {
  $('#title').textContent = board;
  const nDone = tasks.filter((t) => t.status === 'done').length, pct = tasks.length ? Math.round((nDone / tasks.length) * 100) : 0, nLate = tasks.filter(isLate).length;
  $('#stats').innerHTML = [['all', 'Total items', tasks.length, ''], ['working', 'In progress', tasks.filter((t) => t.status === 'working').length, ''], ['late', 'Overdue', nLate, nLate ? 'late' : ''], ['done', 'Completed', pct + '%', '']]
    .map(([k, l, v, c]) => `<button type="button" class="kpi" data-sf="${k}"><small>${l}</small><b class="${c}">${v}</b>${k === 'done' ? `<div class="meter"><i style="width:${pct}%"></i></div>` : ''}</button>`).join('');
  ['all', 'todo', 'working', 'stuck', 'done', 'late'].forEach((k) => { $('#cnt-' + k).textContent = k === 'all' ? tasks.length : k === 'late' ? tasks.filter(isLate).length : tasks.filter((t) => t.status === k).length; });
  document.querySelectorAll('[data-sf]').forEach((b) => b.classList.toggle('active', b.dataset.sf === sfilter));
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#view').innerHTML = view === 'kanban' ? kanbanHtml(visible()) : view === 'dash' ? dashHtml() : view === 'cal' ? calHtml(visible()) : tableHtml(visible());
}

const pill = (map, field, t) => {
  const cur = map[t[field]] || Object.values(map)[0];
  return `<select class="pill" data-f="${field}" data-id="${t.id}" style="--c:${cur[1]}" aria-label="${field}">${Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === t[field] ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>`;
};
const meter = (p) => `<div class="meter"><i style="width:${p}%"></i></div><b>${p}%</b>`;

function tableHtml(list) {
  if (!tasks.length) return '<div class="empty-state"><h3>Your board is empty ♡</h3><p>Click “+ New item” to add your first task.</p></div>';
  if (!list.length) return '<p class="empty">No items match your search or filter.</p>';
  const groups = [...new Set(list.map((t) => t.group_name))];
  return groups.map((g, gi) => {
    const rows = list.filter((t) => t.group_name === g);
    const shut = collapsed.has(g);
    const body = rows.map((t) => `
      <div class="tr" data-open="${t.id}" data-id="${t.id}" draggable="true">
        <span class="cell title"><button type="button" class="bt ttl">${esc(t.title)}</button>${(t.task_files || []).length ? `<small>📎 ${t.task_files.length}</small>` : ''}${(t.subitems || []).length ? `<small>✓ ${t.subitems.filter((x) => x.done).length}/${t.subitems.length}</small>` : ''}</span>
        <span class="cell">${pill(STATUS, 'status', t)}</span>
        <span class="cell">${pill(PRI, 'priority', t)}</span>
        <span class="cell"><input type="date" data-f="due_date" data-id="${t.id}" value="${esc(t.due_date || '')}" class="${isLate(t) ? 'late' : ''}" aria-label="Due date" /></span>
        <span class="cell prog">${meter(t.progress)}</span>
      </div>`).join('');
    return `<section class="grp" data-grp="${esc(g)}" style="--g:${GCOLORS[gi % 5]}">
      <div class="grp-h"><button type="button" class="bt tog" data-tog="${esc(g)}" aria-label="Collapse">${shut ? '▸' : '▾'}</button>
        <h3>${esc(g)}</h3><small>${rows.length} items</small><button type="button" class="ico" data-rename="${esc(g)}">Rename</button><button type="button" class="ico" data-delgroup="${esc(g)}">Delete group</button></div>
      ${shut ? '' : `<div class="tbl">
        <div class="tr th">${[['title', 'Item'], ['status', 'Status'], ['priority', 'Priority'], ['due_date', 'Due date'], ['progress', 'Progress']].map(([k, l]) => `<span><button type="button" class="srt" data-sort="${k}">${l}${sortKey === k ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}</button></span>`).join('')}</div>
        ${body}
        <div class="tr add"><input data-add="${esc(g)}" placeholder="+ Add item (press Enter)" maxlength="120" /></div>
      </div>`}
    </section>`;
  }).join('') + '<button type="button" class="bt add-grp" id="add-grp">+ Add new group</button>';
}

function kanbanHtml(list) {
  return '<div class="kanban">' + Object.entries(STATUS).map(([k, [label, color]]) => {
    const items = list.filter((t) => t.status === k);
    return `<div class="col" data-col="${k}" style="--c:${color}">
      <div class="col-h"><b>${label}</b><span>${items.length}</span></div>
      ${items.map((t) => `<article class="kcard" draggable="true" data-id="${t.id}" data-open="${t.id}">
        <h4>${esc(t.title)}</h4>
        <div class="prog">${meter(t.progress)}</div>
        <div class="kmeta"><span class="tag" style="--c:${(PRI[t.priority] || PRI.medium)[1]}">${(PRI[t.priority] || PRI.medium)[0]}</span>
          ${t.due_date ? `<small class="${isLate(t) ? 'late' : ''}">📅 ${esc(t.due_date)}</small>` : ''}</div>
      </article>`).join('') || '<p class="empty">Drop items here</p>'}
    </div>`;
  }).join('') + '</div>';
}

function dashHtml() {
  const n = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const late = tasks.filter(isLate).length;
  const avg = n ? Math.round(tasks.reduce((s, t) => s + t.progress, 0) / n) : 0;
  let acc = 0;
  const stops = Object.entries(STATUS).map(([k, [, c]]) => { const s = acc; acc += (tasks.filter((t) => t.status === k).length / (n || 1)) * 100; return `${c} ${s}% ${acc}%`; }).join(', ');
  const bars = (rows) => { const max = Math.max(1, ...rows.map((r) => r[1])); return rows.map(([l, v, c]) => `<div class="hb"><span>${esc(l)}</span><div><i style="width:${(v / max) * 100}%;background:${c}"></i></div><b>${v}</b></div>`).join(''); };
  const groups = [...new Set(tasks.map((t) => t.group_name))];
  return `<div class="dash">
    <div class="stat"><small>Total items</small><b>${n}</b></div>
    <div class="stat"><small>Done</small><b>${n ? Math.round((done / n) * 100) : 0}%</b></div>
    <div class="stat"><small>Overdue</small><b class="${late ? 'late' : ''}">${late}</b></div>
    <div class="stat"><small>Average progress</small><b>${avg}%</b></div>
    <div class="wid"><h3>Status overview</h3><div class="donut-w"><div class="donut" style="background:conic-gradient(${n ? stops : '#ffe3ef 0 100%'})"><b>${avg}%</b></div>
      <ul class="legend">${Object.entries(STATUS).map(([k, [l, c]]) => `<li><i style="background:${c}"></i>${l} <b>${tasks.filter((t) => t.status === k).length}</b></li>`).join('')}</ul></div></div>
    <div class="wid"><h3>By priority</h3>${bars(Object.entries(PRI).map(([k, [l, c]]) => [l, tasks.filter((t) => t.priority === k).length, c]))}</div>
    <div class="wid wide"><h3>By group</h3>${bars(groups.map((g, i) => [g, tasks.filter((t) => t.group_name === g).length, GCOLORS[i % 5]])) || '<p class="empty">No groups yet.</p>'}</div>
  </div>`;
}

function sorted(list) {
  if (!sortKey) return list;
  const rank = { status: Object.keys(STATUS), priority: ['low', 'medium', 'high'] }[sortKey];
  const val = (t) => (rank ? rank.indexOf(t[sortKey]) : sortKey === 'progress' ? t.progress : sortKey === 'due_date' ? (t.due_date || '9999') : t.title.toLowerCase());
  return [...list].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sortDir);
}

function calHtml(list) {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const pad = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate(), today = ymd(new Date());
  const cells = Array(pad).fill('<div class="cd off"></div>');
  for (let d = 1; d <= days; d++) {
    const key = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const chips = list.filter((t) => t.due_date === key).map((t) => `<button type="button" class="chip" data-open="${t.id}" style="--c:${(STATUS[t.status] || STATUS.todo)[1]}">${esc(t.title)}</button>`).join('');
    cells.push(`<div class="cd ${key === today ? 'today' : ''}"><b>${d}</b>${chips}</div>`);
  }
  const none = list.filter((t) => !t.due_date).length;
  return `<div class="cal-h"><button type="button" class="link" data-cal="-1">← Previous</button><b>${calMonth.toLocaleString('en', { month: 'long', year: 'numeric' })}</b><button type="button" class="link" data-cal="1">Next →</button></div>
    <div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<i>${d}</i>`).join('')}${cells.join('')}</div>
    ${none ? `<p class="muted">${none} item(s) without a due date are not shown here.</p>` : ''}`;
}

/* ---------- Changing items ---------- */
async function save(t, field, value) {
  const p = { [field]: value };
  if (field === 'status') p.progress = value === 'done' ? 100 : value === 'todo' ? 0 : (t.progress > 0 && t.progress < 100 ? t.progress : 50);
  try { await api('update', { id: t.id, ...p }); await loadTasks(); } catch (err) { toast(err.message); loadTasks(); }
}

async function addItem(title, group) {
  try {
    const r = await api('add', { title, group_name: group || 'My tasks', board, status: 'todo', progress: 0, priority: 'medium' });
    await loadTasks();
    return r.id;
  } catch (err) { toast(err.message); }
}

$('#view').addEventListener('change', (e) => {
  const el = e.target.closest('[data-f]');
  const t = el && tasks.find((x) => x.id == el.dataset.id);
  if (t) save(t, el.dataset.f, el.value);
});

$('#view').addEventListener('click', (e) => {
  const so = e.target.closest('[data-sort]');
  if (so) { sortDir = sortKey === so.dataset.sort ? -sortDir : 1; sortKey = so.dataset.sort; return render(); }
  const cm = e.target.closest('[data-cal]');
  if (cm) { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + Number(cm.dataset.cal), 1); return render(); }
  if (e.target.closest('#add-grp')) return addGroup();
  const dg = e.target.closest('[data-delgroup]');
  if (dg) return delGroup(dg.dataset.delgroup);
  const tg = e.target.closest('[data-tog]');
  if (tg) { collapsed.has(tg.dataset.tog) ? collapsed.delete(tg.dataset.tog) : collapsed.add(tg.dataset.tog); return render(); }
  const o = e.target.closest('[data-open]');
  if (o && !e.target.closest('select, input, button.ico')) openPanel(Number(o.dataset.open));
});

$('#view').addEventListener('click', async (e) => {
  const r = e.target.closest('[data-rename]');
  if (!r) return;
  const name = prompt('Rename group', r.dataset.rename);
  if (!name || !name.trim() || name === r.dataset.rename) return;
  try { await api('renamegroup', { from: r.dataset.rename, to: name }); loadTasks(); } catch (err) { toast(err.message); }
});

$('#view').addEventListener('keydown', async (e) => {
  const inp = e.target.closest('[data-add]');
  if (e.key !== 'Enter' || !inp || !inp.value.trim()) return;
  e.preventDefault();
  const title = inp.value;
  inp.value = '';
  await addItem(title, inp.dataset.add);
  toast('Item added');
});

async function delGroup(g) {
  if (!confirm('Delete the group "' + g + '" and all its items?')) return;
  try { await api('deletegroup', { name: g }); await loadTasks(); toast('Group deleted'); } catch (err) { toast(err.message); }
}

async function addGroup() {
  const name = prompt('Name of the new group');
  if (!name || !name.trim()) return;
  openPanel('new', name.trim().slice(0, 40));
}

$('#new-item').addEventListener('click', () => openPanel('new'));

// Drag cards between Kanban columns to change their status
let dragId = null;
const clearOver = () => document.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));
$('#view').addEventListener('dragstart', (e) => {
  const c = e.target.closest('.kcard, .tr[data-id]');
  if (!c) return;
  dragId = Number(c.dataset.id);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragId));
});
$('#view').addEventListener('dragover', (e) => {
  const z = e.target.closest('.col, .grp');
  if (z && dragId) { e.preventDefault(); clearOver(); z.classList.add('over'); }
});
$('#view').addEventListener('dragend', () => { dragId = null; clearOver(); });
$('#view').addEventListener('drop', (e) => {
  const col = e.target.closest('.col'), gp = e.target.closest('.grp');
  if (!dragId || (!col && !gp)) return;
  e.preventDefault();
  const t = tasks.find((x) => x.id === dragId);
  dragId = null;
  if (t && col && t.status !== col.dataset.col) save(t, 'status', col.dataset.col);
  else if (t && gp && t.group_name !== gp.dataset.grp) save(t, 'group_name', gp.dataset.grp);
  else render();
});

// Views, quick filters, search
document.addEventListener('click', (e) => {
  const v = e.target.closest('[data-view]');
  const f = e.target.closest('[data-sf]');
  if (v) { view = v.dataset.view; render(); }
  if (f) { sfilter = f.dataset.sf; render(); }
});
$('#search').addEventListener('input', (e) => { query = e.target.value; render(); });

/* ---------- Item panel (details, progress, photos and files) ---------- */
function openPanel(id, group) {
  openId = id;
  pending = [];
  renderPending();
  const isNew = id === 'new';
  const t = isNew ? { title: '', notes: '', progress: 0, status: 'todo', priority: 'medium', due_date: '', group_name: group || (tasks[0] && tasks[0].group_name) || 'My tasks' } : tasks.find((x) => x.id === id);
  if (!t) return;
  $('#p-head').textContent = isNew ? 'New item' : 'Item details';
  $('#p-delete').hidden = isNew;
  $('#sub-wrap').hidden = isNew;
  $('#p-title').value = t.title;
  $('#p-notes').value = t.notes || '';
  $('#p-status').value = t.status;
  $('#p-priority').value = t.priority || 'medium';
  $('#p-due').value = t.due_date || '';
  $('#p-group').value = t.group_name;
  $('#groups').innerHTML = [...new Set(tasks.map((x) => x.group_name))].map((g) => `<option value="${esc(g)}">`).join('');
  setProg(t.progress);
  refreshPanel();
  $('#panel').hidden = false;
  $('#p-title').focus();
}
function closePanel() {
  openId = null;
  pending = [];
  renderPending();
  $('#panel').hidden = true;
}
function refreshPanel() {
  if (!openId || openId === 'new') return;
  const t = tasks.find((x) => x.id === openId);
  if (!t) return closePanel();
  $('#p-files').innerHTML = fileHtml(t) || '<small class="muted">No files yet</small>';
  $('#subs').innerHTML = (t.subitems || []).map((x) => `<label class="sub"><input type="checkbox" data-sub="${x.id}" ${x.done ? 'checked' : ''}><span class="${x.done ? 'done' : ''}">${esc(x.title)}</span><button type="button" class="x3" data-delsub="${x.id}" aria-label="Remove subitem">×</button></label>`).join('');
}
const setProg = (n) => { $('#p-progress').value = n; $('#p-out').textContent = n + '%'; };
$('#p-close').addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });
// Progress and status stay in step
$('#p-progress').addEventListener('input', (e) => {
  const p = Number(e.target.value), st = $('#p-status');
  $('#p-out').textContent = p + '%';
  if (p >= 100) st.value = 'done'; else if (p <= 0) st.value = 'todo'; else if (st.value === 'todo' || st.value === 'done') st.value = 'working';
});
$('#p-status').addEventListener('change', (e) => {
  const v = e.target.value, p = Number($('#p-progress').value);
  if (v === 'done') setProg(100); else if (v === 'todo') setProg(0); else if (p === 0 || p === 100) setProg(50);
});

$('#p-save').addEventListener('click', async () => {
  if (!openId) return;
  const row = { title: $('#p-title').value, notes: $('#p-notes').value, progress: Number($('#p-progress').value), status: $('#p-status').value, priority: $('#p-priority').value, due_date: $('#p-due').value, group_name: $('#p-group').value };
  try {
    let id = openId;
    if (id === 'new') id = (await api('add', { ...row, board })).id; else await api('update', { id, ...row });
    if (pending.length) { toast('Uploading files...'); await api('upload', { taskId: id, files: pending }); }
    closePanel();
    await loadTasks();
    toast('Saved');
  } catch (err) { toast(err.message); }
});

$('#p-delete').addEventListener('click', async () => {
  if (!openId || openId === 'new' || !confirm('Delete this item and its files?')) return;
  try { await api('delete', { id: openId }); closePanel(); await loadTasks(); toast('Item deleted'); } catch (err) { toast(err.message); }
});

/* ---------- Subitems and boards ---------- */
const run = async (fn) => { try { await fn(); await loadTasks(); } catch (err) { toast(err.message); } };
$('#subs').addEventListener('change', (e) => { const c = e.target.closest('[data-sub]'); if (c) run(() => api('subset', { id: Number(c.dataset.sub), done: c.checked })); });
$('#subs').addEventListener('click', (e) => { const d = e.target.closest('[data-delsub]'); if (d) run(() => api('subdel', { id: Number(d.dataset.delsub) })); });
$('#sub-add').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.value.trim() || !openId || openId === 'new') return;
  e.preventDefault();
  const title = e.target.value;
  e.target.value = '';
  run(() => api('subadd', { taskId: openId, title }));
});

function renderBoards() {
  $('#boards').innerHTML = [...new Set([...allTasks.map((t) => t.board), board])].map((b) => `<button type="button" class="nav-i ${b === board ? 'active' : ''}" data-board="${esc(b)}">${esc(b)}</button>`).join('');
}
function switchBoard(name) {
  board = name;
  sfilter = 'all';
  tasks = allTasks.filter((t) => t.board === board);
  closePanel();
  renderBoards();
  render();
}
$('#boards').addEventListener('click', (e) => { const b = e.target.closest('[data-board]'); if (b) switchBoard(b.dataset.board); });
$('#new-board').addEventListener('click', () => { const n = prompt('Name of the new board'); if (n && n.trim()) switchBoard(n.trim().slice(0, 40)); });

/* ---------- Night mode + intro ---------- */
$('#theme').addEventListener('click', () => {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.classList.add('theming');
  root.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch (e) {}
  setTimeout(() => root.classList.remove('theming'), 400);
});
setTimeout(() => $('#auth').classList.add('ready'), 3500); // after the intro, tab switches should be instant

/* ---------- Start ---------- */
(async () => {
  try {
    const r = await api('me');
    if (r.name) showApp(r.name); else $('#auth-msg').textContent = 'Connected to Supabase ✓';
  } catch (err) { $('#auth-msg').textContent = err.message; }
})();
