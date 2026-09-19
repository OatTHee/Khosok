# Khosok — บอท Discord + เว็บจัดทัวร์ Dinomaster

ระบบทัวร์นาเมนต์ของเราเอง (แทน Challonge) ข้อมูลอยู่ใน Supabase เดียวกับเว็บ DMT Shop
แจกแต้ม/EXP ตามเกณฑ์ Dinomaster DBWC อัตโนมัติ

## โครงสร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `index.js` | บอท Discord + เซิร์ฟเวอร์เว็บ (Express) |
| `tournament/engine.js` | ตรรกะล้วน: จับคู่ Swiss, สายแพ้คัดออก, จัดอันดับ, คำนวณแต้ม/EXP |
| `tournament/service.js` | อ่าน/เขียน Supabase ใช้ร่วมกันทั้งเว็บและบอท |
| `web/api.js` | API ของเว็บ (แอดมินเท่านั้น) |
| `public/` | หน้าเว็บจัดทัวร์ |
| `supabase/migrations/` | ตาราง `tournaments`, `tournament_players`, `tournament_matches` + ฟังก์ชัน `t_award_points`, `t_finish` |
| `test/` | `npm test` |

## Deploy บน Render

- Build: `npm install` · Start: `npm start`
- Environment: `DISCORD_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `BOT_BRIDGE_URL`, `BOT_BRIDGE_SECRET`
- ไม่ต้องใช้ `CHALLONGE_API_KEY` แล้ว
- เว็บจัดทัวร์ = ลิงก์ของ service บน Render (หน้าแรก) · health check: `/health`
- Login ด้วย Google/Discord: เพิ่มลิงก์ Render ใน Supabase → Authentication → URL Configuration → Redirect URLs

## ใช้งาน

1. เว็บ → สร้างงาน (ได้เลขงาน เช่น `#12`) เลือก Swiss หรือแพ้คัดออก
2. Discord → `!setup 12` เปิดบอร์ดรับสมัคร (ผู้เล่นกดสมัครเอง / แอดมินเพิ่มจากเว็บ)
3. กด "ปิดรับสมัคร & เริ่มแข่ง" (เว็บหรือ Discord) → สุ่ม seed + จับคู่รอบแรก บอทโพสต์คู่ให้
4. กรอกผลที่เว็บ → กด "จับคู่รอบถัดไป" (Swiss) / แพ้คัดออกขึ้นรอบเอง
5. แท็บ "แจกรางวัล & ปิดจ็อบ" → แจกแต้ม → ติ๊กคนเล่นครบ → ปิดจ็อบ (หรือใช้ปุ่มใน `!standing 12`)
