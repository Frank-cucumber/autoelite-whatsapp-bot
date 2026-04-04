const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const express = require('express');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

let latestQR = null;
let isConnected = false;

app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send('<h2 style="font-family:sans-serif;color:green;text-align:center;padding:40px">✅ AutoElite WhatsApp Bot is connected and running!</h2>');
    }
    if (!latestQR) {
        return res.send('<h2 style="font-family:sans-serif;text-align:center;padding:40px">⏳ Waiting for QR code... Refresh in a few seconds.</h2>');
    }
    const qrImage = await QRCode.toDataURL(latestQR);
    res.send(`
        <html>
        <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
            <h2>▲ AutoElite WhatsApp Bot</h2>
            <p>Scan this QR code with WhatsApp to activate the bot</p>
            <p style="font-size:12px;color:#888">WhatsApp → Settings → Linked Devices → Link a Device</p>
            <img src="${qrImage}" style="width:300px;height:300px;border-radius:12px"/>
            <p style="font-size:12px;color:#888">Reload this page if the QR expires.</p>
        </body>
        </html>
    `);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const { version } = await fetchLatestBaileysVersion();
    console.log('Using Baileys version:', version);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['AutoElite Bot', 'Chrome', '1.0.0'],
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('QR code generated');
            latestQR = qr;
        }
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

        if (body === '!hello') {
            reply('Hello! Welcome to AutoElite 👋');
        } else if (body === '!inventory') {
            reply('Browse our latest inventory:\nhttps://autoelite-uk.netlify.app/#inventory');
        } else if (body === '!value') {
            reply('Get a free car valuation:\nhttps://autoelite-uk.netlify.app/valuation.html');
        } else if (body === '!contact') {
            reply('Call us: +44 (0) 800 AUTO ELITE\nOr visit: https://autoelite-uk.netlify.app/#contact');
        } else if (body === '!help') {
            reply(
                '🚗 *AutoElite Bot*\n\n' +
                '!hello — Welcome message\n' +
                '!inventory — View our cars\n' +
                '!value — Value your car\n' +
                '!contact — Get in touch\n' +
                '!help — Show this menu'
            );
        }
    });
}

startBot().catch(console.error);
