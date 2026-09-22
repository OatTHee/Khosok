/* Khosok · เว็บจัดทัวร์ (แอดมิน) — vanilla JS ไม่มี build step */
'use strict';

// ---------- utils ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = {
  registration: ['เปิดรับสมัคร', 'info'], running: ['กำลังแข่ง', 'green'],
  finished: ['ปิดจ็อบแล้ว', ''], cancelled: ['ยกเลิก', 'danger'],
};
const FORMAT = { swiss: 'Swiss', single_elim: 'แพ้คัดออก' };
const fmtDate = iso => iso ? new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' }) : '';
// ---------- รางวัล: ค่าเริ่มต้น (ตรงกับ tournament/engine.js → DEFAULT_REWARDS) ----------
const MAX_RANKS = 16;
const DEFAULT_REWARDS = {
  points: { ranks: [10, 5, 5, 5, 5], base_top: 3, expand_min_players: 10, expand_top: 5 },
  exp: { ranks: [50, 30, 30, 20, 20], join: 10, full_play: 10 },
};
const clone = o => JSON.parse(JSON.stringify(o));
const expFor = (cfg, rank, full) => (cfg.exp.ranks[rank - 1] || 0) + cfg.exp.join + (full ? cfg.exp.full_play : 0);

// badge บอกว่างานนี้แจกอะไรบ้าง
function rewardBadges(t) {
  const b = [];
  b.push(t.give_points !== false ? '<span class="badge gold">💎 แจกแต้ม</span>' : '<span class="badge off">แต้ม</span>');
  b.push(t.give_exp !== false ? '<span class="badge info">✨ แจก EXP</span>' : '<span class="badge off">EXP</span>');
  if (t.other_rewards) b.push(`<span class="badge warn" title="${esc(t.other_rewards)}">🎁 ของรางวัลอื่น</span>`);
  return `<span class="badges">${b.join('')}</span>`;
}

// ข้อความสรุปการแจกแต้ม (ใช้ในตัวอย่างใต้ฟอร์ม)
function groupRanks(values, upto) {
  const out = [];
  for (let r = 1; r <= upto; r++) {
    const v = values[r - 1] || 0, last = out[out.length - 1];
    if (last && last.v === v) last.to = r; else out.push({ from: r, to: r, v });
  }
  return out.filter(g => g.v > 0);
}
const rankLabel = g => (g.from === 1 && g.to === 1 ? 'แชมป์' : g.from === g.to ? `อันดับ ${g.from}` : `อันดับ ${g.from}–${g.to}`);
function describePointsText(cfg) {
  const p = cfg.points;
  let s = `Top ${p.base_top}: ` + (groupRanks(p.ranks, p.base_top).map(g => `${rankLabel(g)} ${g.v} แต้ม`).join(' · ') || '-');
  if (p.expand_min_players > 0 && p.expand_top > p.base_top) {
    const extra = groupRanks(p.ranks, p.expand_top).map(g => ({ ...g, from: Math.max(g.from, p.base_top + 1) })).filter(g => g.to > p.base_top);
    s += `\nครบ ${p.expand_min_players} คน → Top ${p.expand_top}` + (extra.length ? ` (${extra.map(g => `${rankLabel(g)} ${g.v} แต้ม`).join(' · ')})` : '');
  }
  return s;
}
function describeExpText(cfg) {
  const e = cfg.exp;
  const parts = groupRanks(e.ranks, e.ranks.length).map(g => `${g.from === g.to ? `อันดับ ${g.from}` : `อันดับ ${g.from}-${g.to}`} +${g.v}`);
  if (e.join) parts.push(`เข้าร่วม +${e.join}`);
  if (e.full_play) parts.push(`เล่นครบทุกรอบ +${e.full_play}`);
  return parts.join(' · ') || 'ไม่มี EXP';
}

// ฟอร์มตั้งค่ารางวัล — ใช้ทั้งตอนสร้างงานและแท็บตั้งค่า
// lock = { points: 'ข้อความ' | null, exp: 'ข้อความ' | null }
function rewardEditorHTML(t, lock = {}) {
  const gp = t?.give_points !== false, ge = t?.give_exp !== false, other = t?.other_rewards || '';
  const dp = lock.points ? 'disabled' : '', de = lock.exp ? 'disabled' : '';
  return `
  <div class="rw" id="rw">
    <div class="rw-block ${gp ? '' : 'off'}" data-block="points">
      <label class="rw-toggle"><input type="checkbox" name="give_points" ${gp ? 'checked' : ''} ${dp}> 💎 แจกแต้มแลกการ์ด</label>
      ${lock.points ? `<div class="rw-locked">🔒 ${esc(lock.points)}</div>` : ''}
      <div class="rw-nums">
        <label>ได้แต้มกี่อันดับ (ปกติ)<input type="number" min="1" max="${MAX_RANKS}" data-rw="p.base_top" ${dp}></label>
        <label>ขยายเมื่อครบ (คน)<input type="number" min="0" max="1000" data-rw="p.expand_min_players" ${dp}><span class="hint">0 = ไม่ขยาย</span></label>
        <label>ขยายถึงอันดับ<input type="number" min="1" max="${MAX_RANKS}" data-rw="p.expand_top" ${dp}></label>
      </div>
      <div class="rank-grid" data-grid="points"></div>
      <div class="rw-preview" data-preview="points"></div>
    </div>
    <div class="rw-block ${ge ? '' : 'off'}" data-block="exp">
      <label class="rw-toggle"><input type="checkbox" name="give_exp" ${ge ? 'checked' : ''} ${de}> ✨ แจก EXP</label>
      ${lock.exp ? `<div class="rw-locked">🔒 ${esc(lock.exp)}</div>` : ''}
      <div class="rank-grid" data-grid="exp"></div>
      <div class="row" style="gap:6px">
        <button type="button" class="btn ghost sm" data-exp-rows="-1" ${de}>− อันดับ</button>
        <button type="button" class="btn ghost sm" data-exp-rows="1" ${de}>+ อันดับ</button>
      </div>
      <div class="rw-nums">
        <label>เข้าร่วม (+EXP)<input type="number" min="0" data-rw="e.join" ${de}></label>
        <label>เล่นครบทุกรอบ (+EXP)<input type="number" min="0" data-rw="e.full_play" ${de}></label>
      </div>
      <div class="rw-preview" data-preview="exp"></div>
    </div>
    <div class="rw-block ${other ? '' : 'off'}" data-block="other">
      <label class="rw-toggle"><input type="checkbox" name="give_other" ${other ? 'checked' : ''}> 🎁 มีของรางวัลอื่น <span class="hint">แสดงผลอย่างเดียว แอดมินแจกเอง</span></label>
      <textarea name="other_rewards" maxlength="500" rows="3" placeholder="เช่น แชมป์ได้ซองการ์ด 1 ซอง / Top 4 ได้สลีฟลายพิเศษ">${esc(other)}</textarea>
    </div>
    <div class="row"><button type="button" class="btn ghost sm" data-rw-reset ${lock.points && lock.exp ? 'disabled' : ''}>คืนค่าเกณฑ์มาตรฐาน</button></div>
  </div>`;
}

function bindRewardEditor(root, initialCfg, lock = {}) {
  const cfg = clone(initialCfg || DEFAULT_REWARDS);
  const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
  const pointRows = () => Math.max(1, cfg.points.base_top, cfg.points.expand_min_players > 0 ? cfg.points.expand_top : 0);
  const paint = () => {
    const p = cfg.points, e = cfg.exp;
    while (p.ranks.length < pointRows()) p.ranks.push(0);
    p.ranks.length = Math.min(p.ranks.length, pointRows());
    root.querySelector('[data-rw="p.base_top"]').value = p.base_top;
    root.querySelector('[data-rw="p.expand_min_players"]').value = p.expand_min_players;
    root.querySelector('[data-rw="p.expand_top"]').value = p.expand_top;
    root.querySelector('[data-rw="p.expand_top"]').disabled = !!lock.points || !(p.expand_min_players > 0);
    root.querySelector('[data-rw="e.join"]').value = e.join;
    root.querySelector('[data-rw="e.full_play"]').value = e.full_play;
    root.querySelector('[data-grid="points"]').innerHTML = p.ranks.map((v, i) =>
      `<label class="${i >= p.base_top ? 'extra' : ''}">อันดับ ${i + 1}${i >= p.base_top ? ' (ขยาย)' : ''}<input type="number" min="0" value="${v}" data-pr="${i}" ${lock.points ? 'disabled' : ''}></label>`).join('');
    root.querySelector('[data-grid="exp"]').innerHTML = e.ranks.map((v, i) =>
      `<label>อันดับ ${i + 1}<input type="number" min="0" value="${v}" data-er="${i}" ${lock.exp ? 'disabled' : ''}></label>`).join('');
    root.querySelector('[data-preview="points"]').textContent = describePointsText(cfg);
    root.querySelector('[data-preview="exp"]').textContent = describeExpText(cfg);
  };
  const previewOnly = () => {
    root.querySelector('[data-preview="points"]').textContent = describePointsText(cfg);
    root.querySelector('[data-preview="exp"]').textContent = describeExpText(cfg);
  };
  root.addEventListener('input', ev => {
    const el = ev.target;
    if (el.dataset.pr !== undefined) { cfg.points.ranks[+el.dataset.pr] = num(el.value, 0); previewOnly(); }
    else if (el.dataset.er !== undefined) { cfg.exp.ranks[+el.dataset.er] = num(el.value, 0); previewOnly(); }
    else if (el.dataset.rw === 'e.join') { cfg.exp.join = num(el.value, 0); previewOnly(); }
    else if (el.dataset.rw === 'e.full_play') { cfg.exp.full_play = num(el.value, 0); previewOnly(); }
  });
  root.addEventListener('change', ev => {
    const el = ev.target, p = cfg.points;
    if (el.dataset.rw === 'p.base_top') p.base_top = Math.min(MAX_RANKS, Math.max(1, num(el.value, 1)));
    else if (el.dataset.rw === 'p.expand_min_players') p.expand_min_players = Math.min(1000, num(el.value, 0));
    else if (el.dataset.rw === 'p.expand_top') p.expand_top = Math.min(MAX_RANKS, num(el.value, p.base_top));
    else if (el.type === 'checkbox') { el.closest('.rw-block')?.classList.toggle('off', !el.checked); return; }
    else return;
    if (p.expand_top < p.base_top) p.expand_top = p.base_top;
    paint();
  });
  root.addEventListener('click', ev => {
    const b = ev.target.closest('[data-exp-rows],[data-rw-reset]');
    if (!b) return;
    if (b.dataset.expRows) {
      const n = cfg.exp.ranks.length + Number(b.dataset.expRows);
      if (n >= 1 && n <= MAX_RANKS) { if (n > cfg.exp.ranks.length) cfg.exp.ranks.push(0); else cfg.exp.ranks.pop(); }
    } else {
      if (!lock.points) cfg.points = clone(DEFAULT_REWARDS.points);
      if (!lock.exp) cfg.exp = clone(DEFAULT_REWARDS.exp);
    }
    paint();
  });
  paint();
  return {
    read() {
      const q = n => root.querySelector(`[name="${n}"]`);
      return {
        give_points: q('give_points').checked,
        give_exp: q('give_exp').checked,
        other_rewards: q('give_other').checked ? q('other_rewards').value : '',
        reward_config: clone(cfg),
      };
    },
  };
}

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, isErr ? 5000 : 2500);
}

// ---------- state ----------
const S = { sb: null, session: null, me: null, view: null, code: null, tab: null, round: null, finishChecks: null, poll: null, tick: null, lastJson: '' };

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.session?.access_token || ''}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401) { S.me = null; await S.sb.auth.signOut().catch(() => {}); throw new Error(data?.error || 'กรุณาเข้าสู่ระบบ'); }
  if (!res.ok) throw new Error(data?.error || `ผิดพลาด (HTTP ${res.status})`);
  return data;
}

// ทำงาน + แจ้งผล + โหลดใหม่
async function act(fn, okMsg, btn) {
  if (btn) btn.disabled = true;
  try {
    const out = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(out) : okMsg);
    if (S.code) await loadDetail(true);
    return out;
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- dialog ----------
function openDialog(html, onSubmit) {
  const dlg = $('#dialog'), body = $('#dialog-body');
  body.innerHTML = html;
  body.onsubmit = async ev => {
    const submitter = ev.submitter;
    if (!submitter || submitter.value === 'cancel') return;
    ev.preventDefault();
    submitter.disabled = true;
    try {
      const ok = await onSubmit(new FormData(body), submitter.value);
      if (ok !== false) dlg.close();
    } catch (e) { toast(e.message, true); } finally { submitter.disabled = false; }
  };
  dlg.showModal();
  const first = body.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select');
  if (first) first.focus();
}
function confirmBox(title, text, okLabel = 'ยืนยัน', danger = false) {
  return new Promise(resolve => {
    openDialog(`
      <h2>${esc(title)}</h2>
      <div class="muted">${text}</div>
      <div class="dlg-actions">
        <button class="btn secondary" value="cancel">ยกเลิก</button>
        <button class="btn ${danger ? 'danger' : ''}" value="ok">${esc(okLabel)}</button>
      </div>`, async () => { resolve(true); });
    $('#dialog').addEventListener('close', () => resolve(false), { once: true });
  });
}

// ---------- boot ----------
async function boot() {
  const cfg = await fetch('/api/config').then(r => r.json());
  if (!cfg.supabaseUrl || !cfg.supabaseKey) {
    $('#app').innerHTML = `<div class="empty">ยังไม่ได้ตั้งค่า SUPABASE_URL บนเซิร์ฟเวอร์</div>`;
    return;
  }
  S.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, detectSessionInUrl: true } });
  const { data } = await S.sb.auth.getSession();
  S.session = data.session;
  S.sb.auth.onAuthStateChange((event, session) => {
    const changed = (S.session?.access_token || null) !== (session?.access_token || null);
    S.session = session;
    if (event === 'SIGNED_OUT') S.me = null;
    if (changed && (event === 'SIGNED_IN' || event === 'SIGNED_OUT')) route();
  });
  $('#logout').onclick = async () => { await S.sb.auth.signOut(); S.me = null; location.hash = '#/'; route(); };
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.code) loadDetail(false); });
  route();
}

async function route() {
  clearInterval(S.poll); S.poll = null;
  if (!S.session) { S.code = null; $('#userbox').hidden = true; return renderLogin(); }
  if (!S.me) {
    try { S.me = await api('GET', '/me'); }
    catch (e) {
      $('#userbox').hidden = false; $('#username').textContent = S.session.user?.email || '';
      $('#staff-link').hidden = true;
      $('#app').innerHTML = `<div class="login"><div class="card"><h2>เข้าใช้งานไม่ได้</h2><p class="muted">${esc(e.message)}</p><p class="small muted">เว็บนี้ใช้ได้เฉพาะแอดมินร้านและสตาฟจัดทัวร์ที่ได้รับแต่งตั้ง</p></div></div>`;
      return;
    }
  }
  $('#userbox').hidden = false;
  $('#username').textContent = `${S.me.name || S.me.email || ''} · ${S.me.role === 'admin' ? 'แอดมิน' : 'สตาฟ'}`;
  $('#staff-link').hidden = S.me.role !== 'admin';
  if (location.hash.startsWith('#/staff')) { S.code = null; return renderStaff(); }
  const m = location.hash.match(/^#\/t\/([\w-]+)/);
  if (m) {
    if (S.code !== m[1]) { S.code = m[1]; S.tab = null; S.round = null; S.finishChecks = null; S.rwDirty = false; S.lastJson = ''; S.view = null; }
    $('#app').innerHTML = '<div class="loading">กำลังโหลด…</div>';
    await loadDetail(true);
    S.poll = setInterval(() => { if (!document.hidden) loadDetail(false); }, 8000);
  } else {
    S.code = null;
    renderList();
  }
}

// ---------- login ----------
function renderLogin() {
  $('#app').innerHTML = `
  <div class="login">
    <h1 style="margin-bottom:6px">🦖 เว็บจัดทัวร์ Khosok</h1>
    <p class="muted" style="margin-top:0">เข้าสู่ระบบด้วยบัญชีแอดมินเดียวกับเว็บ DMT Shop</p>
    <div class="card">
      <button class="btn secondary block" data-oauth="google">เข้าสู่ระบบด้วย Google</button>
      <button class="btn secondary block" data-oauth="discord">เข้าสู่ระบบด้วย Discord</button>
      <div class="divider">หรือใช้อีเมล</div>
      <form id="pwform" class="stack">
        <label class="field">อีเมล<input name="email" type="email" autocomplete="username" required></label>
        <label class="field">รหัสผ่าน<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn block">เข้าสู่ระบบ</button>
      </form>
    </div>
  </div>`;
  document.querySelectorAll('[data-oauth]').forEach(b => b.onclick = async () => {
    const { error } = await S.sb.auth.signInWithOAuth({ provider: b.dataset.oauth, options: { redirectTo: location.origin + location.pathname } });
    if (error) toast(error.message, true);
  });
  $('#pwform').onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const { error } = await S.sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
    if (error) toast('อีเมลหรือรหัสผ่านไม่ถูกต้อง', true);
  };
}

// ---------- list ----------
async function renderList() {
  $('#app').innerHTML = '<div class="loading">กำลังโหลด…</div>';
  let list;
  try { list = await api('GET', '/tournaments'); } catch (e) { $('#app').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const items = list.map(t => {
    const [label, cls] = STATUS[t.status] || [t.status, ''];
    return `<a class="card t-item" href="#/t/${t.code}">
      <div class="t-num">#${t.code}</div>
      <div class="t-main">
        <h3>${esc(t.name)}</h3>
        <div class="row small muted"><span>${FORMAT[t.format]}</span><span>·</span><span>${t.player_count} คน</span>${rewardBadges(t)}${t.start_at ? `<span class="hide-sm">·</span><span class="hide-sm">${fmtDate(t.start_at)}</span>` : ''}</div>
      </div>
      <span class="badge ${cls}">${label}</span>
    </a>`;
  }).join('');
  $('#app').innerHTML = `
    <div class="spread" style="margin-bottom:16px">
      <h1>งานแข่ง</h1>
      <button class="btn" id="new-t">+ สร้างงานใหม่</button>
    </div>
    <div class="t-list">${items || '<div class="card empty">ยังไม่มีงานแข่ง กด "สร้างงานใหม่" เพื่อเริ่ม</div>'}</div>`;
  $('#new-t').onclick = openCreate;
}

function openCreate() {
  openDialog(`
    <h2>สร้างงานแข่งใหม่</h2>
    <label class="field">ชื่องาน<input name="name" required maxlength="120" placeholder="เช่น DBWC #13"></label>
    <div class="field"><span>รูปแบบ</span>
      <div class="seg">
        <label><input type="radio" name="format" value="swiss" checked><span><b>Swiss</b><br><span class="hint">ทุกคนได้เล่นครบทุกรอบ จับคู่ตามคะแนน</span></span></label>
        <label><input type="radio" name="format" value="single_elim"><span><b>แพ้คัดออก</b><br><span class="hint">แพ้แล้วตกรอบ</span></span></label>
      </div>
    </div>
    <div class="row">
      <label class="field" style="flex:1">จำนวนรอบ Swiss<input name="swiss_rounds" type="number" min="1" max="20" placeholder="อัตโนมัติ"><span class="hint">เว้นว่าง = คำนวณจากจำนวนคน</span></label>
      <label class="field" style="flex:1">นาทีต่อรอบ<input name="round_minutes" type="number" min="1" max="240" value="40"></label>
    </div>
    <label class="field">เวลาเริ่มงาน (ไม่บังคับ)<input name="start_at" type="datetime-local"></label>
    <div class="field"><span>รางวัล</span>${rewardEditorHTML(null)}</div>
    <div class="dlg-actions"><button class="btn secondary" value="cancel">ยกเลิก</button><button class="btn" value="ok">สร้างงาน</button></div>
  `, async f => {
    const t = await api('POST', '/tournaments', {
      name: f.get('name'), format: f.get('format'),
      swiss_rounds: f.get('swiss_rounds') || null, round_minutes: Number(f.get('round_minutes') || 40),
      start_at: f.get('start_at') ? new Date(f.get('start_at')).toISOString() : null,
      ...editor.read(),
    });
    toast(`สร้างงาน #${t.code} แล้ว`);
    location.hash = `#/t/${t.code}`;
  });
  const editor = bindRewardEditor($('#rw'), DEFAULT_REWARDS);
}

// ---------- detail ----------
async function loadDetail(force) {
  if (!S.code) return;
  // ไม่รีเฟรชทับตอนกำลังพิมพ์ หรือเปิดหน้าต่างอยู่
  if (!force && (S.rwDirty || $('#dialog').open || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName))) return;
  let v;
  try { v = await api('GET', `/tournaments/${S.code}`); }
  catch (e) { if (force) $('#app').innerHTML = `<div class="empty">${esc(e.message)}<br><br><a href="#/">← กลับหน้ารวม</a></div>`; return; }
  const json = JSON.stringify(v);
  if (!force && json === S.lastJson) return;
  S.lastJson = json;
  S.view = v;
  renderDetail();
}

function defaultTab(t) {
  return t.status === 'registration' ? 'players' : t.status === 'running' ? 'matches' : 'standings';
}

function renderDetail() {
  const v = S.view, t = v.tournament;
  if (!S.tab) S.tab = defaultTab(t);
  const [label, cls] = STATUS[t.status] || [t.status, ''];
  const active = v.players.filter(p => !p.dropped_at).length;
  const tabs = [
    ['players', `ผู้เล่น (${v.players.length})`],
    ['matches', t.format === 'single_elim' ? 'สายการแข่ง' : 'จับคู่ & กรอกผล'],
    ['standings', 'ตารางคะแนน'],
    ['finish', t.give_points === false && t.give_exp === false ? 'ปิดจ็อบ' : 'แจกรางวัล & ปิดจ็อบ'],
    ['settings', 'ตั้งค่า'],
    ['log', 'บันทึกการแก้ไข'],
  ];
  $('#app').innerHTML = `
    <a href="#/" class="small muted" style="text-decoration:none">← งานแข่งทั้งหมด</a>
    <div class="head" style="margin-top:8px">
      <div>
        <h1>${esc(t.name)}</h1>
        <div class="row small muted" style="margin-top:6px">
          <span class="badge ${cls}">${label}</span>
          <span>${FORMAT[t.format]}</span>
          ${rewardBadges(t)}
          <span>·</span>
          <span>Discord: <span class="code">!setup ${t.code}</span></span>
        </div>
      </div>
      <div class="row">${headActions(v)}</div>
    </div>
    <div class="stats">
      <div class="card stat"><div class="v">${v.players.length}${t.status !== 'registration' && active !== v.players.length ? ` <span class="small muted">(${active} ยังอยู่)</span>` : ''}</div><div class="k">ผู้เข้าแข่งขัน</div></div>
      <div class="card stat"><div class="v">${v.currentRound || '–'} / ${v.totalRounds}</div><div class="k">รอบ</div></div>
      ${t.give_points !== false ? `<div class="card stat"><div class="v">Top ${v.pointsQuota}</div><div class="k">โควตาแจกแต้ม</div></div>` : ''}
      ${t.status === 'running' ? `<div class="card stat timer" id="timer"><div class="v" id="timer-v">–</div><div class="k row" style="justify-content:space-between">เวลารอบนี้ <span>${t.round_ends_at
        ? `<button class="btn ghost sm" id="timer-stop">หยุด</button>`
        : `<button class="btn sm" id="timer-go">เริ่ม ${t.round_minutes} นาที</button>`}</span></div></div>` : ''}
    </div>
    <nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav>
    <section id="tab"></section>`;

  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; S.rwDirty = false; renderDetail(); });
  bindHeadActions(v);
  const timerGo = $('#timer-go'), timerStop = $('#timer-stop');
  if (timerGo) timerGo.onclick = () => act(() => api('POST', `/tournaments/${t.code}/timer`, {}), 'เริ่มจับเวลาแล้ว', timerGo);
  if (timerStop) timerStop.onclick = () => act(() => api('DELETE', `/tournaments/${t.code}/timer`), 'หยุดจับเวลาแล้ว', timerStop);
  startTick();

  const tab = $('#tab');
  ({ players: renderPlayers, matches: renderMatches, standings: renderStandings, finish: renderFinish, settings: renderSettings, log: renderLog }[S.tab] || renderPlayers)(tab, v);
}

function startTick() {
  clearInterval(S.tick);
  const t = S.view?.tournament;
  const el = $('#timer-v');
  if (!el) return;
  const paint = () => {
    if (!t.round_ends_at) { el.textContent = 'ยังไม่จับ'; return; }
    const ms = new Date(t.round_ends_at) - Date.now();
    const a = Math.abs(ms), m = Math.floor(a / 60000), s = Math.floor((a % 60000) / 1000);
    el.textContent = `${ms < 0 ? '+' : ''}${m}:${String(s).padStart(2, '0')}`;
    $('#timer')?.classList.toggle('late', ms < 0);
  };
  paint();
  S.tick = setInterval(paint, 1000);
}

function headActions(v) {
  const t = v.tournament;
  if (t.status === 'registration') return `<button class="btn" id="start" ${v.players.length < 2 ? 'disabled' : ''}>🔀 สุ่ม seed & เริ่มแข่ง</button>`;
  if (t.status === 'running') {
    if (v.canNextRound) return `<button class="btn" id="next-round">จับคู่รอบที่ ${v.currentRound + 1} →</button>`;
    if (v.canFinish) return `<button class="btn warn" id="goto-finish">🏁 ไปหน้าปิดจ็อบ</button>`;
  }
  return '';
}
function bindHeadActions(v) {
  const t = v.tournament;
  const start = $('#start'), next = $('#next-round'), fin = $('#goto-finish');
  if (start) start.onclick = async () => {
    if (!await confirmBox('เริ่มแข่ง?', `ปิดรับสมัคร สุ่ม seed ผู้เล่น ${v.players.length} คน แล้วจับคู่รอบแรก<br>หลังเริ่มแล้วเปลี่ยนรูปแบบการแข่งไม่ได้`, 'เริ่มแข่ง')) return;
    S.tab = 'matches';
    act(() => api('POST', `/tournaments/${t.code}/start`), 'สุ่ม seed และจับคู่รอบแรกแล้ว', start);
  };
  if (next) next.onclick = () => { S.round = null; act(() => api('POST', `/tournaments/${t.code}/next-round`), `จับคู่รอบที่ ${v.currentRound + 1} แล้ว`, next); };
  if (fin) fin.onclick = () => { S.tab = 'finish'; renderDetail(); };
}

// ---------- players tab ----------
function playerBadge(p) {
  if (p.customer_id) return '<span class="badge green">บัญชีเว็บ</span>';
  if (p.discord_id) return '<span class="badge info">Discord</span>';
  return '<span class="badge warn" title="ไม่ได้แต้ม/EXP">walk-in</span>';
}

function renderPlayers(el, v) {
  const t = v.tournament;
  const canAdd = t.status === 'registration' || (t.status === 'running' && t.format === 'swiss');
  const byId = Object.fromEntries(v.standings.map(s => [s.player_id, s]));
  const rows = v.players.slice().sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9) || a.created_at.localeCompare(b.created_at)).map((p, i) => {
    const st = byId[p.id];
    let actions = '';
    if (t.status === 'registration') actions = `<button class="btn ghost sm" data-remove="${p.id}">ลบ</button>`;
    else if (t.status === 'running') actions = p.dropped_at
      ? `<button class="btn ghost sm" data-undrop="${p.id}">กลับเข้าแข่ง</button>`
      : `<button class="btn ghost sm" data-drop="${p.id}">ถอนตัว</button>`;
    return `<tr class="${p.dropped_at ? 'dim' : ''}">
      <td class="num muted">${p.seed ?? i + 1}</td>
      <td><span class="pname">${esc(p.display_name)}</span> ${p.dropped_at ? '<span class="badge danger">ถอนตัว</span>' : ''}</td>
      <td>${playerBadge(p)}</td>
      <td class="num hide-sm">${t.status === 'registration' ? '' : `${st?.wins ?? 0}-${st?.losses ?? 0}`}</td>
      <td style="text-align:right;white-space:nowrap"><button class="btn ghost sm" data-rename="${p.id}">แก้ชื่อ</button> ${actions}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="stack">
      ${canAdd ? `
      <div class="card pad stack">
        <div class="spread"><h2>เพิ่มผู้เล่น</h2>${t.status === 'running' ? '<span class="badge warn">เข้ากลางงาน: เริ่มจาก 0 ชนะ ในรอบถัดไป</span>' : ''}</div>
        <div class="row">
          <input id="acc-q" placeholder="ค้นชื่อ / UID / Discord ID ของสมาชิก" style="flex:1;min-width:200px" autocomplete="off">
        </div>
        <div id="acc-results" class="search-results"></div>
        <div class="divider">หรือ walk-in (ไม่มีบัญชี ไม่ได้แต้ม/EXP)</div>
        <form class="row" id="walkin"><input name="n" placeholder="ชื่อผู้เล่น" required maxlength="80" style="flex:1;min-width:160px"><button class="btn secondary">เพิ่ม walk-in</button></form>
      </div>` : ''}
      ${t.status === 'registration' ? `<div class="notice">ผู้เล่นสมัครเองได้จากปุ่มในบอร์ด Discord (<span class="code">!setup ${t.code}</span>) — รายชื่อจะขึ้นที่นี่อัตโนมัติ</div>` : ''}
      <div class="card table-wrap">
        <table>
          <thead><tr><th class="num">Seed</th><th>ชื่อ</th><th>บัญชี</th><th class="num hide-sm">ชนะ-แพ้</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="empty">ยังไม่มีผู้เล่น</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  const q = $('#acc-q');
  if (q) {
    let timer;
    q.oninput = () => {
      clearTimeout(timer);
      const term = q.value.trim();
      if (!term) { $('#acc-results').innerHTML = ''; return; }
      timer = setTimeout(async () => {
        try {
          const list = await api('GET', `/accounts?q=${encodeURIComponent(term)}`);
          const inIds = new Set(v.players.map(p => p.customer_id).filter(Boolean));
          const inDiscord = new Set(v.players.map(p => p.discord_id).filter(Boolean));
          $('#acc-results').innerHTML = list.length ? list.map((a, i) => {
            const already = (a.customer_id && inIds.has(a.customer_id)) || (a.discord_id && inDiscord.has(a.discord_id));
            return `<div class="result"><div><div class="name">${esc(a.name)}</div><div class="small muted">${esc(a.sub || '')}${a.discord_id ? '' : ' · ไม่ได้ผูก Discord'}</div></div>
              <button class="btn sm" data-add="${i}" ${already ? 'disabled' : ''}>${already ? 'อยู่ในงานแล้ว' : 'เพิ่ม'}</button></div>`;
          }).join('') : '<div class="small muted">ไม่พบสมาชิก</div>';
          document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
            const a = list[Number(b.dataset.add)];
            act(() => api('POST', `/tournaments/${t.code}/players`, a.customer_id ? { customer_id: a.customer_id } : { discord_id: a.discord_id, display_name: a.name }),
              `เพิ่ม ${a.name} แล้ว`, b).then(() => { const qq = $('#acc-q'); if (qq) { qq.value = ''; qq.focus(); } });
          });
        } catch (e) { toast(e.message, true); }
      }, 250);
    };
  }
  const wi = $('#walkin');
  if (wi) wi.onsubmit = ev => {
    ev.preventDefault();
    const name = new FormData(wi).get('n');
    act(() => api('POST', `/tournaments/${t.code}/players`, { display_name: name }), `เพิ่ม ${name} แล้ว`, wi.querySelector('button'));
  };
  el.querySelectorAll('[data-remove]').forEach(b => b.onclick = () =>
    act(() => api('DELETE', `/tournaments/${t.code}/players/${b.dataset.remove}`), 'ลบแล้ว', b));
  el.querySelectorAll('[data-drop]').forEach(b => b.onclick = async () => {
    const p = v.players.find(x => x.id === b.dataset.drop);
    if (!await confirmBox('ถอนตัวผู้เล่น?', `<b>${esc(p.display_name)}</b> จะไม่ถูกจับคู่ในรอบถัดไป และจะอยู่ท้ายตารางเสมอ<br>ถ้ามีแมตช์ค้างในรอบนี้ ให้กรอกผลเป็น "ปรับแพ้"`, 'ถอนตัว', true)) return;
    act(() => api('POST', `/tournaments/${t.code}/players/${p.id}/drop`, { dropped: true }), 'ถอนตัวแล้ว');
  });
  el.querySelectorAll('[data-undrop]').forEach(b => b.onclick = () =>
    act(() => api('POST', `/tournaments/${t.code}/players/${b.dataset.undrop}/drop`, { dropped: false }), 'กลับเข้าแข่งแล้ว', b));
  el.querySelectorAll('[data-rename]').forEach(b => b.onclick = () => {
    const p = v.players.find(x => x.id === b.dataset.rename);
    openDialog(`<h2>แก้ชื่อที่แสดง</h2><label class="field">ชื่อ<input name="n" value="${esc(p.display_name)}" required maxlength="80"></label>
      <div class="dlg-actions"><button class="btn secondary" value="cancel">ยกเลิก</button><button class="btn" value="ok">บันทึก</button></div>`,
      async f => { await api('POST', `/tournaments/${t.code}/players/${p.id}/rename`, { name: f.get('n') }); toast('บันทึกแล้ว'); loadDetail(true); });
  });
}

// ---------- matches tab ----------
function nameMap(v) { return Object.fromEntries(v.players.map(p => [p.id, p.display_name])); }

// ---------- แก้ผลย้อนหลัง: ตัวช่วยฝั่งหน้าเว็บ (ตรงกับ tournament/engine.js) ----------
const nextElim = (matches, m) => matches.find(x => x.round === m.round + 1 && x.slot === Math.ceil(m.slot / 2)) || null;
function elimPlayedDownstream(matches, m) {
  const out = [];
  let cur = nextElim(matches, m);
  while (cur) { if (cur.status === 'complete' && !cur.is_bye) out.push(cur); cur = nextElim(matches, cur); }
  return out;
}
// แก้ย้อนหลัง = Swiss รอบที่ผ่านไปแล้ว / แพ้คัดออกที่รอบหลังกรอกผลแล้ว → ต้องใส่เหตุผล
function isBackdated(m, v) {
  const t = v.tournament;
  if (t.format === 'swiss') return m.round < t.current_round;
  return elimPlayedDownstream(v.matches, m).length > 0;
}
const reasonField = (required, placeholder = 'เช่น คีย์ผู้ชนะสลับกัน / ผู้เล่นแจ้งหลังจบรอบ') => `
  <label class="field">เหตุผล${required ? '' : ' (ไม่บังคับ)'}<textarea name="reason" rows="2" maxlength="500" ${required ? 'required' : ''} placeholder="${esc(placeholder)}"></textarea>
    <span class="hint">เก็บไว้ในแท็บ "บันทึกการแก้ไข" พร้อมชื่อคนแก้</span></label>`;

function matchCard(m, v, names) {
  const t = v.tournament;
  if (m.is_bye) {
    return `<div class="card match done"><div class="match-top"><b>โต๊ะ ${m.slot}</b><span class="badge">บาย</span></div>
      <div class="side win"><span class="n">${esc(names[m.player1_id || m.player2_id])}</span><span class="small">ชนะบาย</span></div></div>`;
  }
  const done = m.status === 'complete';
  const running = t.status === 'running';
  const back = running && isBackdated(m, v);
  const editable = running && !back; // กรอกผลปกติ (ปุ่ม "ชนะ" บนการ์ด)
  const side = (pid, key, score) => {
    const cls = done ? (m.winner_id === pid ? 'win' : 'lose') : '';
    return `<div class="side ${cls}"><span class="n">${esc(names[pid] || 'รอผู้ชนะ')}</span>${done
      ? `<span class="small">${m.winner_id === pid ? '🏆 ชนะ' : (m.forfeit_player_id === pid ? 'ปรับแพ้' : '')}${score !== null && score !== undefined ? ` · ${score}` : ''}</span>`
      : editable && pid ? `<button class="btn sm" data-win="${m.id}" data-side="${key}">ชนะ</button>` : ''}</div>`;
  };
  let foot = '';
  if (running && done) {
    foot = back
      ? `<div class="match-foot"><span class="muted small">↩️ แก้ย้อนหลัง (ต้องใส่เหตุผล)</span><button class="btn ghost sm" data-edit="${m.id}">แก้ผล</button></div>`
      : `<div class="match-foot"><span class="muted">แก้ไขผล</span><span class="row" style="gap:6px"><button class="btn ghost sm" data-edit="${m.id}">แก้ผล</button><button class="btn ghost sm" data-clear="${m.id}">ล้างผล</button></span></div>`;
  } else if (running && m.status === 'open') {
    foot = back
      ? `<div class="match-foot"><span class="muted small">รอบที่ผ่านไปแล้ว</span><button class="btn sm" data-edit="${m.id}">กรอกผลย้อนหลัง</button></div>`
      : `<div class="match-foot">
          <span class="row" style="gap:6px">สกอร์ <input type="number" min="0" max="99" data-s1="${m.id}" aria-label="สกอร์ผู้เล่น 1"> - <input type="number" min="0" max="99" data-s2="${m.id}" aria-label="สกอร์ผู้เล่น 2"></span>
          <label class="row" style="gap:6px"><input type="checkbox" data-ff="${m.id}"> ปรับแพ้ (ถอนตัว/ฟาวล์)</label>
        </div>`;
  }
  return `<div class="card match ${done ? 'done' : ''}" data-match="${m.id}">
    <div class="match-top"><b>โต๊ะ ${m.slot}</b>${done ? '<span class="badge green">กรอกผลแล้ว</span>' : m.status === 'pending' ? '<span class="badge">รอคู่แข่ง</span>' : '<span class="badge info">กำลังแข่ง</span>'}</div>
    ${side(m.player1_id, 'p1', m.score1)}
    <div class="vs">VS</div>
    ${side(m.player2_id, 'p2', m.score2)}
    ${foot}
  </div>`;
}

// หน้าต่างแก้ผล (ใช้ทั้งแก้ผลรอบปัจจุบัน และแก้ย้อนหลัง)
function openEditMatch(m, v) {
  const t = v.tournament, names = nameMap(v);
  const back = isBackdated(m, v);
  const downstream = t.format === 'single_elim' ? elimPlayedDownstream(v.matches, m) : [];
  const done = m.status === 'complete';
  const canClear = done && !(t.format === 'swiss' && back); // Swiss รอบเก่า: แก้ได้ แต่ไม่ล้างทิ้ง
  const where = t.format === 'single_elim' ? `รอบ ${m.round} คู่ ${m.slot}` : `รอบ ${m.round} โต๊ะ ${m.slot}`;
  const radio = (key, pid) => `<label><input type="radio" name="winner" value="${key}" ${done && m.winner_id === pid ? 'checked' : ''} required><span><b>${esc(names[pid])}</b></span></label>`;
  openDialog(`
    <h2>${done ? 'แก้ผล' : 'กรอกผล'} · ${where}</h2>
    ${t.format === 'swiss' && back ? `<div class="notice warn small">รอบนี้ผ่านไปแล้ว — ตารางคะแนนและ BH จะคำนวณใหม่ แต่การจับคู่รอบหลังที่แข่งไปแล้วคงเดิม<br>ถ้ารอบถัดไปยังไม่ได้เริ่มเล่นจริง ใช้ปุ่ม "ย้อนกลับไปรอบนี้" เพื่อจับคู่ใหม่แทน</div>` : ''}
    ${v.rewardsGiven ? '<div class="notice warn small">งานนี้แจกแต้ม/EXP ไปแล้วตามผลเดิม — แก้ผลตอนนี้จะไม่เปลี่ยนแต้ม/EXP ที่แจกไป</div>' : ''}
    <div class="field"><span>ผู้ชนะ</span><div class="seg">${radio('p1', m.player1_id)}${radio('p2', m.player2_id)}</div></div>
    <div class="row">
      <label class="field" style="flex:1">สกอร์ ${esc(names[m.player1_id])}<input type="number" name="s1" min="0" max="99" value="${m.score1 ?? ''}"></label>
      <label class="field" style="flex:1">สกอร์ ${esc(names[m.player2_id])}<input type="number" name="s2" min="0" max="99" value="${m.score2 ?? ''}"></label>
    </div>
    <label class="row" style="gap:6px;margin-bottom:12px"><input type="checkbox" name="ff" ${m.forfeit_player_id ? 'checked' : ''}> ผู้แพ้โดนปรับแพ้ (ถอนตัว/ฟาวล์)</label>
    ${downstream.length ? `
    <div class="field"><span>รอบหลังกรอกผลไปแล้ว ${downstream.length} แมตช์ (${downstream.map(x => `รอบ ${x.round} คู่ ${x.slot}`).join(', ')}) — ถ้าเปลี่ยนตัวผู้ชนะ ให้เลือก</span>
      <div class="seg">
        <label><input type="radio" name="mode" value="swap"><span><b>สลับชื่อ</b><br><span class="hint">คีย์ผิดคน แต่คนที่ชนะจริงเป็นคนไปแข่งต่อ → แทนชื่อในรอบหลัง ผลเดิมคงไว้</span></span></label>
        <label><input type="radio" name="mode" value="cascade"><span><b>ล้างสาย</b><br><span class="hint">ล้างผลทุกแมตช์ที่ต่อจากนี้ แล้วแข่ง/กรอกใหม่</span></span></label>
      </div>
    </div>` : ''}
    ${reasonField(back)}
    <div class="dlg-actions">
      <button class="btn secondary" value="cancel">ยกเลิก</button>
      ${canClear ? `<button class="btn ghost" value="clear" formnovalidate title="${downstream.length ? `ล้างผลของ ${downstream.map(x => `รอบ ${x.round} คู่ ${x.slot}`).join(', ')} ด้วย` : ''}">ล้างผล${downstream.length ? ` + ล้างสาย ${downstream.length} แมตช์` : ''}</button>` : ''}
      <button class="btn" value="ok">บันทึก</button>
    </div>`, async (f, action) => {
    const reason = String(f.get('reason') || '').trim();
    if (back && !reason) { toast('ต้องใส่เหตุผลของการแก้ย้อนหลัง', true); return false; }
    if (action === 'clear') {
      // ล้างผลคู่ที่รอบหลังมีผลแล้ว = ล้างสายเสมอ (แจ้งไว้บนปุ่มแล้ว)
      const out = await act(() => api('POST', `/matches/${m.id}/clear`, { reason }), downstream.length ? `ล้างผลและล้างสาย ${downstream.length} แมตช์แล้ว` : 'ล้างผลแล้ว');
      if (!out) return false;
      return;
    }
    const winner = f.get('winner');
    if (!winner) { toast('ต้องเลือกผู้ชนะ', true); return false; }
    const newWinner = winner === 'p1' ? m.player1_id : m.player2_id;
    const mode = f.get('mode');
    if (downstream.length && done && newWinner !== m.winner_id && !mode) { toast('เลือก "สลับชื่อ" หรือ "ล้างสาย" ก่อน', true); return false; }
    const out = await act(() => api('POST', `/matches/${m.id}/result`, {
      winner, score1: f.get('s1'), score2: f.get('s2'), forfeit: !!f.get('ff'), reason, mode: mode || undefined,
    }), 'บันทึกผลแล้ว');
    if (!out) return false;
  });
}

// ย้อนกลับไปรอบ N (Swiss) — ลบทุกรอบหลัง N
function openRollback(v, round) {
  const t = v.tournament;
  const removed = v.matches.filter(m => m.round > round && !m.is_bye);
  const played = removed.filter(m => m.status === 'complete').length;
  openDialog(`
    <h2>↩️ ย้อนกลับไปรอบ ${round}?</h2>
    <div class="muted">ลบการจับคู่รอบ ${round + 1}–${t.current_round} ทั้งหมด (${removed.length} โต๊ะ${played ? ` · <b>มีผลแล้ว ${played} โต๊ะ จะหายด้วย</b>` : ''}) แล้วกลับมาอยู่รอบ ${round}<br>
    แก้ผลรอบ ${round} ให้ถูก แล้วกด "จับคู่รอบที่ ${round + 1}" ใหม่</div>
    ${reasonField(true, 'เช่น คีย์ผลรอบ ' + round + ' ผิด รอบถัดไปยังไม่ได้เริ่มเล่น')}
    <div class="dlg-actions"><button class="btn secondary" value="cancel">ยกเลิก</button><button class="btn danger" value="ok">ย้อนรอบ</button></div>`,
  async f => {
    S.round = round;
    const out = await act(() => api('POST', `/tournaments/${t.code}/rollback`, { round, reason: f.get('reason') }), `ย้อนกลับไปรอบ ${round} แล้ว`);
    if (!out) return false;
  });
}

function bindMatchActions(el, v) {
  const t = v.tournament;
  el.querySelectorAll('[data-win]').forEach(b => b.onclick = () => {
    const id = b.dataset.win;
    const s1 = el.querySelector(`[data-s1="${id}"]`)?.value, s2 = el.querySelector(`[data-s2="${id}"]`)?.value;
    const ff = el.querySelector(`[data-ff="${id}"]`)?.checked;
    act(() => api('POST', `/matches/${id}/result`, { winner: b.dataset.side, score1: s1, score2: s2, forfeit: !!ff }), 'บันทึกผลแล้ว', b);
  });
  el.querySelectorAll('[data-clear]').forEach(b => b.onclick = () =>
    act(() => api('POST', `/matches/${b.dataset.clear}/clear`, {}), 'ล้างผลแล้ว', b));
  el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const m = v.matches.find(x => x.id === b.dataset.edit);
    if (m) openEditMatch(m, v);
  });
}

const FINISHED_HINT = '<div class="notice">ปิดจ็อบแล้ว — ถ้าคีย์ผิด ไปแท็บ "ปิดจ็อบ" แล้วกด "เปิดงานใหม่เพื่อแก้ผล"</div>';

function renderMatches(el, v) {
  const t = v.tournament;
  if (t.status === 'registration') { el.innerHTML = '<div class="card empty">ยังไม่เริ่มแข่ง — กด "สุ่ม seed & เริ่มแข่ง" ด้านบนเมื่อพร้อม</div>'; return; }
  if (t.format === 'single_elim') return renderBracket(el, v);

  const names = nameMap(v);
  const rounds = [...new Set(v.matches.map(m => m.round))].sort((a, b) => a - b);
  const r = S.round && rounds.includes(S.round) ? S.round : v.currentRound;
  const list = v.matches.filter(m => m.round === r).sort((a, b) => a.is_bye - b.is_bye || a.slot - b.slot);
  const left = list.filter(m => m.status !== 'complete').length;

  let banner = t.status === 'finished' ? FINISHED_HINT : '';
  if (t.status === 'running' && v.rewardsGiven) banner += '<div class="notice warn">แจกแต้ม/EXP ไปแล้วตามผลเดิม — แก้ผลตอนนี้จะไม่เปลี่ยนแต้ม/EXP ที่แจกไป (ปรับเองนอกระบบถ้าจำเป็น)</div>';
  if (t.status === 'running' && r < v.currentRound) {
    banner += `<div class="notice row" style="justify-content:space-between">รอบที่ผ่านไปแล้ว — กด "แก้ผล" ที่โต๊ะเพื่อแก้ย้อนหลัง (การจับคู่รอบหลังคงเดิม)
      ${v.canRollback ? `<button class="btn sm danger" id="rollback">↩️ ย้อนกลับไปรอบ ${r}</button>` : ''}</div>`;
  }
  if (t.status === 'running' && r === v.currentRound) {
    if (left) banner += `<div class="notice">รอบที่ ${r}: เหลือ ${left} โต๊ะที่ยังไม่กรอกผล</div>`;
    else if (v.canNextRound) banner += `<div class="notice green row" style="justify-content:space-between">รอบที่ ${r} กรอกผลครบแล้ว <button class="btn sm" id="next2">จับคู่รอบที่ ${r + 1} →</button></div>`;
    else if (v.canFinish) banner += `<div class="notice green row" style="justify-content:space-between">แข่งครบทุกรอบแล้ว 🎉 <button class="btn sm warn" id="fin2">ไปหน้าปิดจ็อบ</button></div>`;
  }
  el.innerHTML = `
    <div class="stack">
      <div class="row">${rounds.map(x => `<button class="btn ${x === r ? '' : 'secondary'} sm" data-round="${x}">รอบ ${x}</button>`).join('')}</div>
      ${banner}
      <div class="grid">${list.map(m => matchCard(m, v, names)).join('')}</div>
    </div>`;
  el.querySelectorAll('[data-round]').forEach(b => b.onclick = () => { S.round = Number(b.dataset.round); renderDetail(); });
  const rb = $('#rollback');
  if (rb) rb.onclick = () => openRollback(v, r);
  const n2 = $('#next2');
  if (n2) n2.onclick = () => { S.round = null; act(() => api('POST', `/tournaments/${t.code}/next-round`), `จับคู่รอบที่ ${r + 1} แล้ว`, n2); };
  const f2 = $('#fin2');
  if (f2) f2.onclick = () => { S.tab = 'finish'; renderDetail(); };
  bindMatchActions(el, v);
}

function renderBracket(el, v) {
  const names = nameMap(v);
  const rounds = [...new Set(v.matches.map(m => m.round))].sort((a, b) => a - b);
  const last = rounds[rounds.length - 1];
  const roundName = r => r === last ? 'ชิงชนะเลิศ' : r === last - 1 ? 'รองชนะเลิศ' : `รอบที่ ${r}`;
  const bp = (m, pid, score) => `<div class="bp ${m.status === 'complete' && m.winner_id === pid ? 'win' : ''}"><span>${esc(names[pid] || (m.is_bye && !pid ? 'บาย' : '—'))}</span><span class="s">${score ?? ''}</span></div>`;
  el.innerHTML = `
    <div class="stack">
      <div class="notice">กดที่คู่เพื่อกรอกผล/แก้ผล — ผู้ชนะจะขึ้นไปรอบถัดไปเอง · แก้คู่ที่รอบหลังมีผลแล้วได้ (เลือกสลับชื่อหรือล้างสาย)</div>
      ${v.tournament.status === 'finished' ? FINISHED_HINT : ''}
      ${v.tournament.status === 'running' && v.rewardsGiven ? '<div class="notice warn">แจกแต้ม/EXP ไปแล้วตามผลเดิม — แก้ผลตอนนี้จะไม่เปลี่ยนแต้ม/EXP ที่แจกไป</div>' : ''}
      <div class="bracket">${rounds.map(r => `
        <div class="bcol"><h3>${roundName(r)}</h3>
          ${v.matches.filter(m => m.round === r).sort((a, b) => a.slot - b.slot).map(m => `
            <div class="bm ${m.status === 'pending' || m.is_bye ? 'pending' : ''}" data-bm="${m.id}" tabindex="0" role="button" aria-label="รอบ ${r} คู่ ${m.slot}">
              ${bp(m, m.player1_id, m.score1)}${bp(m, m.player2_id, m.score2)}
            </div>`).join('')}
        </div>`).join('')}
      </div>
      <div id="bm-detail"></div>
    </div>`;
  el.querySelectorAll('[data-bm]').forEach(b => {
    const m = v.matches.find(x => x.id === b.dataset.bm);
    if (m.is_bye || m.status === 'pending') return;
    const open = () => {
      const d = $('#bm-detail');
      d.innerHTML = `<div style="max-width:360px">${matchCard(m, v, names).replace('<b>โต๊ะ', `<b>${roundName(m.round)} · คู่`)}</div>`;
      bindMatchActions(d, v);
      d.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    b.onclick = open;
    b.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
}

// ---------- standings tab ----------
function renderStandings(el, v) {
  const t = v.tournament;
  if (!v.matches.length) { el.innerHTML = '<div class="card empty">ยังไม่มีผลการแข่ง</div>'; return; }
  const medal = r => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : r);
  const gp = t.give_points !== false, ge = t.give_exp !== false;
  el.innerHTML = `
    <div class="card table-wrap">
      <table>
        <thead><tr><th class="num">อันดับ</th><th>ชื่อ</th><th class="num">ชนะ-แพ้</th>${t.format === 'swiss' ? '<th class="num hide-sm" title="Buchholz: ผลรวมชนะของคู่แข่ง">BH</th>' : ''}${gp ? '<th class="num">แต้ม</th>' : ''}${ge ? '<th class="num">EXP*</th>' : ''}</tr></thead>
        <tbody>${v.standings.map(s => `<tr class="${s.forfeit ? 'dim' : ''}">
          <td class="num"><b>${medal(s.rank)}</b></td>
          <td><span class="pname">${esc(s.name)}</span> ${s.forfeit ? '<span class="badge danger">ถอนตัว/ปรับแพ้</span>' : ''} ${s.played === 0 ? '<span class="badge">ยังไม่ได้แข่ง</span>' : ''}</td>
          <td class="num">${s.wins}-${s.losses}${s.byes ? ` <span class="muted small">(บาย ${s.byes})</span>` : ''}</td>
          ${t.format === 'swiss' ? `<td class="num hide-sm">${s.buchholz}</td>` : ''}
          ${gp ? `<td class="num">${s.points || ''}</td>` : ''}
          ${ge ? `<td class="num">${s.exp || ''}</td>` : ''}
        </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="small muted">${ge ? '* EXP ตอนนี้คิดแบบ "เล่นครบทุกรอบ" ตามค่าเริ่มต้น ปรับได้ในแท็บแจกรางวัล · ' : ''}ถอนตัว/ปรับแพ้อยู่ท้ายตารางเสมอ${t.format === 'swiss' ? ' · อันดับเท่ากันตัดสินด้วย BH (ผลรวมชนะของคู่แข่งที่เคยเจอ)' : ''}</p>`;
}

// ---------- finish tab: แจกแต้ม / แจก EXP / ปิดจ็อบ (แยก 3 ปุ่ม) ----------
function renderFinish(el, v) {
  const t = v.tournament;
  if (t.status === 'registration' || t.status === 'cancelled') { el.innerHTML = '<div class="card empty">ยังไม่มีอะไรให้แจก</div>'; return; }

  const cfg = v.rewards || DEFAULT_REWARDS;
  const gp = t.give_points !== false, ge = t.give_exp !== false;
  const finished = t.status === 'finished';
  const expDone = !!v.expAwarded;
  if (!S.finishChecks) S.finishChecks = new Set(v.standings.filter(s => s.playedAll).map(s => s.player_id));
  const isFull = s => (expDone ? s.playedAll : S.finishChecks.has(s.player_id));
  const calc = s => (!ge || !s.played ? 0 : expFor(cfg, s.rank, isFull(s)));
  const totalExp = v.standings.reduce((a, s) => a + calc(s), 0);
  const totalPts = v.standings.reduce((a, s) => a + s.points, 0);
  const unlinked = v.standings.filter(s => !s.linked && (s.points || calc(s)));

  let status = '';
  if (!v.allMatchesComplete) status = `<div class="notice warn">ยังมีแมตช์ที่ยังไม่กรอกผล — แจกรางวัล/ปิดจ็อบได้เมื่อกรอกครบ</div>`;
  else if (!v.resultsFinal) status = `<div class="notice warn">แข่งไปแล้ว ${v.currentRound} จาก ${v.totalRounds} รอบ — จับคู่รอบต่อไปก่อน หรือลดจำนวนรอบในแท็บตั้งค่า</div>`;
  else if (finished) {
    const left = [gp && !t.points_awarded_at ? 'แต้มแลกการ์ด' : '', ge && !expDone ? 'EXP' : ''].filter(Boolean);
    status = `<div class="notice ${left.length ? 'warn' : 'green'}">ปิดจ็อบแล้วเมื่อ ${fmtDate(t.finished_at)}${left.length ? ` — ยังไม่ได้แจก ${left.join(' และ ')} (กดแจกได้ด้านล่าง)` : ' — แจกรางวัลครบแล้ว'}</div>`;
  }
  const ready = v.resultsFinal && v.allMatchesComplete;

  const pointsCard = gp ? `
    <div class="card pad stack">
      <div class="spread"><h2>💎 แจกแต้มให้ Top</h2>${t.points_awarded_at ? '<span class="badge green">แจกแล้ว</span>' : ''}</div>
      <div class="muted small" style="white-space:pre-line">${esc(describePointsText(cfg))}\nผู้เข้าแข่ง ${v.players.length} คน → Top ${v.pointsQuota} · รวม ${totalPts} แต้ม</div>
      ${t.points_awarded_at ? `<div class="small muted">แจกเมื่อ ${fmtDate(t.points_awarded_at)}</div>` : `<button class="btn" id="award" ${ready && totalPts ? '' : 'disabled'}>💸 แจกแต้มตอนนี้</button>`}
    </div>` : '';
  const expCard = ge ? `
    <div class="card pad stack">
      <div class="spread"><h2>✨ แจก EXP</h2>${expDone ? '<span class="badge green">แจกแล้ว</span>' : ''}</div>
      <div class="muted small">${esc(describeExpText(cfg))} · รวม ${totalExp} EXP</div>
      ${expDone ? (t.exp_awarded_at ? `<div class="small muted">แจกเมื่อ ${fmtDate(t.exp_awarded_at)}</div>` : '<div class="small muted">แจกไปพร้อมการปิดจ็อบ (ระบบเดิม)</div>')
        : `<button class="btn" id="award-exp" ${ready ? '' : 'disabled'}>✨ แจก EXP ตามที่ติ๊ก</button>`}
    </div>` : '';
  const otherCard = t.other_rewards ? `
    <div class="card pad stack">
      <div class="spread"><h2>🎁 ของรางวัลอื่น</h2><span class="badge">แอดมินแจกเอง</span></div>
      <div class="small" style="white-space:pre-line">${esc(t.other_rewards)}</div>
    </div>` : '';
  const closeCard = `
    <div class="card pad stack">
      <div class="spread"><h2>🏁 ปิดจ็อบ บันทึกประวัติ</h2>${finished ? '<span class="badge green">ปิดแล้ว</span>' : ''}</div>
      <div class="muted small">จบงาน บันทึกประวัติการแข่งและสถิติผู้เล่น (ไม่แจก EXP — ใช้ปุ่มแจก EXP แยก)${t.reopen_count ? ' · งานนี้เคยเปิดใหม่แล้ว ปิดอีกครั้งจะเขียนทับประวัติเดิม' : ''}</div>
      ${finished
        ? `<button class="btn ghost" id="reopen">↩️ เปิดงานใหม่เพื่อแก้ผล</button>
           <div class="small muted">กลับมาสถานะกำลังแข่ง แก้ผลได้ทุกรอบ แล้วปิดจ็อบใหม่ · สถิติผู้เล่นถูกหักคืนแล้วบันทึกใหม่ตอนปิด · แต้ม/EXP ที่แจกแล้วไม่เปลี่ยน</div>`
        : `<button class="btn warn" id="finish" ${v.canFinish ? '' : 'disabled'}>🏁 ปิดจ็อบ & บันทึกประวัติ</button>`}
    </div>`;

  // หลังเปิดงานใหม่: เทียบอันดับตอนปิดครั้งก่อนกับอันดับตอนนี้ (ช่วยปรับแต้ม/EXP เองนอกระบบ)
  const ptsAt = r => (r && r <= v.pointsQuota ? (cfg.points.ranks[r - 1] || 0) : 0);
  const expAt = r => (r ? (cfg.exp.ranks[r - 1] || 0) : 0);
  const moved = !finished && t.reopened_at ? v.standings.filter(s => s.closed_rank && s.closed_rank !== s.rank) : [];
  const compare = moved.length ? `
    <div class="card pad stack">
      <h2>↕️ อันดับเปลี่ยนจากตอนปิดจ็อบครั้งก่อน</h2>
      ${v.rewardsGiven ? '<div class="notice warn small">แต้ม/EXP แจกไปแล้วตามอันดับเดิม ระบบจะไม่แจกซ้ำหรือหักคืน — ถ้าต้องปรับ ให้แอดมินทำเองในเว็บร้าน</div>' : ''}
      <div class="table-wrap"><table>
        <thead><tr><th>ชื่อ</th><th class="num">อันดับเดิม → ใหม่</th>${gp && t.points_awarded_at ? '<th class="num">แต้ม (ส่วนต่าง)</th>' : ''}${ge && expDone ? '<th class="num">EXP อันดับ (ส่วนต่าง)</th>' : ''}</tr></thead>
        <tbody>${moved.map(s => {
          const dp = ptsAt(s.rank) - ptsAt(s.closed_rank), de = expAt(s.rank) - expAt(s.closed_rank);
          const sign = n => (n > 0 ? `+${n}` : `${n}`);
          return `<tr><td><span class="pname">${esc(s.name)}</span></td><td class="num">${s.closed_rank} → <b>${s.rank}</b></td>
            ${gp && t.points_awarded_at ? `<td class="num">${ptsAt(s.closed_rank)} → ${ptsAt(s.rank)} ${dp ? `<b>(${sign(dp)})</b>` : ''}</td>` : ''}
            ${ge && expDone ? `<td class="num">${expAt(s.closed_rank)} → ${expAt(s.rank)} ${de ? `<b>(${sign(de)})</b>` : ''}</td>` : ''}</tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>` : '';

  el.innerHTML = `
    <div class="stack">
      ${status}
      <div class="grid">${pointsCard}${expCard}${otherCard}${closeCard}</div>
      ${compare}
      ${unlinked.length ? `<div class="notice warn">walk-in ${unlinked.length} คนไม่มีบัญชี จะไม่ได้แต้ม/EXP: ${unlinked.map(s => esc(s.name)).join(', ')}</div>` : ''}
      <div class="card table-wrap">
        <table>
          <thead><tr><th class="num">อันดับ</th><th>ชื่อ</th>${ge ? '<th style="text-align:center">เล่นครบทุกรอบ</th>' : ''}${gp ? '<th class="num">แต้ม</th>' : ''}${ge ? '<th class="num">EXP</th>' : ''}</tr></thead>
          <tbody>${v.standings.map(s => `<tr class="${s.played ? '' : 'dim'}">
            <td class="num"><b>${s.rank}</b></td>
            <td><span class="pname">${esc(s.name)}</span> ${s.played ? '' : '<span class="badge">ไม่ได้ลงแข่ง</span>'} ${s.forfeit ? '<span class="badge danger">ถอนตัว</span>' : ''}</td>
            ${ge ? `<td style="text-align:center">${s.played ? `<input type="checkbox" data-full="${s.player_id}" ${isFull(s) ? 'checked' : ''} ${expDone ? 'disabled' : ''} aria-label="เล่นครบทุกรอบ">` : '–'}</td>` : ''}
            ${gp ? `<td class="num">${s.points || ''}</td>` : ''}
            ${ge ? `<td class="num"><b>${calc(s) || ''}</b></td>` : ''}
          </tr>`).join('')}</tbody>
        </table>
      </div>
      ${ge && !expDone ? '<p class="small muted">ค่าเริ่มต้นติ๊กทุกคนที่ไม่ได้ถอนตัว — เอาติ๊กออกเฉพาะคนที่กลับก่อน</p>' : ''}
    </div>`;

  el.querySelectorAll('[data-full]').forEach(cb => cb.onchange = () => {
    if (cb.checked) S.finishChecks.add(cb.dataset.full); else S.finishChecks.delete(cb.dataset.full);
    renderFinish(el, v);
  });
  const award = $('#award');
  if (award) award.onclick = async () => {
    const list = v.standings.filter(s => s.points).map(s => `${s.rank}. ${esc(s.name)} → <b>${s.points}</b> แต้ม`).join('<br>');
    if (!await confirmBox('แจกแต้มแลกการ์ด?', `${list}<br><br>แจกได้ครั้งเดียวต่องาน`, 'แจกแต้ม')) return;
    act(() => api('POST', `/tournaments/${t.code}/award-points`), out => `แจกแต้มแล้ว ${out.awarded.length} คน${out.skipped.length ? ` (ข้าม ${out.skipped.length} คนที่ไม่มีบัญชี)` : ''}`, award);
  };
  const awardExp = $('#award-exp');
  if (awardExp) awardExp.onclick = async () => {
    const list = v.standings.filter(s => calc(s)).map(s => `${isFull(s) ? '☑️' : '⬜'} ${s.rank}. ${esc(s.name)} → <b>${calc(s)}</b> EXP`).join('<br>');
    if (!await confirmBox('แจก EXP?', `${list}<br><br>แจกได้ครั้งเดียวต่องาน`, 'แจก EXP')) return;
    act(() => api('POST', `/tournaments/${t.code}/award-exp`, { playedAllIds: [...S.finishChecks] }),
      out => `แจก EXP แล้ว ${out.awarded.length} คน${out.skipped.length ? ` · ข้าม ${out.skipped.length} คน` : ''}`, awardExp);
  };
  const fin = $('#finish');
  if (fin) fin.onclick = async () => {
    const left = [gp && !t.points_awarded_at ? 'แต้มแลกการ์ด' : '', ge && !expDone ? 'EXP' : ''].filter(Boolean);
    const extra = left.length ? `<br><b>⚠️ ยังไม่ได้แจก ${left.join(' และ ')}</b> — กดแจกทีหลังได้` : '';
    if (!await confirmBox('ปิดจ็อบงานนี้?', `บันทึกประวัติการแข่งและสถิติผู้เล่น แล้วปิดงาน<br>ถ้าเจอว่าคีย์ผิดทีหลัง กด "เปิดงานใหม่" เพื่อกลับมาแก้ได้${extra}`, 'ปิดจ็อบ', true)) return;
    act(() => api('POST', `/tournaments/${t.code}/finish`), 'ปิดจ็อบและบันทึกประวัติแล้ว', fin);
  };
  const reo = $('#reopen');
  if (reo) reo.onclick = () => openDialog(`
    <h2>↩️ เปิดงานใหม่เพื่อแก้ผล?</h2>
    <div class="muted">
      • งานกลับมาสถานะ "กำลังแข่ง" แก้ผลได้ทุกรอบ แล้วกดปิดจ็อบใหม่<br>
      • สถิติผู้เล่น (แข่ง/แชมป์/Top3/Top5) ที่บันทึกตอนปิดจะถูกหักคืน แล้วบันทึกใหม่ตามผลที่แก้ตอนปิดอีกครั้ง<br>
      • <b>แต้ม/EXP ที่แจกไปแล้วไม่เปลี่ยน และจะไม่แจกซ้ำ</b> — ถ้าอันดับเปลี่ยน ระบบจะแสดงตารางเทียบให้ปรับเองนอกระบบ
    </div>
    ${reasonField(true, 'เช่น เพิ่งรู้ว่าคีย์ผลรอบ 2 โต๊ะ 3 สลับกัน')}
    <div class="dlg-actions"><button class="btn secondary" value="cancel">ยกเลิก</button><button class="btn warn" value="ok">เปิดงานใหม่</button></div>`,
  async f => {
    S.tab = 'matches'; S.round = null;
    const out = await act(() => api('POST', `/tournaments/${t.code}/reopen`, { reason: f.get('reason') }), 'เปิดงานใหม่แล้ว — แก้ผลได้เลย');
    if (!out) { S.tab = 'finish'; return false; }
  });
}

// ---------- log tab: บันทึกการแก้ไข ----------
const AUDIT_LABEL = {
  edit_result: '✏️ แก้ผล', clear_result: '🧽 ล้างผล', rollback_round: '↩️ ย้อนรอบ',
  reopen: '🔓 เปิดงานใหม่', reset: '🧹 รีเซ็ตผล',
};
function auditDetail(a, names) {
  const n = id => esc(names[id] || (id ? 'ผู้เล่นที่ลบไปแล้ว' : '—'));
  const res = m => (m?.status === 'complete' ? `${n(m.winner_id)} ชนะ${m.score1 !== null && m.score2 !== null ? ` (${m.score1}-${m.score2})` : ''}${m.forfeit_player_id ? ' [ปรับแพ้]' : ''}` : 'ยังไม่มีผล');
  const b = a.before || {}, af = a.after || {};
  switch (a.action) {
    case 'edit_result':
    case 'clear_result': {
      const m = b.match || af.match || {};
      const down = (af.downstream || []).length;
      return `รอบ ${m.round} โต๊ะ ${m.slot}: ${n(m.player1_id)} vs ${n(m.player2_id)}<br>${res(b.match)} → <b>${res(af.match)}</b>`
        + (down ? `<br><span class="muted">${b.mode === 'swap' ? 'สลับชื่อในรอบหลัง' : 'ล้างสาย'} ${down} แมตช์</span>` : '');
    }
    case 'rollback_round': return `รอบ ${b.current_round} → รอบ ${af.current_round} (ลบ ${(b.removed || []).filter(m => !m.is_bye).length} โต๊ะ)`;
    case 'reopen': return `ปิดจ็อบเมื่อ ${fmtDate(b.finished_at)} → กลับมาแข่งต่อ · หักสถิติคืน ${af.stats_reversed ?? 0} คน`;
    case 'reset': return `ลบ ${af.matches_deleted ?? 0} แมตช์ (เดิมอยู่รอบ ${b.current_round}) → เปิดรับสมัคร`;
    default: return '';
  }
}
async function renderLog(el, v) {
  el.innerHTML = '<div class="loading">กำลังโหลด…</div>';
  let list;
  try { list = await api('GET', `/tournaments/${v.tournament.code}/audit`); } catch (e) { el.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
  if (S.tab !== 'log') return;
  const names = nameMap(v);
  el.innerHTML = `
    <div class="stack">
      <div class="notice">บันทึกทุกการแก้ผลย้อนหลัง ล้างผล ย้อนรอบ เปิดงานใหม่ และรีเซ็ต — ใครทำ เมื่อไหร่ ค่าเดิม/ค่าใหม่ และเหตุผล</div>
      <div class="card table-wrap"><table>
        <thead><tr><th>เวลา</th><th>ทำอะไร</th><th>รายละเอียด</th><th class="hide-sm">โดย</th></tr></thead>
        <tbody>${list.length ? list.map(a => `<tr>
          <td class="small muted" style="white-space:nowrap">${fmtDate(a.created_at)}</td>
          <td style="white-space:nowrap">${AUDIT_LABEL[a.action] || esc(a.action)}</td>
          <td class="small">${auditDetail(a, names)}${a.reason ? `<br><span class="muted">เหตุผล: ${esc(a.reason)}</span>` : ''}<span class="show-sm muted"> · ${esc(a.actor_name || '-')}</span></td>
          <td class="hide-sm small">${esc(a.actor_name || '-')}</td>
        </tr>`).join('') : '<tr><td colspan="4" class="empty">ยังไม่มีการแก้ไข</td></tr>'}</tbody>
      </table></div>
    </div>`;
}

// ---------- staff (แอดมินร้านเท่านั้น) ----------
async function renderStaff() {
  if (S.me?.role !== 'admin') { $('#app').innerHTML = '<div class="empty">เฉพาะแอดมินร้านเท่านั้น<br><br><a href="#/">← กลับ</a></div>'; return; }
  $('#app').innerHTML = '<div class="loading">กำลังโหลด…</div>';
  let list;
  try { list = await api('GET', '/staff'); } catch (e) { $('#app').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  $('#app').innerHTML = `
    <a href="#/" class="small muted" style="text-decoration:none">← งานแข่งทั้งหมด</a>
    <div class="spread" style="margin:8px 0 16px"><h1>สตาฟจัดทัวร์</h1></div>
    <div class="stack">
      <div class="notice">สตาฟจัดการทัวร์ได้ทุกอย่าง (สร้างงาน กรอกผล แจกรางวัล) แต่แต่งตั้งสตาฟคนอื่นไม่ได้ · สตาฟต้อง login ด้วย Discord (หรือบัญชีเว็บร้านที่ผูก Discord แล้ว)</div>
      <form class="card pad row" id="staff-add">
        <label class="field" style="flex:2;min-width:200px">Discord ID<input name="discord_id" inputmode="numeric" pattern="[0-9]{17,20}" required placeholder="เช่น 123456789012345678"><span class="hint">Discord → ตั้งค่า → ขั้นสูง → เปิด Developer Mode แล้วคลิกขวาที่ชื่อ → Copy User ID</span></label>
        <label class="field" style="flex:1;min-width:140px">โน้ต (ไม่บังคับ)<input name="note" maxlength="80" placeholder="เช่น ชื่อเล่น"></label>
        <button class="btn" style="align-self:flex-end;margin-bottom:22px">+ เพิ่มสตาฟ</button>
      </form>
      <div class="card table-wrap">
        <table>
          <thead><tr><th>Discord ID</th><th>ชื่อในระบบ</th><th class="hide-sm">โน้ต</th><th class="hide-sm">เพิ่มเมื่อ</th><th></th></tr></thead>
          <tbody>${list.length ? list.map(s => `<tr>
            <td><span class="code">${esc(s.discord_id)}</span></td>
            <td>${s.name ? esc(s.name) : '<span class="muted small">ยังไม่มีบัญชีในเว็บ</span>'}</td>
            <td class="hide-sm">${esc(s.note || '')}</td>
            <td class="hide-sm small muted">${fmtDate(s.created_at)}</td>
            <td style="text-align:right"><button class="btn ghost sm" data-unstaff="${esc(s.discord_id)}">ถอดสิทธิ์</button></td>
          </tr>`).join('') : '<tr><td colspan="5" class="empty">ยังไม่มีสตาฟ — แอดมินร้านจัดทัวร์ได้อยู่แล้วโดยไม่ต้องเพิ่ม</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  const f = $('#staff-add');
  f.onsubmit = async ev => {
    ev.preventDefault();
    const d = new FormData(f), btn = f.querySelector('button');
    btn.disabled = true;
    try { await api('POST', '/staff', { discord_id: String(d.get('discord_id')).trim(), note: d.get('note') }); toast('เพิ่มสตาฟแล้ว'); renderStaff(); }
    catch (e) { toast(e.message, true); btn.disabled = false; }
  };
  document.querySelectorAll('[data-unstaff]').forEach(b => b.onclick = async () => {
    const row = list.find(x => x.discord_id === b.dataset.unstaff);
    if (!await confirmBox('ถอดสิทธิ์สตาฟ?', `${esc(row.name || row.discord_id)} จะจัดการทัวร์ไม่ได้อีก (มีผลทันที)`, 'ถอดสิทธิ์', true)) return;
    try { await api('DELETE', `/staff/${row.discord_id}`); toast('ถอดสิทธิ์แล้ว'); renderStaff(); } catch (e) { toast(e.message, true); }
  });
}

// ---------- settings tab ----------
function renderSettings(el, v) {
  const t = v.tournament;
  const locked = t.status === 'finished' || t.status === 'cancelled';
  const rwLock = {
    points: t.points_awarded_at ? 'แจกแต้มไปแล้ว แก้ส่วนนี้ไม่ได้' : null,
    exp: v.expAwarded ? 'แจก EXP ไปแล้ว แก้ส่วนนี้ไม่ได้' : null,
  };
  const local = iso => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  el.innerHTML = `
    <div class="grid">
      <form class="card pad stack" id="settings">
        <h2>ตั้งค่างาน</h2>
        <label class="field">ชื่องาน<input name="name" value="${esc(t.name)}" maxlength="120" required ${locked ? 'disabled' : ''}></label>
        ${t.format === 'swiss' ? `<label class="field">จำนวนรอบ Swiss<input name="swiss_rounds" type="number" min="1" max="20" value="${t.swiss_rounds ?? ''}" placeholder="อัตโนมัติ (${v.totalRounds})" ${locked ? 'disabled' : ''}><span class="hint">เว้นว่าง = อัตโนมัติตามจำนวนคน</span></label>` : ''}
        <label class="field">นาทีต่อรอบ<input name="round_minutes" type="number" min="1" max="240" value="${t.round_minutes}" ${locked ? 'disabled' : ''}></label>
        <label class="field">เวลาเริ่มงาน<input name="start_at" type="datetime-local" value="${local(t.start_at)}" ${locked ? 'disabled' : ''}></label>
        ${locked ? '' : '<button class="btn">บันทึก</button>'}
      </form>
      ${t.status === 'cancelled' ? '' : `<form class="card pad stack" id="rw-form">
        <h2>รางวัล</h2>
        <div class="small muted">ติ๊กเฉพาะสิ่งที่งานนี้แจก — ปุ่มแจกใน !standing และหน้าเว็บจะขึ้นตามนี้</div>
        ${rewardEditorHTML(t, rwLock)}
        <button class="btn">บันทึกรางวัล</button>
      </form>`}
      <div class="card pad stack">
        <h2>Discord</h2>
        <div class="small">พิมพ์ในห้องแข่งเพื่อเปิดบอร์ดรับสมัคร:<br><span class="code">!setup ${t.code}</span></div>
        <div class="small">ดูคู่ปัจจุบัน / จับเวลา: <span class="code">!current ${t.code}</span></div>
        <div class="small">ตารางคะแนน: <span class="code">!standing ${t.code}</span></div>
        <div class="small muted">เมื่อจับคู่รอบใหม่จากเว็บ บอทจะโพสต์คู่ในห้องที่ใช้ !setup ให้อัตโนมัติ</div>
      </div>
      ${t.status === 'running' || t.status === 'finished' ? `<div class="card pad stack"><h2>🧹 รีเซ็ตผลทั้งงาน</h2>
        <div class="small muted">ลบการจับคู่และผลทุกรอบ กลับไปสถานะเปิดรับสมัคร (รายชื่อผู้เล่นยังอยู่) แล้วกดเริ่มแข่งใหม่ได้${t.status === 'finished' ? ' · สถิติผู้เล่นที่บันทึกตอนปิดจะถูกหักคืน' : ''}${v.rewardsGiven ? '<br><b>แต้ม/EXP แจกไปแล้ว — จะไม่เปลี่ยนและไม่แจกซ้ำ</b>' : ''}</div>
        <button class="btn danger" id="reset-t">รีเซ็ตผลทั้งงาน</button></div>` : ''}
      ${locked ? '' : `<div class="card pad stack"><h2>ยกเลิกงาน</h2><div class="small muted">ไม่แจกรางวัลใดๆ และปิดงานนี้</div><button class="btn danger" id="cancel-t">ยกเลิกงานแข่ง</button></div>`}
    </div>`;
  const rwf = $('#rw-form');
  if (rwf) {
    S.rwDirty = false;
    rwf.addEventListener('input', () => { S.rwDirty = true; });
    rwf.addEventListener('change', () => { S.rwDirty = true; });
    const editor = bindRewardEditor($('#rw', rwf), v.rewards, rwLock);
    rwf.onsubmit = ev => {
      ev.preventDefault();
      const body = editor.read();
      if (rwLock.points) delete body.give_points;
      if (rwLock.exp) delete body.give_exp;
      S.rwDirty = false;
      act(() => api('PATCH', `/tournaments/${t.code}`, body), 'บันทึกรางวัลแล้ว', rwf.querySelector('button:not([type=button])'));
    };
  }
  const f = $('#settings');
  f.onsubmit = ev => {
    ev.preventDefault();
    const d = new FormData(f);
    const body = { name: d.get('name'), round_minutes: Number(d.get('round_minutes')), start_at: d.get('start_at') ? new Date(d.get('start_at')).toISOString() : null };
    if (t.format === 'swiss') body.swiss_rounds = d.get('swiss_rounds') || null;
    act(() => api('PATCH', `/tournaments/${t.code}`, body), 'บันทึกแล้ว', f.querySelector('button'));
  };
  const rs = $('#reset-t');
  if (rs) rs.onclick = () => openDialog(`
    <h2>🧹 รีเซ็ตผลทั้งงาน?</h2>
    <div class="muted">ลบการจับคู่และผลทั้งหมด ${v.matches.filter(m => !m.is_bye).length} แมตช์ กลับไปเปิดรับสมัคร · seed และการถอนตัวถูกล้าง<br>
      ${v.rewardsGiven ? '<b>แต้ม/EXP ที่แจกไปแล้วจะไม่เปลี่ยน และแจกซ้ำไม่ได้</b><br>' : ''}ย้อนกลับไม่ได้ (แต่ผลเดิมเก็บไว้ในบันทึกการแก้ไข)</div>
    <label class="field">พิมพ์ <span class="code">${t.code}</span> เพื่อยืนยัน<input name="confirm" required autocomplete="off" inputmode="numeric"></label>
    ${reasonField(true, 'เช่น จับคู่ผิดตั้งแต่รอบแรก ขอเริ่มใหม่')}
    <div class="dlg-actions"><button class="btn secondary" value="cancel">ยกเลิก</button><button class="btn danger" value="ok">รีเซ็ต</button></div>`,
  async f => {
    if (String(f.get('confirm')).trim() !== String(t.code)) { toast(`พิมพ์เลขงาน ${t.code} ให้ตรง`, true); return false; }
    S.tab = 'players'; S.round = null; S.finishChecks = null;
    const out = await act(() => api('POST', `/tournaments/${t.code}/reset`, { reason: f.get('reason') }), 'รีเซ็ตแล้ว — กลับไปเปิดรับสมัคร');
    if (!out) { S.tab = 'settings'; return false; }
  });
  const c = $('#cancel-t');
  if (c) c.onclick = async () => {
    if (!await confirmBox('ยกเลิกงานแข่ง?', 'ไม่มีการแจกแต้ม/EXP และแก้ไขงานนี้ต่อไม่ได้', 'ยกเลิกงาน', true)) return;
    act(() => api('POST', `/tournaments/${t.code}/cancel`), 'ยกเลิกงานแล้ว', c);
  };
}

boot().catch(e => { $('#app').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${esc(e.message)}</div>`; });
