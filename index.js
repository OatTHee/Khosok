require('dotenv').config(); // อ่านค่าจากไฟล์ .env (บน Render ตั้งใน Environment แทน)

const express = require('express');
const app = express();
app.set('trust proxy', 1);
app.get('/health', (req, res) => res.send('Khosok is Online! 🟢'));
// 🌐 เว็บจัดทัวร์ + API อยู่ในเซิร์ฟเวอร์เดียวกับบอท (ดู web/api.js)
require('./web/api').mountWeb(app);
app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.log('เซิร์ฟเวอร์เริ่มทำงานแล้ว (เว็บจัดทัวร์ + บอท)');
});

const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const axios = require('axios');
axios.defaults.timeout = 8000; // ตัดจบถ้านานเกิน 8 วินาที
const T = require('./tournament/service'); // 🏟️ ระบบทัวร์นาเมนต์ของเราเอง (แทน Challonge)
const TE = require('./tournament/engine');
const activePolls = new Map();
const pendingFinish = new Map(); // เก็บสถานะ "ติ๊กคนเล่นครบทุกรอบ" ก่อนกดยืนยันปิดจ็อบ
const COMPETITOR_ROLE_ID = '1476156740738486457';


// =========================================================
// 🔐 กันคีย์หลุดใน log
// 1) ปิด error ของ axios ให้เหลือแค่ข้อมูลที่จำเป็น (ตัด config/params/headers ที่มี api_key, apikey, Bearer, x-bot-secret ทิ้ง)
// 2) ครอบ console.* ให้เซ็นเซอร์ค่าลับทุกตัวอีกชั้น เผื่อหลุดมาจากที่อื่น
// =========================================================
const util = require('util');
const SECRET_VALUES = [
    process.env.DISCORD_TOKEN,
    process.env.SUPABASE_SERVICE_KEY,
    process.env.BOT_BRIDGE_SECRET,
    process.env.BOT_BRIDGE_URL,
].filter(v => typeof v === 'string' && v.trim().length >= 8).map(v => v.trim());

function redact(text) {
    if (typeof text !== 'string') return text;
    let out = text;
    for (const secret of SECRET_VALUES) out = out.split(secret).join('***');
    return out
        .replace(/(api_key=)[^&\s'"]+/gi, '$1***')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]+/g, '$1***')
        .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '***JWT***')
        .replace(/sb_secret_[A-Za-z0-9_-]+/g, 'sb_secret_***');
}

function toSafeHttpError(err) {
    if (!axios.isAxiosError(err)) return err;
    const cfg = err.config || {};
    const safe = new Error(redact(err.message));
    safe.name = 'HttpError';
    safe.isAxiosError = true;
    safe.code = err.code;
    safe.method = (cfg.method || '').toUpperCase();
    safe.url = redact(String(cfg.url || '').split('?')[0]); // ไม่เอา query string
    if (err.response) {
        safe.response = {
            status: err.response.status,
            statusText: err.response.statusText,
            headers: err.response.headers,
            data: err.response.data,
        };
    }
    safe.stack = `${safe.name}: ${safe.message} [${safe.method} ${safe.url}${safe.response ? ' → HTTP ' + safe.response.status : ''}]`;
    return safe;
}
axios.interceptors.response.use(res => res, err => Promise.reject(toSafeHttpError(err)));

for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => original(redact(util.format(...args)));
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// 🟢 Supabase (ฐานข้อมูลใหม่ แทน Google Sheet)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// เช็กว่าตั้งค่า Supabase ครบและเป็นคีย์จริง (ไม่ใช่ข้อความตัวอย่าง) — คืน true ถ้าพร้อมใช้งาน
function checkSupabaseEnv(label = 'Supabase') {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        console.error(`❌ [${label}] ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_SERVICE_KEY ใน .env`);
        return false;
    }
    // service_role key ของจริงจะขึ้นต้นด้วย "eyJ" (JWT) หรือ "sb_secret_"
    if (!/^(eyJ|sb_secret_)/.test(SUPABASE_SERVICE_KEY)) {
        console.error(`❌ [${label}] SUPABASE_SERVICE_KEY ยังเป็นข้อความตัวอย่าง ไม่ใช่คีย์จริง`);
        console.error(`   → ไปที่ Supabase Dashboard > Project Settings > API Keys แล้วคัดลอกคีย์ service_role มาวางใน .env`);
        return false;
    }
    return true;
}

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

// =========================================================
// 🏅 ฟังก์ชันแปลง EXP เป็นฉายา (แก้ที่นี่จุดเดียว เปลี่ยนทั้งระบบ)
// =========================================================
function getTitleByExp(exp) {
    if (exp >= 400) return "🦖 เจ้าแห่งเมโซโซอิก";
    if (exp >= 350) return "🐦‍🔥 รีคอลปีศาจ";
    if (exp >= 300) return "⚜️ รีคอลระดับเทพ";
    if (exp >= 260) return "👑 รีคอลระดับราชา";
    if (exp >= 240) return "🔱 รีคอลระดับตำนาน";
    if (exp >= 165) return "⚔️ รีคอลยอดฝีมือ I";
    if (exp >= 150) return "⚔️ รีคอลยอดฝีมือ II";
    if (exp >= 130) return "🌿 รีคอลขั้นสูง I";
    if (exp >= 115) return "🌿 รีคอลขั้นสูง II";
    if (exp >= 100) return "🌿 รีคอลขั้นสูง III"; 
    if (exp >= 80) return "🦴 รีคอลมากประสบการณ์ I";
    if (exp >= 65) return "🦴 รีคอลมากประสบการณ์ II";
    if (exp >= 50) return "🦴 รีคอลมากประสบการณ์ III";
    if (exp >= 35) return "🐣 รีคอลฝึกหัด I";
    if (exp >= 20) return "🐣 รีคอลฝึกหัด II";
    if (exp >= 10) return "🐣 รีคอลฝึกหัด III";
    return "🥚 รีคอลหน้าใหม่";
}

// =========================================================
// 📐 เกณฑ์ EXP (ตัวจริงอยู่ที่ tournament/engine.js ที่เดียว)
// =========================================================
const EXP_JOIN = TE.EXP_JOIN;
const EXP_FULL_PLAY = TE.EXP_FULL_PLAY;
const getPlacementExp = TE.placementExp;
const calcTournamentExp = TE.calcExp;

// =========================================================
// 🗳️ สร้างหน้าจอติ๊ก "ใครเล่นครบทุกรอบ" ก่อนแจก EXP
// state.players = [{ id, label }] (id = player id ในระบบทัวร์)
// =========================================================
function buildFullPlayComponents(code, state) {
    const rows = [];

    state.chunks.forEach((chunk, chunkIndex) => {
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`fullplay_${code}_${chunkIndex}`)
            .setPlaceholder(`✅ ติ๊กคนที่เล่นครบทุกรอบ (ชุดที่ ${chunkIndex + 1})`)
            .setMinValues(0)
            .setMaxValues(chunk.length)
            .addOptions(
                chunk.map(p =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(p.label.substring(0, 100))
                        .setValue(p.id)
                        .setDefault(state.full.has(p.id))
                )
            );
        rows.push(new ActionRowBuilder().addComponents(menu));
    });

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`fullall_${code}`).setLabel('ทุกคนเล่นครบ').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId(`fullconfirm_${code}`).setLabel('ยืนยัน & ปิดจ็อบ').setStyle(ButtonStyle.Danger).setEmoji('🏁'),
        new ButtonBuilder().setCustomId(`fullcancel_${code}`).setLabel('ยกเลิก').setStyle(ButtonStyle.Secondary).setEmoji('✖️')
    ));

    return rows;
}

function buildFullPlayText(state) {
    let text = `📝 **ให้คะแนนพฤติกรรมก่อนแจก EXP — ${state.tournamentName}**\n`;
    text += `ติ๊กเฉพาะคนที่ **อยู่เล่นครบทุกรอบ** (ค่าเริ่มต้นติ๊กไว้ให้ทุกคนที่ไม่ได้ถอนตัว ถ้าใครกลับก่อน/ไม่ครบ ให้เอาติ๊กออก)\n\n`;

    state.players.forEach(p => {
        const full = state.full.has(p.id);
        const exp = calcTournamentExp(p.rank, full);
        text += `${full ? '☑️' : '⬜'} ${p.rank}. ${p.mention} → **${exp} EXP**${p.linked ? '' : ' *(walk-in ไม่ได้รับ)*'}\n`;
    });

    if (state.noShow.length > 0) {
        text += `\n🚫 **ไม่ได้ลงแข่งเลย (ไม่ได้ EXP):** ${state.noShow.join(', ')}\n`;
    }

    text += `\n> อันดับ 1 +50 | อันดับ 2-3 +30 | อันดับ 4-5 +20 | เข้าร่วม +10 | เล่นครบทุกรอบ +10`;
    return text.substring(0, 1900);
}

// =========================================================
// โซนฟังก์ชันตัวช่วย (Helper Functions) — อ่านจากระบบทัวร์ของเราเอง
// =========================================================
const mentionOf = p => (p.discord_id ? `<@${p.discord_id}>` : `**${p.display_name}**`);
const thTime = iso => new Date(iso).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }).replace(':', '.');

// 1. บอร์ดรับสมัคร (โชว์จำนวนคน + ข้อความเชิญชวน)
function buildSetupEmbed(v) {
    const t = v.tournament;
    const count = v.players.length;
    const startTimeText = t.start_at ? `งานเริ่มเวลา ${thTime(t.start_at)} น.` : 'ยังไม่กำหนดเวลาเริ่ม';

    if (t.status !== 'registration') {
        return new EmbedBuilder()
            .setTitle(`ปิดรับสมัครแล้ว: ${t.name}`)
            .setDescription(`👤 ผู้เข้าแข่งขันทั้งหมด **${count}** คน\n${t.status === 'running' ? '⚔️ การแข่งขันเริ่มแล้ว ดูคู่ของคุณในโพสต์ถัดไป' : t.status === 'finished' ? '🏁 งานนี้จบแล้ว' : '❌ งานนี้ถูกยกเลิก'}`)
            .setColor(0x808080)
            .setFooter({ text: `งาน #${t.code}` });
    }

    const names = v.players.slice(0, 40).map((p, i) => `${i + 1}. ${p.display_name}`).join('\n');
    return new EmbedBuilder()
        .setTitle(`เปิดรับสมัคร: ${t.name}`)
        .setDescription(`# ${startTimeText}\n\n📊 **จำนวนผู้สมัครปัจจุบัน:**\n# 👤 ${count} คน\n\n🔥 **เป้าหมายพิเศษ:**\nหากมีผู้เข้าแข่งขันถึง **10 คน** ระบบจะขยายโควต้าแจกรางวัลให้สูงสุดถึง **Top 5!** มาร่วมสนุกกันเยอะๆ นะครับ!\n\nกดปุ่มด้านล่างเพื่อสมัคร หรือสละสิทธิ์\n(เฉพาะแอดมินเท่านั้นที่กดปุ่มเริ่มแข่งได้)${names ? `\n\n**รายชื่อ**\n${names}` : ''}`.substring(0, 4000))
        .setColor(0x00FF00)
        .setFooter({ text: `งาน #${t.code} • ${t.format === 'single_elim' ? 'แพ้คัดออก' : 'Swiss'}` });
}

function setupButtons(code) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`register_${code}`).setLabel('สมัครแข่ง').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`leave_${code}`).setLabel('สละสิทธิ์').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`start_${code}`).setLabel('ปิดรับสมัคร & เริ่มแข่ง').setStyle(ButtonStyle.Primary)
    );
}

// 2. สถานะรอบปัจจุบัน (คู่ + คนได้บาย + จับเวลา)
function buildCurrentEmbed(v) {
    const t = v.tournament;
    const name = Object.fromEntries(v.players.map(p => [p.id, p]));
    const who = id => (name[id] ? name[id].display_name : '*[รอผู้ชนะ]*');
    let text = '';

    if (t.round_ends_at) {
        const unix = Math.floor(new Date(t.round_ends_at).getTime() / 1000);
        text += `**หมดเวลาแข่งขัน:** ${thTime(t.round_ends_at)} น. ( <t:${unix}:R> )\n\n`;
    } else if (t.status === 'running') {
        text += `**หมดเวลาแข่งขัน:** 🕒 *ยังไม่เริ่มจับเวลา (รอแอดมินกดปุ่ม)*\n\n`;
    }

    const round = v.currentRound;
    const rm = v.matches.filter(m => m.round === round).sort((a, b) => a.slot - b.slot);
    const real = rm.filter(m => !m.is_bye);
    const byes = rm.filter(m => m.is_bye);

    const label = t.format === 'single_elim'
        ? (round === v.totalRounds ? 'รอบชิงชนะเลิศ' : round === v.totalRounds - 1 ? 'รอบรองชนะเลิศ' : `รอบที่ ${round}`)
        : `รอบที่ ${round} / ${v.totalRounds}`;
    text += `**--- ${label} ---**\n`;
    if (real.length === 0) text += `ไม่มีแมตช์ในรอบนี้\n`;

    let table = 1;
    real.forEach(m => {
        const p1 = who(m.player1_id), p2 = who(m.player2_id);
        const score = m.score1 !== null && m.score2 !== null ? ` (${m.score1}-${m.score2})` : '';
        if (m.status === 'complete') {
            text += `**โต๊ะ ${table++}** | ✅ ~~${p1} vs ${p2}~~ 🏆 **${who(m.winner_id)}** ชนะ${score}\n\n`;
        } else if (m.status === 'open') {
            text += `**โต๊ะ ${table++}** | ⚔️ **${p1}** VS **${p2}**\n\n`;
        } else {
            text += `**โต๊ะ ${table++}** | 🕒 ${p1} VS ${p2} *(รอคู่แข่ง)*\n\n`;
        }
    });

    if (byes.length > 0) {
        text += `**--- ผู้เล่นที่ได้สิทธิ์ชนะบาย ---**\n🎉 ${byes.map(m => `**${who(m.player1_id || m.player2_id)}**`).join(', ')}\n\n`;
    }
    if (t.status === 'finished') text += `🏁 **งานนี้จบแล้ว** พิมพ์ \`!standing ${t.code}\` เพื่อดูอันดับ`;

    return new EmbedBuilder()
        .setTitle(`🏆 สถานะการจับคู่ปัจจุบัน: ${t.name}`)
        .setDescription(text.substring(0, 4000) || 'ยังไม่มีข้อมูลการประกบคู่ครับ')
        .setColor(0x00FFFF)
        .setFooter({ text: `งาน #${t.code} • อัปเดตอัตโนมัติเมื่อกรอกผลจากเว็บ` })
        .setTimestamp();
}

function currentButtons(v) {
    const t = v.tournament;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`timer_${t.code}`).setLabel(`เริ่มจับเวลา ${t.round_minutes} นาที`).setStyle(ButtonStyle.Primary).setEmoji('⏱️'),
        new ButtonBuilder().setCustomId(`update_${t.code}`).setLabel('อัปเดตผลล่าสุด').setStyle(ButtonStyle.Secondary).setEmoji('🔄')
    );
}

// 3. ตารางคะแนน
function buildStandingEmbed(v) {
    const t = v.tournament;
    const done = t.status === 'finished';
    let text = `ผู้เข้าร่วมทั้งหมด: **${v.players.length}** คน (โควตาแจกแต้ม: **Top ${v.pointsQuota}**)\n`;
    text += done ? `**🏁 ทัวร์นาเมนต์นี้จบการแข่งขันแล้ว 🏁**\n\n` : `รอบ ${v.currentRound} / ${v.totalRounds}\n\n`;

    v.standings.forEach(s => {
        const reward = s.points ? `🎁 *(${s.points} แต้ม)*` : '';
        const tag = s.forfeit ? ' *(ถอนตัว)*' : '';
        const line = `${s.name}${tag} (ชนะ ${s.wins} แพ้ ${s.losses})`;
        if (s.rank === 1) text += `🥇 **อันดับ 1 : ${line}** ${reward}\n`;
        else if (s.rank === 2) text += `🥈 **อันดับ 2 : ${line}** ${reward}\n`;
        else if (s.rank === 3) text += `🥉 **อันดับ 3 : ${line}** ${reward}\n`;
        else text += `🔹 อันดับ ${s.rank} : ${line} ${reward}\n`;
    });

    return new EmbedBuilder()
        .setTitle(done ? `📊 สรุปตารางคะแนน (ปิดจ็อบแล้ว)` : `📊 สรุปตารางคะแนนล่าสุด`)
        .setDescription(text.substring(0, 4000))
        .setColor(done ? 0x00FF00 : 0xFFD700)
        .setFooter({ text: `${t.name} • งาน #${t.code}` });
}

// ข้อความ error ที่อ่านรู้เรื่อง (ServiceError เป็นภาษาไทยอยู่แล้ว)
function errText(error) {
    if (error instanceof T.ServiceError) return error.message;
    console.error('[tournament]', error?.message || error);
    return 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง';
}

// ---------------------------------------------------------
// 🔔 อัปเดตบอร์ดใน Discord อัตโนมัติ เมื่อมีการเปลี่ยนแปลง (จากเว็บหรือจากปุ่มในบอท)
// ---------------------------------------------------------
async function fetchBoardChannel(t) {
    if (!t.discord_channel_id || !client.isReady()) return null;
    return client.channels.fetch(t.discord_channel_id).catch(() => null);
}

async function refreshSetupBoard(t) {
    const channel = await fetchBoardChannel(t);
    if (!channel || !t.setup_message_id) return;
    const v = await T.view(t.id);
    const msg = await channel.messages.fetch(t.setup_message_id).catch(() => null);
    if (!msg) return;
    await msg.edit({ embeds: [buildSetupEmbed(v)], components: v.tournament.status === 'registration' ? [setupButtons(t.code)] : [] }).catch(() => {});
}

async function refreshCurrentBoard(t) {
    const channel = await fetchBoardChannel(t);
    if (!channel || !t.current_message_id) return;
    const v = await T.view(t.id);
    const msg = await channel.messages.fetch(t.current_message_id).catch(() => null);
    if (!msg) return;
    await msg.edit({ embeds: [buildCurrentEmbed(v)], components: v.tournament.status === 'running' ? [currentButtons(v)] : [] }).catch(() => {});
}

async function postCurrentBoard(channel, idOrCode) {
    const v = await T.view(idOrCode);
    const msg = await channel.send({ content: `อัปเดตสถานะการแข่งขันล่าสุด 📢`, embeds: [buildCurrentEmbed(v)], components: [currentButtons(v)] });
    await T.setDiscordRefs(v.tournament.id, { discord_channel_id: channel.id, current_message_id: msg.id });
    return msg;
}

const safeAsync = fn => (...args) => Promise.resolve(fn(...args)).catch(e => console.error('[discord sync]', e?.message || e));
T.events.on('players', safeAsync(async t => { const fresh = await T.getTournament(t.id); await refreshSetupBoard(fresh); }));
T.events.on('tournament', safeAsync(async t => { await refreshSetupBoard(t); }));
T.events.on('round', safeAsync(async (t, round) => {
    const fresh = await T.getTournament(t.id);
    if (round === 1) await refreshSetupBoard(fresh);
    const channel = await fetchBoardChannel(fresh);
    if (channel) await postCurrentBoard(channel, fresh.id);
}));
T.events.on('match', safeAsync(async t => { await refreshCurrentBoard(await T.getTournament(t.id)); }));
T.events.on('timer', safeAsync(async t => { await refreshCurrentBoard(t); }));
T.events.on('finished', safeAsync(async t => {
    const fresh = await T.getTournament(t.id);
    await refreshCurrentBoard(fresh);
    // เคลียร์ยศนักแข่งหลังจบงาน
    const channel = await fetchBoardChannel(fresh);
    const guild = channel?.guild;
    if (!guild) return;
    await guild.members.fetch().catch(() => {});
    const role = guild.roles.cache.get(COMPETITOR_ROLE_ID);
    if (role) for (const [, member] of role.members) await member.roles.remove(COMPETITOR_ROLE_ID).catch(() => {});
}));


// ประกาศตัวแปรเก็บข้อความ Leaderboard เพื่อใช้อัปเดตอัตโนมัติ
let activeLeaderboardMessage = null;
let leaderboardInterval = null;

// 3. ฟังก์ชันสร้างบอร์ดจัดอันดับ (Leaderboard)
async function getLeaderboardEmbed() {
    try {
        if (!checkSupabaseEnv('Leaderboard')) return null;

        // 📌 ดึงอันดับจากตาราง customers ใน Supabase (PostgREST) โดยตรง
        const res = await axios.get(`${SUPABASE_URL}/rest/v1/customers`, {
            params: {
                select: 'discord_id,display_name,exp',
                exp: 'gt.0',
                discord_id: 'not.is.null',
                order: 'exp.desc',
                limit: 20
            },
            headers: {
                apikey: SUPABASE_SERVICE_KEY,
                Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
            }
        });

        // แปลงรูปแบบข้อมูลให้เหมือนของเดิม (discordId / exp) เพื่อไม่ต้องแก้โค้ดส่วนแสดงผล
        const players = (res.data || []).map(row => ({
            discordId: row.discord_id,
            name: row.display_name,
            exp: row.exp || 0
        }));

        if (!players || players.length === 0) {
            return new EmbedBuilder()
                .setTitle('🏆 Dinomaster Season Ranking')
                .setDescription('ยังไม่มีผู้เล่นที่มี EXP ในซีซั่นนี้ครับ มาเริ่มสะสมกันเถอะ!')
                .setColor(0x00FF00); // สีเขียว
        }

        let boardText = '';
        players.forEach((p, index) => {
            let exp = p.exp;
            // 🎯 เรียกใช้ฟังก์ชันฉายาจากที่ตั้งไว้จุดเดียว
            let title = getTitleByExp(exp);

            let rank = index + 1;
            let medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `**${rank}.**`;
            
            boardText += `${medal} <@${p.discordId}> | ${title} (✨ ${exp} EXP)\n`;
        });

        return new EmbedBuilder()
            .setTitle('🏆 Dinomaster Season Ranking (Top 20)')
            .setDescription(boardText)
            .setColor(0xFFD700) // สีทอง
            .setFooter({ text: 'อัปเดตข้อมูลอัตโนมัติทุก 15 นาที • กดปุ่มเพื่อรีเฟรชทันที' })
            .setTimestamp();

    } catch (error) {
        // แสดง log ให้รู้ว่าพังเพราะอะไร จะได้แก้ถูกจุด
        if (error.response) {
            console.error(`Leaderboard Error: HTTP ${error.response.status}`, error.response.data);
            if (error.response.status === 401) {
                console.error('   → คีย์ไม่ถูกต้อง/หมดอายุ ต้องใช้ service_role key เท่านั้น (anon key จะโดน RLS บล็อก)');
            }
        } else {
            console.error("Leaderboard Error:", error.message);
        }
        return null;
    }
}


// =========================================================
// โซนรับคำสั่งจากการพิมพ์ (Message Commands)
// =========================================================
client.on('messageCreate', async message => {
    // ดักไว้แค่ว่าต้องเป็นข้อความจากคนในเซิร์ฟเวอร์ และไม่ใช่บอทพิมพ์เอง
    if (!message.member || message.author.bot) return; 

    const args = message.content.split(' ');
    const command = args[0];
    const tournamentId = args[1];

    // 🔒 ระบบป้องกัน: เช็กสิทธิ์เฉพาะคำสั่งของแอดมิน
    const adminCommands = ['!help', '!setup', '!current', '!standing', '!rank'];
    if (adminCommands.includes(command)) {
        if (!message.member.permissions.has('ManageMessages')) {
            // ถ้าไม่ใช่แอดมินพิมพ์คำสั่งพวกนี้ ให้บอทเงียบและเมินไปเลย
            return; 
        }
    }

    if (command === '!help') {
        const helpEmbed = new EmbedBuilder()
            .setTitle('🛠️ คู่มือแอดมิน: จัดแข่ง Dinomaster')
            .setColor(0x0099FF)
            .addFields(
                { name: ' 🌐 เว็บจัดทัวร์', value: `สร้างงาน / กรอกผล / จับคู่รอบถัดไป ที่ ${process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'เว็บของบอท (ลิงก์ Render)'}` },
                { name: ' เปิดรับสมัคร', value: 'พิมพ์ `!setup <เลขงาน>` เช่น `!setup 12`' },
                { name: ' โชว์คู่รอบปัจจุบัน + จับเวลา', value: 'พิมพ์ `!current <เลขงาน>`\n*(จับคู่รอบใหม่จากเว็บ บอทจะโพสต์ให้เอง)*' },
                { name: ' โชว์อันดับงานแข่ง', value: 'พิมพ์ `!standing <เลขงาน>`' },
                { name: ' เปิดโพลล์ทายแชมป์', value: 'พิมพ์ `!pollchamp <เลขงาน>`' },
                { name: ' เปิด Leaderboard เซิฟ', value: 'พิมพ์ `!dmtrank`' },
                { name: ' โชว์โปรไฟล์ตัวเอง', value: 'พิมพ์ `!dmtprof`' },
            )
            .setFooter({ text: 'คำสั่งถูกซ่อนอัตโนมัติเพื่อความสะอาดของช่อง' });
        
        await message.channel.send({ embeds: [helpEmbed] });
        setTimeout(() => message.delete().catch(() => {}), 1000);
        return;
    }

    if (command === '!setup') {
        if (!tournamentId) return message.reply('กรุณาระบุเลขงานด้วยครับ เช่น `!setup 12` (ดูเลขงานได้ที่เว็บจัดทัวร์)');

        try {
            const v = await T.view(tournamentId);
            if (v.tournament.status !== 'registration') {
                return message.reply(`⚠️ งาน #${v.tournament.code} ไม่ได้อยู่ในช่วงรับสมัครแล้ว (ใช้ \`!current ${v.tournament.code}\` เพื่อดูคู่)`);
            }
            const sent = await message.channel.send({ embeds: [buildSetupEmbed(v)], components: [setupButtons(v.tournament.code)] });
            await T.setDiscordRefs(v.tournament.id, { discord_channel_id: message.channel.id, setup_message_id: sent.id });
            setTimeout(() => message.delete().catch(() => {}), 1000);
        } catch (error) {
            message.channel.send(`❌ ${errText(error)}`);
        }
    }

    if (command === '!current') {
        if (!tournamentId) return message.reply('⚠️ ฟอร์แมตผิดครับ ใช้: `!current <เลขงาน>`');
        try {
            const t = await T.getTournament(tournamentId);
            if (t.status === 'registration') return message.reply('⚠️ งานนี้ยังไม่เริ่มแข่งครับ');
            await postCurrentBoard(message.channel, t.id);
            setTimeout(() => message.delete().catch(() => {}), 1000);
        } catch (error) {
            message.channel.send(`❌ ${errText(error)}`);
        }
    }

    if (command === '!standing') {
        if (!tournamentId) return message.reply('⚠️ ใส่เลขงานด้วยครับ เช่น `!standing 12`');

        try {
            const v = await T.view(tournamentId);
            const t = v.tournament;
            if (!v.matches.length) return message.reply('⚠️ งานนี้ยังไม่เริ่มแข่งครับ');

            const embed = buildStandingEmbed(v);
            if (t.status === 'running') {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`reward_${t.code}`)
                        .setLabel(t.points_awarded_at ? 'แจกแต้มไปแล้ว' : `แจกแต้มให้ Top ${v.pointsQuota}`)
                        .setStyle(ButtonStyle.Success).setEmoji('💸')
                        .setDisabled(!!t.points_awarded_at),
                    new ButtonBuilder()
                        .setCustomId(`finish_${t.code}`)
                        .setLabel('ปิดจ็อบ & บันทึกประวัติ')
                        .setStyle(ButtonStyle.Danger).setEmoji('🏁')
                );
                await message.channel.send({ embeds: [embed], components: [row] });
            } else {
                await message.channel.send({ embeds: [embed] });
            }
            setTimeout(() => message.delete().catch(() => {}), 1000);
        } catch (error) {
            await message.channel.send(`❌ ${errText(error)}`).catch(() => {});
        }
    }


// ---------------------------------------------------------
    // 📜 คำสั่งใหม่: !dmtprof (โชว์โปรไฟล์ไดโนมาสเตอร์สุดเท่)
    // ---------------------------------------------------------
    if (command === '!dmtprof') {
        // ถ้ามีการแท็กเพื่อน ให้ดูโปรไฟล์เพื่อน ถ้าไม่แท็ก ให้ดูของตัวเอง
        const targetUser = message.mentions.users.first() || message.author;
        // 📌 ใส่ลิงก์ Web App URL ของคุณที่นี่ (อันเดิมกับที่ใช้ในปุ่ม reward)
        const GAS_WEB_APP_URL = process.env.BOT_BRIDGE_URL; 

        const loadingMsg = await message.reply('🔄 กำลังเชื่อมต่อฐานข้อมูลไดโนมาสเตอร์... กรุณารอสักครู่');

        try {
            // 🎯 เปลี่ยนเป็น POST เพื่อไม่ให้ชนกับระบบหน้าเว็บ
            const res = await axios.post(GAS_WEB_APP_URL, {
                action: "get_profile",
                discordId: targetUser.id
            }, { headers: { 'x-bot-secret': process.env.BOT_BRIDGE_SECRET } });
            const data = res.data;

            loadingMsg.delete().catch(() => {});

            // ดักจับกรณีส่งข้อมูลพลาดหรือฝั่ง Sheet ฟ้อง Error
            if (data.success === false) {
                return message.reply(`❌ **ระบบขัดข้อง:** ${data.error}`);
            }

            if (!data.found) {
                return message.reply(`❌ **ไม่พบข้อมูลในระบบ!**\nผู้ใช้ ${targetUser.username} อาจจะยังไม่ได้สมัครสมาชิกเว็บแอป หรือยังไม่ได้เชื่อมต่อ Discord ID ครับ`);
            }

            // 🎯 เรียกดึงฉายาจากฟังก์ชันกลาง
            let title = getTitleByExp(data.exp);

            const top5Rate = data.duels > 0 ? ((data.top5 / data.duels) * 100).toFixed(0) + '%' : 'N/A';

            // --------------------------------------------------

            const profileEmbed = new EmbedBuilder()
                .setTitle(`📜 Dinomaster DBWC Profile`)
                .setAuthor({ name: targetUser.username, iconURL: targetUser.displayAvatarURL({ dynamic: true }) })
                .setDescription(`**ฉายา:** ${title}\n**EXP ซีซั่น:** ✨ ${data.exp} EXP\n\n**UID:** \`${data.uid}\` | ชื่อในระบบ: ${data.realName}`)                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 })) // เอารูปโปรไฟล์มาโชว์ใหญ่ๆ ด้านข้าง
                .setColor(0xFFD700) // สีทองอร่าม
                .addFields(
                    { 
                        name: '💎 คลังสมบัติ', 
                        value: `**แต้มแลกการ์ดคงเหลือ:** ${data.points} แต้ม`, 
                        inline: false 
                    },
                    { 
                        name: '⚔️ สถิติสมรภูมิ (Battle Record)', 
                        value: ` **จำนวนครั้งที่ลงแข่ง:** ${data.duels} ครั้ง\n**งานที่แข่งล่าสุด:** ${data.lastActive}`, 
                        inline: false 
                    },
                    { name: '\u200B', value: '\u200B' }, // เว้นบรรทัดว่างๆ ให้ดูไม่แน่นเกินไป
                    { 
                        name: '🏆 Hall of Fame', 
                        value: `👑 **แชมป์เปี้ยน:** ${data.champion} สมัย\n🥉 **Top 3:** ${data.top3} ครั้ง\n🏅 **Top 5:** ${data.top5} ครั้ง\n🎯 **อัตราการติด Top 5 :** ${top5Rate}`,
                        inline: false 
                    }
                )
                .setFooter({ text: 'ข้อมูลอัปเดตล่าสุดจากฐานข้อมูล Dinomaster' })
                .setTimestamp();

            await message.channel.send({ embeds: [profileEmbed] });

        } catch (error) {
            console.error(error);
            loadingMsg.delete().catch(() => {});
            message.channel.send('❌ เกิดข้อผิดพลาดในการดึงข้อมูลโปรไฟล์');
        }
    }

    if (command === '!pollchamp') {
        if (!message.member.permissions.has('ManageMessages')) return message.reply('⛔ คุณไม่มีสิทธิ์สร้างโพลล์ครับ');

        const pollTourneyId = message.content.split(' ')[1];
        if (!pollTourneyId) return message.reply('⚠️ ฟอร์แมตผิดครับ ใช้: `!pollchamp <เลขงาน>`');

        try {
            const full = await T.getFull(pollTourneyId);
            const code = String(full.tournament.code);
            let participants = full.players.filter(p => !p.dropped_at).map(p => p.display_name);

            if (participants.length === 0) return message.reply('❌ ไม่พบผู้เข้าแข่งขันในทัวร์นาเมนต์นี้');

            // ⚠️ Discord รองรับ Dropdown สูงสุด 25 ตัวเลือก ถ้าเกินให้ตัดมาแค่ 25 คนแรก
            if (participants.length > 25) participants = participants.slice(0, 25);

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`pollselect_${code}`)
                .setPlaceholder('🔽 คลิกเพื่อเลือกตัวเต็งแชมป์ของคุณ!')
                .addOptions(participants.map((name, index) =>
                    new StringSelectMenuOptionBuilder().setLabel(name.substring(0, 100)).setValue(`player_${index}`)));

            const closeBtn = new ButtonBuilder()
                .setCustomId(`pollclose_${code}`)
                .setLabel('ปิดโพลล์ & สรุปผล')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🛑');

            const pollMsg = await message.channel.send({
                content: `🏆 **โหวตทายผลแชมป์ทัวร์นาเมนต์!**\nเฉพาะนักแข่งและแอดมินเท่านั้นที่มีสิทธิ์โหวต (1 คนโหวตได้ 1 ครั้ง หากกดใหม่จะเปลี่ยนผลโหวตให้เลยครับ)`,
                components: [new ActionRowBuilder().addComponents(selectMenu), new ActionRowBuilder().addComponents(closeBtn)]
            });

            activePolls.set(code, { messageId: pollMsg.id, participants, votes: {} });
        } catch (error) {
            message.reply(`❌ ${errText(error)}`);
        }
    }


    // ---------------------------------------------------------
    // 🏆 คำสั่งใหม่: !dmtrank (สร้างกระดานจัดอันดับแบบ Real-time)
    // ---------------------------------------------------------
    if (command === '!dmtrank') {
        const embed = await getLeaderboardEmbed();
        if (!embed) return message.reply('❌ ไม่สามารถโหลดข้อมูลจัดอันดับได้');

        // สร้างปุ่มรีเฟรช
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('refresh_leaderboard') // ชื่อ ID สำหรับดักปุ่ม
                .setLabel('รีเฟรชข้อมูลล่าสุด')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🔄')
        );

        const sentMessage = await message.channel.send({ embeds: [embed], components: [row] });
        activeLeaderboardMessage = sentMessage; // จำข้อความนี้ไว้

        // ลบวงจรอัปเดตเก่า (ถ้ามี) แล้วสร้างใหม่
        if (leaderboardInterval) clearInterval(leaderboardInterval);
        
        // ตั้งเวลาให้อัปเดตเองทุกๆ 15 นาที (900000 มิลลิวินาที) เพื่อประหยัดโควต้า Render
        leaderboardInterval = setInterval(async () => {
            if (activeLeaderboardMessage) {
                const newEmbed = await getLeaderboardEmbed();
                if (newEmbed) {
                    activeLeaderboardMessage.edit({ embeds: [newEmbed] }).catch(() => {
                        // ถ้าแอดมินเผลอลบข้อความบอร์ดทิ้ง ให้หยุดการอัปเดตทันที (เซิร์ฟเวอร์จะได้ไม่ทำงานฟรี)
                        clearInterval(leaderboardInterval);
                        activeLeaderboardMessage = null;
                    });
                }
            }
        }, 15 * 60 * 1000); 

        setTimeout(() => message.delete().catch(() => {}), 1000);
    }
});

// =========================================================
// โซนรับคำสั่งจากการกดปุ่ม (Button Interactions)
// =========================================================
client.on('interactionCreate', async interaction => {
    try {

        // =========================
        // 🟣 SELECT MENU
        // =========================
        if (interaction.isStringSelectMenu()) {

            // ✅ ติ๊กคนที่เล่นครบทุกรอบ (ก่อนปิดจ็อบ)
            if (interaction.customId.startsWith('fullplay_')) {
                if (!interaction.member.permissions.has('ManageMessages')) {
                    return await interaction.reply({ content: '⛔ เฉพาะแอดมินเท่านั้น', ephemeral: true });
                }

                const idParts = interaction.customId.split('_');
                const tid = idParts[1];
                const chunkIndex = parseInt(idParts[2]);
                const state = pendingFinish.get(tid);

                if (!state) {
                    return await interaction.reply({ content: '❌ รายการนี้หมดอายุแล้ว กดปุ่ม "ปิดจ็อบ" ใหม่อีกครั้งครับ', ephemeral: true });
                }

                // อัปเดตเฉพาะคนในชุดนี้: เอาออกทั้งชุดก่อน แล้วใส่กลับเฉพาะคนที่ถูกติ๊ก
                state.chunks[chunkIndex].forEach(p => state.full.delete(p.id));
                interaction.values.forEach(id => state.full.add(id));

                return await interaction.update({
                    content: buildFullPlayText(state),
                    components: buildFullPlayComponents(tid, state)
                });
            }

            if (!interaction.customId.startsWith('pollselect_')) return;

            const tourneyId = interaction.customId.split('_')[1];

            const isAdmin = interaction.member.permissions.has('ManageMessages');
            const isCompetitor = interaction.member.roles.cache.has(COMPETITOR_ROLE_ID);

            if (!isAdmin && !isCompetitor) {
                return await interaction.reply({
                    content: '⛔ **คุณไม่มีสิทธิ์โหวตครับ!**',
                    ephemeral: true
                });
            }

            const pollData = activePolls.get(tourneyId);
            if (!pollData) {
                return await interaction.reply({
                    content: '❌ โพลล์นี้ถูกปิดแล้ว',
                    ephemeral: true
                });
            }

            const selectedValue = interaction.values[0];
            const playerIndex = parseInt(selectedValue.split('_')[1]);
            const playerName = pollData.participants[playerIndex];

            pollData.votes[interaction.user.id] = playerIndex;

            return await interaction.reply({
                content: `✅ โหวตแล้ว: **${playerName}**`,
                ephemeral: true
            });
        }

        // =========================
        // 🔵 BUTTON
        // =========================
        if (!interaction.isButton()) return;

        await interaction.deferReply({ ephemeral: true });

        const parts = interaction.customId.split('_');
        const action = parts[0];
        const tournamentId = parts[1];

        if (!action) {
            return await interaction.editReply('❌ ปุ่มไม่ถูกต้อง');
        }


        // =========================
        // 🔴 POLL CLOSE
        // =========================
        if (action === 'pollclose') {
            if (!interaction.member.permissions.has('ManageMessages')) {
                return await interaction.editReply('⛔ สิทธิ์ไม่พอ');
            }

            const pollData = activePolls.get(tournamentId);
            if (!pollData) {
                return await interaction.editReply('❌ ไม่พบโพลล์');
            }

            const scoreMap = {};
            pollData.participants.forEach((_, i) => scoreMap[i] = 0);

            for (const userId in pollData.votes) {
                scoreMap[pollData.votes[userId]]++;
            }

            const results = pollData.participants.map((name, i) => ({
                name,
                votes: scoreMap[i]
            })).filter(p => p.votes > 0);

            results.sort((a, b) => b.votes - a.votes);

            let resultText = `🏆 ผลโหวต\n\n`;

            if (results.length === 0) {
                resultText += `ไม่มีโหวต`;
            } else {
                results.forEach((r, i) => {
                    resultText += `${i === 0 ? '🥇' : '🔸'} ${r.name} (${r.votes})\n`;
                });
            }

            await interaction.message.edit({ content: resultText, components: [] });
            activePolls.delete(tournamentId);

            return await interaction.editReply('✅ ปิดโพลล์แล้ว');
        }
        // =========================
        // 🔄 UPDATE (บอร์ดคู่ปัจจุบัน)
        // =========================
        if (action === 'update') {
            const v = await T.view(tournamentId);
            await interaction.message.edit({ embeds: [buildCurrentEmbed(v)], components: v.tournament.status === 'running' ? [currentButtons(v)] : [] });
            return await interaction.editReply('✅ อัปเดตแล้ว');
        }

        // =========================
        // 🟢 REGISTER (สมัครแข่ง)
        // =========================
        if (action === 'register') {
            const serverNickname = interaction.member.nickname || interaction.user.displayName;
            try {
                await T.addPlayer(tournamentId, {
                    discord_id: interaction.user.id,
                    display_name: serverNickname,
                    requireAccount: true, // ต้องมีบัญชีในฐานข้อมูล (เว็บ DMT Shop หรือบัญชีเก่า) ถึงจะสมัครได้
                });
                return await interaction.editReply(`✅ สมัครแข่งสำเร็จในชื่อ **${serverNickname}**!`);
            } catch (error) {
                if (error.message === 'NO_ACCOUNT') return await interaction.editReply('❌ คุณยังไม่ได้ลงทะเบียนในระบบฐานข้อมูลครับ (สมัคร/ผูก Discord ที่เว็บ DMT Shop ก่อน)');
                if (/ข้อมูลซ้ำ/.test(error.message)) return await interaction.editReply('⚠️ คุณสมัครงานนี้ไปแล้วครับ');
                return await interaction.editReply(`❌ ${errText(error)}`);
            }
        }

        // =========================
        // 🟡 LEAVE (สละสิทธิ์)
        // =========================
        if (action === 'leave') {
            try {
                await T.removePlayerByDiscord(tournamentId, interaction.user.id);
                return await interaction.editReply('✅ สละสิทธิ์เรียบร้อยแล้ว');
            } catch (error) {
                return await interaction.editReply(`❌ ${errText(error)}`);
            }
        }

        // =========================
        // 🟣 START (ปิดรับสมัคร → สุ่ม seed → จับคู่รอบแรก)
        // =========================
        if (action === 'start') {
            if (!interaction.member.permissions.has('ManageMessages')) {
                return await interaction.editReply('⛔ เฉพาะแอดมิน');
            }
            try {
                const v = await T.startTournament(tournamentId);
                // บอร์ดรับสมัคร + โพสต์คู่รอบแรก จะอัปเดตเองผ่าน event 'round'
                return await interaction.editReply(`🔀 สุ่ม seed เรียบร้อย\n✅ เริ่มแข่งขันแล้ว! (${v.players.length} คน)`);
            } catch (error) {
                return await interaction.editReply(`❌ ${errText(error)}`);
            }
        }

        // =========================
        // ⏱️ TIMER
        // =========================
        if (action === 'timer') {
            if (!interaction.member.permissions.has('ManageMessages')) {
                return await interaction.editReply('⛔ เฉพาะแอดมิน');
            }
            try {
                const t = await T.startTimer(tournamentId);
                return await interaction.editReply(`✅ เริ่มจับเวลา ${t.round_minutes} นาทีแล้ว!`);
            } catch (error) {
                return await interaction.editReply(`❌ ${errText(error)}`);
            }
        }

        // =========================
        // 💸 REWARD (ปุ่มแจกแต้ม)
        // =========================
        if (action === 'reward') {
            if (!interaction.member.permissions.has('ManageMessages')) return await interaction.editReply('⛔ เฉพาะแอดมิน');
            try {
                const res = await T.awardPoints(tournamentId);
                let text = `✅ แจกแต้มให้ Top ${res.quota} เรียบร้อย! (แชมป์ 10 แต้ม, อันดับอื่น 5 แต้ม — รวมผู้ได้รับ ${res.awarded.length} คน)`;
                if (res.skipped.length) text += `\n⚠️ ข้าม (ไม่มีบัญชี): ${res.skipped.map(s => s.name).join(', ')}`;
                return await interaction.editReply(text);
            } catch (error) {
                return await interaction.editReply(`❌ ${errText(error)}`);
            }
        }

        // ==========================================
        // 🏁 FINISH (ปุ่มปิดจ็อบ & บันทึกสถิติ)
        // ==========================================
        // ขั้นที่ 1: ขึ้นรายการให้แอดมินติ๊กคนที่เล่นครบทุกรอบก่อน
        if (action === 'finish') {
            if (!interaction.member.permissions.has('ManageMessages')) return await interaction.editReply('⛔ เฉพาะแอดมินเท่านั้นที่ปิดงานแข่งได้');

            try {
                const v = await T.view(tournamentId);
                if (v.tournament.status === 'finished') return await interaction.editReply('⚠️ งานนี้ปิดจ็อบไปแล้ว');
                if (!v.canFinish) {
                    return await interaction.editReply(v.allMatchesComplete
                        ? `⚠️ ยังแข่งไม่ครบ ${v.totalRounds} รอบ (ตอนนี้รอบ ${v.currentRound}) — จับคู่รอบถัดไปที่เว็บก่อน`
                        : '⚠️ ยังมีแมตช์ที่ยังไม่กรอกผล กรอกให้ครบที่เว็บจัดทัวร์ก่อนครับ');
                }

                const players = v.standings.filter(s => s.played > 0).map(s => ({
                    id: s.player_id, rank: s.rank, linked: s.linked,
                    label: `${s.rank}. ${s.name}`,
                    mention: s.discord_id ? `<@${s.discord_id}>` : `**${s.name}**`,
                }));
                const noShow = v.standings.filter(s => s.played === 0).map(s => (s.discord_id ? `<@${s.discord_id}>` : s.name));
                if (players.length === 0) return await interaction.editReply('⚠️ ไม่พบผู้เล่นที่ลงแข่งจริง');

                // แบ่งเป็นชุดละ 25 คน (ข้อจำกัดของ Discord select menu) สูงสุด 4 ชุด = 100 คน
                const chunks = [];
                for (let i = 0; i < players.length && chunks.length < 4; i += 25) chunks.push(players.slice(i, i + 25));

                const state = {
                    tournamentName: v.tournament.name,
                    players, noShow, chunks,
                    full: new Set(v.standings.filter(s => s.played > 0 && !s.dropped).map(s => s.player_id)),
                };
                pendingFinish.set(String(v.tournament.code), state);

                return await interaction.editReply({
                    content: buildFullPlayText(state),
                    components: buildFullPlayComponents(v.tournament.code, state)
                });
            } catch (error) {
                return await interaction.editReply(`❌ ${errText(error)}`);
            }
        }

        if (action === 'fullcancel') {
            pendingFinish.delete(String(tournamentId));
            return await interaction.editReply('✖️ ยกเลิกการปิดจ็อบแล้ว ยังไม่มีการแจก EXP ครับ');
        }

        // ขั้นที่ 2: ยืนยันแล้ว → ปิดจ็อบ + แจก EXP (ธุรกรรมเดียวใน Supabase)
        if (action === 'fullall' || action === 'fullconfirm') {
            if (!interaction.member.permissions.has('ManageMessages')) return await interaction.editReply('⛔ เฉพาะแอดมินเท่านั้นที่ปิดงานแข่งได้');

            const state = pendingFinish.get(String(tournamentId));
            if (!state) return await interaction.editReply('❌ รายการนี้หมดอายุแล้ว กดปุ่ม "ปิดจ็อบ" ใหม่อีกครั้งครับ');

            const playedAllIds = action === 'fullall' ? state.players.map(p => p.id) : [...state.full];

            try {
                const out = await T.finish(tournamentId, { playedAllIds });
                pendingFinish.delete(String(tournamentId));

                let summary = `✅ ปิดงานแข่ง **"${state.tournamentName}"** เรียบร้อย!\n📊 แจก EXP ให้ผู้เล่น ${out.awarded.length} คน\n\n`;
                out.results
                    .filter(r => r.played > 0)
                    .slice(0, 25)
                    .forEach(r => {
                        const place = getPlacementExp(r.rank);
                        const detail = [`เข้าร่วม +${EXP_JOIN}`];
                        if (place > 0) detail.unshift(`อันดับ ${r.rank} +${place}`);
                        if (r.playedAll) detail.push(`เล่นครบทุกรอบ +${EXP_FULL_PLAY}`);
                        const who = r.discord_id ? `<@${r.discord_id}>` : `**${r.name}**`;
                        summary += `${r.playedAll ? '☑️' : '⬜'} ${who} → **${r.exp} EXP** (${detail.join(', ')})\n`;
                    });
                if (out.noShow.length) summary += `\n🚫 ไม่ได้ลงแข่งเลย ไม่ได้ EXP: ${out.noShow.map(n => (n.discord_id ? `<@${n.discord_id}>` : n.name)).join(', ')}`;
                if (out.skipped.length) summary += `\n⚠️ ไม่พบบัญชี (walk-in/ยังไม่ผูก Discord): ${out.skipped.map(s => s.name).join(', ')}`;

                return await interaction.editReply({ content: summary.substring(0, 1900), components: [] });
            } catch (error) {
                return await interaction.editReply(`❌ ${errText(error)}`);
            }
        }


        // =========================
        // 🔄 REFRESH LEADERBOARD
        // =========================
        if (action === 'refresh' && parts[1] === 'leaderboard') {
            const newEmbed = await getLeaderboardEmbed();
            if (!newEmbed) {
                return await interaction.editReply('❌ ไม่สามารถโหลดข้อมูล');
            }

            await interaction.message.edit({ embeds: [newEmbed] });
            return await interaction.editReply('✅ รีเฟรชแล้ว');
        }

    } catch (error) {
        console.error('Interaction Error:', error);

        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply('❌ เกิดข้อผิดพลาด');
            } else {
                await interaction.reply({
                    content: '❌ เกิดข้อผิดพลาด',
                    ephemeral: true
                });
            }
        } catch (e) {
            console.error('Reply fail:', e);
        }
    }
});

// เปลี่ยนจาก clientReady เป็น ready เพื่อให้ทำงานได้อย่างถูกต้องในเวอร์ชันปัจจุบัน
client.once('ready', () => {
    console.log(`✅ บอทออนไลน์แล้วในชื่อ ${client.user.tag}`);
});

client.login(DISCORD_TOKEN);

// ป้องกันบอท Crash และแสดง Log ที่ชัดเจนใน Render
process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 [Anti-Crash] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('🚨 [Anti-Crash] Uncaught Exception:', error);
});