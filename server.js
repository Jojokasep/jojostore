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
    VOUCHER_DANA: "3056", VOUCHER_OVO: "11886", VOUCHER_GOPAY: "3062", VOUCHER_SHOPEEPAY: "3058"
};
const QRIS_RAW = "00020101021126670016COM.NOBUBANK.WWW01189360050300000879140214508257991305870303UMI51440014ID.CO.QRIS.WWW0215ID20232921284770303UMI5204541153033605802ID5920JOJO STORE OK13496366006CIAMIS61054621162070703A0163045679";

const DB_FILE = path.join(__dirname, 'db.json');
let db = { users: [], sessions: [], webhooks: [], seenTx: [], pendingWd: [], settings: { withdrawMode: 'auto', adminId: null } };
function loadDb() { try { if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')) }; } catch(e) {} }
function saveDb() { try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 0)); } catch(e) {} }
loadDb();

const WH_SEC = process.env.WH_SEC || crypto.randomBytes(16).toString('hex');

async function hitApi(url, data) {
    try {
        const p = { ...CONFIG.DEVICE_DATA, ...data, auth_token: CONFIG.AUTH_TOKEN, request_time: Date.now().toString(), ui_mode: 'dark' };
        const params = new URLSearchParams(); for (const k in p) params.append(k, p[k]);
        const res = await axios.post(url, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Host': 'app.orderkuota.com', 'User-Agent': 'okhttp/4.9.3', 'auth-token': CONFIG.AUTH_TOKEN }, timeout: 15000 });
        return res.data;
    } catch(e) { return { success: false, message: "Koneksi Error" }; }
}
function cleanNum(s) { return Number(String(s||'').replace(/[^0-9]/g,'')) || 0; }
function crc16(str) { let c = 0xFFFF; for (let i = 0; i < str.length; i++) { c ^= str.charCodeAt(i) << 8; for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c.toString(16).toUpperCase().padStart(4, '0'); }
function buildQris(name) {
    const t = []; let i = 0;
    while (i < QRIS_RAW.length - 4) { const tg = QRIS_RAW.substring(i, i+2), ln = parseInt(QRIS_RAW.substring(i+2, i+4), 10), v = QRIS_RAW.substring(i+4, i+4+ln); t.push({tag:tg,val:v}); i += 4+ln; }
    const nm = String(name||'STORE').toUpperCase().substring(0,25), idx = t.findIndex(x=>x.tag==='59'); if(idx!==-1)t[idx].val=nm;
    let p=''; for(const x of t){if(x.tag==='63')continue;p+=x.tag+String(x.val.length).padStart(2,'0')+x.val;} return p+'6304'+crc16(p);
}

function auth(req, res, next) {
    const tk = req.headers['authorization']?.replace('Bearer ','');
    if(!tk) return res.status(401).json({success:false,message:"Token diperlukan"});
    const ses = db.sessions.find(s=>s.token===tk);
    if(!ses) return res.status(401).json({success:false,message:"Sesi expired"});
    const u = db.users.find(x=>x.id===ses.userId);
    if(!u) return res.status(401).json({success:false,message:"User tidak ditemukan"});
    req.user = u; next();
}
function authAdmin(req, res, next) {
    auth(req, res, () => {
        if(req.user.role !== 'admin') return res.status(403).json({success:false,message:"Admin only"});
        next();
    });
}

// SSE
const sseC = new Map();
function notifySSE(uid, ev, data) {
    const msg = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
    const c = sseC.get(uid); if(!c) return;
    let dead = []; for(const r of c){try{r.write(msg);}catch(e){dead.push(r);}} dead.forEach(r=>c.delete(r)); if(c.size===0) sseC.delete(uid);
}
async function whBroadcast(ev, data) {
    for(const w of db.webhooks.filter(w=>w.active)) {
        try { await axios.post(w.url, {event:ev,data,timestamp:Date.now()},{headers:{'Content-Type':'application/json','X-Webhook-Signature':'sha256='+crypto.createHmac('sha256',w.secret||WH_SEC).update(JSON.stringify(data)).digest('hex')},timeout:10000}); } catch(e){}
    }
}

// Polling
let polling = false;
async function pollQris() {
    if(polling) return; polling = true;
    try {
        const r = await hitApi('https://app.orderkuota.com/api/v2/qris/mutasi/1349636',{'requests[0]':'account','requests[qris_history][page]':'1','requests[qris_history][dari_tanggal]':'','requests[qris_history][ke_tanggal]':'','requests[qris_history][keterangan]':''});
        if(r.success && r.qris_history?.results) {
            for(const tx of r.qris_history.results) {
                const k = `${tx.id}_${tx.tanggal}_${tx.kredit}`;
                if(!db.seenTx.includes(k)) {
                    db.seenTx.unshift(k); if(db.seenTx.length>500) db.seenTx=db.seenTx.slice(0,500);
                    const amt = cleanNum(tx.kredit);
                    if(amt > 0 && !String(tx.keterangan||'').toLowerCase().includes('pencairan')) {
                        const ket = String(tx.keterangan||'').toLowerCase();
                        let u = db.users.find(x=>x.qrisActive && ket.includes(x.storeName.toLowerCase()));
                        if(!u){const a=db.users.filter(x=>x.qrisActive);if(a.length===1)u=a[0];}
                        if(!u && db.users.length>0) u=db.users[0];
                        if(u) {
                            u.balance = (Number(u.balance)||0)+amt;
                            if(!u.transactions) u.transactions=[];
                            u.transactions.unshift({id:tx.id,type:'qris_in',amount:amt,keterangan:tx.keterangan,tanggal:tx.tanggal,createdAt:new Date().toISOString()});
                            const p={merchantId:u.id,merchantName:u.storeName,amount:amt,keterangan:tx.keterangan};
                            notifySSE(u.id,'payment.in',p); whBroadcast('payment.in',p);
                        }
                    }
                    saveDb();
                }
            }
        }
    } catch(e){} polling = false;
}

// ==================== AUTH ====================
app.post('/auth/register',(req,res)=>{
    const{username,password,storeName}=req.body;
    if(!username||!password||!storeName) return res.status(400).json({success:false,message:"Semua field wajib"});
    if(username.length<3) return res.status(400).json({success:false,message:"Username min 3 karakter"});
    if(password.length<4) return res.status(400).json({success:false,message:"Password min 4 karakter"});
    if(db.users.find(u=>u.username===username)) return res.status(400).json({success:false,message:"Username sudah dipakai"});
    const role = db.users.length===0?'admin':'merchant';
    const u={id:crypto.randomUUID(),username,password:crypto.createHash('sha256').update(password).digest('hex'),storeName:storeName.toUpperCase().substring(0,25),balance:0,qrisActive:false,role,transactions:[],createdAt:new Date().toISOString()};
    if(role==='admin'&&!db.settings.adminId) db.settings.adminId=u.id;
    db.users.push(u);
    const tk=crypto.randomUUID(); db.sessions.push({token:tk,userId:u.id}); saveDb();
    res.json({success:true,message:"Registrasi berhasil",data:{token:tk,user:{id:u.id,username:u.username,storeName:u.storeName,balance:u.balance,qrisActive:u.qrisActive,role:u.role}}});
});

app.post('/auth/login',(req,res)=>{
    const{username,password}=req.body;
    if(!username||!password) return res.status(400).json({success:false,message:"Username dan password wajib"});
    const h=crypto.createHash('sha256').update(password).digest('hex');
    const u=db.users.find(x=>x.username===username&&x.password===h);
    if(!u) return res.status(401).json({success:false,message:"Username atau password salah"});
    const tk=crypto.randomUUID(); db.sessions.push({token:tk,userId:u.id}); saveDb();
    res.json({success:true,message:"Login berhasil",data:{token:tk,user:{id:u.id,username:u.username,storeName:u.storeName,balance:u.balance,qrisActive:u.qrisActive,role:u.role}}});
});

app.post('/auth/logout',auth,(req,res)=>{db.sessions=db.sessions.filter(s=>s.userId!==req.user.id);saveDb();res.json({success:true});});
app.get('/auth/me',auth,(req,res)=>{res.json({success:true,data:{id:req.user.id,username:req.user.username,storeName:req.user.storeName,balance:req.user.balance,qrisActive:req.user.qrisActive,role:req.user.role}});});

// ==================== MERCHANT ====================
app.post('/merchant/qris/toggle',auth,(req,res)=>{req.user.qrisActive=!req.user.qrisActive;saveDb();res.json({success:true,data:{qrisActive:req.user.qrisActive}});});

app.get('/merchant/qris',auth,(req,res)=>{
    const amt=req.query.amount;
    if(!amt||Number(amt)<1000) return res.status(400).json({success:false,message:"Amount min 1000"});
    if(!req.user.qrisActive) return res.status(400).json({success:false,message:"Aktifkan QRIS dulu"});
    axios.post('https://qrisku.my.id/api',{qris_statis:buildQris(req.user.storeName),amount:Number(amt)},{headers:{'Content-Type':'application/json'},timeout:10000})
        .then(r=>{if(r.data.status==='success')res.json({success:true,qris_base64:r.data.qris_base64,amount:Number(amt),store_name:req.user.storeName});else res.json({success:false,message:r.data.message});})
        .catch(()=>res.status(500).json({success:false,message:"Gagal generate"}));
});

app.get('/merchant/saldo',auth,(req,res)=>{res.json({success:true,data:{balance:req.user.balance,storeName:req.user.storeName,qrisActive:req.user.qrisActive}});});

app.get('/merchant/mutasi',auth,(req,res)=>{
    const txs=(req.user.transactions||[]).map(t=>({...t,amount_clean:cleanNum(t.kredit||t.amount)}));
    res.json({success:true,data:txs});
});

app.post('/merchant/withdraw',auth,async(req,res)=>{
    const{wallet,phone,amount}=req.body;
    if(!wallet||!phone||!amount) return res.status(400).json({success:false,message:"Semua field wajib"});
    if(Number(amount)<1000) return res.status(400).json({success:false,message:"Minimal 1000"});
    if(Number(amount)>Number(req.user.balance)) return res.status(400).json({success:false,message:"Saldo tidak cukup"});
    const map={DANA:CONFIG.VOUCHER_DANA,OVO:CONFIG.VOUCHER_OVO,GOPAY:CONFIG.VOUCHER_GOPAY,SHOPEEPAY:CONFIG.VOUCHER_SHOPEEPAY};
    if(!map[wallet]) return res.status(400).json({success:false,message:"Wallet tidak valid"});

    if(db.settings.withdrawMode==='manual'){
        const wd={id:crypto.randomUUID(),merchantId:req.user.id,merchantName:req.user.storeName,username:req.user.username,wallet,phone,amount:Number(amount),status:'pending',createdAt:new Date().toISOString()};
        db.pendingWd.push(wd); saveDb();
        notifySSE(db.settings.adminId,'withdraw.pending',wd); whBroadcast('withdraw.pending',wd);
        res.json({success:true,message:"Withdraw diajukan, menunggu persetujuan admin",data:{id:wd.id,status:'pending'}});
    } else {
        const r=await hitApi('https://app.orderkuota.com/api/v2/order',{quantity:"1",id_plgn:String(amount),kode_promo:"",pin:"",phone,voucher_id:map[wallet],payment:"balance"});
        if(r.success){
            const idTrx=r.results?.id||r.data?.id||"N/A";
            req.user.balance=(Number(req.user.balance)||0)-Number(amount);
            if(!req.user.transactions)req.user.transactions=[];
            req.user.transactions.unshift({id:idTrx,type:'withdraw',wallet,phone,amount:Number(amount),keterangan:`Withdraw ${wallet} ${phone}`,tanggal:new Date().toISOString(),createdAt:new Date().toISOString()});
            saveDb();
            const p={merchantId:req.user.id,id:idTrx,wallet,phone,amount:Number(amount)};
            notifySSE(req.user.id,'withdraw.success',p); whBroadcast('withdraw.success',p);
            res.json({success:true,message:`Withdraw ${wallet} berhasil`,data:{id_trx:idTrx,remaining_balance:req.user.balance}});
        } else res.json({success:false,message:r.message||"Gagal"});
    }
});

app.get('/merchant/sse',auth,(req,res)=>{
    res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
    res.write('event: connected\ndata: {"status":"ok"}\n\n');
    if(!sseC.has(req.user.id))sseC.set(req.user.id,new Set());
    sseC.get(req.user.id).add(res);
    req.on('close',()=>{const c=sseC.get(req.user.id);if(c){c.delete(res);if(c.size===0)sseC.delete(req.user.id);}});
});

// ==================== ADMIN ====================
app.get('/admin/merchants',authAdmin,(req,res)=>{
    res.json({success:true,data:db.users.filter(u=>u.role!=='admin').map(u=>({id:u.id,username:u.username,storeName:u.storeName,balance:u.balance,qrisActive:u.qrisActive,txCount:(u.transactions||[]).length,createdAt:u.createdAt}))});
});

app.delete('/admin/merchants/:id',authAdmin,(req,res)=>{
    const i=db.users.findIndex(u=>u.id===req.params.id&&u.role!=='admin');
    if(i===-1) return res.status(404).json({success:false,message:"Tidak ditemukan"});
    const name=db.users[i].storeName; db.users.splice(i,1);
    db.sessions=db.sessions.filter(s=>s.userId!==req.params.id);
    db.pendingWd=db.pendingWd.filter(w=>w.merchantId!==req.params.id);
    saveDb(); res.json({success:true,message:`Merchant "${name}" dihapus`});
});

app.get('/admin/withdrawals',authAdmin,(req,res)=>{
    const filter=req.query.status;
    let wds=db.pendingWd;
    if(filter) wds=wds.filter(w=>w.status===filter);
    res.json({success:true,data:wds.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))});
});

app.post('/admin/withdrawals/:id/approve',authAdmin,async(req,res)=>{
    const wd=db.pendingWd.find(w=>w.id===req.params.id&&w.status==='pending');
    if(!wd) return res.status(404).json({success:false,message:"Tidak ditemukan atau sudah diproses"});
    const u=db.users.find(x=>x.id===wd.merchantId);
    if(!u) return res.status(400).json({success:false,message:"Merchant tidak ditemukan"});
    if(Number(wd.amount)>Number(u.balance)) return res.status(400).json({success:false,message:"Saldo merchant tidak cukup"});
    const map={DANA:CONFIG.VOUCHER_DANA,OVO:CONFIG.VOUCHER_OVO,GOPAY:CONFIG.VOUCHER_GOPAY,SHOPEEPAY:CONFIG.VOUCHER_SHOPEEPAY};
    const r=await hitApi('https://app.orderkuota.com/api/v2/order',{quantity:"1",id_plgn:String(wd.amount),kode_promo:"",pin:"",phone:wd.phone,voucher_id:map[wd.wallet],payment:"balance"});
    if(r.success){
        wd.status='approved'; wd.idTrx=r.results?.id||r.data?.id||"N/A"; wd.processedAt=new Date().toISOString();
        u.balance=(Number(u.balance)||0)-Number(wd.amount);
        if(!u.transactions)u.transactions=[];
        u.transactions.unshift({id:wd.idTrx,type:'withdraw',wallet:wd.wallet,phone:wd.phone,amount:wd.amount,keterangan:`Withdraw ${wd.wallet} ${wd.phone} (Approved)`,tanggal:new Date().toISOString(),createdAt:new Date().toISOString()});
        saveDb();
        notifySSE(u.id,'withdraw.success',{id:wd.idTrx,wallet:wd.wallet,phone:wd.phone,amount:wd.amount,remaining_balance:u.balance});
        res.json({success:true,message:"Withdraw disetujui",data:wd});
    } else { res.json({success:false,message:r.message||"Gagal proses order"}); }
});

app.post('/admin/withdrawals/:id/reject',authAdmin,(req,res)=>{
    const wd=db.pendingWd.find(w=>w.id===req.params.id&&w.status==='pending');
    if(!wd) return res.status(404).json({success:false,message:"Tidak ditemukan atau sudah diproses"});
    wd.status='rejected'; wd.processedAt=new Date().toISOString(); saveDb();
    notifySSE(wd.merchantId,'withdraw.rejected',{id:wd.id,amount:wd.amount,reason:req.body.reason||'Ditolak admin'});
    res.json({success:true,message:"Withdraw ditolak",data:wd});
});

app.get('/admin/settings',authAdmin,(req,res)=>{res.json({success:true,data:db.settings});});

app.post('/admin/settings',authAdmin,(req,res)=>{
    if(req.body.withdrawMode) db.settings.withdrawMode=req.body.withdrawMode;
    saveDb(); res.json({success:true,message:"Settings disimpan",data:db.settings});
});

app.get('/admin/sse',authAdmin,(req,res)=>{
    res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
    res.write('event: connected\ndata: {"status":"ok"}\n\n');
    if(!sseC.has(req.user.id))sseC.set(req.user.id,new Set());
    sseC.get(req.user.id).add(res);
    req.on('close',()=>{const c=sseC.get(req.user.id);if(c){c.delete(res);if(c.size===0)sseC.delete(req.user.id);}});
});

// Webhook management
app.get('/api/webhook',(req,res)=>{res.json({success:true,data:db.webhooks,secret:WH_SEC});});
app.post('/api/webhook',(req,res)=>{const{url,secret,events}=req.body;if(!url)return res.status(400).json({success:false,message:"url wajib"});try{new URL(url);}catch(e){return res.status(400).json({success:false,message:"url tidak valid"});}const e={id:crypto.randomUUID(),url,secret:secret||'',events:events||[],active:true};db.webhooks.push(e);saveDb();res.json({success:true,data:e});});
app.delete('/api/webhook/:id',(req,res)=>{const i=db.webhooks.findIndex(w=>w.id===req.params.id);if(i===-1)return res.status(404).json({success:false,message:"Tidak ditemukan"});db.webhooks.splice(i,1);saveDb();res.json({success:true});});

app.get('/',(req,res)=>{res.json({status:'ok',service:'JoJo Multi-Merchant',version:'3.1',merchants:db.users.filter(u=>u.role!=='admin').length,withdrawMode:db.settings.withdrawMode});});

app.listen(PORT,()=>{console.log(`Server v3.1 port ${PORT}`);setTimeout(pollQris,3000);setInterval(pollQris,10000);});