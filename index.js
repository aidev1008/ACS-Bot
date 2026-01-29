

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '2mb' }));

// [WEBHOOK] POST /webhook for ACS Call Automation events
app.post('/webhook', (req, res) => {
  try {
    console.log('[WEBHOOK]', JSON.stringify(req.body));
  } catch (err) {
    console.error('[ERROR][WEBHOOK] Failed to log event:', err);
  }
  res.status(200).end();
});

// Create HTTP server for Express and WebSocket
const server = http.createServer(app);

// [MEDIA] WebSocket server for audio streaming
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (ws, req) => {
  console.log('[MEDIA] WebSocket connection established');

  ws.on('message', async (data, isBinary) => {
    if (!isBinary || !(data instanceof Buffer)) {
      console.warn('[MEDIA] Ignored non-binary or malformed frame');
      return;
    }
    // Validate PCM 16-bit, 16kHz, mono (basic check: length > 0)
    if (data.length === 0) {
      console.warn('[MEDIA] Ignored empty audio frame');
      return;
    }
    // Forward to Supabase Edge Function
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('[ERROR][MEDIA] Missing Supabase env vars');
      return;
    }
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/voice-ingest`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/octet-stream',
        },
        body: data
      });
      if (!resp.ok) {
        console.error(`[ERROR][MEDIA] Supabase ingest failed: ${resp.status}`);
      }
    } catch (err) {
      console.error('[ERROR][MEDIA] Error forwarding audio:', err);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[MEDIA] WebSocket closed: code=${code} reason=${reason}`);
  });

  ws.on('error', (err) => {
    console.error('[ERROR][MEDIA] WebSocket error:', err);
  });
});

server.listen(PORT, () => {
  console.log(`[WEBHOOK] Server running on port ${PORT}`);
});
