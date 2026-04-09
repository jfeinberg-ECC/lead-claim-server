const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store of claimed leads (resets on server restart)
const claimedLeads = {};

// Track all connected employee clients
const clients = new Set();

// --- WebSocket connection ---
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`Employee connected. Total connected: ${clients.size}`);

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Employee disconnected. Total connected: ${clients.size}`);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // Employee is trying to claim a lead
      if (msg.type === 'claim') {
        const { leadId, repName } = msg;

        if (claimedLeads[leadId]) {
          // Already claimed — tell this client who got it
          ws.send(JSON.stringify({
            type: 'claim_failed',
            leadId,
            claimedBy: claimedLeads[leadId],
          }));
        } else {
          // First claim — lock it
          claimedLeads[leadId] = repName;
          console.log(`Lead ${leadId} claimed by ${repName}`);

          // Broadcast to ALL clients that this lead is taken
          broadcast({
            type: 'lead_claimed',
            leadId,
            claimedBy: repName,
          });
        }
      }
    } catch (err) {
      console.error('Invalid message:', err);
    }
  });
});

// --- Zapier webhook endpoint ---
// Zapier sends a POST here when a customer texts back
app.post('/webhook/lead', (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: 'Missing phone or message' });
  }

  const lead = {
    id: `lead_${Date.now()}`,
    phone: phone.trim(),
    message: message.trim(),
    receivedAt: new Date().toISOString(),
  };

  console.log('New lead received:', lead);

  // Push to all connected employee dashboards instantly
  broadcast({ type: 'new_lead', lead });

  res.json({ success: true, leadId: lead.id });
});

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: clients.size,
    claimedToday: Object.keys(claimedLeads).length,
  });
});

// --- Broadcast helper ---
function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Lead claim server running on port ${PORT}`);
});
