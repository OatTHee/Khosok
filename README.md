# Khosok — บอท Discord + เว็บจัดทัวร์ Dinomaster

ระบบทัวร์นาเมนต์ของเราเอง (แทน Challonge) ข้อมูลอยู่ใน Supabase เดียวกับเว็บ DMT Shop
แจกแต้ม/EXP ตามเกณฑ์ Dinomaster DBWC (แต่ละงานเลือกได้ว่าจะแจกอะไร และตั้งตารางแต้ม/EXP เองได้)

## โครงสร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `index.js` | บอท Discord + เซิร์ฟเวอร์เว็บ (Express) |
| `tournament/engine.js` | ตรรกะล้วน: จับคู่ Swiss, สายแพ้คัดออก, จัดอันดับ, คำนวณแต้ม/EXP |
| `tournament/service.js` | อ่าน/เขียน Supabase ใช้ร่วมกันทั้งเว็บและบอท |
| `web/api.js` | API ของเว็บ (แอดมินเท่านั้น) |
| `public/` | หน้าเว็บจัดทัวร์ |
| `supabase/migrations/` | ตาราง `tournaments`, `tournament_players`, `tournament_matches` + ฟังก์ชัน `t_award_points`, `t_award_exp`, `t_close` (`t_finish` เดิมเก็บไว้ให้บอทรุ่นเก่า) |
| `test/` | `npm test` |

## Deploy บน Render

- Build: `npm install` · Start: `npm start`
- Environment: `DISCORD_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `BOT_BRIDGE_URL`, `BOT_BRIDGE_SECRET`
- ไม่บังคับ: `PUBLIC_URL` (ลิงก์เว็บ ใช้ทำรูปโลโก้ในป้าย — บน Render ใช้ `RENDER_EXTERNAL_URL` ให้เองอยู่แล้ว), `SHOP_LOGIN_URL` (ค่าเริ่มต้น `https://card-catalog-pi.vercel.app/login`), `LOGO_URL`
- ไม่ต้องใช้ `CHALLONGE_API_KEY` แล้ว
- เว็บจัดทัวร์ = ลิงก์ของ service บน Render (หน้าแรก) · health check: `/health`
- Login ด้วย Google/Discord: เพิ่มลิงก์ Render ใน Supabase → Authentication → URL Configuration → Redirect URLs

## ใช้งาน

1. เว็บ → สร้างงาน (ได้เลขงาน เช่น `#12`) เลือก Swiss หรือแพ้คัดออก + ติ๊กรางวัล (💎 แต้มแลกการ์ด / ✨ EXP / 🎁 ของรางวัลอื่น) และแก้ตารางแต้ม/EXP รายอันดับได้ (แก้ภายหลังได้ในแท็บตั้งค่า จนกว่าจะกดแจก)
2. Discord → `!setup 12` เปิดบอร์ดรับสมัคร (ผู้เล่นกดสมัครเอง / แอดมินเพิ่มจากเว็บ)
3. กด "ปิดรับสมัคร & เริ่มแข่ง" (เว็บหรือ Discord) → สุ่ม seed + จับคู่รอบแรก บอทโพสต์คู่ให้
4. กรอกผลที่เว็บ → กด "จับคู่รอบถัดไป" (Swiss) / แพ้คัดออกขึ้นรอบเอง
5. กรอกผลครบทุกแมตช์แล้ว ใช้ 3 ปุ่มแยกกันในแท็บ "แจกรางวัล & ปิดจ็อบ" หรือใต้ `!standing 12`
   - 💸 **แจกแต้มให้ Top** (ขึ้นเฉพาะงานที่แจกแต้ม) · ✨ **แจก EXP** (ติ๊กคนเล่นครบทุกรอบก่อน) — กดได้อย่างละครั้ง ก่อนหรือหลังปิดจ็อบก็ได้
   - 🏁 **ปิดจ็อบ & บันทึกประวัติ** — จบงาน บันทึกประวัติ + สถิติผู้เล่น (ไม่แจก EXP)
   - 🎁 ของรางวัลอื่น แสดงผลอย่างเดียว แอดมินแจกเองนอกระบบ

## สิทธิ์

- **แอดมินร้าน** (`user_profiles.role = 'admin'`): จัดการทัวร์ได้ทั้งหมด + แต่งตั้ง/ถอดสตาฟที่หน้า "👥 สตาฟ" ในเว็บ
- **สตาฟ** (Discord ID ในตาราง `tournament_staff`): จัดการทัวร์ได้ แต่แต่งตั้งสตาฟไม่ได้ ต้อง login ด้วย Discord หรือบัญชีเว็บร้านที่ผูก Discord แล้ว
- ใน Discord: ปุ่ม/คำสั่งจัดทัวร์ใช้ได้กับคนที่มีสิทธิ์ Manage Messages หรือเป็นสตาฟ
