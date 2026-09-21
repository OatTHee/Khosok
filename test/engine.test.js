const test = require('node:test');
const assert = require('node:assert');
const E = require('../tournament/engine');

const mkPlayers = n => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, display_name: `P${i + 1}`, seed: i + 1, played_all: true }));
let seq = 0;
function playSwiss(n, rounds, pickWinner = m => m.player1_id) {
    const players = mkPlayers(n);
    const matches = [];
    for (let r = 1; r <= rounds; r++) {
        const pairs = E.pairSwissRound(players, matches, r);
        for (const m of pairs) {
            m.id = `m${++seq}`;
            if (!m.is_bye) { m.winner_id = pickWinner(m); m.status = 'complete'; }
            matches.push(m);
        }
    }
    return { players, matches };
}

test('rewards follow skill table', () => {
    assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map(r => E.calcExp(r, true)), [70, 50, 50, 40, 40, 20]);
    assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map(r => E.calcExp(r, false)), [60, 40, 40, 30, 30, 10]);
    assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map(r => E.calcPoints(r, 12)), [10, 5, 5, 5, 5, 0]);
    assert.deepStrictEqual([1, 2, 3, 4].map(r => E.calcPoints(r, 8)), [10, 5, 5, 0]);
});

test('swiss: no rematches, every active player once per round, bye rotates', () => {
    for (const n of [2, 3, 5, 7, 8, 9, 10, 13, 16, 17, 32]) {
        const rounds = E.swissRoundsFor(n);
        const { players, matches } = playSwiss(n, rounds, m => (Math.random() < 0.5 ? m.player1_id : m.player2_id));
        const seen = new Set();
        for (const m of matches.filter(m => !m.is_bye)) {
            const k = [m.player1_id, m.player2_id].sort().join();
            assert.ok(!seen.has(k), `rematch n=${n}`);
            seen.add(k);
        }
        for (let r = 1; r <= rounds; r++) {
            const ids = matches.filter(m => m.round === r).flatMap(m => [m.player1_id, m.player2_id]).filter(Boolean);
            assert.strictEqual(ids.length, n);
            assert.strictEqual(new Set(ids).size, n);
        }
        const byes = matches.filter(m => m.is_bye).map(m => m.player1_id);
        assert.strictEqual(new Set(byes).size, byes.length, `bye twice n=${n}`);
        const table = E.standings({ format: 'swiss' }, players, matches);
        assert.deepStrictEqual(table.map(r => r.rank), players.map((_, i) => i + 1));
    }
});

test('swiss: dropped player is skipped and ranked last', () => {
    const players = mkPlayers(6);
    const matches = [];
    const r1 = E.pairSwissRound(players, matches, 1);
    r1.forEach((m, i) => { m.id = 'x' + i; m.winner_id = m.player1_id; m.status = 'complete'; matches.push(m); });
    const top = r1[0].player1_id;
    players.find(p => p.id === top).dropped_at = new Date().toISOString();
    const r2 = E.pairSwissRound(players, matches, 2);
    assert.ok(!r2.some(m => m.player1_id === top || m.player2_id === top));
    assert.strictEqual(r2.filter(m => m.is_bye).length, 1);
    const t = E.standings({ format: 'swiss' }, players, matches);
    assert.strictEqual(t[t.length - 1].player.id, top);
});

test('swiss: forfeit loser ranked last even with wins', () => {
    const players = mkPlayers(4);
    const matches = [
        { round: 1, slot: 1, player1_id: 'p1', player2_id: 'p2', winner_id: 'p1', status: 'complete' },
        { round: 1, slot: 2, player1_id: 'p3', player2_id: 'p4', winner_id: 'p3', status: 'complete' },
        { round: 2, slot: 1, player1_id: 'p1', player2_id: 'p3', winner_id: 'p3', status: 'complete', forfeit_player_id: 'p1' },
        { round: 2, slot: 2, player1_id: 'p2', player2_id: 'p4', winner_id: 'p2', status: 'complete' },
    ];
    const t = E.standings({ format: 'swiss' }, players, matches);
    assert.strictEqual(t[0].player.id, 'p3');
    assert.strictEqual(t[3].player.id, 'p1');
});

test('elim: bracket shape, byes to top seeds, champion rank 1', () => {
    for (const n of [2, 3, 5, 6, 8, 11, 16]) {
        const players = mkPlayers(n);
        const matches = E.buildElimBracket(players);
        const size = 2 ** E.elimRoundsFor(n);
        assert.strictEqual(matches.length, size - 1);
        const byes = matches.filter(m => m.is_bye);
        assert.strictEqual(byes.length, size - n);
        byes.forEach(m => assert.ok(Number(m.winner_id.slice(1)) <= size - n, 'bye goes to top seeds'));
        // play: higher seed always wins
        for (let r = 1; r <= E.elimRoundsFor(n); r++) {
            for (const m of matches.filter(m => m.round === r && m.status === 'open')) {
                const a = Number(m.player1_id.slice(1)), b = Number(m.player2_id.slice(1));
                m.winner_id = a < b ? m.player1_id : m.player2_id;
                m.status = 'complete';
                E.applyElimAdvance(matches, m);
            }
        }
        assert.ok(E.allComplete(matches), `all complete n=${n}`);
        const t = E.standings({ format: 'single_elim' }, players, matches);
        assert.strictEqual(t[0].player.id, 'p1');
        assert.strictEqual(t[1].player.id, 'p2');
        assert.deepStrictEqual(t.map(r => r.rank), players.map((_, i) => i + 1));
    }
});

test('elim: cannot change result once next match completed', () => {
    const players = mkPlayers(4);
    const ms = E.buildElimBracket(players);
    const [a, b] = ms.filter(m => m.round === 1);
    a.winner_id = a.player1_id; a.status = 'complete'; E.applyElimAdvance(ms, a);
    b.winner_id = b.player1_id; b.status = 'complete'; E.applyElimAdvance(ms, b);
    const f = ms.find(m => m.round === 2);
    assert.strictEqual(f.status, 'open');
    f.winner_id = f.player1_id; f.status = 'complete';
    a.winner_id = a.player2_id;
    assert.throws(() => E.applyElimAdvance(ms, a));
});

test('rewards preview: no-show gets nothing, played_all respected', () => {
    const players = mkPlayers(4);
    players[3].dropped_at = 'x';
    const matches = [
        { round: 1, slot: 1, player1_id: 'p1', player2_id: 'p2', winner_id: 'p1', status: 'complete' },
        { round: 1, slot: 2, player1_id: 'p3', player2_id: null, winner_id: 'p3', status: 'complete', is_bye: true },
    ];
    const pv = E.rewardsPreview({ format: 'swiss' }, players, matches, new Set(['p1']));
    const by = Object.fromEntries(pv.map(r => [r.player.id, r]));
    assert.strictEqual(by.p1.rank, 1); assert.strictEqual(by.p1.exp, 70); assert.strictEqual(by.p1.points, 10);
    assert.strictEqual(by.p3.exp, 0, 'bye-only = no-show');
    assert.strictEqual(by.p4.exp, 0);
    assert.strictEqual(by.p2.exp, 40); // rank3? check below
});

test('custom reward config per tournament', () => {
    const cfg = { points: { ranks: [20, 10, 5, 2], base_top: 2, expand_min_players: 6, expand_top: 4 }, exp: { ranks: [100, 50], join: 5, full_play: 0 } };
    assert.deepStrictEqual([1, 2, 3, 4, 5].map(r => E.calcPoints(r, 5, cfg)), [20, 10, 0, 0, 0]);
    assert.deepStrictEqual([1, 2, 3, 4, 5].map(r => E.calcPoints(r, 6, cfg)), [20, 10, 5, 2, 0]);
    assert.deepStrictEqual([1, 2, 3].map(r => E.calcExp(r, true, cfg)), [105, 55, 5]);
    // ไม่ขยายโควตา
    const noExpand = { ...cfg, points: { ...cfg.points, expand_min_players: 0 } };
    assert.strictEqual(E.pointsQuota(100, noExpand), 2);
    // null = เกณฑ์มาตรฐาน
    assert.deepStrictEqual(E.normalizeRewards(null), JSON.parse(JSON.stringify(E.DEFAULT_REWARDS)));
    assert.match(E.describePoints(null), /Top 3.*แชมป์ \*\*10\*\*/);
    assert.match(E.describePoints(null), /ครบ \*\*10 คน\*\* ขยายเป็น \*\*Top 5\*\*/);
});

test('rewardsPreview respects give_points / give_exp', () => {
    const { players, matches } = playSwiss(8, 3);
    const on = E.rewardsPreview({ format: 'swiss', swiss_rounds: 3 }, players, matches);
    assert.ok(on.some(r => r.points > 0) && on.some(r => r.exp > 0));
    const off = E.rewardsPreview({ format: 'swiss', swiss_rounds: 3, give_points: false, give_exp: false }, players, matches);
    assert.ok(off.every(r => r.points === 0 && r.exp === 0));
});
