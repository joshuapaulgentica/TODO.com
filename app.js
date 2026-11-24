/* app.js - TODO dashboard (boards, completed, productivity, profile, settings) on Supabase */
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
let page = 'board'; // board | done | prod | profile | settings
let hideDone = (() => { try { return localStorage.getItem('hideDone') !== '0'; } catch (e) { return true; } })();
let boardList = [];
let profile = null;
let avatarUrl = '';
let myEmail = '';
let socialUrl = ''; // profile picture from Google / Facebook (used until you upload your own)
let myProviders = []; // how this account signs in: email, google, facebook
let needsSql = false;
let warnedSql = false;
const AV_BUCKET = BUCKET; // profile photos live in the same private bucket as task files (folder = your user id)

/* ---------- Supabase connection ---------- */
// 1) In Supabase open Project Settings > API (or the Connect button).
// 2) Paste your Project URL and your anon / publishable key below.
const SUPABASE_URL = 'https://cfadwunwdrkjhighrxwh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_N4YKvlyib7YGOFBxcGL6Ww_5pHGlqd-';

// Did the visitor arrive from the "reset password" email link? (checked before supabase-js tidies the address)
let recovering = /type=recovery/.test(location.hash);
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
    if (action === 'oauth') {
      // Sends the visitor to Google / Facebook, which sends them back to this page signed in
      const back = location.origin + location.pathname.replace(/index\.html$/, '');
      const { error } = await sb.auth.signInWithOAuth({ provider: data.provider, options: { redirectTo: back, queryParams: data.provider === 'google' ? { prompt: 'select_account' } : undefined } });
      if (error) throw error;
      return { ok: true };
    }
    if (action === 'forgot') {
      // Supabase emails a link that brings the person back to this page to choose a new password
      const back = location.origin + location.pathname.replace(/index\.html$/, '');
      const { error } = await sb.auth.resetPasswordForEmail(data.email.trim().toLowerCase(), { redirectTo: back });
      if (error) throw error;
      return { ok: true };
    }
    if (action === 'reset') {
      const { data: d, error } = await sb.auth.updateUser({ password: data.next });
      if (error) throw error;
      try { await sb.auth.signOut({ scope: 'others' }); } catch (e) {} // log out other devices after a password reset
      return { name: nameOf(d.user) };
    }
    if (action === 'logout') { await sb.auth.signOut(); return { ok: true }; }
    if (action === 'me') {
      const { data: d } = await sb.auth.getSession();
      return { name: d.session ? nameOf(d.session.user) : null };
    }
    if (action === 'list') {
      const COLS = 'id, title, notes, progress, priority, status, due_date, group_name, board, created_at', REL = ', task_files(id, path, name, mime, size), subitems(id, title, done)';
      let r = await sb.from('tasks').select(COLS + ', completed_at' + REL).order('created_at', { ascending: true });
      if (r.error && /completed_at/.test(r.error.message)) { needsSql = true; r = await sb.from('tasks').select(COLS + REL).order('created_at', { ascending: true }); }
      const { data: rows, error } = r;
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
      if ('status' in data && !needsSql) {
        const prev = allTasks.find((x) => x.id === data.id);
        if (row.status === 'done') { if (!prev || prev.status !== 'done') row.completed_at = new Date().toISOString(); } else row.completed_at = null;
      }
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
    if (action === 'boards') {
      const { data: rows, error } = await sb.from('boards').select('name').order('created_at', { ascending: true });
      if (error) throw error;
      return rows.map((r) => r.name);
    }
    if (action === 'addboard') {
      const { error } = await sb.from('boards').insert({ name: String(data.name).trim().slice(0, 40) });
      if (error && error.code !== '23505') throw error; // 23505 = already exists, fine
      return { ok: true };
    }
    if (action === 'delboard') {
      const { data: ts } = await sb.from('tasks').select('id').eq('board', data.name);
      const ids = (ts || []).map((x) => x.id);
      if (ids.length) {
        const { data: files } = await sb.from('task_files').select('path').in('task_id', ids);
        if (files && files.length) await sb.storage.from(BUCKET).remove(files.map((f) => f.path));
        const { error } = await sb.from('tasks').delete().in('id', ids);
        if (error) throw error;
      }
      const { error } = await sb.from('boards').delete().eq('name', data.name);
      if (error && !/relation|schema cache|does not exist/i.test(error.message)) throw error;
      return { ok: true };
    }
    if (action === 'getprofile') {
      const { data: u } = await sb.auth.getUser();
      const { data: p } = await sb.from('profiles').select('*').maybeSingle();
      let url = '';
      if (p && p.avatar_path) { const sg = await sb.storage.from(AV_BUCKET).createSignedUrl(p.avatar_path, 3600); url = (sg.data && sg.data.signedUrl) || ''; }
      const md = u.user.user_metadata || {};
      return { profile: p, url, email: u.user.email || '', social: md.avatar_url || md.picture || '', providers: (u.user.app_metadata && u.user.app_metadata.providers) || [] };
    }
    if (action === 'saveprofile') {
      const { data: u } = await sb.auth.getUser();
      const { error } = await sb.from('profiles').upsert({ id: u.user.id, ...data.fields, updated_at: new Date().toISOString() });
      if (error) throw new Error(error.code === '23505' ? 'That username is already taken.' : error.message);
      if (data.fields.full_name) await sb.auth.updateUser({ data: { name: data.fields.full_name } });
      return { ok: true };
    }
    if (action === 'avatar') {
      const { data: u } = await sb.auth.getUser();
      const ext = (data.file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const path = `${u.user.id}/avatar-${Date.now()}.${ext}`;
      const up = await sb.storage.from(AV_BUCKET).upload(path, data.file, { contentType: data.file.type });
      if (up.error) throw up.error;
      const { error } = await sb.from('profiles').upsert({ id: u.user.id, avatar_path: path, updated_at: new Date().toISOString() });
      if (error) { await sb.storage.from(AV_BUCKET).remove([path]); throw new Error(/relation|schema cache|does not exist/i.test(error.message) ? 'Run the new supabase.sql in Supabase first (it creates the profiles table).' : error.message); }
      if (data.old) await sb.storage.from(AV_BUCKET).remove([data.old]);
      return { ok: true };
    }
    if (action === 'rmavatar') {
      const { data: u } = await sb.auth.getUser();
      const { error } = await sb.from('profiles').upsert({ id: u.user.id, avatar_path: null, updated_at: new Date().toISOString() });
      if (error) throw error;
      if (data.old) await sb.storage.from(AV_BUCKET).remove([data.old]);
      return { ok: true };
    }
    if (action === 'password') {
      const { data: u } = await sb.auth.getUser();
      const chk = await sb.auth.signInWithPassword({ email: u.user.email, password: data.current });
      if (chk.error) throw new Error('Your current password is not correct.');
      const { error } = await sb.auth.updateUser({ password: data.next });
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
function showAuthView(v) { // login | register | forgot | reset
  $('#login-form').hidden = v !== 'login';
  $('#register-form').hidden = v !== 'register';
  $('#forgot-form').hidden = v !== 'forgot';
  $('#reset-form').hidden = v !== 'reset';
  const tabs = v === 'login' || v === 'register';
  $('#auth-switch').hidden = !tabs;
  $('#or-row').hidden = !tabs;
  $('#social-row').hidden = !tabs;
  $('#tab-login').classList.toggle('active', v === 'login');
  $('#tab-register').classList.toggle('active', v === 'register');
  $('#auth-msg').textContent = '';
}
const showTab = (login) => showAuthView(login ? 'login' : 'register');
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
function checkPassword(p, root = '#pw-rules') {
  let ok = true;
  document.querySelectorAll(root + ' li').forEach((li) => {
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

/* ---------- Forgot / reset password ---------- */
$('#forgot-link').addEventListener('click', () => {
  const typed = $('#l-email').value.trim();
  showAuthView('forgot');
  if (typed) $('#f-email').value = typed;
  $('#f-email').focus();
});
document.querySelectorAll('[data-back="login"]').forEach((b) => b.addEventListener('click', () => {
  if (recovering) { recovering = false; try { history.replaceState(null, '', location.pathname); } catch (e) {} }
  showAuthView('login');
}));

let forgotTimer;
function startCooldown(secs) { // stops people from pressing "send" again and again
  const btn = $('#f-send');
  let left = secs;
  clearInterval(forgotTimer);
  btn.disabled = true; btn.textContent = 'Send again in ' + left + 's';
  forgotTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) { clearInterval(forgotTimer); btn.disabled = false; btn.textContent = 'Send reset link'; }
    else btn.textContent = 'Send again in ' + left + 's';
  }, 1000);
}
$('#forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#f-email').value.trim();
  if (location.protocol === 'file:') { $('#auth-msg').textContent = 'Password reset only works on your website address (http or https), not when the file is opened from your computer.'; return; }
  $('#f-send').disabled = true;
  $('#auth-msg').textContent = 'Sending...';
  try {
    await api('forgot', { email });
    // Same message whether or not the email has an account, so nobody can use this form to find out who is registered
    $('#auth-msg').textContent = 'If ' + email + ' has an account, a reset link is on its way. Check your inbox and your spam folder. The link works for 1 hour.';
    startCooldown(60);
    $('#auth-msg').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); // on a small phone the message can be below the screen
  } catch (err) {
    $('#f-send').disabled = false;
    $('#auth-msg').textContent = /rate limit|only request this after/i.test(err.message) ? 'Too many requests. Please wait a minute and try again. (' + err.message + ')' : err.message;
  }
});

function showReset() { // the visitor clicked the link in the email
  document.body.classList.remove('in');
  $('#app').hidden = true;
  $('#auth').hidden = false;
  showAuthView('reset');
  window.scrollTo({ top: 0 });
  $('#n-pass').focus();
}
if (sb) sb.auth.onAuthStateChange((ev) => { if (ev === 'PASSWORD_RECOVERY') { recovering = true; showReset(); } });
$('#n-pass').addEventListener('input', (e) => checkPassword(e.target.value, '#pw-rules3'));
$('#reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = $('#n-pass').value, rep = $('#n-rep').value;
  if (!checkPassword(next, '#pw-rules3')) { $('#auth-msg').textContent = 'Your password does not meet all the requirements yet.'; return; }
  if (next !== rep) { $('#auth-msg').textContent = 'The two passwords do not match.'; return; }
  try {
    const r = await api('reset', { next });
    recovering = false;
    try { history.replaceState(null, '', location.pathname); } catch (err) {}
    e.target.reset(); checkPassword('', '#pw-rules3');
    showApp(r.name);
    toast('Password changed. You are logged in.');
  } catch (err) {
    $('#auth-msg').textContent = /same|different/i.test(err.message) ? 'Choose a password you have not used before.' : err.message;
  }
});

/* ---------- Google and Facebook sign-in ---------- */
const socialBtns = () => document.querySelectorAll('.sbtn');
socialBtns().forEach((b) => b.addEventListener('click', async () => {
  const provider = b.dataset.provider, label = provider === 'google' ? 'Google' : 'Facebook';
  if (location.protocol === 'file:') { $('#auth-msg').textContent = label + ' sign-in only works on your website address (http or https), not when the file is opened from your computer.'; return; }
  socialBtns().forEach((x) => { x.disabled = true; });
  $('#auth-msg').textContent = 'Opening ' + label + '...';
  try { await api('oauth', { provider }); } catch (err) { socialBtns().forEach((x) => { x.disabled = false; }); $('#auth-msg').textContent = err.message; }
}));
window.addEventListener('pageshow', (e) => { if (e.persisted) { socialBtns().forEach((x) => { x.disabled = false; }); $('#auth-msg').textContent = ''; } });

// If Google / Facebook sent the visitor back with an error, show it on the login card
const oauthError = (() => {
  const q = new URLSearchParams(location.search), f = new URLSearchParams(location.hash.slice(1));
  const raw = q.get('error_description') || f.get('error_description') || q.get('error') || f.get('error');
  if (!raw) return '';
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  if (/otp_expired|expired|invalid/i.test(raw) && /otp|link|expired/i.test(raw)) return 'That reset link has expired or was already used. Click "Forgot password?" to get a new one.';
  return 'Sign-in did not finish: ' + raw + (/email/i.test(raw) ? ' (Facebook may not have shared an email address. Use an account with an email, or sign up with email.)' : '');
})();

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
  page = 'board';
  applyIdentity();
  loadProfile();
  loadTasks();
}

async function loadTasks() {
  try {
    allTasks = await api('list');
    allTasks.forEach((t) => { t.status = t.status || 'todo'; t.group_name = t.group_name || 'My tasks'; t.board = t.board || 'Main board'; t.subitems = (t.subitems || []).sort((a, b) => a.id - b.id); });
    await loadBoards();
    tasks = allTasks.filter((t) => t.board === board);
    renderBoards();
    render();
    refreshPanel();
    checkReminders();
    if (needsSql && !warnedSql) { warnedSql = true; toast('Run the new supabase.sql in Supabase to turn on every feature'); }
  } catch (err) { toast(err.message); }
}

async function loadBoards() {
  let names = [];
  try {
    names = await api('boards');
    for (const b of new Set(allTasks.map((t) => t.board))) if (!names.includes(b)) { await api('addboard', { name: b }); names.push(b); }
    if (!names.length) { await api('addboard', { name: 'Main board' }); names.push('Main board'); }
  } catch (err) {
    needsSql = true;
    names = [...new Set([...allTasks.map((t) => t.board), 'Main board'])];
  }
  boardList = names;
  if (!boardList.includes(board)) board = boardList[0];
}

function visible() {
  const q = query.trim().toLowerCase();
  const hide = hideDone && sfilter !== 'done';
  return sorted(tasks.filter((t) => (!hide || t.status !== 'done') && (sfilter === 'all' || (sfilter === 'late' ? isLate(t) : t.status === sfilter)) && (!q || t.title.toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q))));
}

/* ---------- Stat cards: icons, mini charts, count-up ---------- */
const IC = {
  all: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  working: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  late: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  done: '<circle cx="12" cy="12" r="8"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>',
};
const ic = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${IC[k]}</svg>`;
const SPARK_DAYS = 7;
function dayCounts(list) {
  const out = Array(SPARK_DAYS).fill(0), today = new Date();
  today.setHours(0, 0, 0, 0);
  list.forEach((t) => {
    const d = t.created_at ? new Date(t.created_at) : new Date(); // no date yet = just added
    d.setHours(0, 0, 0, 0);
    const i = SPARK_DAYS - 1 - Math.round((today - d) / 864e5);
    if (i >= 0 && i < SPARK_DAYS) out[i]++;
  });
  return out;
}
function sparkSvg(vals, kind) {
  const w = 200, h = 40, max = Math.max(1, ...vals);
  if (kind === 'bars') {
    const bw = w / SPARK_DAYS;
    return `<svg class="spark bars" viewBox="0 0 ${w} ${h}" aria-hidden="true">${vals.map((v, i) => { const bh = Math.max(4, (v / max) * h); return `<rect x="${(i * bw + 5).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 10).toFixed(1)}" height="${bh.toFixed(1)}" rx="4" style="--i:${i}"/>`; }).join('')}</svg>`;
  }
  const pts = vals.map((v, i) => [(i * w) / (SPARK_DAYS - 1), h - 4 - (v / max) * (h - 10)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  return `<svg class="spark line" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path class="area" d="${d} L${w} ${h} L0 ${h} Z"/><path class="ln" pathLength="1" d="${d}"/></svg>`;
}
const kpiSeen = {};
function animateKpis() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let first = false;
  document.querySelectorAll('.kpi b[data-to]').forEach((el) => {
    const key = board + ':' + el.closest('.kpi').dataset.sf, to = Number(el.dataset.to), suf = el.dataset.suf || '';
    const isNew = !(key in kpiSeen), from = isNew ? 0 : kpiSeen[key];
    if (isNew) first = true;
    kpiSeen[key] = to;
    if (reduce || from === to) return;
    const t0 = performance.now(), dur = 900;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(from + (to - from) * e) + suf;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  $('#stats').classList.toggle('enter', first && !reduce);
}

function render() {
  $('#tb-title').textContent = page === 'board' ? board : PAGE_TITLES[page];
  document.querySelectorAll('[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $('#cnt-doneall').textContent = allTasks.filter((t) => t.status === 'done').length;
  $('#board-page').hidden = page !== 'board';
  $('#page').hidden = page === 'board';
  if (page !== 'board') {
    document.querySelectorAll('.nav-i[data-sf]').forEach((b) => b.classList.remove('active'));
    return renderPage();
  }
  const hidden = tasks.filter((t) => t.status === 'done').length;
  $('#hide-done').setAttribute('aria-pressed', String(hideDone));
  $('#hide-done').textContent = 'Hide completed' + (hidden ? ' (' + hidden + ')' : '');
  $('#title').textContent = board;
  const nDone = tasks.filter((t) => t.status === 'done').length, pct = tasks.length ? Math.round((nDone / tasks.length) * 100) : 0, nLate = tasks.filter(isLate).length;
  const series = { all: tasks, working: tasks.filter((t) => t.status === 'working'), late: tasks.filter(isLate), done: tasks.filter((t) => t.status === 'done') };
  $('#stats').innerHTML = [['all', 'Total items', tasks.length, '', 'line'], ['working', 'In progress', series.working.length, '', 'bars'], ['late', 'Overdue', nLate, nLate ? 'late' : '', 'bars'], ['done', 'Completed', pct, '', 'line']]
    .map(([k, l, v, c, kind], i) => `<button type="button" class="kpi" data-sf="${k}" style="--n:${i}"><span class="k-top"><small>${l}</small><i class="k-ic">${ic(k)}</i></span><b class="${c}" data-to="${v}" data-suf="${k === 'done' ? '%' : ''}">${v}${k === 'done' ? '%' : ''}</b>${sparkSvg(dayCounts(series[k]), kind)}<em class="k-cap">added in the last 7 days</em>${k === 'done' ? `<div class="meter"><i style="width:${pct}%"></i></div>` : ''}</button>`).join('');
  animateKpis();
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
  if (!list.length) return hideDone && sfilter === 'all' && !query && tasks.every((t) => t.status === 'done') ? '<div class="empty-state"><h3>All caught up ♡</h3><p>Your finished tasks moved to the Completed page.</p></div>' : '<p class="empty">No items match your search or filter.</p>';
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
      </article>`).join('') || `<p class="empty">${k === 'done' && hideDone ? 'Drop here to complete (' + tasks.filter((x) => x.status === 'done').length + ' hidden)' : 'Drop items here'}</p>`}
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
  try {
    const was = t.status;
    await api('update', { id: t.id, ...p });
    await loadTasks();
    if (field === 'status' && value === 'done' && was !== 'done') cheer();
  } catch (err) { toast(err.message); loadTasks(); }
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
  if (v) { view = v.dataset.view; page = 'board'; renderBoards(); render(); }
  if (f) { sfilter = f.dataset.sf; page = 'board'; renderBoards(); render(); closeMenu(); }
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
    const prevSt = id === 'new' ? null : (tasks.find((x) => x.id === id) || {}).status;
    if (id === 'new') id = (await api('add', { ...row, board })).id; else await api('update', { id, ...row });
    if (pending.length) { toast('Uploading files...'); await api('upload', { taskId: id, files: pending }); }
    closePanel();
    await loadTasks();
    if (row.status === 'done' && prevSt !== 'done') cheer(); else toast('Saved');
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
  $('#boards').innerHTML = [...new Set([...boardList, board])].map((b) => `<button type="button" class="nav-i ${b === board && page === 'board' ? 'active' : ''}" data-board="${esc(b)}" title="${esc(b)}"><i class="bi">${esc((b[0] || '?').toUpperCase())}</i><em class="lbl">${esc(b)}</em></button>`).join('');
}
function switchBoard(name) {
  board = name;
  page = 'board';
  closeMenu();
  sfilter = 'all';
  tasks = allTasks.filter((t) => t.board === board);
  closePanel();
  renderBoards();
  render();
}
$('#boards').addEventListener('click', (e) => { const b = e.target.closest('[data-board]'); if (b) switchBoard(b.dataset.board); });
$('#new-board').addEventListener('click', async () => {
  const n = prompt('Name of the new board');
  const name = n && n.trim().slice(0, 40);
  if (!name) return;
  try {
    if (!boardList.includes(name)) await api('addboard', { name });
    board = name; page = 'board'; sfilter = 'all';
    closePanel(); closeMenu();
    await loadTasks();
    toast('Board "' + name + '" created');
  } catch (err) { toast(err.message); }
});

/* ---------- v3 features ---------- */
/* ---------- Appearance: mode (light / dark / system) and accent color ---------- */
const sysDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const DEFAULT_ACC = '#e8528a';
const ACCENTS = [['Rose', ''], ['Violet', '#8b5cf6'], ['Ocean', '#2f80ed'], ['Teal', '#0fa3a3'], ['Green', '#2fa86b'], ['Orange', '#f07b3f']];
const store = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
const stored = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };

function applyMode(m) {
  const root = document.documentElement;
  store('theme', m);
  root.classList.add('theming');
  root.dataset.theme = m === 'dark' || (m === 'system' && sysDark()) ? 'dark' : 'light';
  setTimeout(() => root.classList.remove('theming'), 400);
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (stored('theme') === 'system') applyMode('system'); });
$('#theme').addEventListener('click', () => {
  applyMode(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  if (page === 'settings') renderPage();
});

function applyAccent(hex, save = true) {
  const root = document.documentElement;
  const custom = hex && hex.toLowerCase() !== DEFAULT_ACC ? hex.toLowerCase() : null;
  if (custom) { root.dataset.accent = '1'; root.style.setProperty('--acc', custom); } else { delete root.dataset.accent; root.style.removeProperty('--acc'); }
  store('accent', custom);
  $('#tc').setAttribute('content', custom || DEFAULT_ACC);
  if (save) api('saveprofile', { fields: { accent: custom } }).catch(() => {});
}

/* ---------- Reminders (browser notifications) ---------- */
let notifOn = stored('notif') === '1' && 'Notification' in window && Notification.permission === 'granted';
function checkReminders() {
  if (!notifOn) return;
  const today = ymd(new Date());
  const due = allTasks.filter((t) => t.status !== 'done' && t.due_date && t.due_date <= today);
  if (!due.length) return;
  const key = 'notified:' + today + ':' + due.length;
  if (stored(key)) return;
  store(key, '1');
  const late = due.filter((t) => t.due_date < today).length;
  const body = `${due.length - late} due today${late ? ', ' + late + ' overdue' : ''}: ${due.slice(0, 3).map((t) => t.title).join(', ')}`;
  try { new Notification('todo. reminder', { body, icon: 'apple-touch-icon.png' }); } catch (e) {}
}
async function setNotif(on) {
  if (on) {
    if (!('Notification' in window)) { toast('This browser does not support notifications'); return; }
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications are blocked. Allow them in your browser settings first.'); return; }
  }
  notifOn = on;
  store('notif', on ? '1' : '0');
  api('saveprofile', { fields: { notifications: on } }).catch(() => {});
  if (on) { try { new Notification('Reminders are on ♡', { body: 'You will be told about tasks due today and overdue tasks.' }); } catch (e) {} checkReminders(); }
  toast(on ? 'Reminders turned on' : 'Reminders turned off');
}
setInterval(checkReminders, 15 * 60 * 1000);

/* ---------- Profile ---------- */
const cssUrl = (u) => u.replace(/[()'"\\\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
function paintAvatar(el) {
  const u = avatarUrl || socialUrl;
  el.style.backgroundImage = u ? `url("${cssUrl(u)}")` : '';
  el.classList.toggle('img', !!u);
  el.textContent = u ? '' : initial();
}
function applyIdentity() {
  $('#hello').textContent = myName;
  $('#wname').textContent = myName.trim().split(/\s+/)[0];
  paintAvatar($('#avatar'));
}
async function loadProfile() {
  try {
    const r = await api('getprofile');
    profile = r.profile || {};
    avatarUrl = r.url || '';
    myEmail = r.email || '';
    socialUrl = r.social || '';
    myProviders = r.providers || [];
    if (profile.full_name) myName = profile.full_name;
    if (r.profile) applyAccent(profile.accent || null, false);
    if (r.profile && profile.notifications != null) notifOn = !!profile.notifications && 'Notification' in window && Notification.permission === 'granted';
  } catch (err) { /* profile table not created yet: the app still works */ }
  applyIdentity();
  if (page === 'profile' || page === 'settings') renderPage();
}

/* ---------- Dates and stats ---------- */
const dayOf = (iso) => ymd(new Date(iso));
const doneDay = (t) => (t.status === 'done' ? dayOf(t.completed_at || t.created_at) : null);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const lastDays = (n) => { const t = new Date(); t.setHours(0, 0, 0, 0); return Array.from({ length: n }, (_, i) => addDays(t, i - (n - 1))); };

function prodStats() {
  const t0 = new Date();
  t0.setHours(0, 0, 0, 0);
  const days = lastDays(7).map((d) => {
    const k = ymd(d), planned = allTasks.filter((t) => (t.due_date || dayOf(t.created_at)) === k);
    const pd = planned.filter((t) => t.status === 'done').length;
    return { d, k, created: allTasks.filter((t) => dayOf(t.created_at) === k).length, completed: allTasks.filter((t) => doneDay(t) === k).length, planned: planned.length, pd, pct: planned.length ? Math.round((pd / planned.length) * 100) : null };
  });
  const prevKeys = lastDays(14).slice(0, 7).map(ymd);
  const set = new Set(allTasks.map(doneDay).filter(Boolean));
  let cur = 0, d = new Date(t0);
  if (!set.has(ymd(d))) d = addDays(d, -1); // a streak is still alive until today ends
  while (set.has(ymd(d))) { cur++; d = addDays(d, -1); }
  let best = 0, streak = 0, prev = null;
  [...set].sort().forEach((k) => { streak = prev && ymd(addDays(new Date(prev + 'T00:00:00'), 1)) === k ? streak + 1 : 1; best = Math.max(best, streak); prev = k; });
  const today = ymd(t0), open = allTasks.filter((t) => t.status !== 'done' && t.due_date);
  const byDue = (a, b) => (a.due_date > b.due_date ? 1 : -1);
  return {
    t0, days, cur, best,
    weekDone: days.reduce((s, x) => s + x.completed, 0), weekAdded: days.reduce((s, x) => s + x.created, 0),
    prevDone: allTasks.filter((t) => prevKeys.includes(doneDay(t))).length,
    todayDone: days[6].completed,
    overdue: open.filter((t) => t.due_date < today).sort(byDue),
    upcoming: open.filter((t) => t.due_date >= today).sort(byDue).slice(0, 8),
    total: allTasks.length, done: allTasks.filter((t) => t.status === 'done').length
  };
}

/* ---------- Motivation when you finish a task ---------- */
const CHEERS = ['Nice one!', 'Another one down ♡', 'You are on a roll!', 'Look at you go!', 'Small steps, big wins.', 'Done and dusted ✦', 'Proud of you!', 'Keep that momentum!'];
function burst() {
  for (let i = 0; i < 12; i++) {
    const s = document.createElement('span');
    s.className = 'burst';
    s.textContent = ['♥', '✦', '♡', '✧'][i % 4];
    s.style.setProperty('--x', Math.round(Math.random() * 320 - 160) + 'px');
    s.style.setProperty('--y', Math.round(-120 - Math.random() * 200) + 'px');
    s.style.setProperty('--r', Math.round(Math.random() * 120 - 60) + 'deg');
    s.style.animationDelay = i * 30 + 'ms';
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 1600);
  }
}
function cheer() {
  const s = prodStats();
  let msg = CHEERS[Math.floor(Math.random() * CHEERS.length)] + ` ${s.todayDone} done today`;
  if (s.cur > 1) msg += `, ${s.cur}-day streak`;
  if (!tasks.some((t) => t.status !== 'done')) msg = 'Board cleared! Everything is done 🎉';
  else if (hideDone) msg += '. Moved to Completed';
  toast(msg);
  burst();
}

/* ---------- Pages: Completed, Productivity, Profile, Settings ---------- */
const PAGE_TITLES = { done: 'Completed', prod: 'Productivity', profile: 'Profile', settings: 'Settings' };
const closeMenu = () => document.body.classList.remove('menu-open');
function go(p) {
  page = p;
  closeMenu();
  closePanel();
  renderBoards();
  render();
  window.scrollTo(0, 0);
}
function renderPage() {
  $('#page').innerHTML = page === 'done' ? doneHtml() : page === 'prod' ? prodHtml() : page === 'profile' ? profileHtml() : settingsHtml();
}

function doneHtml() {
  const list = allTasks.filter((t) => t.status === 'done').sort((a, b) => new Date(b.completed_at || b.created_at) - new Date(a.completed_at || a.created_at));
  const head = `<div class="pg-h"><h2>Completed</h2><p class="muted">${list.length} finished task${list.length === 1 ? '' : 's'}. Restore one to bring it back to its board.</p></div>`;
  if (!list.length) return head + '<div class="empty-state"><h3>Nothing here yet ♡</h3><p>Tasks you finish will land here.</p></div>';
  const today = ymd(new Date()), yest = ymd(addDays(new Date(), -1)), groups = {};
  list.forEach((t) => { (groups[doneDay(t)] = groups[doneDay(t)] || []).push(t); });
  const label = (k) => (k === today ? 'Today' : k === yest ? 'Yesterday' : new Date(k + 'T00:00:00').toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric' }));
  return head + '<div class="pg-act"><button type="button" class="link" data-act="clear-done">Delete all completed</button></div>' +
    Object.keys(groups).sort().reverse().map((k) => `<p class="dh">${esc(label(k))}</p><div class="sec flush">${groups[k].map((t) => `<div class="cr"><i class="ck">✓</i><span class="ct"><b>${esc(t.title)}</b><small>${esc(t.board)}, ${esc(t.group_name)}</small></span><span class="acts"><button type="button" class="link" data-restore="${t.id}">Restore</button><button type="button" class="link dx" data-delone="${t.id}">Delete</button></span></div>`).join('')}</div>`).join('');
}

function prodHtml() {
  const s = prodStats(), n = s.todayDone, dd = s.weekDone - s.prevDone;
  const msg = !s.total ? 'Add your first task to start your streak ♡' : n >= 5 ? `${n} tasks finished today. You are on fire!` : n > 0 ? `${n} done today. Keep the momentum going!` : s.cur > 0 ? `You have a ${s.cur}-day streak. Finish one task today to keep it alive.` : s.total - s.done > 0 ? 'Finish one small task today to start a new streak.' : 'All clear ♡ Rest up or plan something new.';
  const mx = Math.max(1, ...s.days.flatMap((x) => [x.created, x.completed])), hh = (v) => (v ? Math.max(6, (v / mx) * 100) : 0);
  const rel = (due) => { const k = Math.round((new Date(due + 'T00:00:00') - s.t0) / 864e5); return k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : k > 1 ? 'In ' + k + ' days' : -k + (k === -1 ? ' day late' : ' days late'); };
  const item = (t, late) => `<li><button type="button" data-goto="${t.id}"><span><b>${esc(t.title)}</b><small>${esc(t.board)}</small></span><em class="${late ? 'late' : ''}">${rel(t.due_date)}</em></button></li>`;
  const kpi = (l, v, c) => `<div class="sec"><small>${l}</small><b>${v}</b><em>${c}</em></div>`;
  return `<div class="pg-h"><h2>Productivity</h2><p class="cheer-line">${esc(msg)}</p></div>
  <div class="pk">
    ${kpi('Daily streak', `${s.cur}<span> day${s.cur === 1 ? '' : 's'}</span>`, 'Best: ' + s.best + ' day' + (s.best === 1 ? '' : 's'))}
    ${kpi('Completed today', n, s.total - s.done + ' still open')}
    ${kpi('This week', s.weekDone, `${s.weekAdded} added, ${dd > 0 ? '+' + dd + ' vs last week' : dd < 0 ? dd + ' vs last week' : 'same as last week'}`)}
    ${kpi('Overall', (s.total ? Math.round((s.done / s.total) * 100) : 0) + '%', `${s.done} of ${s.total} task${s.total === 1 ? "" : "s"} done`)}
  </div>
  <div class="pgrid">
    <section class="sec"><h3>Daily activity</h3>
      <div class="bars7">${s.days.map((x, i) => `<div class="b7 ${i === 6 ? 'today' : ''}" title="${x.created} added, ${x.completed} completed"><div class="pair"><i class="c1" style="height:${hh(x.created)}%"></i><i class="c2" style="height:${hh(x.completed)}%"></i></div><b>${x.completed}</b><small>${wdName(x.d)}</small></div>`).join('')}</div>
      <p class="lg"><span><i class="c1"></i>Added</span><span><i class="c2"></i>Completed</span></p></section>
    <section class="sec"><h3>Completed per day</h3>
      ${s.days.map((x, i) => `<div class="hb2"><span class="${i === 6 ? 'tdy' : ''}">${wdName(x.d)} ${x.d.getDate()}</span><div class="meter"><i style="width:${x.pct || 0}%"></i></div><b>${x.planned ? `${x.pd}/${x.planned}, ${x.pct}%` : 'no tasks'}</b></div>`).join('')}
      <p class="muted sm">Share of each day's tasks that are done. A day's tasks are the ones due that day, or added that day when there is no due date.</p></section>
    <section class="sec wide"><h3>Upcoming deadlines</h3>
      ${s.overdue.length ? `<p class="dh first">Overdue</p><ul class="dl">${s.overdue.map((t) => item(t, true)).join('')}</ul>` : ''}
      ${s.upcoming.length ? `<p class="dh ${s.overdue.length ? '' : 'first'}">Coming up</p><ul class="dl">${s.upcoming.map((t) => item(t, false)).join('')}</ul>` : ''}
      ${!s.overdue.length && !s.upcoming.length ? '<p class="empty">No deadlines ahead. Add a due date to an item and it will show up here.</p>' : ''}</section>
  </div>`;
}
const wdName = (d) => d.toLocaleDateString('en', { weekday: 'short' });

function profileHtml() {
  const p = profile || {}, done = allTasks.filter((t) => t.status === 'done').length, total = allTasks.length;
  return `<div class="pg-h"><h2>Profile</h2><p class="muted">Your photo and details.</p></div>
  <div class="pgrid">
    <section class="sec pcard">
      <div class="pav ${avatarUrl || socialUrl ? 'img' : ''}" ${avatarUrl || socialUrl ? `style="background-image:url('${esc(cssUrl(avatarUrl || socialUrl))}')"` : ''}>${avatarUrl || socialUrl ? '' : esc(initial())}</div>
      <div class="pbtns"><button type="button" class="btn sm" data-act="pickav">${avatarUrl ? 'Change photo' : 'Upload photo'}</button>${avatarUrl ? '<button type="button" class="link" data-act="rmav">Remove</button>' : ''}</div>
      <small class="muted">PNG, JPG, WEBP or GIF, up to 2 MB</small>
      <input type="file" id="av-input" hidden accept="image/png,image/jpeg,image/webp,image/gif" />
      <div class="pst"><div><b>${done}</b><small>Completed</small></div><div><b>${total}</b><small>Total tasks</small></div><div><b>${total ? Math.round((done / total) * 100) : 0}%</b><small>Done rate</small></div></div>
    </section>
    <section class="sec"><h3>Details</h3>
      <form id="profile-form">
        <label>Full name <input type="text" id="pf-name" maxlength="60" required value="${esc(p.full_name || myName)}" /></label>
        <label>Username <input type="text" id="pf-user" maxlength="20" placeholder="letters, numbers, underscore" value="${esc(p.username || '')}" autocapitalize="none" /></label>
        <label>Bio <textarea id="pf-bio" rows="3" maxlength="200" placeholder="A few words about you">${esc(p.bio || '')}</textarea></label>
        <small class="muted"><span id="bio-n">${(p.bio || '').length}</span>/200</small>
        <label>Email <input type="email" value="${esc(myEmail)}" disabled /></label>
        <button type="submit" class="btn">Save profile</button>
      </form></section>
  </div>`;
}

const canChangePw = () => !myProviders.length || myProviders.includes('email');
const providerNames = () => myProviders.filter((p) => p !== 'email').map((p) => p[0].toUpperCase() + p.slice(1)).join(' and ') || 'a social account';
const rulesHtml = (id) => `<ul id="${id}" class="rules" aria-live="polite"><li data-rule="len">At least 8 characters</li><li data-rule="upper">One uppercase letter (A-Z)</li><li data-rule="lower">One lowercase letter (a-z)</li><li data-rule="num">One number (0-9)</li><li data-rule="sym">One symbol, like @ # $ % * !</li></ul>`;
function settingsHtml() {
  const mode = stored('theme') || 'light', acc = (stored('accent') || '').toLowerCase();
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const custom = acc && !ACCENTS.some((a) => a[1] === acc);
  return `<div class="pg-h"><h2>Settings</h2><p class="muted">Make todo. feel like yours.</p></div>
  <div class="pgrid">
    <section class="sec"><h3>Appearance</h3>
      <p class="plabel">Mode</p>
      <div class="seg" role="group" aria-label="Mode">${[['light', 'Light'], ['dark', 'Dark'], ['system', 'Auto']].map(([k, l]) => `<button type="button" data-mode="${k}" class="${mode === k ? 'on' : ''}" aria-pressed="${mode === k}">${l}</button>`).join('')}</div>
      <p class="plabel gap">Accent color</p>
      <div class="sw">${ACCENTS.map(([l, h]) => `<button type="button" class="swatch ${h === acc ? 'on' : ''}" data-acc="${h}" style="--c:${h || DEFAULT_ACC}" aria-label="${l}" title="${l}"></button>`).join('')}<input type="color" id="acc-custom" value="${custom ? acc : '#e8528a'}" aria-label="Custom color" title="Custom color" class="${custom ? 'on' : ''}" /></div>
    </section>
    <section class="sec"><h3>Notifications</h3>
      <div class="row"><span>Due-date reminders<small>${perm === 'unsupported' ? 'Not supported by this browser.' : perm === 'denied' ? 'Blocked in your browser settings.' : 'Tells you about tasks due today and overdue ones while todo. is open.'}</small></span>
        <button type="button" class="tg" role="switch" aria-label="Due-date reminders" aria-checked="${notifOn}" data-act="notif"></button></div>
    </section>
    <section class="sec"><h3>Change password</h3>
      ${canChangePw() ? `<form id="pw-form" autocomplete="off">
        <label>Current password <input type="password" id="pw-cur" required autocomplete="current-password" /></label>
        <label>New password <input type="password" id="pw-new" minlength="8" required autocomplete="new-password" /></label>
        ${rulesHtml('pw-rules2')}
        <label>Repeat new password <input type="password" id="pw-rep" required autocomplete="new-password" /></label>
        <button type="submit" class="btn">Update password</button>
      </form>` : `<p class="muted">You signed in with ${providerNames()}, so your password is managed there. There is nothing to change here.</p>`}</section>
    <section class="sec"><h3>Account</h3>
      <div class="row"><span>Signed in as<small>${esc(myEmail || myName)}</small></span></div>
      <button type="button" class="ghost" data-act="logout">Log out</button>
    </section>
  </div>`;
}

$('#page').addEventListener('click', async (e) => {
  const q = (s) => e.target.closest(s);
  let b;
  if ((b = q('[data-restore]'))) { await run(() => api('update', { id: Number(b.dataset.restore), status: 'working', progress: 50 })); return toast('Moved back to its board'); }
  if ((b = q('[data-delone]'))) { if (confirm('Delete this task for good?')) run(() => api('delete', { id: Number(b.dataset.delone) })); return; }
  if (q('[data-act="clear-done"]')) {
    const n = allTasks.filter((t) => t.status === 'done').length;
    if (n && confirm('Delete all ' + n + ' completed task(s) for good?')) run(async () => { for (const t of allTasks.filter((x) => x.status === 'done')) await api('delete', { id: t.id }); });
    return;
  }
  if ((b = q('[data-goto]'))) {
    const t = allTasks.find((x) => String(x.id) === b.dataset.goto);
    if (!t) return;
    board = t.board; page = 'board'; sfilter = 'all';
    tasks = allTasks.filter((x) => x.board === board);
    renderBoards(); render(); openPanel(t.id);
    return;
  }
  if (q('[data-act="pickav"]')) return $('#av-input').click();
  if (q('[data-act="rmav"]')) { if (confirm('Remove your photo?')) { try { await api('rmavatar', { old: profile && profile.avatar_path }); await loadProfile(); toast('Photo removed'); } catch (err) { toast(err.message); } } return; }
  if ((b = q('[data-mode]'))) { applyMode(b.dataset.mode); return renderPage(); }
  if ((b = q('[data-acc]'))) { applyAccent(b.dataset.acc || null); return renderPage(); }
  if ((b = q('[data-act="notif"]'))) { await setNotif(b.getAttribute('aria-checked') !== 'true'); return renderPage(); }
  if (q('[data-act="logout"]')) $('#logout').click();
});

$('#page').addEventListener('change', async (e) => {
  if (e.target.id === 'acc-custom') { applyAccent(e.target.value); return renderPage(); }
  if (e.target.id !== 'av-input') return;
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(f.type)) return toast('Please choose a PNG, JPG, WEBP or GIF image');
  if (f.size > 2 * 1024 * 1024) return toast('The photo must be smaller than 2 MB');
  try { toast('Uploading photo...'); await api('avatar', { file: f, old: profile && profile.avatar_path }); await loadProfile(); toast('Photo updated ♡'); } catch (err) { toast(err.message); }
});

$('#page').addEventListener('input', (e) => {
  if (e.target.id === 'pw-new') checkPassword(e.target.value, '#pw-rules2');
  if (e.target.id === 'pf-bio') $('#bio-n').textContent = e.target.value.length;
});

$('#page').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id === 'profile-form') {
    const name = $('#pf-name').value.trim(), user = $('#pf-user').value.trim().toLowerCase(), bio = $('#pf-bio').value.trim();
    if (!name) return toast('Please enter your name');
    if (user && !/^[a-z0-9_]{3,20}$/.test(user)) return toast('Username: 3 to 20 letters, numbers or underscores');
    try { await api('saveprofile', { fields: { full_name: name, username: user || null, bio } }); await loadProfile(); toast('Profile saved ♡'); } catch (err) { toast(err.message); }
  }
  if (e.target.id === 'pw-form') {
    const cur = $('#pw-cur').value, next = $('#pw-new').value, rep = $('#pw-rep').value;
    if (!checkPassword(next, '#pw-rules2')) return toast('The new password does not meet all the requirements yet');
    if (next !== rep) return toast('The two new passwords do not match');
    if (next === cur) return toast('Choose a password that is different from the current one');
    try { await api('password', { current: cur, next }); e.target.reset(); checkPassword('', '#pw-rules2'); toast('Password changed'); } catch (err) { toast(err.message); }
  }
});

/* ---------- Completed toggle, sidebar pages, mobile menu ---------- */
$('#hide-done').addEventListener('click', () => { hideDone = !hideDone; store('hideDone', hideDone ? '1' : '0'); render(); });
$('.side').addEventListener('click', (e) => {
  const p = e.target.closest('[data-page]');
  if (p) return go(p.dataset.page);
  if (e.target.closest('.nav-i, .add-b')) closeMenu();
});
$('#menu-btn').addEventListener('click', () => document.body.classList.toggle('menu-open'));
$('#scrim').addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

$('#del-board').addEventListener('click', async () => {
  const n = tasks.length;
  if (!confirm(`Delete the board "${board}"${n ? ' and its ' + n + ' item(s)' : ''}? This cannot be undone.`)) return;
  const gone = board;
  try {
    await api('delboard', { name: gone });
    board = boardList.find((b) => b !== gone) || 'Main board';
    sfilter = 'all';
    closePanel();
    await loadTasks();
    toast('Board "' + gone + '" deleted');
  } catch (err) { toast(err.message); }
});

setTimeout(() => $('#auth').classList.add('ready'), 3500); // after the intro, tab switches should be instant

/* ---------- Start ---------- */
(async () => {
  try {
    const r = await api('me');
    if (r.name && recovering) showReset();
    else if (r.name) showApp(r.name); else $('#auth-msg').textContent = oauthError || 'Connected to Supabase ✓';
  } catch (err) { $('#auth-msg').textContent = err.message; }
})();

/* ---------- Website (landing) part: top bar, scroll animations, contact form ---------- */
(function landing() {
  const toTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  // Logo and "back to top" links
  document.querySelectorAll('[data-go="top"]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); toTop(); }));

  // LOGIN ACCOUNT: go to the login card and focus the email box
  $('#nav-login').addEventListener('click', () => {
    showTab(true); toTop();
    setTimeout(() => $('#l-email').focus({ preventScroll: true }), 450);
  });
  // Call to action: open the "Create account" form
  $('#cta-go').addEventListener('click', () => {
    showTab(false); toTop();
    setTimeout(() => $('#r-name').focus({ preventScroll: true }), 450);
  });

  // Animate things when they scroll into view
  const items = document.querySelectorAll('.rv');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((list) => list.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add('seen'); io.unobserve(en.target); }
    }), { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
    items.forEach((el) => io.observe(el));
  } else items.forEach((el) => el.classList.add('seen'));

  // Highlight the top bar link of the section you are reading
  const links = [...document.querySelectorAll('.nav-links a[data-sec]')];
  if ('IntersectionObserver' in window) {
    const so = new IntersectionObserver((list) => list.forEach((en) => {
      if (en.isIntersecting) links.forEach((a) => a.classList.toggle('on', a.dataset.sec === en.target.id));
    }), { rootMargin: '-45% 0px -50% 0px' });
    ['about', 'features', 'contact'].forEach((id) => { const s = document.getElementById(id); if (s) so.observe(s); });
    new IntersectionObserver(([en]) => { if (en.isIntersecting) links.forEach((a) => a.classList.remove('on')); }, { threshold: 0.5 }).observe($('#auth'));
  }

  // Contact form: saved in your Supabase table "contact_messages" (see supabase.sql)
  const form = $('#contact-form');
  const note = $('#c-note');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#c-name').value.trim(), email = $('#c-email').value.trim(), message = $('#c-msg').value.trim();
    if ($('#c-trap').value) { note.textContent = 'Thank you! Your message was sent ♡'; return; } // spam bots fill the hidden box
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || message.length < 5) { note.textContent = 'Please add your name, a valid email and a short message.'; return; }
    let last = 0; try { last = Number(localStorage.getItem('contactAt')) || 0; } catch (err) {}
    if (Date.now() - last < 30000) { note.textContent = 'Please wait a few seconds before sending another message.'; return; }
    if (!sb) { note.textContent = 'The contact form is not connected yet.'; return; }
    const btn = $('#c-send'); btn.disabled = true; note.textContent = 'Sending…';
    const { error } = await sb.from('contact_messages').insert({ name, email, message });
    btn.disabled = false;
    if (error) {
      note.textContent = /contact_messages|relation|schema cache/i.test(error.message) ? 'The contact form needs the latest supabase.sql to be run once.' : error.message;
      return;
    }
    try { localStorage.setItem('contactAt', String(Date.now())); } catch (err) {}
    form.reset();
    note.textContent = 'Thank you! Your message was sent ♡';
  });
})();
