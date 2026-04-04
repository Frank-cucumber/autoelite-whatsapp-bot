const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('Scan this QR code with WhatsApp:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        }
        if (connection === 'open') {
            console.log('AutoElite WhatsApp bot is ready!');
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
            reply('Browse our latest inventory here:\nhttps://autoelite-uk.netlify.app/#inventory');
        } else if (body === '!value') {
            reply('Get a free car valuation here:\nhttps://autoelite-uk.netlify.app/valuation.html');
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

startBot();
