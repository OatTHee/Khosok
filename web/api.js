// =========================================================
// 🌐 API สำหรับเว็บจัดทัวร์
// login ด้วยบัญชี Supabase เดียวกับเว็บ DMT Shop
// สิทธิ์: แอดมินร้าน = ทุกอย่าง + แต่งตั้งสตาฟ · สตาฟ (Discord ID ใน tournament_staff) = จัดการทัวร์
// =========================================================
'use strict';
const path = require('path');
const express = require('express');
const S = require('../tournament/service');

// publishable key ของโปรเจกต์ DMT Shop — เป็นคีย์ฝั่งหน้าเว็บ เปิดเผยได้ (สิทธิ์ถูกคุมด้วย RLS)
// เปลี่ยนได้ด้วย env SUPABASE_PUBLISHABLE_KEY
const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_mwPhY8NkaiB7H1ppaavysA_5jKVAgFl';

const tokenCache = new Map(); // token -> { user, until }

// ผ่านได้ถ้าเป็นแอดมินร้าน หรือสตาฟที่ถูกแต่งตั้ง (ดู tournament/service.js → resolveRole)
async function requireStaff(req, res, next) {
    try {
        const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
        if (!m) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
        const token = m[1];

        const hit = tokenCache.get(token);
        if (hit && hit.until > Date.now()) { req.user = hit.user; return next(); }

        const { data, error } = await S.db().auth.getUser(token);
        if (error || !data?.user) return res.status(401).json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });

        const { role, discordIds } = await S.resolveRole(data.user);
        if (!role) {
            return res.status(403).json({
                error: discordIds.length
                    ? 'บัญชีนี้ยังไม่ได้รับสิทธิ์จัดทัวร์ — ให้แอดมินเพิ่ม Discord ID ของคุณเป็นสตาฟก่อน'
                    : 'บัญชีนี้ยังไม่ได้ผูก Discord — ออกจากระบบแล้วเข้าใหม่ด้วยปุ่ม "เข้าสู่ระบบด้วย Discord"',
                discordIds,
            });
        }

        const meta = data.user.user_metadata || {};
        const user = { id: data.user.id, email: data.user.email, name: meta.full_name || meta.name || data.user.email, role, discordIds };
        tokenCache.set(token, { user, until: Date.now() + 30_000 });
        if (tokenCache.size > 500) for (const [k, v] of tokenCache) if (v.until < Date.now()) tokenCache.delete(k);
        req.user = user;
        next();
    } catch (err) { next(err); }
}

function adminOnly(req, res, next) {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'เฉพาะแอดมินร้านเท่านั้นที่จัดการสตาฟได้' });
    next();
}

const actorOf = req => ({ id: req.user?.id || null, name: req.user?.name || req.user?.email || null });

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).then(data => res.json(data ?? { ok: true })).catch(next);

function buildRouter() {
    const r = express.Router();
    r.use(express.json({ limit: '100kb' }));

    // ค่าที่หน้าเว็บต้องใช้ login (publishable/anon key เปิดเผยได้ ไม่ใช่ความลับ)
    r.get('/config', (req, res) => {
        res.json({
            supabaseUrl: process.env.SUPABASE_URL || null,
            supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY || DEFAULT_PUBLISHABLE_KEY,
        });
    });

    r.use(requireStaff);
    r.get('/me', (req, res) => res.json(req.user));

    // 🛡️ จัดการสตาฟ (แอดมินร้านเท่านั้น)
    r.get('/staff', adminOnly, wrap(() => S.listStaff()));
    r.post('/staff', adminOnly, wrap(req => S.addStaff(req.body?.discord_id, req.body?.note, req.user.id)));
    r.delete('/staff/:discordId', adminOnly, wrap(async req => {
        const out = await S.removeStaff(req.params.discordId);
        // เตะเซสชันที่แคชไว้ทิ้ง ให้สิทธิ์หายทันที
        for (const [k, v] of tokenCache) if (v.user.discordIds?.includes(out.discord_id) && v.user.role !== 'admin') tokenCache.delete(k);
        return out;
    }));

    r.get('/tournaments', wrap(() => S.listTournaments()));
    r.post('/tournaments', wrap(req => S.createTournament(req.body || {}, req.user.id)));
    r.get('/tournaments/:id', wrap(req => S.view(req.params.id)));
    r.patch('/tournaments/:id', wrap(req => S.updateTournament(req.params.id, req.body || {})));
    r.post('/tournaments/:id/cancel', wrap(req => S.cancelTournament(req.params.id)));

    r.get('/accounts', wrap(req => S.searchAccounts(req.query.q)));
    r.post('/tournaments/:id/players', wrap(req => S.addPlayer(req.params.id, req.body || {})));
    r.delete('/tournaments/:id/players/:pid', wrap(req => S.removePlayer(req.params.id, req.params.pid)));
    r.post('/tournaments/:id/players/:pid/drop', wrap(req => S.setDropped(req.params.id, req.params.pid, req.body?.dropped !== false)));
    r.post('/tournaments/:id/players/:pid/rename', wrap(req => S.renamePlayer(req.params.id, req.params.pid, req.body?.name)));

    r.post('/tournaments/:id/start', wrap(req => S.startTournament(req.params.id)));
    r.post('/tournaments/:id/next-round', wrap(req => S.nextRound(req.params.id)));
    r.post('/matches/:mid/result', wrap(req => S.reportResult(req.params.mid, req.body || {}, actorOf(req))));
    r.post('/matches/:mid/clear', wrap(req => S.clearResult(req.params.mid, req.body || {}, actorOf(req))));

    // ↩️ แก้ย้อนหลัง (สตาฟทำได้ทุกอย่าง · ทุกครั้งบันทึกลง tournament_audit)
    r.post('/tournaments/:id/rollback', wrap(req => S.rollbackRound(req.params.id, req.body?.round, req.body || {}, actorOf(req))));
    r.post('/tournaments/:id/reopen', wrap(req => S.reopenTournament(req.params.id, req.body || {}, actorOf(req))));
    r.post('/tournaments/:id/reset', wrap(req => S.resetTournament(req.params.id, req.body || {}, actorOf(req))));
    r.get('/tournaments/:id/audit', wrap(req => S.listAudit(req.params.id)));

    r.post('/tournaments/:id/timer', wrap(req => S.startTimer(req.params.id, req.body?.minutes)));
    r.delete('/tournaments/:id/timer', wrap(req => S.stopTimer(req.params.id)));

    r.post('/tournaments/:id/award-points', wrap(req => S.awardPoints(req.params.id)));
    r.post('/tournaments/:id/award-exp', wrap(req => S.awardExp(req.params.id, { playedAllIds: req.body?.playedAllIds })));
    r.post('/tournaments/:id/finish', wrap(req => S.finish(req.params.id)));

    // eslint-disable-next-line no-unused-vars
    r.use((err, req, res, next) => {
        if (err instanceof S.ServiceError) return res.status(err.status || 400).json({ error: err.message });
        if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' });
        console.error('[web api]', err?.message || err);
        res.status(500).json({ error: 'เซิร์ฟเวอร์ผิดพลาด ลองใหม่อีกครั้ง' });
    });
    return r;
}

function mountWeb(app) {
    app.use('/api', buildRouter());
    app.get('/vendor/supabase.js', (req, res) => res.sendFile(require.resolve('@supabase/supabase-js/dist/umd/supabase.js')));
    app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '5m' }));
}

module.exports = { mountWeb };
