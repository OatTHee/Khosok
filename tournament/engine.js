// =========================================================
// 🧠 Tournament Engine — ตรรกะล้วน ไม่แตะฐานข้อมูล (ทดสอบได้ง่าย)
// ใช้ร่วมกันระหว่างเว็บจัดทัวร์และบอท Discord
// =========================================================
'use strict';

// ---------- เกณฑ์รางวัล ----------
// ค่าเริ่มต้นตรงกับ skill dinomaster-scoring — แต่ละงานตั้งเองได้ (tournaments.reward_config)
const EXP_JOIN = 10;
const EXP_FULL_PLAY = 10;
const MAX_REWARD_RANKS = 16;

const DEFAULT_REWARDS = Object.freeze({
    points: { ranks: [10, 5, 5, 5, 5], base_top: 3, expand_min_players: 10, expand_top: 5 },
    exp: { ranks: [50, 30, 30, 20, 20], join: EXP_JOIN, full_play: EXP_FULL_PLAY },
});

const int = (v, def, min = 0, max = 100000) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : def;
};

// ทำความสะอาด config ที่มาจากฐานข้อมูล/หน้าเว็บ (ช่องไหนผิดใช้ค่าเริ่มต้น)
function normalizeRewards(cfg) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    const p = c.points || {}, e = c.exp || {};
    const ranks = (arr, def) => (Array.isArray(arr) && arr.length
        ? arr.slice(0, MAX_REWARD_RANKS).map(x => int(x, 0))
        : def.slice());
    const pts = {
        ranks: ranks(p.ranks, DEFAULT_REWARDS.points.ranks),
        base_top: int(p.base_top, DEFAULT_REWARDS.points.base_top, 0, MAX_REWARD_RANKS),
        expand_min_players: int(p.expand_min_players, DEFAULT_REWARDS.points.expand_min_players, 0, 1000),
        expand_top: int(p.expand_top, DEFAULT_REWARDS.points.expand_top, 0, MAX_REWARD_RANKS),
    };
    if (pts.expand_top < pts.base_top) pts.expand_top = pts.base_top;
    return {
        points: pts,
        exp: {
            ranks: ranks(e.ranks, DEFAULT_REWARDS.exp.ranks),
            join: int(e.join, DEFAULT_REWARDS.exp.join),
            full_play: int(e.full_play, DEFAULT_REWARDS.exp.full_play),
        },
    };
}
const rewardsOf = t => normalizeRewards(t?.reward_config);

// expand_min_players = 0 → ไม่มีการขยายโควตา
function pointsQuota(totalPlayers, cfg = DEFAULT_REWARDS) {
    const p = normalizeRewards(cfg).points;
    return p.expand_min_players > 0 && totalPlayers >= p.expand_min_players ? p.expand_top : p.base_top;
}
function calcPoints(rank, totalPlayers, cfg = DEFAULT_REWARDS) {
    const c = normalizeRewards(cfg);
    if (rank > pointsQuota(totalPlayers, c)) return 0;
    return c.points.ranks[rank - 1] || 0;
}
function placementExp(rank, cfg = DEFAULT_REWARDS) {
    return normalizeRewards(cfg).exp.ranks[rank - 1] || 0;
}
function calcExp(rank, playedAll, cfg = DEFAULT_REWARDS) {
    const e = normalizeRewards(cfg).exp;
    return (e.ranks[rank - 1] || 0) + e.join + (playedAll ? e.full_play : 0);
}

// จัดกลุ่มอันดับที่ได้ค่าเท่ากันติดกัน: [10,5,5] → [{from:1,to:1,v:10},{from:2,to:3,v:5}]
function groupRanks(values, upto = values.length) {
    const out = [];
    for (let r = 1; r <= upto; r++) {
        const v = values[r - 1] || 0;
        const last = out[out.length - 1];
        if (last && last.v === v) last.to = r; else out.push({ from: r, to: r, v });
    }
    return out.filter(g => g.v > 0);
}
const rankLabel = g => (g.from === 1 && g.to === 1 ? 'แชมป์' : g.from === g.to ? `อันดับ ${g.from}` : `อันดับ ${g.from}–${g.to}`);

// ข้อความอธิบายการแจกแต้ม ใช้ทั้งบอร์ด !setup และหน้าเว็บ
function describePoints(cfg) {
    const p = normalizeRewards(cfg).points;
    const base = groupRanks(p.ranks, p.base_top);
    if (!base.length && !(p.expand_min_players > 0 && p.expand_top > p.base_top)) return 'ไม่มีอันดับที่ได้แต้ม';
    let text = `แจกให้ **Top ${p.base_top}**: ${base.map(g => `${rankLabel(g)} **${g.v}** แต้ม`).join(' · ') || '-'}`;
    if (p.expand_min_players > 0 && p.expand_top > p.base_top) {
        const extra = groupRanks(p.ranks, p.expand_top).map(g => ({ ...g, from: Math.max(g.from, p.base_top + 1) })).filter(g => g.to > p.base_top);
        text += `\nถ้ามีผู้เข้าแข่งครบ **${p.expand_min_players} คน** ขยายเป็น **Top ${p.expand_top}**${extra.length ? ` (${extra.map(g => `${rankLabel(g)} **${g.v}** แต้ม`).join(' · ')})` : ''}`;
    }
    return text;
}
function describeExp(cfg) {
    const e = normalizeRewards(cfg).exp;
    const parts = groupRanks(e.ranks).map(g => `${g.from === g.to ? `อันดับ ${g.from}` : `อันดับ ${g.from}-${g.to}`} +${g.v}`);
    if (e.join) parts.push(`เข้าร่วม +${e.join}`);
    if (e.full_play) parts.push(`เล่นครบทุกรอบ +${e.full_play}`);
    return parts.join(' | ') || 'ไม่มี EXP';
}

// ---------- ตัวช่วยทั่วไป ----------
function shuffle(arr, rng = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function swissRoundsFor(n) {
    return Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
}
function elimRoundsFor(n) {
    return Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
}
function totalRounds(tournament, playerCount) {
    if (tournament.format === 'single_elim') return elimRoundsFor(playerCount);
    return tournament.swiss_rounds || swissRoundsFor(playerCount);
}

// ---------- สถิติรายคน ----------
function computeStats(players, matches) {
    const s = new Map();
    for (const p of players) {
        s.set(p.id, {
            wins: 0, losses: 0, played: 0, byes: 0,
            opponents: [], forfeit: !!p.dropped_at, lostInRound: null,
        });
    }
    for (const m of matches) {
        if (m.status !== 'complete') continue;
        if (m.is_bye) {
            const st = s.get(m.player1_id || m.player2_id);
            if (st) { st.wins++; st.byes++; }
            continue;
        }
        const a = s.get(m.player1_id), b = s.get(m.player2_id);
        if (a) { a.played++; a.opponents.push(m.player2_id); }
        if (b) { b.played++; b.opponents.push(m.player1_id); }
        const w = s.get(m.winner_id);
        const loserId = m.winner_id === m.player1_id ? m.player2_id : m.player1_id;
        const l = s.get(loserId);
        if (w) w.wins++;
        if (l) { l.losses++; if (l.lostInRound === null) l.lostInRound = m.round; }
        if (m.forfeit_player_id && s.get(m.forfeit_player_id)) s.get(m.forfeit_player_id).forfeit = true;
    }
    for (const st of s.values()) {
        st.buchholz = st.opponents.reduce((sum, id) => sum + (s.get(id)?.wins || 0), 0);
    }
    return s;
}

// ---------- ตารางอันดับ (อันดับรันต่อเนื่อง ไม่มีอันดับร่วม) ----------
function standings(tournament, players, matches) {
    const stats = computeStats(players, matches);
    const seedOf = p => (p.seed ?? 9999);
    const rows = players.map(p => ({ player: p, ...stats.get(p.id) }));

    if (tournament.format === 'single_elim') {
        const depth = r => (r.lostInRound === null ? Infinity : r.lostInRound);
        rows.sort((a, b) =>
            (a.forfeit - b.forfeit) ||
            (depth(b) - depth(a) || 0) ||
            (b.wins - a.wins) ||
            (seedOf(a.player) - seedOf(b.player)));
    } else {
        rows.sort((a, b) =>
            (a.forfeit - b.forfeit) ||
            (b.wins - a.wins) ||
            (b.buchholz - a.buchholz) ||
            (a.losses - b.losses) ||
            (seedOf(a.player) - seedOf(b.player)));
    }
    return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

// ---------- Swiss: จับคู่รอบถัดไป ----------
function pairSwissRound(players, matches, round, { rng = Math.random } = {}) {
    const stats = computeStats(players, matches);
    const active = players.filter(p => !p.dropped_at);
    if (active.length < 2) throw new Error('ผู้เล่นที่ยังอยู่ในงานไม่พอจับคู่ (ต้องมีอย่างน้อย 2 คน)');

    const played = new Set();
    for (const m of matches) {
        if (!m.is_bye && m.player1_id && m.player2_id) played.add(pairKey(m.player1_id, m.player2_id));
    }

    // เรียงตาม ชนะ → Buchholz → seed (รอบแรกทุกคน 0 ชนะ = เรียงตาม seed ที่สุ่มไว้แล้ว)
    // คนคะแนนเท่ากันสุ่มลำดับกันเล็กน้อยตั้งแต่รอบ 2 เพื่อไม่ให้เจอคู่เดิมๆ ตาม seed
    const jitter = new Map(active.map(p => [p.id, round > 1 ? rng() : 0]));
    const ranked = active.slice().sort((a, b) => {
        const A = stats.get(a.id), B = stats.get(b.id);
        return (B.wins - A.wins) || (B.buchholz - A.buchholz) ||
            (jitter.get(a.id) - jitter.get(b.id)) || ((a.seed ?? 9999) - (b.seed ?? 9999));
    });

    let budget = 200000;
    const tryPair = (list, allowRematch) => {
        if (list.length === 0) return [];
        if (--budget < 0) return null;
        const [a, ...rest] = list;
        for (let i = 0; i < rest.length; i++) {
            const b = rest[i];
            if (!allowRematch && played.has(pairKey(a.id, b.id))) continue;
            const sub = tryPair(rest.slice(0, i).concat(rest.slice(i + 1)), allowRematch);
            if (sub) return [[a, b], ...sub];
        }
        return null;
    };

    // ผู้ได้บาย: เลือกจากล่างขึ้นบน คนที่ยังไม่เคยได้บาย
    const byeCandidates = ranked.length % 2 === 0
        ? [null]
        : [...ranked].reverse().sort((a, b) => stats.get(a.id).byes - stats.get(b.id).byes);

    let pairs = null, bye = null;
    for (const allowRematch of [false, true]) {
        for (const cand of byeCandidates) {
            budget = 200000;
            const pool = cand ? ranked.filter(p => p.id !== cand.id) : ranked;
            const res = tryPair(pool, allowRematch);
            if (res) { pairs = res; bye = cand; break; }
        }
        if (pairs) break;
    }
    if (!pairs) throw new Error('จับคู่ไม่สำเร็จ');

    const out = pairs.map(([a, b], i) => ({
        round, slot: i + 1, player1_id: a.id, player2_id: b.id,
        is_bye: false, status: 'open', winner_id: null,
    }));
    if (bye) {
        out.push({
            round, slot: out.length + 1, player1_id: bye.id, player2_id: null,
            is_bye: true, status: 'complete', winner_id: bye.id,
        });
    }
    return out;
}

// ---------- แพ้คัดออก: สร้างสายทั้งหมด ----------
function seedOrder(size) {
    let o = [1, 2];
    while (o.length < size) {
        const n = o.length * 2;
        o = o.flatMap(s => [s, n + 1 - s]);
    }
    return o;
}

// players ต้องเรียงตาม seed แล้ว (seed 1 มาก่อน)
function buildElimBracket(seededPlayers) {
    const n = seededPlayers.length;
    if (n < 2) throw new Error('ต้องมีผู้เล่นอย่างน้อย 2 คน');
    const rounds = elimRoundsFor(n);
    const size = 2 ** rounds;
    const order = seedOrder(size);
    const bySeed = i => seededPlayers[i - 1] || null;

    const matches = [];
    for (let r = 1; r <= rounds; r++) {
        const count = size / 2 ** r;
        for (let s = 1; s <= count; s++) {
            matches.push({
                round: r, slot: s, player1_id: null, player2_id: null,
                winner_id: null, is_bye: false, status: 'pending',
            });
        }
    }
    const get = (r, s) => matches.find(m => m.round === r && m.slot === s);

    for (let s = 1; s <= size / 2; s++) {
        const m = get(1, s);
        const a = bySeed(order[2 * (s - 1)]);
        const b = bySeed(order[2 * (s - 1) + 1]);
        m.player1_id = a ? a.id : null;
        m.player2_id = b ? b.id : null;
        if (a && b) m.status = 'open';
        else {
            m.is_bye = true;
            m.status = 'complete';
            m.winner_id = (a || b).id;
        }
    }
    // ส่งผู้ได้บายขึ้นรอบ 2
    for (const m of matches.filter(x => x.round === 1 && x.is_bye)) {
        applyElimAdvance(matches, m);
    }
    return matches;
}

// หาแมตช์ถัดไปที่ผู้ชนะของ m จะไป
function nextElimMatch(matches, m) {
    return matches.find(x => x.round === m.round + 1 && x.slot === Math.ceil(m.slot / 2)) || null;
}

// ใส่ผู้ชนะของ m ลงแมตช์ถัดไป (แก้ object ใน matches ตรงๆ) — คืนแมตช์ที่ถูกแก้
function applyElimAdvance(matches, m) {
    const next = nextElimMatch(matches, m);
    if (!next) return null;
    if (next.status === 'complete' && !next.is_bye) {
        throw new Error(`แมตช์รอบ ${next.round} โต๊ะ ${next.slot} กรอกผลไปแล้ว ต้องล้างผลรอบนั้นก่อน`);
    }
    const key = m.slot % 2 === 1 ? 'player1_id' : 'player2_id';
    next[key] = m.status === 'complete' ? m.winner_id : null;
    next.status = next.player1_id && next.player2_id ? 'open' : 'pending';
    return next;
}

// ---------- แพ้คัดออก: แก้ผลย้อนหลัง ----------
// แมตช์ถัดๆ ไปในสายของ m ที่กรอกผลไปแล้ว (ไม่นับบาย)
function elimPlayedDownstream(matches, m) {
    const out = [];
    let cur = nextElimMatch(matches, m);
    while (cur) {
        if (cur.status === 'complete' && !cur.is_bye) out.push(cur);
        cur = nextElimMatch(matches, cur);
    }
    return out;
}

const clearMatchResult = x => Object.assign(x, {
    winner_id: null, score1: null, score2: null, forfeit_player_id: null, completed_at: null,
});
const statusByPlayers = x => (x.player1_id && x.player2_id ? 'open' : 'pending');

// เรียกหลังแก้ target แล้ว (target = ผลใหม่ / ล้างผลแล้ว) — oldWinnerId = ผู้ชนะเดิมก่อนแก้
// mode: 'swap'    = คนชนะจริงเป็นคนที่ไปแข่งรอบถัดไป → แทนชื่อในรอบหลังโดยไม่แตะผล
//       'cascade' = ล้างผลทุกแมตช์ในสายที่ต่อจากแมตช์นี้
// คืนรายการแมตช์ที่ถูกแก้ · ถ้ารอบหลังมีผลแล้วแต่ไม่ได้ระบุ mode จะโยน error (code = 'NEEDS_MODE')
function applyElimCorrection(matches, target, oldWinnerId, mode = null) {
    const newWinner = target.status === 'complete' ? target.winner_id : null;
    if (oldWinnerId && oldWinnerId === newWinner) return []; // แก้แค่สกอร์ ผู้ชนะเดิม
    const next = nextElimMatch(matches, target);
    if (!next) return [];
    const played = elimPlayedDownstream(matches, target);
    if (!played.length) return [applyElimAdvance(matches, target)];

    if (mode === 'swap') {
        if (!newWinner || !oldWinnerId) {
            throw Object.assign(new Error('สลับชื่อได้เฉพาะตอนเปลี่ยนตัวผู้ชนะ — ถ้าจะล้างผลให้เลือก "ล้างสาย"'), { code: 'BAD_MODE' });
        }
        const changed = [];
        for (const x of matches) {
            if (x.round <= target.round) continue;
            let hit = false;
            for (const k of ['player1_id', 'player2_id', 'winner_id', 'forfeit_player_id']) {
                if (x[k] === oldWinnerId) { x[k] = newWinner; hit = true; }
            }
            if (hit) changed.push(x);
        }
        return changed;
    }
    if (mode === 'cascade') {
        const changed = [];
        let cur = target, nx = next;
        while (nx) {
            const key = cur.slot % 2 === 1 ? 'player1_id' : 'player2_id';
            nx[key] = cur.status === 'complete' ? cur.winner_id : null;
            const wasPlayed = nx.status === 'complete' && !nx.is_bye;
            if (wasPlayed) clearMatchResult(nx);
            nx.status = statusByPlayers(nx);
            changed.push(nx);
            if (!wasPlayed) break;
            cur = nx;
            nx = nextElimMatch(matches, cur);
        }
        return changed;
    }
    throw Object.assign(new Error(`รอบหลังกรอกผลไปแล้ว ${played.length} แมตช์ — เลือกว่าจะ "สลับชื่อ" หรือ "ล้างสาย"`),
        { code: 'NEEDS_MODE', affected: played.map(x => ({ id: x.id, round: x.round, slot: x.slot })) });
}

// ---------- รอบปัจจุบัน / สถานะ ----------
function currentRoundOf(tournament, matches) {
    if (!matches.length) return 0;
    if (tournament.format === 'single_elim') {
        const notDone = matches.filter(m => m.status !== 'complete');
        if (notDone.length) return Math.min(...notDone.map(m => m.round));
        return Math.max(...matches.map(m => m.round));
    }
    return Math.max(...matches.map(m => m.round));
}
function isRoundComplete(matches, round) {
    const rm = matches.filter(m => m.round === round);
    return rm.length > 0 && rm.every(m => m.status === 'complete');
}
function allComplete(matches) {
    return matches.length > 0 && matches.every(m => m.status === 'complete');
}

// ---------- สรุปรางวัลรายคน ----------
// playedAllIds: Set ของ player id ที่ "เล่นครบทุกรอบ" (null = ใช้ค่า played_all ในฐานข้อมูล)
function rewardsPreview(tournament, players, matches, playedAllIds = null) {
    const table = standings(tournament, players, matches);
    const total = players.length;
    const cfg = rewardsOf(tournament);
    const givePoints = tournament?.give_points !== false;
    const giveExp = tournament?.give_exp !== false;
    return table.map(r => {
        const played = r.played > 0;
        const playedAll = playedAllIds ? playedAllIds.has(r.player.id) : !!r.player.played_all;
        return {
            player: r.player,
            rank: r.rank,
            wins: r.wins, losses: r.losses, played: r.played, byes: r.byes,
            buchholz: r.buchholz, forfeit: r.forfeit,
            playedAll: played ? playedAll : false,
            points: played && givePoints ? calcPoints(r.rank, total, cfg) : 0,
            exp: played && giveExp ? calcExp(r.rank, playedAll, cfg) : 0,
        };
    });
}

module.exports = {
    EXP_JOIN, EXP_FULL_PLAY, DEFAULT_REWARDS, MAX_REWARD_RANKS, normalizeRewards, rewardsOf,
    placementExp, calcExp, pointsQuota, calcPoints, describePoints, describeExp,
    shuffle, swissRoundsFor, elimRoundsFor, totalRounds, computeStats, standings,
    pairSwissRound, seedOrder, buildElimBracket, nextElimMatch, applyElimAdvance,
    elimPlayedDownstream, applyElimCorrection,
    currentRoundOf, isRoundComplete, allComplete, rewardsPreview,
};
