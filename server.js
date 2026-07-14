const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const CONFIG = {
    AUTH_TOKEN: '1349636:Lx4AfqGh0E2Kbd68COZmDyngc3HPIjQr',
    DEVICE_DATA: {
        app_reg_id: "dr5gziOnST6nZQFPrTGbda:APA91bFSvNYNiC_68rtd0q3tA-yX-vYcuYqTUTcc53PwWdDst_E4RrIaUGdxwRkymkLPlydc-W7Amc0IpDjoNF5k9-kShFZSxhiKFduaLcbOZzAsH0VmzBM",
        phone_uuid: "dr5gziOnST6nZQFPrTGbda",
        phone_model: "vivo 1935",
        phone_android_version: "10",
        app_version_code: "260115",
        auth_username: "jokowiiiiii",
        app_version_name: "26.01.15"
    },
    VOUCHER_DANA: "3056",
    VOUCHER_OVO: "11886",
    VOUCHER_GOPAY: "3062",
    VOUCHER_SHOPEEPAY: "3058"
};

const QRIS_RAW = "00020101021126670016COM.NOBUBANK.WWW01189360050300000879140214508257991305870303UMI51440014ID.CO.QRIS.WWW0215ID20232921284770303UMI5204541153033605802ID5920JOJO STORE OK13496366006CIAMIS61054621162070703A0163045679";

async function hitOrderkuotaAPI(url, data) {
    try {
        const payload = { ...CONFIG.DEVICE_DATA, ...data, auth_token: CONFIG.AUTH_TOKEN, request_time: Date.now().toString(), ui_mode: 'dark' };
        const params = new URLSearchParams();
        for (const key in payload) params.append(key, payload[key]);
        const response = await axios.post(url, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Host': 'app.orderkuota.com', 'User-Agent': 'okhttp/4.9.3', 'auth-token': CONFIG.AUTH_TOKEN }
        });
        return response.data;
    } catch (error) {
        return { success: false, message: "Koneksi Error" };
    }
}

function cleanNumber(str) { if (!str) return 0; return Number(String(str).replace(/[^0-9]/g, '')) || 0; }

// 1. CEK SALDO
app.get('/api/saldo', async (req, res) => {
    const result = await hitOrderkuotaAPI('https://app.orderkuota.com/api/v2/get', { 'requests[0]': 'account' });
    if (result.success && result.account) {
        res.json({ success: true, balance: result.account.results.balance, qris_balance: result.account.results.qris_balance });
    } else {
        res.json({ success: false, message: "Gagal ambil saldo" });
    }
});

// 2. GENERATE QRIS
app.get('/api/qris', async (req, res) => {
    const { amount } = req.query;
    if (!amount) return res.json({ success: false, message: "Nominal wajib" });
    try {
        const response = await axios.post('https://qrisku.my.id/api', { qris_statis: QRIS_RAW, amount }, { headers: { 'Content-Type': 'application/json' } });
        if (response.data.status === 'success') {
            res.json({ success: true, qris_base64: response.data.qris_base64 });
        } else {
            res.json({ success: false, message: response.data.message });
        }
    } catch (error) {
        res.json({ success: false, message: "Gagal generate QRIS" });
    }
});

// 3. MUTASI
app.get('/api/mutasi', async (req, res) => {
    const result = await hitOrderkuotaAPI('https://app.orderkuota.com/api/v2/qris/mutasi/1349636', {
        'requests[0]': 'account', 'requests[qris_history][page]': '1',
        'requests[qris_history][dari_tanggal]': '', 'requests[qris_history][ke_tanggal]': '', 'requests[qris_history][keterangan]': ''
    });
    const transactions = result.qris_history?.results;
    if (result.success && transactions && transactions.length > 0) {
        const cleanList = transactions.map(t => ({ ...t, kredit_clean: cleanNumber(t.kredit), status: t.status }));
        res.json({ success: true, data: cleanList });
    } else {
        res.json({ success: false, data: [] });
    }
});

// 4. ORDER
app.post('/api/order', async (req, res) => {
    const { wallet, phone, nominal } = req.body;
    let voucherId = CONFIG.VOUCHER_DANA;
    if (wallet === 'OVO') voucherId = CONFIG.VOUCHER_OVO;
    if (wallet === 'GOPAY') voucherId = CONFIG.VOUCHER_GOPAY;
    if (wallet === 'SHOPEEPAY') voucherId = CONFIG.VOUCHER_SHOPEEPAY;
    try {
        const result = await hitOrderkuotaAPI('https://app.orderkuota.com/api/v2/order', { quantity: "1", id_plgn: nominal, kode_promo: "", pin: "", phone: phone, voucher_id: voucherId, payment: "balance" });
        if (result.success) {
            const idTrx = result.results?.id || result.data?.id || "N/A";
            res.json({ success: true, idTrx });
        } else {
            res.json({ success: false, message: result.message });
        }
    } catch (error) {
        res.json({ success: false, message: "Gagal memproses order" });
    }
});

// 5. WITHDRAW
app.post('/api/withdraw', async (req, res) => {
    const { amount } = req.body;
    if (!amount || amount < 1000) return res.json({ success: false, message: "Minimal transfer Rp 1.000" });
    try {
        const result = await hitOrderkuotaAPI('https://app.orderkuota.com/api/v2/get', { 'requests[qris_withdraw][amount]': amount });
        if (result.success && result.qris_withdraw && result.qris_withdraw.success) {
            res.json({ success: true, message: `Saldo Rp ${Number(amount).toLocaleString('id-ID')} berhasil dipindahkan ke saldo utama.` });
        } else {
            res.json({ success: false, message: result.message || "Gagal memproses transfer" });
        }
    } catch (error) {
        res.json({ success: false, message: "Terjadi kesalahan server" });
    }
});

app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));
