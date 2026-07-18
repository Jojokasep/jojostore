const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// Response helper
const resOk = (res, data, msg) => res.json({ status: 200, success: true, data, message: msg || 'OK' });
const resCreated = (res, data, msg) => res.json({ status: 201, success: true, data, message: msg || 'Created' });
const resBad = (res, msg) => res.status(400).json({ status: 400, success: false, message: msg });
const resErr = (res, msg) => res.status(500).json({ status: 500, success: false, message: msg || 'Server Error' });

const CFG = {
    TOKEN: '1349636:Lx4AfqGh0E2Kbd68COZmDyngc3HPIjQr',
    MID: '1349636',
    DEVICE: {
        app_reg_id: "dr5gziOnST6nZQFPrTGbda:APA91bFSvNYNiC_68rtd0q3tA-yX-vYcuYqTUTcc53PwWdDst_E4RrIaUGdxwRkymkLPlydc-W7Amc0IpDjoNF5k9-kShFZSxhiKFduaLcbOZzAsH0VmzBM",
        phone_uuid: "dr5gziOnST6nZQFPrTGbda", phone_model: "vivo 1935", phone_android_version: "10",
        app_version_code: "260115", auth_username: "jokowiiiiii", app_version_name: "26.01.15"
    },
    VOUCHER: { DANA: "3056", OVO: "11886", GOPAY: "3062", SHOPEEPAY: "3058" }
};
const QRIS_RAW = "00020101021126670016COM.NOBUBANK.WWW01189360050300000879140214508257991305870303UMI51440014ID.CO.QRIS.WWW0215ID20232921284770303UMI5204541153033605802ID5920JOJO STORE OK13496366006CIAMIS61054621162070703A0163045679";

async function hitAPI(url, extra = {}) {
    try {
        const p = new URLSearchParams({ ...CFG.DEVICE, ...extra, auth_token: CFG.TOKEN, request_time: String(Date.now()), ui_mode: 'dark' });
        const r = await axios.post(url, p, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Host': 'app.orderkuota.com', 'User-Agent': 'okhttp/4.9.3', 'auth-token': CFG.TOKEN }, timeout: 15000 });
        return r.data;
    } catch (e) { return null; }
}
const cleanNum = s => Number(String(s || '').replace(/\D/g, '')) || 0;
const validWallets = Object.keys(CFG.VOUCHER);

// ── Root — supaya nggak "Cannot GET /" ──────────────
app.get('/', (req, res) => {
    resOk(res, {
        name: 'JoJo Store API',
        version: 'v1',
        endpoints: {
            'GET  /api/v1/health': 'Cek status API',
            'GET  /api/v1/account/balance': 'Cek saldo',
            'POST /api/v1/qris/generate': 'Generate QRIS (body: {amount})',
            'GET  /api/v1/transactions': 'Mutasi QRIS',
            'POST /api/v1/transfers': 'Kirim e-wallet (body: {wallet, phone, nominal})',
            'POST /api/v1/transfers/withdraw': 'Transfer saldo QRIS (body: {amount})'
        }
    }, 'JoJo Store RESTful API');
});

// GET /api/v1/health
app.get('/api/v1/health', (req, res) => resOk(res, { uptime: process.uptime() }));

// GET /api/v1/account/balance
app.get('/api/v1/account/balance', async (req, res) => {
    const r = await hitAPI('https://app.orderkuota.com/api/v2/get', { 'requests[0]': 'account' });
    if (!r) return resErr(res, 'Provider tidak merespon');
    if (r.success && r.account?.results) return resOk(res, { balance: Number(r.account.results.balance) || 0, qris_balance: Number(r.account.results.qris_balance) || 0 });
    return resBad(res, r.message || 'Gagal ambil saldo');
});

// POST /api/v1/qris/generate
app.post('/api/v1/qris/generate', async (req, res) => {
    const amount = Number(req.body.amount);
    if (!amount || amount < 1000) return resBad(res, 'Minimal Rp 1.000');
    try {
        const r = await axios.post('https://qrisku.my.id/api', { qris_statis: QRIS_RAW, amount }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
        if (r.data?.status === 'success' && r.data.qris_base64) return resCreated(res, { amount, qris_base64: r.data.qris_base64 });
        return resBad(res, r.data?.message || 'Gagal generate QRIS');
    } catch (e) { return resErr(res, 'Layanan QRIS tidak merespon'); }
});

// GET /api/v1/transactions
app.get('/api/v1/transactions', async (req, res) => {
    const r = await hitAPI(`https://app.orderkuota.com/api/v2/qris/mutasi/${CFG.MID}`, {
        'requests[0]': 'account', 'requests[qris_history][page]': req.query.page || '1',
        'requests[qris_history][dari_tanggal]': '', 'requests[qris_history][ke_tanggal]': '', 'requests[qris_history][keterangan]': ''
    });
    if (!r) return resErr(res, 'Provider tidak merespon');
    if (r.success && r.qris_history?.results?.length > 0) {
        const tx = r.qris_history.results.map(t => ({
            id: t.id || null, tanggal: (t.tanggal || '').substring(0, 16).replace('T', ' '),
            keterangan: t.keterangan || '', kredit_clean: cleanNum(t.kredit),
            is_pencairan: String(t.keterangan || '').toLowerCase().includes('pencairan')
        }));
        return resOk(res, { transactions: tx, summary: { total: tx.length, income: tx.filter(t => !t.is_pencairan).reduce((s, t) => s + t.kredit_clean, 0) } });
    }
    return resOk(res, { transactions: [], summary: { total: 0, income: 0 } });
});

// POST /api/v1/transfers
app.post('/api/v1/transfers', async (req, res) => {
    const { wallet, phone, nominal } = req.body;
    const w = String(wallet || '').toUpperCase();
    const n = Number(nominal);
    const p = String(phone || '').replace(/\D/g, '');
    if (!validWallets.includes(w)) return resBad(res, 'Wallet harus: ' + validWallets.join(', '));
    if (!p || p.length < 10) return resBad(res, 'Nomor tidak valid');
    if (!n || n < 1000) return resBad(res, 'Minimal Rp 1.000');
    const r = await hitAPI('https://app.orderkuota.com/api/v2/order', { quantity: "1", id_plgn: String(n), kode_promo: "", pin: "", phone: p, voucher_id: CFG.VOUCHER[w], payment: "balance" });
    if (!r) return resErr(res, 'Provider tidak merespon');
    if (r.success) return resCreated(res, { transaction_id: r.results?.id || r.data?.id || null, wallet: w, phone: p, nominal: n });
    return resBad(res, r.message || 'Gagal transfer');
});

// POST /api/v1/transfers/withdraw
app.post('/api/v1/transfers/withdraw', async (req, res) => {
    const amount = Number(req.body.amount);
    if (!amount || amount < 1000) return resBad(res, 'Minimal Rp 1.000');
    const r = await hitAPI('https://app.orderkuota.com/api/v2/get', { 'requests[qris_withdraw][amount]': String(amount) });
    if (!r) return resErr(res, 'Provider tidak merespon');
    if (r.success && r.qris_withdraw?.success) return resCreated(res, { amount }, 'Rp ' + amount.toLocaleString('id-ID') + ' dipindahkan ke saldo utama');
    return resBad(res, r.message || 'Gagal transfer saldo');
});

// 404 untuk route yang tidak terdaftar
app.use('/api/v1', (req, res) => res.status(404).json({ status: 404, success: false, message: 'Endpoint ' + req.method + ' ' + req.path + ' tidak ditemukan' }));
app.use((err, req, res, next) => { console.error(err); resErr(res); });

app.listen(PORT, () => console.log('JoJo API v1 — port ' + PORT));