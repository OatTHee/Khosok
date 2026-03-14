const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Khosok is Online! 🟢'));
app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.log('เซิร์ฟเวอร์จำลองเริ่มทำงานแล้ว พร้อมรับการปลุก!');
});

const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const axios = require('axios');
const tournamentTimers = new Map(); // หน่วยความจำสำหรับเก็บเวลาหมดรอบ
const activePolls = new Map();

// กำหนดค่าต่างๆ ของคุณที่นี่ (ดึงจาก Environment Variables ปลอดภัย 100%)
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHALLONGE_API_KEY = process.env.CHALLONGE_API_KEY;

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
                { name: ' เปิดรับสมัคร', value: 'พิมพ์ `!setup <ID>`' },
                { name: ' โชว์สถานะล่าสุด (อัจฉริยะ)', value: 'พิมพ์ `!current <ID>`\n*(โชว์รอบปัจจุบัน, แมตช์ล่วงหน้า และคนได้บาย)*' },
                { name: ' โชว์อันดับงานแข่ง', value: 'พิมพ์ `!standing <ID>`' },
                { name: ' เปิดโพลล์ทายแชมป์', value: 'พิมพ์ `!pollchamp <ID>`' },
                { name: ' เปิด Leaderboard เซิฟ', value: 'พิมพ์ `!dmtrank`' },
                { name: ' โชว์โปรไฟล์ตัวเอง', value: 'พิมพ์ `!dmtprof`' },

            )
            .setFooter({ text: 'คำสั่งถูกซ่อนอัตโนมัติเพื่อความสะอาดของช่อง' });
        
        await message.channel.send({ embeds: [helpEmbed] });
        setTimeout(() => message.delete().catch(() => {}), 1000);
        return;
    }

    if (command === '!setup') {
        const tournamentId = message.content.split(' ')[1];
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
                .setEmoji('⏱️'),
            // 🎯 เพิ่มปุ่มใหม่: อัปเดตสายแข่งแมนนวล
            new ButtonBuilder()
                .setCustomId(`update_${tournamentId}`)
                .setLabel('อัปเดตสายแข่ง (ขึ้นรอบใหม่)')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🔄')
        );

        const embed = await getCurrentEmbed(tournamentId, null);
        const sentMessage = await message.channel.send({ content: `อัปเดตสถานะการแข่งขันล่าสุด 📢`, embeds: [embed], components: [row] });

        setTimeout(() => message.delete().catch(() => {}), 1000);

        // 🎯 สังเกตว่าบล็อก setInterval (อัปเดตอัตโนมัติทุก 30 วิ) ถูกลบออกไปแล้วครับ!
        // ภาพจะไม่ขยับเลยจนกว่าแอดมินจะกดยืนยันด้วยปุ่ม
    }
   if (command === '!standing') {
        if (!tournamentId) return message.reply('⚠️ ใส่ ID ทัวร์นาเมนต์ด้วยครับ');

        try {
            const res = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}.json`, {
                params: { api_key: CHALLONGE_API_KEY, include_participants: 1, include_matches: 1 }
            });
            
            // 🎯 1. เช็กสถานะว่าทัวร์นาเมนต์จบหรือยัง
            const tourneyState = res.data.tournament.state;
            const isCompleted = (tourneyState === 'complete'); // ถ้าจบแล้วจะเป็น true
            
            let players = res.data.tournament.participants.map(p => p.participant);
            let matches = res.data.tournament.matches ? res.data.tournament.matches.map(m => m.match) : [];
            
            const totalPlayers = players.length;
            const rewardCount = totalPlayers >= 10 ? 5 : 3;

            // 🎯 2. ให้บอทนับ ชนะ/แพ้ และ "เช็กการปรับฟาวล์ (-1)" จากสกอร์
            players.forEach(p => { p.calc_wins = 0; p.calc_losses = 0; p.is_forfeit = false; });
            
            matches.forEach(m => {
                if (m.state === 'complete') {
                    if (m.winner_id) {
                        let winner = players.find(p => p.id === m.winner_id);
                        let loser_id = (m.player1_id === m.winner_id) ? m.player2_id : m.player1_id;
                        let loser = players.find(p => p.id === loser_id);
                        if (winner) winner.calc_wins += 1;
                        if (loser) loser.calc_losses += 1;
                    }
                    
                    if (m.scores_csv) {
                        let setScores = m.scores_csv.split(',');
                        setScores.forEach(scoreStr => {
                            let parts = scoreStr.match(/(-?\d+)-(-?\d+)/);
                            if (parts) {
                                let score1 = parseInt(parts[1]);
                                let score2 = parseInt(parts[2]);
                                
                                if (score1 < 0) {
                                    let p1 = players.find(p => p.id === m.player1_id);
                                    if (p1) p1.is_forfeit = true;
                                }
                                if (score2 < 0) {
                                    let p2 = players.find(p => p.id === m.player2_id);
                                    if (p2) p2.is_forfeit = true;
                                }
                            }
                        });
                    }
                }
            });

            // 🎯 3. จัดอันดับใหม่
            players.sort((a, b) => {
                const rankA = a.final_rank;
                const rankB = b.final_rank;

                if (rankA && rankB) {
                    if (rankA !== rankB) return rankA - rankB; 
                    if (a.is_forfeit !== b.is_forfeit) return a.is_forfeit ? 1 : -1;
                    if (a.calc_wins !== b.calc_wins) return b.calc_wins - a.calc_wins;
                    return a.calc_losses - b.calc_losses;
                }
                
                if (!rankA && rankB) return -1;
                if (rankA && !rankB) return 1;

                if (b.calc_wins !== a.calc_wins) return b.calc_wins - a.calc_wins;
                return a.calc_losses - b.calc_losses;
            });

            // 🎯 4. ลูปเพื่อแสดงผลรันตัวเลข และใส่ป้ายบอกสถานะ
            let standingText = `ผู้เข้าร่วมทั้งหมด: **${totalPlayers}** คน (โควตาแจกแต้ม: **Top ${rewardCount}**)\n`;
            
            if (isCompleted) {
                standingText += `**🏁 ทัวร์นาเมนต์นี้จบการแข่งขันแล้ว 🏁**\n\n`;
            } else {
                standingText += `\n`;
            }

            players.forEach((p, index) => {
                const listIndex = index + 1; 
                let displayRank; 

                if (listIndex === 1) displayRank = 1;
                else if (listIndex === 2) displayRank = 2;
                else if (listIndex === 3 || listIndex === 4) displayRank = 3;
                else displayRank = listIndex - 1; 

                const wins = p.calc_wins !== undefined ? p.calc_wins : 0; 
                const losses = p.calc_losses !== undefined ? p.calc_losses : 0; 
                
                const isRewarded = (displayRank <= rewardCount) ? "🎁 *(ได้ 5 แต้ม)*" : "";
                const forfeitTag = p.is_forfeit ? " *(ถอนตัว)*" : "";
                
                if (listIndex === 1) {
                    standingText += `🥇 **อันดับ 1 : ${p.name}** (ชนะ ${wins} แพ้ ${losses}) ${isRewarded}\n`;
                } else if (listIndex === 2) {
                    standingText += `🥈 **อันดับ 2 : ${p.name}** (ชนะ ${wins} แพ้ ${losses}) ${isRewarded}\n`;
                } else if (listIndex === 3 || listIndex === 4) {
                    standingText += `🥉 **อันดับ 3 : ${p.name} (ที่ 3 ร่วม)** (ชนะ ${wins} แพ้ ${losses}) ${isRewarded}\n`;
                } else {
                    standingText += `🔹 อันดับ ${displayRank} : ${p.name}${forfeitTag} (ชนะ ${wins} แพ้ ${losses}) ${isRewarded}\n`;
                }
            });

            // เปลี่ยนสีขอบและหัวข้อให้ชัดเจนถ้าจบแล้ว
            const embedTitle = isCompleted ? `📊 สรุปตารางคะแนน (ปิดจ็อบแล้ว)` : `📊 สรุปตารางคะแนนล่าสุด`;
            const embedColor = isCompleted ? 0x00FF00 : 0xFFD700; // สีเขียวถ้าจบแล้ว สีทองถ้ากำลังแข่ง

            const embed = new EmbedBuilder()
                .setTitle(embedTitle)
                .setDescription(standingText)
                .setColor(embedColor);

            // 🎯 5. ส่งผลลัพธ์ (แยกเงื่อนไขมีปุ่ม กับไม่มีปุ่ม)
            if (!isCompleted) {
                // ถ้ายังไม่จบ ให้แสดงปุ่มตามปกติ
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
            } else {
                // ถ้าจบแล้ว ไม่ต้องส่ง ActionRow (ซ่อนปุ่มไปเลย)
                await message.channel.send({ embeds: [embed] });
            }

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

    if (command === '!pollchamp') {
        if (!message.member.permissions.has('ManageMessages')) return message.reply('⛔ คุณไม่มีสิทธิ์สร้างโพลล์ครับ');
        
        // 🎯 [แก้จุดนี้] ดึงเฉพาะไอดีที่ต่อท้ายคำสั่ง
        const pollTourneyId = message.content.split(' ')[1]; 
        
        if (!pollTourneyId) return message.reply('⚠️ ฟอร์แมตผิดครับ ใช้: `!pollchamp <id_challonge>`');

        try {
            // ดึงรายชื่อจาก Challonge ทันที
            const res = await axios.get(`https://api.challonge.com/v1/tournaments/${pollTourneyId}/participants.json`, {
                params: { api_key: CHALLONGE_API_KEY }
            });
            let participants = res.data.map(p => p.participant.name);

            if (participants.length === 0) return message.reply('❌ ไม่พบผู้เข้าแข่งขันในทัวร์นาเมนต์นี้');

            // ⚠️ Discord รองรับ Dropdown สูงสุด 25 ตัวเลือก ถ้าเกินให้ตัดมาแค่ 25 คนแรก
            if (participants.length > 25) participants = participants.slice(0, 25);

            // สร้างเมนู Dropdown
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`pollselect_${pollTourneyId}`)
                .setPlaceholder('🔽 คลิกเพื่อเลือกตัวเต็งแชมป์ของคุณ!')
                .addOptions(
                    participants.map((name, index) => 
                        new StringSelectMenuOptionBuilder()
                            .setLabel(name.substring(0, 100))
                            .setValue(`player_${index}`)
                    )
                );

            // สร้างปุ่มปิดโพลล์
            const closeBtn = new ButtonBuilder()
                .setCustomId(`pollclose_${pollTourneyId}`)
                .setLabel('ปิดโพลล์ & สรุปผล')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🛑');

            const row1 = new ActionRowBuilder().addComponents(selectMenu);
            const row2 = new ActionRowBuilder().addComponents(closeBtn);

            const pollMsg = await message.channel.send({
                content: `🏆 **โหวตทายผลแชมป์ทัวร์นาเมนต์!**\nเฉพาะนักแข่งและแอดมินเท่านั้นที่มีสิทธิ์โหวต (1 คนโหวตได้ 1 ครั้ง หากกดใหม่จะเปลี่ยนผลโหวตให้เลยครับ)`,
                components: [row1, row2]
            });

            // บันทึกสถานะลงในระบบ
            activePolls.set(pollTourneyId, {
                messageId: pollMsg.id,
                participants: participants,
                votes: {} // กล่องเก็บว่า ใครโหวตเบอร์ไหน { discordId: playerIndex }
            });

        } catch (error) {
            console.error('Poll Error:', error);
            message.reply('❌ ไม่สามารถดึงข้อมูลได้ครับ ตรวจสอบ ID อีกครั้ง');
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
        if (interaction.isStringSelectMenu()) {
        if (interaction.customId.startsWith('pollselect_')) {
            const tourneyId = interaction.customId.split('_')[1];
            
            // เช็กสิทธิ์: ต้องเป็นแอดมิน หรือ มียศนักแข่ง
            const COMPETITOR_ROLE_ID = '1476156740738486457';
            const isAdmin = interaction.member.permissions.has('ManageMessages');
            const isCompetitor = interaction.member.roles.cache.has(COMPETITOR_ROLE_ID);

            if (!isAdmin && !isCompetitor) {
                return await interaction.reply({ content: '⛔ **คุณไม่มีสิทธิ์โหวตครับ!** (เฉพาะแอดมินและนักแข่งในรายการนี้เท่านั้น)', ephemeral: true });
            }

            const pollData = activePolls.get(tourneyId);
            if (!pollData) return await interaction.reply({ content: '❌ โพลล์นี้สรุปผลไปแล้ว หรือถูกปิดไปแล้วครับ', ephemeral: true });

            const selectedValue = interaction.values[0]; // ดึงค่าที่เลือกมา เช่น 'player_0'
            const playerIndex = parseInt(selectedValue.split('_')[1]);
            const playerName = pollData.participants[playerIndex];

            // บันทึกโหวต (ถ้าเป็น id เดิม มันจะเขียนทับของเก่าทันที = 1 โหวตเสมอ)
            pollData.votes[interaction.user.id] = playerIndex;

            // ตอบกลับแบบเห็นคนเดียว ไม่รบกวนแชท
            return await interaction.reply({ content: `✅ บันทึกแล้ว! คุณทายว่า **${playerName}** จะได้แชมป์!`, ephemeral: true });
        }
        return; // ถ้าเป็น Select Menu อื่นๆ ให้จบการทำงานตรงนี้
    }

    if (!interaction.isButton()) return;
    await interaction.deferReply({ ephemeral: true });

    const [action, tournamentId] = interaction.customId.split('_');
    const nickname = interaction.member.nickname || interaction.user.displayName;
    const apiUrl = `https://api.challonge.com/v1/tournaments/${tournamentId}/participants.json`;

    try {

        if (action === 'pollclose') {
            if (!interaction.member.permissions.has('ManageMessages')) return await interaction.editReply('⛔ สิทธิ์ไม่พอครับ! (เฉพาะแอดมิน)');

            const pollData = activePolls.get(tournamentId); // tournamentId มาจากการ split ชื่อปุ่ม
            if (!pollData) return await interaction.editReply('❌ ไม่พบข้อมูลโพลล์นี้ หรือโพลล์ถูกปิดไปแล้วครับ');

            // 1. นับคะแนนโหวตทั้งหมด
            const scoreMap = {};
            pollData.participants.forEach((_, index) => scoreMap[index] = 0);
            
            for (const userId in pollData.votes) {
                const pIndex = pollData.votes[userId];
                scoreMap[pIndex]++;
            }

            // 2. จัดรูปแบบผู้เข้าแข่งขันและจำนวนโหวต (เอาเฉพาะคนที่มีคะแนน)
            const results = pollData.participants.map((name, index) => ({
                name: name,
                votes: scoreMap[index]
            })).filter(p => p.votes > 0);

            // 3. เรียงลำดับจากโหวตมากไปน้อย
            results.sort((a, b) => b.votes - a.votes);

            let resultText = `🏆 **สรุปผลโหวตทายผลแชมป์!**\n\n`;
            if (results.length === 0) {
                resultText += `ไม่มีใครได้รับการโหวตเลยครับ 😅 (แอบเหงานะเนี่ย)`;
            } else {
                results.forEach((r, idx) => {
                    if (idx === 0) {
                        resultText += `🥇 **อันดับ 1 (ตัวเต็งอันดับหนึ่ง):** ${r.name} - **${r.votes} โหวต**\n`;
                    } else {
                        resultText += `🔸 ตัวสำรองอันดับ ${idx + 1}: ${r.name} - ${r.votes} โหวต\n`;
                    }
                });
            }

            // 4. ลบโพลล์เก่าทิ้ง แล้วโชว์ผลคะแนนแทน
            await interaction.message.edit({ content: resultText, components: [] }); // ลบ components ออกหมด
            activePolls.delete(tournamentId); // ล้างหน่วยความจำ

            await interaction.editReply('✅ สรุปผลโพลล์เรียบร้อยแล้ว!');
        }
        const COMPETITOR_ROLE_ID = '1476156740738486457';
        // 🎯 เปลี่ยนจาก update_bracket เป็น update เฉยๆ
        if (action === 'update') {
            try {
                // ดึงเวลาจับเวลาล่าสุด (ถ้ามีการเปิดจับเวลาอยู่)
                const currentEndTime = tournamentTimers.get(tournamentId) || null;
                
                // สั่งดึงภาพและข้อมูลสายแข่ง "เวอร์ชันล่าสุด" มาใหม่
                const updatedEmbed = await getCurrentEmbed(tournamentId, currentEndTime);
                
                // เอาภาพใหม่ไปทับภาพเก่าในข้อความเดิม
                await interaction.message.edit({ embeds: [updatedEmbed] });
                
                // ปิดสถานะ Thinking
                await interaction.editReply({ content: '✅ ดึงภาพและอัปเดตสายแข่งล่าสุดเรียบร้อยแล้ว!' });
                
            } catch (error) {
                console.error('Update Bracket Error:', error);
                await interaction.editReply({ content: '❌ เกิดข้อผิดพลาดในการดึงข้อมูลสายแข่งใหม่' });
            }
        }

        if (action === 'register') {
            // 1. เช็ก Google Sheets ก่อนว่าใช้ไอดีหลักที่ลงทะเบียนไว้หรือไม่
            const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzIkudMeK7Nx-5xGXdj3TznDPE43-rHru_1yKcp-A7s502EPJyYEG7vIJ3bMgj1euklig/exec'; // ⚠️ เอาลิงก์ Web App ล่าสุดมาใส่นะครับ
            const checkPayload = { action: 'get_profile', discordId: interaction.user.id };

            try {
                const gasRes = await axios.post(GAS_WEB_APP_URL, checkPayload);
                const userProfile = gasRes.data;

                // ถ้าไม่เจอข้อมูล แปลว่าไม่ได้ลงทะเบียน หรือไม่ได้ใช้ไอดีที่ผูกไว้มากด
                if (!userProfile.found) {
                    return await interaction.editReply('❌ **คุณยังไม่ได้ลงทะเบียน หรือไม่ได้ใช้ไอดีหลัก!**\n👉 กรุณาใช้ Discord ID ที่ลงทะเบียนไว้ใน Web App มากดสมัครครับ เพื่อรักษาสิทธิ์และ EXP ของคุณเอง');
                }

                const nickname = interaction.member.displayName; // ใช้ชื่อเล่นในดิสคอร์ดปัจจุบัน
                const mainId = interaction.user.id; // ไอดีคนที่กด

                // 2. ดึงรายชื่อคนใน Challonge มาตรวจหา "ID" ที่ซ่อนอยู่หลังบัตร
                const participantsRes = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}/participants.json`, {
                    params: { api_key: CHALLONGE_API_KEY }
                });
                
                const participants = participantsRes.data;
                const existingParticipant = participants.find(p => p.participant.misc === mainId);

                // 3. ถ้าเจอว่าเคยสมัครไปแล้วด้วยไอดีนี้!
                if (existingParticipant) {
                    const pId = existingParticipant.participant.id;
                    const pName = existingParticipant.participant.name;

                    // มอบยศให้เผื่อไว้ (กรณีเขาเคยลบยศทิ้งแล้วมากดใหม่)
                    try { await interaction.member.roles.add(COMPETITOR_ROLE_ID); } catch(e) {}

                    // ถ้าชื่อในเว็บ ไม่ตรงกับชื่อดิสคอร์ดปัจจุบัน (เปลี่ยนชื่อมา)
                    if (pName !== nickname) {
                        await axios.put(`https://api.challonge.com/v1/tournaments/${tournamentId}/participants/${pId}.json`, {
                            api_key: CHALLONGE_API_KEY,
                            participant: { name: nickname }
                        });
                        
                        // อัปเดตหน้าบอร์ดใหม่ให้ชื่อเปลี่ยนด้วย
                        const updatedEmbed = await getSetupEmbed(tournamentId);
                        if (updatedEmbed) {
                            await interaction.message.edit({ embeds: [updatedEmbed] });
                        }

                        return await interaction.editReply(`✅ **อัปเดตชื่อสำเร็จ!**\nระบบได้เปลี่ยนชื่อในสายแข่งเป็น **${nickname}** ให้คุณแล้วครับ (ไม่มีการลงชื่อซ้ำ)`);
                    } else {
                        return await interaction.editReply('⚠️ **คุณสมัครไปแล้วครับ!** (มีรายชื่อในสายแข่งแล้ว)');
                    }
                }

                // 4. ถ้ายังไม่เคยสมัคร ให้สร้างใหม่และ "แอบซ่อน ID" ไว้ในช่อง misc
                await axios.post(`https://api.challonge.com/v1/tournaments/${tournamentId}/participants.json`, {
                    api_key: CHALLONGE_API_KEY,
                    participant: { 
                        name: nickname,
                        misc: mainId // 🎯 ยัด ID ไว้ตรวจสอบคราวหลัง
                    }
                });

                // 5. มอบยศและแจ้งเตือนผลการสมัคร
                try {
                    await interaction.member.roles.add(COMPETITOR_ROLE_ID);
                    await interaction.editReply(`✅ สมัครสำเร็จ! นำชื่อ **${nickname}** เข้าสู่ระบบ และมอบยศนักแข่งให้แล้วครับ`);
                } catch (roleError) {
                    await interaction.editReply(`✅ สมัครสำเร็จ! นำชื่อ **${nickname}** เข้าสู่ระบบแล้ว (แต่ระบบมอบยศนักแข่งให้ไม่ได้ กรุณาแจ้งแอดมิน)`);
                }
                
                // 6. อัปเดตรายชื่อหน้าบอร์ด (Embed)
                const updatedEmbed = await getSetupEmbed(tournamentId);
                if (updatedEmbed) {
                    await interaction.message.edit({ embeds: [updatedEmbed] });
                }

            } catch (err) {
                console.error('Register Error:', err);
                await interaction.editReply('❌ เกิดข้อผิดพลาดในการเชื่อมต่อกับระบบครับ');
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

            // 🎯 [ปรับปรุงจุดนี้] ใช้ filter เพื่อเช็คเงื่อนไข "ที่ 3 ร่วม" แทนการ slice ตัดทิ้ง
            const winners = players.filter((p, index) => {
                const listRank = index + 1;
                // ให้ผ่านถ้าอยู่ในโควตาแจก หรือ (ถ้าโควตาคือ Top 3 และคนนี้คือคนที่ 4 ซึ่งเป็นที่ 3 ร่วม)
                return listRank <= rewardCount || (rewardCount === 3 && listRank === 4);
            }).map(p => ({
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