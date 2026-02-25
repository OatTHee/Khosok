
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Khosok is Online! 🟢'));
app.listen(process.env.PORT || 3000, () => console.log('เซิร์ฟเวอร์จำลองเริ่มทำงานแล้ว'));
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const tournamentTimers = new Map(); // หน่วยความจำสำหรับเก็บเวลาหมดรอบ
const axios = require('axios');

// กำหนดค่าต่างๆ ของคุณที่นี่
const DISCORD_TOKEN = 'MTQ3NjA2OTUxMjY2MTk1ODY5Ng.GB52Aa.KOdmIt8F2Ig7fTziWHb98MDUpFvM08cSyEqxRs';
const CHALLONGE_API_KEY = '7043adaa156fd70080d970fdc8a9e49bef0a06dfdefe1d6b';

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

// ---------------------------------------------------------
// ฟังก์ชัน 1: ดึงรายชื่อผู้สมัคร (อัปเดตใหม่)
// ---------------------------------------------------------
async function getParticipantsEmbed(tournamentId) {
    try {
        const res = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}/participants.json?api_key=${CHALLONGE_API_KEY}`);
        const participants = res.data;
        
        let listString = participants.length === 0 
            ? 'ยังไม่มีผู้สมัครเป็นคนแรก... สมัครเลยน้องๆ!' 
            : participants.map((p, index) => `**${index + 1}.** ${p.participant.name}`).join('\n');

        return new EmbedBuilder()
            .setTitle(`📋 รายชื่อผู้เข้าแข่งขัน: ${tournamentId}`)
            .setDescription(listString)
            .setColor(0x00FF00) // สีเขียว
            .setFooter({ text: `อัปเดตล่าสุดอัตโนมัติ • ผู้สมัคร: ${participants.length} คน` })
            .setTimestamp();
    } catch (error) {
        return new EmbedBuilder().setDescription('❌ โหลดข้อมูลรายชื่อไม่สำเร็จ');
    }
}

// ---------------------------------------------------------
// ฟังก์ชัน 2: ดึงข้อมูลการจับคู่ (เวอร์ชัน Turbo 🚀 ดึงข้อมูลรอบเดียวจบ)
// ---------------------------------------------------------
async function getRoundEmbed(tournamentId, roundNum) {
    try {
        // วิ่งไปขอข้อมูลรวดเดียวจบ ทั้งผู้เล่นและแมตช์แข่ง ลดการดีเลย์
        const res = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}.json`, {
            params: {
                api_key: CHALLONGE_API_KEY,
                include_participants: 1,
                include_matches: 1
            }
        });

        const tournamentData = res.data.tournament;
        const participants = tournamentData.participants;
        const matches = tournamentData.matches;

        // 1. สร้าง Map เพื่อแปลง ID เป็นชื่อ
        const playerMap = {};
        participants.forEach(p => { 
            playerMap[p.participant.id] = p.participant.name; 
        });

        // 2. กรองเอาเฉพาะแมตช์ในรอบที่ต้องการ
        const matchesInRound = matches.filter(m => m.match.round === parseInt(roundNum));

        // 3. จัดเรียงข้อความและใส่เลขโต๊ะ
        let matchText = matchesInRound.map((m, index) => {
            const match = m.match;
            const p1 = playerMap[match.player1_id] || '*[รอผู้ชนะ/บาย]*';
            const p2 = playerMap[match.player2_id] || '*[รอผู้ชนะ/บาย]*';
            const scores = match.scores_csv || '0-0';
            const tableNum = index + 1;

            if (match.state === 'complete') {
                const winnerName = playerMap[match.winner_id];
                return `**โต๊ะ ${tableNum}** | ✅ ~~${p1} vs ${p2}~~ 🏆 **${winnerName}** ชนะ (${scores})`;
            } else if (match.state === 'open') {
                return `**โต๊ะ ${tableNum}** | ⚔️ **${p1}** VS **${p2}**`;
            } else {
                return `**โต๊ะ ${tableNum}** | 🕒 ${p1} VS ${p2} *(รอดำเนินการ)*`;
            }
        }).join('\n\n');

        if (!matchText) matchText = 'ยังไม่มีข้อมูลการประกบคู่ในรอบนี้ หรือกรอกเลขรอบผิดครับ';

        return new EmbedBuilder()
            .setTitle(`🏆 ตารางการแข่งขัน รอบที่ ${roundNum}`)
            .setDescription(matchText)
            .setColor(0xFFA500) // สีส้ม
            .setFooter({ text: 'ดึงข้อมูลผลแพ้ชนะเรียลไทม์อัตโนมัติ' })
            .setTimestamp();

    } catch (error) {
        console.error(error);
        return new EmbedBuilder().setDescription('❌ ไม่สามารถโหลดข้อมูลสายการแข่งขันได้');
    }
}

// ---------------------------------------------------------
// ระบบคำสั่ง (Commands)
// ---------------------------------------------------------
client.on('messageCreate', async message => {
    // เช็กสิทธิ์ว่าคนพิมพ์มีสิทธิ์จัดการข้อความไหม (แอดมิน)
    if (!message.member || !message.member.permissions.has('ManageMessages')) return;

    const args = message.content.split(' ');
    const command = args[0];
    const tournamentId = args[1];

    // ---------------------------------------------------------
    // 📖 คำสั่งใหม่: !help (เปิดสมุดโน้ตคู่มือ)
    // ---------------------------------------------------------
    if (command === '!help') {
        const helpEmbed = new EmbedBuilder()
            .setTitle('🛠️ คู่มือแอดมิน: จัดแข่ง Dinomaster')
            .setColor(0x0099FF)
            .addFields(
                { name: ' เปิดรับสมัคร', value: 'พิมพ์ `!setup <ID>`' },
                { name: ' โชว์สถานะล่าสุด (อัจฉริยะ)', value: 'พิมพ์ `!current <ID>`\n*(โชว์รอบปัจจุบัน, แมตช์ล่วงหน้า และคนได้บาย)*' },
                { name: ' โชอันดับงานแข่ง', value: 'พิมพ์ `!standing <ID>`' },

            )
            .setFooter({ text: 'คำสั่งถูกซ่อนอัตโนมัติเพื่อความสะอาดของช่อง' });
        
        await message.channel.send({ embeds: [helpEmbed] });
        setTimeout(() => message.delete().catch(() => {}), 1000);
        return;
    }

    // ---------------------------------------------------------
    // 🌟 คำสั่งใหม่: !current <ID>
    // ---------------------------------------------------------
    if (command === '!current') {
        if (!tournamentId) return message.reply('⚠️ ฟอร์แมตผิดครับ ใช้: `!current <id>`');

        // รีเซ็ตเวลาทุกครั้งที่เรียกตารางใหม่
        tournamentTimers.set(tournamentId, null);

        // สร้างปุ่มเริ่มจับเวลา
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`timer_${tournamentId}`)
                .setLabel('เริ่มจับเวลา 40 นาที')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('⏱️')
        );

        const embed = await getCurrentEmbed(tournamentId, null);
        const sentMessage = await message.channel.send({ content: `อัปเดตสถานะการแข่งขันล่าสุด 📢`, embeds: [embed], components: [row] });

        setTimeout(() => message.delete().catch(() => {}), 1000);

        setInterval(async () => {
            // ดึงเวลาล่าสุดจากระบบความจำมาใช้อัปเดต
            const currentEndTime = tournamentTimers.get(tournamentId);
            const updatedEmbed = await getCurrentEmbed(tournamentId, currentEndTime);
            sentMessage.edit({ embeds: [updatedEmbed] }).catch(() => {});
        }, 30000);
    }

    // ---------------------------------------------------------
    // 🏆 คำสั่ง: !standing <ID> (โชว์อันดับ + ปุ่มแจกแต้ม)
    // ---------------------------------------------------------
    if (command === '!standing') {
        if (!tournamentId) return message.reply('⚠️ ใส่ ID ทัวร์นาเมนต์ด้วยครับ');

        try {
            const res = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}/participants.json?api_key=${CHALLONGE_API_KEY}`);
            let players = res.data.map(p => p.participant);
            
            // Logic: ถ้าคนเล่นรวม 10 คนขึ้นไป แจก 5 รางวัล, ถ้าน้อยกว่า แจก 3 รางวัล
            const totalPlayers = players.length;
            const rewardCount = totalPlayers >= 10 ? 5 : 3;

            players.sort((a, b) => {
                if (a.final_rank && b.final_rank) return a.final_rank - b.final_rank;
                return (b.match_wins || 0) - (a.match_wins || 0);
            });

            const topPlayers = players.slice(0, 5); // โชว์ 5 อันดับแรกเสมอ
            let standingText = `ผู้เข้าร่วมทั้งหมด: **${totalPlayers}** คน (โควตาแจกแต้ม: **Top ${rewardCount}**)\n\n`;

            topPlayers.forEach((p, index) => {
                const rank = index + 1;
                const wins = p.match_wins || 0;
                const losses = p.match_losses || 0;
                const isRewarded = rank <= rewardCount ? "🎁 *(ได้ 5 แต้ม)*" : "";
                
                if (rank === 1) standingText += `🥇 **อันดับ 1 : ${p.name}** (ชนะ ${wins}) ${isRewarded}\n`;
                else if (rank === 2) standingText += `🥈 **อันดับ 2 : ${p.name}** (ชนะ ${wins}) ${isRewarded}\n`;
                else if (rank === 3) standingText += `🥉 **อันดับ 3 : ${p.name}** (ชนะ ${wins}) ${isRewarded}\n`;
                else standingText += `🔹 อันดับ ${rank} : ${p.name} (ชนะ ${wins}) ${isRewarded}\n`;
            });

            const embed = new EmbedBuilder()
                .setTitle(`📊 สรุปตารางคะแนนล่าสุด`)
                .setDescription(standingText)
                .setColor(0xFFD700);

            // สร้างปุ่มแจกรางวัล
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`reward_${tournamentId}_${rewardCount}`)
                    .setLabel(`แจก 5 แต้มให้ Top ${rewardCount}`)
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('💸')
            );

            await message.channel.send({ embeds: [embed], components: [row] });
            setTimeout(() => message.delete().catch(() => {}), 1000);

        } catch (error) {
            console.error(error);
            message.channel.send('❌ ไม่สามารถดึงข้อมูลตารางคะแนนได้');
        }
    }
});

// ---------------------------------------------------------
// จัดการปุ่มกด (สมัคร/สละสิทธิ์) เหมือนเดิม
// ---------------------------------------------------------
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    await interaction.deferReply({ ephemeral: true });

    const [action, tournamentId] = interaction.customId.split('_');
    const nickname = interaction.member.nickname || interaction.user.displayName;
    const apiUrl = `https://api.challonge.com/v1/tournaments/${tournamentId}/participants.json`;

    try {
        // 1. ปุ่มสมัครแข่ง
        if (action === 'register') {
            await axios.post(apiUrl, { 
                api_key: CHALLONGE_API_KEY, 
                participant: { 
                    name: nickname,
                    misc: interaction.user.id // 🔑 แอบฝัง Discord_ID ไว้ในระบบ Challonge
                } 
            });
            await interaction.editReply(`✅ สมัครสำเร็จ! นำชื่อ **${nickname}** เข้าสู่ระบบแล้ว`);
            
        // 2. ปุ่มสละสิทธิ์
        } else if (action === 'leave') {
            const res = await axios.get(`${apiUrl}?api_key=${CHALLONGE_API_KEY}`);
            const target = res.data.find(p => p.participant.name === nickname);
            if (target) {
                await axios.delete(`https://api.challonge.com/v1/tournaments/${tournamentId}/participants/${target.participant.id}.json`, { data: { api_key: CHALLONGE_API_KEY } });
                await interaction.editReply(`❌ ถอนตัวสำเร็จครับ`);
            } else {
                await interaction.editReply(`⚠️ ไม่พบชื่อของคุณในระบบ`);
            }
            
        // 3. ปุ่มปิดรับสมัคร & เริ่มแข่ง
        } else if (action === 'start') {
            if (!interaction.member.permissions.has('ManageMessages')) {
                return await interaction.editReply('⛔ **คุณไม่มีสิทธิ์กดปุ่มนี้ครับ!** (เฉพาะแอดมินเท่านั้น)');
            }

            await axios.post(`https://api.challonge.com/v1/tournaments/${tournamentId}/start.json?api_key=${CHALLONGE_API_KEY}`);

            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`register_${tournamentId}`).setLabel('ปิดรับสมัครแล้ว').setStyle(ButtonStyle.Secondary).setDisabled(true),
                new ButtonBuilder().setCustomId(`leave_${tournamentId}`).setLabel('ปิดรับสมัครแล้ว').setStyle(ButtonStyle.Secondary).setDisabled(true),
                new ButtonBuilder().setCustomId(`start_${tournamentId}`).setLabel('กำลังแข่งขัน...').setStyle(ButtonStyle.Secondary).setDisabled(true)
            );

            await interaction.message.edit({ components: [disabledRow] });
            await interaction.editReply('✅ ทัวร์นาเมนต์ถูกกด Start เรียบร้อยแล้ว!');
            await interaction.channel.send(`🎉 **หมดเวลารับสมัคร! ทัวร์นาเมนต์เริ่มต้นขึ้นแล้วครับ**\nแอดมินสามารถพิมพ์ \`!current ${tournamentId}\` เพื่อดึงตารางแข่งและตั้งเวลาได้เลย!`);
            
        // 4. ปุ่มเริ่มจับเวลา (ตัวใหม่ล่าสุด!)
        } else if (action === 'timer') {
            if (!interaction.member.permissions.has('ManageMessages')) {
                return await interaction.editReply('⛔ **คุณไม่มีสิทธิ์กดปุ่มจับเวลาครับ!**');
            }

            // คำนวณเวลา 40 นาที (40 * 60 วินาที * 1000 มิลลิวินาที)
            const endTimeMs = Date.now() + (40 * 60 * 1000);
            tournamentTimers.set(tournamentId, endTimeMs); // บันทึกลงหน่วยความจำ

            // อัปเดตหน้าตา Embed ทันที
            const updatedEmbed = await getCurrentEmbed(tournamentId, endTimeMs);
            await interaction.message.edit({ embeds: [updatedEmbed] });
            
            // ตอบกลับแอดมิน
            await interaction.editReply('✅ เริ่มจับเวลา 40 นาทีสำหรับรอบนี้แล้ว!');
        
        // 5. ปุ่มแจกรางวัลเข้า Google Sheets
        } else if (action === 'reward') {
            if (!interaction.member.permissions.has('ManageMessages')) return await interaction.editReply('⛔ สิทธิ์ไม่พอครับ!');
            
            const rewardCount = parseInt(interaction.customId.split('_')[2]);
            const GAS_WEB_APP_URL = "ใส่_WEB_APP_URL_ของคุณที่นี่"; // 📌 เอาลิงก์จาก Apps Script มาใส่ตรงนี้!

            const res = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}/participants.json?api_key=${CHALLONGE_API_KEY}`);
            let players = res.data.map(p => p.participant);
            
            players.sort((a, b) => {
                if (a.final_rank && b.final_rank) return a.final_rank - b.final_rank;
                return (b.match_wins || 0) - (a.match_wins || 0);
            });

            // ดึงคนที่ได้รางวัล และมี Discord ID (misc)
            const winners = players.slice(0, rewardCount).map(p => ({
                name: p.name,
                discordId: p.misc, 
                points: 5 // แจก 5 แต้ม
            })).filter(w => w.discordId); // กรองคนที่ไม่มี ID ออก (พวกแอดมินยัดชื่อเอง)

            if (winners.length === 0) return await interaction.editReply('❌ ไม่พบผู้เล่นที่มี Discord ID ในระบบ');

            // ส่งข้อมูลไปให้ Google Sheets
            const sheetRes = await axios.post(GAS_WEB_APP_URL, {
                action: "award_points",
                winners: winners
            });

            const resultData = sheetRes.data.results;
            let resultMessage = `🎉 **โอนแต้มเข้าสู่ระบบสำเร็จ!**\n\n`;

            resultData.forEach(r => {
                if (r.status === "success") {
                    resultMessage += `✅ **${r.name}** (+5 แต้ม) -> เข้าสู่ระบบแล้ว (${r.uid})\n`;
                } else {
                    resultMessage += `⚠️ **${r.name}** -> อดได้แต้ม! (ไม่พบ Discord ID ในฐานข้อมูลเว็บแอป กรุณาไปสมัครก่อนครับ)\n`;
                }
            });

            // ปิดปุ่มกันคนกดซ้ำเบิ้ลแต้ม
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('rewarded').setLabel('แจกแต้มเรียบร้อยแล้ว').setStyle(ButtonStyle.Secondary).setDisabled(true)
            );
            await interaction.message.edit({ components: [disabledRow] });
            await interaction.editReply('ดำเนินการเสร็จสิ้น!');
            await interaction.channel.send(resultMessage);
        }

    } catch (error) {
        if (error.response?.data?.errors?.includes('Name has already been taken')) {
            await interaction.editReply('⚠️ สมัครไปแล้วครับ!');
        } else if (action === 'start') {
            console.error('Start Error:', error.response?.data || error.message);
            await interaction.editReply('❌ **เริ่มทัวร์นาเมนต์ไม่ได้!** (ต้องมีผู้สมัครอย่างน้อย 2 คน หรือกด Start ไปแล้ว)');
        } else {
            console.error(error);
            await interaction.editReply('❌ ระบบเกิดข้อผิดพลาด หรือทัวร์นาเมนต์เริ่มไปแล้ว');
        }
    }
});
// ---------------------------------------------------------
// ฟังก์ชัน 3: ดึงสถานะปัจจุบันแบบอัจฉริยะ (โชว์คู่ล่วงหน้า + คนได้บาย + จับเวลา)
// ---------------------------------------------------------
async function getCurrentEmbed(tournamentId, endTimeMs) {
    try {
        const res = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}.json`, {
            params: { api_key: CHALLONGE_API_KEY, include_participants: 1, include_matches: 1 }
        });

        const tournamentData = res.data.tournament;
        const participants = tournamentData.participants;
        const matches = tournamentData.matches;

        const playerMap = {};
        participants.forEach(p => { playerMap[p.participant.id] = p.participant.name; });

        // 1. หารอบปัจจุบัน (รอบต่ำสุดที่ยังมีแมตช์ที่ยังแข่งไม่จบ)
        let currentRound = 1;
        const activeMatches = matches.filter(m => m.match.state !== 'complete');
        if (activeMatches.length > 0) {
            currentRound = Math.min(...activeMatches.map(m => m.match.round));
        } else if (matches.length > 0) {
            currentRound = Math.max(...matches.map(m => m.match.round));
        }

        // 2. แยกประเภทแมตช์
        const roundMatches = matches.filter(m => m.match.round === currentRound);
        const advanceMatches = matches.filter(m => m.match.round > currentRound && m.match.state === 'open');

        // 3. หาคนที่มีชื่อลงแข่งอยู่ตอนนี้
        const playingNowIds = new Set();
        [...roundMatches, ...advanceMatches].forEach(m => {
            if (m.match.player1_id) playingNowIds.add(m.match.player1_id);
            if (m.match.player2_id) playingNowIds.add(m.match.player2_id);
        });

        // 4. หาคนที่ได้สิทธิ์ชนะบาย (Bye)
        const byePlayers = [];
        const futurePending = matches.filter(m => m.match.round > currentRound && m.match.state === 'pending');
        futurePending.forEach(m => {
            if (m.match.player1_id && !playingNowIds.has(m.match.player1_id)) {
                byePlayers.push(playerMap[m.match.player1_id]);
                playingNowIds.add(m.match.player1_id);
            }
            if (m.match.player2_id && !playingNowIds.has(m.match.player2_id)) {
                byePlayers.push(playerMap[m.match.player2_id]);
                playingNowIds.add(m.match.player2_id);
            }
        });

        // ================= ประกอบร่างข้อความ =================
        let matchText = '';
        
        // --- ส่วนแสดงเวลาหมดรอบ (นับถอยหลังแบบดิจิทัล) ---
        if (endTimeMs) {
            const endDate = new Date(endTimeMs);
            const timeString = endDate.toLocaleTimeString('th-TH', { 
                timeZone: 'Asia/Bangkok', 
                hour: '2-digit', 
                minute: '2-digit' 
            }).replace(':', '.'); 
            
            const unixSeconds = Math.floor(endTimeMs / 1000);
            matchText += `**หมดเวลาแข่งขัน:** ${timeString} น. ( <t:${unixSeconds}:R> )\n\n`;
        } else {
            matchText += `**หมดเวลาแข่งขัน:** 🕒 *ยังไม่เริ่มจับเวลา (รอแอดมินกดปุ่ม)*\n\n`;
        }

        // ประกาศแค่รอบเดียวตรงนี้!
        let tableNum = 1;

        // ส่วนที่ 1: แมตช์ในรอบปัจจุบัน
        matchText += `**--- รอบที่ ${currentRound} ---**\n`;
        if (roundMatches.length === 0) matchText += `ไม่มีแมตช์ในรอบนี้\n`;
        roundMatches.forEach(m => {
            const match = m.match;
            const p1 = playerMap[match.player1_id] || '*[รอผู้ชนะ]*';
            const p2 = playerMap[match.player2_id] || '*[รอผู้ชนะ]*';
            const scores = match.scores_csv || '0-0';

            if (match.state === 'complete') {
                const winnerName = playerMap[match.winner_id];
                matchText += `**โต๊ะ ${tableNum++}** | ✅ ~~${p1} vs ${p2}~~ 🏆 **${winnerName}** ชนะ (${scores})\n\n`;
            } else if (match.state === 'open') {
                matchText += `**โต๊ะ ${tableNum++}** | ⚔️ **${p1}** VS **${p2}**\n\n`;
            } else {
                matchText += `**โต๊ะ ${tableNum++}** | 🕒 ${p1} VS ${p2} *(รอดำเนินการ)*\n\n`;
            }
        });

        // ส่วนที่ 2: แมตช์ล่วงหน้าจากรอบอนาคต
        if (advanceMatches.length > 0) {
            matchText += `**--- แมตช์ล่วงหน้า (สามารถแข่งพร้อมกันได้เลย) ---**\n`;
            advanceMatches.forEach(m => {
                const match = m.match;
                const p1 = playerMap[match.player1_id];
                const p2 = playerMap[match.player2_id];
                matchText += `**โต๊ะ ${tableNum++}** | ⚔️ **${p1}** VS **${p2}** *(คู่จากรอบที่ ${match.round})*\n\n`;
            });
        }

        // ส่วนที่ 3: คนที่ได้สิทธิ์ชนะบาย (Bye)
        if (byePlayers.length > 0) {
            matchText += `**--- ผู้เล่นที่ได้สิทธิ์ชนะบาย (รอแข่งรอบถัดไป) ---**\n`;
            matchText += `🎉 ${byePlayers.map(name => `**${name}**`).join(', ')}\n\n`;
        }

        if (!matchText) matchText = 'ยังไม่มีข้อมูลการประกบคู่ครับ';

        return new EmbedBuilder()
            .setTitle(`🏆 สถานะการจับคู่ปัจจุบัน: ${tournamentData.name}`)
            .setDescription(matchText)
            .setColor(0x00FFFF)
            .setFooter({ text: 'ดึงข้อมูลและจัดโต๊ะเรียลไทม์อัตโนมัติ' })
            .setTimestamp();

    } catch (error) {
        console.error(error);
        return new EmbedBuilder().setDescription('❌ ไม่สามารถโหลดข้อมูลสายการแข่งขันได้');
    }
}

client.once('clientReady', () => {
    console.log(`✅ บอทออนไลน์แล้วในชื่อ ${client.user.tag}`);
});

client.login(DISCORD_TOKEN);