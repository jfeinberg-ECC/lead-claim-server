const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: '10mb' }));

// Never cache ANY static files — always serve fresh
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  maxAge: 0
}));

// ── DATABASE ─────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      lead_type TEXT,
      first_name TEXT,
      last_name TEXT,
      phone TEXT,
      email TEXT,
      company_name TEXT,
      state TEXT,
      timezone TEXT,
      within_calling_hours BOOLEAN,
      qualify_amount TEXT,
      timeline TEXT,
      time_in_business TEXT,
      monthly_revenue TEXT,
      funds_used_for TEXT,
      conducts_business TEXT,
      campaign_name TEXT,
      form_name TEXT,
      received_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS lead_events (
      id SERIAL PRIMARY KEY,
      lead_id TEXT,
      event_type TEXT,
      rep_name TEXT,
      disposition TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS waiting_queue (
      lead_id TEXT PRIMARY KEY,
      lead_data JSONB,
      added_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_super_admin BOOLEAN DEFAULT FALSE,
      linked_rep_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      admin_id INTEGER REFERENCES admins(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
    );

    CREATE TABLE IF NOT EXISTS reps (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      first_name TEXT,
      last_name TEXT,
      password_hash TEXT,
      profile_pic TEXT,
      active BOOLEAN DEFAULT TRUE,
      invited_at TIMESTAMPTZ DEFAULT NOW(),
      last_login TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS rep_sessions (
      token TEXT PRIMARY KEY,
      rep_id INTEGER REFERENCES reps(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days'
    );

    CREATE TABLE IF NOT EXISTS rep_invites (
      token TEXT PRIMARY KEY,
      rep_id INTEGER REFERENCES reps(id) ON DELETE CASCADE,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days'
    );
  `);

  // Default super admin
  const existing = await pool.query('SELECT id FROM admins WHERE is_super_admin = TRUE LIMIT 1');
  if (existing.rows.length === 0) {
    const hash = hashPassword('changeme123');
    await pool.query(
      'INSERT INTO admins (username, password_hash, is_super_admin) VALUES ($1, $2, TRUE) ON CONFLICT DO NOTHING',
      ['admin', hash]
    );
    console.log('Default super admin created: admin / changeme123');
  }
  // Add columns if they don't exist (safe migration)
  await pool.query("ALTER TABLE reps ADD COLUMN IF NOT EXISTS first_name TEXT").catch(()=>{});
  await pool.query("ALTER TABLE reps ADD COLUMN IF NOT EXISTS last_name TEXT").catch(()=>{});
  await pool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS linked_rep_id INTEGER").catch(()=>{});
  console.log('Database initialized');
}

// ── IN-MEMORY STATE ──────────────────────────────────────────
const claimedLeads = {};
const leadData = {};
const clients = new Set();
const repCooldowns = {};
const repActiveLeads = {};
const COOLDOWN_MS = 60000;

// ── HELPERS ──────────────────────────────────────────────────
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'voltlead_salt').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function sendEmail(to, subject, html) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@voltlead.io';
  if (!apiKey) { console.warn('No SendGrid API key'); return; }
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, name: 'Voltlead' },
        subject,
        content: [{ type: 'text/html', value: html }]
      })
    });
    if (res.ok) console.log(`Email sent to ${to}`);
    else console.error(`SendGrid error: ${res.status}`, await res.text());
  } catch (err) {
    console.error('Email error:', err);
  }
}

// ── TIMEZONE HELPERS ─────────────────────────────────────────
const areaCodeTimezones = {
  '201':'America/New_York','202':'America/New_York','203':'America/New_York','207':'America/New_York',
  '212':'America/New_York','215':'America/New_York','216':'America/New_York','217':'America/Chicago',
  '218':'America/Chicago','219':'America/Chicago','224':'America/Chicago','225':'America/Chicago',
  '228':'America/Chicago','229':'America/New_York','231':'America/New_York','234':'America/New_York',
  '239':'America/New_York','240':'America/New_York','248':'America/New_York','251':'America/Chicago',
  '252':'America/New_York','256':'America/Chicago','260':'America/New_York','267':'America/New_York',
  '269':'America/New_York','270':'America/Chicago','272':'America/New_York','276':'America/New_York',
  '281':'America/Chicago','301':'America/New_York','302':'America/New_York','303':'America/Denver',
  '304':'America/New_York','305':'America/New_York','309':'America/Chicago','310':'America/Los_Angeles',
  '312':'America/Chicago','313':'America/New_York','314':'America/Chicago','315':'America/New_York',
  '316':'America/Chicago','317':'America/New_York','318':'America/Chicago','319':'America/Chicago',
  '320':'America/Chicago','321':'America/New_York','323':'America/Los_Angeles','325':'America/Chicago',
  '330':'America/New_York','331':'America/Chicago','334':'America/Chicago','336':'America/New_York',
  '337':'America/Chicago','339':'America/New_York','346':'America/Chicago','347':'America/New_York',
  '351':'America/New_York','352':'America/New_York','360':'America/Los_Angeles','361':'America/Chicago',
  '380':'America/New_York','385':'America/Denver','386':'America/New_York','401':'America/New_York',
  '402':'America/Chicago','404':'America/New_York','405':'America/Chicago','406':'America/Denver',
  '407':'America/New_York','408':'America/Los_Angeles','409':'America/Chicago','410':'America/New_York',
  '412':'America/New_York','413':'America/New_York','414':'America/Chicago','415':'America/Los_Angeles',
  '417':'America/Chicago','419':'America/New_York','423':'America/New_York','424':'America/Los_Angeles',
  '425':'America/Los_Angeles','430':'America/Chicago','432':'America/Chicago','434':'America/New_York',
  '435':'America/Denver','440':'America/New_York','442':'America/Los_Angeles','443':'America/New_York',
  '458':'America/Los_Angeles','463':'America/New_York','469':'America/Chicago','470':'America/New_York',
  '475':'America/New_York','478':'America/New_York','479':'America/Chicago','480':'America/Phoenix',
  '484':'America/New_York','501':'America/Chicago','502':'America/New_York','503':'America/Los_Angeles',
  '504':'America/Chicago','505':'America/Denver','507':'America/Chicago','508':'America/New_York',
  '509':'America/Los_Angeles','510':'America/Los_Angeles','512':'America/Chicago','513':'America/New_York',
  '515':'America/Chicago','516':'America/New_York','517':'America/New_York','518':'America/New_York',
  '520':'America/Phoenix','530':'America/Los_Angeles','531':'America/Chicago','539':'America/Chicago',
  '540':'America/New_York','541':'America/Los_Angeles','551':'America/New_York','559':'America/Los_Angeles',
  '561':'America/New_York','562':'America/Los_Angeles','563':'America/Chicago','567':'America/New_York',
  '570':'America/New_York','571':'America/New_York','573':'America/Chicago','574':'America/New_York',
  '575':'America/Denver','580':'America/Chicago','585':'America/New_York','586':'America/New_York',
  '601':'America/Chicago','602':'America/Phoenix','603':'America/New_York','605':'America/Chicago',
  '606':'America/New_York','607':'America/New_York','608':'America/Chicago','609':'America/New_York',
  '610':'America/New_York','612':'America/Chicago','614':'America/New_York','615':'America/New_York',
  '616':'America/New_York','617':'America/New_York','618':'America/Chicago','619':'America/Los_Angeles',
  '620':'America/Chicago','623':'America/Phoenix','626':'America/Los_Angeles','628':'America/Los_Angeles',
  '629':'America/New_York','630':'America/Chicago','631':'America/New_York','636':'America/Chicago',
  '641':'America/Chicago','646':'America/New_York','650':'America/Los_Angeles','651':'America/Chicago',
  '657':'America/Los_Angeles','660':'America/Chicago','661':'America/Los_Angeles','662':'America/Chicago',
  '667':'America/New_York','669':'America/Los_Angeles','678':'America/New_York','681':'America/New_York',
  '682':'America/Chicago','689':'America/New_York','701':'America/Chicago','702':'America/Los_Angeles',
  '703':'America/New_York','704':'America/New_York','706':'America/New_York','707':'America/Los_Angeles',
  '708':'America/Chicago','712':'America/Chicago','713':'America/Chicago','714':'America/Los_Angeles',
  '715':'America/Chicago','716':'America/New_York','717':'America/New_York','718':'America/New_York',
  '719':'America/Denver','720':'America/Denver','724':'America/New_York','725':'America/Los_Angeles',
  '726':'America/Chicago','727':'America/New_York','731':'America/Chicago','732':'America/New_York',
  '734':'America/New_York','737':'America/Chicago','740':'America/New_York','747':'America/Los_Angeles',
  '754':'America/New_York','757':'America/New_York','760':'America/Los_Angeles','762':'America/New_York',
  '763':'America/Chicago','765':'America/New_York','769':'America/Chicago','770':'America/New_York',
  '772':'America/New_York','773':'America/Chicago','774':'America/New_York','775':'America/Los_Angeles',
  '779':'America/Chicago','781':'America/New_York','785':'America/Chicago','786':'America/New_York',
  '801':'America/Denver','802':'America/New_York','803':'America/New_York','804':'America/New_York',
  '805':'America/Los_Angeles','806':'America/Chicago','808':'Pacific/Honolulu','810':'America/New_York',
  '812':'America/New_York','813':'America/New_York','814':'America/New_York','815':'America/Chicago',
  '816':'America/Chicago','817':'America/Chicago','818':'America/Los_Angeles','828':'America/New_York',
  '830':'America/Chicago','831':'America/Los_Angeles','832':'America/Chicago','838':'America/New_York',
  '843':'America/New_York','845':'America/New_York','847':'America/Chicago','848':'America/New_York',
  '850':'America/Chicago','856':'America/New_York','857':'America/New_York','858':'America/Los_Angeles',
  '859':'America/New_York','860':'America/New_York','862':'America/New_York','863':'America/New_York',
  '864':'America/New_York','865':'America/New_York','870':'America/Chicago','872':'America/Chicago',
  '878':'America/New_York','901':'America/Chicago','903':'America/Chicago','904':'America/New_York',
  '906':'America/New_York','907':'America/Anchorage','908':'America/New_York','909':'America/Los_Angeles',
  '910':'America/New_York','912':'America/New_York','913':'America/Chicago','914':'America/New_York',
  '915':'America/Denver','916':'America/Los_Angeles','917':'America/New_York','918':'America/Chicago',
  '919':'America/New_York','920':'America/Chicago','925':'America/Los_Angeles','928':'America/Phoenix',
  '929':'America/New_York','931':'America/Chicago','936':'America/Chicago','937':'America/New_York',
  '940':'America/Chicago','941':'America/New_York','947':'America/New_York','949':'America/Los_Angeles',
  '951':'America/Los_Angeles','952':'America/Chicago','954':'America/New_York','956':'America/Chicago',
  '959':'America/New_York','970':'America/Denver','971':'America/Los_Angeles','972':'America/Chicago',
  '973':'America/New_York','978':'America/New_York','979':'America/Chicago','980':'America/New_York',
  '984':'America/New_York','985':'America/Chicago','989':'America/New_York'
};

function getTimezoneForPhone(phone) {
  const cleaned = (phone || '').replace(/\D/g, '');
  const digits = cleaned.startsWith('1') ? cleaned.slice(1) : cleaned;
  return areaCodeTimezones[digits.substring(0, 3)] || 'America/New_York';
}

function isWithinCallingHours(phone) {
  const tz = getTimezoneForPhone(phone);
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour').value);
  const m = parseInt(parts.find(p => p.type === 'minute').value);
  return (h * 60 + m) >= 480 && (h * 60 + m) < 1020;
}

// ── REP AUTH MIDDLEWARE ──────────────────────────────────────
async function requireRep(req, res, next) {
  const token = req.headers['x-rep-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const result = await pool.query(
    'SELECT r.* FROM rep_sessions s JOIN reps r ON s.rep_id = r.id WHERE s.token = $1 AND s.expires_at > NOW() AND r.active = TRUE',
    [token]
  );
  if (result.rows.length === 0) return res.status(401).json({ error: 'Session expired' });
  req.rep = result.rows[0];
  next();
}

// ── ADMIN AUTH MIDDLEWARE ────────────────────────────────────
async function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const result = await pool.query(
    'SELECT a.* FROM admin_sessions s JOIN admins a ON s.admin_id = a.id WHERE s.token = $1 AND s.expires_at > NOW()',
    [token]
  );
  if (result.rows.length === 0) return res.status(401).json({ error: 'Session expired' });
  req.admin = result.rows[0];
  next();
}

async function requireSuperAdmin(req, res, next) {
  await requireAdmin(req, res, () => {
    if (!req.admin.is_super_admin) return res.status(403).json({ error: 'Super admin required' });
    next();
  });
}

// ── WEBSOCKET ────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`Connected. Total: ${clients.size}`);

  pool.query('SELECT lead_id, lead_data, added_at FROM waiting_queue ORDER BY added_at ASC')
    .then(result => {
      if (result.rows.length > 0) {
        // Send full lead data so client can claim properly after refresh
        const queue = result.rows.map(row => ({
          lead_id: row.lead_id,
          lead_data: row.lead_data, // Already full data stored in DB
          added_at: row.added_at
        }));
        ws.send(JSON.stringify({ type: 'waiting_queue_init', queue }));
      }
    }).catch(err => console.error('Queue fetch error:', err));

  // Send rep their server-side state so client stays in sync
  ws.on('message-init', async (repName) => {
    if (repActiveLeads[repName]) {
      ws.send(JSON.stringify({ type: 'server_state', hasActiveLead: true, activeLeadId: repActiveLeads[repName] }));
    } else {
      ws.send(JSON.stringify({ type: 'server_state', hasActiveLead: false }));
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'claim') {
        const { leadId, repToken: msgRepToken } = msg;
        let repName = msg.repName;
        // Verify rep token and use authenticated name from DB
        if (msgRepToken) {
          try {
            const tokenResult = await pool.query(
              'SELECT r.name FROM rep_sessions s JOIN reps r ON s.rep_id = r.id WHERE s.token = $1 AND s.expires_at > NOW() AND r.active = TRUE',
              [msgRepToken]
            );
            if (tokenResult.rows.length > 0) repName = tokenResult.rows[0].name;
          } catch(e) { console.error('Token verify error:', e); }
        }
        const now = Date.now();
        const lastClaim = repCooldowns[repName] || 0;
        const secondsLeft = Math.ceil((COOLDOWN_MS - (now - lastClaim)) / 1000);
        const hasActive = repActiveLeads[repName] && repActiveLeads[repName] !== leadId;

        if (claimedLeads[leadId]) {
          ws.send(JSON.stringify({ type: 'claim_failed', leadId, claimedBy: claimedLeads[leadId] }));
        } else if (hasActive) {
          ws.send(JSON.stringify({ type: 'claim_blocked', reason: 'active_lead', leadId }));
        } else if (now - lastClaim < COOLDOWN_MS) {
          ws.send(JSON.stringify({ type: 'claim_blocked', reason: 'cooldown', secondsLeft, leadId }));
        } else {
          // Check calling hours
          const leadInfo = leadData[leadId];
          if (leadInfo && leadInfo.withinCallingHours === false) {
            const stillOutside = !isWithinCallingHours(leadInfo.phone || '');
            if (stillOutside) {
              ws.send(JSON.stringify({ type: 'claim_blocked', reason: 'outside_hours', leadId }));
              return;
            }
          }
          // DB-level atomic lock — prevents double claims after server restart
          const existingClaim = await pool.query(
            `SELECT rep_name FROM lead_events WHERE lead_id = $1 AND event_type = 'claimed' LIMIT 1`,
            [leadId]
          );
          if (existingClaim.rows.length > 0) {
            const claimedBy = existingClaim.rows[0].rep_name;
            claimedLeads[leadId] = claimedBy; // Restore memory
            ws.send(JSON.stringify({ type: 'claim_failed', leadId, claimedBy }));
            return;
          }
          claimedLeads[leadId] = repName;
          repCooldowns[repName] = now;
          repActiveLeads[repName] = leadId;
          // Always fetch full lead from DB to ensure complete data
          let lead = leadData[leadId];
          try {
            const result = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
            if (result.rows.length > 0) {
              const r = result.rows[0];
              lead = {
                id: r.id, leadType: r.lead_type, timezone: r.timezone,
                withinCallingHours: r.within_calling_hours,
                firstName: r.first_name, lastName: r.last_name,
                phone: r.phone, email: r.email, companyName: r.company_name,
                state: r.state, qualifyAmount: r.qualify_amount,
                timeline: r.timeline, timeInBusiness: r.time_in_business,
                monthlyRevenue: r.monthly_revenue, fundsUsedFor: r.funds_used_for,
                conductsBusiness: r.conducts_business, campaignName: r.campaign_name,
              };
              leadData[leadId] = lead;
            }
          } catch(e) { console.error('Lead fetch error:', e); }
          ws.send(JSON.stringify({ type: 'claim_success', leadId, lead }));
          broadcastAll({ type: 'lead_claimed', leadId, claimedBy: repName });
          await pool.query('DELETE FROM waiting_queue WHERE lead_id = $1', [leadId]);
          await pool.query(
            'INSERT INTO lead_events (lead_id, event_type, rep_name) VALUES ($1, $2, $3)',
            [leadId, 'claimed', repName]
          );
          console.log(`Lead ${leadId} claimed by ${repName}`);
        }
      }

      if (msg.type === 'dispose') {
        const { leadId, disposition, notes, repToken: msgRepToken } = msg;
        let repName = msg.repName;
        // Verify via token for consistent naming
        if (msgRepToken) {
          try {
            const tr = await pool.query(
              'SELECT r.name FROM rep_sessions s JOIN reps r ON s.rep_id = r.id WHERE s.token = $1 AND s.expires_at > NOW()',
              [msgRepToken]
            );
            if (tr.rows.length > 0) repName = tr.rows[0].name;
          } catch(e) {}
        }
        const lead = leadData[leadId] || {};
        handleDisposition({ lead, disposition, notes, repName });
        if (repActiveLeads[repName] === leadId) delete repActiveLeads[repName];
        // Always remove from waiting queue on dispose
        await pool.query('DELETE FROM waiting_queue WHERE lead_id = $1', [leadId]);
        broadcastAll({ type: 'lead_disposed', leadId, disposition, claimedBy: repName });
        broadcastAll({ type: 'lead_claimed', leadId, claimedBy: repName }); // ensure queue UI updates
        await pool.query(
          'INSERT INTO lead_events (lead_id, event_type, rep_name, disposition, notes) VALUES ($1, $2, $3, $4, $5)',
          [leadId, 'disposed', repName, disposition, notes]
        );
        console.log(`Disposed ${leadId}: ${disposition} by ${repName}`);
      }

      if (msg.type === 'pass') {
        const { leadId, lead } = msg;
        let repName = msg.repName;
        // Verify token for consistent naming
        if (msg.repToken) {
          try {
            const tr = await pool.query(
              'SELECT r.name FROM rep_sessions s JOIN reps r ON s.rep_id = r.id WHERE s.token = $1 AND s.expires_at > NOW()',
              [msg.repToken]
            );
            if (tr.rows.length > 0) repName = tr.rows[0].name;
          } catch(e) {}
        }
        // Only pass if NOT already claimed by someone else
        if (claimedLeads[leadId] && claimedLeads[leadId] !== repName) {
          console.log(`Pass rejected — lead ${leadId} already claimed by ${claimedLeads[leadId]}`);
          return;
        }
        // Release active lead lock for this rep
        if (repName && repActiveLeads[repName] === leadId) {
          delete repActiveLeads[repName];
        }
        // Remove from claimedLeads so it can be claimed again
        delete claimedLeads[leadId];
        await addToWaitingQueue(leadId, lead);
        await pool.query(
          'INSERT INTO lead_events (lead_id, event_type, rep_name) VALUES ($1, $2, $3)',
          [leadId, 'passed', repName || 'unknown']
        );
      }

      if (msg.type === 'release_lock') {
        const { repName } = msg;
        if (repName) {
          delete repActiveLeads[repName];
          console.log(`Lock released for ${repName}`);
        }
      }

      if (msg.type === 'rep_init') {
        // Client asking server for their true state on connect
        // Check DB for undisposed leads in last 2 hours — don't trust memory alone
        const { repName, repToken: msgRepToken } = msg;
        if (repName) {
          let verifiedName = repName;
          // Verify token to get consistent name
          if (msgRepToken) {
            try {
              const tr = await pool.query(
                'SELECT r.name, r.first_name, r.last_name FROM rep_sessions s JOIN reps r ON s.rep_id = r.id WHERE s.token = $1 AND s.expires_at > NOW()',
                [msgRepToken]
              );
              if (tr.rows.length > 0) {
                verifiedName = tr.rows[0].name;
              }
            } catch(e) { console.error('rep_init error:', e); }
          }
          
          const activeLeadId = repActiveLeads[verifiedName] || null;
          const cooldownMs = repCooldowns[verifiedName] ? Math.max(0, COOLDOWN_MS - (Date.now() - repCooldowns[verifiedName])) : 0;
          ws.send(JSON.stringify({
            type: 'server_state',
            hasActiveLead: !!activeLeadId,
            activeLeadId,
            cooldownSecsLeft: Math.ceil(cooldownMs / 1000)
          }));
          console.log(`State sync for ${verifiedName}: active=${activeLeadId}, cooldown=${Math.ceil(cooldownMs/1000)}s`);
        }
      }

      if (msg.type === 'expire') {
        const { leadId } = msg;
        // Don't expire if already claimed by someone
        if (claimedLeads[leadId]) {
          console.log(`Expire ignored — lead ${leadId} already claimed by ${claimedLeads[leadId]}`);
          return;
        }
        let lead = msg.lead;
        // Always fetch full lead from DB for queue storage
        try {
          const r = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
          if (r.rows.length > 0) {
            const row = r.rows[0];
            lead = {
              id: row.id, leadType: row.lead_type, timezone: row.timezone,
              withinCallingHours: row.within_calling_hours,
              firstName: row.first_name, lastName: row.last_name,
              phone: row.phone, email: row.email, companyName: row.company_name,
              state: row.state, qualifyAmount: row.qualify_amount,
              timeline: row.timeline, timeInBusiness: row.time_in_business,
              monthlyRevenue: row.monthly_revenue, fundsUsedFor: row.funds_used_for,
              conductsBusiness: row.conducts_business, campaignName: row.campaign_name,
            };
          }
        } catch(e) {}
        await addToWaitingQueue(leadId, lead);
        await pool.query(
          'INSERT INTO lead_events (lead_id, event_type, rep_name) VALUES ($1, $2, $3)',
          [leadId, 'expired', 'system']
        );
      }

    } catch (err) {
      console.error('Message error:', err);
    }
  });
});

async function addToWaitingQueue(leadId, lead) {
  try {
    // Get full lead from DB
    let fullLead = lead;
    try {
      const result = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
      if (result.rows.length > 0) {
        const r = result.rows[0];
        fullLead = {
          id: r.id, leadType: r.lead_type, timezone: r.timezone,
          withinCallingHours: r.within_calling_hours,
          firstName: r.first_name, lastName: r.last_name,
          phone: r.phone, email: r.email, companyName: r.company_name,
          state: r.state, qualifyAmount: r.qualify_amount,
          timeline: r.timeline, timeInBusiness: r.time_in_business,
          monthlyRevenue: r.monthly_revenue, fundsUsedFor: r.funds_used_for,
          conductsBusiness: r.conducts_business, campaignName: r.campaign_name,
        };
      }
    } catch(e) {}

    const inserted = await pool.query(
      'INSERT INTO waiting_queue (lead_id, lead_data) VALUES ($1, $2) ON CONFLICT (lead_id) DO NOTHING RETURNING lead_id',
      [leadId, JSON.stringify(fullLead)]
    );

    if (inserted.rows.length > 0) {
      // Only broadcast lead_waiting (queue update) NOT new_lead (which triggers popup)
      broadcastAll({ type: 'lead_waiting', leadId, lead: fullLead, addedAt: new Date().toISOString() });
    }
  } catch (err) {
    console.error('Waiting queue error:', err);
  }
}

async function handleDisposition({ lead, disposition, notes, repName }) {
  const payload = { ...lead, notes, disposition, repName, disposedAt: new Date().toISOString() };
  if (['imn_app_taken', 'imn_app_sent'].includes(disposition)) {
    await sendToZapier(process.env.ZAPIER_SALESFORCE_WEBHOOK, payload);
  } else if (['left_message', 'no_answer', 'in_market_later'].includes(disposition)) {
    await sendToZapier(process.env.ZAPIER_VANILLASOFT_WEBHOOK, payload);
  }
}

async function sendToZapier(webhookUrl, payload) {
  if (!webhookUrl) return console.warn('No webhook URL configured');
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log(`Zapier response: ${res.status}`);
  } catch (err) {
    console.error('Zapier error:', err);
  }
}

// ── REP AUTH ROUTES ──────────────────────────────────────────
app.post('/rep/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const hash = hashPassword(password);
  const result = await pool.query(
    'SELECT * FROM reps WHERE email = $1 AND password_hash = $2 AND active = TRUE',
    [email.toLowerCase(), hash]
  );
  if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });
  const rep = result.rows[0];
  const token = generateToken();
  await pool.query('INSERT INTO rep_sessions (token, rep_id) VALUES ($1, $2)', [token, rep.id]);
  await pool.query('UPDATE reps SET last_login = NOW() WHERE id = $1', [rep.id]);
  res.json({ token, name: rep.name, firstName: rep.first_name, lastName: rep.last_name, email: rep.email, profilePic: rep.profile_pic });
});

app.post('/rep/logout', requireRep, async (req, res) => {
  const token = req.headers['x-rep-token'];
  await pool.query('DELETE FROM rep_sessions WHERE token = $1', [token]);
  res.json({ success: true });
});

app.get('/rep/me', requireRep, async (req, res) => {
  res.json({ name: req.rep.name, firstName: req.rep.first_name, lastName: req.rep.last_name, email: req.rep.email, profilePic: req.rep.profile_pic });
});

app.post('/rep/change-password', requireRep, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  const hash = hashPassword(currentPassword);
  const result = await pool.query('SELECT id FROM reps WHERE id = $1 AND password_hash = $2', [req.rep.id, hash]);
  if (result.rows.length === 0) return res.status(401).json({ error: 'Current password is incorrect' });
  await pool.query('UPDATE reps SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), req.rep.id]);
  res.json({ success: true });
});

app.post('/rep/profile-pic', requireRep, async (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data provided' });
  await pool.query('UPDATE reps SET profile_pic = $1 WHERE id = $2', [imageData, req.rep.id]);
  res.json({ success: true, profilePic: imageData });
});

app.post('/rep/update-profile', requireRep, async (req, res) => {
  const { firstName, lastName } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: 'First and last name required' });
  const fullName = `${firstName.trim()} ${lastName.trim()}`;
  await pool.query(
    'UPDATE reps SET first_name = $1, last_name = $2, name = $3 WHERE id = $4',
    [firstName.trim(), lastName.trim(), fullName, req.rep.id]
  );
  res.json({ success: true, name: fullName, firstName: firstName.trim(), lastName: lastName.trim() });
});

// Invite acceptance — set password from invite link
app.get('/rep/invite/:token', async (req, res) => {
  const result = await pool.query(
    'SELECT i.*, r.name, r.email FROM rep_invites i JOIN reps r ON i.rep_id = r.id WHERE i.token = $1 AND i.used = FALSE AND i.expires_at > NOW()',
    [req.params.token]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Invalid or expired invite link' });
  res.json({ valid: true, name: result.rows[0].name, email: result.rows[0].email });
});

app.post('/rep/invite/:token/accept', async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const result = await pool.query(
    'SELECT i.*, r.id as rep_id FROM rep_invites i JOIN reps r ON i.rep_id = r.id WHERE i.token = $1 AND i.used = FALSE AND i.expires_at > NOW()',
    [req.params.token]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Invalid or expired invite link' });
  const invite = result.rows[0];
  await pool.query('UPDATE reps SET password_hash = $1 WHERE id = $2', [hashPassword(password), invite.rep_id]);
  await pool.query('UPDATE rep_invites SET used = TRUE WHERE token = $1', [req.params.token]);
  res.json({ success: true });
});

// ── LEAD WEBHOOK ─────────────────────────────────────────────
app.post('/webhook/lead', async (req, res) => {
  const body = req.body;
  const phone = body.phone_number || body.phone || '';
  const campaignName = (body.campaign_name || '').toLowerCase();
  const leadType = campaignName.includes('equipment') ? 'Equipment Financing' : 'Working Capital';
  const tz = getTimezoneForPhone(phone);
  const withinHours = isWithinCallingHours(phone);

  const lead = {
    id: `lead_${Date.now()}`,
    receivedAt: new Date().toISOString(),
    leadType, timezone: tz, withinCallingHours: withinHours,
    firstName: body.first_name || '',
    lastName: body.last_name || '',
    phone,
    email: body.email || '',
    companyName: body.company_name || '',
    state: body.state || '',
    qualifyAmount: body.qualify_amount || body.how_much_would_you_like_to_qualify_for || '',
    timeline: body.timeline || body.how_soon_are_you_looking_for_funds || '',
    timeInBusiness: body.time_in_business || body.how_long_have_you_been_in_business || '',
    monthlyRevenue: body.monthly_revenue || body.whats_your_current_monthly_revenue || '',
    fundsUsedFor: body.funds_used_for || body.what_will_the_funds_be_used_for || '',
    conductsBusiness: body.conducts_business || body.how_do_you_conduct_business || '',
    campaignName: body.campaign_name || '',
    formName: body.form_name || '',
  };

  leadData[lead.id] = lead;

  try {
    await pool.query(`
      INSERT INTO leads (id, lead_type, first_name, last_name, phone, email, company_name, state,
        timezone, within_calling_hours, qualify_amount, timeline, time_in_business, monthly_revenue,
        funds_used_for, conducts_business, campaign_name, form_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    `, [lead.id, lead.leadType, lead.firstName, lead.lastName, lead.phone, lead.email,
        lead.companyName, lead.state, lead.timezone, lead.withinCallingHours,
        lead.qualifyAmount, lead.timeline, lead.timeInBusiness, lead.monthlyRevenue,
        lead.fundsUsedFor, lead.conductsBusiness, lead.campaignName, lead.formName]);
  } catch (err) {
    console.error('DB insert error:', err);
  }

  console.log(`New lead: ${lead.id} | ${leadType} | ${withinHours ? 'in hours' : 'OUTSIDE hours'} | ${tz}`);
  broadcastAll({ type: 'new_lead', lead: { id: lead.id, leadType, withinCallingHours: withinHours, timezone: tz } });
  res.json({ success: true, leadId: lead.id });
});

// ── ADMIN AUTH ───────────────────────────────────────────────
app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const hash = hashPassword(password);
  const result = await pool.query(
    'SELECT * FROM admins WHERE username = $1 AND password_hash = $2',
    [username, hash]
  );
  if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
  const admin = result.rows[0];
  const token = generateToken();
  await pool.query('INSERT INTO admin_sessions (token, admin_id) VALUES ($1, $2)', [token, admin.id]);
  res.json({ token, username: admin.username, isSuperAdmin: admin.is_super_admin });
});

app.get('/admin/admins', requireSuperAdmin, async (req, res) => {
  const result = await pool.query('SELECT id, username, is_super_admin, created_at FROM admins ORDER BY created_at');
  res.json(result.rows);
});

app.post('/admin/admins', requireSuperAdmin, async (req, res) => {
  const { username, password, isSuperAdmin } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    await pool.query(
      'INSERT INTO admins (username, password_hash, is_super_admin) VALUES ($1, $2, $3)',
      [username, hashPassword(password), isSuperAdmin || false]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Username already exists' });
  }
});

app.delete('/admin/admins/:id', requireSuperAdmin, async (req, res) => {
  if (req.admin.id === parseInt(req.params.id)) return res.status(400).json({ error: 'Cannot delete yourself' });
  await pool.query('DELETE FROM admins WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.post('/admin/change-password', requireAdmin, async (req, res) => {
  const { newPassword } = req.body;
  await pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), req.admin.id]);
  res.json({ success: true });
});

// ── ADMIN REP MANAGEMENT ─────────────────────────────────────
app.get('/admin/reps', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT id, name, email, active, profile_pic, invited_at, last_login FROM reps ORDER BY name');
  res.json(result.rows);
});

app.post('/admin/reps/invite', requireAdmin, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  try {
    const repResult = await pool.query(
      'INSERT INTO reps (name, email) VALUES ($1, $2) RETURNING id',
      [name, email.toLowerCase()]
    );
    const repId = repResult.rows[0].id;
    const token = generateToken();
    await pool.query('INSERT INTO rep_invites (token, rep_id) VALUES ($1, $2)', [token, repId]);
    const baseUrl = process.env.APP_URL || 'https://lead-claim-server-production.up.railway.app';
    const inviteUrl = `${baseUrl}/invite.html?token=${token}`;
    const html = `
      <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #1D9E75; font-size: 28px; margin: 0;">⚡ Voltlead</h1>
          <p style="color: #888; margin-top: 4px;">Real-time Lead Claiming</p>
        </div>
        <div style="background: #f9f9f9; border-radius: 12px; padding: 32px;">
          <h2 style="margin: 0 0 12px; font-size: 20px;">You're invited, ${name}!</h2>
          <p style="color: #555; line-height: 1.6;">You've been added to the Voltlead lead claiming platform. Click the button below to set your password and get started.</p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${inviteUrl}" style="background: #1D9E75; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; display: inline-block;">Accept Invitation</a>
          </div>
          <p style="color: #aaa; font-size: 13px; text-align: center;">This link expires in 7 days. If you didn't expect this email, you can ignore it.</p>
        </div>
      </div>
    `;
    await sendEmail(email, 'You\'re invited to Voltlead', html);
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A rep with this email already exists' });
    res.status(500).json({ error: 'Failed to create invitation' });
  }
});

app.post('/admin/reps/:id/resend-invite', requireAdmin, async (req, res) => {
  const rep = await pool.query('SELECT * FROM reps WHERE id = $1', [req.params.id]);
  if (rep.rows.length === 0) return res.status(404).json({ error: 'Rep not found' });
  const token = generateToken();
  await pool.query('UPDATE rep_invites SET used = TRUE WHERE rep_id = $1', [req.params.id]);
  await pool.query('INSERT INTO rep_invites (token, rep_id) VALUES ($1, $2)', [token, req.params.id]);
  const baseUrl = process.env.APP_URL || 'https://lead-claim-server-production.up.railway.app';
  const inviteUrl = `${baseUrl}/invite.html?token=${token}`;
  const html = `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;"><h1 style="color:#1D9E75;">⚡ Voltlead</h1><p>Hi ${rep.rows[0].name},</p><p>Here's your new invitation link to access Voltlead:</p><div style="text-align:center;margin:32px 0;"><a href="${inviteUrl}" style="background:#1D9E75;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;display:inline-block;">Set Password</a></div><p style="color:#aaa;font-size:13px;">This link expires in 7 days.</p></div>`;
  await sendEmail(rep.rows[0].email, 'Your Voltlead invitation', html);
  res.json({ success: true });
});

app.patch('/admin/reps/:id/toggle', requireAdmin, async (req, res) => {
  const result = await pool.query('UPDATE reps SET active = NOT active WHERE id = $1 RETURNING active', [req.params.id]);
  res.json({ active: result.rows[0].active });
});

app.post('/admin/reps/:id/reset-password', requireAdmin, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: 'Password required' });
  await pool.query('UPDATE reps SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), req.params.id]);
  await pool.query('DELETE FROM rep_sessions WHERE rep_id = $1', [req.params.id]);
  res.json({ success: true });
});

app.post('/admin/reps/:id/reset-cooldown', requireAdmin, async (req, res) => {
  const rep = await pool.query('SELECT name FROM reps WHERE id = $1', [req.params.id]);
  if (rep.rows.length === 0) return res.status(404).json({ error: 'Rep not found' });
  const name = rep.rows[0].name;
  delete repCooldowns[name];
  delete repActiveLeads[name];
  res.json({ success: true });
});

// ── ADMIN REPORTING ──────────────────────────────────────────
app.get('/admin/stats', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  const dateFilter = from && to ? `AND l.received_at BETWEEN '${from}' AND '${to}'` : '';
  const [totals, byRep, byDisposition, byLeadType, avgResponse, waiting] = await Promise.all([
    pool.query(`SELECT COUNT(*) as total_leads FROM leads l WHERE 1=1 ${dateFilter}`),
    pool.query(`
      SELECT e.rep_name,
        COUNT(DISTINCT CASE WHEN e.event_type = 'claimed' THEN e.lead_id END) as claimed,
        COUNT(DISTINCT CASE WHEN e.event_type = 'disposed' THEN e.lead_id END) as disposed,
        COUNT(DISTINCT CASE WHEN e.disposition IN ('imn_app_taken','imn_app_sent') THEN e.lead_id END) as positive,
        COUNT(DISTINCT CASE WHEN e.disposition IN ('left_message','no_answer','in_market_later') THEN e.lead_id END) as vanillasoft,
        COUNT(DISTINCT CASE WHEN e.disposition IN ('not_qualified','not_interested','wrong_number') THEN e.lead_id END) as negative
      FROM lead_events e
      JOIN leads l ON e.lead_id = l.id
      WHERE e.event_type IN ('claimed','disposed') ${dateFilter.replace('l.received_at','l.received_at')}
      GROUP BY e.rep_name ORDER BY claimed DESC
    `),
    pool.query(`
      SELECT e.disposition, COUNT(*) as count FROM lead_events e
      JOIN leads l ON e.lead_id = l.id
      WHERE e.event_type = 'disposed' ${dateFilter}
      GROUP BY e.disposition ORDER BY count DESC
    `),
    pool.query(`SELECT l.lead_type, COUNT(*) as count FROM leads l WHERE 1=1 ${dateFilter} GROUP BY l.lead_type`),
    pool.query(`
      SELECT AVG(EXTRACT(EPOCH FROM (claim.created_at - l.received_at))) as avg_seconds
      FROM lead_events claim JOIN leads l ON claim.lead_id = l.id
      WHERE claim.event_type = 'claimed' ${dateFilter}
    `),
    pool.query('SELECT COUNT(*) as count FROM waiting_queue'),
  ]);
  res.json({
    totalLeads: parseInt(totals.rows[0].total_leads),
    byRep: byRep.rows,
    byDisposition: byDisposition.rows,
    byLeadType: byLeadType.rows,
    avgResponseSeconds: Math.round(avgResponse.rows[0].avg_seconds || 0),
    waitingCount: parseInt(waiting.rows[0].count),
  });
});

app.get('/admin/leads', requireAdmin, async (req, res) => {
  const { from, to, rep, disposition } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (from && to) { params.push(from, to); where += ` AND l.received_at BETWEEN $${params.length-1} AND $${params.length}`; }
  if (rep) { params.push(rep); where += ` AND claim_event.rep_name = $${params.length}`; }
  if (disposition) { params.push(disposition); where += ` AND dispose_event.disposition = $${params.length}`; }
  const result = await pool.query(`
    SELECT l.*,
      claim_event.rep_name as claimed_by, claim_event.created_at as claimed_at,
      dispose_event.disposition, dispose_event.notes, dispose_event.created_at as disposed_at
    FROM leads l
    LEFT JOIN lead_events claim_event ON l.id = claim_event.lead_id AND claim_event.event_type = 'claimed'
    LEFT JOIN lead_events dispose_event ON l.id = dispose_event.lead_id AND dispose_event.event_type = 'disposed'
    ${where} ORDER BY l.received_at DESC LIMIT 500
  `, params);
  res.json(result.rows);
});

// Delete lead
app.delete('/admin/leads/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM lead_events WHERE lead_id = $1', [req.params.id]);
  await pool.query('DELETE FROM waiting_queue WHERE lead_id = $1', [req.params.id]);
  await pool.query('DELETE FROM leads WHERE id = $1', [req.params.id]);
  delete leadData[req.params.id];
  res.json({ success: true });
});

// Manual lead addition
app.post('/admin/leads/manual', requireAdmin, async (req, res) => {
  const body = req.body;
  const phone = body.phone || '';
  const campaignName = (body.campaignName || '').toLowerCase();
  const leadType = campaignName.includes('equipment') ? 'Equipment Financing' : 'Working Capital';
  const tz = getTimezoneForPhone(phone);
  const withinHours = isWithinCallingHours(phone);

  const lead = {
    id: `lead_${Date.now()}`,
    receivedAt: new Date().toISOString(),
    leadType, timezone: tz, withinCallingHours: withinHours,
    firstName: body.firstName || '',
    lastName: body.lastName || '',
    phone,
    email: body.email || '',
    companyName: body.companyName || '',
    state: body.state || '',
    qualifyAmount: body.qualifyAmount || '',
    timeline: body.timeline || '',
    timeInBusiness: body.timeInBusiness || '',
    monthlyRevenue: body.monthlyRevenue || '',
    fundsUsedFor: body.fundsUsedFor || '',
    conductsBusiness: body.conductsBusiness || '',
    campaignName: body.campaignName || 'Manual Entry',
    formName: 'Admin Manual',
  };

  leadData[lead.id] = lead;
  try {
    await pool.query(`
      INSERT INTO leads (id, lead_type, first_name, last_name, phone, email, company_name, state,
        timezone, within_calling_hours, qualify_amount, timeline, time_in_business, monthly_revenue,
        funds_used_for, conducts_business, campaign_name, form_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    `, [lead.id, lead.leadType, lead.firstName, lead.lastName, lead.phone, lead.email,
        lead.companyName, lead.state, lead.timezone, lead.withinCallingHours,
        lead.qualifyAmount, lead.timeline, lead.timeInBusiness, lead.monthlyRevenue,
        lead.fundsUsedFor, lead.conductsBusiness, lead.campaignName, lead.formName]);
  } catch (err) {
    console.error('DB insert error:', err);
  }

  broadcastAll({ type: 'new_lead', lead: { id: lead.id, leadType, withinCallingHours: withinHours, timezone: tz } });
  res.json({ success: true, leadId: lead.id });
});

app.get('/admin/export', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  const dateFilter = from && to ? `AND l.received_at BETWEEN '${from}' AND '${to}'` : '';
  const result = await pool.query(`
    SELECT l.received_at, l.lead_type, l.first_name, l.last_name, l.phone, l.email,
      l.company_name, l.state, l.timezone, l.qualify_amount, l.timeline,
      l.time_in_business, l.monthly_revenue, l.funds_used_for,
      claim_event.rep_name as claimed_by, claim_event.created_at as claimed_at,
      dispose_event.disposition, dispose_event.notes, dispose_event.created_at as disposed_at
    FROM leads l
    LEFT JOIN lead_events claim_event ON l.id = claim_event.lead_id AND claim_event.event_type = 'claimed'
    LEFT JOIN lead_events dispose_event ON l.id = dispose_event.lead_id AND dispose_event.event_type = 'disposed'
    WHERE 1=1 ${dateFilter} ORDER BY l.received_at DESC
  `);
  const headers = ['Received','Lead Type','First Name','Last Name','Phone','Email','Company','State','Timezone',
    'Qualify Amount','Timeline','Time in Business','Monthly Revenue','Funds Used For',
    'Claimed By','Claimed At','Disposition','Notes','Disposed At'];
  const rows = result.rows.map(r => [
    r.received_at, r.lead_type, r.first_name, r.last_name, r.phone, r.email,
    r.company_name, r.state, r.timezone, r.qualify_amount, r.timeline,
    r.time_in_business, r.monthly_revenue, r.funds_used_for,
    r.claimed_by, r.claimed_at, r.disposition, r.notes, r.disposed_at
  ].map(v => `"${(v||'').toString().replace(/"/g,'""')}"`).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=voltlead-leads.csv');
  res.send([headers.join(','), ...rows].join('\n'));
});

app.get('/admin/waiting', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM waiting_queue ORDER BY added_at ASC');
  res.json(result.rows);
});

// One-time admin password reset — remove after use
app.get('/reset-admin-password', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== 'voltlead-reset-2024') return res.status(403).json({ error: 'Forbidden' });
  const hash = hashPassword('changeme123');
  await pool.query('UPDATE admins SET password_hash = $1 WHERE username = $2', [hash, 'admin']);
  res.json({ success: true, message: 'Admin password reset to changeme123' });
});

// ── REP RECENT LEADS ─────────────────────────────────────────
app.get('/rep/recent-leads', requireRep, async (req, res) => {
  const rep = req.rep;
  // Get all names this rep has ever used (first_name+last_name combos + current name)
  const possibleNames = [rep.name];
  if (rep.first_name && rep.last_name) {
    possibleNames.push(`${rep.first_name} ${rep.last_name}`);
  }
  // Also check any name stored in lead_events that could match this rep's email pattern
  const result = await pool.query(`
    SELECT DISTINCT ON (l.id) l.*,
      e_claim.created_at as claimed_at,
      e_claim.rep_name as claimed_by_name,
      e_dispose.disposition, e_dispose.notes, e_dispose.created_at as disposed_at
    FROM leads l
    JOIN lead_events e_claim ON l.id = e_claim.lead_id AND e_claim.event_type = 'claimed'
    LEFT JOIN lead_events e_dispose ON l.id = e_dispose.lead_id AND e_dispose.event_type = 'disposed'
    WHERE l.received_at > NOW() - INTERVAL '30 days'
    AND e_claim.rep_name = ANY($1)
    ORDER BY l.id, e_claim.created_at DESC
  `, [possibleNames]);
  // Sort: undisposed first (most recent claim), then disposed (most recent first)
  res.json(result.rows);
});

// Get admin's linked rep
app.get('/admin/linked-rep', requireAdmin, async (req, res) => {
  const result = await pool.query(
    'SELECT a.linked_rep_id, r.name, r.id FROM admins a LEFT JOIN reps r ON a.linked_rep_id = r.id WHERE a.id = $1',
    [req.admin.id]
  );
  const row = result.rows[0];
  res.json({ linkedRepId: row?.linked_rep_id, linkedRepName: row?.name });
});

// Set admin's linked rep
app.post('/admin/link-rep', requireAdmin, async (req, res) => {
  const { repId } = req.body;
  await pool.query('UPDATE admins SET linked_rep_id = $1 WHERE id = $2', [repId || null, req.admin.id]);
  res.json({ success: true });
});

// ── ADMIN SWITCH TO REP ──────────────────────────────────────
app.post('/admin/switch-to-rep', requireAdmin, async (req, res) => {
  const admin = req.admin;
  let repId;
  let repName = admin.username;

  // Use linked rep account if set
  const adminData = await pool.query('SELECT linked_rep_id FROM admins WHERE id = $1', [req.admin.id]);
  const linkedRepId = adminData.rows[0]?.linked_rep_id;

  if (linkedRepId) {
    // Use the admin's linked rep account
    const repResult = await pool.query('SELECT * FROM reps WHERE id = $1', [linkedRepId]);
    if (repResult.rows.length > 0) {
      repId = repResult.rows[0].id;
      repName = repResult.rows[0].name;
      await pool.query('UPDATE reps SET active = TRUE WHERE id = $1', [repId]);
    }
  }

  if (!repId) {
    // No linked rep — return error asking admin to link one
    return res.status(400).json({ error: 'No rep account linked. Go to Change Password page to link your rep account.' });
  }
  // Create a short-lived one-time token (5 minutes)
  const token = generateToken();
  await pool.query(
    "INSERT INTO rep_sessions (token, rep_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '8 hours')",
    [token, repId]
  );
  res.json({ token, repName });
});

// Manual queue recovery trigger (admin only)
app.post('/admin/recover-queue', requireAdmin, async (req, res) => {
  await recoverOrphanedLeads();
  const result = await pool.query('SELECT COUNT(*) as count FROM waiting_queue');
  res.json({ success: true, queueCount: parseInt(result.rows[0].count) });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connected: clients.size, leads: Object.keys(leadData).length });
});

function broadcastAll(data) {
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

// ── 2-HOUR LEAD TIMEOUT ──────────────────────────────────────
const LEAD_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const LEAD_WARNING_MS = 90 * 60 * 1000;      // 90 minutes — warn rep

async function checkLeadTimeouts() {
  try {
    // Find claimed but undisposed leads older than 90 minutes
    // Only look at leads claimed in last 30 days, exclude already queued ones
    const result = await pool.query(`
      SELECT DISTINCT ON (e.lead_id) e.lead_id, e.rep_name, e.created_at as claimed_at,
        l.first_name, l.last_name
      FROM lead_events e
      JOIN leads l ON e.lead_id = l.id
      WHERE e.event_type = 'claimed'
      AND e.created_at < NOW() - INTERVAL '90 minutes'
      AND l.received_at > NOW() - INTERVAL '30 days'
      AND NOT EXISTS (
        SELECT 1 FROM lead_events d
        WHERE d.lead_id = e.lead_id AND d.event_type IN ('disposed', 'timeout', 'passed')
      )
      AND NOT EXISTS (
        SELECT 1 FROM waiting_queue wq WHERE wq.lead_id = e.lead_id
      )
      ORDER BY e.lead_id, e.created_at DESC
    `);
    
    // Skip leads currently active in memory
    const activeLeadIds = new Set(Object.values(repActiveLeads));

    for (const row of result.rows) {
      const claimedAt = new Date(row.claimed_at).getTime();
      const age = Date.now() - claimedAt;
      const leadId = row.lead_id;
      const repName = row.rep_name;
      
      // Skip if currently active in memory
      if (activeLeadIds.has(leadId)) continue;

      if (age >= LEAD_TIMEOUT_MS) {
        // 2+ hours — release lead back to queue
        console.log(`Lead ${leadId} timed out for ${repName} — returning to queue`);
        if (repActiveLeads[repName] === leadId) delete repActiveLeads[repName];
        delete claimedLeads[leadId];
        // Get full lead data
        const leadResult = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
        if (leadResult.rows.length > 0) {
          const r = leadResult.rows[0];
          const lead = {
            id: r.id, leadType: r.lead_type, timezone: r.timezone,
            withinCallingHours: r.within_calling_hours,
            firstName: r.first_name, lastName: r.last_name,
            phone: r.phone, email: r.email, companyName: r.company_name,
            state: r.state, qualifyAmount: r.qualify_amount,
            timeline: r.timeline, timeInBusiness: r.time_in_business,
            monthlyRevenue: r.monthly_revenue, fundsUsedFor: r.funds_used_for,
            conductsBusiness: r.conducts_business,
          };
          await addToWaitingQueue(leadId, lead);
          await pool.query(
            'INSERT INTO lead_events (lead_id, event_type, rep_name, notes) VALUES ($1, $2, $3, $4)',
            [leadId, 'timeout', repName, 'Returned to queue after 2 hour timeout']
          );
          // Notify rep their lead was released
          broadcastAll({
            type: 'lead_timeout',
            leadId,
            repName,
            message: `${row.first_name} ${row.last_name} was returned to the queue after 2 hours`
          });
        }
      } else if (age >= LEAD_WARNING_MS) {
        // 90+ minutes — warn the rep
        const minsLeft = Math.ceil((LEAD_TIMEOUT_MS - age) / 60000);
        broadcastAll({
          type: 'lead_timeout_warning',
          leadId,
          repName,
          minutesLeft: minsLeft,
          message: `⚠️ Your lead ${row.first_name} ${row.last_name} will return to the queue in ${minsLeft} minutes if not disposed`
        });
      }
    }
  } catch(err) {
    console.error('Timeout check error:', err);
  }
}

// Run timeout check every 5 minutes
setInterval(checkLeadTimeouts, 5 * 60 * 1000);

// Recover orphaned leads — unclaimed leads not in waiting queue
async function recoverOrphanedLeads() {
  try {
    // First clean up any disposed leads that are still in the waiting queue
    await pool.query(`
      DELETE FROM waiting_queue wq
      WHERE EXISTS (
        SELECT 1 FROM lead_events e
        WHERE e.lead_id = wq.lead_id
        AND e.event_type IN ('disposed', 'timeout')
      )
    `);
    const result = await pool.query(`
      SELECT l.* FROM leads l
      WHERE l.received_at > NOW() - INTERVAL '30 days'
      AND NOT EXISTS (
        SELECT 1 FROM lead_events e 
        WHERE e.lead_id = l.id AND e.event_type IN ('disposed', 'timeout')
      )
      AND NOT EXISTS (
        SELECT 1 FROM lead_events e2 
        WHERE e2.lead_id = l.id AND e2.event_type = 'claimed'
        AND e2.created_at > NOW() - INTERVAL '2 hours'
        AND NOT EXISTS (
          SELECT 1 FROM lead_events d 
          WHERE d.lead_id = l.id AND d.event_type IN ('disposed','timeout','passed')
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM waiting_queue wq WHERE wq.lead_id = l.id
      )
    `);
    for (const r of result.rows) {
      const lead = {
        id: r.id, leadType: r.lead_type, timezone: r.timezone,
        withinCallingHours: r.within_calling_hours,
        firstName: r.first_name, lastName: r.last_name,
        phone: r.phone, email: r.email, companyName: r.company_name,
        state: r.state, qualifyAmount: r.qualify_amount,
        timeline: r.timeline, timeInBusiness: r.time_in_business,
        monthlyRevenue: r.monthly_revenue, fundsUsedFor: r.funds_used_for,
        conductsBusiness: r.conducts_business, campaignName: r.campaign_name,
      };
      await pool.query(
        'INSERT INTO waiting_queue (lead_id, lead_data) VALUES ($1, $2) ON CONFLICT (lead_id) DO NOTHING',
        [r.id, JSON.stringify(lead)]
      );
      console.log(`Recovered orphaned lead: ${r.first_name} ${r.last_name}`);
    }
    if (result.rows.length > 0) {
      console.log(`Recovered ${result.rows.length} orphaned leads to queue`);
      // Broadcast full queue refresh to all clients (not new_lead which triggers popup)
      const queueResult = await pool.query('SELECT lead_id, lead_data, added_at FROM waiting_queue ORDER BY added_at ASC');
      broadcastAll({ type: 'waiting_queue_init', queue: queueResult.rows });
    }
  } catch(err) {
    console.error('Recovery error:', err);
  }
}

// Run recovery every 2 minutes
setInterval(recoverOrphanedLeads, 2 * 60 * 1000);
// Also run on startup after DB init
setTimeout(recoverOrphanedLeads, 5000);

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  server.listen(PORT, () => console.log(`Voltlead server on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
