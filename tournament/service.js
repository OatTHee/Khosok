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
        if (error.code === '23505') throw new ServiceError(/tournament_staff/.test(error.message) ? 'คนนี้เป็นสตาฟอยู่แล้ว' : 'ข้อมูลซ้ำ (ผู้เล่นคนนี้อยู่ในงานแล้ว)');
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

// งานที่ปิดจ็อบด้วยระบบเดิม (t_finish) แจก EXP ไปพร้อมกับตอนปิดแล้ว
function expAwarded(t) {
    return !!t.exp_awarded_at || (t.status === 'finished' && !t.closed_v2);
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
        // แก้ผลย้อนหลัง
        canRollback: running && tournament.format === 'swiss' && tournament.current_round > 1,
        rewardsGiven: !!tournament.points_awarded_at || expAwarded(tournament),
        // ผลนิ่งแล้ว (กรอกครบ + แข่งครบรอบ หรือปิดจ็อบแล้ว) → กดแจกแต้ม/EXP ได้
        resultsFinal: tournament.status === 'finished' || (running && everything && (tournament.format === 'single_elim' || current >= total)),
        rewards: E.rewardsOf(tournament),
        pointsText: E.describePoints(tournament.reward_config),
        expText: E.describeExp(tournament.reward_config),
        expAwarded: expAwarded(tournament),
        pointsQuota: E.pointsQuota(players.length, tournament.reward_config),
        standings: E.rewardsPreview(tournament, players, matches).map(r => ({
            player_id: r.player.id, name: r.player.display_name, discord_id: r.player.discord_id,
            linked: !!(r.player.customer_id || r.player.discord_id),
            rank: r.rank, wins: r.wins, losses: r.losses, played: r.played, byes: r.byes,
            buchholz: r.buchholz, forfeit: r.forfeit, dropped: !!r.player.dropped_at,
            points: r.points, exp: r.exp, playedAll: r.playedAll,
            closed_rank: r.player.final_rank ?? null, // อันดับตอนปิดจ็อบครั้งล่าสุด (ใช้เทียบหลังเปิดงานใหม่)
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
// ตรวจตารางรางวัลจากหน้าเว็บ (ผิดให้แจ้ง ไม่เดาเอง)
function validateRewards(cfg) {
    if (cfg === null) return null;
    if (typeof cfg !== 'object') throw new ServiceError('ตารางรางวัลไม่ถูกต้อง');
    const isInt = (v, max = 100000) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= max && v !== '' && v !== null;
    const checkRanks = (arr, label) => {
        if (!Array.isArray(arr) || !arr.length || arr.length > E.MAX_REWARD_RANKS) throw new ServiceError(`${label}: ต้องมี 1–${E.MAX_REWARD_RANKS} อันดับ`);
        arr.forEach((v, i) => { if (!isInt(v)) throw new ServiceError(`${label}: อันดับ ${i + 1} ต้องเป็นเลขจำนวนเต็ม 0 ขึ้นไป`); });
    };
    const p = cfg.points || {}, e = cfg.exp || {};
    checkRanks(p.ranks, 'แต้มแลกการ์ด');
    checkRanks(e.ranks, 'EXP');
    if (!isInt(p.base_top, E.MAX_REWARD_RANKS) || Number(p.base_top) < 1) throw new ServiceError(`จำนวนอันดับที่ได้แต้มต้องเป็น 1–${E.MAX_REWARD_RANKS}`);
    if (!isInt(p.expand_min_players, 1000)) throw new ServiceError('จำนวนคนที่ต้องครบเพื่อขยายโควตา ต้องเป็น 0 ขึ้นไป (0 = ไม่ขยาย)');
    if (Number(p.expand_min_players) > 0 && (!isInt(p.expand_top, E.MAX_REWARD_RANKS) || Number(p.expand_top) < Number(p.base_top))) {
        throw new ServiceError('อันดับที่ขยายถึง ต้องไม่น้อยกว่าจำนวนอันดับปกติ');
    }
    if (!isInt(e.join) || !isInt(e.full_play)) throw new ServiceError('EXP เข้าร่วม / เล่นครบ ต้องเป็นเลข 0 ขึ้นไป');
    const n = E.normalizeRewards(cfg);
    const need = Math.max(n.points.base_top, n.points.expand_min_players > 0 ? n.points.expand_top : 0);
    while (n.points.ranks.length < need) n.points.ranks.push(0);
    return n;
}

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
    if (input.give_points !== undefined) out.give_points = !!input.give_points;
    if (input.give_exp !== undefined) out.give_exp = !!input.give_exp;
    if (input.other_rewards !== undefined) {
        const txt = String(input.other_rewards ?? '').replace(/\r/g, '').trim().slice(0, 500);
        out.other_rewards = txt || null;
    }
    if (input.reward_config !== undefined) out.reward_config = validateRewards(input.reward_config);
    return out;
}

async function createTournament(input, userId = null) {
    const row = normalizeSettings(input);
    row.created_by = userId;
    const t = await run(db().from('tournaments').insert(row).select().single());
    events.emit('tournament', t);
    return t;
}

const REWARD_KEYS = ['give_points', 'give_exp', 'other_rewards', 'reward_config'];

async function updateTournament(idOrCode, input) {
    const t = await getTournament(idOrCode);
    if (t.status === 'cancelled') throw new ServiceError('งานนี้ถูกยกเลิกแล้ว แก้ไขไม่ได้');
    let patch = normalizeSettings(input, { partial: true });
    // ปิดจ็อบแล้ว: แก้ได้เฉพาะตั้งค่ารางวัลที่ยังไม่ได้แจก
    if (t.status === 'finished') patch = Object.fromEntries(Object.entries(patch).filter(([k]) => REWARD_KEYS.includes(k)));
    // แจกไปแล้ว ห้ามเปลี่ยนส่วนนั้น
    const oldCfg = E.rewardsOf(t);
    // แจกไปแล้ว: คงค่าเดิมของส่วนนั้นไว้ (ไม่ให้ตัวเลขที่แสดงเพี้ยนจากที่แจกจริง)
    if (t.points_awarded_at) {
        if (patch.give_points === false) throw new ServiceError('แจกแต้มไปแล้ว ปิดการแจกแต้มไม่ได้');
        if (patch.reward_config) patch.reward_config.points = oldCfg.points;
    }
    if (expAwarded(t)) {
        if (patch.give_exp === false && t.exp_awarded_at) throw new ServiceError('แจก EXP ไปแล้ว ปิดการแจก EXP ไม่ได้');
        if (patch.reward_config) patch.reward_config.exp = oldCfg.exp;
    }
    if (!Object.keys(patch).length) throw new ServiceError('ไม่มีอะไรให้บันทึก');
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
// 📝 บันทึกการแก้ไข (tournament_audit) — ไม่ทำให้งานหลักล้มถ้าเขียนไม่สำเร็จ
// actor = { id, name } จาก req.user ของเว็บ (บอทส่ง { name: 'Discord: ...' })
// ---------------------------------------------------------
const matchSnap = m => m && ({
    id: m.id, round: m.round, slot: m.slot, player1_id: m.player1_id, player2_id: m.player2_id,
    winner_id: m.winner_id, score1: m.score1 ?? null, score2: m.score2 ?? null,
    forfeit_player_id: m.forfeit_player_id ?? null, status: m.status, is_bye: !!m.is_bye,
});
async function audit(t, { action, match_id = null, reason = null, actor = null, before = null, after = null }) {
    try {
        await run(db().from('tournament_audit').insert({
            tournament_id: t.id, match_id, action, reason: reason || null,
            actor_id: actor?.id || null, actor_name: actor?.name || null, before, after,
        }));
    } catch (err) {
        console.error('[tournament audit]', err?.message || err);
    }
}
function needReason(reason, what) {
    const r = clean(reason, 500);
    if (!r) throw new ServiceError(`${what} ต้องใส่เหตุผลด้วย (เก็บไว้ในบันทึกการแก้ไข)`);
    return r;
}

async function listAudit(idOrCode, { limit = 100 } = {}) {
    const t = await getTournament(idOrCode);
    return run(db().from('tournament_audit').select('*').eq('tournament_id', t.id)
        .order('created_at', { ascending: false }).limit(Math.min(Number(limit) || 100, 500)));
}

// ---------------------------------------------------------
// กรอกผล / แก้ผลย้อนหลัง
// Swiss: แก้ได้ทุกรอบ (รอบที่ผ่านมาแล้วต้องใส่เหตุผล) การจับคู่รอบหลังคงเดิม ตารางคะแนนคำนวณใหม่เอง
// แพ้คัดออก: ถ้าเปลี่ยนผู้ชนะแล้วรอบหลังมีผลแล้ว ต้องเลือก mode 'swap' (สลับชื่อ) หรือ 'cascade' (ล้างสาย)
// ---------------------------------------------------------
async function loadMatchContext(matchId) {
    if (!UUID_RE.test(String(matchId || ''))) throw new ServiceError('ไม่พบแมตช์นี้', 404);
    const m = await run(db().from('tournament_matches').select('*').eq('id', matchId).single(), 'ไม่พบแมตช์นี้');
    const full = await getFull(m.tournament_id);
    const t = full.tournament;
    if (t.status === 'finished') throw new ServiceError('งานนี้ปิดจ็อบแล้ว — กด "เปิดงานใหม่" ในแท็บปิดจ็อบก่อนแก้ผล');
    if (t.status !== 'running') throw new ServiceError('งานนี้ไม่ได้อยู่ระหว่างแข่ง');
    if (m.is_bye) throw new ServiceError('แมตช์บายไม่ต้องกรอกผล');
    const target = full.matches.find(x => x.id === m.id);
    const before = matchSnap(target);
    return { m, full, t, target, before };
}

// Swiss รอบที่ผ่านไปแล้ว หรือแพ้คัดออกที่รอบหลังมีผลแล้ว = "แก้ย้อนหลัง" ต้องมีเหตุผล
function isBackdated(t, full, m) {
    if (t.format === 'swiss') return m.round < t.current_round;
    return E.elimPlayedDownstream(full.matches, m).length > 0;
}

async function saveElimChain(full, changed) {
    // changed = แมตช์ที่ต้องเขียนกลับ (object จาก full.matches)
    const seen = new Set();
    for (const x of changed) {
        if (!x || seen.has(x.id)) continue;
        seen.add(x.id);
        await run(db().from('tournament_matches').update({
            player1_id: x.player1_id, player2_id: x.player2_id, winner_id: x.winner_id,
            score1: x.score1 ?? null, score2: x.score2 ?? null, status: x.status,
            forfeit_player_id: x.forfeit_player_id ?? null,
            completed_at: x.status === 'complete' ? (x.completed_at || new Date().toISOString()) : null,
        }).eq('id', x.id));
    }
}

function elimCorrection(full, target, oldWinner, mode) {
    try {
        return E.applyElimCorrection(full.matches, target, oldWinner, mode === 'swap' || mode === 'cascade' ? mode : null);
    } catch (err) {
        throw new ServiceError(err.message, err.code === 'NEEDS_MODE' ? 409 : 400);
    }
}

async function reportResult(matchId, { winner, score1, score2, forfeit, reason, mode } = {}, actor = null) {
    const { m, full, t, target, before } = await loadMatchContext(matchId);
    if (m.status === 'pending' || !m.player1_id || !m.player2_id) throw new ServiceError('แมตช์นี้ยังรอผู้เล่นจากรอบก่อน');

    const winnerId = winner === 'p1' || winner === m.player1_id ? m.player1_id
        : winner === 'p2' || winner === m.player2_id ? m.player2_id : null;
    if (!winnerId) throw new ServiceError('ต้องเลือกผู้ชนะ');
    const loserId = winnerId === m.player1_id ? m.player2_id : m.player1_id;
    const toScore = v => (v === '' || v === null || v === undefined ? null : Number.isInteger(Number(v)) ? Number(v) : null);

    const backdated = isBackdated(t, full, target);
    const why = backdated ? needReason(reason, 'แก้ผลย้อนหลัง') : clean(reason, 500) || null;
    const oldWinner = target.status === 'complete' ? target.winner_id : null;

    Object.assign(target, {
        winner_id: winnerId, status: 'complete',
        score1: toScore(score1), score2: toScore(score2),
        forfeit_player_id: forfeit ? loserId : null,
        completed_at: target.completed_at && oldWinner ? target.completed_at : new Date().toISOString(),
    });

    const changed = [target];
    if (t.format === 'single_elim') changed.push(...elimCorrection(full, target, oldWinner, mode));
    await saveElimChain(full, changed);

    if (before.status === 'complete' || backdated) {
        await audit(t, {
            action: 'edit_result', match_id: m.id, reason: why, actor,
            before: { match: before, mode: t.format === 'single_elim' && changed.length > 1 ? (mode || null) : null },
            after: { match: matchSnap(target), downstream: changed.slice(1).map(matchSnap) },
        });
    }
    events.emit('match', t, target);
    return view(t.id);
}

async function clearResult(matchId, { reason } = {}, actor = null) {
    const { m, full, t, target, before } = await loadMatchContext(matchId);
    if (target.status !== 'complete') throw new ServiceError('แมตช์นี้ยังไม่มีผล');
    const backdated = isBackdated(t, full, target);
    const why = backdated ? needReason(reason, 'ล้างผลย้อนหลัง') : clean(reason, 500) || null;
    const oldWinner = target.winner_id;
    Object.assign(target, { winner_id: null, status: 'open', score1: null, score2: null, forfeit_player_id: null, completed_at: null });
    const changed = [target];
    // ล้างผลแล้วรอบหลังมีผล → ต้องล้างสายเท่านั้น
    if (t.format === 'single_elim') changed.push(...elimCorrection(full, target, oldWinner, backdated ? 'cascade' : null));
    await saveElimChain(full, changed);
    await audit(t, {
        action: 'clear_result', match_id: m.id, reason: why, actor,
        before: { match: before }, after: { match: matchSnap(target), downstream: changed.slice(1).map(matchSnap) },
    });
    events.emit('match', t, target);
    return view(t.id);
}

// Swiss: ย้อนกลับไปรอบ N — ลบทุกแมตช์หลังรอบ N แล้วให้จับคู่รอบ N+1 ใหม่
async function rollbackRound(idOrCode, toRound, { reason } = {}, actor = null) {
    const full = await getFull(idOrCode);
    const t = full.tournament;
    if (t.format !== 'swiss') throw new ServiceError('ย้อนรอบใช้ได้เฉพาะ Swiss (แพ้คัดออกให้แก้ผลแมตช์แล้วเลือก "ล้างสาย")');
    if (t.status === 'finished') throw new ServiceError('งานนี้ปิดจ็อบแล้ว — กด "เปิดงานใหม่" ก่อน');
    if (t.status !== 'running') throw new ServiceError('งานนี้ไม่ได้อยู่ระหว่างแข่ง');
    const n = Number(toRound);
    if (!Number.isInteger(n) || n < 1 || n >= t.current_round) throw new ServiceError(`เลือกรอบ 1–${t.current_round - 1} (ตอนนี้อยู่รอบ ${t.current_round})`);
    const why = needReason(reason, 'ย้อนรอบ');

    const removed = full.matches.filter(x => x.round > n);
    const locked = await run(db().from('tournaments')
        .update({ current_round: n, round_ends_at: null })
        .eq('id', t.id).eq('current_round', t.current_round).eq('status', 'running').select());
    if (!locked.length) throw new ServiceError('มีคนเปลี่ยนรอบไปแล้ว ลองโหลดหน้าใหม่');
    await run(db().from('tournament_matches').delete().eq('tournament_id', t.id).gt('round', n));

    await audit(t, {
        action: 'rollback_round', reason: why, actor,
        before: { current_round: t.current_round, removed: removed.map(matchSnap) },
        after: { current_round: n },
    });
    events.emit('match', locked[0], null);
    return view(t.id);
}

// เปิดงานที่ปิดจ็อบแล้วกลับมาแข่งต่อ — หักสถิติที่เคยบวกคืน · แต้ม/EXP ที่แจกแล้วคงไว้ ไม่แจกซ้ำ
async function reopenTournament(idOrCode, { reason } = {}, actor = null) {
    const full = await getFull(idOrCode);
    const t = full.tournament;
    if (t.status !== 'finished') throw new ServiceError('เปิดงานใหม่ได้เฉพาะงานที่ปิดจ็อบแล้ว');
    const why = needReason(reason, 'เปิดงานใหม่');
    const res = await run(db().rpc('t_reopen', { p_tournament_id: t.id }));
    await audit(t, {
        action: 'reopen', reason: why, actor,
        before: {
            status: t.status, finished_at: t.finished_at,
            final_ranks: full.players.filter(p => p.final_rank).map(p => ({ player_id: p.id, name: p.display_name, rank: p.final_rank })),
        },
        after: { status: 'running', stats_reversed: res?.stats_reversed?.length ?? 0 },
    });
    const fresh = await getTournament(t.id);
    events.emit('tournament', fresh);
    events.emit('match', fresh, null);
    return view(t.id);
}

// ล้างผลทั้งงาน กลับไปเปิดรับสมัคร (คงรายชื่อผู้เล่น) — แต้ม/EXP ที่แจกแล้วคงไว้ ไม่แจกซ้ำ
async function resetTournament(idOrCode, { reason } = {}, actor = null) {
    const full = await getFull(idOrCode);
    const t = full.tournament;
    if (!['running', 'finished'].includes(t.status)) throw new ServiceError('รีเซ็ตได้เฉพาะงานที่เริ่มแข่งแล้ว');
    const why = needReason(reason, 'รีเซ็ตผล');
    const res = await run(db().rpc('t_reset', { p_tournament_id: t.id }));
    await audit(t, {
        action: 'reset', reason: why, actor,
        before: { status: t.status, current_round: t.current_round, matches: full.matches.map(matchSnap) },
        after: { status: 'registration', matches_deleted: res?.matches_deleted ?? 0, stats_reversed: res?.stats_reversed?.length ?? 0 },
    });
    const fresh = await getTournament(t.id);
    events.emit('tournament', fresh);
    events.emit('match', fresh, null);
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
// แจกแต้ม / แจก EXP / ปิดจ็อบ — 3 ปุ่มแยกกัน
// แจกแต้ม/EXP กดได้อย่างละครั้ง ก่อนหรือหลังปิดจ็อบก็ได้ (ต้องกรอกผลครบทุกแมตช์)
// ---------------------------------------------------------
function assertResultsFinal(v) {
    const t = v.tournament;
    if (t.status === 'registration') throw new ServiceError('งานนี้ยังไม่เริ่มแข่ง');
    if (t.status === 'cancelled') throw new ServiceError('งานนี้ถูกยกเลิกแล้ว');
    if (!v.allMatchesComplete) throw new ServiceError('ยังมีแมตช์ที่ยังไม่กรอกผล');
    if (!v.resultsFinal) throw new ServiceError(`ยังแข่งไม่ครบ ${v.totalRounds} รอบ`);
}

async function awardPoints(idOrCode) {
    const full = await getFull(idOrCode);
    const v = buildView(full);
    const t = full.tournament;
    if (t.give_points === false) throw new ServiceError('งานนี้ตั้งค่าไว้ว่าไม่แจกแต้มแลกการ์ด');
    if (t.points_awarded_at) throw new ServiceError('งานนี้แจกแต้มไปแล้ว');
    assertResultsFinal(v);
    const pv = E.rewardsPreview(t, full.players, full.matches);
    const awards = pv.filter(r => r.points > 0).map(r => ({ player_id: r.player.id, rank: r.rank, points: r.points }));
    if (!awards.length) throw new ServiceError('ยังไม่มีผู้เล่นที่ได้แต้ม (ต้องแข่งจริงอย่างน้อย 1 แมตช์)');
    const res = await run(db().rpc('t_award_points', { p_tournament_id: t.id, p_awards: awards }));
    events.emit('points', t, res);
    return { ...res, quota: v.pointsQuota, total: awards.reduce((a, x) => a + x.points, 0) };
}

// playedAllIds: array ของ player id ที่เล่นครบทุกรอบ (ไม่ส่ง = ใช้ค่าในฐานข้อมูล)
async function awardExp(idOrCode, { playedAllIds } = {}) {
    const full = await getFull(idOrCode);
    const v = buildView(full);
    const t = full.tournament;
    if (t.give_exp === false) throw new ServiceError('งานนี้ตั้งค่าไว้ว่าไม่แจก EXP');
    if (expAwarded(t)) throw new ServiceError('งานนี้แจก EXP ไปแล้ว');
    assertResultsFinal(v);

    const set = Array.isArray(playedAllIds) ? new Set(playedAllIds) : null;
    const pv = E.rewardsPreview(t, full.players, full.matches, set);
    const results = pv.map(r => ({ player_id: r.player.id, rank: r.rank, exp: r.exp, played_all: r.playedAll, played: r.played > 0 }));
    const res = await run(db().rpc('t_award_exp', { p_tournament_id: t.id, p_results: results }));
    const noShow = pv.filter(r => r.played === 0).map(r => ({ player_id: r.player.id, name: r.player.display_name, discord_id: r.player.discord_id }));
    const out = {
        ...res, noShow, rewards: E.rewardsOf(t),
        results: pv.map(r => ({ player_id: r.player.id, name: r.player.display_name, discord_id: r.player.discord_id, rank: r.rank, exp: r.exp, playedAll: r.playedAll, played: r.played })),
    };
    events.emit('exp', t, out);
    return out;
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

// ปิดจ็อบ: บันทึกประวัติการแข่ง + สถิติผู้เล่น แล้วปิดงาน (ไม่แจก EXP)
async function finish(idOrCode) {
    const full = await getFull(idOrCode);
    const v = buildView(full);
    const t = full.tournament;
    if (t.status === 'finished') throw new ServiceError('งานนี้ปิดจ็อบไปแล้ว');
    if (!v.allMatchesComplete) throw new ServiceError('ยังมีแมตช์ที่ยังไม่กรอกผล');
    if (!v.canFinish) throw new ServiceError(`ยังแข่งไม่ครบ ${v.totalRounds} รอบ`);

    const pv = E.rewardsPreview(t, full.players, full.matches);
    const results = pv.map(r => ({ player_id: r.player.id, rank: r.rank, played: r.played > 0 }));
    const { participants, history } = buildHistoryText(full, pv);

    const res = await run(db().rpc('t_close', {
        p_tournament_id: t.id, p_results: results,
        p_participants_list: participants, p_match_history: history,
    }));
    const pending = [];
    if (t.give_points !== false && !t.points_awarded_at) pending.push('แต้มแลกการ์ด');
    if (t.give_exp !== false && !expAwarded(t)) pending.push('EXP');
    const out = { ...res, pending };
    events.emit('finished', { ...t, status: 'finished' }, out);
    return out;
}


// ---------------------------------------------------------
// 🛡️ สิทธิ์: แอดมินร้าน (user_profiles.role = 'admin') = จัดการทัวร์ + แต่งตั้งสตาฟ
//          สตาฟ (tournament_staff.discord_id) = จัดการทัวร์อย่างเดียว
// ---------------------------------------------------------
const DISCORD_ID_RE = /^\d{17,20}$/;
let staffCache = { at: 0, ids: new Set() };
const STAFF_TTL_MS = 30_000;

async function staffIds(force = false) {
    if (!force && Date.now() - staffCache.at < STAFF_TTL_MS) return staffCache.ids;
    const rows = await run(db().from('tournament_staff').select('discord_id'));
    staffCache = { at: Date.now(), ids: new Set(rows.map(r => r.discord_id)) };
    return staffCache.ids;
}
async function isStaffDiscord(discordId) {
    if (!discordId) return false;
    return (await staffIds()).has(String(discordId));
}

// Discord ID ของผู้ใช้เว็บ: จาก identity ที่ login ด้วย Discord หรือที่ผูกไว้ในตาราง customers
async function discordIdsOfUser(user) {
    const ids = new Set();
    for (const i of user.identities || []) {
        if (i.provider !== 'discord') continue;
        const v = i.identity_data?.provider_id || i.identity_data?.sub || i.id;
        if (v && DISCORD_ID_RE.test(String(v))) ids.add(String(v));
    }
    const c = await run(db().from('customers').select('discord_id').eq('id', user.id).maybeSingle());
    if (c?.discord_id) ids.add(String(c.discord_id));
    return [...ids];
}

// คืน 'admin' | 'staff' | null
async function resolveRole(user) {
    const prof = await run(db().from('user_profiles').select('role').eq('id', user.id).maybeSingle());
    if (prof?.role === 'admin') return { role: 'admin', discordIds: await discordIdsOfUser(user) };
    const ids = await discordIdsOfUser(user);
    const staff = await staffIds();
    if (ids.some(id => staff.has(id))) return { role: 'staff', discordIds: ids };
    return { role: null, discordIds: ids };
}

async function listStaff() {
    const rows = await run(db().from('tournament_staff').select('*').order('created_at'));
    if (!rows.length) return [];
    const ids = rows.map(r => r.discord_id);
    const [cs, ls] = await Promise.all([
        run(db().from('customers').select('discord_id, display_name').in('discord_id', ids)),
        run(db().from('legacy_accounts').select('discord_id, name').in('discord_id', ids)),
    ]);
    const nameOf = Object.fromEntries([...ls.map(l => [l.discord_id, l.name]), ...cs.map(c => [c.discord_id, c.display_name])]);
    return rows.map(r => ({ ...r, name: nameOf[r.discord_id] || null }));
}

async function addStaff(discordId, note, byUserId) {
    const id = String(discordId ?? '').trim();
    if (!DISCORD_ID_RE.test(id)) throw new ServiceError('Discord ID ต้องเป็นตัวเลข 17–20 หลัก (คลิกขวาที่ชื่อใน Discord → Copy User ID)');
    const row = await run(db().from('tournament_staff').insert({ discord_id: id, note: clean(note, 80) || null, added_by: byUserId || null }).select().single());
    await staffIds(true);
    return row;
}

async function removeStaff(discordId) {
    const rows = await run(db().from('tournament_staff').delete().eq('discord_id', String(discordId)).select());
    if (!rows.length) throw new ServiceError('ไม่พบสตาฟคนนี้', 404);
    await staffIds(true);
    return rows[0];
}

module.exports = {
    isStaffDiscord, resolveRole, listStaff, addStaff, removeStaff,
    ServiceError, events, db,
    getTournament, getFull, view, buildView, listTournaments,
    createTournament, updateTournament, cancelTournament, setDiscordRefs,
    findAccountByDiscord, searchAccounts, addPlayer, removePlayer, removePlayerByDiscord, setDropped, renamePlayer,
    startTournament, nextRound, reportResult, clearResult, startTimer, stopTimer,
    rollbackRound, reopenTournament, resetTournament, listAudit,
    awardPoints, awardExp, finish, expAwarded,
};
