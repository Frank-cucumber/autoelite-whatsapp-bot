// ── Claude AI Integration ─────────────────────────────────
// Uses Anthropic Claude for intelligent natural language understanding.
// Falls back gracefully if ANTHROPIC_API_KEY is not set.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are the AutoElite WhatsApp assistant — a professional, friendly sales agent for AutoElite, a premium exotic car dealership in the UK.

Your role:
- Help customers find their perfect car
- Answer questions about vehicles, pricing, finance, and test drives
- Capture leads and book appointments
- Be warm, knowledgeable, and professional at all times
- Use British English spellings and phrasing
- Keep replies concise (under 200 words) — this is WhatsApp

Inventory available:
1. Ferrari F8 Tributo — £312,000 | 710HP | 0-60 in 2.9s | 4,200 miles | Rosso Corsa
2. Lamborghini Huracán — £248,000 | 631HP | 0-60 in 3.0s | 6,800 miles | Giallo Inti
3. McLaren 720S — £225,000 | 720HP | 0-60 in 2.9s | 8,900 miles | Papaya Spark
4. Bentley Continental GT — £198,000 | 626HP | 0-60 in 3.6s | 11,000 miles | Beluga Black
5. Porsche 911 GT3 — £182,000 | 502HP | 0-60 in 3.2s | 2,100 miles | GT Silver

Finance: PCP from 9.9% APR, HP and lease available, 10% minimum deposit typical.
Location: AutoElite Showroom — https://autoelite-uk.netlify.app/#contact
Opening hours: Mon–Fri 9am–6pm | Sat 9am–5pm | Sun 10am–4pm

Important rules:
- Never make up prices or specs not listed above
- If asked about a car not in inventory, say you can source it and take their details
- Always aim to capture: customer name, budget, preferred car, and contact preference
- When a customer shows buying intent, escalate (say the team will call them shortly)
- Use emojis sparingly but effectively
- Sign off replies with — *AutoElite Team*`;

async function getAIReply(customerName, history, latestMessage) {
    if (!ANTHROPIC_KEY) return null;

    const messages = [];

    // Add conversation history (last 10 exchanges)
    const recent = history.slice(-20);
    for (const h of recent) {
        messages.push({
            role: h.role === 'bot' ? 'assistant' : 'user',
            content: h.message,
        });
    }

    // Add current message if not already in history
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.content !== latestMessage || lastMsg.role !== 'user') {
        messages.push({ role: 'user', content: latestMessage });
    }

    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': ANTHROPIC_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 400,
                system: SYSTEM_PROMPT + (customerName ? `\n\nThe customer's name is ${customerName}.` : ''),
                messages,
            }),
        });

        if (!res.ok) {
            const err = await res.text();
            console.log('AI API error:', err);
            return null;
        }

        const data = await res.json();
        return data.content?.[0]?.text || null;
    } catch (e) {
        console.log('AI request failed:', e.message);
        return null;
    }
}

// Classify intent from message to help route within state machine
async function classifyIntent(message) {
    if (!ANTHROPIC_KEY) return null;
    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': ANTHROPIC_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 20,
                system: 'Classify this WhatsApp message from a car dealership customer into exactly one of these intents (reply with just the word): greeting, testdrive, finance, tradein, inventory, hours, location, warranty, valuation, contact, thanks, deposit, feedback, buying_signal, other',
                messages: [{ role: 'user', content: message }],
            }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.content?.[0]?.text?.trim().toLowerCase() || null;
    } catch { return null; }
}

module.exports = { getAIReply, classifyIntent };
