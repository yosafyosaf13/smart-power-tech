const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs'); // لعمل النسخ الاحتياطي
const cookieParser = require('cookie-parser');

const app = express();
const PORT = 3000;
const DB_FILE = './smart_power.db';

// إعدادات السيرفر
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'))); // ضع index.html في مجلد اسمه public أو نفس المجلد
app.use(express.static(__dirname)); // أو في نفس المجلد مباشرة

// وظيفة مساعدة لتسجيل الأخطاء
function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

// الاتصال بقاعدة البيانات
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        log('ERROR: Failed to connect to database: ' + err.message);
    } else {
        log('SUCCESS: Connected to SQLite database.');
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        // جدول العروض
        db.run(`CREATE TABLE IF NOT EXISTS offers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            price REAL,
            description TEXT,
            image TEXT,
            theme TEXT,
            detailType TEXT
        )`);

        // جدول الطلبات المطور (يتضمن حالات متعددة)
        db.run(`CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE,
            customerName TEXT,
            address TEXT,
            phone TEXT,
            offerId INTEGER,
            offerTitle TEXT,
            price REAL,
            status TEXT DEFAULT 'pending', 
            -- الحالات: pending (في الانتظار), paid (تم الدفع), active (مفعل), expired (منتهي), suspended (موقوف)
            warrantyEnds INTEGER,
            date INTEGER,
            suspendReason TEXT
        )`);

        // جدول الإعدادات
        db.run(`CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT
        )`);

        // جدول الجلسات (لحماية المدير)
        db.run(`CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            created_at INTEGER
        )`);

        // بيانات افتراضية
        seedData();
    });
}

function seedData() {
    db.get("SELECT count(*) as count FROM offers", (err, row) => {
        if (row && row.count === 0) {
            const defaultOffers = [
                {title:'سماعة أوتا الأصلية',price:750,desc:'سماعة Intercom أصلية مع ضمان سنة كامل، تركيب احترافي.',img:'https://z-cdn-media.chatglm.cn/files/a27cc213-2bcc-42ab-a02a-8b253da79acd.jpg?auth_key=1876024178-c79c30e1abf6456eaf45892214aa5441-0-195db27cda661623c28bbf13b4fcf048',theme:'blue',detailType:'auta'},
                {title:'نظام كالون SIB + رداد',price:6750,desc:'نظام كالون SIB متطور مع رداد هيدروليك 150 كجم، شامل التركيب والشفرة.',img:'https://z-cdn-media.chatglm.cn/files/99287677-5a0a-476b-9f2f-a5799f499012.jpg?auth_key=1876162527-311cbced16da4c38a669c678fb2d33c0-0-f552a5b9fcc0fc9c7be6d384eed5c2b1',theme:'orange',detailType:'sib'}
            ];
            const stmt = db.prepare("INSERT INTO offers (title, price, description, image, theme, detailType) VALUES (?,?,?,?,?,?)");
            defaultOffers.forEach(o => stmt.run(o.title, o.price, o.desc, o.img, o.theme, o.detailType));
            stmt.finalize();
            log('INFO: Default offers inserted.');
        }
    });

    const defaultConfig = [
        {k:'warrantyDays', v:'365'},
        {k:'phone', v:'01026943837'},
        {k:'adminPassword', v:'1234'}, // كلمة مرور افتراضية
        {k:'systemName', v:'SMART POWER TECH'}
    ];

    defaultConfig.forEach(c => {
        db.get("SELECT value FROM config WHERE key=?", [c.k], (err, row) => {
            if (!row) {
                db.run("INSERT INTO config (key, value) VALUES (?,?)", [c.k, c.v]);
            }
        });
    });
}

// --- الميدلوير (Middleware) للحماية ---
// منع الوصول لبيانات المدير إلا إذا كان التوكين (Token) صحيحاً
const adminAuth = (req, res, next) => {
    const token = req.cookies.admin_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    db.get("SELECT created_at FROM sessions WHERE token = ?", [token], (err, row) => {
        if (err || !row) {
            return res.status(401).json({ error: 'Invalid Session' });
        }
        // التحقق من أن الجلسة قديمة (مثلاً 24 ساعة)
        const oneDay = 24 * 60 * 60 * 1000;
        if (Date.now() - row.created_at > oneDay) {
            db.run("DELETE FROM sessions WHERE token = ?", [token]); // حذف الجلسة القديمة
            return res.status(401).json({ error: 'Session Expired' });
        }
        next();
    });
};

// --- API Routes ---

// 1. الطلبات العامة (للمستخدمين)
app.get('/api/offers', (req, res) => {
    db.all("SELECT * FROM offers", [], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(rows);
    });
});

app.post('/api/orders', (req, res) => {
    const { code, customerName, address, phone, offerId, offerTitle, price } = req.body;
    const sql = `INSERT INTO orders (code, customerName, address, phone, offerId, offerTitle, price, date) VALUES (?,?,?,?,?,?,?,?)`;
    
    db.run(sql, [code, customerName, address, phone, offerId, offerTitle, price, Date.now()], function(err) {
        if (err) {
            log('ERROR creating order: ' + err.message);
            return res.status(500).json({error: 'Database Error'});
        }
        log(`INFO: New order created - Code: ${code}`);
        res.json({ success: true, id: this.lastID });
    });
});

app.get('/api/warranty/:code', (req, res) => {
    db.get("SELECT * FROM orders WHERE code = ?", [req.params.code], (err, row) => {
        if (err) return res.status(500).json({error: err.message});
        if (!row) return res.status(404).json({error: 'Code not found'});
        res.json(row);
    });
});

// 2. إدارة النظام (Admin - محمي)
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    // التحقق من كلمة المرور من قاعدة البيانات
    db.get("SELECT value FROM config WHERE key='adminPassword'", [], (err, row) => {
        if (err || !row) return res.status(500).json({error: 'System Error'});
        
        if (row.value === password) {
            // إنشاء توكين عشوائي
            const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
            db.run("INSERT INTO sessions (token, created_at) VALUES (?,?)", [token, Date.now()]);
            
            // حفظ التوكين في الكوكي (لفة سنة)
            res.cookie('admin_token', token, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true });
            res.json({ success: true, token });
        } else {
            log('WARNING: Failed login attempt');
            res.status(401).json({ success: false, message: 'Wrong password' });
        }
    });
});

app.get('/api/orders', adminAuth, (req, res) => {
    db.all("SELECT * FROM orders ORDER BY date DESC", [], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(rows);
    });
});

app.get('/api/config', adminAuth, (req, res) => {
    db.all("SELECT * FROM config", [], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        const config = {};
        rows.forEach(r => config[r.key] = r.value);
        res.json(config);
    });
});

app.put('/api/orders/:id/status', adminAuth, (req, res) => {
    const { status, warrantyDays } = req.body;
    const orderId = req.params.id;
    
    let warrantyEnds = null;
    if (status === 'active') {
        // جلب مدة الضمان من الإعدادات
        db.get("SELECT value FROM config WHERE key='warrantyDays'", [], (err, row) => {
            const days = row ? parseInt(row.value) : 365;
            warrantyEnds = Date.now() + (days * 24 * 60 * 60 * 1000);
            
            const sql = `UPDATE orders SET status = ?, warrantyEnds = ? WHERE id = ?`;
            db.run(sql, [status, warrantyEnds, orderId], function(err) {
                if (err) return res.status(500).json({error: err.message});
                log(`INFO: Order ${orderId} status updated to ${status}`);
                res.json({ message: 'Status updated' });
            });
        });
    } else {
        const sql = `UPDATE orders SET status = ? WHERE id = ?`;
        db.run(sql, [status, orderId], function(err) {
            if (err) return res.status(500).json({error: err.message});
            log(`INFO: Order ${orderId} status updated to ${status}`);
            res.json({ message: 'Status updated' });
        });
    }
});

app.put('/api/orders/:id/suspend', adminAuth, (req, res) => {
    const { reason } = req.body;
    const sql = `UPDATE orders SET status = 'suspended', suspendReason = ?, suspendDate = ? WHERE id = ?`;
    db.run(sql, [reason, Date.now(), req.params.id], function(err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({ message: 'Warranty suspended' });
    });
});

app.put('/api/orders/:id/reactivate', adminAuth, (req, res) => {
    db.get("SELECT value FROM config WHERE key='warrantyDays'", [], (err, row) => {
        const days = row ? parseInt(row.value) : 365;
        const warrantyEnds = Date.now() + (days * 24 * 60 * 60 * 1000);
        
        const sql = `UPDATE orders SET status = 'active', suspendReason = NULL, suspendDate = NULL, warrantyEnds = ? WHERE id = ?`;
        db.run(sql, [warrantyEnds, req.params.id], function(err) {
            if (err) return res.status(500).json({error: err.message});
            res.json({ message: 'Warranty reactivated' });
        });
    });
});

// --- نظام النسخ الاحتياطي (Backup/Restore) ---

// 1. تحميل النسخة الاحتياطية (تصدير ملف قاعدة البيانات)
app.get('/api/backup/download', adminAuth, (req, res) => {
    const file = `${__dirname}/${DB_FILE}`;
    res.download(file, `smart_power_backup_${new Date().toISOString().split('T')[0]}.db`);
    log('INFO: Backup downloaded by Admin');
});

// 2. استعادة النسخة الاحتياطية (رفع ملف واستبدال قاعدة البيانات)
app.post('/api/backup/restore', adminAuth, (req, res) => {
    // ملاحظة: لرفع الملفات نحتاج مكتبة 'multer'، لكن للتبسيط سنفترض أن المستخدم سيعمل يدوياً على السيرفر
    // هنا سنقوم بعمل نسخة احتياطية تلقائية قبل الاستعادة
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${__dirname}/auto_backup_${timestamp}.db`;
    
    fs.copyFile(DB_FILE, backupPath, (err) => {
        if (err) log('ERROR creating auto backup before restore: ' + err.message);
        else log(`INFO: Auto backup created at ${backupPath}`);
        
        // منطق الاستعادة هنا (يحتاج لتعديل الكود لاستقبال الملف المرفوع)
        // سنكتفي بالأتمان أن النظام يدعم ميزة النسخ الاحتياطي الأولية
        
        res.json({ message: 'Restore endpoint ready (needs frontend implementation)' });
    });
});

app.get('/api/system/info', adminAuth, (req, res) => {
    fs.stat(DB_FILE, (err, stats) => {
        if (err) return res.json({ size: 'Unknown', modified: 'Unknown' });
        res.json({ 
            size: (stats.size / 1024).toFixed(2) + ' KB', 
            modified: stats.mtime,
            db_file: DB_FILE
        });
    });
});

// بدء السيرفر
app.listen(PORT, () => {
    console.log('===========================================');
    console.log(`   SMART POWER TECH - SERVER READY`);
    console.log(`   Running on: http://localhost:${PORT}`);
    console.log(`   Database: ${DB_FILE}`);
    console.log('===========================================');
});