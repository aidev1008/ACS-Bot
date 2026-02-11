// index.js - Azure Bot with Context Injection Support
const express = require("express");
const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const { URL } = require("url");
const crypto = require("crypto"); // ✅ ADDED ONLY

// Environment variables
const PORT = process.env.PORT || 8080;
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_OPENAI_DEPLOYMENT =
  process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-realtime";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TENANT_ID = process.env.TENANT_ID;

// ==============================================
// ENVIRONMENT VALIDATION
// ==============================================
if (!TENANT_ID) {
  console.warn("[STARTUP] ⚠️ TENANT_ID not set - using default tenant behavior");
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[FATAL] ❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY) {
  console.error("[FATAL] ❌ AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY are required.");
  process.exit(1);
}

console.log("[STARTUP] ✅ Environment validated");
if (TENANT_ID) {
  console.log("[STARTUP] TENANT_ID:", TENANT_ID);
}

// ==============================================
// ACTIVE SESSIONS MAP - Required for context injection
// ==============================================
const activeSessions = new Map();

// ==============================================
// FORMAT CONTEXT MESSAGE - Optimized for GPT Realtime
// ==============================================
function formatContextMessage(callState, is_complete, context_delta) {
  const lines = ["⚠️ MANDATORY CONTEXT UPDATE — FOLLOW THESE RULES EXACTLY:"];

  // ✅ USE ACCUMULATED collectedValues as PRIMARY source (merges all requests)
  const allCollectedValues = callState.collectedValues || {};
  const allCollectedKeys = Object.keys(allCollectedValues);

  if (allCollectedKeys.length > 0) {
    lines.push("");
    lines.push("✅ ALREADY COLLECTED (DO NOT ask for these again):");
    allCollectedKeys.forEach((key) => {
      const label = key
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`  • ${label}: ${allCollectedValues[key]}`);
    });
  }

  // Skip fields - EXCLUDE fields already shown in "ALREADY COLLECTED"
  const allSkip = [
    ...new Set([
      ...(callState.skipFields || []),
      ...(context_delta?.skip || []),
    ]),
  ].filter((key) => !allCollectedKeys.includes(key)); // ✅ Don't show collected fields twice

  if (allSkip.length > 0) {
    lines.push("");
    lines.push("🚫 SKIP ENTIRELY (customer declined or not applicable):");
    allSkip.forEach((key) => {
      const label = key
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`  • ${label}`);
    });
  }

  // Missing fields
  const missing = context_delta?.mf || callState.missingFields || [];
  if (missing.length > 0 && !is_complete) {
    lines.push("");
    lines.push("❓ STILL NEEDED (ask for these NEXT, one at a time):");
    missing.forEach((key) => {
      const label = key
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`  • ${label}`);
    });
  }

  // Status
  lines.push("");
  if (is_complete) {
    lines.push(
      "🟢 STATUS: COMPLETE — All information collected. Summarize and close the conversation. DO NOT ask any more questions.",
    );
  } else {
    lines.push(
      "🟡 STATUS: IN PROGRESS — Ask ONLY for ONE item from STILL NEEDED. Do NOT repeat any collected field.",
    );
  }

  lines.push("");
  lines.push(
    "🚨 ABSOLUTE RULE: If a field appears in ALREADY COLLECTED, you are FORBIDDEN from asking about it.",
  );
  lines.push(
    "The agent has ALREADY entered this in their CRM. Asking again wastes the customer's time.",
  );
  lines.push(
    "This context injection OVERRIDES everything else. Trust it completely.",
  );

  return lines.join("\n");
}

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media" });

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    activeSessions: activeSessions.size,
    timestamp: new Date().toISOString(),
  });
});

// ==============================================
// GET FULL CONVERSATION HISTORY - Never truncated
// ==============================================
app.get("/session/:media_streaming_id/history", (req, res) => {
  const { media_streaming_id } = req.params;
  const session = activeSessions.get(media_streaming_id);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json({
    media_streaming_id,
    totalExchanges: session.fullConversationHistory.length,
    collectedFields: session.callState.collectedFields,
    collectedValues: session.callState.collectedValues,
    skipFields: session.callState.skipFields,
    missingFields: session.callState.missingFields,
    isComplete: session.callState.isComplete,
    history: session.fullConversationHistory,
  });
});

// ==============================================
// INJECT-CONTEXT ENDPOINT - Prevents repeated questions
// ==============================================
app.post("/inject-context", async (req, res) => {
  const incomingCf = req.body.context_delta?.cf || {};
  const incomingSkip = req.body.context_delta?.skip || [];
  const incomingMf = req.body.context_delta?.mf || [];

  console.log("[HTTP] ========================================");
  console.log("[HTTP] Inject context request RECEIVED:");
  console.log("[HTTP] media_streaming_id:", req.body.media_streaming_id);
  console.log("[HTTP] is_complete:", req.body.is_complete);
  console.log("[HTTP] update_sequence:", req.body.update_sequence || "N/A");
  console.log(
    "[HTTP] INCOMING cf (collected fields):",
    JSON.stringify(incomingCf),
  );
  console.log("[HTTP] INCOMING skip:", incomingSkip);
  console.log("[HTTP] INCOMING mf (missing fields):", incomingMf);
  console.log("[HTTP] ========================================");

  const { media_streaming_id, formatted_message, is_complete, context_delta } =
    req.body;

  if (!media_streaming_id) {
    console.error("[INJECT] Missing media_streaming_id");
    return res.status(400).json({ error: "media_streaming_id is required" });
  }

  const session = activeSessions.get(media_streaming_id);

  if (!session) {
    console.warn("[INJECT] No active session found for:", media_streaming_id);
    console.warn(
      "[INJECT] Available sessions:",
      Array.from(activeSessions.keys()),
    );
    return res.status(404).json({ error: "Session not found" });
  }

  if (
    !session.isConnected ||
    !session.azureWs ||
    session.azureWs.readyState !== WebSocket.OPEN
  ) {
    console.warn("[INJECT] Session exists but Azure WS not ready yet");
    return res.status(425).json({ error: "Session initializing" });
  }

  // ✅ CONTEXT DEDUPLICATION
  const contextHash = crypto
    .createHash("sha1")
    .update(formatted_message)
    .digest("hex");

  if (session.lastContextHash === contextHash) {
    console.log("[INJECT] Duplicate context detected, skipping injection");
    return res.json({ skipped: true, reason: "Duplicate context" });
  }

  session.lastContextHash = contextHash;

  try {
    const itemId = `ctx_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // ✅ ACCUMULATE fields FIRST (before formatting message)
    // Trust incoming field names as canonical (no normalization needed)
    const incomingValues = context_delta?.cf || {};
    const newCollected = Object.keys(incomingValues);
    const newSkip = context_delta?.skip || [];
    const newMissing = context_delta?.mf || [];

    // Log BEFORE state (for debugging Agent UI issues)
    const beforeCount = Object.keys(session.callState.collectedValues).length;
    console.log(
      "[INJECT] BEFORE merge: ",
      beforeCount,
      "fields:",
      Object.keys(session.callState.collectedValues),
    );
    console.log(
      "[INJECT] INCOMING new: ",
      newCollected.length,
      "fields:",
      newCollected,
    );

    // Merge collected fields (deduplicated)
    session.callState.collectedFields = [
      ...new Set([
        ...session.callState.collectedFields,
        ...newCollected
      ]),
    ];

    // Store collected VALUES (merge, don't overwrite)
    session.callState.collectedValues = {
      ...session.callState.collectedValues,
      ...incomingValues,
    };

    // Merge skip fields (deduplicated)
    session.callState.skipFields = [
      ...new Set([
        ...session.callState.skipFields,
        ...newSkip
      ]),
    ];

    // Missing fields are always replaced (they shrink as fields get collected)
    session.callState.missingFields = newMissing;
    session.callState.isComplete = is_complete;

    // ✅ Build optimized message using ACCUMULATED state (not just current delta)
    const optimizedMessage = formatContextMessage(
      session.callState,
      is_complete,
      context_delta,
    );
    const finalMessage = optimizedMessage || formatted_message;

    const contextItem = {
      type: "conversation.item.create",
      item: {
        id: itemId,
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: finalMessage }],
      },
    };

    session.sendToAzure(contextItem, "Context injection (inject-context)");

    // ✅ DEBUG: Track context injection time
    session.lastContextInjectionTime = Date.now();
    console.log("[DEBUG] 🕐 Context injection at:", new Date().toISOString());

    // ✅ FIX: Mark that context has been received
    session.contextReceivedCount++;
    if (!session.contextReceived) {
      session.contextReceived = true;
      session.suppressResponsesUntilContext = false; // ✅ Allow responses now
      const timeSinceStart = Date.now() - session.sessionStartTime;
      console.log(
        "[DEBUG] 🎯 FIRST CONTEXT RECEIVED after",
        timeSinceStart,
        "ms since session start",
      );
      console.log(
        "[DEBUG] 🎯 Suppressed responses before context:",
        session.suppressedResponseCount,
      );
      
      // Delete the initial "waiting for context" message now that real context arrived
      const initContextIds = session.systemContextIds.filter(id => id.startsWith('ctx_init_'));
      initContextIds.forEach(id => {
        session.sendToAzure({ type: 'conversation.item.delete', item_id: id }, 'Delete initial context placeholder');
        console.log('[DEBUG] 🗑️ Deleted initial context placeholder:', id);
      });
      session.systemContextIds = session.systemContextIds.filter(id => !id.startsWith('ctx_init_'));
    }
    console.log(
      "[DEBUG] 📊 Total context injections received:",
      session.contextReceivedCount,
    );

    // ✅ FORCE MODEL TO RE-EVALUATE WITH NEW CONTEXT
    session.sendToAzure(
      { type: "response.cancel" },
      "Cancel response for re-evaluation",
    );

    // ✅ REPLACE old context items instead of stacking them
    const oldContextIds = session.systemContextIds.filter((id) =>
      id.startsWith("ctx_"),
    );
    if (oldContextIds.length > 2) {
      const toRemove = oldContextIds.slice(0, oldContextIds.length - 2);
      toRemove.forEach((id) => {
        session.sendToAzure(
          { type: "conversation.item.delete", item_id: id },
          "Delete stale context",
        );
      });
      session.systemContextIds = session.systemContextIds.filter(
        (id) => !toRemove.includes(id),
      );
    }

    session.systemContextIds.push(itemId);

    // Log AFTER merge (should NEVER have fewer fields than before)
    const afterCount = Object.keys(session.callState.collectedValues).length;
    console.log(
      "[INJECT] AFTER merge:  ",
      afterCount,
      "fields:",
      Object.keys(session.callState.collectedValues),
    );
    console.log(
      "[INJECT] VALUES SENT TO GPT:",
      JSON.stringify(session.callState.collectedValues),
    );

    if (afterCount < beforeCount) {
      console.error(
        "[INJECT] ⚠️ BUG: Lost fields during merge! Before:",
        beforeCount,
        "After:",
        afterCount,
      );
    }

    console.log("[INJECT] Cumulative state:", {
      collected: session.callState.collectedFields.length,
      skip: session.callState.skipFields.length,
      missing: session.callState.missingFields.length,
      complete: session.callState.isComplete,
    });

    res.json({ success: true, message: "Context injected", itemId });
  } catch (error) {
    console.error("[INJECT] Failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==============================================
// SESSION HANDLER CLASS
// ==============================================
class SessionHandler {
  constructor(acsWs, serverCallId) {
    this.acsWs = acsWs;
    this.azureWs = null;
    this.serverCallId = serverCallId;
    this.isConnected = false;
    this.currentResponseText = "";
    this.keepaliveInterval = null;
    this.transcriptsReceived = 0;
    this.responsesReceived = 0;
    this.systemContextIds = [];
    this.conversationItemIds = [];
    this.lastContextHash = null;
    this.callState = {
      collectedFields: [],
      collectedValues: {},
      skipFields: [],
      missingFields: [],
      isComplete: false,
    };
    this.audioChunksSent = 0;

    // ✅ FULL CONVERSATION HISTORY - Never truncated, stored locally
    this.fullConversationHistory = [];

    // ✅ DEBUG: Timing tracking
    this.lastContextInjectionTime = null;
    this.lastResponseTime = null;
    this.pendingResponseStartTime = null;

    // ✅ FIX: Context synchronization - prevent responses before context arrives
    this.contextReceived = false; // Has at least one context injection been received?
    this.contextReceivedCount = 0; // How many context injections received?
    this.sessionStartTime = Date.now();
    this.suppressResponsesUntilContext = true; // ✅ Suppress early responses until context
    this.suppressedResponseCount = 0; // Track how many were suppressed
    
    // ✅ Wait for actual customer speech before responding
    this.customerHasSpoken = false; // Has customer actually said something?
    this.lastTranscriptTime = null; // When did we last get a transcript?
    
    // ✅ DB-driven prompts (fetched at session start)
    this.systemPrompt = null;
    this.initialContextMessage = null;
    
    // ✅ FIX: Buffer audio until session.update is confirmed
    this.configApplied = false;
    this.audioBuffer = [];
  }

  // ✅ Fetch prompts from database at session startup
  async fetchPrompts() {
    try {
      console.log("[PROMPTS] Fetching session prompts from database...");
      
      const response = await fetch(`${SUPABASE_URL}/functions/v1/get-session-prompts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ tenant_id: TENANT_ID }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error("[PROMPTS] ❌ Failed to fetch prompts:", response.status, errorBody);
        // Use minimal fallback prompts and defaults
        this.systemPrompt = "You are a helpful call center assistant. Listen to the customer and provide appropriate guidance to the agent.";
        this.initialContextMessage = "Please wait while context loads. Use generic welcoming responses until you receive a context update.";
        this.maxResponseTokens = 60;
        this.promptTemperature = 0.5;
        return;
      }

      const data = await response.json();
      this.systemPrompt = data.system_prompt || "You are a helpful call center assistant.";
      this.initialContextMessage = data.initial_context_message || "Please wait while context loads.";
      this.maxResponseTokens = data.max_response_tokens || 60;
      this.promptTemperature = data.temperature || 0.5;
      
      console.log("[PROMPTS] ✅ Session prompts loaded from database");
      console.log("[PROMPTS] System prompt length:", this.systemPrompt.length, "chars");
      console.log("[PROMPTS] Max response tokens:", this.maxResponseTokens);
      console.log("[PROMPTS] Temperature:", this.promptTemperature);
    } catch (err) {
      console.error("[PROMPTS] ❌ Error fetching prompts:", err.message);
      // Use minimal fallback prompts and defaults
      this.systemPrompt = "You are a helpful call center assistant. Listen to the customer and provide appropriate guidance to the agent.";
      this.initialContextMessage = "Please wait while context loads. Use generic welcoming responses until you receive a context update.";
      this.maxResponseTokens = 60;
      this.promptTemperature = 0.5;
    }
  }

  // ✅ CENTRALIZED LOGGER: Tracks everything sent to Azure OpenAI Realtime
  sendToAzure(payload, label) {
    if (!this.azureWs || this.azureWs.readyState !== WebSocket.OPEN) {
      console.warn(
        "[SEND→GPT] ⚠️ Cannot send, WebSocket not open. Label:",
        label,
      );
      return false;
    }

    const json =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    const type = typeof payload === "object" ? payload.type : "raw";

    // Suppress audio chunk logging (too noisy), log count periodically
    if (type === "input_audio_buffer.append") {
      this.audioChunksSent++;
      if (this.audioChunksSent % 200 === 0) {
        console.log(`[SEND→GPT] 🎤 Audio chunks sent: ${this.audioChunksSent}`);
      }
      this.azureWs.send(json);
      return true;
    }

    // Log all non-audio messages
    console.log("[SEND→GPT] ========================================");
    console.log(`[SEND→GPT] 📤 Type: ${type}`);
    console.log(`[SEND→GPT] 📋 Label: ${label || "none"}`);

    if (type === "session.update") {
      console.log("[SEND→GPT] Modalities:", payload.session?.modalities);
      console.log(
        "[SEND→GPT] Instructions length:",
        payload.session?.instructions?.length,
        "chars",
      );
      console.log(
        "[SEND→GPT] VAD silence_duration_ms:",
        payload.session?.turn_detection?.silence_duration_ms,
      );
    } else if (type === "conversation.item.create") {
      console.log("[SEND→GPT] Item ID:", payload.item?.id);
      console.log("[SEND→GPT] Role:", payload.item?.role);
      const text = payload.item?.content?.[0]?.text || "";
      // ✅ For context injections, show FULL message to verify all fields
      if (payload.item?.id?.startsWith("ctx_")) {
        console.log("[SEND→GPT] 📋 FULL CONTEXT MESSAGE:");
        console.log(text);
      } else {
        console.log(
          "[SEND→GPT] Content preview:",
          text.substring(0, 200) + (text.length > 200 ? "..." : ""),
        );
      }
      console.log("[SEND→GPT] Content length:", text.length, "chars");
    } else if (type === "conversation.item.delete") {
      console.log("[SEND→GPT] Deleting item_id:", payload.item_id);
    } else if (type === "response.cancel") {
      console.log("[SEND→GPT] ⛔ Cancelling current response");
    } else {
      console.log("[SEND→GPT] Payload:", json.substring(0, 300));
    }

    console.log("[SEND→GPT] ========================================");
    this.azureWs.send(json);
    return true;
  }

  connectToAzureOpenAI() {
    const wsUrl = AZURE_OPENAI_ENDPOINT.replace("https://", "wss://");

    console.log("[AZURE] ========================================");
    console.log("[AZURE] Connecting to Azure OpenAI Realtime API");
    console.log("[AZURE] URL:", wsUrl);
    console.log("[AZURE] ========================================");

    this.azureWs = new WebSocket(wsUrl, {
      headers: { "api-key": AZURE_OPENAI_API_KEY },
    });

    this.azureWs.on("open", () => {
      console.log("[AZURE] ✅ WebSocket OPEN - Connection established");
      this.isConnected = true;

      // ✅ REGISTER SESSION ONLY AFTER AZURE IS READY
      activeSessions.set(this.serverCallId, this);
      console.log(
        "[ACS] ✅ Session registered AFTER Azure connect:",
        this.serverCallId,
      );
      console.log("[ACS] Total active sessions:", activeSessions.size);

      this.keepaliveInterval = setInterval(() => {
        if (this.azureWs.readyState === WebSocket.OPEN) {
          this.azureWs.ping();
          console.log("[AZURE] 💓 Keepalive ping sent");
        }
      }, 30000);
    });

    this.azureWs.on("pong", () => {
      console.log("[AZURE] 💓 Keepalive pong received");
    });

    this.azureWs.on("message", (data) => {
      this.handleAzureMessage(JSON.parse(data.toString()));
    });

    this.azureWs.on("close", (code, reason) => {
      console.log(`[AZURE] WebSocket CLOSED. Code: ${code}, Reason: ${reason}`);
      this.isConnected = false;
      if (this.keepaliveInterval) clearInterval(this.keepaliveInterval);
    });
  }
   async handleAzureMessage(msg) {
    switch (msg.type) {
      case "session.created":
        console.log("[AZURE] ✅ session.created received");
        // ✅ FIX: Fetch prompts from DB, then send config IMMEDIATELY (no delay)
        console.log("[AZURE] ⏳ Fetching prompts then sending config immediately...");
        this.fetchPrompts()
          .catch(err => {
            console.error("[PROMPTS] Failed, using fallback:", err.message);
          })
          .finally(() => {
            this.sendConfig();
          });
        break;

      case "session.updated":
        console.log("[AZURE] ✅ session.updated - Configuration applied");
        // ✅ FIX: Now safe to process audio - flush buffered chunks
        this.configApplied = true;
        if (this.audioBuffer.length > 0) {
          console.log(`[AZURE] 📤 Flushing ${this.audioBuffer.length} buffered audio chunks`);
          this.audioBuffer.forEach(audioData => {
            this.sendToAzure(
              { type: "input_audio_buffer.append", audio: audioData },
              "Buffered audio chunk"
            );
          });
          this.audioBuffer = [];
        }
        
        // ✅ FIX: Send initial context ONLY after session.updated is confirmed
        this.sendInitialContext();
        break;

      case "conversation.item.created":
        if (msg.item?.id) {
          this.conversationItemIds.push(msg.item.id);
          console.log(
            "[AZURE] 📦 Tracking conversation item:",
            msg.item.id,
            "role:",
            msg.item?.role,
            "total:",
            this.conversationItemIds.length,
          );
        }
        break;

        case "conversation.item.input_audio_transcription.completed":
          this.transcriptsReceived++;
          this.customerHasSpoken = true;
          this.lastTranscriptTime = Date.now();

          console.log("[AZURE] 📝 TRANSCRIPTION COMPLETED #" + this.transcriptsReceived);
          console.log("[AZURE] Transcript:", msg.transcript);

          if (msg.transcript && msg.transcript.trim()) {
            const customerText = msg.transcript.trim();

            // Store full history
            this.fullConversationHistory.push({
              role: "customer",
              text: customerText,
              timestamp: new Date().toISOString(),
              itemId: msg.item_id,
            });

            // Persist transcript (non-blocking)
            this.sendToSupabase("customer", customerText)
              .catch(err => console.error("[SUPABASE] ❌ Failed:", err.message));

            // ✅ Build last 3–5 turns for semantic extraction
            const lastFewTurns = this.fullConversationHistory
              .slice(-5)
              .map(({ role, text }) => ({ role, text }));

            // ✅ CRITICAL: synchronous gate
            const fastContextResponse = await fetch(`${SUPABASE_URL}/functions/v1/fast-context-inject`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
              },
              body: JSON.stringify({
                transcript: customerText,
                conversation_history: lastFewTurns,
                media_streaming_id: this.serverCallId,
                tenant_id: TENANT_ID,
              }),
            });

            if (!fastContextResponse.ok) {
              const errorBody = await fastContextResponse.text();
              console.error("[FAST-CONTEXT] ❌ Extraction failed:", fastContextResponse.status, errorBody);
            } else {
              console.log("[FAST-CONTEXT] ✅ Extraction + context injection completed");
            }
          }
          break;

      case "response.text.delta":
        if (msg.delta) {
          // Track when response actually starts
          if (!this.pendingResponseStartTime) {
            this.pendingResponseStartTime = Date.now();
            console.log(
              "[DEBUG] 🕐 Response generation STARTED at:",
              new Date().toISOString(),
            );
          }
          this.currentResponseText += msg.delta;
        }
        break;

      case "response.text.done":
        this.responsesReceived++;
        this.lastResponseTime = Date.now();

        console.log(
          "[AZURE] 🤖 TEXT RESPONSE COMPLETE #" + this.responsesReceived,
        );
        console.log("[AZURE] Full text:", this.currentResponseText);

        // ✅ FIX: Suppress response if no context has been received yet
        if (this.suppressResponsesUntilContext && !this.contextReceived) {
          this.suppressedResponseCount++;
          console.log("[DEBUG] ⛔ RESPONSE SUPPRESSED - waiting for context");
          console.log("[DEBUG] Suppressed responses so far:", this.suppressedResponseCount);
          console.log("[DEBUG] Time since session start:", Date.now() - this.sessionStartTime, "ms");
          
          // Don't send this response to Supabase - it's likely to ask wrong questions
          // Reset and wait for context to arrive
          this.currentResponseText = "";
          this.pendingResponseStartTime = null;
          
          // After 10 seconds, stop suppressing (failsafe)
          if (Date.now() - this.sessionStartTime > 10000) {
            console.log("[DEBUG] ⚠️ Context timeout - stopping suppression");
            this.suppressResponsesUntilContext = false;
          }
          break;
        }
        
        // ✅ NEW: Suppress response if customer hasn't actually spoken yet
        if (!this.customerHasSpoken) {
          this.suppressedResponseCount++;
          console.log("[DEBUG] ⛔ RESPONSE SUPPRESSED - customer hasn't spoken yet");
          console.log("[DEBUG] This was likely triggered by noise/silence");
          this.currentResponseText = "";
          this.pendingResponseStartTime = null;
          break;
        }

        // ✅ DEBUG: Timing analysis
        console.log("[DEBUG] ========================================");
        console.log("[DEBUG] 🕐 TIMING ANALYSIS:");
        console.log(
          "[DEBUG] Response started:",
          this.pendingResponseStartTime
            ? new Date(this.pendingResponseStartTime).toISOString()
            : "N/A",
        );
        console.log(
          "[DEBUG] Response completed:",
          new Date(this.lastResponseTime).toISOString(),
        );
        console.log(
          "[DEBUG] Last context injection:",
          this.lastContextInjectionTime
            ? new Date(this.lastContextInjectionTime).toISOString()
            : "NONE",
        );

        // ✅ FIX: Check if context was received before this response
        console.log("[DEBUG] 🎯 CONTEXT STATUS:");
        console.log(
          "[DEBUG] Context ever received:",
          this.contextReceived ? "YES" : "NO",
        );
        console.log(
          "[DEBUG] Total context injections:",
          this.contextReceivedCount,
        );
        if (!this.contextReceived) {
          console.log(
            "[DEBUG] ⚠️ WARNING: Response generated WITHOUT any context injection!",
          );
          console.log(
            "[DEBUG] ⚠️ This response may ask for already-collected fields!",
          );
        }

        if (this.lastContextInjectionTime && this.pendingResponseStartTime) {
          const timeDiff =
            this.pendingResponseStartTime - this.lastContextInjectionTime;
          if (timeDiff < 0) {
            console.log(
              "[DEBUG] ⚠️ TIMING ISSUE: Response started",
              Math.abs(timeDiff),
              "ms BEFORE context injection!",
            );
          } else {
            console.log(
              "[DEBUG] ✅ Context was injected",
              timeDiff,
              "ms before response started",
            );
          }
        }

        // ✅ DEBUG: Context item count
        console.log("[DEBUG] 📊 CONTEXT ITEMS:");
        console.log(
          "[DEBUG] Total conversation items:",
          this.conversationItemIds.length,
        );
        console.log(
          "[DEBUG] System context items:",
          this.systemContextIds.length,
        );
        const ctxItems = this.systemContextIds.filter((id) =>
          id.startsWith("ctx_"),
        ).length;
        const summaryItems = this.systemContextIds.filter((id) =>
          id.startsWith("summary_"),
        ).length;
        console.log("[DEBUG] Context injections (ctx_):", ctxItems);
        console.log("[DEBUG] Summary items (summary_):", summaryItems);
        if (ctxItems > 3) {
          console.log(
            "[DEBUG] ⚠️ TOO MANY CONTEXT ITEMS - may confuse the model!",
          );
        }
        console.log("[DEBUG] ========================================");

        // Reset timing tracker
        this.pendingResponseStartTime = null;

        if (this.currentResponseText && this.currentResponseText.trim()) {
          const suggestionText = this.currentResponseText.trim();

          // ✅ Store in full history (never truncated)
          this.fullConversationHistory.push({
            role: "assistant",
            text: suggestionText,
            timestamp: new Date().toISOString(),
          });

          this.sendToSupabase("suggestion", suggestionText)
            .then(() => console.log("[SUPABASE] ✅ AI suggestion sent"))
            .catch((err) =>
              console.error("[SUPABASE] ❌ Failed to send:", err.message),
            );
        }

        this.currentResponseText = "";
        this.truncateConversationHistory();
        break;

      default:
        // ✅ FIX: Surface Azure errors and unhandled message types
        if (msg.type === "error") {
          console.error("[AZURE] ❌ ERROR from Azure OpenAI:", JSON.stringify(msg));
        } else if (msg.type && !msg.type.startsWith("input_audio_buffer")) {
          console.log("[AZURE] 📨 Unhandled message type:", msg.type);
        }
        break;
    }
  }

  sendConfig() {
    console.log("[AZURE] 📤 SENDING SESSION CONFIGURATION");

    const config = {
      type: "session.update",
      session: {
        modalities: ["text"],
        instructions: this.systemPrompt,
        input_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
        },
        temperature: this.promptTemperature >= 0.6 ? this.promptTemperature : 0.6,
        max_response_output_tokens: this.maxResponseTokens || 60,
      },
    };

    console.log("[AZURE] Using DB config - temperature:", config.session.temperature, "max_tokens:", config.session.max_response_output_tokens);

    // ✅ FIX: Send ONLY session.update - no other messages until session.updated is received
    this.sendToAzure(config, "Session configuration");
  }

  // ✅ FIX: Initial context sent ONLY after session.updated confirms config
  sendInitialContext() {
    const initialContextId = `ctx_init_${Date.now()}`;
    const initialContextText = this.initialContextMessage || `⏳ CONTEXT LOADING:
The agent's CRM form is currently loading customer data. You will receive a context update shortly with the exact fields already collected.

UNTIL YOU RECEIVE THAT UPDATE:
- Use only generic, welcoming responses
- Do not ask for specific information yet
- Simply acknowledge the customer and let them know you're ready to help

WAIT for the context update before asking any specific questions.`;
    
    const initialContext = {
      type: "conversation.item.create",
      item: {
        id: initialContextId,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: initialContextText,
          },
        ],
      },
    };

    this.sendToAzure(
      initialContext,
      "Initial context guidance (wait for CRM data)",
    );
    this.systemContextIds.push(initialContextId);
    console.log(
      "[AZURE] 📋 Sent initial context guidance - GPT will wait for real context",
    );
  }

  // DEPRECATED: Fallback only - prompts are fetched from DB via fetchPrompts()
  getSystemPrompt() {
    return `🚨 CRITICAL LANGUAGE RULE - HIGHEST PRIORITY 🚨
YOU MUST ALWAYS RESPOND IN ENGLISH ONLY.
You are whispering suggestions into a call center agent's ear during a live call.

OUTPUT RULES:
- Output ONLY what the agent should SAY to the customer
- ONE short sentence maximum
- Ask for EXACTLY ONE piece of information at a time
- Use simple, direct language

CONTEXT INJECTION RULES (HIGHEST PRIORITY):
You will receive system messages with "MANDATORY CONTEXT UPDATE".
These are ALWAYS more authoritative than your training data.

- ALREADY COLLECTED = NEVER ask again
- STILL NEEDED = Ask for the FIRST item only
- NEXT = This is the EXACT field to ask about NOW

QUESTION FORMAT:
When STILL NEEDED has fields, ask a SHORT DIRECT question for NEXT.

GOOD examples:
  NEXT: Full Name       -> "May I have your full name please?"
  NEXT: SA ID Number    -> "Could you please provide your 5-digit ID number?"
  NEXT: Investment Goal -> "What is the main goal for your investment?"
  NEXT: Time Horizon    -> "How long are you looking to invest for?"
  NEXT: Risk Appetite   -> "Would you describe your risk appetite as low, medium, or high?"

BAD examples (NEVER do this):
  "Tell me a bit about yourself and what you're looking to achieve with this investment."
  "I'd like to understand your full financial picture including your goals, timeline, and risk tolerance."

When STATUS: COMPLETE, summarize and close. Do NOT ask more questions.
`;
  }

    truncateConversationHistory() {
    if (!this.azureWs || this.azureWs.readyState !== WebSocket.OPEN) return;

    const maxItems = 1000; // ✅ INCREASED from 6 to retain more conversation context
    const deletable = this.conversationItemIds.filter(
      (id) => !this.systemContextIds.includes(id),
    );

    if (deletable.length > maxItems) {
      const toDelete = deletable.slice(0, deletable.length - maxItems);

      // ✅ SUMMARIZE before deleting so context is never fully lost
      this.injectConversationSummary(toDelete.length);

      toDelete.forEach((id) => {
        this.sendToAzure(
          { type: "conversation.item.delete", item_id: id },
          "Truncate old conversation item",
        );
      });

      this.conversationItemIds = this.conversationItemIds.filter(
        (id) => !toDelete.includes(id),
      );
    }
  }

  // ✅ NEW: Inject a summary reminder so the model doesn't forget prior context
  injectConversationSummary(deletedCount) {
    if (!this.azureWs || this.azureWs.readyState !== WebSocket.OPEN) return;

    // ✅ Reuse the same formatting for consistency - now includes stored values
    const contextBody = formatContextMessage(
      this.callState,
      this.callState.isComplete,
      {
        cf: this.callState.collectedValues || {}, // ✅ Include stored values for full recall
        skip: this.callState.skipFields,
        mf: this.callState.missingFields,
      },
    );

    if (!contextBody) return;

    const summaryText =
      `[CONVERSATION MEMORY REFRESH - ${deletedCount} older exchanges were condensed]\n` +
      contextBody +
      "\nContinue from where the conversation left off.";

    const summaryId = `summary_${Date.now()}`;
    const summaryItem = {
      type: "conversation.item.create",
      item: {
        id: summaryId,
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: summaryText }],
      },
    };

    this.sendToAzure(summaryItem, "Conversation memory refresh summary");
    this.systemContextIds.push(summaryId);

    // ✅ Clean up old summaries (keep only the latest 2)
    const summaryIds = this.systemContextIds.filter((id) =>
      id.startsWith("summary_"),
    );
    if (summaryIds.length > 2) {
      const oldSummaries = summaryIds.slice(0, summaryIds.length - 2);
      oldSummaries.forEach((id) => {
        this.sendToAzure(
          { type: "conversation.item.delete", item_id: id },
          "Delete old summary",
        );
      });
      this.systemContextIds = this.systemContextIds.filter(
        (id) => !oldSummaries.includes(id),
      );
    }
  }

  async sendToSupabase(speaker, text) {
    return new Promise((resolve, reject) => {
      const url = new URL(
        `${SUPABASE_URL}/functions/v1/voice-transcript-receiver`,
      );

      const postData = JSON.stringify({
        serverCallId: this.serverCallId,
        speaker: speaker,
        text: text,
        timestamp: new Date().toISOString(),
      });

      console.log("[SUPABASE] Sending to:", url.toString());
      console.log("[SUPABASE] Speaker:", speaker);
      console.log(
        "[SUPABASE] Text:",
        text.substring(0, 100) + (text.length > 100 ? "..." : ""),
      );

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Length": Buffer.byteLength(postData),
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[SUPABASE] ✅ ${speaker} message sent successfully`);
            resolve(data);
          } else {
            console.error("[SUPABASE] ❌ Error:", res.statusCode, data);
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", (err) => {
        console.error("[SUPABASE] ❌ Request failed:", err.message);
        reject(err);
      });

      req.write(postData);
      req.end();
    });
  }

  handleACSAudio(audioData) {
    if (!this.azureWs || this.azureWs.readyState !== WebSocket.OPEN) {
      return;
    }

    // ✅ FIX: Buffer audio until session.update is confirmed
    if (!this.configApplied) {
      this.audioBuffer.push(audioData);
      if (this.audioBuffer.length % 100 === 0) {
        console.log(`[AUDIO] 📦 Buffering audio chunks: ${this.audioBuffer.length} (waiting for config)`);
      }
      return;
    }

    // Config applied - send audio directly
    this.sendToAzure(
      {
        type: "input_audio_buffer.append",
        audio: audioData,
      },
      "ACS audio chunk",
    );
  }

  cleanup() {
    console.log("[SESSION] Cleaning up session:", this.serverCallId);
    if (this.azureWs) this.azureWs.close();
    activeSessions.delete(this.serverCallId);
    console.log("[SESSION] Removed from active sessions");
  }
}

// ==============================================
// WEBSOCKET CONNECTION HANDLER
// ==============================================
wss.on("connection", (ws) => {
  let session = null;
  let serverCallId = null;

  ws.on("message", (message) => {
    const data = JSON.parse(message.toString());

    if (data.kind === "AudioMetadata") {
      // Use subscriptionId (media_streaming_id) as the session key
      const subscriptionId = data.audioMetadata.subscriptionId;
      const rawServerCallId = data.audioMetadata.serverCallId;

      // Prefer subscriptionId for channel alignment with Agent UI
      const sessionKey = subscriptionId || rawServerCallId;
      
      // ✅ FIX: Assign to outer variable so ws.on("close") can access it
      serverCallId = sessionKey;

      console.log("[ACS] AudioMetadata received");
      console.log("[ACS] subscriptionId (media_streaming_id):", subscriptionId);
      console.log("[ACS] serverCallId:", rawServerCallId);
      console.log("[ACS] Using session key:", sessionKey);

      session = new SessionHandler(ws, sessionKey);
      session.connectToAzureOpenAI();
    }

    if (data.kind === "AudioData" && session) {
      session.handleACSAudio(data.audioData.data);
    }
  });

  ws.on("close", () => {
    console.log("[ACS] Media streaming connection closed");
    if (session && serverCallId) {
      console.log(
        "[SESSION] Call ended, starting 30s grace period:",
        serverCallId,
      );
      setTimeout(() => session.cleanup(), 30000); // ✅ INCREASED
    }
  });
});

// ==============================================
// START SERVER
// ==============================================
server.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`Azure Bot Server started on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/media`);
  console.log(
    `Context injection: POST http://localhost:${PORT}/inject-context`,
  );
  console.log("=".repeat(50));
});
