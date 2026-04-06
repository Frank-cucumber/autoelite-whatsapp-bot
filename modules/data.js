// ── Central Data Store ────────────────────────────────────

const ROLES = { directors: ['447383349557'], admins: [] };

const leads = [];
const bookings = [];
const inquiries = [];
const deposits = [];
const feedback = [];
const blacklist = [];

const inventory = [
    { id: 1, name: 'Ferrari F8 Tributo',    price: 312000, hp: 710,  speed: '2.9s', miles: 4200,  colour: 'Rosso Corsa',    status: 'available', watchers: [] },
    { id: 2, name: 'Lamborghini Huracán',   price: 248000, hp: 631,  speed: '3.0s', miles: 6800,  colour: 'Giallo Inti',    status: 'available', watchers: [] },
    { id: 3, name: 'Porsche 911 GT3',       price: 182000, hp: 502,  speed: '3.2s', miles: 2100,  colour: 'GT Silver',      status: 'available', watchers: [] },
    { id: 4, name: 'McLaren 720S',          price: 225000, hp: 720,  speed: '2.9s', miles: 8900,  colour: 'Papaya Spark',   status: 'available', watchers: [] },
    { id: 5, name: 'Bentley Continental GT',price: 198000, hp: 626,  speed: '3.6s', miles: 11000, colour: 'Beluga Black',   status: 'available', watchers: [] },
];

// Per-customer state: conversation steps, history, stage, VIP, notes
const customers = {};

const STAGES = ['enquiry', 'viewing', 'test drive', 'offer', 'sold', 'lost'];

function getCustomer(phone) {
    if (!customers[phone]) {
        customers[phone] = {
            phone,
            jid: null,
            name: null,
            vip: false,
            stage: 'enquiry',
            history: [],
            notes: [],
            interest: null,
            budget: null,
            firstContact: new Date().toISOString(),
            lastContact: new Date().toISOString(),
            followedUp: false,
            lostReason: null,
            depositPaid: false,
            reviewRequested: false,
            feedbackGiven: false,
            awaitingFeedback: false,
            step: null,
            stepData: {},
            outOfHoursNotified: false,
            welcomed: false,
            messageCount: 0,
        };
    }
    customers[phone].jid = customers[phone].jid || (phone + '@s.whatsapp.net');
    return customers[phone];
}

function updateCustomer(phone, data) {
    const c = getCustomer(phone);
    Object.assign(c, data, { lastContact: new Date().toISOString() });
}

function addHistory(phone, role, message) {
    const c = getCustomer(phone);
    c.history.push({ role, message, time: new Date().toISOString() });
    if (c.history.length > 80) c.history.shift();
}

function detectBuyingSignals(message) {
    const signals = [
        /i('ll| will) (take|buy|have) it/i,
        /how (do i|can i) (buy|purchase|pay|get it)/i,
        /\b(deposit|down payment|reserve|purchase|buy now)\b/i,
        /when can i (collect|pick up|get it)/i,
        /\b(deal|sold|yes please|let's do it)\b/i,
        /i('m| am) (interested|ready|keen|serious)/i,
        /\b(sign|paperwork|contract|handover)\b/i,
        /can i (buy|get|have) (it|this|one)/i,
    ];
    return signals.some(r => r.test(message));
}

function isBlacklisted(phone) {
    return blacklist.some(b => b.phone === phone);
}

function getAvailableInventory() {
    return inventory.filter(v => v.status === 'available');
}

function findVehicle(query) {
    const q = query.toLowerCase();
    return inventory.find(v =>
        v.name.toLowerCase().includes(q) ||
        v.colour.toLowerCase().includes(q) ||
        String(v.id) === q
    );
}

function addWatcher(vehicleId, phone) {
    const v = inventory.find(i => i.id === vehicleId);
    if (v && !v.watchers.includes(phone)) v.watchers.push(phone);
}

module.exports = {
    ROLES, leads, bookings, inquiries, deposits, feedback, blacklist, inventory,
    customers, STAGES,
    getCustomer, updateCustomer, addHistory,
    detectBuyingSignals, isBlacklisted,
    getAvailableInventory, findVehicle, addWatcher,
};
