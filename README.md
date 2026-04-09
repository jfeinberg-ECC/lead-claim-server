# Lead Claim Server

Real-time WebSocket server that receives inbound text replies via Zapier and broadcasts them to all connected employee dashboards. First employee to click "Claim" locks the lead.

---

## Deploy to Railway (10 minutes)

### Step 1 — Upload these files to GitHub
1. Go to github.com and create a free account if you don't have one
2. Click **New repository** → name it `lead-claim-server` → click **Create**
3. Upload all files from this folder (server.js, package.json, railway.toml)

### Step 2 — Deploy on Railway
1. Go to railway.app and sign up with your GitHub account
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `lead-claim-server` repo
4. Railway auto-detects Node.js and deploys it — takes about 2 minutes
5. Click **Settings** → **Networking** → **Generate Domain**
6. Copy your public URL — it will look like: `https://lead-claim-server-production.up.railway.app`

### Step 3 — Set up Zapier webhook
1. In your Zapier workflow, add a new action step: **Webhooks by Zapier → POST**
2. Set the URL to: `https://YOUR-RAILWAY-URL/webhook/lead`
3. Set Payload Type to: **JSON**
4. Map these fields:
   - `phone` → the customer's phone number from ClickSend
   - `message` → the customer's reply text from ClickSend
5. Test the step — you should see the lead appear on the dashboard

### Step 4 — Open the dashboard
- Go to `https://YOUR-RAILWAY-URL` in your browser
- Enter your name when prompted
- Keep this tab open — you're live!

---

## How it works

```
Customer texts back
       ↓
  ClickSend catches it
       ↓
    Zapier fires
       ↓
POST /webhook/lead  ←── your Railway server
       ↓
WebSocket broadcast to ALL open dashboards
       ↓
First employee clicks "Claim" → locked for everyone else
```

---

## Webhook format (what Zapier sends)

```json
POST /webhook/lead
{
  "phone": "6035550182",
  "message": "Yes I'm interested, please call me back!"
}
```

## Health check

Visit `https://YOUR-RAILWAY-URL/health` to see:
- How many employees are currently connected
- How many leads have been claimed today

---

## Notes
- Claimed leads reset when the server restarts (Railway free tier sleeps after inactivity)
- To upgrade to persistent storage, add a free Railway PostgreSQL or Redis database later
- Railway free tier gives you $5/month credit — more than enough for this use case
