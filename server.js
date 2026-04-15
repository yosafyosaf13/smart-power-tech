const express = require('express');
const { Pool } = require('pg'); // مكتبة PostgreSQL
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// إعدادات السيرفر
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(__dirname)); // لخدمة ملف index.html

// وظيفة مساعدة لتسجيل الأخطاء
function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

// الاتصال بقاعدة البيانات (الرابط يأتي تلقائياً من Render)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// تهيئة قاعدة البيانات وإنشاء الجداول
async function initDb() {
    try {
        log('Initializing Database...');

        // جدول العروض
        await pool.query(`CREATE TABLE IF NOT EXISTS offers (
            id SERIAL PRIMARY KEY,
            title TEXT,
            price REAL,
            description TEXT,
            image TEXT,
            theme TEXT,
            detailType TEXT
        )`);

        // جدول الطلبات
        await pool.query(`CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY,
            code TEXT UNIQUE,
            customerName TEXT,
            address TEXT,
            phone TEXT,
            offerId INTEGER,
            offerTitle TEXT,
            price REAL,
            status TEXT DEFAULT 'pending',
            warrantyEnds BIGINT,
            date BIGINT,
            suspendReason TEXT
        )`);

        // جدول الإعدادات
        await pool.query(`CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT
        )`);

        // جدول الجلسات
        await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            created_at BIGINT
        )`);

        // بيانات افتراضية (Seed Data)
        const offersCount = await pool.query('SELECT COUNT(*) as count FROM offers');
        if (offersCount.rows[0].count === 0) {
            const defaultOffers = [
                ['سماعة أوتا الأصلية',750,'سماعة Intercom أصلية مع ضمان سنة كامل، تركيب احترافي.','https://z-cdn-media.chatglm.cn/files/a27cc213-2bcc-42ab-a02a-8b253da79acd.jpg?auth_key=1876024178-c79c30e1abf6456eaf45892214aa5441-0-195db27cda661623c28bbf13b4fcf048','blue','auta'],
                ['نظام كالون SIB + رداد',6750,'نظام كالون SIB متطور مع رداد هيدروليك 150 كجم، شامل التركيب والشفرة.','https://z-cdn-media.chatglm.cn/files/99287677-5a0a-476b-9f2f-a5799f499012.jpg?auth_key=1876162527-311cbced16da4c38a669c678fb2d33c0-0-f552a5b9fcc0fc9c7be6d384eed5c2b1','orange','sib']
            ];
            
            for (const o of defaultOffers) {
                await pool.query('INSERT INTO offers (title, price, description, image, theme, detailType) VALUES ($1, $2, $3, $4, $5, $6)', o);
            }
            log('Default offers inserted.');
        }

        // إعدادات افتراضية
        const keys = ['warrantyDays', 'phone', 'adminPassword', 'systemName'];
        const values = ['365', '01026943837', '1234', 'SMART POWER TECH'];
        
        for (let i = 0; i < keys.length; i++) {
            const res = await pool.query('SELECT value FROM config WHERE key = $1', [keys[i]]);
            if (res.rows.length === 0) {
                await pool.query('INSERT INTO config (key, value) VALUES ($1, $2)', [keys[i], values[i]]);
            }
        }
        log('Database initialized successfully.');

    } catch (err) {
        log('ERROR initializing database: ' + err.message);
    }
}

initDb();

// --- Middleware للحماية ---
const adminAuth = (req, res, next) => {
    const token = req.cookies.admin_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    pool.query('SELECT created_at FROM sessions WHERE token = $1', [token], (err, res) => {
        if (err || res.rows.length === 0) return res.status(401).json({ error: 'Invalid Session' });
        
        const oneDay = 24 * 60 * 60 * 1000;
        if (Date.now() - res.rows[0].created_at > oneDay) {
            pool.query('DELETE FROM sessions WHERE token = $1', [token]);
            return res.status(401).json({ error: 'Session Expired' });
        }
        next();
    });
};

// --- API Routes ---

// 1. جلب العروض
app.get('/api/offers', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM offers ORDER BY id ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

// 2. جلب الطلبات
app.get('/api/orders', adminAuth, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM orders ORDER BY date DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

// 3. إنشاء طلب جديد
app.post('/api/orders', async (req, res) => {
    const { code, customerName, address, phone, offerId, offerTitle, price } = req.body;
    const query = `INSERT INTO orders (code, customerName, address, phone, offerId, offerTitle, price, date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`;
    
    try {
        const { rows } = await pool.query(query, [code, customerName, address, phone, offerId, offerTitle, price, Date.now()]);
        log(`INFO: New order created - Code: ${code}`);
        res.json({ id: rows[0].id });
    } catch (err) {
        if (err.code === '23505') { // Unique violation
            res.status(400).json({ error: 'Code already exists' });
        } else {
            res.status(500).json({ error: err.message });
        }
    }
});

// 4. البحث عن ضمان
app.get('/api/warranty/:code', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM orders WHERE code = $1', [req.params.code]);
        if (rows.length === 0) return res.status(404).json({ error: 'Code not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({error: err.message });
    }
});

// 5. تحديث حالة الطلب
app.put('/api/orders/:id/status', adminAuth, async (req, res) => {
    const { status, warrantyDays } = req.body;
    const orderId = req.params.id;
    
    let warrantyEnds = null;
    if (status === 'active') {
        const confRes = await pool.query('SELECT value FROM config WHERE key = $1', ['warrantyDays']);
        const days = confRes.rows.length > 0 ? parseInt(confRes.rows[0].value) : 365;
        warrantyEnds = Date.now() + (days * 24 * 60 * 60 * 1000);
    }

    try {
        await pool.query(`UPDATE orders SET status = $1, warrantyEnds = $2 WHERE id = $3`, [status, warrantyEnds, orderId]);
        res.json({ message: 'Status updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. إيقاف الضمان
app.put('/api/orders/:id/suspend', adminAuth, async (req, res) => {
    const { reason } = req.body;
    try {
        await pool.query(`UPDATE orders SET status = 'suspended', suspendReason = $1, suspendDate = $2 WHERE id = $3`, [reason, Date.now(), req.params.id]);
        res.json({ message: 'Warranty suspended' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. إعادة تفعيل الضمان
app.put('/api/orders/:id/reactivate', adminAuth, async (req, res) => {
    try {
        const confRes = await pool.query('SELECT value FROM config WHERE key = $1', ['warrantyDays']);
        const days = confRes.rows.length > 0 ? parseInt(confRes.rows[0].value) : 365;
        const warrantyEnds = Date.now() + (days * 24 * 60 * 60 * 1000);
        
        await pool.query(`UPDATE orders SET status = 'active', suspendReason = NULL, suspendDate = NULL, warrantyEnds = $1 WHERE id = $2`, [warrantyEnds, req.params.id]);
        res.json({ message: 'Warranty reactivated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 8. تسجيل دخول الإدارة
app.post('/api/login', async (req, res) => {
    const { password } = req.body;
    try {
        const { rows } = await pool.query('SELECT value FROM config WHERE key = $1', ['adminPassword']);
        if (rows.length > 0 && rows[0].value === password) {
            const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
            await pool.query('INSERT INTO sessions (token, created_at) VALUES ($1, $2)', [token, Date.now()]);
            
            res.cookie('admin_token', token, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true });
            res.json({ success: true, token });
        } else {
            res.status(401).json({ success: false, message: 'Wrong password' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 9. جلب الإعدادات
app.get('/api/config', adminAuth, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM config');
        const config = {};
        rows.forEach(r => config[r.key] = r.value);
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// بدء السيرفر
app.listen(PORT, () => {
    console.log('===========================================');
    console.log(`   SMART POWER TECH - SERVER READY`);
    console.log(`   Running on: http://localhost:${PORT}`);
    console.log(`   Database: PostgreSQL (Render)`);
    console.log('===========================================');
});
