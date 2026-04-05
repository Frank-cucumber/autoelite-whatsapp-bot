const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const express = require('express');
const pino = require('pino');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_ID = process.env.GIST_ID;

// ── Roles ─────────────────────────────────────────────────
const ROLES = { directors: ['447383349557'], admins: [] };
const isDirector = (num) => ROLES.directors.includes(num);
const isAdmin = (num) => ROLES.admins.includes(num) || isDirector(num);
const phoneFromJid = (jid) => jid.replace('@s.whatsapp.net', '').replace('@g.us', '');

// ── Business Hours (UK) ───────────────────────────────────
function isOpenNow() {
    const now = new Date(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }));
    const day = now.getDay(); // 0=Sun, 1=Mon ... 6=Sat
    const hour = now.getHours();
    if (day >= 1 && day <= 5) return hour >= 9 && hour < 18; // Mon-Fri 9-6
    if (day === 6) return hour >= 9 && hour < 17;             // Sat 9-5
    if (day === 0) return hour >= 10 && hour < 16;            // Sun 10-4
    return false;
}

function nextOpenTime() {
    const now = new Date(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }));
    const day = now.getDay();
    if (day === 0) return 'Monday at 9:00am';
    if (day === 6) return 'Sunday at 10:00am';
    return 'tomorrow at 9:00am';
}

// ── State ─────────────────────────────────────────────────
let latestQR = null;
let isConnected = false;
let sock = null;
let controlGroupJid = null;
const conversations = {};
const inquiries = [];
const leads = [];      // captured leads
const bookings = [];   // test drive bookings

// ── Lead capture ──────────────────────────────────────────
function captureLead(jid, data) {
    const phone = phoneFromJid(jid);
    const existing = leads.find(l => l.phone === phone);
    if (existing) {
        Object.assign(existing, data, { lastContact: new Date().toISOString() });
    } else {
        leads.push({ phone, jid, capturedAt: new Date().toISOString(), lastContact: new Date().toISOString(), status: 'new', followedUp: false, ...data });
    }
}

// ── Gist Auth State ───────────────────────────────────────
async function useGistAuthState() {
    const authPath = path.join('/tmp', 'auth');
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });
    if (GITHUB_TOKEN && GIST_ID) {
        try {
            const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
                headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'autoelite-bot' }
            });
            const data = await res.json();
            const file = data.files?.['wa-session.json'];
            if (file && file.content !== '{"session":"init"}') {
                const sessions = JSON.parse(file.content);
                for (const [name, content] of Object.entries(sessions))
                    fs.writeFileSync(path.join(authPath, name), JSON.stringify(content));
                console.log('Session restored from GitHub Gist');
            }
        } catch (e) { console.log('Could not restore session:', e.message); }
    }
    const { state, saveCreds: _saveCreds } = await useMultiFileAuthState(authPath);
    const saveCreds = async () => {
        await _saveCreds();
        if (!GITHUB_TOKEN || !GIST_ID) return;
        try {
            const files = fs.readdirSync(authPath);
            const sessions = {};
            for (const f of files) sessions[f] = JSON.parse(fs.readFileSync(path.join(authPath, f), 'utf8'));
            await fetch(`https://api.github.com/gists/${GIST_ID}`, {
                method: 'PATCH',
                headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'autoelite-bot', 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: { 'wa-session.json': { content: JSON.stringify(sessions) } } })
            });
        } catch (e) { console.log('Could not save session:', e.message); }
    };
    return { state, saveCreds };
}

// ── Customer Conversation Handler ─────────────────────────
async function handleCustomer(jid, body, reply) {
    const state = conversations[jid] || {};
    const phone = phoneFromJid(jid);

    // Out of hours auto-reply (only once per session)
    if (!isOpenNow() && !state.outOfHoursNotified) {
        conversations[jid] = { ...state, outOfHoursNotified: true };
        captureLead(jid, { message: body });
        return reply(`Thanks for contacting *AutoElite*! 🚗\n\nWe're currently closed but we'll get back to you as soon as we open — *${nextOpenTime()}*.\n\nIn the meantime:\n🌐 https://autoelite-uk.netlify.app\n📋 Browse inventory: https://autoelite-uk.netlify.app/#inventory\n\nLeave your message and we'll reply first thing!`);
    }

    // Multi-step: Lead capture (name)
    if (state.step === 'capture_name') {
        conversations[jid] = { step: 'capture_interest', name: body };
        captureLead(jid, { name: body });
        return reply(`Nice to meet you *${body}*! 😊\n\nWhat are you looking for today?\n\n🚗 Buying a car\n💰 Finance options\n🔄 Part exchange / trade-in\n📅 Book a test drive\n💡 Car valuation`);
    }

    // Multi-step: Test Drive
    if (state.step === 'testdrive_name') {
        conversations[jid] = { step: 'testdrive_date', name: body };
        captureLead(jid, { name: body });
        return reply(`Thanks ${body}! 📅 What date works for you? (e.g. Monday 14th April)`);
    }
    if (state.step === 'testdrive_date') {
        conversations[jid] = { ...state, step: 'testdrive_car', date: body };
        return reply(`Great! 🚗 Which car are you interested in?\n\n• Ferrari F8 Tributo — £312,000\n• Lamborghini Huracán — £248,000\n• Porsche 911 GT3 — £182,000\n\nOr describe what you're looking for.`);
    }
    if (state.step === 'testdrive_car') {
        const booking = { jid, phone, name: state.name, date: state.date, car: body, bookedAt: new Date().toISOString(), reminded: false };
        bookings.push(booking);
        captureLead(jid, { name: state.name, interest: `Test drive: ${body}`, status: 'booked' });
        conversations[jid] = {};
        if (sock) {
            for (const d of ROLES.directors) {
                sock.sendMessage(d + '@s.whatsapp.net', {
                    text: `🔔 *New Test Drive Booking*\n\nName: ${state.name}\nDate: ${state.date}\nCar: ${body}\nNumber: ${phone}`
                });
            }
        }
        return reply(`✅ *Test drive booked!*\n\nName: ${state.name}\nDate: ${state.date}\nCar: ${body}\n\nWe'll send you a reminder the day before. See you soon! 🚗`);
    }

    // Multi-step: Trade-in
    if (state.step === 'tradein_reg') {
        conversations[jid] = { step: 'tradein_mileage', reg: body.toUpperCase() };
        return reply(`Got it — *${body.toUpperCase()}* 👍\n\nApproximate mileage?`);
    }
    if (state.step === 'tradein_mileage') {
        inquiries.push({ type: 'Trade-in', jid, phone, reg: state.reg, mileage: body, time: new Date().toISOString() });
        captureLead(jid, { interest: `Trade-in: ${state.reg}`, status: 'enquiry' });
        conversations[jid] = {};
        if (sock) {
            for (const d of ROLES.directors) {
                sock.sendMessage(d + '@s.whatsapp.net', { text: `🔔 *New Trade-in Enquiry*\n\nReg: ${state.reg}\nMileage: ${body}\nNumber: ${phone}` });
            }
        }
        return reply(`Thanks! We'll value *${state.reg}* and get back to you shortly.\n\nInstant estimate: https://autoelite-uk.netlify.app/valuation.html`);
    }

    // Natural language matching
    const b = body.toLowerCase();

    if (b.match(/\b(hi|hello|hey|hiya|morning|afternoon|evening)\b/)) {
        captureLead(jid, { firstContact: new Date().toISOString() });
        if (!state.welcomed) {
            conversations[jid] = { ...state, welcomed: true, step: 'capture_name' };
            return reply(`👋 Welcome to *AutoElite* — premium car sales!\n\nI'm the AutoElite assistant. What's your name?`);
        }
        return reply(`Welcome back! 😊 How can I help you today?\n\nType *!help* to see all options.`);
    }
    if (b.match(/\b(test.?drive|test.?driv)\b/)) {
        conversations[jid] = { step: 'testdrive_name' };
        return reply(`Let's book your test drive! 🚗\n\nWhat's your name?`);
    }
    if (b.match(/\b(price|cost|how much|afford|budget)\b/)) {
        captureLead(jid, { interest: 'Pricing enquiry', status: 'enquiry' });
        return reply(`💰 *Current Pricing*\n\n• Ferrari F8 Tributo — £312,000\n• Lamborghini Huracán — £248,000\n• Porsche 911 GT3 — £182,000\n\nFull inventory: https://autoelite-uk.netlify.app/#inventory\n\nInterested in finance? Type *!finance*`);
    }
    if (b.match(/\b(finance|monthly|payment|loan|hp|pcp|lease)\b/)) {
        captureLead(jid, { interest: 'Finance enquiry', status: 'enquiry' });
        return reply(`💳 *Finance Options*\n\n✅ PCP — Personal Contract Purchase\n✅ HP — Hire Purchase\n✅ Lease / Contract Hire\n✅ 0% deposit options\n\nGet a personalised quote:\nhttps://autoelite-uk.netlify.app/#contact`);
    }
    if (b.match(/\b(trade.?in|part.?ex|sell my car)\b/)) {
        conversations[jid] = { step: 'tradein_reg' };
        return reply(`🔄 *Trade-in / Part Exchange*\n\nWhat's your vehicle registration?`);
    }
    if (b.match(/\b(stock|inventory|available|cars|vehicles|models)\b/)) {
        return reply(`🚗 *Featured Vehicles*\n\n• Ferrari F8 Tributo — 710HP — £312,000\n• Lamborghini Huracán — 631HP — £248,000\n• Porsche 911 GT3 — 502HP — £182,000\n\nhttps://autoelite-uk.netlify.app/#inventory`);
    }
    if (b.match(/\b(open|hours|when|close|closing|time)\b/)) {
        return reply(`🕐 *Opening Hours*\n\nMon–Fri: 9am – 6pm\nSaturday: 9am – 5pm\nSunday: 10am – 4pm`);
    }
    if (b.match(/\b(location|where|address|directions)\b/)) {
        return reply(`📍 *AutoElite Showroom*\nhttps://autoelite-uk.netlify.app/#contact`);
    }
    if (b.match(/\b(warranty|guarantee|cover|breakdown)\b/)) {
        return reply(`🛡 *Warranty*\n\n✅ 12-month warranty included\n✅ RAC breakdown cover\n✅ Extended options available\n\nhttps://autoelite-uk.netlify.app/#contact`);
    }
    if (b.match(/\b(valuation|value|worth)\b/)) {
        return reply(`💡 *Free Valuation*\nhttps://autoelite-uk.netlify.app/valuation.html\n\nOr type *!tradein* for a guaranteed offer.`);
    }
    if (b.match(/\b(contact|call|speak|talk|email|human|agent|team)\b/)) {
        return reply(`📞 *Contact AutoElite*\n\nPhone: +44 (0) 800 AUTO ELITE\nWeb: https://autoelite-uk.netlify.app/#contact\n\nMon–Fri 9am–6pm | Sat 9am–5pm | Sun 10am–4pm`);
    }
    if (b.match(/\b(thank|thanks|cheers|brilliant|great|perfect)\b/)) {
        return reply(`You're welcome! 😊 Anything else I can help with?\n\nType *!help* to see all options.`);
    }
    if (b === '!help') {
        return reply(`🚗 *AutoElite Bot*\n\n!inventory — Browse cars\n!testdrive — Book a test drive\n!finance — Finance options\n!tradein — Value your car\n!contact — Speak to the team\n!hours — Opening times`);
    }
    if (b === '!inventory') return reply(`🚗 https://autoelite-uk.netlify.app/#inventory`);
    if (b === '!contact') return reply(`📞 +44 (0) 800 AUTO ELITE\n🌐 https://autoelite-uk.netlify.app/#contact`);
    if (b === '!hours') return reply(`🕐 Mon–Fri 9am–6pm | Sat 9am–5pm | Sun 10am–4pm`);
    if (b === '!testdrive') { conversations[jid] = { step: 'testdrive_name' }; return reply(`What's your name?`); }
    if (b === '!tradein') { conversations[jid] = { step: 'tradein_reg' }; return reply(`What's your vehicle registration?`); }

    // Fallback — log and notify director
    inquiries.push({ type: 'General', jid, phone, message: body, time: new Date().toISOString() });
    captureLead(jid, { lastMessage: body });
    if (sock) {
        for (const d of ROLES.directors) {
            sock.sendMessage(d + '@s.whatsapp.net', {
                text: `🔔 *New Inquiry*\n\nFrom: ${phone}\nMessage: "${body}"\n\nReply: !notify ${phone} <message>`
            });
        }
    }
    return reply(`Thanks for your message! 👋 Our team will get back to you shortly.\n\n📞 +44 (0) 800 AUTO ELITE\n🌐 https://autoelite-uk.netlify.app`);
}

// ── Director Command Handler ───────────────────────────────
async function handleDirector(jid, body, reply) {
    const parts = body.split(' ');
    const cmd = parts[0].toLowerCase();

    if (cmd === '!commands' || cmd === '!help') {
        return reply(`👑 *Director Commands*\n\n📋 *Inquiries*\n!inquiries — View recent inquiries\n!leads — View captured leads\n!bookings — View test drive bookings\n\n📣 *Messaging*\n!notify <number> <msg> — Message a customer\n!buyer <number> <car> — Buyer found notification\n!broadcast <msg> — Message all leads\n!reminder <number> <name> <date> <car> — Send booking reminder\n\n👥 *Teams*\n!addadmin <number> — Add admin\n!removeadmin <number> — Remove admin\n!creategroup <name> — Create group\n\n📊 *Reports*\n!summary — Today's summary`);
    }
    if (cmd === '!inquiries') {
        if (!inquiries.length) return reply('No inquiries yet.');
        return reply(`📋 *Recent Inquiries*\n\n` + inquiries.slice(-10).reverse().map((i, n) => `${n + 1}. [${i.type}] ${i.phone} — "${i.message || i.car || i.reg || ''}" — ${new Date(i.time).toLocaleString('en-GB')}`).join('\n'));
    }
    if (cmd === '!leads') {
        if (!leads.length) return reply('No leads captured yet.');
        return reply(`👤 *Leads (${leads.length})*\n\n` + leads.slice(-10).reverse().map((l, n) => `${n + 1}. ${l.name || 'Unknown'} — ${l.phone} — ${l.interest || 'browsing'} — ${l.status}`).join('\n'));
    }
    if (cmd === '!bookings') {
        if (!bookings.length) return reply('No test drives booked yet.');
        return reply(`📅 *Test Drive Bookings*\n\n` + bookings.map((b, n) => `${n + 1}. ${b.name} — ${b.car} — ${b.date} — ${b.phone}`).join('\n'));
    }
    if (cmd === '!summary') {
        const today = new Date().toLocaleDateString('en-GB');
        const todayInquiries = inquiries.filter(i => i.time.startsWith(new Date().toISOString().slice(0, 10)));
        const todayLeads = leads.filter(l => l.capturedAt?.startsWith(new Date().toISOString().slice(0, 10)));
        const todayBookings = bookings.filter(b => b.bookedAt?.startsWith(new Date().toISOString().slice(0, 10)));
        return reply(`📊 *AutoElite Daily Summary — ${today}*\n\n🔔 Inquiries today: ${todayInquiries.length}\n👤 New leads: ${todayLeads.length}\n📅 Test drives booked: ${todayBookings.length}\n📋 Total leads: ${leads.length}\n\nType !leads or !bookings for details.`);
    }
    if (cmd === '!notify') {
        const number = parts[1]; const message = parts.slice(2).join(' ');
        if (!number || !message) return reply('Usage: !notify <number> <message>');
        await sock.sendMessage(number + '@s.whatsapp.net', { text: message });
        const lead = leads.find(l => l.phone === number);
        if (lead) lead.lastContact = new Date().toISOString();
        return reply(`✅ Message sent to ${number}`);
    }
    if (cmd === '!buyer') {
        const number = parts[1]; const car = parts.slice(2).join(' ');
        if (!number || !car) return reply('Usage: !buyer <number> <car>');
        await sock.sendMessage(number + '@s.whatsapp.net', {
            text: `🎉 *Great news from AutoElite!*\n\nWe have a buyer interested in your *${car}*!\n\nPlease contact us ASAP:\n📞 +44 (0) 800 AUTO ELITE\n🌐 https://autoelite-uk.netlify.app/#contact`
        });
        return reply(`✅ Buyer notification sent to ${number}`);
    }
    if (cmd === '!reminder') {
        const number = parts[1]; const name = parts[2]; const date = parts[3]; const car = parts.slice(4).join(' ');
        if (!number || !name) return reply('Usage: !reminder <number> <name> <date> <car>');
        await sock.sendMessage(number + '@s.whatsapp.net', {
            text: `🚗 *AutoElite Reminder*\n\nHi ${name}! Just a reminder that your test drive is booked for *${date}*.\n\nCar: ${car}\n\nSee you soon! If you need to reschedule:\n📞 +44 (0) 800 AUTO ELITE`
        });
        return reply(`✅ Reminder sent to ${number}`);
    }
    if (cmd === '!broadcast') {
        const message = parts.slice(1).join(' ');
        if (!message) return reply('Usage: !broadcast <message>');
        const contacts = [...new Set(leads.map(l => l.jid).filter(Boolean))];
        if (!contacts.length) return reply('No leads to broadcast to yet.');
        let sent = 0;
        for (const contact of contacts) {
            try { await sock.sendMessage(contact, { text: `📢 *AutoElite:* ${message}` }); sent++; } catch {}
        }
        return reply(`✅ Broadcast sent to ${sent} lead(s)`);
    }
    if (cmd === '!addadmin') {
        const number = parts[1];
        if (!ROLES.admins.includes(number)) ROLES.admins.push(number);
        return reply(`✅ ${number} added as admin`);
    }
    if (cmd === '!removeadmin') {
        ROLES.admins = ROLES.admins.filter(n => n !== parts[1]);
        return reply(`✅ ${parts[1]} removed as admin`);
    }
    if (cmd === '!creategroup') {
        const name = parts.slice(1).join(' ');
        if (!name) return reply('Usage: !creategroup <name>');
        try {
            const group = await sock.groupCreate(name, []);
            return reply(`✅ Group "${name}" created!`);
        } catch (e) { return reply(`❌ ${e.message}`); }
    }

    return handleCustomer(jid, body, reply);
}

// ── Scheduled Automations ─────────────────────────────────
function startAutomations() {
    // Daily summary — 8:00am UK every day
    cron.schedule('0 8 * * *', async () => {
        if (!sock || !isConnected) return;
        const today = new Date().toLocaleDateString('en-GB');
        const todayInquiries = inquiries.filter(i => i.time?.startsWith(new Date().toISOString().slice(0, 10)));
        const todayLeads = leads.filter(l => l.capturedAt?.startsWith(new Date().toISOString().slice(0, 10)));
        const todayBookings = bookings.filter(b => b.bookedAt?.startsWith(new Date().toISOString().slice(0, 10)));
        for (const d of ROLES.directors) {
            sock.sendMessage(d + '@s.whatsapp.net', {
                text: `☀️ *Good morning! AutoElite Daily Summary — ${today}*\n\n🔔 Inquiries yesterday: ${todayInquiries.length}\n👤 New leads: ${todayLeads.length}\n📅 Test drives booked: ${todayBookings.length}\n📋 Total leads: ${leads.length}\n\nType !leads or !bookings for details. Have a great day! 🚗`
            });
        }
    }, { timezone: 'Europe/London' });

    // Test drive reminders — check every hour
    cron.schedule('0 * * * *', async () => {
        if (!sock || !isConnected) return;
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).toLowerCase();
        for (const booking of bookings) {
            if (booking.reminded) continue;
            if (booking.date.toLowerCase().includes(tomorrowStr.split(',')[0])) {
                try {
                    await sock.sendMessage(booking.jid, {
                        text: `🚗 *AutoElite Reminder*\n\nHi ${booking.name}! Just a reminder that your test drive is tomorrow — *${booking.date}*.\n\nCar: ${booking.car}\n\nSee you soon! To reschedule:\n📞 +44 (0) 800 AUTO ELITE`
                    });
                    booking.reminded = true;
                } catch (e) { console.log('Reminder failed:', e.message); }
            }
        }
    }, { timezone: 'Europe/London' });

    // Follow-up leads — check daily at 9am for leads with no contact in 3 days
    cron.schedule('0 9 * * *', async () => {
        if (!sock || !isConnected) return;
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        const staleLeads = leads.filter(l => l.lastContact < threeDaysAgo && !l.followedUp && l.status !== 'closed');
        for (const lead of staleLeads) {
            try {
                await sock.sendMessage(lead.jid, {
                    text: `👋 Hi ${lead.name || 'there'}! It's AutoElite — we just wanted to check in.\n\nAre you still interested in ${lead.interest || 'finding your perfect car'}? We'd love to help! 🚗\n\nReply here or call us:\n📞 +44 (0) 800 AUTO ELITE`
                });
                lead.followedUp = true;
                lead.lastContact = new Date().toISOString();
            } catch (e) { console.log('Follow-up failed:', e.message); }
        }
        if (staleLeads.length > 0) {
            for (const d of ROLES.directors) {
                sock.sendMessage(d + '@s.whatsapp.net', { text: `📣 *Follow-up sent to ${staleLeads.length} lead(s)* who hadn't been contacted in 3+ days.` });
            }
        }
    }, { timezone: 'Europe/London' });

    console.log('Automations scheduled: daily summary, reminders, follow-ups');
}

// ── HTTP Server ───────────────────────────────────────────
app.get('/', async (req, res) => {
    if (isConnected) return res.send('<h2 style="font-family:sans-serif;color:green;text-align:center;padding:40px">✅ AutoElite WhatsApp Bot is connected and running!</h2>');
    if (!latestQR) return res.send('<h2 style="font-family:sans-serif;text-align:center;padding:40px">⏳ Waiting for QR code... Refresh in a few seconds.</h2>');
    const qrImage = await QRCode.toDataURL(latestQR);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
        <h2>▲ AutoElite WhatsApp Bot</h2>
        <p>Scan this QR code with WhatsApp to activate the bot</p>
        <p style="font-size:12px;color:#888">WhatsApp → Settings → Linked Devices → Link a Device</p>
        <img src="${qrImage}" style="width:300px;height:300px;border-radius:12px"/>
    </body></html>`);
});

app.get('/send/:number/:message', async (req, res) => {
    if (!isConnected || !sock) return res.json({ error: 'Bot not connected' });
    try {
        await sock.sendMessage(req.params.number + '@s.whatsapp.net', { text: decodeURIComponent(req.params.message) });
        res.json({ success: true, to: req.params.number });
    } catch (e) { res.json({ error: e.message }); }
});

app.get('/simulate/:number/:message', async (req, res) => {
    if (!isConnected || !sock) return res.json({ error: 'Bot not connected' });
    const jid = req.params.number + '@s.whatsapp.net';
    const body = decodeURIComponent(req.params.message);
    let botReply = null;
    const reply = async (text) => {
        botReply = text;
        if (sock) await sock.sendMessage(ROLES.directors[0] + '@s.whatsapp.net', {
            text: `🧪 *Simulate*\nCustomer (${req.params.number}): "${body}"\n\nBot reply:\n${text}`
        });
    };
    const phone = req.params.number;
    if (isDirector(phone)) await handleDirector(jid, body, reply);
    else if (isAdmin(phone)) await handleDirector(jid, body, reply);
    else await handleCustomer(jid, body, reply);
    res.json({ success: true, from: phone, message: body, reply: botReply });
});

app.get('/inquiries', (req, res) => res.json(inquiries));
app.get('/leads', (req, res) => res.json(leads));
app.get('/bookings', (req, res) => res.json(bookings));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ── Bot ───────────────────────────────────────────────────
async function startBot() {
    const { state, saveCreds } = await useGistAuthState();
    const { version } = await fetchLatestBaileysVersion();
    console.log('Using Baileys version:', version);

    sock = makeWASocket({
        version, auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['AutoElite Bot', 'Chrome', '1.0.0'],
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) { latestQR = qr; console.log('QR code ready'); }
        if (connection === 'close') {
            isConnected = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) startBot();
        }
        if (connection === 'open') {
            isConnected = true;
            latestQR = null;
            console.log('Bot connected!');
            startAutomations();
            setTimeout(async () => {
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    const existing = Object.values(groups).find(g => g.subject === 'AutoElite Control');
                    if (existing) {
                        controlGroupJid = existing.id;
                        await sock.sendMessage(controlGroupJid, { text: '✅ AutoElite Bot reconnected!\n\nType !commands to see director controls.' });
                    } else {
                        const group = await sock.groupCreate('AutoElite Control', []);
                        controlGroupJid = group.gid;
                        await sock.sendMessage(controlGroupJid, { text: '👑 *AutoElite Control Panel*\n\nWelcome! Type !commands to get started.' });
                    }
                } catch (e) { console.log('Group setup error:', e.message); }
            }, 3000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const selfBody = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const isControlGroup = msg.key.remoteJid === controlGroupJid;
        if ((msg.key.fromMe || isControlGroup) && selfBody.startsWith('!')) {
            const selfJid = msg.key.remoteJid;
            const selfReply = (text) => sock.sendMessage(selfJid, { text });
            return handleDirector(selfJid, selfBody, selfReply);
        }

        if (type !== 'notify') return;
        if (msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        if (!body) return;

        const phone = phoneFromJid(jid);
        const reply = (text) => sock.sendMessage(jid, { text });

        if (isDirector(phone)) return handleDirector(jid, body, reply);
        if (isAdmin(phone)) return handleDirector(jid, body, reply);
        return handleCustomer(jid, body, reply);
    });
}

startBot().catch(console.error);
