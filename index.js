const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', (qr) => {
    console.log('Scan this QR code with WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('WhatsApp bot is ready!');
});

client.on('message', async (msg) => {
    const body = msg.body.toLowerCase();

    if (body === '!hello') {
        msg.reply('Hello! Welcome to AutoElite 👋');
    } else if (body === '!inventory') {
        msg.reply('Browse our latest inventory here: https://autoelite-uk.netlify.app/#inventory');
    } else if (body === '!value') {
        msg.reply('Get a free car valuation here: https://autoelite-uk.netlify.app/valuation.html');
    } else if (body === '!contact') {
        msg.reply('Call us: +44 (0) 800 AUTO ELITE\nOr visit: https://autoelite-uk.netlify.app/#contact');
    } else if (body === '!help') {
        msg.reply(
            '🚗 *AutoElite Bot*\n\n' +
            '!hello — Welcome message\n' +
            '!inventory — View our cars\n' +
            '!value — Value your car\n' +
            '!contact — Get in touch\n' +
            '!help — Show this menu'
        );
    }
});

client.initialize();
