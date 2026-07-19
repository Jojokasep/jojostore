const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_VERSION = 'v1';

// ═══════════════════════════════════════════════════════════════
//  MIDDLEWARES
// ═══════════════════════════════════════════════════════════════
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID']
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Simple request ID
app.use((req, res, next) => {
    req.requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    res.setHeader('X-Request-ID', req.requestId);
    next();
});

// Simple request logger
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} - ${Date.now() - start}ms`);
    });
    next();
});

// ═══════════════════════════════════════════════════════════════
//  RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════
class ApiResponse {
    static success(res, data = null, message = 'OK', meta = null, statusCode = 200) {
        const response = { status: statusCode, success: true, message, data };
        if (meta) response.meta = meta;
        return res.status(statusCode).json(response);
    }

    static created(res, data = null, message = 'Resource created successfully') {
        return this.success(res, data, message, null, 201);
    }

    static error(res, statusCode, code, message, details = null) {
        const response = {
            status: statusCode,
            success: false,
            error: { code, message }
        };
        if (details) response.error.details = details;
        return res.status(statusCode).json(response);
    }

    static badRequest(res, message, details = null) {
        return this.error(res, 400, 'BAD_REQUEST', message, details);
    }

    static notFound(res, resource = 'Resource') {
        return this.error(res, 404, 'NOT_FOUND', `${resource} tidak ditemukan`);
    }

    static validationError(res, details) {
        return this.error(res, 422, 'VALIDATION_ERROR', 'Validasi gagal', details);
    }

    static internalError(res, message = 'Internal Server Error') {
        return this.error(res, 500, 'INTERNAL_ERROR', message);
    }

    static serviceUnavailable(res, message = 'Service temporarily unavailable') {
        return this.error(res, 503, 'SERVICE_UNAVAILABLE', message);
    }
}

// ═══════════════════════════════════════════════════════════════
//  VALIDATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════
function validate(schema) {
    return (req, res, next) => {
        const errors = [];
        
        for (const [field, rules] of Object.entries(schema)) {
            const value = req.body[field];
            
            for (const rule of rules) {
                if (rule === 'required' && (value === undefined || value === null || value === '')) {
                    errors.push({ field, message: `${field} wajib diisi` });
                    break;
                }
                if (rule === 'number' && value !== undefined && isNaN(Number(value))) {
                    errors.push({ field, message: `${field} harus berupa angka` });
                }
                if (typeof rule === 'object' && rule.min !== undefined && value !== undefined) {
                    if (Number(value) < rule.min) {
                        errors.push({ field, message: `${field} minimal ${rule.min}` });
                    }
                }
                if (typeof rule === 'object' && rule.max !== undefined && value !== undefined) {
                    if (Number(value) > rule.max) {
                        errors.push({ field, message: `${field} maksimal ${rule.max}` });
                    }
                }
                if (typeof rule === 'object' && rule.pattern && value !== undefined) {
                    if (!rule.pattern.test(String(value))) {
                        errors.push({ field, message: rule.message || `Format ${field} tidak valid` });
                    }
                }
                if (typeof rule === 'object' && rule.in && value !== undefined) {
                    if (!rule.in.includes(String(value).toUpperCase())) {
                        errors.push({ field, message: `${field} harus salah satu dari: ${rule.in.join(', ')}` });
                    }
                }
            }
        }

        if (errors.length > 0) {
            return ApiResponse.validationError(res, errors);
        }
        next();
    };
}

// ═══════════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const CONFIG = {
    AUTH_TOKEN: process.env.AUTH_TOKEN || '1349636:Lx4AfqGh0E2Kbd68COZmDyngc3HPIjQr',
    MERCHANT_ID: process.env.MERCHANT_ID || '1349636',
    DEVICE_DATA: {
        app_reg_id: process.env.APP_REG_ID || "dr5gziOnST6nZQFPrTGbda:APA91bFSvNYNiC_68rtd0q3tA-yX-vYcuYqTUTcc53PwWdDst_E4RrIaUGdxwRkymkLPlydc-W7Amc0IpDjoNF5k9-kShFZSxhiKFduaLcbOZzAsH0VmzBM",
        phone_uuid: process.env.PHONE_UUID || "dr5gziOnST6nZQFPrTGbda",
        phone_model: process.env.PHONE_MODEL || "vivo 1935",
        phone_android_version: process.env.ANDROID_VERSION || "10",
        app_version_code: process.env.APP_VERSION_CODE || "260115",
        auth_username: process.env.AUTH_USERNAME || "jokowiiiiii",
        app_version_name: process.env.APP_VERSION_NAME || "26.01.15"
    },
    VOUCHERS: {
        DANA: "3056",
        OVO: "11886",
        GOPAY: "3062",
        SHOPEEPAY: "3058"
    },
    QRIS_RAW: process.env.QRIS_RAW || "00020101021126670016COM.NOBUBANK.WWW01189360050300000879140214508257991305870303UMI51440014ID.CO.QRIS.WWW0215ID20232921284770303UMI5204541153033605802ID5920JOJO STORE OK13496366006CIAMIS61054621162070703A0163045679",
    QRIS_URL: process.env.QRIS_URL || "https://qrisku.my.id/api"
};

// ═══════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════
const Utils = {
    cleanNumber(str) {
        if (!str) return 0;
        return Number(String(str).replace(/[^0-9]/g, '')) || 0;
    },
    cleanPhone(phone) {
        return String(phone).replace(/\D/g, '');
    },
    isValidPhone(phone) {
        return /^[\d]{8,15}$/.test(this.cleanPhone(phone));
    },
    resolveVoucherId(wallet) {
        return CONFIG.VOUCHERS[String(wallet).toUpperCase()] || null;
    },
    getValidWallets() {
        return Object.keys(CONFIG.VOUCHERS);
    },
    parsePagination(query) {
        const page = Math.max(1, parseInt(query.page) || 1);
        const perPage = Math.min(100, Math.max(1, parseInt(query.per_page) || 20));
        return { page, perPage };
    },
    buildPaginationMeta(total, page, perPage) {
        const totalPages = Math.ceil(total / perPage);
        return {
            pagination: {
                current_page: page,
                per_page: perPage,
                total_items: total,
                total_pages: totalPages,
                has_next: page < totalPages,
                has_prev: page > 1
            }
        };
    },
    buildLinks(req, page, totalPages) {
        const baseUrl = `${req.protocol}://${req.get('host')}${req.path}`;
        const buildUrl = (p) => {
            const url = new URL(baseUrl);
            url.searchParams.set('page', p);
            for (const [key, value] of Object.entries(req.query)) {
                if (key !== 'page') url.searchParams.set(key, value);
            }
            return url.toString();
        };
        return {
            links: {
                self: buildUrl(page),
                first: buildUrl(1),
                last: buildUrl(totalPages || 1),
                next: page < totalPages ? buildUrl(page + 1) : null,
                prev: page > 1 ? buildUrl(page - 1) : null
            }
        };
    }
};

// ═══════════════════════════════════════════════════════════════
//  EXTERNAL API SERVICE
// ═══════════════════════════════════════════════════════════════
const OrderkuotaService = {
    async request(url, extraData = {}) {
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
            return { success: true, data: response.data };
        } catch (error) {
            console.error(`[Orderkuota Error] ${error.message}`);
            return { success: false, error: error.message };
        }
    },

    async getAccountInfo() {
        return this.request('https://app.orderkuota.com/api/v2/get', { 'requests[0]': 'account' });
    },

    async getTransactionHistory(page = 1, filters = {}) {
        return this.request(
            `https://app.orderkuota.com/api/v2/qris/mutasi/${CONFIG.MERCHANT_ID}`,
            {
                'requests[0]': 'account',
                'requests[qris_history][page]': String(page),
                'requests[qris_history][dari_tanggal]': filters.dari || '',
                'requests[qris_history][ke_tanggal]': filters.ke || '',
                'requests[qris_history][keterangan]': filters.keterangan || ''
            }
        );
    },

    async createTransfer(voucherId, phone, nominal) {
        return this.request('https://app.orderkuota.com/api/v2/order', {
            quantity: "1",
            id_plgn: String(nominal),
            kode_promo: "",
            pin: "",
            phone: Utils.cleanPhone(phone),
            voucher_id: voucherId,
            payment: "balance"
        });
    },

    async withdrawQrisBalance(amount) {
        return this.request('https://app.orderkuota.com/api/v2/get', {
            'requests[qris_withdraw][amount]': String(amount)
        });
    }
};

const QrisService = {
    async generateQris(amount) {
        try {
            const response = await axios.post(CONFIG.QRIS_URL, {
                qris_statis: CONFIG.QRIS_RAW,
                amount: amount
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000
            });
            return { success: true, data: response.data };
        } catch (error) {
            console.error(`[QRIS Error] ${error.message}`);
            return { success: false, error: error.message };
        }
    }
};

// ═══════════════════════════════════════════════════════════════
//  ROUTERS
// ═══════════════════════════════════════════════════════════════

// Health Router
const healthRouter = express.Router();
healthRouter.get('/', (req, res) => {
    ApiResponse.success(res, {
        service: 'JoJo Store API',
        version: API_VERSION,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    }, 'Service is healthy');
});

// Account Router
const accountRouter = express.Router();
accountRouter.get('/', async (req, res) => {
    const result = await OrderkuotaService.getAccountInfo();
    if (!result.success) return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
    
    const data = result.data;
    if (data.success && data.account?.results) {
        const { balance, qris_balance } = data.account.results;
        return ApiResponse.success(res, {
            id: CONFIG.MERCHANT_ID,
            balance: {
                main: Number(balance) || 0,
                qris: Number(qris_balance) || 0,
                total: (Number(balance) || 0) + (Number(qris_balance) || 0)
            },
            currency: 'IDR'
        });
    }
    return ApiResponse.badRequest(res, data.message || 'Gagal mengambil informasi akun');
});

accountRouter.get('/balance', async (req, res) => {
    const result = await OrderkuotaService.getAccountInfo();
    if (!result.success) return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
    
    const data = result.data;
    if (data.success && data.account?.results) {
        const { balance, qris_balance } = data.account.results;
        return ApiResponse.success(res, {
            main: Number(balance) || 0,
            qris: Number(qris_balance) || 0,
            formatted: {
                main: `Rp ${Number(balance || 0).toLocaleString('id-ID')}`,
                qris: `Rp ${Number(qris_balance || 0).toLocaleString('id-ID')}`
            }
        });
    }
    return ApiResponse.badRequest(res, data.message || 'Gagal mengambil saldo');
});

// Transfers Router
const transfersRouter = express.Router();

transfersRouter.get('/', async (req, res) => {
    const { page, perPage } = Utils.parsePagination(req.query);
    const { dari, ke, keterangan } = req.query;

    const result = await OrderkuotaService.getTransactionHistory(page, { dari, ke, keterangan });
    if (!result.success) return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
    
    const data = result.data;
    if (data.success && data.qris_history?.results?.length > 0) {
        const transactions = data.qris_history.results.map(t => ({
            id: t.id || null,
            type: String(t.keterangan || '').toLowerCase().includes('pencairan') ? 'withdrawal' : 'payment',
            date: t.tanggal || t.date || null,
            description: t.keterangan || '',
            amount: Utils.cleanNumber(t.kredit),
            amount_formatted: `Rp ${Utils.cleanNumber(t.kredit).toLocaleString('id-ID')}`,
            status: t.status || '-'
        }));

        const totalItems = data.qris_history.total || transactions.length;
        const meta = Utils.buildPaginationMeta(totalItems, page, perPage);
        const links = Utils.buildLinks(req, page, meta.pagination.total_pages);

        return ApiResponse.success(res, { items: transactions }, 'Transfer history retrieved', { ...meta, ...links });
    }
    return ApiResponse.success(res, { items: [] }, 'Tidak ada riwayat transfer', Utils.buildPaginationMeta(0, page, perPage));
});

transfersRouter.post('/',
    validate({
        wallet: ['required', { in: Utils.getValidWallets() }],
        phone: ['required', { pattern: /^[\d]{8,15}$/, message: 'Format nomor HP tidak valid (8-15 digit)' }],
        nominal: ['required', 'number', { min: 1000 }]
    }),
    async (req, res) => {
        const { wallet, phone, nominal } = req.body;
        const walletUpper = wallet.toUpperCase();
        const voucherId = Utils.resolveVoucherId(walletUpper);
        const numNominal = Number(nominal);

        const result = await OrderkuotaService.createTransfer(voucherId, phone, numNominal);
        if (!result.success) return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
        
        const data = result.data;
        if (data.success) {
            const trxId = data.results?.id || data.data?.id || null;
            return ApiResponse.created(res, {
                id: trxId,
                type: 'ewallet_transfer',
                wallet: walletUpper,
                destination: Utils.cleanPhone(phone),
                amount: numNominal,
                amount_formatted: `Rp ${numNominal.toLocaleString('id-ID')}`,
                status: 'processing',
                created_at: new Date().toISOString()
            }, 'Transfer berhasil diproses');
        }
        return ApiResponse.badRequest(res, data.message || 'Gagal memproses transfer');
    }
);

transfersRouter.post('/withdraw',
    validate({ amount: ['required', 'number', { min: 1000 }] }),
    async (req, res) => {
        const { amount } = req.body;
        const numAmount = Number(amount);

        const result = await OrderkuotaService.withdrawQrisBalance(numAmount);
        if (!result.success) return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
        
        const data = result.data;
        if (data.success && data.qris_withdraw?.success) {
            return ApiResponse.created(res, {
                id: `wd_${Date.now()}`,
                type: 'qris_withdrawal',
                amount: numAmount,
                amount_formatted: `Rp ${numAmount.toLocaleString('id-ID')}`,
                source: 'qris_balance',
                destination: 'main_balance',
                status: 'completed',
                created_at: new Date().toISOString()
            }, `Saldo Rp ${numAmount.toLocaleString('id-ID')} berhasil dipindahkan`);
        }
        return ApiResponse.badRequest(res, data.message || 'Gagal memproses penarikan saldo');
    }
);

// Wallets Router
const walletsRouter = express.Router();

walletsRouter.get('/', (req, res) => {
    const wallets = Object.entries(CONFIG.VOUCHERS).map(([name, voucherId]) => ({
        name,
        voucher_id: voucherId,
        min_amount: 1000
    }));
    ApiResponse.success(res, { items: wallets }, 'Supported wallets retrieved');
});

walletsRouter.get('/:walletName', (req, res) => {
    const walletName = req.params.walletName.toUpperCase();
    const voucherId = CONFIG.VOUCHERS[walletName];
    if (!voucherId) return ApiResponse.notFound(res, `Wallet '${walletName}'`);
    
    ApiResponse.success(res, {
        name: walletName,
        voucher_id: voucherId,
        min_amount: 1000
    });
});

walletsRouter.post('/:walletName/topup',
    (req, res, next) => {
        const walletName = req.params.walletName.toUpperCase();
        if (!CONFIG.VOUCHERS[walletName]) return ApiResponse.notFound(res, `Wallet '${walletName}'`);
        req.walletName = walletName;
        req.voucherId = CONFIG.VOUCHERS[walletName];
        next();
    },
    validate({
        phone: ['required', { pattern: /^[\d]{8,15}$/, message: 'Format nomor HP tidak valid' }],
        nominal: ['required', 'number', { min: 1000 }]
    }),
    async (req, res) => {
        const { walletName, voucherId } = req;
        const { phone, nominal } = req.body;
        const numNominal = Number(nominal);

        const result = await OrderkuotaService.createTransfer(voucherId, phone, numNominal);
        if (!result.success) return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
        
        const data = result.data;
        if (data.success) {
            const trxId = data.results?.id || data.data?.id || null;
            return ApiResponse.created(res, {
                id: trxId,
                type: 'wallet_topup',
                wallet: walletName,
                destination: Utils.cleanPhone(phone),
                amount: numNominal,
                amount_formatted: `Rp ${numNominal.toLocaleString('id-ID')}`,
                status: 'processing',
                created_at: new Date().toISOString()
            }, `Top up ${walletName} berhasil diproses`);
        }
        return ApiResponse.badRequest(res, data.message || 'Gagal memproses top up');
    }
);

// Payments Router
const paymentsRouter = express.Router();

paymentsRouter.post('/qris',
    validate({ amount: ['required', 'number', { min: 1000 }, { max: 10000000 }] }),
    async (req, res) => {
        const { amount } = req.body;
        const numAmount = Number(amount);

        const result = await QrisService.generateQris(numAmount);
        if (!result.success) return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke layanan QRIS');
        
        const data = result.data;
        if (data.status === 'success' && data.qris_base64) {
            return ApiResponse.created(res, {
                id: `qris_${Date.now()}`,
                type: 'qris_payment',
                amount: numAmount,
                amount_formatted: `Rp ${numAmount.toLocaleString('id-ID')}`,
                qris: { base64: data.qris_base64 },
                merchant: { id: CONFIG.MERCHANT_ID, name: 'JOJO STORE' },
                status: 'pending',
                created_at: new Date().toISOString()
            }, 'QRIS berhasil digenerate');
        }
        return ApiResponse.badRequest(res, data.message || 'Gagal generate QRIS');
    }
);

// Transactions Router
const transactionsRouter = express.Router();

transactionsRouter.get('/', async (req, res) => {
    const { page, perPage } = Utils.parsePagination(req.query);
    const { dari, ke, keterangan, type } = req.query;

    const result = await OrderkuotaService.getTransactionHistory(page, { dari, ke, keterangan });
    if (!result.success) return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
    
    const data = result.data;
    if (data.success && data.qris_history?.results?.length > 0) {
        let transactions = data.qris_history.results.map(t => {
            const isPencairan = String(t.keterangan || '').toLowerCase().includes('pencairan');
            return {
                id: t.id || null,
                type: isPencairan ? 'withdrawal' : 'payment',
                date: t.tanggal || t.date || null,
                description: t.keterangan || '',
                amount: Utils.cleanNumber(t.kredit),
                amount_formatted: `Rp ${Utils.cleanNumber(t.kredit).toLocaleString('id-ID')}`,
                status: t.status || '-'
            };
        });

        if (type) {
            transactions = transactions.filter(t => t.type === type.toLowerCase());
        }

        const summary = {
            total_items: transactions.length,
            total_income: transactions.filter(t => t.type === 'payment').reduce((s, t) => s + t.amount, 0),
            total_withdrawals: transactions.filter(t => t.type === 'withdrawal').reduce((s, t) => s + t.amount, 0)
        };

        const totalItems = data.qris_history.total || transactions.length;
        const meta = Utils.buildPaginationMeta(totalItems, page, perPage);
        const links = Utils.buildLinks(req, page, meta.pagination.total_pages);

        return ApiResponse.success(res, { items: transactions, summary }, 'Transactions retrieved', { ...meta, ...links });
    }
    return ApiResponse.success(res, { items: [], summary: { total_items: 0, total_income: 0, total_withdrawals: 0 } }, 'Tidak ada transaksi', Utils.buildPaginationMeta(0, page, perPage));
});

transactionsRouter.get('/:id', (req, res) => {
    ApiResponse.notFound(res, `Transaction dengan ID '${req.params.id}'`);
});

// ═══════════════════════════════════════════════════════════════
//  MOUNT ROUTERS
// ═══════════════════════════════════════════════════════════════

// ⭐ ROOT ENDPOINT UNTUK RAILWAY HEALTH CHECK ⭐
app.get('/', (req, res) => {
    res.status(200).json({
        status: 200,
        success: true,
        message: 'JoJo Store API is running',
        data: {
            service: 'JoJo Store API',
            version: API_VERSION,
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            base_url: `/api/${API_VERSION}`,
            endpoints: {
                health: `/api/${API_VERSION}/health`,
                account: `/api/${API_VERSION}/account`,
                transfers: `/api/${API_VERSION}/transfers`,
                wallets: `/api/${API_VERSION}/wallets`,
                payments: `/api/${API_VERSION}/payments`,
                transactions: `/api/${API_VERSION}/transactions`
            }
        }
    });
});

app.use(`/api/${API_VERSION}`, (req, res) => {
    ApiResponse.success(res, {
        name: 'JoJo Store API',
        version: API_VERSION,
        endpoints: {
            health: `/api/${API_VERSION}/health`,
            account: `/api/${API_VERSION}/account`,
            transfers: `/api/${API_VERSION}/transfers`,
            wallets: `/api/${API_VERSION}/wallets`,
            payments: `/api/${API_VERSION}/payments`,
            transactions: `/api/${API_VERSION}/transactions`
        }
    }, 'Welcome to JoJo Store API');
});

app.use(`/api/${API_VERSION}/health`, healthRouter);
app.use(`/api/${API_VERSION}/account`, accountRouter);
app.use(`/api/${API_VERSION}/transfers`, transfersRouter);
app.use(`/api/${API_VERSION}/wallets`, walletsRouter);
app.use(`/api/${API_VERSION}/payments`, paymentsRouter);
app.use(`/api/${API_VERSION}/transactions`, transactionsRouter);

// ═══════════════════════════════════════════════════════════════
//  ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════
app.use('/api/', (req, res) => {
    ApiResponse.notFound(res, `Endpoint ${req.method} ${req.path}`);
});

app.use('*', (req, res) => {
    // Jangan return 404 untuk root, karena sudah dihandle di atas
    if (req.path === '/') {
        return res.status(200).json({
            status: 200,
            success: true,
            message: 'OK'
        });
    }
    ApiResponse.notFound(res, `Endpoint ${req.method} ${req.path}`);
});

app.use((err, req, res, next) => {
    console.error(`[Error] ${req.requestId}:`, err.message);
    if (err.type === 'entity.parse.failed') {
        return ApiResponse.badRequest(res, 'Invalid JSON in request body');
    }
    ApiResponse.internalError(res);
});

// ═══════════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║               JoJo Store API - RESTful v1                    ║
║                 Running on port ${PORT}                          ║
╠═══════════════════════════════════════════════════════════════╣
║  GET    /                            Root (Railway Health)  ║
║  GET    /api/v1                      API Root                ║
║  GET    /api/v1/health               Health Check            ║
║  GET    /api/v1/account              Account Info            ║
║  GET    /api/v1/account/balance      Balance Only            ║
║  GET    /api/v1/transfers            Transfer History        ║
║  POST   /api/v1/transfers            Create Transfer         ║
║  POST   /api/v1/transfers/withdraw   Withdraw QRIS           ║
║  GET    /api/v1/wallets              List Wallets            ║
║  GET    /api/v1/wallets/:name        Wallet Detail           ║
║  POST   /api/v1/wallets/:name/topup  Top Up Wallet           ║
║  POST   /api/v1/payments/qris        Generate QRIS           ║
║  GET    /api/v1/transactions         All Transactions        ║
╚═══════════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;