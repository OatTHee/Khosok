// =========================================================
// 🏟️ Tournament Service — อ่าน/เขียน Supabase + เรียก engine
// ทั้งหน้าเว็บ (web/api.js) และบอท Discord (index.js) เรียกผ่านไฟล์นี้ที่เดียว
// ทุกการเปลี่ยนแปลงจะยิง event ออกไปให้บอทอัปเดตบอร์ดใน Discord เอง
// =========================================================
'use strict';
const { EventEmitter } = require('events');
const { createClient } = require('@supabase/supabase-js');
const E = require('./engine');

class ServiceError extends Error {
    constructor(message, status = 400) { super(message); this.name = 'ServiceError'; this.status = status; }
}

const events = new EventEmitter();
let _db = null;
function db() {
    if (_db) return _db;
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new ServiceError('ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_SERVICE_KEY', 500);
    _db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return _db;
}

async function run(query, notFoundMsg) {
    const { data, error } = await query;
    if (error) {
        if (error.code === '23505') throw new ServiceError('ข้อมูลซ้ำ (ผู้เล่นคนนี้อยู่ในงานแล้ว)');
        if (error.code === 'PGRST116' && notFoundMsg) throw new ServiceError(notFoundMsg, 404);
        // ข้อความ raise exception จากฟังก์ชัน SQL เป็นภาษาไทยอยู่แล้ว ส่งต่อได้เลย
        if (error.code === 'P0001') throw new ServiceError(error.message);
        throw new ServiceError(`ฐานข้อมูลผิดพลาด: ${error.message}`, 500);
    }
    return data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (s, max = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------------------------------------------------------
// อ่านข้อมูล
// ---------------------------------------------------------
async function getTournament(idOrCode) {
    const key = String(idOrCode ?? '').trim().replace(/^#/, '');
    let q = db().from('tournaments').select('*');
    if (UUID_RE.test(key)) q = q.eq('id', key);
    else if (/^\d+$/.test(key)) q = q.eq('code', Number(key));
    else throw new ServiceError('รหัสงานไม่ถูกต้อง (ใช้เลขงาน เช่น 12)', 404);
    return run(q.single(), `ไม่พบงานแข่งรหัส ${key}`);
}

async function getFull(idOrCode) {
    const tournament = await getTournament(idOrCode);
    const [players, matches] = await Promise.all([
        run(db().from('tournament_players').select('*').eq('tournament_id', tournament.id).order('created_at')),
        run(db().from('tournament_matches').select('*').eq('tournament_id', tournament.id).order('round').order('slot')),
    ]);
    return { tournament, players, matches };
}

function buildView({ tournament, players, matches }) {
    const total = E.totalRounds(tournament, players.length);
    const current = tournament.format === 'single_elim'
        ? E.currentRoundOf(tournament, matches)
        : tournament.current_round;
    const roundComplete = current > 0 && E.isRoundComplete(matches, current);
    const everything = E.allComplete(matches);
    const running = tournament.status === 'running';
    return {
        tournament, players, matches,
        totalRounds: total,
        currentRound: current,
        roundComplete,
        canNextRound: running && tournament.format === 'swiss' && roundComplete && current < total,
        canFinish: running && everything && (tournament.format === 'single_elim' || current >= total),
        allMatchesComplete: everything,
        pointsQuota: E.pointsQuota(players.length),
        standings: E.rewardsPreview(tournament, players, matches).map(r => ({
            player_id: r.player.id, name: r.player.display_name, discord_id: r.player.discord_id,
            linked: !!(r.player.customer_id || r.player.discord_id),
            rank: r.rank, wins: r.wins, losses: r.losses, played: r.played, byes: r.byes,
            buchholz: r.buchholz, forfeit: r.forfeit, dropped: !!r.player.dropped_at,
            points: r.points, exp: r.exp, playedAll: r.playedAll,
        })),
    };
}

async function view(idOrCode) {
    return buildView(await getFull(idOrCode));
}

async function listTournaments({ limit = 50 } = {}) {
    const rows = await run(db().from('tournaments')
        .select('*, tournament_players(count)')
        .order('created_at', { ascending: false }).limit(limit));
    return rows.map(r => ({ ...r, player_count: r.tournament_players?.[0]?.count ?? 0, tournament_players: undefined }));
}

// ---------------------------------------------------------
// สร้าง / แก้ไขงาน
// ---------------------------------------------------------
function normalizeSettings(input, { partial = false } = {}) {
    const out = {};
    if (!partial || input.name !== undefined) {
        out.name = clean(input.name, 120);
        if (!out.name) throw new ServiceError('ต้องใส่ชื่องาน');
    }
    if (!partial || input.format !== undefined) {
        out.format = input.format === 'single_elim' ? 'single_elim' : 'swiss';
    }
    if (input.swiss_rounds !== undefined) {
        const n = input.swiss_rounds === '' || input.swiss_rounds === null ? null : Number(input.swiss_rounds);
        if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 20)) throw new ServiceError('จำนวนรอบ Swiss ต้องเป็น 1–20 หรือเว้นว่าง (อัตโนมัติ)');
        out.swiss_rounds = n;
    }
    if (input.round_minutes !== undefined) {
        const n = Number(input.round_minutes);
        if (!(Number.isInteger(n) && n >= 1 && n <= 240)) throw new ServiceError('เวลาต่อรอบต้องเป็น 1–240 นาที');
        out.round_minutes = n;
    }
    if (input.start_at !== undefined) {
        out.start_at = input.start_at ? new Date(input.start_at).toISOString() : null;
    }
    return out;
}

async function createTournament(input, userId = null) {
    const row = normalizeSettings(input);
    row.created_by = userId;
    const t = await run(db().from('tournaments').insert(row).select().single());
    events.emit('tournament', t);
    return t;
}

async function updateTournament(idOrCode, input) {
    const t = await getTournament(idOrCode);
    if (t.status === 'finished' || t.status === 'cancelled') throw new ServiceError('งานนี้ปิดไปแล้ว แก้ไขไม่ได้');
    const patch = normalizeSettings(input, { partial: true });
    if (t.status !== 'registration') {
        delete patch.format; // เริ่มแข่งแล้วห้ามเปลี่ยนรูปแบบ
        if (patch.swiss_rounds !== undefined && patch.swiss_rounds !== null && patch.swiss_rounds < t.current_round) {
            throw new ServiceError(`ตอนนี้แข่งถึงรอบ ${t.current_round} แล้ว ตั้งจำนวนรอบน้อยกว่านี้ไม่ได้`);
        }
    }
    const updated = await run(db().from('tournaments').update(patch).eq('id', t.id).select().single());
    events.emit('tournament', updated);
    return updated;
}

async function cancelTournament(idOrCode) {
    const t = await getTournament(idOrCode);
    if (t.status === 'finished') throw new ServiceError('งานนี้ปิดจ็อบแจกรางวัลไปแล้ว ยกเลิกไม่ได้');
    const updated = await run(db().from('tournaments').update({ status: 'cancelled', round_ends_at: null }).eq('id', t.id).select().single());
    events.emit('tournament', updated);
    return updated;
}

async function setDiscordRefs(idOrCode, refs) {
    const t = await getTournament(idOrCode);
    const patch = {};
    for (const k of ['discord_channel_id', 'setup_message_id', 'current_message_id']) if (refs[k] !== undefined) patch[k] = refs[k];
    return run(db().from('tournaments').update(patch).eq('id', t.id).select().single());
}

// ---------------------------------------------------------
// ผู้เล่น
// ---------------------------------------------------------
async function findAccountByDiscord(discordId) {
    if (!discordId) return null;
    const c = await run(db().from('customers').select('id, display_name, discord_id').eq('discord_id', discordId).maybeSingle());
    if (c) return { customer_id: c.id, discord_id: c.discord_id, name: c.display_name, source: 'customer' };
    const l = await run(db().from('legacy_accounts').select('discord_id, name').eq('discord_id', discordId).is('claimed_by', null).maybeSingle());
    if (l) return { customer_id: null, discord_id: l.discord_id, name: l.name, source: 'legacy' };
    return null;
}

async function searchAccounts(term) {
    const q = clean(term, 50).replace(/[%,()"\\*]/g, '');
    if (q.length < 1) return [];
    const like = `"%${q}%"`;
    const [cs, ls] = await Promise.all([
        run(db().from('customers').select('id, display_name, real_name, uid, discord_id')
            .or(`display_name.ilike.${like},real_name.ilike.${like},uid.ilike.${like},discord_id.eq."${q}"`).limit(15)),
        run(db().from('legacy_accounts').select('uid, name, real_name, discord_id').is('claimed_by', null)
            .not('discord_id', 'is', null)
            .or(`name.ilike.${like},real_name.ilike.${like},uid.ilike.${like},discord_id.eq."${q}"`).limit(10)),
    ]);
    return [
        ...cs.map(c => ({ customer_id: c.id, discord_id: c.discord_id, name: c.display_name || c.real_name || c.uid, sub: [c.real_name, c.uid].filter(Boolean).join(' · '), source: 'customer' })),
        ...ls.map(l => ({ customer_id: null, discord_id: l.discord_id, name: l.name || l.real_name || l.uid, sub: ['บัญชีเก่า (ยังไม่ login เว็บ)', l.uid].filter(Boolean).join(' · '), source: 'legacy' })),
    ];
}

// input: { customer_id } | { discord_id, display_name } | { display_name } (walk-in)
async function addPlayer(idOrCode, input) {
    const t = await getTournament(idOrCode);
    const lateSwiss = t.status === 'running' && t.format === 'swiss';
    if (t.status !== 'registration' && !lateSwiss) throw new ServiceError('ปิดรับสมัครแล้ว');

    const row = { tournament_id: t.id, customer_id: null, discord_id: null, display_name: clean(input.display_name) };
    if (input.customer_id) {
        const c = await run(db().from('customers').select('id, display_name, discord_id, real_name').eq('id', input.customer_id).single(), 'ไม่พบบัญชีนี้');
        row.customer_id = c.id;
        row.discord_id = c.discord_id || null;
        row.display_name = row.display_name || clean(c.display_name || c.real_name) || 'ผู้เล่น';
    } else if (input.discord_id) {
        const acc = await findAccountByDiscord(String(input.discord_id));
        if (!acc && input.requireAccount) throw new ServiceError('NO_ACCOUNT', 404);
        row.discord_id = String(input.discord_id);
        row.customer_id = acc?.customer_id || null;
        row.display_name = row.display_name || clean(acc?.name) || 'ผู้เล่น';
    }
    if (!row.display_name) throw new ServiceError('ต้องใส่ชื่อผู้เล่น');

    const p = await run(db().from('tournament_players').insert(row).select().single());
    events.emit('players', t);
    return p;
}

async function removePlayer(idOrCode, playerId) {
    const t = await getTournament(idOrCode);
    if (t.status !== 'registration') throw new ServiceError('เริ่มแข่งแล้ว ลบผู้เล่นไม่ได้ ให้ใช้ "ถอนตัว" แทน');
    const rows = await run(db().from('tournament_players').delete().eq('tournament_id', t.id).eq('id', playerId).select());
    if (!rows.length) throw new ServiceError('ไม่พบผู้เล่นคนนี้ในงาน', 404);
    events.emit('players', t);
    return rows[0];
}

async function removePlayerByDiscord(idOrCode, discordId) {
    const t = await getTournament(idOrCode);
    if (t.status !== 'registration') throw new ServiceError('ปิดรับสมัครแล้ว สละสิทธิ์ผ่านปุ่มไม่ได้ ติดต่อแอดมิน');
    const rows = await run(db().from('tournament_players').delete().eq('tournament_id', t.id).eq('discord_id', String(discordId)).select());
    if (!rows.length) throw new ServiceError('ไม่พบการสมัครของคุณในงานนี้', 404);
    events.emit('players', t);
    return rows[0];
}

async function setDropped(idOrCode, playerId, dropped) {
    const t = await getTournament(idOrCode);
    if (t.status !== 'running') throw new ServiceError('ถอนตัวได้เฉพาะระหว่างแข่ง');
    const patch = dropped ? { dropped_at: new Date().toISOString(), played_all: false } : { dropped_at: null, played_all: true };
    const rows = await run(db().from('tournament_players').update(patch).eq('tournament_id', t.id).eq('id', playerId).select());
    if (!rows.length) throw new ServiceError('ไม่พบผู้เล่นคนนี้ในงาน', 404);
    events.emit('players', t);
    return rows[0];
}

async function renamePlayer(idOrCode, playerId, name) {
    const t = await getTournament(idOrCode);
    const display_name = clean(name);
    if (!display_name) throw new ServiceError('ต้องใส่ชื่อ');
    const rows = await run(db().from('tournament_players').update({ display_name }).eq('tournament_id', t.id).eq('id', playerId).select());
    if (!rows.length) throw new ServiceError('ไม่พบผู้เล่นคนนี้ในงาน', 404);
    events.emit('players', t);
    return rows[0];
}

// ---------------------------------------------------------
// เริ่มแข่ง / จับคู่รอบถัดไป
// ---------------------------------------------------------
async function insertMatches(t, list) {
    if (!list.length) return [];
    const rows = list.map(m => ({
        tournament_id: t.id, round: m.round, slot: m.slot,
        player1_id: m.player1_id, player2_id: m.player2_id, winner_id: m.winner_id || null,
        is_bye: !!m.is_bye, status: m.status,
        completed_at: m.status === 'complete' ? new Date().toISOString() : null,
    }));
    return run(db().from('tournament_matches').insert(rows).select());
}

async function startTournament(idOrCode) {
    const t0 = await getTournament(idOrCode);
    if (t0.status !== 'registration') throw new ServiceError(t0.status === 'running' ? 'งานนี้เริ่มแข่งไปแล้ว' : 'งานนี้ปิดไปแล้ว');
    const players = await run(db().from('tournament_players').select('*').eq('tournament_id', t0.id));
    if (players.length < 2) throw new ServiceError('ต้องมีผู้เล่นอย่างน้อย 2 คนถึงจะเริ่มได้');

    // 🔒 จองสถานะก่อน กันกดเริ่มซ้อนกันสองที่
    const locked = await run(db().from('tournaments')
        .update({ status: 'running', current_round: 1, started_at: new Date().toISOString(), round_ends_at: null })
        .eq('id', t0.id).eq('status', 'registration').select());
    if (!locked.length) throw new ServiceError('งานนี้เริ่มแข่งไปแล้ว');
    const t = locked[0];

    try {
        // 🔀 สุ่ม seed
        const seeded = E.shuffle(players).map((p, i) => ({ ...p, seed: i + 1 }));
        await Promise.all(seeded.map(p => run(db().from('tournament_players').update({ seed: p.seed }).eq('id', p.id))));

        const list = t.format === 'single_elim'
            ? E.buildElimBracket(seeded)
            : E.pairSwissRound(seeded, [], 1);
        await insertMatches(t, list);
    } catch (err) {
        await db().from('tournament_matches').delete().eq('tournament_id', t.id);
        await db().from('tournaments').update({ status: 'registration', current_round: 0, started_at: null }).eq('id', t.id);
        throw err;
    }
    events.emit('round', t, 1);
    return view(t.id);
}

async function nextRound(idOrCode) {
    const full = await getFull(idOrCode);
    const v = buildView(full);
    const t = full.tournament;
    if (t.format !== 'swiss') throw new ServiceError('แพ้คัดออกจะขึ้นรอบถัดไปเองอัตโนมัติเมื่อกรอกผล');
    if (t.status !== 'running') throw new ServiceError('งานนี้ไม่ได้อยู่ระหว่างแข่ง');
    if (!v.roundComplete) throw new ServiceError(`รอบที่ ${t.current_round} ยังกรอกผลไม่ครบ`);
    if (t.current_round >= v.totalRounds) throw new ServiceError(`ครบ ${v.totalRounds} รอบแล้ว (เพิ่มจำนวนรอบในตั้งค่าได้ถ้าต้องการแข่งต่อ)`);

    const next = t.current_round + 1;
    const locked = await run(db().from('tournaments')
        .update({ current_round: next, round_ends_at: null })
        .eq('id', t.id).eq('current_round', t.current_round).select());
    if (!locked.length) throw new ServiceError('มีคนกดจับคู่รอบนี้ไปแล้ว');

    try {
        const list = E.pairSwissRound(full.players, full.matches, next);
        await insertMatches(t, list);
    } catch (err) {
        await db().from('tournament_matches').delete().eq('tournament_id', t.id).eq('round', next);
        await db().from('tournaments').update({ current_round: t.current_round }).eq('id', t.id);
        throw err;
    }
    events.emit('round', locked[0], next);
    return view(t.id);
}

// ---------------------------------------------------------
// กรอกผล
// ---------------------------------------------------------
async function loadMatchContext(matchId) {
    const m = await run(db().from('tournament_matches').select('*').eq('id', matchId).single(), 'ไม่พบแมตช์นี้');
    const full = await getFull(m.tournament_id);
    if (full.tournament.status !== 'running') throw new ServiceError('งานนี้ไม่ได้อยู่ระหว่างแข่ง');
    if (m.is_bye) throw new ServiceError('แมตช์บายไม่ต้องกรอกผล');
    const t = full.tournament;
    if (t.format === 'swiss' && m.round !== t.current_round) {
        throw new ServiceError(`แก้ได้เฉพาะผลของรอบปัจจุบัน (รอบ ${t.current_round})`);
    }
    return { m, full, t };
}

async function saveElimChain(full, changed) {
    // changed = แมตช์ที่ต้องเขียนกลับ (object จาก full.matches)
    for (const x of changed) {
        await run(db().from('tournament_matches').update({
            player1_id: x.player1_id, player2_id: x.player2_id, winner_id: x.winner_id,
            score1: x.score1 ?? null, score2: x.score2 ?? null, status: x.status,
            forfeit_player_id: x.forfeit_player_id ?? null,
            completed_at: x.status === 'complete' ? (x.completed_at || new Date().toISOString()) : null,
        }).eq('id', x.id));
    }
}

async function reportResult(matchId, { winner, score1, score2, forfeit } = {}) {
    const { m, full, t } = await loadMatchContext(matchId);
    if (m.status === 'pending' || !m.player1_id || !m.player2_id) throw new ServiceError('แมตช์นี้ยังรอผู้เล่นจากรอบก่อน');

    const winnerId = winner === 'p1' || winner === m.player1_id ? m.player1_id
        : winner === 'p2' || winner === m.player2_id ? m.player2_id : null;
    if (!winnerId) throw new ServiceError('ต้องเลือกผู้ชนะ');
    const loserId = winnerId === m.player1_id ? m.player2_id : m.player1_id;
    const toScore = v => (v === '' || v === null || v === undefined ? null : Number.isInteger(Number(v)) ? Number(v) : null);

    const target = full.matches.find(x => x.id === m.id);
    Object.assign(target, {
        winner_id: winnerId, status: 'complete',
        score1: toScore(score1), score2: toScore(score2),
        forfeit_player_id: forfeit ? loserId : null,
        completed_at: new Date().toISOString(),
    });

    const changed = [target];
    if (t.format === 'single_elim') {
        const next = E.applyElimAdvance(full.matches, target); // โยน error ถ้ารอบถัดไปกรอกผลไปแล้ว
        if (next) changed.push(next);
    }
    await saveElimChain(full, changed);
    events.emit('match', t, target);
    return view(t.id);
}

async function clearResult(matchId) {
    const { m, full, t } = await loadMatchContext(matchId);
    const target = full.matches.find(x => x.id === m.id);
    Object.assign(target, { winner_id: null, status: 'open', score1: null, score2: null, forfeit_player_id: null, completed_at: null });
    const changed = [target];
    if (t.format === 'single_elim') {
        const next = E.applyElimAdvance(full.matches, target);
        if (next) changed.push(next);
    }
    await saveElimChain(full, changed);
    events.emit('match', t, target);
    return view(t.id);
}

// ---------------------------------------------------------
// จับเวลา
// ---------------------------------------------------------
async function startTimer(idOrCode, minutes) {
    const t = await getTournament(idOrCode);
    if (t.status !== 'running') throw new ServiceError('งานนี้ไม่ได้อยู่ระหว่างแข่ง');
    const mins = Number(minutes) || t.round_minutes;
    const round_ends_at = new Date(Date.now() + mins * 60000).toISOString();
    const u = await run(db().from('tournaments').update({ round_ends_at }).eq('id', t.id).select().single());
    events.emit('timer', u);
    return u;
}
async function stopTimer(idOrCode) {
    const t = await getTournament(idOrCode);
    const u = await run(db().from('tournaments').update({ round_ends_at: null }).eq('id', t.id).select().single());
    events.emit('timer', u);
    return u;
}

// ---------------------------------------------------------
// แจกแต้ม / ปิดจ็อบ
// ---------------------------------------------------------
async function awardPoints(idOrCode) {
    const full = await getFull(idOrCode);
    const t = full.tournament;
    if (t.points_awarded_at) throw new ServiceError('งานนี้แจกแต้มไปแล้ว');
    const pv = E.rewardsPreview(t, full.players, full.matches);
    const awards = pv.filter(r => r.points > 0).map(r => ({ player_id: r.player.id, rank: r.rank, points: r.points }));
    if (!awards.length) throw new ServiceError('ยังไม่มีผู้เล่นที่ได้แต้ม (ต้องแข่งจริงอย่างน้อย 1 แมตช์)');
    const res = await run(db().rpc('t_award_points', { p_tournament_id: t.id, p_awards: awards }));
    events.emit('points', t, res);
    return { ...res, quota: E.pointsQuota(full.players.length) };
}

function buildHistoryText(full, preview) {
    const name = Object.fromEntries(full.players.map(p => [p.id, p.display_name]));
    const participants = preview.map(r => `${r.rank}. ${r.player.display_name}${r.player.discord_id ? ` <@${r.player.discord_id}>` : ''}`).join('\n');
    const history = full.matches
        .filter(m => m.status === 'complete')
        .map(m => {
            if (m.is_bye) return `รอบ ${m.round}: ${name[m.player1_id || m.player2_id]} ได้บาย`;
            const score = m.score1 !== null && m.score2 !== null ? `${m.score1}-${m.score2}` : '-';
            const ff = m.forfeit_player_id ? ` [ปรับแพ้: ${name[m.forfeit_player_id]}]` : '';
            return `รอบ ${m.round}: ${name[m.player1_id]} vs ${name[m.player2_id]} | ชนะ: ${name[m.winner_id]} (${score})${ff}`;
        }).join('\n');
    return { participants, history };
}

// playedAllIds: array ของ player id ที่เล่นครบทุกรอบ (ไม่ส่ง = ใช้ค่าในฐานข้อมูล)
async function finish(idOrCode, { playedAllIds } = {}) {
    const full = await getFull(idOrCode);
    const v = buildView(full);
    const t = full.tournament;
    if (t.status === 'finished') throw new ServiceError('งานนี้ปิดจ็อบไปแล้ว');
    if (!v.allMatchesComplete) throw new ServiceError('ยังมีแมตช์ที่ยังไม่กรอกผล');
    if (!v.canFinish) throw new ServiceError(`ยังแข่งไม่ครบ ${v.totalRounds} รอบ`);

    const set = Array.isArray(playedAllIds) ? new Set(playedAllIds) : null;
    const pv = E.rewardsPreview(t, full.players, full.matches, set);
    const results = pv.map(r => ({ player_id: r.player.id, rank: r.rank, exp: r.exp, played_all: r.playedAll, played: r.played > 0 }));
    const { participants, history } = buildHistoryText(full, pv);

    const res = await run(db().rpc('t_finish', {
        p_tournament_id: t.id, p_results: results,
        p_participants_list: participants, p_match_history: history,
    }));
    const noShow = pv.filter(r => r.played === 0).map(r => ({ player_id: r.player.id, name: r.player.display_name, discord_id: r.player.discord_id }));
    const out = { ...res, results: pv.map(r => ({ player_id: r.player.id, name: r.player.display_name, discord_id: r.player.discord_id, rank: r.rank, exp: r.exp, playedAll: r.playedAll, played: r.played })), noShow };
    events.emit('finished', { ...t, status: 'finished' }, out);
    return out;
}

module.exports = {
    ServiceError, events, db,
    getTournament, getFull, view, buildView, listTournaments,
    createTournament, updateTournament, cancelTournament, setDiscordRefs,
    findAccountByDiscord, searchAccounts, addPlayer, removePlayer, removePlayerByDiscord, setDropped, renamePlayer,
    startTournament, nextRound, reportResult, clearResult, startTimer, stopTimer,
    awardPoints, finish,
};
