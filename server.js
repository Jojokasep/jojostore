const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Response Helper ( Konsisten ) ──────────────────────
function respond(res, statusCode, success, data = null, message = '') {
    const payload = { status: statusCode, success };
    if (data !== null) payload.data = data;
    if (message) payload.message = message;
    return res.status(statusCode).json(payload);
}

const ok      = (res, data, msg) => respond(res, 200, true, data, msg || 'OK');
const created = (res, data, msg) => respond(res, 201, true, data, msg || 'Created');
const bad     = (res, msg)       => respond(res, 400, false, null, msg);
const serverErr= (res, msg)      => respond(res, 500, false, null, msg || 'Internal Server Error');

// ── Konfigurasi ────────────────────────────────────────
const CONFIG = {
    AUTH_TOKEN: '1349636:Lx4AfqGh0E2Kbd68COZmDyngc3HPIjQr',
    MERCHANT_ID: '1349636',
    DEVICE_DATA: {
        app_reg_id: "dr5gziOnST6nZQFPrTGbda:APA91bFSvNYNiC_68rtd0q3tA-yX-vYcuYqTUTcc53PwWdDst_E4RrIaUGdxwRkymkLPlydc-W7Amc0IpDjoNF5k9-kShFZSxhiKFduaLcbOZzAsH0VmzBM",
        phone_uuid: "dr5gziOnST6nZQFPrTGbda",
        phone_model: "vivo 1935",
        phone_android_version: "10",
        app_version_code: "260115",
        auth_username: "jokowiiiiii",
        app_version_name: "26.01.15"
    },
    VOUCHERS: {
        DANA:      "3056",
        OVO:       "11886",
        GOPAY:     "3062",
        SHOPEEPAY: "3058"
    }
};

const QRIS_RAW = "00020101021126670016COM.NOBUBANK.WWW01189360050300000879140214508257991305870303UMI51440014ID.CO.QRIS.WWW0215ID20232921284770303UMI5204541153033605802ID5920JOJO STORE OK13496366006CIAMIS61054621162070703A0163045679";

// ── Fungsi Bantu ───────────────────────────────────────
async function hitOrderkuotaAPI(url, extraData = {}) {
    try {
        const payload = {
            ...CONFIG.DEVICE_DATA,
            ...extraData,
            auth_token: CONFIG.AUTH_TOKEN,
            request_time: Date.now().toString(),
            ui_mode: 'dark'
        };
        const params = new URLSearchParams();
        for (const key in payload) params.append(key, payload[key]);

        const response = await axios.post(url, params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Host': 'app.orderkuota.com',
                'User-Agent': 'okhttp/4.9.3',
                'auth-token': CONFIG.AUTH_TOKEN
            },
            timeout: 15000
        });
        return response.data;
    } catch (error) {
        console.error('[Orderkuota API Error]', error.message);
        return null;
    }
}

function cleanNumber(str) {
    if (!str) return 0;
    return Number(String(str).replace(/[^0-9]/g, '')) || 0;
}

function resolveVoucherId(wallet) {
    const w = String(wallet).toUpperCase();
    return CONFIG.VOUCHERS[w] || CONFIG.VOUCHERS.DANA;
}

// ════════════════════════════════════════════════════════
//  RESTFUL ROUTES  —  /api/v1/
// ════════════════════════════════════════════════════════

// ── Health Check ───────────────────────────────────────
app.get('/api/v1/health', (req, res) => {
    ok(res, { uptime: process.uptime(), timestamp: Date.now() }, 'Service is running');
});

// ── 1. Saldo (Account Balance) ─────────────────────────
// GET /api/v1/account/balance
app.get('/api/v1/account/balance', async (req, res) => {
    const result = await hitOrderkuotaAPI('https://app.orderkuota.com/api/v2/get', {
        'requests[0]': 'account'
    });
    if (!result) return serverErr(res, 'Gagal terhubung ke provider');

    if (result.success && result.account?.results) {
        const { balance, qris_balance } = result.account.results;
        return ok(res, {
            balance: Number(balance) || 0,
            qris_balance: Number(qris_balance) || 0
        });
    }
    return bad(res, result.message || 'Gagal mengambil saldo');
});

// ── 2. QRIS Generate ──────────────────────────────────
// POST /api/v1/qris/generate
app.post('/api/v1/qris/generate', async (req, res) => {
    const { amount } = req.body;
    const numAmount = Number(amount);

    if (!numAmount || numAmount < 1000) {
        return bad(res, 'Nominal wajib diisi dan minimal Rp 1.000');
    }

    try {
        const response = await axios.post('https://qrisku.my.id/api', {
            qris_statis: QRIS_RAW,
            amount: numAmount
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        if (response.data?.status === 'success' && response.data.qris_base64) {
            return created(res, {
                amount: numAmount,
                qris_base64: response.data.qris_base64
            }, 'QRIS berhasil digenerate');
        }
        return bad(res, response.data?.message || 'Gagal generate QRIS dari provider');
    } catch (error) {
        console.error('[QRIS Error]', error.message);
        return serverErr(res, 'Gagal terhubung ke layanan QRIS');
    }
});

// ── 3. Transaksi / Mutasi ─────────────────────────────
// GET /api/v1/transactions?page=1&dari=&ke=&keterangan=
app.get('/api/v1/transactions', async (req, res) => {
    const page = req.query.page || '1';
    const dari = req.query.dari || '';
    const ke = req.query.ke || '';
    const keterangan = req.query.keterangan || '';

    const result = await hitOrderkuotaAPI(
        `https://app.orderkuota.com/api/v2/qris/mutasi/${CONFIG.MERCHANT_ID}`,
        {
            'requests[0]': 'account',
            'requests[qris_history][page]': String(page),
            'requests[qris_history][dari_tanggal]': dari,
            'requests[qris_history][ke_tanggal]': ke,
            'requests[qris_history][keterangan]': keterangan
        }
    );

    if (!result) return serverErr(res, 'Gagal terhubung ke provider');

    if (result.success && result.qris_history?.results?.length > 0) {
        const transactions = result.qris_history.results.map(t => ({
            id: t.id || null,
            tanggal: t.tanggal || t.date || null,
            keterangan: t.keterangan || '',
            kredit: t.kredit || '0',
            kredit_clean: cleanNumber(t.kredit),
            status: t.status || '-',
            is_pencairan: String(t.keterangan || '').toLowerCase().includes('pencairan')
        }));
        const summary = {
            total_transactions: transactions.length,
            total_income: transactions.filter(t => !t.is_pencairan).reduce((s, t) => s + t.kredit_clean, 0)
        };
        return ok(res, { transactions, summary });
    }

    return ok(res, { transactions: [], summary: { total_transactions: 0, total_income: 0 } }, 'Tidak ada transaksi');
});

// ── 4. Transfer E-Wallet ──────────────────────────────
// POST /api/v1/transfers
app.post('/api/v1/transfers', async (req, res) => {
    const { wallet, phone, nominal } = req.body;

    if (!wallet || !phone || !nominal) {
        return bad(res, 'Wallet, nomor tujuan, dan nominal wajib diisi');
    }

    const numNominal = Number(nominal);
    if (!numNominal || numNominal < 1000) {
        return bad(res, 'Nominal minimal Rp 1.000');
    }

    if (!/^[\d]{8,15}$/.test(phone.replace(/\D/g, ''))) {
        return bad(res, 'Format nomor tidak valid');
    }

    const validWallets = Object.keys(CONFIG.VOUCHERS);
    if (!validWallets.includes(String(wallet).toUpperCase())) {
        return bad(res, `Wallet harus salah satu dari: ${validWallets.join(', ')}`);
    }

    const voucherId = resolveVoucherId(wallet);
    const result = await hitOrderkuotaAPI('https://app.orderkuota.com/api/v2/order', {
        quantity: "1",
        id_plgn: String(numNominal),
        kode_promo: "",
        pin: "",
        phone: phone.replace(/\D/g, ''),
        voucher_id: voucherId,
        payment: "balance"
    });

    if (!result) return serverErr(res, 'Gagal terhubung ke provider');

    if (result.success) {
        const trxId = result.results?.id || result.data?.id || null;
        return created(res, {
            transaction_id: trxId,
            wallet: String(wallet).toUpperCase(),
            phone: phone.replace(/\D/g, ''),
            nominal: numNominal
        }, 'Transfer berhasil diproses');
    }

    return bad(res, result.message || 'Gagal memproses transfer');
});

// ── 5. Withdraw / Pindah Saldo QRIS → Utama ──────────
// POST /api/v1/transfers/withdraw
app.post('/api/v1/transfers/withdraw', async (req, res) => {
    const { amount } = req.body;
    const numAmount = Number(amount);

    if (!numAmount || numAmount < 1000) {
        return bad(res, 'Minimal transfer Rp 1.000');
    }

    const result = await hitOrderkuotaAPI('https://app.orderkuota.com/api/v2/get', {
        'requests[qris_withdraw][amount]': String(numAmount)
    });

    if (!result) return serverErr(res, 'Gagal terhubung ke provider');

    if (result.success && result.qris_withdraw?.success) {
        return created(res, {
            amount: numAmount,
            source: 'qris_balance',
            destination: 'main_balance'
        }, `Saldo Rp ${numAmount.toLocaleString('id-ID')} berhasil dipindahkan ke saldo utama`);
    }

    return bad(res, result.message || 'Gagal memproses transfer saldo');
});

// ── 6. Top Up DANA (Bebas Nominal / BBSD) ────────────
// POST /api/v1/topup/dana
app.post('/api/v1/topup/dana', async (req, res) => {
    const { phone, nominal } = req.body;

    if (!phone || !nominal) {
        return bad(res, 'Nomor DANA dan nominal wajib diisi');
    }

    const numNominal = Number(nominal);
    if (!numNominal || numNominal < 1000) {
        return bad(res, 'Nominal minimal Rp 1.000');
    }

    if (!/^[\d]{8,15}$/.test(phone.replace(/\D/g, ''))) {
        return bad(res, 'Format nomor tidak valid');
    }

    const result = await hitOrderkuotaAPI('https://app.orderkuota.com/api/v2/order', {
        quantity: "1",
        id_plgn: String(numNominal),
        kode_promo: "",
        pin: "",
        phone: phone.replace(/\D/g, ''),
        voucher_id: "BBSD",
        payment: "balance"
    });

    if (!result) return serverErr(res, 'Gagal terhubung ke provider');

    if (result.success) {
        const trxId = result.results?.id || result.data?.id || null;
        return created(res, {
            transaction_id: trxId,
            phone: phone.replace(/\D/g, ''),
            nominal: numNominal,
            product: 'TOPUP_DANA_BBSD'
        }, 'Top Up DANA berhasil diproses');
    }

    return bad(res, result.message || 'Gagal memproses top up');
});

// ── 404 Handler ────────────────────────────────────────
app.use('/api/v1', (req, res) => {
    respond(res, 404, false, null, `Endpoint ${req.method} ${req.path} tidak ditemukan`);
});

// ── Global Error Handler ───────────────────────────────
app.use((err, req, res, next) => {
    console.error('[Unhandled Error]', err.stack);
    serverErr(res, 'Internal Server Error');
});

// ── Start Server ───────────────────────────────────────
app.listen(PORT, () => {
    console.log(`┌──────────────────────────────────────┐`);
    console.log(`│  JoJo Store API - RESTful v1         │`);
    console.log(`│  Running on port ${PORT}                  │`);
    console.log(`├──────────────────────────────────────┤`);
    console.log(`│  GET    /api/v1/health                │`);
    console.log(`│  GET    /api/v1/account/balance       │`);
    console.log(`│  POST   /api/v1/qris/generate         │`);
    console.log(`│  GET    /api/v1/transactions          │`);
    console.log(`│  POST   /api/v1/transfers             │`);
    console.log(`│  POST   /api/v1/transfers/withdraw    │`);
    console.log(`│  POST   /api/v1/topup/dana            │`);
    console.log(`└──────────────────────────────────────┘`);
});