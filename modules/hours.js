function isOpenNow() {
    const now = new Date(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }));
    const day = now.getDay();
    const hour = now.getHours();
    if (day >= 1 && day <= 5) return hour >= 9 && hour < 18;
    if (day === 6) return hour >= 9 && hour < 17;
    if (day === 0) return hour >= 10 && hour < 16;
    return false;
}

function nextOpenTime() {
    const now = new Date(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }));
    const day = now.getDay();
    const hour = now.getHours();
    if (day === 0 && hour >= 16) return 'Monday at 9:00am';
    if (day === 0) return 'today at 10:00am';
    if (day === 6 && hour >= 17) return 'Sunday at 10:00am';
    if (day === 6) return 'today at 9:00am';
    if (day >= 1 && day <= 4 && hour >= 18) return 'tomorrow at 9:00am';
    if (day === 5 && hour >= 18) return 'Saturday at 9:00am';
    return 'today at 9:00am';
}

function getUKHour() {
    const now = new Date(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }));
    return now.getHours();
}

function calcMonthlyPayment(price, depositPct = 10, termMonths = 48, apr = 9.9) {
    const deposit = price * (depositPct / 100);
    const loan = price - deposit;
    const monthlyRate = apr / 100 / 12;
    const payment = loan * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1);
    return {
        deposit: Math.round(deposit),
        monthly: Math.round(payment),
        total: Math.round(deposit + payment * termMonths),
        term: termMonths,
        apr,
    };
}

function formatCurrency(n) {
    return '£' + n.toLocaleString('en-GB');
}

module.exports = { isOpenNow, nextOpenTime, getUKHour, calcMonthlyPayment, formatCurrency };
