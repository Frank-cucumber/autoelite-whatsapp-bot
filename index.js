const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_ID = process.env.GIST_ID;

// ── Roles ────────────────────────────────────────────────
const ROLES = {
    directors: ['447383349557'],
    admins: [],
};

const isDirector = (num) => ROLES.directors.includes(num);
const isAdmin = (num) => ROLES.admins.includes(num) || isDirector(num);
const phoneFromJid = (jid) => jid.replace('@s.whatsapp.net', '').replace('@g.us', '');

// ── State ─────────────────────────────────────────────────
let latestQR = null;
let isConnected = false;
let sock = null;
const conversations = {}; // multi-step conversation state per jid
const inquiries = [];     // store recent customer inquiries
let controlGroupJid = null; // AutoElite Control group JID

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
                for (const [name, content] of Object.entries(sessions)) {
                    fs.writeFileSync(path.join(authPath, name), JSON.stringify(content));
                }
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

    // Multi-step: Test Drive Booking
    if (state.step === 'testdrive_name') {
        conversations[jid] = { step: 'testdrive_date', name: body };
        return reply(`Thanks ${body}! 📅 What date would you like to come in? (e.g. Monday 14th April)`);
    }
    if (state.step === 'testdrive_date') {
        conversations[jid] = { ...state, step: 'testdrive_car', date: body };
        return reply(`Great! 🚗 Which car are you interested in test driving?\n\nOur current highlights:\n• Ferrari F8 Tributo — £312,000\n• Lamborghini Huracán — £248,000\n• Porsche 911 GT3 — £182,000\n\nOr tell us what you're looking for.`);
    }
    if (state.step === 'testdrive_car') {
        const booking = { jid, name: state.name, date: state.date, car: body, time: new Date().toISOString() };
        inquiries.push({ type: 'Test Drive', ...booking });
        conversations[jid] = {};
        // Notify director
        if (sock) {
            for (const d of ROLES.directors) {
                sock.sendMessage(d + '@s.whatsapp.net', {
                    text: `🔔 *New Test Drive Booking*\n\nName: ${state.name}\nDate: ${state.date}\nCar: ${body}\nNumber: ${phoneFromJid(jid)}`
                });
            }
        }
        return reply(`✅ *Test drive booked!*\n\nName: ${state.name}\nDate: ${state.date}\nCar: ${body}\n\nOne of our team will confirm your appointment shortly. See you soon! 🚗`);
    }

    // Multi-step: Trade-in / Valuation enquiry
    if (state.step === 'tradein_reg') {
        conversations[jid] = { step: 'tradein_mileage', reg: body.toUpperCase() };
        return reply(`Got it — *${body.toUpperCase()}* 👍\n\nApproximate mileage?`);
    }
    if (state.step === 'tradein_mileage') {
        const enquiry = { type: 'Trade-in', jid, reg: state.reg, mileage: body, time: new Date().toISOString() };
        inquiries.push(enquiry);
        conversations[jid] = {};
        if (sock) {
            for (const d of ROLES.directors) {
                sock.sendMessage(d + '@s.whatsapp.net', {
                    text: `🔔 *New Trade-in Enquiry*\n\nReg: ${state.reg}\nMileage: ${body}\nNumber: ${phoneFromJid(jid)}`
                });
            }
        }
        return reply(`Thanks! We'll look up *${state.reg}* and get back to you with a valuation shortly.\n\nYou can also get an instant estimate at:\nhttps://autoelite-uk.netlify.app/valuation.html`);
    }

    // Natural language matching
    const b = body.toLowerCase();

    if (b.match(/\b(hi|hello|hey|hiya|good morning|good afternoon|good evening)\b/)) {
        return reply(`👋 Hello! Welcome to *AutoElite* — premium car sales.\n\nHow can I help you today?\n\n🚗 *!inventory* — Browse our cars\n📅 *!testdrive* — Book a test drive\n💰 *!finance* — Finance options\n🔄 *!tradein* — Value your car\n📞 *!contact* — Speak to the team\n❓ *!faq* — Common questions`);
    }
    if (b.match(/\b(test.?drive|test.?driv|drive|driving)\b/)) {
        conversations[jid] = { step: 'testdrive_name' };
        return reply(`Great choice! 🚗 Let's book your test drive.\n\nFirst, what's your name?`);
    }
    if (b.match(/\b(price|cost|how much|afford|budget|expensive)\b/)) {
        return reply(`💰 *Our current pricing:*\n\n• Ferrari F8 Tributo — £312,000\n• Lamborghini Huracán — £248,000\n• Porsche 911 GT3 — £182,000\n\nWe also have a wide range of vehicles across all budgets. Visit our full inventory:\nhttps://autoelite-uk.netlify.app/#inventory\n\nInterested in finance? Type *!finance*`);
    }
    if (b.match(/\b(finance|monthly|payment|loan|hp|pcp|lease)\b/)) {
        return reply(`💳 *Finance Options at AutoElite*\n\n✅ PCP (Personal Contract Purchase)\n✅ HP (Hire Purchase)\n✅ Lease / Contract Hire\n✅ 0% deposit options available\n\nWe work with leading UK finance providers. To get a personalised quote, contact our team:\nhttps://autoelite-uk.netlify.app/#contact\n\nOr call: +44 (0) 800 AUTO ELITE`);
    }
    if (b.match(/\b(trade.?in|trade in|part.?ex|part ex|sell my car|selling my car)\b/)) {
        conversations[jid] = { step: 'tradein_reg' };
        return reply(`🔄 *Trade-in / Part Exchange*\n\nWe'll give you a competitive offer for your current car.\n\nWhat's your vehicle registration plate?`);
    }
    if (b.match(/\b(stock|inventory|available|cars|vehicles|models|selection)\b/)) {
        return reply(`🚗 *Current Highlights*\n\n• Ferrari F8 Tributo — 710HP — £312,000\n• Lamborghini Huracán — 631HP — £248,000\n• Porsche 911 GT3 — 502HP — £182,000\n\nView full inventory:\nhttps://autoelite-uk.netlify.app/#inventory`);
    }
    if (b.match(/\b(open|opening|hours|when|time|times|close|closing)\b/)) {
        return reply(`🕐 *AutoElite Opening Hours*\n\nMon–Fri: 9:00am – 6:00pm\nSaturday: 9:00am – 5:00pm\nSunday: 10:00am – 4:00pm\n\nBank holidays may vary. Call ahead to confirm:\n+44 (0) 800 AUTO ELITE`);
    }
    if (b.match(/\b(location|where|address|find you|directions|postcode)\b/)) {
        return reply(`📍 *AutoElite Showroom*\n\nAutoElite, United Kingdom\n\nFor directions, visit:\nhttps://autoelite-uk.netlify.app/#contact`);
    }
    if (b.match(/\b(warranty|guarantee|cover|breakdown|protection)\b/)) {
        return reply(`🛡 *Warranty & Protection*\n\nAll AutoElite vehicles come with:\n✅ 12-month warranty as standard\n✅ RAC breakdown cover\n✅ Extended warranty options available\n\nSpeak to our team for full details:\nhttps://autoelite-uk.netlify.app/#contact`);
    }
    if (b.match(/\b(valuation|value|worth|estimate)\b/)) {
        return reply(`💡 *Free Car Valuation*\n\nGet an instant estimate for your car:\nhttps://autoelite-uk.netlify.app/valuation.html\n\nOr type *!tradein* and we'll get you a guaranteed offer.`);
    }
    if (b.match(/\b(contact|call|phone|speak|talk|email|human|person|agent|team)\b/)) {
        return reply(`📞 *Contact AutoElite*\n\nPhone: +44 (0) 800 AUTO ELITE\nWeb: https://autoelite-uk.netlify.app/#contact\n\nOur team is available:\nMon–Fri 9am–6pm\nSat 9am–5pm\nSun 10am–4pm`);
    }
    if (b.match(/\b(thank|thanks|thank you|cheers|brilliant|great|awesome|perfect)\b/)) {
        return reply(`You're welcome! 😊 Is there anything else I can help you with?\n\nType *!help* to see all options.`);
    }

    // Fallback — log as inquiry and notify director
    inquiries.push({ type: 'General Inquiry', jid, message: body, time: new Date().toISOString() });
    if (sock) {
        for (const d of ROLES.directors) {
            sock.sendMessage(d + '@s.whatsapp.net', {
                text: `🔔 *New Customer Inquiry*\n\nFrom: ${phoneFromJid(jid)}\nMessage: "${body}"\n\nReply directly or use: !notify ${phoneFromJid(jid)} <your reply>`
            });
        }
    }
    return reply(`Thanks for your message! 👋 A member of our team will get back to you shortly.\n\nIn the meantime, you can also:\n🚗 Browse inventory: https://autoelite-uk.netlify.app/#inventory\n📞 Call us: +44 (0) 800 AUTO ELITE`);
}

// ── Director / Admin Command Handler ─────────────────────
async function handleDirector(jid, body, reply) {
    const parts = body.split(' ');
    const cmd = parts[0].toLowerCase();

    if (cmd === '!help' || cmd === '!commands') {
        return reply(`👑 *Director Commands*\n\n!inquiries — View recent inquiries\n!notify <number> <msg> — Message a customer\n!buyer <number> <car> — Tell customer their car sold\n!broadcast <msg> — Message all recent contacts\n!addadmin <number> — Add an admin\n!removeadmin <number> — Remove an admin\n!creategroup <name> — Create a WhatsApp group\n!clearinquiries — Clear inquiry log\n\n👤 *Customer Commands also available*`);
    }
    if (cmd === '!inquiries') {
        if (inquiries.length === 0) return reply('No inquiries yet.');
        const recent = inquiries.slice(-10).reverse();
        const text = recent.map((i, n) => `${n + 1}. [${i.type}] ${phoneFromJid(i.jid || '')} — "${i.message || i.car || i.reg || ''}" — ${new Date(i.time).toLocaleString('en-GB')}`).join('\n');
        return reply(`📋 *Recent Inquiries (last 10)*\n\n${text}`);
    }
    if (cmd === '!clearinquiries') {
        inquiries.length = 0;
        return reply('✅ Inquiry log cleared.');
    }
    if (cmd === '!notify') {
        const number = parts[1];
        const message = parts.slice(2).join(' ');
        if (!number || !message) return reply('Usage: !notify <number> <message>\nExample: !notify 447911123456 Your car is ready for collection!');
        await sock.sendMessage(number + '@s.whatsapp.net', { text: message });
        return reply(`✅ Message sent to ${number}`);
    }
    if (cmd === '!buyer') {
        const number = parts[1];
        const car = parts.slice(2).join(' ');
        if (!number || !car) return reply('Usage: !buyer <number> <car>\nExample: !buyer 447911123456 Porsche 911 GT3');
        await sock.sendMessage(number + '@s.whatsapp.net', {
            text: `🎉 *Great news from AutoElite!*\n\nWe have a buyer interested in your *${car}*!\n\nPlease contact us as soon as possible to proceed:\n📞 +44 (0) 800 AUTO ELITE\n🌐 https://autoelite-uk.netlify.app/#contact`
        });
        return reply(`✅ Buyer notification sent to ${number} for ${car}`);
    }
    if (cmd === '!broadcast') {
        const message = parts.slice(1).join(' ');
        if (!message) return reply('Usage: !broadcast <message>');
        const contacts = [...new Set(inquiries.map(i => i.jid).filter(Boolean))];
        if (contacts.length === 0) return reply('No contacts to broadcast to yet.');
        let sent = 0;
        for (const contact of contacts) {
            try { await sock.sendMessage(contact, { text: `📢 *AutoElite:* ${message}` }); sent++; } catch {}
        }
        return reply(`✅ Broadcast sent to ${sent} contact(s)`);
    }
    if (cmd === '!addadmin') {
        const number = parts[1];
        if (!number) return reply('Usage: !addadmin <number>');
        if (!ROLES.admins.includes(number)) ROLES.admins.push(number);
        return reply(`✅ ${number} added as admin`);
    }
    if (cmd === '!removeadmin') {
        const number = parts[1];
        ROLES.admins = ROLES.admins.filter(n => n !== number);
        return reply(`✅ ${number} removed as admin`);
    }
    if (cmd === '!creategroup') {
        const name = parts.slice(1).join(' ');
        if (!name) return reply('Usage: !creategroup <name>');
        try {
            const group = await sock.groupCreate(name, [jid]);
            return reply(`✅ Group "${name}" created!\nInvite others with: !groupinvite`);
        } catch (e) {
            return reply(`❌ Could not create group: ${e.message}`);
        }
    }

    // Director can also use customer commands
    return handleCustomer(jid, body, reply);
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

app.get('/inquiries', (req, res) => res.json(inquiries));

app.get('/simulate/:number/:message', async (req, res) => {
    const jid = req.params.number + '@s.whatsapp.net';
    const body = decodeURIComponent(req.params.message);
    let botReply = null;
    const reply = async (text) => {
        botReply = text;
        // Send bot's response to director so they can see it
        if (sock) await sock.sendMessage(ROLES.directors[0] + '@s.whatsapp.net', {
            text: `🧪 *Simulate Test*\nCustomer (${req.params.number}): "${body}"\n\nBot reply:\n${text}`
        });
    };
    const phone = req.params.number;
    if (isDirector(phone)) await handleDirector(jid, body, reply);
    else if (isAdmin(phone)) await handleDirector(jid, body, reply);
    else await handleCustomer(jid, body, reply);
    res.json({ success: true, from: req.params.number, message: body, reply: botReply });
});

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
            // Create control group if it doesn't exist yet
            setTimeout(async () => {
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    const existing = Object.values(groups).find(g => g.subject === 'AutoElite Control');
                    if (existing) {
                        controlGroupJid = existing.id;
                        console.log('Control group found:', controlGroupJid);
                        await sock.sendMessage(controlGroupJid, { text: '✅ AutoElite Bot connected and ready!\n\nType !commands to see director controls.' });
                    } else {
                        const group = await sock.groupCreate('AutoElite Control', []);
                        controlGroupJid = group.gid;
                        console.log('Control group created:', controlGroupJid);
                        await sock.sendMessage(controlGroupJid, { text: '👑 *AutoElite Control Panel*\n\nWelcome! This is your private bot control group.\n\nType !commands to get started.' });
                    }
                } catch (e) { console.log('Group setup error:', e.message); }
            }, 3000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        const msg = messages[0];
        if (!msg.message) return;

        // Handle control group messages and self-commands
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
