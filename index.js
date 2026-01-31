const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');
require('dotenv').config();

// Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const PORT = process.env.PORT || 8080;

console.log('[STARTUP] Environment check:');
console.log('[STARTUP] SUPABASE_URL:', SUPABASE_URL ? 'SET' : 'MISSING');
console.log('[STARTUP] SUPABASE_SERVICE_ROLE_KEY:', SUPABASE_SERVICE_ROLE_KEY ? 'SET' : 'MISSING');
console.log('[STARTUP] AZURE_OPENAI_ENDPOINT:', AZURE_OPENAI_ENDPOINT || 'MISSING');
console.log('[STARTUP] AZURE_OPENAI_API_KEY:', AZURE_OPENAI_API_KEY ? 'SET' : 'MISSING');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[FATAL] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY) {
  console.error('[FATAL] Missing AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_KEY');
  process.exit(1);
}

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', mode: 'text-only-suggestions' });
});

app.get('/', (req, res) => {
  res.status(200).send('ACS Bot - Text-Only AI Suggestions Mode');
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

function resample16kTo24k(input16k) {
  const inputLength = input16k.length;
  const outputLength = Math.floor(inputLength * 1.5);
  const output24k = new Int16Array(outputLength);
  
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = (i * 2) / 3;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, inputLength - 1);
    const fraction = srcIndex - srcIndexFloor;
    output24k[i] = Math.round(input16k[srcIndexFloor] * (1 - fraction) + input16k[srcIndexCeil] * fraction);
  }
  
  return output24k;
}

function int16ArrayToBase64(int16Array) {
  const uint8Array = new Uint8Array(int16Array.buffer);
  let binary = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

class AzureRealtimeSession {
  constructor(serverCallId) {
    this.serverCallId = serverCallId;
    this.azureWs = null;
    this.isConnected = false;
    this.isConfigured = false;
    this.audioChunksProcessed = 0;
    this.currentResponseText = '';
    this.transcriptsReceived = 0;
    this.responsesReceived = 0;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const wsUrl = AZURE_OPENAI_ENDPOINT.replace('https://', 'wss://');
      
      console.log('[AZURE] ========================================');
      console.log('[AZURE] Connecting to Azure OpenAI Realtime API');
      console.log('[AZURE] URL:', wsUrl);
      console.log('[AZURE] ========================================');
      
      this.azureWs = new WebSocket(wsUrl, {
        headers: {
          'api-key': AZURE_OPENAI_API_KEY
        }
      });

      this.azureWs.on('open', () => {
        console.log('[AZURE] ✅ WebSocket OPEN - Connection established');
        this.isConnected = true;
        resolve();
      });

      this.azureWs.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          await this.handleAzureMessage(msg);
        } catch (err) {
          console.error('[AZURE] ❌ Message parse error:', err.message);
          console.error('[AZURE] Raw data:', data.toString().substring(0, 500));
        }
      });

      this.azureWs.on('error', (err) => {
        console.error('[AZURE] ❌ WebSocket error:', err.message);
        reject(err);
      });

      this.azureWs.on('close', (code, reason) => {
        console.log(`[AZURE] WebSocket CLOSED. Code: ${code}, Reason: ${reason || 'none'}`);
        console.log(`[AZURE] Stats: ${this.audioChunksProcessed} chunks, ${this.transcriptsReceived} transcripts, ${this.responsesReceived} responses`);
        this.isConnected = false;
      });

      setTimeout(() => {
        if (!this.isConnected) {
          console.error('[AZURE] ❌ Connection timeout after 15 seconds');
          reject(new Error('Azure connection timeout'));
        }
      }, 15000);
    });
  }

  async handleAzureMessage(msg) {
    // Log ALL message types for debugging
    console.log(`[AZURE MSG] Type: ${msg.type}`);
    
    switch (msg.type) {
      case 'session.created':
        console.log('[AZURE] ✅ session.created received');
        console.log('[AZURE] Session ID:', msg.session?.id);
        console.log('[AZURE] Now sending configuration...');
        this.sendConfig();
        break;

      case 'session.updated':
        console.log('[AZURE] ✅ session.updated - Configuration applied');
        console.log('[AZURE] Modalities:', JSON.stringify(msg.session?.modalities));
        console.log('[AZURE] Turn detection:', JSON.stringify(msg.session?.turn_detection));
        console.log('[AZURE] Input transcription:', JSON.stringify(msg.session?.input_audio_transcription));
        this.isConfigured = true;
        break;

      // ========== INPUT AUDIO EVENTS ==========
      case 'input_audio_buffer.speech_started':
        console.log('[AZURE] 🎤 Speech STARTED - User is speaking');
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[AZURE] 🎤 Speech STOPPED - User stopped speaking');
        break;

      case 'input_audio_buffer.committed':
        console.log('[AZURE] 🎤 Audio buffer committed, item_id:', msg.item_id);
        break;

      // ========== TRANSCRIPTION EVENTS ==========
      case 'conversation.item.input_audio_transcription.completed':
        this.transcriptsReceived++;
        console.log('[AZURE] ========================================');
        console.log('[AZURE] 📝 TRANSCRIPTION COMPLETED');
        console.log('[AZURE] Transcript:', msg.transcript);
        console.log('[AZURE] Item ID:', msg.item_id);
        console.log('[AZURE] Total transcripts:', this.transcriptsReceived);
        console.log('[AZURE] ========================================');
        
        if (msg.transcript?.trim()) {
          const customerText = msg.transcript.trim();
          console.log('[CUSTOMER SAID]', customerText);
          
          try {
            await this.sendToSupabase('customer', customerText);
            console.log('[SUPABASE] ✅ Customer transcript sent');
          } catch (err) {
            console.error('[SUPABASE] ❌ Failed to send customer transcript:', err.message);
          }
        }
        break;

      case 'conversation.item.input_audio_transcription.failed':
        console.error('[AZURE] ❌ TRANSCRIPTION FAILED');
        console.error('[AZURE] Error:', JSON.stringify(msg.error, null, 2));
        break;

      // ========== CONVERSATION ITEM EVENTS ==========
      case 'conversation.item.created':
        console.log('[AZURE] 📦 Conversation item created:', msg.item?.type, 'role:', msg.item?.role);
        break;

      // ========== RESPONSE EVENTS ==========
      case 'response.created':
        console.log('[AZURE] 🤖 Response STARTED - AI is generating...');
        this.currentResponseText = '';
        break;

      case 'response.output_item.added':
        console.log('[AZURE] 🤖 Response output item added, type:', msg.item?.type);
        break;

      case 'response.content_part.added':
        console.log('[AZURE] 🤖 Content part added, type:', msg.part?.type);
        break;

      case 'response.text.delta':
        if (msg.delta) {
          this.currentResponseText += msg.delta;
          console.log('[AZURE] 🤖 Text delta received:', msg.delta.substring(0, 50) + (msg.delta.length > 50 ? '...' : ''));
        }
        break;

      case 'response.text.done':
        this.responsesReceived++;
        console.log('[AZURE] ========================================');
        console.log('[AZURE] 🤖 TEXT RESPONSE COMPLETE');
        console.log('[AZURE] Full text:', this.currentResponseText);
        console.log('[AZURE] Total responses:', this.responsesReceived);
        console.log('[AZURE] ========================================');
        
        if (this.currentResponseText.trim()) {
          try {
            await this.sendToSupabase('suggestion', this.currentResponseText);
            console.log('[SUPABASE] ✅ AI suggestion sent');
          } catch (err) {
            console.error('[SUPABASE] ❌ Failed to send AI suggestion:', err.message);
          }
          this.currentResponseText = '';
        }
        break;

      case 'response.done':
        console.log('[AZURE] 🤖 Response generation DONE');
        console.log('[AZURE] Status:', msg.response?.status);
        if (msg.response?.status === 'failed') {
          console.error('[AZURE] ❌ Response failed:', JSON.stringify(msg.response?.status_details, null, 2));
        }
        break;

      // ========== ERROR EVENTS ==========
      case 'error':
        console.error('[AZURE] ❌ ========================================');
        console.error('[AZURE] ❌ ERROR RECEIVED');
        console.error('[AZURE] ❌ Type:', msg.error?.type);
        console.error('[AZURE] ❌ Code:', msg.error?.code);
        console.error('[AZURE] ❌ Message:', msg.error?.message);
        console.error('[AZURE] ❌ Full error:', JSON.stringify(msg.error, null, 2));
        console.error('[AZURE] ❌ ========================================');
        break;

      // ========== RATE LIMIT EVENTS ==========
      case 'rate_limits.updated':
        console.log('[AZURE] Rate limits updated:', JSON.stringify(msg.rate_limits));
        break;

      default:
        console.log('[AZURE] Unhandled message type:', msg.type);
        console.log('[AZURE] Full message:', JSON.stringify(msg).substring(0, 300));
    }
  }

  sendConfig() {
    if (this.azureWs?.readyState !== WebSocket.OPEN) {
      console.error('[AZURE] ❌ Cannot send config - WebSocket not open (state:', this.azureWs?.readyState, ')');
      return;
    }

    const config = {
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: `You are an AI assistant helping human call center agents.

YOUR ROLE:
- Listen to customer speech and provide helpful SUGGESTIONS for the human agent
- Your responses will be displayed on the agent's screen as guidance
- The human agent will speak to the customer - you do NOT speak directly

SUGGESTION GUIDELINES:
1. Provide concise, actionable suggestions (1-3 sentences)
2. Suggest what the agent should say or do next
3. Identify customer intent and emotion when relevant

LANGUAGE: Always provide suggestions in English.

Remember: You are advising the AGENT, not speaking to the customer.`,

        input_audio_format: 'pcm16',
        
        input_audio_transcription: {
          model: 'whisper-1'
        },
        
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800
        },
        
        temperature: 0.7,
        max_response_output_tokens: 200
      }
    };
    
    console.log('[AZURE] ========================================');
    console.log('[AZURE] SENDING SESSION CONFIGURATION');
    console.log('[AZURE] Modalities:', config.session.modalities);
    console.log('[AZURE] Input format:', config.session.input_audio_format);
    console.log('[AZURE] Transcription model:', config.session.input_audio_transcription.model);
    console.log('[AZURE] VAD type:', config.session.turn_detection.type);
    console.log('[AZURE] ========================================');
    
    this.azureWs.send(JSON.stringify(config));
    console.log('[AZURE] ✅ Configuration sent, waiting for session.updated...');
  }

  sendAudio(base64Audio) {
    if (this.azureWs?.readyState === WebSocket.OPEN) {
      this.audioChunksProcessed++;
      
      if (this.audioChunksProcessed % 100 === 0) {
        console.log(`[AZURE] Audio progress: ${this.audioChunksProcessed} chunks sent, ${this.transcriptsReceived} transcripts received`);
        console.log(`[AZURE] Session configured: ${this.isConfigured}, WebSocket state: ${this.azureWs.readyState}`);
      }
      
      this.azureWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64Audio
      }));
    } else {
      if (this.audioChunksProcessed % 100 === 0) {
        console.warn('[AZURE] ⚠️ Cannot send audio - WebSocket not open');
      }
    }
  }

  async sendToSupabase(speaker, text) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${SUPABASE_URL}/functions/v1/voice-transcript-receiver`);
      
      const postData = JSON.stringify({
        serverCallId: this.serverCallId,
        speaker: speaker,
        text: text,
        timestamp: new Date().toISOString()
      });

      console.log('[SUPABASE] Sending to:', url.toString());
      console.log('[SUPABASE] Speaker:', speaker);
      console.log('[SUPABASE] Text:', text.substring(0, 100) + (text.length > 100 ? '...' : ''));

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[SUPABASE] ✅ ${speaker} message sent successfully`);
            resolve(data);
          } else {
            console.error('[SUPABASE] ❌ Error:', res.statusCode, data);
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (err) => {
        console.error('[SUPABASE] ❌ Request failed:', err.message);
        reject(err);
      });

      req.write(postData);
      req.end();
    });
  }

  close() {
    console.log('[AZURE] Closing session');
    console.log(`[AZURE] Final stats: ${this.audioChunksProcessed} chunks, ${this.transcriptsReceived} transcripts, ${this.responsesReceived} responses`);
    if (this.azureWs) {
      this.azureWs.close();
    }
  }
}

wss.on('connection', async (ws, req) => {
  console.log('[MEDIA] ========================================');
  console.log('[MEDIA] New WebSocket connection from ACS');
  console.log('[MEDIA] URL:', req.url);
  console.log('[MEDIA] ========================================');
  
  // NEW: Extract user identity from query parameters
  const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const userIdentity = urlParams.get('user_identity') || null;
  console.log('[MEDIA] User identity to filter for:', userIdentity);
  
  let messageCount = 0;
  let serverCallId = null;
  let session = null;
  let userAudioCount = 0;
  let agentAudioCount = 0;
  
  ws.on('message', async (data) => {
    messageCount++;
    
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.kind === 'AudioMetadata') {
        console.log('[MEDIA] ========================================');
        console.log('[MEDIA] AudioMetadata received');
        console.log('[MEDIA] Full metadata:', JSON.stringify(msg.audioMetadata, null, 2));
        
        serverCallId = msg.audioMetadata?.callConnectionId || 
                       msg.audioMetadata?.subscriptionId || 
                       `call-${Date.now()}`;
        
        console.log('[MEDIA] ServerCallId:', serverCallId);
        console.log('[MEDIA] User identity filter:', userIdentity);
        console.log('[MEDIA] ========================================');
        
        session = new AzureRealtimeSession(serverCallId);
        try {
          await session.connect();
          console.log('[MEDIA] ✅ Azure session connected, waiting for audio...');
        } catch (err) {
          console.error('[MEDIA] ❌ Azure connection failed:', err.message);
        }
      }
      
      if (msg.kind === 'AudioData') {
        const audioData = msg.audioData;
        const participantId = audioData.participantRawID;
        
        // CRITICAL: Filter by participant FIRST (before any processing)
        if (userIdentity && participantId) {
          if (participantId !== userIdentity) {
            agentAudioCount++;
            // Log only every 100 skipped packets to avoid log spam
            if (agentAudioCount % 100 === 0) {
              console.log(`[MEDIA] Skipped ${agentAudioCount} agent audio packets (participant: ${participantId})`);
            }
            return; // Skip this packet entirely - it's from the agent
          }
        }
        
        // Only reaches here if it's user audio (or no filter configured)
        if (!audioData.silent && session?.isConnected) {
          userAudioCount++;
          
          if (userAudioCount % 100 === 0) {
            console.log(`[MEDIA] Processing user audio packet #${userAudioCount} (participant: ${participantId})`);
          }
          
          const audioBuffer = Buffer.from(audioData.data, 'base64');
          const int16Array = new Int16Array(
            audioBuffer.buffer, 
            audioBuffer.byteOffset, 
            audioBuffer.length / 2
          );
          const resampled24k = resample16kTo24k(int16Array);
          const base64Audio24k = int16ArrayToBase64(resampled24k);
          session.sendAudio(base64Audio24k);
        }
      }
      
      if (messageCount % 500 === 0) {
        console.log(`[MEDIA] Progress: ${messageCount} total messages, user audio: ${userAudioCount}, agent audio skipped: ${agentAudioCount}`);
      }
      
    } catch (err) {
      console.error('[MEDIA] ❌ Parse error:', err.message);
    }
  });
  
  ws.on('close', (code, reason) => {
    console.log('[MEDIA] ========================================');
    console.log(`[MEDIA] Connection closed. Code: ${code}`);
    console.log(`[MEDIA] Total messages: ${messageCount}`);
    console.log(`[MEDIA] User audio processed: ${userAudioCount}`);
    console.log(`[MEDIA] Agent audio skipped: ${agentAudioCount}`);
    console.log('[MEDIA] ========================================');
    if (session) session.close();
  });
  
  ws.on('error', (err) => {
    console.error('[MEDIA] ❌ Error:', err.message);
  });
});



server.listen(PORT, () => {
  console.log('========================================');
  console.log(`[SERVER] Running on port ${PORT}`);
  console.log('[MODE] Text-Only AI Suggestions (no audio output to caller)');
  console.log('========================================');
});
