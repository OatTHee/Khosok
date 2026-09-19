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
const placementExp = r => (r === 1 ? 50 : r <= 3 ? 30 : r <= 5 ? 20 : 0);

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
      $('#app').innerHTML = `<div class="login"><div class="card"><h2>เข้าใช้งานไม่ได้</h2><p class="muted">${esc(e.message)}</p><p class="small muted">ต้องเป็นบัญชีที่มีสิทธิ์แอดมินในเว็บ DMT Shop</p></div></div>`;
      return;
    }
  }
  $('#userbox').hidden = false;
  $('#username').textContent = S.me.name || S.me.email || '';
  const m = location.hash.match(/^#\/t\/([\w-]+)/);
  if (m) {
    if (S.code !== m[1]) { S.code = m[1]; S.tab = null; S.round = null; S.finishChecks = null; S.lastJson = ''; S.view = null; }
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
        <div class="row small muted"><span>${FORMAT[t.format]}</span><span>·</span><span>${t.player_count} คน</span>${t.start_at ? `<span class="hide-sm">·</span><span class="hide-sm">${fmtDate(t.start_at)}</span>` : ''}</div>
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
    <div class="dlg-actions"><button class="btn secondary" value="cancel">ยกเลิก</button><button class="btn" value="ok">สร้างงาน</button></div>
  `, async f => {
    const t = await api('POST', '/tournaments', {
      name: f.get('name'), format: f.get('format'),
      swiss_rounds: f.get('swiss_rounds') || null, round_minutes: Number(f.get('round_minutes') || 40),
      start_at: f.get('start_at') ? new Date(f.get('start_at')).toISOString() : null,
    });
    toast(`สร้างงาน #${t.code} แล้ว`);
    location.hash = `#/t/${t.code}`;
  });
}

// ---------- detail ----------
async function loadDetail(force) {
  if (!S.code) return;
  // ไม่รีเฟรชทับตอนกำลังพิมพ์ หรือเปิดหน้าต่างอยู่
  if (!force && ($('#dialog').open || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName))) return;
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
    ['finish', 'แจกรางวัล & ปิดจ็อบ'],
    ['settings', 'ตั้งค่า'],
  ];
  $('#app').innerHTML = `
    <a href="#/" class="small muted" style="text-decoration:none">← งานแข่งทั้งหมด</a>
    <div class="head" style="margin-top:8px">
      <div>
        <h1>${esc(t.name)}</h1>
        <div class="row small muted" style="margin-top:6px">
          <span class="badge ${cls}">${label}</span>
          <span>${FORMAT[t.format]}</span>
          <span>·</span>
          <span>Discord: <span class="code">!setup ${t.code}</span></span>
        </div>
      </div>
      <div class="row">${headActions(v)}</div>
    </div>
    <div class="stats">
      <div class="card stat"><div class="v">${v.players.length}${t.status !== 'registration' && active !== v.players.length ? ` <span class="small muted">(${active} ยังอยู่)</span>` : ''}</div><div class="k">ผู้เข้าแข่งขัน</div></div>
      <div class="card stat"><div class="v">${v.currentRound || '–'} / ${v.totalRounds}</div><div class="k">รอบ</div></div>
      <div class="card stat"><div class="v">Top ${v.pointsQuota}</div><div class="k">โควตาแจกแต้ม</div></div>
      ${t.status === 'running' ? `<div class="card stat timer" id="timer"><div class="v" id="timer-v">–</div><div class="k row" style="justify-content:space-between">เวลารอบนี้ <span>${t.round_ends_at
        ? `<button class="btn ghost sm" id="timer-stop">หยุด</button>`
        : `<button class="btn sm" id="timer-go">เริ่ม ${t.round_minutes} นาที</button>`}</span></div></div>` : ''}
    </div>
    <nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav>
    <section id="tab"></section>`;

  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; renderDetail(); });
  bindHeadActions(v);
  const timerGo = $('#timer-go'), timerStop = $('#timer-stop');
  if (timerGo) timerGo.onclick = () => act(() => api('POST', `/tournaments/${t.code}/timer`, {}), 'เริ่มจับเวลาแล้ว', timerGo);
  if (timerStop) timerStop.onclick = () => act(() => api('DELETE', `/tournaments/${t.code}/timer`), 'หยุดจับเวลาแล้ว', timerStop);
  startTick();

  const tab = $('#tab');
  ({ players: renderPlayers, matches: renderMatches, standings: renderStandings, finish: renderFinish, settings: renderSettings }[S.tab] || renderPlayers)(tab, v);
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

function matchCard(m, v, names) {
  const t = v.tournament;
  if (m.is_bye) {
    return `<div class="card match done"><div class="match-top"><b>โต๊ะ ${m.slot}</b><span class="badge">บาย</span></div>
      <div class="side win"><span class="n">${esc(names[m.player1_id || m.player2_id])}</span><span class="small">ชนะบาย</span></div></div>`;
  }
  const done = m.status === 'complete';
  const editable = t.status === 'running' && (t.format === 'single_elim' || m.round === t.current_round);
  const side = (pid, key, score) => {
    const cls = done ? (m.winner_id === pid ? 'win' : 'lose') : '';
    return `<div class="side ${cls}"><span class="n">${esc(names[pid] || 'รอผู้ชนะ')}</span>${done
      ? `<span class="small">${m.winner_id === pid ? '🏆 ชนะ' : (m.forfeit_player_id === pid ? 'ปรับแพ้' : '')}${score !== null && score !== undefined ? ` · ${score}` : ''}</span>`
      : editable && pid ? `<button class="btn sm" data-win="${m.id}" data-side="${key}">ชนะ</button>` : ''}</div>`;
  };
  return `<div class="card match ${done ? 'done' : ''}" data-match="${m.id}">
    <div class="match-top"><b>โต๊ะ ${m.slot}</b>${done ? '<span class="badge green">กรอกผลแล้ว</span>' : m.status === 'pending' ? '<span class="badge">รอคู่แข่ง</span>' : '<span class="badge info">กำลังแข่ง</span>'}</div>
    ${side(m.player1_id, 'p1', m.score1)}
    <div class="vs">VS</div>
    ${side(m.player2_id, 'p2', m.score2)}
    ${editable ? (done
      ? `<div class="match-foot"><span class="muted">กดล้างผลเพื่อแก้ไข</span><button class="btn ghost sm" data-clear="${m.id}">ล้างผล</button></div>`
      : m.status === 'open' ? `<div class="match-foot">
          <span class="row" style="gap:6px">สกอร์ <input type="number" min="0" max="99" data-s1="${m.id}" aria-label="สกอร์ผู้เล่น 1"> - <input type="number" min="0" max="99" data-s2="${m.id}" aria-label="สกอร์ผู้เล่น 2"></span>
          <label class="row" style="gap:6px"><input type="checkbox" data-ff="${m.id}"> ปรับแพ้ (ถอนตัว/ฟาวล์)</label>
        </div>` : '') : ''}
  </div>`;
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
    act(() => api('POST', `/matches/${b.dataset.clear}/clear`), 'ล้างผลแล้ว', b));
}

function renderMatches(el, v) {
  const t = v.tournament;
  if (t.status === 'registration') { el.innerHTML = '<div class="card empty">ยังไม่เริ่มแข่ง — กด "สุ่ม seed & เริ่มแข่ง" ด้านบนเมื่อพร้อม</div>'; return; }
  if (t.format === 'single_elim') return renderBracket(el, v);

  const names = nameMap(v);
  const rounds = [...new Set(v.matches.map(m => m.round))].sort((a, b) => a - b);
  const r = S.round && rounds.includes(S.round) ? S.round : v.currentRound;
  const list = v.matches.filter(m => m.round === r).sort((a, b) => a.is_bye - b.is_bye || a.slot - b.slot);
  const left = list.filter(m => m.status !== 'complete').length;

  let banner = '';
  if (t.status === 'running' && r === v.currentRound) {
    if (left) banner = `<div class="notice">รอบที่ ${r}: เหลือ ${left} โต๊ะที่ยังไม่กรอกผล</div>`;
    else if (v.canNextRound) banner = `<div class="notice green row" style="justify-content:space-between">รอบที่ ${r} กรอกผลครบแล้ว <button class="btn sm" id="next2">จับคู่รอบที่ ${r + 1} →</button></div>`;
    else if (v.canFinish) banner = `<div class="notice green row" style="justify-content:space-between">แข่งครบทุกรอบแล้ว 🎉 <button class="btn sm warn" id="fin2">ไปหน้าปิดจ็อบ</button></div>`;
  }
  el.innerHTML = `
    <div class="stack">
      <div class="row">${rounds.map(x => `<button class="btn ${x === r ? '' : 'secondary'} sm" data-round="${x}">รอบ ${x}</button>`).join('')}</div>
      ${banner}
      <div class="grid">${list.map(m => matchCard(m, v, names)).join('')}</div>
    </div>`;
  el.querySelectorAll('[data-round]').forEach(b => b.onclick = () => { S.round = Number(b.dataset.round); renderDetail(); });
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
      <div class="notice">กดที่คู่เพื่อกรอกผล — ผู้ชนะจะขึ้นไปรอบถัดไปเอง</div>
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
  el.innerHTML = `
    <div class="card table-wrap">
      <table>
        <thead><tr><th class="num">อันดับ</th><th>ชื่อ</th><th class="num">ชนะ-แพ้</th>${t.format === 'swiss' ? '<th class="num hide-sm" title="Buchholz: ผลรวมชนะของคู่แข่ง">BH</th>' : ''}<th class="num">แต้ม</th><th class="num">EXP*</th></tr></thead>
        <tbody>${v.standings.map(s => `<tr class="${s.forfeit ? 'dim' : ''}">
          <td class="num"><b>${medal(s.rank)}</b></td>
          <td><span class="pname">${esc(s.name)}</span> ${s.forfeit ? '<span class="badge danger">ถอนตัว/ปรับแพ้</span>' : ''} ${s.played === 0 ? '<span class="badge">ยังไม่ได้แข่ง</span>' : ''}</td>
          <td class="num">${s.wins}-${s.losses}${s.byes ? ` <span class="muted small">(บาย ${s.byes})</span>` : ''}</td>
          ${t.format === 'swiss' ? `<td class="num hide-sm">${s.buchholz}</td>` : ''}
          <td class="num">${s.points || ''}</td>
          <td class="num">${s.exp || ''}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="small muted">* EXP ตอนนี้คิดแบบ "เล่นครบทุกรอบ" ตามค่าเริ่มต้น ปรับได้ในแท็บปิดจ็อบ · ถอนตัว/ปรับแพ้อยู่ท้ายตารางเสมอ${t.format === 'swiss' ? ' · อันดับเท่ากันตัดสินด้วย BH (ผลรวมชนะของคู่แข่งที่เคยเจอ)' : ''}</p>`;
}

// ---------- finish tab ----------
function renderFinish(el, v) {
  const t = v.tournament;
  if (t.status === 'registration' || t.status === 'cancelled') { el.innerHTML = '<div class="card empty">ยังไม่มีอะไรให้แจก</div>'; return; }

  if (!S.finishChecks) S.finishChecks = new Set(v.standings.filter(s => s.playedAll).map(s => s.player_id));
  const finished = t.status === 'finished';
  const calc = s => {
    if (!s.played) return 0;
    const full = finished ? s.playedAll : S.finishChecks.has(s.player_id);
    return placementExp(s.rank) + 10 + (full ? 10 : 0);
  };
  const totalExp = v.standings.reduce((a, s) => a + calc(s), 0);
  const totalPts = v.standings.reduce((a, s) => a + s.points, 0);
  const unlinked = v.standings.filter(s => !s.linked && (s.points || calc(s)));

  let status = '';
  if (finished) status = `<div class="notice green">ปิดจ็อบแล้วเมื่อ ${fmtDate(t.finished_at)} — แจก EXP และบันทึกประวัติเรียบร้อย</div>`;
  else if (!v.allMatchesComplete) status = `<div class="notice warn">ยังมีแมตช์ที่ยังไม่กรอกผล — ปิดจ็อบได้เมื่อกรอกครบ</div>`;
  else if (!v.canFinish) status = `<div class="notice warn">แข่งไปแล้ว ${v.currentRound} จาก ${v.totalRounds} รอบ — จับคู่รอบต่อไปก่อน หรือลดจำนวนรอบในแท็บตั้งค่า</div>`;

  el.innerHTML = `
    <div class="stack">
      ${status}
      <div class="grid">
        <div class="card pad stack">
          <div class="spread"><h2>💎 แต้มแลกการ์ด</h2>${t.points_awarded_at ? '<span class="badge green">แจกแล้ว</span>' : ''}</div>
          <div class="muted small">แชมป์ 10 แต้ม · อันดับ 2–${v.pointsQuota} คนละ 5 แต้ม (ผู้เข้าแข่ง ${v.players.length} คน → Top ${v.pointsQuota}) · รวม ${totalPts} แต้ม</div>
          ${t.points_awarded_at ? `<div class="small muted">แจกเมื่อ ${fmtDate(t.points_awarded_at)}</div>` : `<button class="btn" id="award" ${totalPts ? '' : 'disabled'}>แจกแต้มตอนนี้</button>`}
        </div>
        <div class="card pad stack">
          <div class="spread"><h2>✨ EXP & ปิดจ็อบ</h2>${finished ? '<span class="badge green">ปิดแล้ว</span>' : ''}</div>
          <div class="muted small">อันดับ 1 +50 · 2–3 +30 · 4–5 +20 · เข้าร่วม +10 · เล่นครบทุกรอบ +10 · รวม ${totalExp} EXP</div>
          ${finished ? '' : `<button class="btn warn" id="finish" ${v.canFinish ? '' : 'disabled'}>🏁 ยืนยันอันดับ & ปิดจ็อบ</button>`}
        </div>
      </div>
      ${unlinked.length ? `<div class="notice warn">walk-in ${unlinked.length} คนไม่มีบัญชี จะไม่ได้แต้ม/EXP: ${unlinked.map(s => esc(s.name)).join(', ')}</div>` : ''}
      <div class="card table-wrap">
        <table>
          <thead><tr><th class="num">อันดับ</th><th>ชื่อ</th><th style="text-align:center">เล่นครบทุกรอบ</th><th class="num">แต้ม</th><th class="num">EXP</th></tr></thead>
          <tbody>${v.standings.map(s => `<tr class="${s.played ? '' : 'dim'}">
            <td class="num"><b>${s.rank}</b></td>
            <td><span class="pname">${esc(s.name)}</span> ${s.played ? '' : '<span class="badge">ไม่ได้ลงแข่ง</span>'} ${s.forfeit ? '<span class="badge danger">ถอนตัว</span>' : ''}</td>
            <td style="text-align:center">${s.played ? `<input type="checkbox" data-full="${s.player_id}" ${(finished ? s.playedAll : S.finishChecks.has(s.player_id)) ? 'checked' : ''} ${finished ? 'disabled' : ''} aria-label="เล่นครบทุกรอบ">` : '–'}</td>
            <td class="num">${s.points || ''}</td>
            <td class="num"><b>${calc(s) || ''}</b></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      ${finished ? '' : '<p class="small muted">ค่าเริ่มต้นติ๊กทุกคนที่ไม่ได้ถอนตัว — เอาติ๊กออกเฉพาะคนที่กลับก่อน</p>'}
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
  const fin = $('#finish');
  if (fin) fin.onclick = async () => {
    const extra = t.points_awarded_at ? '' : '<br><b>⚠️ ยังไม่ได้แจกแต้มแลกการ์ด</b> — แจกทีหลังได้';
    if (!await confirmBox('ปิดจ็อบงานนี้?', `แจก EXP รวม ${totalExp} EXP บันทึกประวัติและสถิติ แล้วปิดงาน<br>ทำแล้วย้อนกลับไม่ได้${extra}`, 'ปิดจ็อบ', true)) return;
    act(() => api('POST', `/tournaments/${t.code}/finish`, { playedAllIds: [...S.finishChecks] }),
      out => `ปิดจ็อบแล้ว แจก EXP ${out.awarded.length} คน${out.skipped.length ? ` · ข้าม ${out.skipped.length} คน` : ''}`, fin);
  };
}

// ---------- settings tab ----------
function renderSettings(el, v) {
  const t = v.tournament;
  const locked = t.status === 'finished' || t.status === 'cancelled';
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
      <div class="card pad stack">
        <h2>Discord</h2>
        <div class="small">พิมพ์ในห้องแข่งเพื่อเปิดบอร์ดรับสมัคร:<br><span class="code">!setup ${t.code}</span></div>
        <div class="small">ดูคู่ปัจจุบัน / จับเวลา: <span class="code">!current ${t.code}</span></div>
        <div class="small">ตารางคะแนน: <span class="code">!standing ${t.code}</span></div>
        <div class="small muted">เมื่อจับคู่รอบใหม่จากเว็บ บอทจะโพสต์คู่ในห้องที่ใช้ !setup ให้อัตโนมัติ</div>
      </div>
      ${locked ? '' : `<div class="card pad stack"><h2>ยกเลิกงาน</h2><div class="small muted">ไม่แจกรางวัลใดๆ และปิดงานนี้</div><button class="btn danger" id="cancel-t">ยกเลิกงานแข่ง</button></div>`}
    </div>`;
  const f = $('#settings');
  f.onsubmit = ev => {
    ev.preventDefault();
    const d = new FormData(f);
    const body = { name: d.get('name'), round_minutes: Number(d.get('round_minutes')), start_at: d.get('start_at') ? new Date(d.get('start_at')).toISOString() : null };
    if (t.format === 'swiss') body.swiss_rounds = d.get('swiss_rounds') || null;
    act(() => api('PATCH', `/tournaments/${t.code}`, body), 'บันทึกแล้ว', f.querySelector('button'));
  };
  const c = $('#cancel-t');
  if (c) c.onclick = async () => {
    if (!await confirmBox('ยกเลิกงานแข่ง?', 'ไม่มีการแจกแต้ม/EXP และแก้ไขงานนี้ต่อไม่ได้', 'ยกเลิกงาน', true)) return;
    act(() => api('POST', `/tournaments/${t.code}/cancel`), 'ยกเลิกงานแล้ว', c);
  };
}

boot().catch(e => { $('#app').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${esc(e.message)}</div>`; });
