const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_ID = process.env.GIST_ID;

let latestQR = null;
let isConnected = false;
let sock = null;

// --- Gist-based persistent auth state ---
async function useGistAuthState() {
    const authPath = path.join('/tmp', 'auth');
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    // Try to restore from gist
    if (GITHUB_TOKEN && GIST_ID) {
        try {
            const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
                headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'autoelite-bot' }
            });
            const data = await res.json();
            const files = data.files || {};
            for (const [filename, filedata] of Object.entries(files)) {
                if (filename !== 'wa-session.json' || filedata.content === '{"session":"init"}') continue;
                const sessions = JSON.parse(filedata.content);
                for (const [name, content] of Object.entries(sessions)) {
                    fs.writeFileSync(path.join(authPath, name), JSON.stringify(content));
                }
            }
            console.log('Session restored from GitHub Gist');
        } catch (e) {
            console.log('Could not restore session:', e.message);
        }
    }

    const { state, saveCreds: _saveCreds } = await useMultiFileAuthState(authPath);

    const saveCreds = async () => {
        await _saveCreds();
        if (!GITHUB_TOKEN || !GIST_ID) return;
        try {
            const files = fs.readdirSync(authPath);
            const sessions = {};
            for (const file of files) {
                sessions[file] = JSON.parse(fs.readFileSync(path.join(authPath, file), 'utf8'));
            }
            await fetch(`https://api.github.com/gists/${GIST_ID}`, {
                method: 'PATCH',
                headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'autoelite-bot', 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: { 'wa-session.json': { content: JSON.stringify(sessions) } } })
            });
        } catch (e) {
            console.log('Could not save session:', e.message);
        }
    };

    return { state, saveCreds };
}

// --- HTTP Server ---
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
        const jid = req.params.number + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: decodeURIComponent(req.params.message) });
        res.json({ success: true, to: req.params.number });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- Bot ---
async function startBot() {
    const { state, saveCreds } = await useGistAuthState();
    const { version } = await fetchLatestBaileysVersion();
    console.log('Using Baileys version:', version);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['AutoElite Bot', 'Chrome', '1.0.0'],
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) { latestQR = qr; console.log('QR code ready'); }
        if (connection === 'close') {
            isConnected = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('Connection closed, code:', code);
            if (code !== DisconnectReason.loggedOut) startBot();
        }
        if (connection === 'open') {
            isConnected = true;
            latestQR = null;
            console.log('Bot connected!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().trim();
        const jid = msg.key.remoteJid;
        const reply = (text) => sock.sendMessage(jid, { text });

        if (body === '!hello') reply('Hello! Welcome to AutoElite 👋');
        else if (body === '!inventory') reply('Browse our latest inventory:\nhttps://autoelite-uk.netlify.app/#inventory');
        else if (body === '!value') reply('Get a free car valuation:\nhttps://autoelite-uk.netlify.app/valuation.html');
        else if (body === '!contact') reply('Call us: +44 (0) 800 AUTO ELITE\nOr visit: https://autoelite-uk.netlify.app/#contact');
        else if (body === '!help') reply('🚗 *AutoElite Bot*\n\n!hello — Welcome message\n!inventory — View our cars\n!value — Value your car\n!contact — Get in touch\n!help — Show this menu');
    });
}

startBot().catch(console.error);
