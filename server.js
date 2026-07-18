const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ============================================================
// DATABASE (In-Memory, persist ke file JSON)
// ============================================================
const DB_FILE = path.join(__dirname, 'merchants_db.json');
let db = { users: [], sessions: [], webhooks: [], seenTx: [], logs: [] };
function loadDb() { try { if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8)); } catch(e) {} }
function saveDb() { try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch(e) {} }
loadDb();

const CONFIG = {
    AUTH_TOKEN: '1349636:Lx4AfqGh0E2Kbd68COZmDyngc3HPIjQr',
    DEVICE_DATA: {
        app_reg_id: "dr5gziOnST6nZQFPrTGbda:APA91bFSvNYNiC_68rtd0q3tA-yX-vYcuYqTUTcc53PwWdDst_E4RrIaUGdxwRkymkLPlydc-W7Amc0IpDjoNF5k9-kShFZSxhiKFduaLcbOZzAsH0VmzBM",
        phone_uuid: "dr5gziOnST6nZQFPrTGbda", phone_model: "vivo 1935", phone_android_version: "10",
        app_version_code: "260115", auth_username: "jokowiiiiii", app_version_name: "26.01.15"
    },
    VOUCHER_DANA: "3056", VOUCHER_OVO: "11886", VOUCHER_GOPAY: "3062", VOUCHER_SHOPEEPAY: "3058"
};
const QRIS_RAW = "00020101021126670016COM.NOBUBANK.WWW01189360050300000879140214508257991305870303UMI51440014ID.CO.QRIS.WWW0215ID20232921284770303UMI5204541153033605802ID5920JOJO STORE OK13496366006CIAMIS61054621162070703A0163045679";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');

// ============================================================
// HELPERS
// ============================================================
async function hitApi(url, data) {
    try {
        const p = { ...CONFIG.DEVICE_DATA, ...data, auth_token: CONFIG.AUTH_TOKEN, request_time: Date.now().toString(), ui_mode: 'dark' };
        const params = new URLSearchParams(); for (const k in p) params.append(k, p[k]);
        const res = await axios.post(url, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Host': 'app.orderkuota.com', 'User-Agent': 'okhttp/4.9.3', 'auth-token': CONFIG.AUTH_TOKEN } });
        return res.data;
    } catch(e) { return { success: false, message: "Koneksi Error" }; }
}
function cleanNum(s) { return Number(String(s||'').replace(/[^0-9]/g,'')) || 0; }
function crc16ccitt(str) { let crc = 0xFFFF; for (let i = 0; i < str.length; i++) { crc ^= str.charCodeAt(i) << 8; for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF; } return crc.toString(16).toUpperCase().padStart(4, '0'); }
function buildQrisWithName(name) {
    const tlvs = []; let i = 0;
    while (i < QRIS_RAW.length - 4) { const tag = QRIS_RAW.substring(i, i+2), len = parseInt(QRIS_RAW.substring(i+2, i+4), 10), val = QRIS_RAW.substring(i+4, i+4+len); tlvs.push({tag, val}); i += 4 + len; }
    const cleanName = String(name || 'STORE').toUpperCase().substring(0, 25);
    const idx = tlvs.findIndex(t => t.tag === '59'); if (idx !== -1) tlvs[idx].val = cleanName;
    let payload = ''; for (const t of tlvs) { if (t.tag === '63') continue; payload += t.tag + String(t.val.length).padStart(2, '0') + t.val; }
    return payload + '6304' + crc16ccitt(payload);
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function auth(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, message: "Token diperlukan" });
    const session = db.sessions.find(s => s.token === token);
    if (!session) return res.status(401).json({ success: false, message: "Sesi expired" });
    const user = db.users.find(u => u.id === session.userId);
    if (!user) return res.status(401).json({ success: false, message: "User tidak ditemukan" });
    req.user = user; next();
}

// ============================================================
// SSE & WEBHOOK ENGINE
// ============================================================
const sseClients = new Map(); // userId -> Set<res>
function notifySSE(userId, event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const clients = sseClients.get(userId);
    if (clients) { let dead = []; for (const c of clients) { try { c.write(msg); } catch(e) { dead.push(c); } } dead.forEach(c => clients.delete(c)); if (clients.size === 0) sseClients.delete(userId); }
}
function broadcastWebhook(event, data) {
    const targets = db.webhooks.filter(w => w.active && (!w.events || w.events.length === 0 || w.events.includes(event)));
    for (const wh of targets) {
        const payload = { event, data, timestamp: Date.now() };
        const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret || WEBHOOK_SECRET).update(JSON.stringify(payload)).digest('hex');
        const log = { id: crypto.randomUUID(), url: wh.url, event, status: 'pending', timestamp: new Date().toISOString() };
        try { const res = await axios.post(wh.url, payload, { headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sig, 'X-Webhook-Event': event }, timeout: 15000 }); log.status = res.status >= 200 && res.status < 300 ? 'success' : `http_${res.status}`; }
        catch (e) { log.status = e.code === 'ECONNREFUSED' ? 'refused' : 'error'; }
        db.logs.unshift(log);
    }
    if (db.logs.length > 200) db.logs = db.logs.slice(0, 200); saveDb();
}

// ============================================================
// AUTO-POLLING & ROUTING KE MERCHANT
// ============================================================
let isPolling = false;
async function pollQris() {
    if (isPolling) return; isPolling = true;
    try {
        const result = await hitApi('https://app.orderkuota.com/api/v2/qris/mutasi/1349636', { 'requests[0]': 'account', 'requests[qris_history][page]': '1', 'requests[qris_history][dari_tanggal]': '', 'requests[qris_history][ke_tanggal]': '', 'requests[qris_history][keterangan]': '' });
        if (result.success && result.qris_history?.results) {
            for (const tx of result.qris_history.results) {
                const txKey = `${tx.id}_${tx.tanggal}_${tx.kredit}`;
                if (!db.seenTx.includes(txKey)) {
                    db.seenTx.unshift(txKey); if (db.seenTx.length > 1000) db.seenTx = db.seenTx.slice(0, 1000);
                    const amount = cleanNum(tx.kredit);
                    const isPencairan = String(tx.keterangan || '').toLowerCase().includes('pencairan');
                    if (amount > 0 && !isPencairan) {
                        // Cari merchant yang aktif QRIS-nya (by keterangan)
                        const ket = String(tx.keterangan || '').toLowerCase();
                        let targetUser = null;
                        // Cara 1: cocokkan nama toko di keterangan
                        for (const u of db.users) { if (u.qrisActive && ket.includes(u.storeName.toLowerCase())) { targetUser = u; break; } }
                        // Cara 2: kalau cuma 1 merchant yang aktif QRIS, kasih ke dia
                        if (!targetUser) { const active = db.users.filter(u => u.qrisActive); if (active.length === 1) targetUser = active[0]; }
                        // Cara 3: kalau tidak ada yang cocok, simpan ke admin (user pertama)
                        if (!targetUser && db.users.length > 0) targetUser = db.users[0];

                        if (targetUser) {
                            targetUser.balance = (Number(targetUser.balance) || 0) + amount;
                            const txRecord = { id: tx.id, type: 'qris_in', amount, keterangan: tx.keterangan, tanggal: tx.tanggal, status: tx.status, createdAt: new Date().toISOString() };
                            if (!targetUser.transactions) targetUser.transactions = [];
                            targetUser.transactions.unshift(txRecord);
                            saveDb();
                            const payload = { merchantId: targetUser.id, merchantName: targetUser.storeName, amount, keterangan: tx.keterangan, tanggal: tx.tanggal };
                            notifySSE(targetUser.id, 'payment.in', payload);
                            broadcastWebhook('payment.in', payload);
                        }
                    }
                    saveDb();
                }
            }
        }
    } catch(e) { console.log('[Poll] Error:', e.message); }
    isPolling = false;
}
setInterval(pollQris, 10000);
setTimeout(pollQris, 2000);

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/auth/register', (req, res) => {
    const { username, password, storeName } = req.body;
    if (!username || !password || !storeName) return res.status(400).json({ success: false, message: "Username, password, nama toko wajib" });
    if (username.length < 3) return res.status(400).json({ success: false, message: "Username min 3 karakter" });
    if (password.length < 4) return res.status(400).json({ success: false, message: "Password min 4 karakter" });
    if (db.users.find(u => u.username === username)) return res.status(400).json({ success: false, message: "Username sudah dipakai" });
    const user = { id: crypto.randomUUID(), username, password: crypto.createHash('sha256').update(password).digest('hex'), storeName: storeName.toUpperCase().substring(0, 25), balance: 0, qrisActive: false, transactions: [], createdAt: new Date().toISOString() };
    db.users.push(user); saveDb();
    const token = crypto.randomUUID();
    db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() }); saveDb();
    res.json({ success: true, message: "Registrasi berhasil", data: { token, user: { id: user.id, username: user.username, storeName: user.storeName, balance: user.balance, qrisActive: user.qrisActive } } });
});

app.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: "Username dan password wajib" });
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    const user = db.users.find(u => u.username === username && u.password === hash);
    if (!user) return res.status(401).json({ success: false, message: "Username atau password salah" });
    const token = crypto.randomUUID();
    db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() }); saveDb();
    res.json({ success: true, message: "Login berhasil", data: { token, user: { id: user.id, username: user.username, storeName: user.storeName, balance: user.balance, qrisActive: user.qrisActive } } });
});

app.post('/auth/logout', auth, (req, res) => {
    db.sessions = db.sessions.filter(s => s.userId !== req.user.id); saveDb();
    res.json({ success: true, message: "Logout berhasil" });
});

app.get('/auth/me', auth, (req, res) => {
    res.json({ success: true, data: { id: req.user.id, username: req.user.username, storeName: req.user.storeName, balance: req.user.balance, qrisActive: req.user.qrisActive } });
});

// ============================================================
// MERCHANT ROUTES (Perlu Login)
// ============================================================

// Toggle QRIS aktif/nonaktif
app.post('/merchant/qris/toggle', auth, (req, res) => {
    req.user.qrisActive = !req.user.qrisActive; saveDb();
    res.json({ success: true, message: `QRIS ${req.user.qrisActive ? 'diaktifkan' : 'dinonaktifkan'}`, data: { qrisActive: req.user.qrisActive } });
});

// Generate QRIS
app.get('/merchant/qris', auth, (req, res) => {
    const amount = req.query.amount;
    if (!amount || Number(amount) < 1000) return res.status(400).json({ success: false, message: "Amount wajib, minimal 1000" });
    if (!req.user.qrisActive) return res.status(400).json({ success: false, message: "Aktifkan QRIS terlebih dahulu" });
    const qrisString = buildQrisWithName(req.user.storeName);
    axios.post('https://qrisku.my.id/api', { qris_statis: qrisString, amount: Number(amount) }, { headers: { 'Content-Type': 'application/json' } })
        .then(r => { if (r.data.status === 'success') res.json({ success: true, qris_base64: r.data.qris_base64, amount: Number(amount), store_name: req.user.storeName }); else res.json({ success: false, message: r.data.message }); })
        .catch(() => res.status(500).json({ success: false, message: "Gagal generate" }));
});

// Cek saldo merchant
app.get('/merchant/saldo', auth, (req, res) => {
    res.json({ success: true, data: { balance: req.user.balance, storeName: req.user.storeName, qrisActive: req.user.qrisActive } });
});

// Mutasi merchant (hanya miliknya)
app.get('/merchant/mutasi', auth, (req, res) => {
    const txs = (req.user.transactions || []).map(t => ({ ...t, amount_clean: cleanNum(t.kredit || t.amount) }));
    res.json({ success: true, data: txs });
});

// WITHDRAW ke e-wallet (pakai saldo orderkuota via voucher DANA/OVO/dll)
app.post('/merchant/withdraw', auth, async (req, res) => {
    const { wallet, phone, amount } = req.body;
    if (!wallet || !phone || !amount) return res.status(400).json({ success: false, message: "wallet, phone, amount wajib" });
    if (Number(amount) < 1000) return res.status(400).json({ success: false, message: "Minimal 1000" });
    if (Number(amount) > Number(req.user.balance)) return res.status(400).json({ success: false, message: "Saldo tidak cukup" });
    const map = { DANA: CONFIG.VOUCHER_DANA, OVO: CONFIG.VOUCHER_OVO, GOPAY: CONFIG.VOUCHER_GOPAY, SHOPEEPAY: CONFIG.VOUCHER_SHOPEEPAY };
    if (!map[wallet]) return res.status(400).json({ success: false, message: "Wallet tidak valid" });
    
    const r = await hitApi('https://app.orderkuota.com/api/v2/order', { quantity: "1", id_plgn: String(amount), kode_promo: "", pin: "", phone, voucher_id: map[wallet], payment: "balance" });
    if (r.success) {
        const idTrx = r.results?.id || r.data?.id || "N/A";
        req.user.balance = (Number(req.user.balance) || 0) - Number(amount);
        if (!req.user.transactions) req.user.transactions = [];
        req.user.transactions.unshift({ id: idTrx, type: 'withdraw', wallet, phone, amount: Number(amount), keterangan: `Withdraw ${wallet} ${phone}`, tanggal: new Date().toISOString(), status: 'success', createdAt: new Date().toISOString() });
        saveDb();
        const payload = { merchantId: req.user.id, id: idTrx, wallet, phone, amount: Number(amount) };
        notifySSE(req.user.id, 'withdraw.success', payload);
        broadcastWebhook('withdraw.success', payload);
        res.json({ success: true, message: `Withdraw ${wallet} ${phone} berhasil`, data: { id_trx: idTrx, remaining_balance: req.user.balance } });
    } else res.json({ success: false, message: r.message || "Gagal memproses" });
});

// SSE
app.get('/merchant/sse', auth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders();
    res.write('event: connected\ndata: {"status":"ok"}\n\n');
    if (!sseClients.has(req.user.id)) sseClients.set(req.user.id, new Set());
    sseClients.get(req.user.id).add(res);
    req.on('close', () => { const c = sseClients.get(req.user.id); if (c) { c.delete(res); if (c.size === 0) sseClients.delete(req.user.id); } });
});

// ============================================================
// ADMIN: Lihat semua merchant (opsional, buat monitoring)
// ============================================================
app.get('/admin/merchants', (req, res) => {
    res.json({ success: true, data: db.users.map(u => ({ id: u.id, username: u.username, storeName: u.storeName, balance: u.balance, qrisActive: u.qrisActive, txCount: (u.transactions||[]).length })) });
});

// ============================================================
// WEBHOOK MANAGEMENT
// ============================================================
app.get('/api/webhook', (req, res) => { res.json({ success: true, data: db.webhooks, secret: WEBHOOK_SECRET }); });
app.post('/api/webhook', (req, res) => { const { url, secret, events } = req.body; if (!url) return res.status(400).json({ success: false, message: "url wajib" }); try { new URL(url); } catch(e) { return res.status(400).json({ success: false, message: "url tidak valid" }); } const entry = { id: crypto.randomUUID(), url, secret: secret || '', events: events || [], active: true, createdAt: new Date().toISOString() }; db.webhooks.push(entry); saveDb(); res.json({ success: true, data: entry }); });
app.delete('/api/webhook/:id', (req, res) => { const i = db.webhooks.findIndex(w => w.id === req.params.id); if (i === -1) return res.status(404).json({ success: false, message: "Tidak ditemukan" }); db.webhooks.splice(i, 1); saveDb(); res.json({ success: true, message: "Dihapus" }); });

app.listen(PORT, () => console.log(`Multi-Merchant API berjalan di port ${PORT}`));
