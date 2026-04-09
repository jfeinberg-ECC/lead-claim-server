const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const claimedLeads = {};
const leadData = {};
const clients = new Set();

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
  const areaCode = digits.substring(0, 3);
  return areaCodeTimezones[areaCode] || 'America/New_York';
}

function isWithinCallingHours(phone) {
  const tz = getTimezoneForPhone(phone);
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour').value);
  const m = parseInt(parts.find(p => p.type === 'minute').value);
  const totalMins = h * 60 + m;
  return totalMins >= 480 && totalMins < 1020;
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`Connected. Total: ${clients.size}`);
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'claim') {
        const { leadId, repName } = msg;
        if (claimedLeads[leadId]) {
          ws.send(JSON.stringify({ type: 'claim_failed', leadId, claimedBy: claimedLeads[leadId] }));
        } else {
          claimedLeads[leadId] = repName;
          const lead = leadData[leadId];
          ws.send(JSON.stringify({ type: 'claim_success', leadId, lead }));
          broadcastAll({ type: 'lead_claimed', leadId, claimedBy: repName });
          console.log(`Lead ${leadId} claimed by ${repName}`);
        }
      }
      if (msg.type === 'dispose') {
        const { leadId, repName, disposition, notes } = msg;
        const lead = leadData[leadId] || {};
        handleDisposition({ lead, disposition, notes, repName });
        broadcastAll({ type: 'lead_disposed', leadId, disposition, claimedBy: repName });
        console.log(`Disposed ${leadId}: ${disposition}`);
      }
    } catch (err) {
      console.error('Message error:', err);
    }
  });
});

async function handleDisposition({ lead, disposition, notes, repName }) {
  const payload = { ...lead, notes, disposition, repName, disposedAt: new Date().toISOString() };
  if (['imn_app_taken', 'imn_app_sent'].includes(disposition)) {
    await sendToZapier(process.env.ZAPIER_SALESFORCE_WEBHOOK, payload);
  } else if (['left_message', 'no_answer', 'in_market_later'].includes(disposition)) {
    await sendToZapier(process.env.ZAPIER_VANILLASOFT_WEBHOOK, payload);
  }
  // not_qualified, not_interested, wrong_number → archive only (no webhook)
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

app.post('/webhook/lead', (req, res) => {
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
  console.log(`New lead: ${lead.id} | ${leadType} | ${withinHours ? 'in hours' : 'OUTSIDE hours'} | ${tz}`);
  broadcastAll({ type: 'new_lead', lead: { id: lead.id, leadType, withinCallingHours: withinHours, timezone: tz } });
  res.json({ success: true, leadId: lead.id });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
