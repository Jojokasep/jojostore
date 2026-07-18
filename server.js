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

const CONFIG = {
    AUTH_TOKEN: '1349636:Lx4AfqGh0E2Kbd68COZmDyngc3HPIjQr',
    DEVICE_DATA: {
        app_reg_id: "dr5gziOnST6nZQFPrTGbda:APA91bFSvNYNiC_68rtd0q3tA-yX-vYcuYqTUTcc53PwWdDst_E4RrIaUGdxwRkymkLPlydc-W7Amc0IpDjoNF5k9-kShFZSxhiKFduaLcbOZzAsH0VmzBM",
        phone_uuid: "dr5gziOnST6nZQFPrTGbda", phone_model: "vivo 1935", phone_android_version: "10",
        app_version_code: "260115", auth_username: "jokowiiiiii", app_version_name: "26.01.15"
    },
    VOUCHER_DANA: "3056", VOUCHER_OVO: "11886", VOUCHER_GOPAY: "3062", VOUCHER_SHOPEEPAY: "3058",
    DEFAULT_STORE_NAME: "JOJO STORE"
};
const QRIS_RAW = "00020101021126670016COM.NOBUBANK.WWW01189360050300000879140214508257991305870303UMI51440014ID.CO.QRIS.WWW0215ID20232921284770303UMI5204541153033605802ID5920JOJO STORE OK13496366006CIAMIS61054621162070703A0163045679";

// ============================================================
// DATA STORE
// ============================================================
const DATA_FILE = path.join(__dirname, 'data.json');
let db = { webhooks: [], seenTx: [], logs: [] };
function loadDb() { try { if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch(e){} }
function saveDb() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch(e){} }
loadDb();

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');

// ============================================================
// QRIS: CRC16-CCITT & Custom Name Builder
// ============================================================
function crc16ccitt(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
        crc ^= str.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

function buildQrisWithName(name) {
    // Parse TLV dari QRIS_RAW
    const tlvs = [];
    let i = 0;
    while (i < QRIS_RAW.length - 4) {
        const tag = QRIS_RAW.substring(i, i + 2);
        const len = parseInt(QRIS_RAW.substring(i + 2, i + 4), 10);
        const val = QRIS_RAW.substring(i + 4, i + 4 + len);
        tlvs.push({ tag, val });
        i += 4 + len;
    }
    // Ganti Tag 59 (Merchant Name), max 25 karakter
    const cleanName = String(name || CONFIG.DEFAULT_STORE_NAME).toUpperCase().substring(0, 25);
    const idx = tlvs.findIndex(t => t.tag === '59');
    if (idx !== -1) tlvs[idx].val = cleanName;
    // Rebuild tanpa CRC (Tag 63)
    let payload = '';
    for (const t of tlvs) {
        if (t.tag === '63') continue;
        payload += t.tag + String(t.val.length).padStart(2, '0') + t.val;
    }
    // Hitung & append CRC baru
    return payload + '6304' + crc16ccitt(payload);
}

// ============================================================
// WEBHOOK BROADCAST
// ============================================================
async function broadcastEvent(event, data) {
    const targets = db.webhooks.filter(w => w.active && (!w.events || w.events.length === 0 || w.events.includes(event)));
    for (const wh of targets) {
        const payload = { event, data, timestamp: Date.now() };
        const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret || WEBHOOK_SECRET).update(JSON.stringify(payload)).digest('hex');
        const log = { id: crypto.randomUUID(), url: wh.url, event, direction: 'outgoing', status: 'pending', timestamp: new Date().toISOString() };
        try {
            const res = await axios.post(wh.url, payload, {
                headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sig, 'X-Webhook-Event': event },
                timeout: 15000
            });
            log.status = res.status >= 200 && res.status < 300 ? 'success' : `http_${res.status}`;
        } catch (e) {
            log.status = e.code === 'ECONNREFUSED' ? 'connection_refused' : 'error';
        }
        db.logs.unshift(log);
    }
    if (db.logs.length > 300) db.logs = db.logs.slice(0, 300);
    saveDb();
    console.log(`[Webhook] ${event} -> ${targets.length} URL`);
}

// ============================================================
// SSE
// ============================================================
const sseClients = new Set();
function notifySSE(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let dead = [];
    for (const c of sseClients) { try { c.write(msg); } catch(e) { dead.push(c); } }
    dead.forEach(c => sseClients.delete(c));
}

app.get('/api/sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('event: connected\ndata: {"status":"ok"}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
});

// ============================================================
// AUTO-POLLING QRIS
// ============================================================
let isPolling = false;
async function pollQris() {
    if (isPolling) return;
    isPolling = true;
    try {
        const result = await hitApi('https://app.orderkuota.com/api/v2/qris/mutasi/1349636', {
            'requests[0]': 'account', 'requests[qris_history][page]': '1',
            'requests[qris_history][dari_tanggal]': '', 'requests[qris_history][ke_tanggal]': '', 'requests[qris_history][keterangan]': ''
        });
        if (result.success && result.qris_history?.results) {
            for (const tx of result.qris_history.results) {
                const txKey = `${tx.id}_${tx.tanggal}_${tx.kredit}`;
                if (!db.seenTx.includes(txKey)) {
                    db.seenTx.unshift(txKey);
                    if (db.seenTx.length > 1000) db.seenTx = db.seenTx.slice(0, 1000);
                    const amount = cleanNum(tx.kredit);
                    const isPencairan = String(tx.keterangan || '').toLowerCase().includes('pencairan');
                    if (amount > 0 && !isPencairan) {
                        const payload = { id: tx.id, amount, keterangan: tx.keterangan, tanggal: tx.tanggal, status: tx.status };
                        await broadcastEvent('payment.in', payload);
                        notifySSE('payment.in', payload);
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
// HELPER
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

// ============================================================
// API: AKUN
// ============================================================
app.get('/api/saldo', async (req, res) => {
    const r = await hitApi('https://app.orderkuota.com/api/v2/get', { 'requests[0]': 'account' });
    if (r.success && r.account) res.json({ success: true, balance: r.account.results.balance, qris_balance: r.account.results.qris_balance });
    else res.json({ success: false, message: "Gagal ambil saldo" });
});

// QRIS — sekarang support ?name=NAMA+TOKO
app.get('/api/qris', async (req, res) => {
    const amount = req.query.amount;
    if (!amount || Number(amount) < 1000) return res.status(400).json({ success: false, message: "Parameter amount wajib, minimal 1000" });
    // Build QRIS dengan nama custom (atau default)
    const storeName = req.query.name || CONFIG.DEFAULT_STORE_NAME;
    const qrisString = buildQrisWithName(storeName);
    try {
        const r = await axios.post('https://qrisku.my.id/api', { qris_statis: qrisString, amount: Number(amount) }, { headers: { 'Content-Type': 'application/json' } });
        if (r.data.status === 'success') res.json({ success: true, qris_base64: r.data.qris_base64, amount: Number(amount), store_name: storeName.toUpperCase() });
        else res.json({ success: false, message: r.data.message });
    } catch(e) { res.status(500).json({ success: false, message: "Gagal generate QRIS" }); }
});

app.get('/api/mutasi', async (req, res) => {
    const r = await hitApi('https://app.orderkuota.com/api/v2/qris/mutasi/1349636', { 'requests[0]': 'account', 'requests[qris_history][page]': req.query.page || '1', 'requests[qris_history][dari_tanggal]': req.query.dari || '', 'requests[qris_history][ke_tanggal]': req.query.sampai || '', 'requests[qris_history][keterangan]': '' });
    if (r.success && r.qris_history?.results) {
        const clean = r.qris_history.results.map(t => ({ ...t, kredit_clean: cleanNum(t.kredit) }));
        res.json({ success: true, data: clean });
    } else res.json({ success: true, data: [] });
});

// ============================================================
// API: TRANSAKSI
// ============================================================
app.post('/api/order', async (req, res) => {
    const { wallet, phone, nominal } = req.body;
    if (!wallet || !phone || !nominal) return res.status(400).json({ success: false, message: "wallet, phone, nominal wajib" });
    const map = { DANA: CONFIG.VOUCHER_DANA, OVO: CONFIG.VOUCHER_OVO, GOPAY: CONFIG.VOUCHER_GOPAY, SHOPEEPAY: CONFIG.VOUCHER_SHOPEEPAY };
    if (!map[wallet]) return res.status(400).json({ success: false, message: "Wallet tidak valid (DANA/OVO/GOPAY/SHOPEEPAY)" });
    const r = await hitApi('https://app.orderkuota.com/api/v2/order', { quantity: "1", id_plgn: String(nominal), kode_promo: "", pin: "", phone, voucher_id: map[wallet], payment: "balance" });
    if (r.success) {
        const idTrx = r.results?.id || r.data?.id || "N/A";
        const payload = { id: idTrx, wallet, phone, nominal: Number(nominal) };
        await broadcastEvent('order.success', payload);
        notifySSE('order.success', payload);
        res.json({ success: true, id_trx: idTrx });
    } else res.json({ success: false, message: r.message || "Gagal memproses order" });
});

app.post('/api/withdraw', async (req, res) => {
    const { amount } = req.body;
    if (!amount || Number(amount) < 1000) return res.status(400).json({ success: false, message: "Minimal 1000" });
    const r = await hitApi('https://app.orderkuota.com/api/v2/get', { 'requests[qris_withdraw][amount]': String(amount) });
    if (r.success && r.qris_withdraw?.success) {
        const payload = { amount: Number(amount) };
        await broadcastEvent('withdraw.success', payload);
        notifySSE('withdraw.success', payload);
        res.json({ success: true, message: `Transfer Rp ${Number(amount).toLocaleString('id-ID')} berhasil` });
    } else res.json({ success: false, message: r.message || "Gagal transfer" });
});

// ============================================================
// API: WEBHOOK MANAGEMENT
// ============================================================
app.get('/api/webhook', (req, res) => {
    res.json({ success: true, data: db.webhooks, secret: WEBHOOK_SECRET, incoming_url: `${req.protocol}://${req.get('host')}/api/webhook/incoming` });
});

app.post('/api/webhook', (req, res) => {
    const { url, secret, events } = req.body;
    if (!url) return res.status(400).json({ success: false, message: "url wajib" });
    try { new URL(url); } catch(e) { return res.status(400).json({ success: false, message: "url tidak valid" }); }
    const entry = { id: crypto.randomUUID(), url, secret: secret || '', events: events || [], active: true, created_at: new Date().toISOString() };
    db.webhooks.push(entry); saveDb();
    res.json({ success: true, message: "Webhook terdaftar", data: entry });
});

app.delete('/api/webhook/:id', (req, res) => {
    const i = db.webhooks.findIndex(w => w.id === req.params.id);
    if (i === -1) return res.status(404).json({ success: false, message: "Tidak ditemukan" });
    db.webhooks.splice(i, 1); saveDb();
    res.json({ success: true, message: "Webhook dihapus" });
});

app.post('/api/webhook/incoming', (req, res) => {
    const sig = req.headers['x-webhook-signature'] || '';
    if (sig) {
        const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(req.body)).digest('hex');
        if (sig !== expected) return res.status(401).json({ success: false, message: "Signature invalid" });
    }
    db.logs.unshift({ id: crypto.randomUUID(), event: req.headers['x-webhook-event'] || 'incoming', direction: 'incoming', payload: req.body, status: 'received', timestamp: new Date().toISOString() });
    saveDb();
    res.json({ success: true, message: "Diterima" });
});

app.get('/api/webhook/logs', (req, res) => {
    res.json({ success: true, data: db.logs.slice(0, 50) });
});

app.post('/api/webhook/reset', (req, res) => {
    db.seenTx = []; saveDb();
    res.json({ success: true, message: "Seen transactions direset" });
});

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'ok', service: 'JoJo Store API', version: '2.1',
        endpoints: ['/api/saldo', '/api/qris?amount=&name=', '/api/mutasi', '/api/order', '/api/withdraw', '/api/webhook', '/api/sse']
    });
});

app.listen(PORT, () => console.log(`JoJo Store API v2.1 berjalan di port ${PORT}`));