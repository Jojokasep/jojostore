const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const API_VERSION = 'v1';

// ═══════════════════════════════════════════════════════════════
//  MIDDLEWARES
// ═══════════════════════════════════════════════════════════════

// Security headers
app.use(helmet());

// CORS configuration
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    credentials: true,
    maxAge: 86400
}));

// Body parsers
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        status: 429,
        success: false,
        error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Terlalu banyak request, coba lagi dalam 15 menit'
        }
    }
});

const strictLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        status: 429,
        success: false,
        error: {
            code: 'STRICT_RATE_LIMIT',
            message: 'Rate limit ketat untuk endpoint ini, coba lagi dalam 1 menit'
        }
    }
});

app.use('/api/', limiter);

// Request ID middleware
app.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    res.setHeader('X-Request-ID', req.requestId);
    next();
});

// Request logger
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[${new Date().toISOString()}] [${req.requestId}] ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
    });
    next();
});

// ═══════════════════════════════════════════════════════════════
//  RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════

class ApiResponse {
    static success(res, data = null, message = 'OK', meta = null, statusCode = 200) {
        const response = {
            status: statusCode,
            success: true,
            message,
            data
        };
        if (meta) response.meta = meta;
        return res.status(statusCode).json(response);
    }

    static created(res, data = null, message = 'Resource created successfully') {
        return this.success(res, data, message, null, 201);
    }

    static noContent(res) {
        return res.status(204).send();
    }

    static error(res, statusCode, code, message, details = null) {
        const response = {
            status: statusCode,
            success: false,
            error: {
                code,
                message
            }
        };
        if (details) response.error.details = details;
        return res.status(statusCode).json(response);
    }

    static badRequest(res, message, details = null) {
        return this.error(res, 400, 'BAD_REQUEST', message, details);
    }

    static unauthorized(res, message = 'Unauthorized') {
        return this.error(res, 401, 'UNAUTHORIZED', message);
    }

    static forbidden(res, message = 'Forbidden') {
        return this.error(res, 403, 'FORBIDDEN', message);
    }

    static notFound(res, resource = 'Resource') {
        return this.error(res, 404, 'NOT_FOUND', `${resource} tidak ditemukan`);
    }

    static conflict(res, message) {
        return this.error(res, 409, 'CONFLICT', message);
    }

    static validationError(res, details) {
        return this.error(res, 422, 'VALIDATION_ERROR', 'Validasi gagal', details);
    }

    static tooManyRequests(res, message) {
        return this.error(res, 429, 'RATE_LIMIT_EXCEEDED', message);
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
                if (rule === 'string' && value !== undefined && typeof value !== 'string') {
                    errors.push({ field, message: `${field} harus berupa string` });
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
    QRIS: {
        RAW: process.env.QRIS_RAW || "00020101021126670016COM.NOBUBANK.WWW01189360050300000879140214508257991305870303UMI51440014ID.CO.QRIS.WWW0215ID20232921284770303UMI5204541153033605802ID5920JOJO STORE OK13496366006CIAMIS61054621162070703A0163045679",
        GENERATOR_URL: process.env.QRIS_GENERATOR_URL || "https://qrisku.my.id/api"
    },
    PAGINATION: {
        DEFAULT_PAGE: 1,
        DEFAULT_PER_PAGE: 20,
        MAX_PER_PAGE: 100
    }
};

// ═══════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

class Utils {
    static cleanNumber(str) {
        if (!str) return 0;
        return Number(String(str).replace(/[^0-9]/g, '')) || 0;
    }

    static cleanPhone(phone) {
        return String(phone).replace(/\D/g, '');
    }

    static isValidPhone(phone) {
        const cleaned = this.cleanPhone(phone);
        return /^[\d]{8,15}$/.test(cleaned);
    }

    static resolveVoucherId(wallet) {
        const w = String(wallet).toUpperCase();
        return CONFIG.VOUCHERS[w] || null;
    }

    static getValidWallets() {
        return Object.keys(CONFIG.VOUCHERS);
    }

    static parsePagination(query) {
        const page = Math.max(1, parseInt(query.page) || CONFIG.PAGINATION.DEFAULT_PAGE);
        const perPage = Math.min(
            CONFIG.PAGINATION.MAX_PER_PAGE,
            Math.max(1, parseInt(query.per_page) || CONFIG.PAGINATION.DEFAULT_PER_PAGE)
        );
        return { page, perPage, offset: (page - 1) * perPage };
    }

    static buildPaginationMeta(total, page, perPage) {
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
    }

    static buildLinks(req, page, totalPages) {
        const baseUrl = `${req.protocol}://${req.get('host')}${req.path}`;
        const buildUrl = (p) => {
            const url = new URL(baseUrl);
            url.searchParams.set('page', p);
            // Copy other query params
            for (const [key, value] of Object.entries(req.query)) {
                if (key !== 'page') url.searchParams.set(key, value);
            }
            return url.toString();
        };
        return {
            links: {
                self: buildUrl(page),
                first: buildUrl(1),
                last: buildUrl(totalPages),
                next: page < totalPages ? buildUrl(page + 1) : null,
                prev: page > 1 ? buildUrl(page - 1) : null
            }
        };
    }
}

// ═══════════════════════════════════════════════════════════════
//  EXTERNAL API SERVICE
// ═══════════════════════════════════════════════════════════════

class OrderkuotaService {
    static async request(url, extraData = {}) {
        try {
            const payload = {
                ...CONFIG.DEVICE_DATA,
                ...extraData,
                auth_token: CONFIG.AUTH_TOKEN,
                request_time: Date.now().toString(),
                ui_mode: 'dark'
            };

            const params = new URLSearchParams();
            for (const key in payload) {
                params.append(key, payload[key]);
            }

            const response = await axios.post(url, params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Host': 'app.orderkuota.com',
                    'User-Agent': 'okhttp/4.9.3',
                    'auth-token': CONFIG.AUTH_TOKEN
                },
                timeout: 15000
            });

            return {
                success: true,
                data: response.data
            };
        } catch (error) {
            console.error(`[OrderkuotaService Error] ${error.message}`);
            return {
                success: false,
                error: error.response?.data || error.message
            };
        }
    }

    static async getAccountInfo() {
        return this.request('https://app.orderkuota.com/api/v2/get', {
            'requests[0]': 'account'
        });
    }

    static async getTransactionHistory(page = 1, filters = {}) {
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
    }

    static async createTransfer(voucherId, phone, nominal) {
        return this.request('https://app.orderkuota.com/api/v2/order', {
            quantity: "1",
            id_plgn: String(nominal),
            kode_promo: "",
            pin: "",
            phone: Utils.cleanPhone(phone),
            voucher_id: voucherId,
            payment: "balance"
        });
    }

    static async withdrawQrisBalance(amount) {
        return this.request('https://app.orderkuota.com/api/v2/get', {
            'requests[qris_withdraw][amount]': String(amount)
        });
    }

    static async topUpDana(phone, nominal) {
        return this.request('https://app.orderkuota.com/api/v2/order', {
            quantity: "1",
            id_plgn: String(nominal),
            kode_promo: "",
            pin: "",
            phone: Utils.cleanPhone(phone),
            voucher_id: "BBSD",
            payment: "balance"
        });
    }
}

class QrisService {
    static async generateQris(amount) {
        try {
            const response = await axios.post(CONFIG.QRIS.GENERATOR_URL, {
                qris_statis: CONFIG.QRIS.RAW,
                amount: amount
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000
            });

            return {
                success: true,
                data: response.data
            };
        } catch (error) {
            console.error(`[QrisService Error] ${error.message}`);
            return {
                success: false,
                error: error.response?.data || error.message
            };
        }
    }
}

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
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    }, 'Service is healthy');
});

healthRouter.get('/detailed', async (req, res) => {
    const accountCheck = await OrderkuotaService.getAccountInfo();
    ApiResponse.success(res, {
        service: 'JoJo Store API',
        version: API_VERSION,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        dependencies: {
            orderkuota_api: accountCheck.success ? 'connected' : 'disconnected'
        },
        memory: {
            rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
            heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
        }
    }, 'Detailed health check');
});

// Account Router
const accountRouter = express.Router();

accountRouter.get('/', async (req, res) => {
    const result = await OrderkuotaService.getAccountInfo();
    
    if (!result.success) {
        return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
    }

    const data = result.data;
    
    if (data.success && data.account?.results) {
        const { balance, qris_balance, ...otherInfo } = data.account.results;
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
    
    if (!result.success) {
        return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
    }

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

// GET /transfers - List transfer history
transfersRouter.get('/', async (req, res) => {
    const { page, perPage } = Utils.parsePagination(req.query);
    const { dari, ke, keterangan } = req.query;

    const result = await OrderkuotaService.getTransactionHistory(page, { dari, ke, keterangan });
    
    if (!result.success) {
        return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
    }

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

        return ApiResponse.success(
            res,
            { items: transactions },
            'Transfer history retrieved',
            { ...meta, ...links }
        );
    }

    return ApiResponse.success(
        res,
        { items: [] },
        'Tidak ada riwayat transfer',
        Utils.buildPaginationMeta(0, page, perPage)
    );
});

// POST /transfers - Create new transfer
transfersRouter.post('/',
    strictLimiter,
    validate({
        wallet: ['required', 'string', { in: Utils.getValidWallets() }],
        phone: ['required', 'string', { pattern: /^[\d]{8,15}$/, message: 'Format nomor HP tidak valid (8-15 digit)' }],
        nominal: ['required', 'number', { min: 1000 }]
    }),
    async (req, res) => {
        const { wallet, phone, nominal } = req.body;
        const walletUpper = wallet.toUpperCase();
        const voucherId = Utils.resolveVoucherId(walletUpper);
        const cleanPhone = Utils.cleanPhone(phone);
        const numNominal = Number(nominal);

        const result = await OrderkuotaService.createTransfer(voucherId, cleanPhone, numNominal);
        
        if (!result.success) {
            return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
        }

        const data = result.data;

        if (data.success) {
            const trxId = data.results?.id || data.data?.id || null;
            return ApiResponse.created(res, {
                id: trxId,
                type: 'ewallet_transfer',
                wallet: walletUpper,
                destination: cleanPhone,
                amount: numNominal,
                amount_formatted: `Rp ${numNominal.toLocaleString('id-ID')}`,
                status: 'processing',
                created_at: new Date().toISOString()
            }, 'Transfer berhasil diproses');
        }

        return ApiResponse.badRequest(res, data.message || 'Gagal memproses transfer');
    }
);

// POST /transfers/withdraw - Withdraw from QRIS to main balance
transfersRouter.post('/withdraw',
    strictLimiter,
    validate({
        amount: ['required', 'number', { min: 1000 }]
    }),
    async (req, res) => {
        const { amount } = req.body;
        const numAmount = Number(amount);

        const result = await OrderkuotaService.withdrawQrisBalance(numAmount);
        
        if (!result.success) {
            return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
        }

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
            }, `Saldo Rp ${numAmount.toLocaleString('id-ID')} berhasil dipindahkan ke saldo utama`);
        }

        return ApiResponse.badRequest(res, data.message || 'Gagal memproses penarikan saldo');
    }
);

// Wallets Router
const walletsRouter = express.Router();

// GET /wallets - List supported wallets
walletsRouter.get('/', (req, res) => {
    const wallets = Object.entries(CONFIG.VOUCHERS).map(([name, voucherId]) => ({
        name,
        voucher_id: voucherId,
        min_amount: 1000,
        supports_custom_amount: name !== 'SHOPEEPAY' // Example logic
    }));
    
    ApiResponse.success(res, { items: wallets }, 'Supported wallets retrieved');
});

// GET /wallets/:walletName - Get specific wallet info
walletsRouter.get('/:walletName', (req, res) => {
    const walletName = req.params.walletName.toUpperCase();
    const voucherId = CONFIG.VOUCHERS[walletName];
    
    if (!voucherId) {
        return ApiResponse.notFound(res, `Wallet '${walletName}'`);
    }

    ApiResponse.success(res, {
        name: walletName,
        voucher_id: voucherId,
        min_amount: 1000,
        supports_custom_amount: walletName !== 'SHOPEEPAY'
    });
});

// POST /wallets/:walletName/topup - Top up specific wallet
walletsRouter.post('/:walletName/topup',
    strictLimiter,
    (req, res, next) => {
        const walletName = req.params.walletName.toUpperCase();
        if (!CONFIG.VOUCHERS[walletName]) {
            return ApiResponse.notFound(res, `Wallet '${walletName}'`);
        }
        req.walletName = walletName;
        req.voucherId = CONFIG.VOUCHERS[walletName];
        next();
    },
    validate({
        phone: ['required', 'string', { pattern: /^[\d]{8,15}$/, message: 'Format nomor HP tidak valid' }],
        nominal: ['required', 'number', { min: 1000 }]
    }),
    async (req, res) => {
        const { walletName, voucherId } = req;
        const { phone, nominal } = req.body;
        const cleanPhone = Utils.cleanPhone(phone);
        const numNominal = Number(nominal);

        const result = await OrderkuotaService.createTransfer(voucherId, cleanPhone, numNominal);
        
        if (!result.success) {
            return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
        }

        const data = result.data;

        if (data.success) {
            const trxId = data.results?.id || data.data?.id || null;
            return ApiResponse.created(res, {
                id: trxId,
                type: 'wallet_topup',
                wallet: walletName,
                destination: cleanPhone,
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

// POST /payments/qris - Generate QRIS payment
paymentsRouter.post('/qris',
    strictLimiter,
    validate({
        amount: ['required', 'number', { min: 1000 }, { max: 10000000 }]
    }),
    async (req, res) => {
        const { amount } = req.body;
        const numAmount = Number(amount);

        const result = await QrisService.generateQris(numAmount);
        
        if (!result.success) {
            return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke layanan QRIS');
        }

        const data = result.data;

        if (data.status === 'success' && data.qris_base64) {
            return ApiResponse.created(res, {
                id: `qris_${Date.now()}`,
                type: 'qris_payment',
                amount: numAmount,
                amount_formatted: `Rp ${numAmount.toLocaleString('id-ID')}`,
                qris: {
                    base64: data.qris_base64,
                    raw: CONFIG.QRIS.RAW
                },
                merchant: {
                    id: CONFIG.MERCHANT_ID,
                    name: 'JOJO STORE'
                },
                expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes
                status: 'pending',
                created_at: new Date().toISOString()
            }, 'QRIS berhasil digenerate');
        }

        return ApiResponse.badRequest(res, data.message || 'Gagal generate QRIS dari provider');
    }
);

// Transactions Router
const transactionsRouter = express.Router();

// GET /transactions - Get all transactions
transactionsRouter.get('/', async (req, res) => {
    const { page, perPage } = Utils.parsePagination(req.query);
    const { dari, ke, keterangan, type } = req.query;

    const result = await OrderkuotaService.getTransactionHistory(page, { dari, ke, keterangan });
    
    if (!result.success) {
        return ApiResponse.serviceUnavailable(res, 'Gagal terhubung ke provider');
    }

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
                status: t.status || '-',
                raw: t
            };
        });

        // Filter by type if specified
        if (type) {
            transactions = transactions.filter(t => t.type === type.toLowerCase());
        }

        // Calculate summary
        const summary = {
            total_items: transactions.length,
            total_income: transactions
                .filter(t => t.type === 'payment')
                .reduce((sum, t) => sum + t.amount, 0),
            total_withdrawals: transactions
                .filter(t => t.type === 'withdrawal')
                .reduce((sum, t) => sum + t.amount, 0)
        };

        const totalItems = data.qris_history.total || transactions.length;
        const meta = Utils.buildPaginationMeta(totalItems, page, perPage);
        const links = Utils.buildLinks(req, page, meta.pagination.total_pages);

        return ApiResponse.success(
            res,
            { items: transactions, summary },
            'Transactions retrieved',
            { ...meta, ...links }
        );
    }

    return ApiResponse.success(
        res,
        { 
            items: [], 
            summary: { total_items: 0, total_income: 0, total_withdrawals: 0 } 
        },
        'Tidak ada transaksi',
        Utils.buildPaginationMeta(0, page, perPage)
    );
});

// GET /transactions/:id - Get specific transaction (placeholder)
transactionsRouter.get('/:id', (req, res) => {
    // Note: The external API doesn't support single transaction lookup
    // This is a placeholder showing RESTful structure
    ApiResponse.notFound(res, `Transaction dengan ID '${req.params.id}'`);
});

// ═══════════════════════════════════════════════════════════════
//  MOUNT ROUTERS
// ═══════════════════════════════════════════════════════════════

app.use(`/api/${API_VERSION}/health`, healthRouter);
app.use(`/api/${API_VERSION}/account`, accountRouter);
app.use(`/api/${API_VERSION}/transfers`, transfersRouter);
app.use(`/api/${API_VERSION}/wallets`, walletsRouter);
app.use(`/api/${API_VERSION}/payments`, paymentsRouter);
app.use(`/api/${API_VERSION}/transactions`, transactionsRouter);

// API Root
app.get(`/api/${API_VERSION}`, (req, res) => {
    ApiResponse.success(res, {
        name: 'JoJo Store API',
        version: API_VERSION,
        documentation: `${req.protocol}://${req.get('host')}/api/${API_VERSION}/health`,
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

// ═══════════════════════════════════════════════════════════════
//  ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════

// 404 for API routes
app.use('/api/', (req, res) => {
    ApiResponse.notFound(res, `Endpoint ${req.method} ${req.path}`);
});

// 404 for non-API routes
app.use('*', (req, res) => {
    ApiResponse.notFound(res, `Endpoint ${req.method} ${req.path}`);
});

// Global error handler
app.use((err, req, res, next) => {
    console.error(`[Unhandled Error] ${req.requestId}:`, err.stack);
    
    if (err.type === 'entity.parse.failed') {
        return ApiResponse.badRequest(res, 'Invalid JSON in request body');
    }
    
    if (err.type === 'entity.too.large') {
        return ApiResponse.error(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body terlalu besar');
    }

    ApiResponse.internalError(res, 'Internal Server Error');
});

// ═══════════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    JoJo Store API - RESTful v1                  ║
║                      Running on port ${PORT}                       ║
╠══════════════════════════════════════════════════════════════════╣
║  BASE                                                            ║
║  ├─ GET    /api/v1                       API Root               ║
║  ├─ GET    /api/v1/health                Health Check           ║
║  └─ GET    /api/v1/health/detailed       Detailed Health        ║
║                                                                  ║
║  ACCOUNT                                                         ║
║  ├─ GET    /api/v1/account               Account Info           ║
║  └─ GET    /api/v1/account/balance       Balance Only           ║
║                                                                  ║
║  TRANSFERS                                                       ║
║  ├─ GET    /api/v1/transfers             Transfer History       ║
║  ├─ POST   /api/v1/transfers             Create Transfer        ║
║  └─ POST   /api/v1/transfers/withdraw    Withdraw QRIS Balance  ║
║                                                                  ║
║  WALLETS                                                         ║
║  ├─ GET    /api/v1/wallets               List Wallets           ║
║  ├─ GET    /api/v1/wallets/:name         Wallet Detail          ║
║  └─ POST   /api/v1/wallets/:name/topup   Top Up Wallet          ║
║                                                                  ║
║  PAYMENTS                                                        ║
║  └─ POST   /api/v1/payments/qris         Generate QRIS          ║
║                                                                  ║
║  TRANSACTIONS                                                    ║
║  ├─ GET    /api/v1/transactions          All Transactions       ║
║  └─ GET    /api/v1/transactions/:id      Transaction Detail     ║
╚══════════════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;