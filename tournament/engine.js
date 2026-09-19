// =========================================================
// 🧠 Tournament Engine — ตรรกะล้วน ไม่แตะฐานข้อมูล (ทดสอบได้ง่าย)
// ใช้ร่วมกันระหว่างเว็บจัดทัวร์และบอท Discord
// =========================================================
'use strict';

// ---------- เกณฑ์รางวัล (ตรงกับ skill dinomaster-scoring) ----------
const EXP_JOIN = 10;
const EXP_FULL_PLAY = 10;

function placementExp(rank) {
    if (rank === 1) return 50;
    if (rank <= 3) return 30;
    if (rank <= 5) return 20;
    return 0;
}
function calcExp(rank, playedAll) {
    return placementExp(rank) + EXP_JOIN + (playedAll ? EXP_FULL_PLAY : 0);
}
function pointsQuota(totalPlayers) {
    return totalPlayers >= 10 ? 5 : 3;
}
function calcPoints(rank, totalPlayers) {
    if (rank === 1) return 10;
    return rank <= pointsQuota(totalPlayers) ? 5 : 0;
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
    return table.map(r => {
        const played = r.played > 0;
        const playedAll = playedAllIds ? playedAllIds.has(r.player.id) : !!r.player.played_all;
        return {
            player: r.player,
            rank: r.rank,
            wins: r.wins, losses: r.losses, played: r.played, byes: r.byes,
            buchholz: r.buchholz, forfeit: r.forfeit,
            playedAll: played ? playedAll : false,
            points: played ? calcPoints(r.rank, total) : 0,
            exp: played ? calcExp(r.rank, playedAll) : 0,
        };
    });
}

module.exports = {
    EXP_JOIN, EXP_FULL_PLAY, placementExp, calcExp, pointsQuota, calcPoints,
    shuffle, swissRoundsFor, elimRoundsFor, totalRounds, computeStats, standings,
    pairSwissRound, seedOrder, buildElimBracket, nextElimMatch, applyElimAdvance,
    currentRoundOf, isRoundComplete, allComplete, rewardsPreview,
};
