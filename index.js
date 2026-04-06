const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const express = require('express');
const pino = require('pino');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ── Modules ───────────────────────────────────────────────
const {
    ROLES, leads, bookings, inquiries, deposits, feedback, blacklist, inventory,
    customers, STAGES,
    getCustomer, updateCustomer, addHistory,
    detectBuyingSignals, isBlacklisted,
    getAvailableInventory, findVehicle, addWatcher,
} = require('./modules/data');

const { isOpenNow, nextOpenTime, getUKHour, calcMonthlyPayment, formatCurrency } = require('./modules/hours');
const { getAIReply, classifyIntent } = require('./modules/ai');

// ── App Setup ─────────────────────────────────────────────
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_ID = process.env.GIST_ID;

let latestQR = null;
let isConnected = false;
let sock = null;
let controlGroupJid = null;

// ── Helpers ───────────────────────────────────────────────
const phoneFromJid = (jid) => jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
const isDirector = (num) => ROLES.directors.includes(num);
const isAdmin = (num) => ROLES.admins.includes(num) || isDirector(num);

function sendToDirectors(text) {
    if (!sock || !isConnected) return;
    for (const d of ROLES.directors) {
        sock.sendMessage(d + '@s.whatsapp.net', { text }).catch(() => {});
    }
}

function captureLead(jid, data) {
    const phone = phoneFromJid(jid);
    const existing = leads.find(l => l.phone === phone);
    if (existing) {
        Object.assign(existing, data, { lastContact: new Date().toISOString() });
    } else {
        leads.push({
            phone, jid,
            capturedAt: new Date().toISOString(),
            lastContact: new Date().toISOString(),
            status: 'new',
            followedUp: false,
            ...data,
        });
    }
}

function inventoryList(vehicles) {
    return vehicles.map((v, i) =>
        `${i + 1}. *${v.name}*\n   ${formatCurrency(v.price)} | ${v.hp}HP | 0-60 in ${v.speed} | ${v.miles.toLocaleString()} miles | ${v.colour}`
    ).join('\n\n');
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
                console.log('Session restored from Gist');
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

// ── Customer Handler (24/7 AI Agent) ─────────────────────
async function handleCustomer(jid, body, reply) {
    const phone = phoneFromJid(jid);

    // ── Blacklist check ───────────────────────────────────
    if (isBlacklisted(phone)) return;

    const customer = getCustomer(phone);
    customer.jid = jid;
    customer.messageCount = (customer.messageCount || 0) + 1;
    addHistory(phone, 'customer', body);
    updateCustomer(phone, {});

    const b = body.toLowerCase().trim();
    const step = customer.step;

    // ── Buying signal detection ───────────────────────────
    if (detectBuyingSignals(body) && customer.stage !== 'sold') {
        updateCustomer(phone, { stage: 'offer' });
        sendToDirectors(`🔥 *HOT LEAD — Buying Signal Detected!*\n\nCustomer: ${customer.name || phone}\nPhone: ${phone}\nMessage: "${body}"\nStage: ${customer.stage}\n\nReply: !notify ${phone} <message>`);
    }

    // ── Feedback collection flow ──────────────────────────
    if (customer.awaitingFeedback) {
        const rating = parseInt(body);
        if (rating >= 1 && rating <= 5) {
            const stars = '⭐'.repeat(rating);
            feedback.push({ phone, name: customer.name, rating, time: new Date().toISOString() });
            updateCustomer(phone, { awaitingFeedback: false, feedbackGiven: true, step: null });
            const replyText = rating >= 4
                ? `${stars} Thank you so much, ${customer.name || 'there'}! We're thrilled you had a great experience.\n\n⭐ *Leave us a Google review* — it helps other customers find us:\nhttps://g.page/r/autoelite/review\n\nIt was a pleasure doing business with you! — *AutoElite Team*`
                : `${stars} Thank you for your honest feedback, ${customer.name || 'there'}. We're sorry your experience wasn't perfect — a senior team member will be in touch shortly to make it right.\n\n— *AutoElite Team*`;
            if (rating < 4) sendToDirectors(`⚠️ *Low Rating Alert*\nCustomer: ${customer.name || phone} (${phone})\nRating: ${rating}/5\nAction required.`);
            addHistory(phone, 'bot', replyText);
            return reply(replyText);
        } else {
            const replyText = `Please reply with a number from *1 to 5*:\n\n5 — Excellent\n4 — Good\n3 — Average\n2 — Poor\n1 — Very poor`;
            addHistory(phone, 'bot', replyText);
            return reply(replyText);
        }
    }

    // ── Multi-step flows ──────────────────────────────────

    // Name capture
    if (step === 'capture_name') {
        const name = body.trim().split(' ')[0];
        updateCustomer(phone, { name, step: 'capture_interest' });
        captureLead(jid, { name });
        const replyText = `Nice to meet you, *${name}*! 😊\n\nWhat brings you to AutoElite today?\n\n🚗 Browse our cars\n💳 Finance options\n🔄 Part exchange / trade-in\n📅 Book a test drive\n💡 Get a car valuation\n\nJust type what you're looking for!`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Test drive flow
    if (step === 'testdrive_name') {
        updateCustomer(phone, { name: body.trim(), step: 'testdrive_car' });
        captureLead(jid, { name: body.trim() });
        const avail = getAvailableInventory();
        const replyText = `Great, ${body.trim()}! 🚗 Which car would you like to test drive?\n\n${inventoryList(avail)}\n\nJust type the name or number.`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    if (step === 'testdrive_car') {
        updateCustomer(phone, { interest: body, step: 'testdrive_date' });
        captureLead(jid, { interest: body });
        const replyText = `Perfect choice! 🔑\n\nWhat date and time works for you?\n_(e.g. Saturday 12th April, 2pm)_`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    if (step === 'testdrive_date') {
        const booking = {
            jid, phone,
            name: customer.name,
            date: body,
            car: customer.interest,
            bookedAt: new Date().toISOString(),
            reminded: false,
        };
        bookings.push(booking);
        updateCustomer(phone, { stage: 'test drive', step: null, stepData: {} });
        captureLead(jid, { status: 'test-drive-booked' });
        sendToDirectors(`📅 *New Test Drive Booking*\n\nName: ${customer.name}\nCar: ${customer.interest}\nDate: ${body}\nPhone: ${phone}`);
        const replyText = `✅ *Test drive confirmed!*\n\n👤 Name: ${customer.name}\n🚗 Car: ${customer.interest}\n📅 Date: ${body}\n\nWe'll send you a reminder the day before. See you soon!\n\n_Need to reschedule? Just message us anytime._\n\n— *AutoElite Team*`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Trade-in flow
    if (step === 'tradein_reg') {
        updateCustomer(phone, { stepData: { reg: body.toUpperCase() }, step: 'tradein_mileage' });
        const replyText = `Got it — *${body.toUpperCase()}* 👍\n\nApproximate mileage?`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    if (step === 'tradein_mileage') {
        const { reg } = customer.stepData;
        inquiries.push({ type: 'Trade-in', jid, phone, reg, mileage: body, time: new Date().toISOString() });
        updateCustomer(phone, { step: null, stepData: {}, interest: `Trade-in: ${reg}` });
        captureLead(jid, { interest: `Trade-in: ${reg}`, status: 'enquiry' });
        sendToDirectors(`🔄 *Trade-in Enquiry*\n\nReg: ${reg}\nMileage: ${body}\nCustomer: ${customer.name || phone} (${phone})`);
        const replyText = `Thank you! 🎉\n\nWe'll value *${reg}* and get back to you with a guaranteed offer within 2 hours during business hours.\n\nFor an instant estimate:\n💡 https://autoelite-uk.netlify.app/valuation.html\n\n— *AutoElite Team*`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Finance calculator flow
    if (step === 'finance_price') {
        const price = parseInt(body.replace(/[^0-9]/g, ''));
        if (!price || price < 1000) {
            const replyText = `Please enter the vehicle price in pounds (e.g. 182000 or £182,000):`;
            addHistory(phone, 'bot', replyText);
            return reply(replyText);
        }
        const pcp = calcMonthlyPayment(price, 10, 48, 9.9);
        const hp  = calcMonthlyPayment(price, 10, 60, 8.9);
        updateCustomer(phone, { step: null, budget: price });
        captureLead(jid, { budget: price });
        const replyText = `💳 *Finance Illustration for ${formatCurrency(price)}*\n\n*PCP (4 years @ 9.9% APR)*\nDeposit: ${formatCurrency(pcp.deposit)}\nMonthly: ${formatCurrency(pcp.monthly)}\nTotal: ${formatCurrency(pcp.total)}\n\n*HP (5 years @ 8.9% APR)*\nDeposit: ${formatCurrency(hp.deposit)}\nMonthly: ${formatCurrency(hp.monthly)}\nTotal: ${formatCurrency(hp.total)}\n\n_These are illustrations only. Subject to status and affordability checks._\n\nWould you like to speak to our finance team? Just say *yes* and we'll arrange a call! 📞`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Deposit flow
    if (step === 'deposit_confirm') {
        if (b.includes('yes') || b.includes('confirm') || b.includes('ok') || b.includes('proceed')) {
            const vehicle = customer.stepData.vehicle;
            deposits.push({ phone, name: customer.name, vehicle: vehicle?.name, amount: vehicle ? Math.round(vehicle.price * 0.1) : 0, time: new Date().toISOString(), confirmed: true });
            if (vehicle) vehicle.status = 'reserved';
            updateCustomer(phone, { stage: 'offer', depositPaid: true, step: null, stepData: {} });
            captureLead(jid, { status: 'deposit-requested' });
            sendToDirectors(`💰 *Deposit Confirmation*\n\nCustomer: ${customer.name || phone} (${phone})\nVehicle: ${vehicle?.name || 'TBC'}\nAmount: ${vehicle ? formatCurrency(Math.round(vehicle.price * 0.1)) : 'TBC'}\n\nPlease arrange payment link.`);
            const replyText = `✅ *Brilliant! Deposit request confirmed.*\n\nVehicle: ${vehicle?.name || 'TBC'}\nDeposit: ${vehicle ? formatCurrency(Math.round(vehicle.price * 0.1)) : 'TBC'}\n\nOur team will send you a secure payment link within the next 30 minutes. 🔐\n\nYour car will be reserved once the deposit is received.\n\n— *AutoElite Team*`;
            addHistory(phone, 'bot', replyText);
            return reply(replyText);
        } else {
            updateCustomer(phone, { step: null, stepData: {} });
            const replyText = `No problem! The vehicle remains available. Let us know when you're ready or if you have any questions. 😊\n\n— *AutoElite Team*`;
            addHistory(phone, 'bot', replyText);
            return reply(replyText);
        }
    }

    // ── Keyword / Intent Routing ──────────────────────────

    // Greetings — always welcome 24/7
    if (b.match(/^(hi|hello|hey|hiya|good\s?(morning|afternoon|evening)|howdy|yo|sup)\b/)) {
        if (!customer.welcomed || !customer.name) {
            updateCustomer(phone, { welcomed: true, step: 'capture_name' });
            captureLead(jid, {});
            const hour = getUKHour();
            const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
            const open = isOpenNow();
            const replyText = `${greeting}! 👋 Welcome to *AutoElite* — London's premier exotic car dealership.\n\nI'm your 24/7 AutoElite assistant — here to help any time, day or night.${!open ? `\n\n⏰ Our showroom opens ${nextOpenTime()}, but I can help you right now with information, quotes, and bookings.` : ''}\n\nWhat's your name?`;
            addHistory(phone, 'bot', replyText);
            return reply(replyText);
        }
        const replyText = `Welcome back, *${customer.name}*! 😊\n\nHow can I help you today?\n\n🚗 !inventory — View our cars\n📅 !testdrive — Book a test drive\n💳 !finance — Finance calculator\n🔄 !tradein — Part exchange value\n💰 !deposit — Reserve a car\n📊 !status — Your journey with us`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // !help / !menu
    if (b === '!help' || b === '!menu' || b === 'menu' || b === 'help') {
        const replyText = `🚗 *AutoElite — 24/7 Assistant*\n\n*Browse & Buy*\n!inventory — All available cars\n!finance <price> — Monthly payment calc\n!deposit — Reserve a vehicle\n\n*Appointments*\n!testdrive — Book a test drive\n!tradein — Part exchange value\n!valuation — Free car valuation\n\n*Information*\n!hours — Opening times\n!location — Showroom address\n!warranty — What's included\n!contact — Speak to the team\n\n*Your Account*\n!status — Your journey with us\n!history — Recent messages\n\n_Our AI assistant is available 24/7. Human team available Mon–Fri 9am–6pm._`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // !inventory
    if (b === '!inventory' || b.match(/\b(stock|available cars|show me|what cars|your cars|models)\b/)) {
        const avail = getAvailableInventory();
        if (!avail.length) {
            const replyText = `We're currently updating our inventory. Please check back soon or speak to the team:\n📞 +44 (0) 800 AUTO ELITE`;
            addHistory(phone, 'bot', replyText);
            return reply(replyText);
        }
        const replyText = `🚗 *AutoElite Inventory — ${avail.length} Cars Available*\n\n${inventoryList(avail)}\n\n🌐 Full details: https://autoelite-uk.netlify.app/#inventory\n\n_Type !finance <price> for monthly payments, or !testdrive to book a drive!_`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Finance calculator
    if (b.startsWith('!finance')) {
        const priceStr = b.replace('!finance', '').trim();
        const price = parseInt(priceStr.replace(/[^0-9]/g, ''));
        if (!price) {
            updateCustomer(phone, { step: 'finance_price' });
            const replyText = `💳 *Finance Calculator*\n\nWhich vehicle are you interested in, or enter a price (e.g. 182000)?`;
            addHistory(phone, 'bot', replyText);
            return reply(replyText);
        }
        const pcp = calcMonthlyPayment(price, 10, 48, 9.9);
        const hp  = calcMonthlyPayment(price, 10, 60, 8.9);
        updateCustomer(phone, { budget: price });
        captureLead(jid, { budget: price });
        const replyText = `💳 *Finance Illustration for ${formatCurrency(price)}*\n\n*PCP (4 years @ 9.9% APR)*\nDeposit: ${formatCurrency(pcp.deposit)}\nMonthly: ${formatCurrency(pcp.monthly)}/mo\nTotal: ${formatCurrency(pcp.total)}\n\n*HP (5 years @ 8.9% APR)*\nDeposit: ${formatCurrency(hp.deposit)}\nMonthly: ${formatCurrency(hp.monthly)}/mo\nTotal: ${formatCurrency(hp.total)}\n\n_Subject to status. Representative example only._\n\nWould you like a personalised quote from our finance team? 📞`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Finance keyword
    if (b.match(/\b(finance|monthly|payment|loan|hp|pcp|lease|afford|deposit)\b/)) {
        updateCustomer(phone, { step: 'finance_price' });
        captureLead(jid, { interest: 'Finance enquiry' });
        const replyText = `💳 *Finance Options*\n\nWe offer:\n✅ PCP — Personal Contract Purchase\n✅ HP — Hire Purchase\n✅ Lease / Contract Hire\n✅ Balloon payment options\n\nEnter a vehicle price and I'll calculate your monthly payments:\n_(e.g. type: 182000)_`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Test drive
    if (b === '!testdrive' || b.match(/\b(test.?drive|test.?driv|book a drive|book.?drive)\b/)) {
        if (!customer.name) {
            updateCustomer(phone, { step: 'testdrive_name' });
            const replyText = `Let's get you booked in! 🚗\n\nWhat's your name?`;
            addHistory(phone, 'bot', replyText);
            return reply(replyText);
        }
        updateCustomer(phone, { step: 'testdrive_car' });
        const avail = getAvailableInventory();
        const replyText = `Great, ${customer.name}! Which car would you like to test drive?\n\n${inventoryList(avail)}\n\nJust type the name or number.`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Trade-in
    if (b === '!tradein' || b.match(/\b(trade.?in|part.?ex|sell my car|swap|exchange)\b/)) {
        updateCustomer(phone, { step: 'tradein_reg' });
        captureLead(jid, { interest: 'Trade-in enquiry' });
        const replyText = `🔄 *Part Exchange / Trade-in*\n\nWe offer top prices for quality vehicles!\n\nWhat's your vehicle registration number?`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Deposit / Reserve
    if (b === '!deposit' || b.match(/\b(reserve|put a deposit|hold it|secure it|buy now)\b/)) {
        const avail = getAvailableInventory();
        updateCustomer(phone, { step: 'deposit_confirm', stepData: {} });
        const replyText = `💰 *Reserve Your Vehicle*\n\nA 10% deposit secures any vehicle for 7 days.\n\n${inventoryList(avail)}\n\nWhich car would you like to reserve?`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Pricing / specific car enquiry
    if (b.match(/\b(price|cost|how much|ferrari|lamborghini|porsche|mclaren|bentley)\b/)) {
        const avail = getAvailableInventory();
        captureLead(jid, { interest: 'Pricing enquiry' });
        const replyText = `💰 *Our Available Cars*\n\n${inventoryList(avail)}\n\n🌐 https://autoelite-uk.netlify.app/#inventory\n\nInterested in finance? Type !finance <price> for monthly payments.`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Hours
    if (b === '!hours' || b.match(/\b(open|hours|when|close|closing|time|weekend)\b/)) {
        const open = isOpenNow();
        const replyText = `🕐 *AutoElite Opening Hours*\n\n${open ? '🟢 We are *currently open!*' : `🔴 We are currently closed. Next open: *${nextOpenTime()}*`}\n\nMon–Fri: 9:00am – 6:00pm\nSaturday: 9:00am – 5:00pm\nSunday: 10:00am – 4:00pm\n\n💬 _Our AI assistant is available 24/7 for enquiries and bookings._`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Location
    if (b === '!location' || b.match(/\b(location|where|address|directions|map|postcode)\b/)) {
        const replyText = `📍 *AutoElite Showroom*\n\nVisit us or get directions:\n🌐 https://autoelite-uk.netlify.app/#contact\n\nOr call us:\n📞 +44 (0) 800 AUTO ELITE`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Warranty
    if (b === '!warranty' || b.match(/\b(warranty|guarantee|cover|breakdown|rac|aa)\b/)) {
        const replyText = `🛡 *AutoElite Warranty*\n\n✅ 12-month comprehensive warranty\n✅ RAC Approved Dealer breakdown cover\n✅ Extended 3-year warranty available\n✅ All vehicles HPI checked & inspected\n✅ 30-day money-back guarantee\n\nFor full details: https://autoelite-uk.netlify.app/#contact`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Valuation
    if (b === '!valuation' || b.match(/\b(valuation|value my car|what is my car worth|how much is my)\b/)) {
        const replyText = `💡 *Free Car Valuation*\n\nGet an instant online valuation:\n🌐 https://autoelite-uk.netlify.app/valuation.html\n\nOr for a guaranteed offer, type *!tradein* and we'll buy your car at the best price.\n\n— *AutoElite Team*`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Contact / human
    if (b === '!contact' || b.match(/\b(contact|call|speak|talk|email|human|agent|person|team|staff)\b/)) {
        const open = isOpenNow();
        captureLead(jid, { interest: 'Wants human contact' });
        if (!open) sendToDirectors(`📞 *Contact Request (Out of Hours)*\nCustomer: ${customer.name || phone} (${phone})\nMessage: "${body}"`);
        const replyText = `📞 *Contact AutoElite*\n\n${open ? '✅ Our team are available right now!' : `⏰ We'll be open ${nextOpenTime()} — but I've flagged your message for a callback.`}\n\n📞 +44 (0) 800 AUTO ELITE\n📧 hello@autoelite.co.uk\n🌐 https://autoelite-uk.netlify.app/#contact\n\n_Leave your message here and the team will reply as soon as they're available._`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Status — customer journey
    if (b === '!status') {
        const stageEmojis = { enquiry: '💬', viewing: '👀', 'test drive': '🚗', offer: '💰', sold: '✅', lost: '❌' };
        const replyText = `📊 *Your AutoElite Journey*\n\n👤 Name: ${customer.name || 'Not captured yet'}\n📱 Phone: ${customer.phone}\n⭐ Status: ${stageEmojis[customer.stage] || '💬'} ${customer.stage}\n🚗 Interest: ${customer.interest || 'Not specified'}\n💰 Budget: ${customer.budget ? formatCurrency(customer.budget) : 'Not specified'}\n${customer.vip ? '👑 VIP Customer\n' : ''}${customer.depositPaid ? '✅ Deposit confirmed\n' : ''}\nFirst contact: ${new Date(customer.firstContact).toLocaleDateString('en-GB')}`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // History
    if (b === '!history') {
        const recent = customer.history.slice(-6);
        if (!recent.length) {
            addHistory(phone, 'bot', 'No history yet.');
            return reply('No history yet.');
        }
        const replyText = `📋 *Recent Messages*\n\n` + recent.map(h => `[${h.role === 'customer' ? 'You' : 'AutoElite'}]: ${h.message.substring(0, 80)}${h.message.length > 80 ? '...' : ''}`).join('\n\n');
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // Thanks
    if (b.match(/\b(thank|thanks|cheers|brilliant|great|perfect|amazing|lovely|wonderful)\b/)) {
        const replyText = `You're very welcome, ${customer.name || 'there'}! 😊\n\nIs there anything else I can help with?\n\nType *!menu* to see all options, or just ask me anything — I'm here 24/7! 🚗\n\n— *AutoElite Team*`;
        addHistory(phone, 'bot', replyText);
        return reply(replyText);
    }

    // ── AI Fallback ───────────────────────────────────────
    const aiReply = await getAIReply(customer.name, customer.history, body);
    if (aiReply) {
        inquiries.push({ type: 'AI-handled', jid, phone, message: body, reply: aiReply, time: new Date().toISOString() });
        captureLead(jid, { lastMessage: body });
        addHistory(phone, 'bot', aiReply);
        return reply(aiReply);
    }

    // ── Final fallback ────────────────────────────────────
    inquiries.push({ type: 'Unhandled', jid, phone, message: body, time: new Date().toISOString() });
    captureLead(jid, { lastMessage: body });
    if (!isOpenNow()) {
        sendToDirectors(`📩 *Out-of-Hours Enquiry*\nCustomer: ${customer.name || phone} (${phone})\nMessage: "${body}"`);
    } else {
        sendToDirectors(`🔔 *New Enquiry Needs Attention*\nCustomer: ${customer.name || phone} (${phone})\nMessage: "${body}"\n\nReply: !notify ${phone} <message>`);
    }
    const replyText = `Thanks for your message, ${customer.name || 'there'}! 👋\n\nI've passed this to the AutoElite team who'll get back to you${isOpenNow() ? ' shortly' : ` when we open — ${nextOpenTime()}`}.\n\n📞 +44 (0) 800 AUTO ELITE\n🌐 https://autoelite-uk.netlify.app\n\n— *AutoElite Team*`;
    addHistory(phone, 'bot', replyText);
    return reply(replyText);
}

// ── Director Command Handler ───────────────────────────────
async function handleDirector(jid, body, reply) {
    const parts = body.trim().split(' ');
    const cmd = parts[0].toLowerCase();
    const phone = phoneFromJid(jid);

    if (cmd === '!help' || cmd === '!commands') {
        return reply(`👑 *AutoElite Director Commands*\n\n📋 *Data*\n!leads [n] — Last n leads (default 10)\n!bookings — Test drive bookings\n!inquiries — Recent inquiries\n!deposits — Deposits confirmed\n!feedback — Customer feedback\n!inventory — Stock list\n!summary — Today's summary\n!weekly — Weekly report\n\n📣 *Messaging*\n!notify <num> <msg> — Message customer\n!buyer <num> <car> — Buyer found alert\n!broadcast <msg> — Message all leads\n!reminder <num> <name> <date> <car>\n!review <num> — Request Google review\n\n🚗 *Inventory*\n!addcar <name>|<price>|<hp>|<speed>|<miles>|<colour>\n!sellcar <id> — Mark as sold\n!pricedrop <id> <newprice> — Price drop + notify watchers\n!restock <id> — Mark as available again\n\n👤 *CRM*\n!vip <num> — Toggle VIP flag\n!blacklist <num> [reason] — Block number\n!unblacklist <num> — Unblock\n!stage <num> <stage> — Update pipeline stage\n!note <num> <note> — Add note to customer\n!lost <num> <reason> — Mark as lost lead\n!won <num> <car> — Mark as sold\n\n👥 *Admin*\n!addadmin <num> — Grant admin access\n!removeadmin <num> — Remove admin\n!creategroup <name> — Create WhatsApp group\n\n📤 *Export*\n!csv — Export leads as CSV (check /leads-csv endpoint)`);
    }

    // ── Data commands ──────────────────────────────────────
    if (cmd === '!leads') {
        const n = parseInt(parts[1]) || 10;
        if (!leads.length) return reply('No leads captured yet.');
        const vipTag = (l) => customers[l.phone]?.vip ? '👑 ' : '';
        return reply(`👤 *Leads (${leads.length} total — showing last ${Math.min(n, leads.length)})*\n\n` +
            leads.slice(-n).reverse().map((l, i) =>
                `${i + 1}. ${vipTag(l)}${l.name || 'Unknown'} — ${l.phone}\n   ${l.interest || 'browsing'} | ${l.status} | ${new Date(l.lastContact).toLocaleDateString('en-GB')}`
            ).join('\n\n'));
    }

    if (cmd === '!bookings') {
        if (!bookings.length) return reply('No test drives booked yet.');
        return reply(`📅 *Test Drive Bookings (${bookings.length})*\n\n` +
            bookings.map((b, i) => `${i + 1}. ${b.name} — ${b.car}\n   📅 ${b.date} | 📱 ${b.phone}${b.reminded ? ' ✅ reminded' : ''}`).join('\n\n'));
    }

    if (cmd === '!inquiries') {
        if (!inquiries.length) return reply('No inquiries yet.');
        return reply(`📋 *Recent Inquiries*\n\n` +
            inquiries.slice(-10).reverse().map((i, n) =>
                `${n + 1}. [${i.type}] ${i.phone}\n   "${(i.message || '').substring(0, 60)}" — ${new Date(i.time).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}`
            ).join('\n\n'));
    }

    if (cmd === '!deposits') {
        if (!deposits.length) return reply('No deposits confirmed yet.');
        return reply(`💰 *Deposits*\n\n` +
            deposits.map((d, i) => `${i + 1}. ${d.name || d.phone} — ${d.vehicle}\n   ${formatCurrency(d.amount)} | ${new Date(d.time).toLocaleDateString('en-GB')}`).join('\n\n'));
    }

    if (cmd === '!feedback') {
        if (!feedback.length) return reply('No feedback received yet.');
        const avg = (feedback.reduce((s, f) => s + f.rating, 0) / feedback.length).toFixed(1);
        return reply(`⭐ *Customer Feedback — Average: ${avg}/5*\n\n` +
            feedback.slice(-10).reverse().map((f, i) => `${i + 1}. ${'⭐'.repeat(f.rating)} — ${f.name || f.phone} (${new Date(f.time).toLocaleDateString('en-GB')})`).join('\n'));
    }

    if (cmd === '!inventory') {
        if (!inventory.length) return reply('No inventory.');
        return reply(`🚗 *Full Inventory (${inventory.length} vehicles)*\n\n` +
            inventory.map(v => `[${v.id}] *${v.name}* — ${formatCurrency(v.price)}\n   ${v.hp}HP | ${v.speed} | ${v.miles.toLocaleString()}mi | ${v.colour} | *${v.status}*\n   Watchers: ${v.watchers.length}`).join('\n\n'));
    }

    if (cmd === '!summary') {
        const today = new Date().toISOString().slice(0, 10);
        const ti = inquiries.filter(i => i.time.startsWith(today)).length;
        const tl = leads.filter(l => l.capturedAt?.startsWith(today)).length;
        const tb = bookings.filter(b => b.bookedAt?.startsWith(today)).length;
        const hot = leads.filter(l => customers[l.phone]?.stage === 'offer').length;
        const avail = getAvailableInventory().length;
        return reply(`📊 *AutoElite Daily Summary — ${new Date().toLocaleDateString('en-GB')}*\n\n🔔 Inquiries today: ${ti}\n👤 New leads today: ${tl}\n📅 Test drives booked today: ${tb}\n🔥 Hot leads (offer stage): ${hot}\n📋 Total leads: ${leads.length}\n🚗 Cars available: ${avail}\n💰 Deposits received: ${deposits.length}\n⭐ Feedback count: ${feedback.length}`);
    }

    if (cmd === '!weekly') {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const wLeads = leads.filter(l => l.capturedAt > weekAgo).length;
        const wBookings = bookings.filter(b => b.bookedAt > weekAgo).length;
        const wDeposits = deposits.filter(d => d.time > weekAgo).length;
        const wFeedback = feedback.filter(f => f.time > weekAgo);
        const avgRating = wFeedback.length ? (wFeedback.reduce((s, f) => s + f.rating, 0) / wFeedback.length).toFixed(1) : 'N/A';
        const sold = leads.filter(l => customers[l.phone]?.stage === 'sold' && l.lastContact > weekAgo).length;
        return reply(`📊 *AutoElite Weekly Report*\n_Last 7 days_\n\n👤 New leads: ${wLeads}\n📅 Test drives: ${wBookings}\n💰 Deposits: ${wDeposits}\n✅ Sold: ${sold}\n⭐ Avg rating: ${avgRating}/5\n\n📋 Total leads all-time: ${leads.length}\n🚗 Available stock: ${getAvailableInventory().length}`);
    }

    // ── Messaging commands ─────────────────────────────────
    if (cmd === '!notify') {
        const number = parts[1]; const message = parts.slice(2).join(' ');
        if (!number || !message) return reply('Usage: !notify <number> <message>');
        await sock.sendMessage(number + '@s.whatsapp.net', { text: message });
        captureLead(number + '@s.whatsapp.net', { lastContact: new Date().toISOString() });
        return reply(`✅ Sent to ${number}`);
    }

    if (cmd === '!buyer') {
        const number = parts[1]; const car = parts.slice(2).join(' ');
        if (!number || !car) return reply('Usage: !buyer <number> <car>');
        await sock.sendMessage(number + '@s.whatsapp.net', {
            text: `🎉 *Great news from AutoElite!*\n\nWe have an interested buyer for your *${car}*!\n\nPlease contact us as soon as possible:\n📞 +44 (0) 800 AUTO ELITE\n🌐 https://autoelite-uk.netlify.app/#contact\n\n— *AutoElite Team*`
        });
        return reply(`✅ Buyer notification sent to ${number}`);
    }

    if (cmd === '!broadcast') {
        const message = parts.slice(1).join(' ');
        if (!message) return reply('Usage: !broadcast <message>');
        const contacts = [...new Set(leads.map(l => l.jid).filter(Boolean))];
        if (!contacts.length) return reply('No leads to broadcast to.');
        let sent = 0;
        for (const contact of contacts) {
            const cPhone = phoneFromJid(contact);
            if (isBlacklisted(cPhone)) continue;
            try { await sock.sendMessage(contact, { text: `📢 *AutoElite:* ${message}` }); sent++; } catch {}
        }
        return reply(`✅ Broadcast sent to ${sent} contact(s)`);
    }

    if (cmd === '!reminder') {
        const number = parts[1]; const name = parts[2]; const date = parts[3]; const car = parts.slice(4).join(' ');
        if (!number || !name) return reply('Usage: !reminder <number> <name> <date> <car>');
        await sock.sendMessage(number + '@s.whatsapp.net', {
            text: `🚗 *AutoElite Reminder*\n\nHi ${name}! Your test drive is booked for *${date}*.\n\nCar: ${car}\n\nWe look forward to seeing you! To reschedule:\n📞 +44 (0) 800 AUTO ELITE\n\n— *AutoElite Team*`
        });
        return reply(`✅ Reminder sent to ${number}`);
    }

    if (cmd === '!review') {
        const number = parts[1];
        if (!number) return reply('Usage: !review <number>');
        const c = customers[number];
        await sock.sendMessage(number + '@s.whatsapp.net', {
            text: `Hi ${c?.name || 'there'}! 👋 It was a pleasure helping you at AutoElite.\n\nWe'd love to hear about your experience — could you rate us from *1 to 5*?\n\n5 — Excellent\n4 — Good\n3 — Average\n2 — Poor\n1 — Very poor\n\nJust reply with a number. Thank you! 🙏\n\n— *AutoElite Team*`
        });
        if (c) updateCustomer(number, { awaitingFeedback: true, reviewRequested: true });
        return reply(`✅ Review request sent to ${number}`);
    }

    // ── Inventory commands ─────────────────────────────────
    if (cmd === '!addcar') {
        const carData = parts.slice(1).join(' ').split('|').map(s => s.trim());
        if (carData.length < 6) return reply('Usage: !addcar Name|Price|HP|Speed|Miles|Colour\nExample: !addcar Ferrari Roma|218000|620|3.4s|5000|Bianco');
        const [name, priceStr, hpStr, speed, milesStr, colour] = carData;
        const newCar = { id: inventory.length + 1, name, price: parseInt(priceStr), hp: parseInt(hpStr), speed, miles: parseInt(milesStr), colour, status: 'available', watchers: [] };
        inventory.push(newCar);
        return reply(`✅ *${name}* added to inventory!\n\nID: ${newCar.id} | ${formatCurrency(newCar.price)} | ${newCar.hp}HP`);
    }

    if (cmd === '!sellcar') {
        const id = parseInt(parts[1]);
        const v = inventory.find(v => v.id === id);
        if (!v) return reply(`No vehicle with ID ${id}. Use !inventory to see IDs.`);
        v.status = 'sold';
        // Notify watchers
        for (const wp of v.watchers) {
            try {
                await sock.sendMessage(wp + '@s.whatsapp.net', {
                    text: `⚠️ *AutoElite Update*\n\nUnfortunately the *${v.name}* you were watching has now been sold.\n\nWe'd love to help you find your perfect alternative — reply here or call us:\n📞 +44 (0) 800 AUTO ELITE\n\n— *AutoElite Team*`
                });
            } catch {}
        }
        return reply(`✅ ${v.name} marked as sold. ${v.watchers.length} watcher(s) notified.`);
    }

    if (cmd === '!pricedrop') {
        const id = parseInt(parts[1]); const newPrice = parseInt(parts[2]);
        if (!id || !newPrice) return reply('Usage: !pricedrop <id> <newprice>');
        const v = inventory.find(v => v.id === id);
        if (!v) return reply(`No vehicle with ID ${id}.`);
        const oldPrice = v.price;
        v.price = newPrice;
        // Notify watchers
        for (const wp of v.watchers) {
            try {
                await sock.sendMessage(wp + '@s.whatsapp.net', {
                    text: `🎉 *Price Drop Alert — AutoElite!*\n\nGreat news! The *${v.name}* you've been watching just dropped in price:\n\n~~${formatCurrency(oldPrice)}~~ → *${formatCurrency(newPrice)}*\n\nSaving: ${formatCurrency(oldPrice - newPrice)}!\n\nInterested? Reply now or call:\n📞 +44 (0) 800 AUTO ELITE\n\n— *AutoElite Team*`
                });
            } catch {}
        }
        return reply(`✅ ${v.name} price updated: ${formatCurrency(oldPrice)} → ${formatCurrency(newPrice)}. ${v.watchers.length} watcher(s) notified.`);
    }

    if (cmd === '!restock') {
        const id = parseInt(parts[1]);
        const v = inventory.find(v => v.id === id);
        if (!v) return reply(`No vehicle with ID ${id}.`);
        v.status = 'available';
        return reply(`✅ ${v.name} marked as available again.`);
    }

    // ── CRM commands ──────────────────────────────────────
    if (cmd === '!vip') {
        const number = parts[1];
        if (!number) return reply('Usage: !vip <number>');
        const c = getCustomer(number);
        c.vip = !c.vip;
        const lead = leads.find(l => l.phone === number);
        if (lead) lead.vip = c.vip;
        return reply(`${c.vip ? '👑 VIP status granted' : 'VIP status removed'} for ${c.name || number}`);
    }

    if (cmd === '!blacklist') {
        const number = parts[1]; const reason = parts.slice(2).join(' ') || 'No reason given';
        if (!number) return reply('Usage: !blacklist <number> [reason]');
        if (!blacklist.find(b => b.phone === number)) blacklist.push({ phone: number, reason, time: new Date().toISOString() });
        return reply(`✅ ${number} blacklisted. Reason: ${reason}`);
    }

    if (cmd === '!unblacklist') {
        const number = parts[1];
        const i = blacklist.findIndex(b => b.phone === number);
        if (i === -1) return reply(`${number} is not blacklisted.`);
        blacklist.splice(i, 1);
        return reply(`✅ ${number} removed from blacklist.`);
    }

    if (cmd === '!stage') {
        const number = parts[1]; const stage = parts[2]?.toLowerCase();
        if (!number || !STAGES.includes(stage)) return reply(`Usage: !stage <number> <stage>\nStages: ${STAGES.join(', ')}`);
        updateCustomer(number, { stage });
        const lead = leads.find(l => l.phone === number);
        if (lead) lead.status = stage;
        return reply(`✅ ${customers[number]?.name || number} moved to *${stage}* stage.`);
    }

    if (cmd === '!note') {
        const number = parts[1]; const note = parts.slice(2).join(' ');
        if (!number || !note) return reply('Usage: !note <number> <note>');
        const c = getCustomer(number);
        c.notes.push({ note, time: new Date().toISOString(), by: phoneFromJid(jid) });
        return reply(`✅ Note added to ${c.name || number}: "${note}"`);
    }

    if (cmd === '!lost') {
        const number = parts[1]; const reason = parts.slice(2).join(' ') || 'No reason given';
        if (!number) return reply('Usage: !lost <number> <reason>');
        updateCustomer(number, { stage: 'lost', lostReason: reason });
        const lead = leads.find(l => l.phone === number);
        if (lead) { lead.status = 'lost'; lead.lostReason = reason; }
        return reply(`✅ ${customers[number]?.name || number} marked as *lost*.\nReason: ${reason}`);
    }

    if (cmd === '!won') {
        const number = parts[1]; const car = parts.slice(2).join(' ');
        if (!number) return reply('Usage: !won <number> <car>');
        updateCustomer(number, { stage: 'sold', depositPaid: true });
        const lead = leads.find(l => l.phone === number);
        if (lead) lead.status = 'sold';
        // Schedule review request for 3 days after sale
        setTimeout(async () => {
            if (!sock || !isConnected) return;
            const c = customers[number];
            if (c && !c.reviewRequested) {
                await sock.sendMessage(number + '@s.whatsapp.net', {
                    text: `Hi ${c.name || 'there'}! 🎉 Congratulations on your new *${car}*!\n\nWe hope you're loving it. We'd be grateful if you could rate your experience with us:\n\n5 — Excellent\n4 — Good\n3 — Average\n2 — Poor\n1 — Very poor\n\nJust reply with a number. Thank you! 🙏\n\n— *AutoElite Team*`
                });
                updateCustomer(number, { awaitingFeedback: true, reviewRequested: true });
            }
        }, 3 * 24 * 60 * 60 * 1000);
        return reply(`✅ ${customers[number]?.name || number} marked as *sold* — ${car}.\nReview request scheduled for 3 days' time.`);
    }

    if (cmd === '!csv') {
        return reply(`📤 Download leads CSV:\nhttps://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:3000'}/leads-csv\n\nor run: curl -o leads.csv http://localhost:${PORT}/leads-csv`);
    }

    // ── Admin commands ─────────────────────────────────────
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
            return reply(`✅ Group "${name}" created!\nJID: ${group.gid}`);
        } catch (e) { return reply(`❌ ${e.message}`); }
    }

    // Fall through to customer handler for non-commands
    return handleCustomer(jid, body, reply);
}

// ── Scheduled Automations ─────────────────────────────────
function startAutomations() {
    // Daily summary — 8:00am UK every day
    cron.schedule('0 8 * * *', () => {
        if (!sock || !isConnected) return;
        const today = new Date().toLocaleDateString('en-GB');
        const todayStr = new Date().toISOString().slice(0, 10);
        const ti = inquiries.filter(i => i.time.startsWith(todayStr)).length;
        const tl = leads.filter(l => l.capturedAt?.startsWith(todayStr)).length;
        const tb = bookings.filter(b => b.bookedAt?.startsWith(todayStr)).length;
        const hot = leads.filter(l => customers[l.phone]?.stage === 'offer').length;
        sendToDirectors(`☀️ *Good morning! AutoElite Daily Summary — ${today}*\n\n🔔 Inquiries yesterday: ${ti}\n👤 New leads: ${tl}\n📅 Test drives booked: ${tb}\n🔥 Hot leads: ${hot}\n📋 Total leads: ${leads.length}\n🚗 Cars available: ${getAvailableInventory().length}\n\nType !leads for details. Have a great day! 🚗`);
    }, { timezone: 'Europe/London' });

    // Weekly report — Monday 8:30am
    cron.schedule('30 8 * * 1', () => {
        if (!sock || !isConnected) return;
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const wLeads = leads.filter(l => l.capturedAt > weekAgo).length;
        const wBookings = bookings.filter(b => b.bookedAt > weekAgo).length;
        const wDeposits = deposits.filter(d => d.time > weekAgo).length;
        const wFeedback = feedback.filter(f => f.time > weekAgo);
        const avgRating = wFeedback.length ? (wFeedback.reduce((s, f) => s + f.rating, 0) / wFeedback.length).toFixed(1) : 'N/A';
        const sold = leads.filter(l => customers[l.phone]?.stage === 'sold' && l.lastContact > weekAgo).length;
        sendToDirectors(`📊 *AutoElite Weekly Report — w/e ${new Date().toLocaleDateString('en-GB')}*\n\n👤 New leads: ${wLeads}\n📅 Test drives: ${wBookings}\n💰 Deposits: ${wDeposits}\n✅ Cars sold: ${sold}\n⭐ Avg customer rating: ${avgRating}/5\n\n📋 Total leads all-time: ${leads.length}\n🚗 Current stock: ${getAvailableInventory().length} cars`);
    }, { timezone: 'Europe/London' });

    // Test drive reminders — check every hour
    cron.schedule('0 * * * *', async () => {
        if (!sock || !isConnected) return;
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dayName = tomorrow.toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase();
        for (const booking of bookings) {
            if (booking.reminded) continue;
            if (booking.date.toLowerCase().includes(dayName)) {
                try {
                    await sock.sendMessage(booking.jid, {
                        text: `🚗 *AutoElite Reminder*\n\nHi ${booking.name}! Just a quick reminder that your test drive is *tomorrow* — ${booking.date}.\n\nCar: *${booking.car}*\n\nWe look forward to seeing you! To reschedule:\n📞 +44 (0) 800 AUTO ELITE\n\n— *AutoElite Team*`
                    });
                    booking.reminded = true;
                } catch (e) { console.log('Reminder failed:', e.message); }
            }
        }
    }, { timezone: 'Europe/London' });

    // Follow-up stale leads — daily at 9:30am
    cron.schedule('30 9 * * *', async () => {
        if (!sock || !isConnected) return;
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        const staleLeads = leads.filter(l =>
            l.lastContact < threeDaysAgo &&
            !l.followedUp &&
            !['sold', 'lost', 'deposit-requested'].includes(l.status) &&
            !isBlacklisted(l.phone)
        );
        let count = 0;
        for (const lead of staleLeads) {
            const c = customers[lead.phone];
            try {
                await sock.sendMessage(lead.jid, {
                    text: `👋 Hi ${lead.name || 'there'}! It's AutoElite — we just wanted to check in.\n\nAre you still looking for ${lead.interest || 'your perfect car'}? We're here to help! 🚗\n\nType *!inventory* to see our latest stock, or reply and let's chat.\n\n— *AutoElite Team*`
                });
                lead.followedUp = true;
                lead.lastContact = new Date().toISOString();
                count++;
            } catch (e) { console.log('Follow-up failed:', e.message); }
        }
        if (count > 0) sendToDirectors(`📣 *Follow-up sent to ${count} stale lead(s)*`);
    }, { timezone: 'Europe/London' });

    // After-sale review requests — daily at 10am (check for sold customers)
    cron.schedule('0 10 * * *', async () => {
        if (!sock || !isConnected) return;
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        for (const [phone, c] of Object.entries(customers)) {
            if (c.stage !== 'sold' || c.reviewRequested || c.feedbackGiven) continue;
            if (c.lastContact < threeDaysAgo && c.lastContact > twoDaysAgo) {
                try {
                    await sock.sendMessage(c.jid || phone + '@s.whatsapp.net', {
                        text: `Hi ${c.name || 'there'}! 🎉 Hope you're enjoying your new car!\n\nAt AutoElite, we're always looking to improve. Could you rate your experience from *1 to 5*?\n\n5 ⭐ Excellent\n4 ⭐ Good\n3 ⭐ Average\n2 ⭐ Poor\n1 ⭐ Very poor\n\nJust reply with a number. Thank you! 🙏\n\n— *AutoElite Team*`
                    });
                    updateCustomer(phone, { awaitingFeedback: true, reviewRequested: true });
                } catch {}
            }
        }
    }, { timezone: 'Europe/London' });

    console.log('✅ Automations scheduled: daily summary, weekly report, reminders, follow-ups, review requests');
}

// ── HTTP Server ───────────────────────────────────────────
app.get('/', async (req, res) => {
    if (isConnected) return res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:#fff">
        <h1 style="color:#4ade80">✅ AutoElite Bot Online</h1>
        <p style="color:#aaa">24/7 WhatsApp agent is connected and running</p>
        <p style="color:#666;font-size:12px">Leads: ${leads.length} | Bookings: ${bookings.length} | Stock: ${getAvailableInventory().length} cars</p>
        <p><a href="/leads" style="color:#4ade80">View Leads</a> &nbsp;|&nbsp; <a href="/bookings" style="color:#4ade80">Bookings</a> &nbsp;|&nbsp; <a href="/inventory" style="color:#4ade80">Inventory</a></p>
        </body></html>`);
    if (!latestQR) return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0a0a0a;color:#fff"><h2>⏳ Waiting for QR code...</h2><p style="color:#aaa">Refresh in a few seconds.</p></body></html>');
    const qrImage = await QRCode.toDataURL(latestQR);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
        <h2>▲ AutoElite WhatsApp Bot</h2>
        <p style="color:#aaa">Scan with WhatsApp to activate</p>
        <p style="font-size:12px;color:#666">WhatsApp → Settings → Linked Devices → Link a Device</p>
        <img src="${qrImage}" style="width:280px;height:280px;border-radius:12px;margin:20px auto;display:block"/>
        <p style="font-size:11px;color:#555">QR refreshes every 60s — reload page if it expires</p>
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
        await sock.sendMessage(ROLES.directors[0] + '@s.whatsapp.net', {
            text: `🧪 *Simulate* [${req.params.number}]: "${body}"\n\n🤖 Bot:\n${text}`
        }).catch(() => {});
    };
    const phone = req.params.number;
    if (isDirector(phone) || isAdmin(phone)) await handleDirector(jid, body, reply);
    else await handleCustomer(jid, body, reply);
    res.json({ success: true, from: phone, message: body, reply: botReply });
});

app.get('/leads', (req, res) => res.json(leads));
app.get('/bookings', (req, res) => res.json(bookings));
app.get('/inquiries', (req, res) => res.json(inquiries));
app.get('/inventory', (req, res) => res.json(inventory));
app.get('/deposits', (req, res) => res.json(deposits));
app.get('/feedback', (req, res) => res.json(feedback));
app.get('/customers', (req, res) => res.json(customers));

// CSV export
app.get('/leads-csv', (req, res) => {
    const headers = ['phone', 'name', 'interest', 'budget', 'status', 'stage', 'vip', 'firstContact', 'lastContact', 'followedUp', 'depositPaid'];
    const rows = leads.map(l => {
        const c = customers[l.phone] || {};
        return headers.map(h => {
            const val = l[h] ?? c[h] ?? '';
            return `"${String(val).replace(/"/g, '""')}"`;
        }).join(',');
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="autoelite-leads.csv"');
    res.send([headers.join(','), ...rows].join('\n'));
});

app.listen(PORT, () => console.log(`🚀 AutoElite server running on port ${PORT}`));

// ── Bot ───────────────────────────────────────────────────
async function startBot() {
    const { state, saveCreds } = await useGistAuthState();
    const { version } = await fetchLatestBaileysVersion();
    console.log('Baileys version:', version);

    sock = makeWASocket({
        version, auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['AutoElite Bot', 'Chrome', '1.0.0'],
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) { latestQR = qr; console.log('📱 QR code ready — scan at your deployment URL'); }
        if (connection === 'close') {
            isConnected = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('Connection closed, code:', code);
            if (code !== DisconnectReason.loggedOut) {
                console.log('Reconnecting...');
                setTimeout(startBot, 3000);
            }
        }
        if (connection === 'open') {
            isConnected = true;
            latestQR = null;
            console.log('✅ Bot connected!');
            startAutomations();
            // Set up control group
            setTimeout(async () => {
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    const existing = Object.values(groups).find(g => g.subject === 'AutoElite Control');
                    if (existing) {
                        controlGroupJid = existing.id;
                        await sock.sendMessage(controlGroupJid, { text: '✅ *AutoElite 24/7 Bot reconnected!*\n\nAll systems operational. Type !help to see director commands.' });
                    } else {
                        const group = await sock.groupCreate('AutoElite Control', []);
                        controlGroupJid = group.gid;
                        await sock.sendMessage(controlGroupJid, { text: '👑 *AutoElite Control Panel — Active*\n\nYour 24/7 AI sales agent is live!\n\nType !help to see all commands.' });
                    }
                } catch (e) { console.log('Group setup:', e.message); }
                // Notify directors
                sendToDirectors('🚀 *AutoElite 24/7 Bot is live!*\n\nYour AI sales agent is now active and handling customer enquiries around the clock.\n\nType !help for director commands.');
            }, 3000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const isControlGroup = msg.key.remoteJid === controlGroupJid;

        // Handle director commands from self or control group
        if ((msg.key.fromMe || isControlGroup) && body.startsWith('!')) {
            const replyJid = msg.key.remoteJid;
            return handleDirector(replyJid, body, (text) => sock.sendMessage(replyJid, { text }));
        }

        if (type !== 'notify') return;
        if (msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        if (!body) return;

        const phone = phoneFromJid(jid);
        const reply = (text) => sock.sendMessage(jid, { text });

        if (isDirector(phone) || isAdmin(phone)) return handleDirector(jid, body, reply);
        return handleCustomer(jid, body, reply);
    });
}

startBot().catch(console.error);
