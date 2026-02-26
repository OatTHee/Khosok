const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Khosok is Online! 🟢'));
app.listen(process.env.PORT || 3000, () => console.log('เซิร์ฟเวอร์จำลองเริ่มทำงานแล้ว'));

const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const tournamentTimers = new Map(); // หน่วยความจำสำหรับเก็บเวลาหมดรอบ

// กำหนดค่าต่างๆ ของคุณที่นี่
const DISCORD_TOKEN = 'MTQ3NjA2OTUxMjY2MTk1ODY5Ng.GB52Aa.KOdmIt8F2Ig7fTziWHb98MDUpFvM08cSyEqxRs';
const CHALLONGE_API_KEY = '7043adaa156fd70080d970fdc8a9e49bef0a06dfdefe1d6b';

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

// =========================================================
// 🏅 ฟังก์ชันแปลง EXP เป็นฉายา (แก้ที่นี่จุดเดียว เปลี่ยนทั้งระบบ)
// =========================================================
function getTitleByExp(exp) {
    if (exp >= 260) return "🐦‍🔥 รีคอลปีศาจ";
    if (exp >= 230) return "⚜️ รีคอลระดับเทพ";
    if (exp >= 200) return "👑 รีคอลระดับราชา";
    if (exp >= 180) return "🔱 รีคอลระดับตำนาน";
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
// โซนฟังก์ชันตัวช่วย (Helper Functions)
// วางไว้ด้านนอกสุด เพื่อให้ทุกระบบเรียกใช้ได้
// =========================================================

// 1. ฟังก์ชันสร้างบอร์ดรับสมัคร (โชว์ชื่ออัปเดตเรียลไทม์ + ดึงเวลาจาก Challonge)
async function getSetupEmbed(tournamentId) {
    try {
        const res = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}.json`, {
            params: { api_key: CHALLONGE_API_KEY, include_participants: 1 }
        });
        
        const tournamentData = res.data.tournament;
        const tName = tournamentData.name;
        const participants = tournamentData.participants.map(p => p.participant.name);

        // 🕒 จัดการดึงและแปลงเวลาเริ่มแข่ง
        let startTimeText = "ยังไม่กำหนดเวลาเริ่ม";
        if (tournamentData.start_at) {
            const startDate = new Date(tournamentData.start_at);
            const timeString = startDate.toLocaleTimeString('th-TH', {
                timeZone: 'Asia/Bangkok',
                hour: '2-digit',
                minute: '2-digit'
            }).replace(':', '.'); 
            startTimeText = `งานเริ่มเวลา ${timeString} น.`;
        }

        let participantText = '';
        if (participants.length === 0) {
            participantText = 'ยังไม่มีคนสมัคร กดเพื่อเป็นคนแรก';
        } else {
            // 🎯 แก้ไขตรงนี้: เอาชื่อมาเรียงต่อกันโดยใช้ \n (ขึ้นบรรทัดใหม่) และใส่เลขกำกับ
            participantText = participants.map((name, index) => `**${index + 1}.** ${name}`).join('\n'); 
        }

        return new EmbedBuilder()
            .setTitle(`เปิดรับสมัคร: ${tName}`)
            .setDescription(`# ${startTimeText}\n\n**รายชื่อผู้สมัคร (${participants.length} คน):**\n${participantText}\n\nกดปุ่มด้านล่างเพื่อสมัคร หรือสละสิทธิ์\n(เฉพาะแอดมินเท่านั้นที่กดปุ่มเริ่มแข่งได้)`)
            .setColor(0x00FF00); // สีเขียว
    } catch (error) {
        console.error(error);
        return null;
    }
}

// 2. ฟังก์ชันดึงสถานะปัจจุบันแบบอัจฉริยะ (โชว์คู่ล่วงหน้า + คนได้บาย + จับเวลา)
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

        let currentRound = 1;
        const activeMatches = matches.filter(m => m.match.state !== 'complete');
        if (activeMatches.length > 0) {
            currentRound = Math.min(...activeMatches.map(m => m.match.round));
        } else if (matches.length > 0) {
            currentRound = Math.max(...matches.map(m => m.match.round));
        }

        const roundMatches = matches.filter(m => m.match.round === currentRound);
        const advanceMatches = matches.filter(m => m.match.round > currentRound && m.match.state === 'open');

        const playingNowIds = new Set();
        [...roundMatches, ...advanceMatches].forEach(m => {
            if (m.match.player1_id) playingNowIds.add(m.match.player1_id);
            if (m.match.player2_id) playingNowIds.add(m.match.player2_id);
        });

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

        let matchText = '';
        
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

        let tableNum = 1;

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

        if (advanceMatches.length > 0) {
            matchText += `**--- แมตช์ล่วงหน้า (สามารถแข่งพร้อมกันได้เลย) ---**\n`;
            advanceMatches.forEach(m => {
                const match = m.match;
                const p1 = playerMap[match.player1_id];
                const p2 = playerMap[match.player2_id];
                matchText += `**โต๊ะ ${tableNum++}** | ⚔️ **${p1}** VS **${p2}** *(คู่จากรอบที่ ${match.round})*\n\n`;
            });
        }

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

// ประกาศตัวแปรเก็บข้อความ Leaderboard เพื่อใช้อัปเดตอัตโนมัติ
let activeLeaderboardMessage = null;
let leaderboardInterval = null;

// 3. ฟังก์ชันสร้างบอร์ดจัดอันดับ (Leaderboard)
async function getLeaderboardEmbed() {
    // 📌 ลิงก์ Web App URL เดิมของคุณ
    const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzIkudMeK7Nx-5xGXdj3TznDPE43-rHru_1yKcp-A7s502EPJyYEG7vIJ3bMgj1euklig/exec"; 
    try {
        const res = await axios.post(GAS_WEB_APP_URL, { action: "get_leaderboard" });
        const players = res.data.data;

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
        console.error("Leaderboard Error:", error);
        return null;
    }
}


// =========================================================
// โซนรับคำสั่งจากการพิมพ์ (Message Commands)
// =========================================================
client.on('messageCreate', async message => {
    if (!message.member || !message.member.permissions.has('ManageMessages')) return;

    const args = message.content.split(' ');
    const command = args[0];
    const tournamentId = args[1];

    if (command === '!help') {
        const helpEmbed = new EmbedBuilder()
            .setTitle('🛠️ คู่มือแอดมิน: จัดแข่ง Dinomaster')
            .setColor(0x0099FF)
            .addFields(
                { name: ' เปิดรับสมัคร', value: 'พิมพ์ `!setup <ID>`' },
                { name: ' โชว์สถานะล่าสุด (อัจฉริยะ)', value: 'พิมพ์ `!current <ID>`\n*(โชว์รอบปัจจุบัน, แมตช์ล่วงหน้า และคนได้บาย)*' },
                { name: ' โชอันดับงานแข่ง', value: 'พิมพ์ `!standing <ID>`' }
            )
            .setFooter({ text: 'คำสั่งถูกซ่อนอัตโนมัติเพื่อความสะอาดของช่อง' });
        
        await message.channel.send({ embeds: [helpEmbed] });
        setTimeout(() => message.delete().catch(() => {}), 1000);
        return;
    }

    if (command === '!setup') {
        if (!tournamentId) return message.reply('กรุณาระบุ ID ทัวร์นาเมนต์ด้วยครับ เช่น !setup m1neoxux');

        try {
            const setupEmbed = await getSetupEmbed(tournamentId);
            if (!setupEmbed) return message.channel.send('ไม่พบทัวร์นาเมนต์นี้ใน Challonge หรือใส่ ID ผิดครับ');

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`register_${tournamentId}`).setLabel('สมัครแข่ง').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`leave_${tournamentId}`).setLabel('สละสิทธิ์').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`start_${tournamentId}`).setLabel('ปิดรับสมัคร & เริ่มแข่ง').setStyle(ButtonStyle.Primary)
            );

            await message.channel.send({ embeds: [setupEmbed], components: [row] });
            setTimeout(() => message.delete().catch(() => {}), 1000);

        } catch (error) {
            console.error('Setup Error:', error.message);
            message.channel.send('ระบบเกิดข้อผิดพลาดในการสร้างบอร์ดรับสมัคร');
        }
    }

    if (command === '!current') {
        if (!tournamentId) return message.reply('⚠️ ฟอร์แมตผิดครับ ใช้: `!current <id>`');

        tournamentTimers.set(tournamentId, null);

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
            const currentEndTime = tournamentTimers.get(tournamentId);
            const updatedEmbed = await getCurrentEmbed(tournamentId, currentEndTime);
            sentMessage.edit({ embeds: [updatedEmbed] }).catch(() => {});
        }, 30000);
    }

   // ---------------------------------------------------------
    // 🏆 คำสั่ง: !standing <ID> (โชว์อันดับ + ปุ่มแจกแต้ม + ปุ่มปิดจ็อบ)
    // ---------------------------------------------------------
    if (command === '!standing') {
        if (!tournamentId) return message.reply('⚠️ ใส่ ID ทัวร์นาเมนต์ด้วยครับ');

        try {
            // 1. ดึงข้อมูล "ทั้งผู้เล่น และ แมตช์การแข่งขัน" มาพร้อมกัน
            const res = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}.json`, {
                params: { api_key: CHALLONGE_API_KEY, include_participants: 1, include_matches: 1 }
            });
            
            let players = res.data.tournament.participants.map(p => p.participant);
            let matches = res.data.tournament.matches.map(m => m.match);
            
            const totalPlayers = players.length;
            const rewardCount = totalPlayers >= 10 ? 5 : 3;

            // 2. ให้บอทนับจำนวน ชนะ/แพ้ ด้วยตัวเองจากประวัติการแข่งทั้งหมด
            players.forEach(p => {
                p.calc_wins = 0;
                p.calc_losses = 0;
            });

            matches.forEach(m => {
                if (m.state === 'complete' && m.winner_id) {
                    let winner = players.find(p => p.id === m.winner_id);
                    // หาว่าใครคือคนแพ้ในแมตช์นี้
                    let loser_id = (m.player1_id === m.winner_id) ? m.player2_id : m.player1_id;
                    let loser = players.find(p => p.id === loser_id);
                    
                    if (winner) winner.calc_wins += 1;
                    if (loser) loser.calc_losses += 1;
                }
            });

            // 3. จัดอันดับแบบขั้นสุดยอด (เป๊ะตาม Challonge แน่นอน)
            players.sort((a, b) => {
                const rankA = a.final_rank;
                const rankB = b.final_rank;

                // กฎข้อ 1: ถ้าตกรอบแล้วทั้งคู่ ให้เรียงตามอันดับทางการ (Final Rank)
                if (rankA && rankB) return rankA - rankB;
                
                // กฎข้อ 2: A ยังไม่ตกรอบ (ไม่มี Rank) แต่ B ตกรอบแล้ว -> A ต้องอยู่สูงกว่า
                if (!rankA && rankB) return -1;
                
                // กฎข้อ 3: B ยังไม่ตกรอบ แต่ A ตกรอบแล้ว -> B ต้องอยู่สูงกว่า
                if (rankA && !rankB) return 1;

                // กฎข้อ 4: ถ้าสูสีกัน (ยังไม่ตกรอบทั้งคู่) ให้วัดที่ "จำนวนรอบที่ชนะ"
                if (b.calc_wins !== a.calc_wins) {
                    return b.calc_wins - a.calc_wins;
                }
                
                // กฎข้อ 5: ถ้าชนะเท่ากัน ให้วัดว่าใครแพ้น้อยกว่า (เผื่อกรณี Double Elim)
                return a.calc_losses - b.calc_losses;
            });

            const topPlayers = players.slice(0, 5); 
            let standingText = `ผู้เข้าร่วมทั้งหมด: **${totalPlayers}** คน (โควตาแจกแต้ม: **Top ${rewardCount}**)\n\n`;

            topPlayers.forEach((p, index) => {
                const rank = index + 1;
                const wins = p.calc_wins; // ใช้ค่าที่บอทนับเอง
                const losses = p.calc_losses; // ใช้ค่าที่บอทนับเอง
                const isRewarded = rank <= rewardCount ? "🎁 *(ได้ 5 แต้ม)*" : "";
                
                if (rank === 1) standingText += `🥇 **อันดับ 1 : ${p.name}** (ชนะ ${wins} แพ้ ${losses}) ${isRewarded}\n`;
                else if (rank === 2) standingText += `🥈 **อันดับ 2 : ${p.name}** (ชนะ ${wins} แพ้ ${losses}) ${isRewarded}\n`;
                else if (rank === 3) standingText += `🥉 **อันดับ 3 : ${p.name}** (ชนะ ${wins} แพ้ ${losses}) ${isRewarded}\n`;
                else standingText += `🔹 อันดับ ${rank} : ${p.name} (ชนะ ${wins} แพ้ ${losses}) ${isRewarded}\n`;
            });

            const embed = new EmbedBuilder()
                .setTitle(`📊 สรุปตารางคะแนนล่าสุด`)
                .setDescription(standingText)
                .setColor(0xFFD700);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`reward_${tournamentId}_${rewardCount}`)
                    .setLabel(`แจก 5 แต้มให้ Top ${rewardCount}`)
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('💸'),
                new ButtonBuilder()
                    .setCustomId(`finish_${tournamentId}`)
                    .setLabel(`ปิดจ็อบ & บันทึกประวัติ`)
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🏁')
            );

            await message.channel.send({ embeds: [embed], components: [row] });
            setTimeout(() => message.delete().catch(() => {}), 1000);

        } catch (error) {
            console.error(error);
            message.channel.send('❌ ไม่สามารถดึงข้อมูลตารางคะแนนได้');
        }
    }

// ---------------------------------------------------------
    // 📜 คำสั่งใหม่: !dmtprof (โชว์โปรไฟล์ไดโนมาสเตอร์สุดเท่)
    // ---------------------------------------------------------
    if (command === '!dmtprof') {
        // ถ้ามีการแท็กเพื่อน ให้ดูโปรไฟล์เพื่อน ถ้าไม่แท็ก ให้ดูของตัวเอง
        const targetUser = message.mentions.users.first() || message.author;
        // 📌 ใส่ลิงก์ Web App URL ของคุณที่นี่ (อันเดิมกับที่ใช้ในปุ่ม reward)
        const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzIkudMeK7Nx-5xGXdj3TznDPE43-rHru_1yKcp-A7s502EPJyYEG7vIJ3bMgj1euklig/exec"; 

        const loadingMsg = await message.reply('🔄 กำลังเชื่อมต่อฐานข้อมูลไดโนมาสเตอร์... กรุณารอสักครู่');

        try {
            // 🎯 เปลี่ยนเป็น POST เพื่อไม่ให้ชนกับระบบหน้าเว็บ
            const res = await axios.post(GAS_WEB_APP_URL, {
                action: "get_profile",
                discordId: targetUser.id
            });
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
    if (!interaction.isButton()) return;
    await interaction.deferReply({ ephemeral: true });

    const [action, tournamentId] = interaction.customId.split('_');
    const nickname = interaction.member.nickname || interaction.user.displayName;
    const apiUrl = `https://api.challonge.com/v1/tournaments/${tournamentId}/participants.json`;

    try {
        const COMPETITOR_ROLE_ID = '1476156740738486457';

        if (action === 'register') {
            await axios.post(apiUrl, { 
                api_key: CHALLONGE_API_KEY, 
                participant: { 
                    name: nickname,
                    misc: interaction.user.id
                } 
            });

            try {
                await interaction.member.roles.add(COMPETITOR_ROLE_ID);
                await interaction.editReply(`สมัครสำเร็จ! นำชื่อ ${nickname} เข้าสู่ระบบ และมอบยศนักแข่งให้แล้วครับ`);
            } catch (roleError) {
                await interaction.editReply(`สมัครสำเร็จ! นำชื่อ ${nickname} เข้าสู่ระบบแล้ว (แต่ระบบมอบยศให้ไม่ได้)`);
            }
            
            const updatedEmbed = await getSetupEmbed(tournamentId);
            if (updatedEmbed) {
                await interaction.message.edit({ embeds: [updatedEmbed] });
            }
            
        } else if (action === 'leave') {
            const res = await axios.get(`${apiUrl}?api_key=${CHALLONGE_API_KEY}`);
            const target = res.data.find(p => p.participant.name === nickname);
            if (target) {
                await axios.delete(`https://api.challonge.com/v1/tournaments/${tournamentId}/participants/${target.participant.id}.json`, { data: { api_key: CHALLONGE_API_KEY } });
                
                try {
                    await interaction.member.roles.remove(COMPETITOR_ROLE_ID);
                    await interaction.editReply(`ถอนตัวสำเร็จ และดึงยศนักแข่งออกเรียบร้อยครับ`);
                } catch (roleError) {
                    await interaction.editReply(`ถอนตัวสำเร็จครับ (แต่ระบบดึงยศออกเองไม่ได้)`);
                }

                const updatedEmbed = await getSetupEmbed(tournamentId);
                if (updatedEmbed) {
                    await interaction.message.edit({ embeds: [updatedEmbed] });
                }

            } else {
                await interaction.editReply(`ไม่พบชื่อของคุณในระบบ`);
            }
            
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
            
        } else if (action === 'timer') {
            if (!interaction.member.permissions.has('ManageMessages')) {
                return await interaction.editReply('⛔ **คุณไม่มีสิทธิ์กดปุ่มจับเวลาครับ!**');
            }

            const endTimeMs = Date.now() + (40 * 60 * 1000);
            tournamentTimers.set(tournamentId, endTimeMs); 

            const updatedEmbed = await getCurrentEmbed(tournamentId, endTimeMs);
            await interaction.message.edit({ embeds: [updatedEmbed] });
            
            await interaction.editReply('✅ เริ่มจับเวลา 40 นาทีสำหรับรอบนี้แล้ว!');
        
        // 5. ปุ่มแจกรางวัลเข้า Google Sheets
        } else if (action === 'reward') {
            if (!interaction.member.permissions.has('ManageMessages')) return await interaction.editReply('⛔ สิทธิ์ไม่พอครับ!');
            
            const rewardCount = parseInt(interaction.customId.split('_')[2]);
            // 📌 ดึงลิงก์ Web App URL ของคุณมาใส่ให้แล้ว
            const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzIkudMeK7Nx-5xGXdj3TznDPE43-rHru_1yKcp-A7s502EPJyYEG7vIJ3bMgj1euklig/exec"; 

            const res = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}.json`, {
                params: { api_key: CHALLONGE_API_KEY, include_participants: 1, include_matches: 1 }
            });
            let players = res.data.tournament.participants.map(p => p.participant);
            let matches = res.data.tournament.matches.map(m => m.match);
            
            players.forEach(p => { p.calc_wins = 0; p.calc_losses = 0; });
            matches.forEach(m => {
                if (m.state === 'complete' && m.winner_id) {
                    let winner = players.find(p => p.id === m.winner_id);
                    let loser_id = (m.player1_id === m.winner_id) ? m.player2_id : m.player1_id;
                    let loser = players.find(p => p.id === loser_id);
                    if (winner) winner.calc_wins += 1;
                    if (loser) loser.calc_losses += 1;
                }
            });

            players.sort((a, b) => {
                const rankA = a.final_rank; const rankB = b.final_rank;
                if (rankA && rankB) return rankA - rankB;
                if (!rankA && rankB) return -1;
                if (rankA && !rankB) return 1;
                if (b.calc_wins !== a.calc_wins) return b.calc_wins - a.calc_wins;
                return a.calc_losses - b.calc_losses;
            });

            const winners = players.slice(0, rewardCount).map(p => ({
                name: p.name,
                // 🎯 แปลงข้อมูลที่ซ่อนไว้ให้เป็น String ชัวร์ๆ ก่อนส่งไป API
                discordId: String(p.misc).trim(), 
                points: 5
            })).filter(w => w.discordId && w.discordId !== 'null' && w.discordId !== 'undefined'); 

            if (winners.length === 0) return await interaction.editReply('❌ ไม่พบผู้เล่นที่มี Discord ID ในระบบ');

            const sheetRes = await axios.post(GAS_WEB_APP_URL, {
                action: "award_points",
                winners: winners
            });

            const resultData = sheetRes.data.results;
            let resultMessage = `🎉 **โอนแต้มเข้าสู่ระบบสำเร็จ!**\n\n`;

            resultData.forEach(r => {
                if (r.status === "success") {
                    // 🎯 รายงานผลโดยจับคู่ "ชื่อดิสคอร์ดตอนแข่ง" -> "ชื่อจริงในเว็บแอป"
                    resultMessage += `✅ ให้แต้ม **${r.tourneyName}** -> เข้าไอดีเว็บ: **${r.realName}** (+5 แต้ม) [${r.uid}]\n`;
                } else {
                    resultMessage += `⚠️ **${r.tourneyName}** -> อดได้แต้ม! (ไม่พบ Discord ID ในระบบเว็บ กรุณาไปสมัครก่อนครับ)\n`;
                }
            });

            // ปิดแค่ปุ่มแจกแต้ม (เปลี่ยนเป็นสีเทา) แต่ยังคงปุ่ม ปิดจ็อบ เอาไว้ให้กดต่อได้
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('rewarded')
                    .setLabel('แจกแต้มเรียบร้อยแล้ว')
                    .setStyle(ButtonStyle.Secondary) // เปลี่ยนเป็นปุ่มสีเทา
                    .setDisabled(true),              // ล็อกไม่ให้กดซ้ำ
                new ButtonBuilder()
                    .setCustomId(`finish_${tournamentId}`)
                    .setLabel(`ปิดจ็อบ & บันทึกประวัติ`)
                    .setStyle(ButtonStyle.Danger)    // สีแดงเหมือนเดิม
                    .setEmoji('🏁')
            );
            
            await interaction.message.edit({ components: [disabledRow] });
            await interaction.editReply('ดำเนินการเสร็จสิ้น!');
            await interaction.channel.send(resultMessage);
        
        // 5. ปุ่มแจกรางวัลเข้า Google Sheets
        } else if (action === 'reward') {
            if (!interaction.member.permissions.has('ManageMessages')) return await interaction.editReply('⛔ สิทธิ์ไม่พอครับ!');
            
            const rewardCount = parseInt(interaction.customId.split('_')[2]);
            const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzIkudMeK7Nx-5xGXdj3TznDPE43-rHru_1yKcp-A7s502EPJyYEG7vIJ3bMgj1euklig/exec"; // 📌 อย่าลืมใส่ลิงก์ของคุณ!

            // ดึงข้อมูลทั้งผู้เล่นและแมตช์ เพื่อมานับคะแนน
            const res = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}.json`, {
                params: { api_key: CHALLONGE_API_KEY, include_participants: 1, include_matches: 1 }
            });
            let players = res.data.tournament.participants.map(p => p.participant);
            let matches = res.data.tournament.matches.map(m => m.match);
            
            // ให้บอทนับ ชนะ/แพ้ เอง
            players.forEach(p => { p.calc_wins = 0; p.calc_losses = 0; });
            matches.forEach(m => {
                if (m.state === 'complete' && m.winner_id) {
                    let winner = players.find(p => p.id === m.winner_id);
                    let loser_id = (m.player1_id === m.winner_id) ? m.player2_id : m.player1_id;
                    let loser = players.find(p => p.id === loser_id);
                    if (winner) winner.calc_wins += 1;
                    if (loser) loser.calc_losses += 1;
                }
            });

            // ลอจิกเรียงอันดับขั้นสุดยอด
            players.sort((a, b) => {
                const rankA = a.final_rank; const rankB = b.final_rank;
                if (rankA && rankB) return rankA - rankB;
                if (!rankA && rankB) return -1;
                if (rankA && !rankB) return 1;
                if (b.calc_wins !== a.calc_wins) return b.calc_wins - a.calc_wins;
                return a.calc_losses - b.calc_losses;
            });

            // ดึงคนที่ได้รางวัล และมี Discord ID
            const winners = players.slice(0, rewardCount).map(p => ({
                name: p.name,
                discordId: p.misc, 
                points: 5
            })).filter(w => w.discordId); 

            if (winners.length === 0) return await interaction.editReply('❌ ไม่พบผู้เล่นที่มี Discord ID ในระบบ');

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
                    resultMessage += `⚠️ **${r.name}** -> อดได้แต้ม! (ไม่พบ Discord ID ในฐานข้อมูล)\n`;
                }
            });

            // ปิดแค่ปุ่มแจกแต้ม (เปลี่ยนเป็นสีเทา) แต่ยังคงปุ่ม ปิดจ็อบ เอาไว้ให้กดต่อได้
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('rewarded')
                    .setLabel('แจกแต้มเรียบร้อยแล้ว')
                    .setStyle(ButtonStyle.Secondary) // เปลี่ยนเป็นปุ่มสีเทา
                    .setDisabled(true),              // ล็อกไม่ให้กดซ้ำ
                new ButtonBuilder()
                    .setCustomId(`finish_${tournamentId}`)
                    .setLabel(`ปิดจ็อบ & บันทึกประวัติ`)
                    .setStyle(ButtonStyle.Danger)    // สีแดงเหมือนเดิม
                    .setEmoji('🏁')
            );
            
            await interaction.message.edit({ components: [disabledRow] });
            await interaction.editReply('ดำเนินการเสร็จสิ้น!');
            await interaction.channel.send(resultMessage);
            
        // 6. ปุ่มปิดจ็อบทัวร์นาเมนต์ (ถอดยศ + Finalize + บันทึกประวัติ)
        } else if (action === 'finish') {
            if (!interaction.member.permissions.has('ManageMessages')) return await interaction.editReply('⛔ สิทธิ์ไม่พอครับ!');

            const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzIkudMeK7Nx-5xGXdj3TznDPE43-rHru_1yKcp-A7s502EPJyYEG7vIJ3bMgj1euklig/exec"; // 📌 อย่าลืมใส่ลิงก์ของคุณ!
            const COMPETITOR_ROLE_ID = '1476156740738486457'; // 📌 ID ยศนักแข่ง

            try {
                // 1. ดึงข้อมูลทัวร์นาเมนต์ แมตช์ และผู้เล่นทั้งหมด
                const tRes = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}.json`, {
                    params: { api_key: CHALLONGE_API_KEY, include_participants: 1, include_matches: 1 }
                });
                const tournamentData = tRes.data.tournament;
                let participants = tournamentData.participants.map(p => p.participant);
                let matches = tournamentData.matches.map(m => m.match);

                // 2. สั่ง Finalize ทัวร์นาเมนต์ใน Challonge
                await axios.post(`https://api.challonge.com/v1/tournaments/${tournamentId}/finalize.json?api_key=${CHALLONGE_API_KEY}`);

                // 3. วิ่งไล่ถอดยศนักแข่ง
                let removedRolesCount = 0;
                for (const p of participants) {
                    if (p.misc) {
                        try {
                            const member = await interaction.guild.members.fetch(p.misc);
                            if (member) {
                                await member.roles.remove(COMPETITOR_ROLE_ID);
                                removedRolesCount++;
                            }
                        } catch (e) { console.error(`ถอดยศไม่ได้: ${p.misc}`); }
                    }
                }

                // 4. เตรียมก้อนข้อความส่งเข้า Sheets (เพิ่มการนับคะแนน)
                const playerMap = {};
                participants.forEach(p => { 
                    playerMap[p.id] = p.name; 
                    p.calc_wins = 0; 
                    p.calc_losses = 0; 
                });

                matches.forEach(m => {
                    if (m.state === 'complete' && m.winner_id) {
                        let winner = participants.find(p => p.id === m.winner_id);
                        let loser_id = (m.player1_id === m.winner_id) ? m.player2_id : m.player1_id;
                        let loser = participants.find(p => p.id === loser_id);
                        if (winner) winner.calc_wins += 1;
                        if (loser) loser.calc_losses += 1;
                    }
                });

                participants.sort((a, b) => {
                    const rankA = a.final_rank; const rankB = b.final_rank;
                    if (rankA && rankB) return rankA - rankB;
                    if (!rankA && rankB) return -1;
                    if (rankA && !rankB) return 1;
                    if (b.calc_wins !== a.calc_wins) return b.calc_wins - a.calc_wins;
                    return a.calc_losses - b.calc_losses;
                });

                // 📝 เปลี่ยนรูปแบบรายชื่อให้มีสถิติ ชนะ/แพ้ โชว์ในชีตด้วย
                const participantsListString = participants.map((p, index) => `${index + 1}. ${p.name} (อันดับ ${index + 1} | ชนะ ${p.calc_wins} แพ้ ${p.calc_losses})`).join('\n');

                const matchHistoryString = matches.map(m => {
                    const p1 = playerMap[m.player1_id] || 'Bye';
                    const p2 = playerMap[m.player2_id] || 'Bye';
                    const scores = m.scores_csv || '0-0';
                    const winner = playerMap[m.winner_id] || 'บาย/เสมอ';
                    return `รอบ ${m.round}: ${p1} vs ${p2} | ชนะ: ${winner} (${scores})`;
                }).join('\n');

                // เตรียมข้อมูลลำดับส่งไปให้ Sheets แจก EXP
                const playerStats = participants.map((p, index) => ({
                    discordId: p.misc ? String(p.misc).trim() : null,
                    rank: p.final_rank || index + 1 // ใช้อันดับทางการ หรืออันดับที่เรียงแล้ว
                })).filter(p => p.discordId);

                // 5. ส่งข้อมูลเข้า Google Sheets
                await axios.post(GAS_WEB_APP_URL, {
                    action: "finish_tournament",
                    tournamentName: tournamentData.name,
                    participantsList: participantsListString,
                    matchHistory: matchHistoryString,
                    playerStats: playerStats // 🎯 ส่งอันนี้เพิ่มเข้าไปด้วย
                });

                // 6. แจ้งผลและปิดการใช้งานปุ่มทั้งหมด
                await interaction.editReply(`✅ ปิดจ็อบสำเร็จ! ถอดยศแล้ว ${removedRolesCount} คน`);
                await interaction.channel.send(`🏁 **ปิดการแข่งขัน: ${tournamentData.name}**\nทำการถอดยศนักแข่ง สรุปผลบน Challonge และบันทึกประวัติทุกแมตช์ลงระบบเรียบร้อยแล้วครับ!`);

                const oldEmbed = interaction.message.embeds[0];
                const disabledRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('ended').setLabel('ทัวร์นาเมนต์นี้จบลงแล้ว').setStyle(ButtonStyle.Secondary).setDisabled(true)
                );
                await interaction.message.edit({ embeds: [oldEmbed], components: [disabledRow] });

            } catch (error) {
                console.error(error);
                await interaction.editReply('❌ **ปิดจ็อบไม่ได้!** (คุณอาจจะยังกรอกผลคะแนนบางคู่ไม่ครบ กรุณาเคลียร์สายแข่งให้เสร็จก่อนครับ)');
            }
        } else if (action === 'refresh') {
            // 7. ปุ่มรีเฟรชกระดานจัดอันดับ (Leaderboard)
            if (!interaction.member.permissions.has('ManageMessages')) return await interaction.editReply('⛔ สิทธิ์ไม่พอครับ! (เฉพาะแอดมิน)');

            if (tournamentId === 'leaderboard') { // เช็กจาก customId: 'refresh_leaderboard'
                const newEmbed = await getLeaderboardEmbed();
                if (newEmbed) {
                    await interaction.message.edit({ embeds: [newEmbed] });
                    await interaction.editReply('✅ โหลดข้อมูลอัปเดตล่าสุดจากฐานข้อมูลเรียบร้อยแล้ว!');
                } else {
                    await interaction.editReply('❌ ไม่สามารถอัปเดตข้อมูลได้ในขณะนี้');
                }
            }
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

// เปลี่ยนจาก clientReady เป็น ready เพื่อให้ทำงานได้อย่างถูกต้องในเวอร์ชันปัจจุบัน
client.once('ready', () => {
    console.log(`✅ บอทออนไลน์แล้วในชื่อ ${client.user.tag}`);
});

client.login(DISCORD_TOKEN);