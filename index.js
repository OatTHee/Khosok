require('dotenv').config(); // [เพิ่มบรรทัดนี้] เพื่อให้บอทอ่านค่าจากไฟล์ .env ได้

const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Khosok is Online! 🟢'));
app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.log('เซิร์ฟเวอร์จำลองเริ่มทำงานแล้ว พร้อมรับการปลุก!');
});

const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const axios = require('axios');
axios.defaults.timeout = 8000; // ตัดจบถ้านานเกิน 8 วินาที
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

// 1. ฟังก์ชันสร้างบอร์ดรับสมัคร (โชว์จำนวนคน + ข้อความเชิญชวน)
async function getSetupEmbed(tournamentId) {
    try {
        const res = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}.json`, {
            params: { api_key: CHALLONGE_API_KEY, include_participants: 1 }
        });
        
        const tournamentData = res.data.tournament;
        const tName = tournamentData.name;
        const participantCount = tournamentData.participants.length;

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

        return new EmbedBuilder()
            .setTitle(`เปิดรับสมัคร: ${tName}`)
            .setDescription(`# ${startTimeText}\n\n📊 **จำนวนผู้สมัครปัจจุบัน:**\n# 👤 ${participantCount} คน\n\n🔥 **เป้าหมายพิเศษ:**\nหากมีผู้เข้าแข่งขันถึง **10 คน** ระบบจะขยายโควต้าแจกรางวัล 5 แต้ม ให้สูงสุดถึง **Top 5!** มาร่วมสนุกกันเยอะๆ นะครับ!\n\nกดปุ่มด้านล่างเพื่อสมัคร หรือสละสิทธิ์\n(เฉพาะแอดมินเท่านั้นที่กดปุ่มเริ่มแข่งได้)`)
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
    try {

        // =========================
        // 🟣 SELECT MENU
        // =========================
        if (interaction.isStringSelectMenu()) {

            if (!interaction.customId.startsWith('pollselect_')) return;

            const tourneyId = interaction.customId.split('_')[1];

            const COMPETITOR_ROLE_ID = '1476156740738486457';
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

        const nickname = interaction.member.nickname || interaction.user.displayName;
        const apiUrl = `https://api.challonge.com/v1/tournaments/${tournamentId}/participants.json`;

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
        // 🔄 UPDATE
        // =========================
        if (action === 'update') {
            const endTime = tournamentTimers.get(tournamentId) || null;

            const updatedEmbed = await getCurrentEmbed(tournamentId, endTime);
            await interaction.message.edit({ embeds: [updatedEmbed] });

            return await interaction.editReply('✅ อัปเดตแล้ว');
        }

// =========================
        // 🟢 REGISTER (สมัครแข่ง)
        // =========================
        if (action === 'register') {
            const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzIkudMeK7Nx-5xGXdj3TznDPE43-rHru_1yKcp-A7s502EPJyYEG7vIJ3bMgj1euklig/exec';

            try {
                // เช็คก่อนว่าลงทะเบียนในระบบเว็บแอปหรือยัง
                const gasRes = await axios.post(GAS_WEB_APP_URL, {
                    action: 'get_profile',
                    discordId: interaction.user.id
                }, { timeout: 8000 });

                const userProfile = gasRes.data;

                if (!userProfile.found) {
                    return await interaction.editReply('❌ คุณยังไม่ได้ลงทะเบียนในระบบฐานข้อมูลครับ');
                }

                // 🎯 ดึงชื่อเล่นในเซิร์ฟเวอร์ ณ วินาทีที่กด (ถ้าไม่ได้ตั้งชื่อเล่นไว้ ให้ใช้ชื่อ Discord ปกติ)
                const serverNickname = interaction.member.nickname || interaction.user.displayName;
                
                // ⚠️ สำคัญ: ห้อยแท็ก <@ID> ไว้ด้านหลัง เพื่อให้ปุ่มแจกแต้มและบันทึกสถิติหาตัวเจอ
                const challongeName = `${serverNickname} <@${interaction.user.id}>`;

                // เพิ่มผู้เข้าแข่งลง Challonge
                await axios.post(`https://api.challonge.com/v1/tournaments/${tournamentId}/participants.json`, {
                    participant: { name: challongeName }
                }, {
                    params: { api_key: CHALLONGE_API_KEY },
                    timeout: 8000
                });

                // 🎯 อัปเดตหน้าบอร์ดรับสมัครเพื่อให้ตัวเลข "จำนวนคน" เปลี่ยนทันที
                const updatedEmbed = await getSetupEmbed(tournamentId);
                if (updatedEmbed) {
                    await interaction.message.edit({ embeds: [updatedEmbed] });
                }

                return await interaction.editReply(`✅ สมัครแข่งสำเร็จในชื่อ **${serverNickname}**!`);
            } catch (error) {
                if (error.response?.status === 422) {
                    return await interaction.editReply('⚠️ คุณได้สมัครไปแล้ว หรือ ID ทัวร์นาเมนต์ไม่ถูกต้อง');
                }
                throw error;
            }
        }

        // =========================
        // 🟡 LEAVE (สละสิทธิ์)
        // =========================
        if (action === 'leave') {
            try {
                const getRes = await axios.get(apiUrl, {
                    params: { api_key: CHALLONGE_API_KEY }
                });

                const participants = getRes.data.map(p => p.participant);
                
                // 🎯 ค้นหาจาก <@DiscordID> เพื่อความแม่นยำ 100% ไม่ว่าชื่อเล่นจะเปลี่ยนไปแค่ไหน
                const userParticipant = participants.find(p => p.name.includes(`<@${interaction.user.id}>`));

                if (!userParticipant) {
                    return await interaction.editReply('❌ ไม่พบการสมัครของคุณในการแข่งขันนี้ครับ');
                }

                // สั่งลบชื่อจาก Challonge
                await axios.delete(`https://api.challonge.com/v1/tournaments/${tournamentId}/participants/${userParticipant.id}.json`, {
                    params: { api_key: CHALLONGE_API_KEY }
                });

                // 🎯 อัปเดตหน้าบอร์ดรับสมัครเพื่อให้ตัวเลข "จำนวนคน" ลดลงทันที
                const updatedEmbed = await getSetupEmbed(tournamentId);
                if (updatedEmbed) {
                    await interaction.message.edit({ embeds: [updatedEmbed] });
                }

                return await interaction.editReply('✅ สละสิทธิ์เรียบร้อยแล้ว');
            } catch (error) {
                throw error;
            }
        }


        // =========================
        // 🟢 START
        // =========================
        if (action === 'start') {
            if (!interaction.member.permissions.has('ManageMessages')) {
                return await interaction.editReply('⛔ เฉพาะแอดมิน');
            }

            try {
                await axios.post(`https://api.challonge.com/v1/tournaments/${tournamentId}/start.json`, {}, {
                    params: { api_key: CHALLONGE_API_KEY }
                });

                return await interaction.editReply('✅ เริ่มแข่งขันแล้ว!');
            } catch (error) {
                if (error.response?.data?.errors?.includes('Tournament has already been started')) {
                    return await interaction.editReply('⚠️ ทัวร์นาเมนต์นี้เริ่มแล้ว');
                }
                throw error;
            }
        }

        // =========================
        // ⏱️ TIMER
        // =========================
        if (action === 'timer') {
            if (!interaction.member.permissions.has('ManageMessages')) {
                return await interaction.editReply('⛔ เฉพาะแอดมิน');
            }

            const durationMs = 40 * 60 * 1000; // 40 นาที
            const endTime = Date.now() + durationMs;

            tournamentTimers.set(tournamentId, endTime);

            const updatedEmbed = await getCurrentEmbed(tournamentId, endTime);
            await interaction.message.edit({ embeds: [updatedEmbed] });

            return await interaction.editReply('✅ เริ่มจับเวลา 40 นาทีแล้ว!');
        }

  // =========================
        // 💸 REWARD (ปุ่มแจกแต้ม)
        // =========================
        if (action === 'reward') {
            if (!interaction.member.permissions.has('ManageMessages')) return await interaction.editReply('⛔ เฉพาะแอดมิน');

            const rewardCount = parseInt(parts[2]) || 3;
            const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzIkudMeK7Nx-5xGXdj3TznDPE43-rHru_1yKcp-A7s502EPJyYEG7vIJ3bMgj1euklig/exec';

            try {
                // 1. ดึงข้อมูลผู้เข้าแข่งและแมตช์ทั้งหมดมาคำนวณเอง
                const res = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}.json`, {
                    params: { api_key: CHALLONGE_API_KEY, include_participants: 1, include_matches: 1 }
                });

                const tournamentName = res.data.tournament.name;
                let players = res.data.tournament.participants.map(p => p.participant);
                let matches = res.data.tournament.matches ? res.data.tournament.matches.map(m => m.match) : [];

                // 2. คำนวณ ชนะ/แพ้ แบบเจาะลึก
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
                        // เช็คสละสิทธิ์หรือโดนปรับฟาวล์จากสกอร์ติดลบ
                        if (m.scores_csv) {
                            let setScores = m.scores_csv.split(',');
                            setScores.forEach(scoreStr => {
                                let pts = scoreStr.match(/(-?\d+)-(-?\d+)/);
                                if (pts) {
                                    if (parseInt(pts[1]) < 0) { let p1 = players.find(p => p.id === m.player1_id); if (p1) p1.is_forfeit = true; }
                                    if (parseInt(pts[2]) < 0) { let p2 = players.find(p => p.id === m.player2_id); if (p2) p2.is_forfeit = true; }
                                }
                            });
                        }
                    }
                });

                // 3. จัดเรียงอันดับตามความเก่งเป๊ะๆ
                players.sort((a, b) => {
                    const rankA = a.final_rank; const rankB = b.final_rank;
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

                // 4. เลือกผู้ชนะเพื่อส่งไปแจกแต้ม
                let winners = [];
                let currentDisplayRank = 1;

                for (let i = 0; i < players.length; i++) {
                    let listIndex = i + 1;
                    // จัดกลุ่มอันดับ 3 ร่วม (อันดับ 3 และ 4 ในแถว ให้ถือเป็นอันดับ 3)
                    if (listIndex === 1) currentDisplayRank = 1;
                    else if (listIndex === 2) currentDisplayRank = 2;
                    else if (listIndex === 3 || listIndex === 4) currentDisplayRank = 3;
                    else currentDisplayRank = listIndex - 1; 

                    // ถ้าอันดับเกินโควต้าที่ตั้งไว้ ให้หยุดทำงานทันที (แจกแค่ 3 หรือ 5 คน)
                    if (currentDisplayRank > rewardCount) break;

                    const player = players[i];
                    const match = player.name.match(/<@(\d+)>/);
                    if (match) {
                        winners.push({ discordId: match[1], points: 5, name: tournamentName });
                    }
                }

                if (winners.length > 0) {
                    await axios.post(GAS_WEB_APP_URL, { action: 'award_points', winners: winners });
                }

                return await interaction.editReply(`✅ แจก 5 แต้มให้ Top ${rewardCount} เรียบร้อย! (จำนวนผู้ได้รับแจกทั้งหมด: ${winners.length} คน)`);
            } catch (error) {
                console.error("Reward Error:", error);
                return await interaction.editReply('❌ เกิดข้อผิดพลาดในการแจกแต้ม');
            }
        }

      // ==========================================
        // 🏁 FINISH (ปุ่มปิดจ็อบ & บันทึกสถิติ)
        // ==========================================
        if (action === 'finish') {
            const COMPETITOR_ROLE_ID = '1476156740738486457'; 
            const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzIkudMeK7Nx-5xGXdj3TznDPE43-rHru_1yKcp-A7s502EPJyYEG7vIJ3bMgj1euklig/exec'; 

            if (!interaction.member.permissions.has('ManageMessages')) return await interaction.editReply('⛔ เฉพาะแอดมินเท่านั้นที่ปิดงานแข่งได้');

            try {
                // 🎯 1. สั่ง Finalize ใน Challonge เป็นอย่างแรก! 
                // เพื่อให้ระบบคำนวณ final_rank ให้ครบทุกคนก่อนจะดึงข้อมูลไปแจก EXP
                await axios.post(`https://api.challonge.com/v1/tournaments/${tournamentId}/finalize.json`, {}, {
                    params: { api_key: CHALLONGE_API_KEY }
                });

                // 2. ดึงข้อมูลที่อัปเดต final_rank เสร็จสมบูรณ์แล้ว
                const tourneyRes = await axios.get(`https://api.challonge.com/v1/tournaments/${tournamentId}.json`, {
                    params: { api_key: CHALLONGE_API_KEY, include_participants: 1, include_matches: 1 }
                });

                const tournamentName = tourneyRes.data.tournament.name;
                const matches = tourneyRes.data.tournament.matches.map(m => m.match);
                let players = tourneyRes.data.tournament.participants.map(p => p.participant);

                // 3. นำรายชื่อมาจัดเรียงตาม final_rank ที่ Challonge สรุปให้
                players.sort((a, b) => (a.final_rank || 999) - (b.final_rank || 999));

                let participantsList = "";
                let playerStats = [];
                const participantMap = {};

                // 4. วนลูปจับคู่เพื่อส่งให้ GAS
                players.forEach((participant, index) => {
                    const name = participant.name;
                    // ถึงตรงนี้รับรองว่ามี final_rank แน่นอน 100%
                    const rank = participant.final_rank || (index + 1); 
                    const discordIdMatch = name.match(/<@(\d+)>/);
                    const discordId = discordIdMatch ? discordIdMatch[1] : null;

                    participantMap[participant.id] = name;
                    participantsList += `${rank}. ${name}\n`;

                    if (discordId) {
                        playerStats.push({ discordId: discordId, rank: rank });
                    }
                });

                // 5. สรุปแมตช์ที่แข่งมาทั้งหมด
                let matchHistory = "";
                matches.forEach(match => {
                    const p1 = participantMap[match.player1_id] || "Unknown";
                    const p2 = participantMap[match.player2_id] || "Unknown";
                    const winner = participantMap[match.winner_id] || "เสมอ/ไม่มีผู้ชนะ";
                    const score = match.scores_csv || "0-0";
                    matchHistory += `รอบ ${match.round}: ${p1} vs ${p2} | ชนะ: ${winner} (${score})\n`;
                });

                // 6. ส่งข้อมูลที่ถูกต้องทั้งหมดไปยัง GAS (เพื่อแจก EXP)
                await axios.post(GAS_WEB_APP_URL, {
                    action: "finish_tournament",
                    tournamentName: tournamentName,
                    participantsList: participantsList.trim(),
                    matchHistory: matchHistory.trim(),
                    playerStats: playerStats
                });

                // 7. เคลียร์ยศนักแข่ง
                const role = interaction.guild.roles.cache.get(COMPETITOR_ROLE_ID);
                if (role) {
                    await interaction.guild.members.fetch();
                    for (const [id, member] of role.members) {
                        await member.roles.remove(COMPETITOR_ROLE_ID).catch(() => {});
                    }
                }

                return await interaction.editReply(`✅ ปิดงานแข่ง **"${tournamentName}"** เรียบร้อย!\n📊 ระบบแจก EXP ตามขั้นบันได (60/40/30/10) ให้ผู้เล่น ${playerStats.length} คน สำเร็จ!`);

            } catch (error) {
                console.error("Finish Error:", error.response?.data || error.message);
                
                // ถ้ายิง Finalize ไม่ผ่าน (เพราะแข่งยังไม่จบ หรือกรอกคะแนนไม่ครบ) จะเด้งมาตรงนี้ทันที บอทจะปลอดภัย
                if (error.response?.status === 422) {
                    return await interaction.editReply('⚠️ ไม่สามารถปิดจ็อบได้ ตรวจสอบใน Challonge ว่ามีคู่ไหนยังไม่ได้กรอกผลการแข่งบ้างครับ');
                }
                
                return await interaction.editReply('❌ เกิดข้อผิดพลาด กรุณาตรวจสอบ Log');
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