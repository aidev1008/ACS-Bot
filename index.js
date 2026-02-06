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

// ==============================================
// ACTIVE SESSIONS MAP - Required for context injection
// ==============================================
const activeSessions = new Map();

// ==============================================
// FIELD NAME NORMALIZATION - Ensures consistent field tracking
// ==============================================
const FIELD_NAME_MAP = {
  'name': 'Full Name',
  'full_name': 'Full Name',
  'customer_name': 'Full Name',
  'investment_goal': 'Investment Goal',
  'goal': 'Investment Goal',
  'time_horizon': 'Time Horizon',
  'horizon': 'Time Horizon',
  'risk_appetite': 'Risk Appetite',
  'risk': 'Risk Appetite',
  'contribution_amount': 'Contribution Amount',
  'amount': 'Contribution Amount',
  'contribution_preference': 'Contribution Preference',
  'preference': 'Contribution Preference',
  'sa_id_number': 'SA ID Number',
  'id_number': 'SA ID Number',
  'id': 'SA ID Number',
};

function normalizeFieldName(fieldName) {
  if (!fieldName) return fieldName;
  const key = fieldName.toLowerCase().replace(/\s+/g, '_');
  return FIELD_NAME_MAP[key] || fieldName;
}

function normalizeFieldValues(values) {
  const normalized = {};
  for (const [key, value] of Object.entries(values)) {
    const normalizedKey = normalizeFieldName(key);
    // Prefer existing value if already set (don't overwrite with duplicate)
    if (!normalized[normalizedKey]) {
      normalized[normalizedKey] = value;
    }
  }
  return normalized;
}

function normalizeFieldList(fields) {
  const normalized = new Set();
  for (const field of fields) {
    normalized.add(normalizeFieldName(field));
  }
  return Array.from(normalized);
}

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
    // Normalize incoming field names for consistent tracking
    const incomingValues = context_delta?.cf || {};
    const normalizedIncomingValues = normalizeFieldValues(incomingValues);
    const newCollected = Object.keys(normalizedIncomingValues);
    const newSkip = normalizeFieldList(context_delta?.skip || []);
    const newMissing = normalizeFieldList(context_delta?.mf || []);

    // Log BEFORE state (for debugging Agent UI issues)
    const beforeCount = Object.keys(session.callState.collectedValues).length;
    console.log(
      "[INJECT] BEFORE merge: ",
      beforeCount,
      "fields:",
      Object.keys(session.callState.collectedValues),
    );
    console.log(
      "[INJECT] INCOMING new (normalized): ",
      newCollected.length,
      "fields:",
      newCollected,
    );

    // Merge collected fields (deduplicated, normalized)
    session.callState.collectedFields = [
      ...new Set([
        ...normalizeFieldList(session.callState.collectedFields),
        ...newCollected
      ]),
    ];

    // Store collected VALUES (merge, don't overwrite, normalized keys)
    session.callState.collectedValues = {
      ...session.callState.collectedValues,
      ...normalizedIncomingValues,
    };

    // Merge skip fields (deduplicated, normalized)
    session.callState.skipFields = [
      ...new Set([
        ...normalizeFieldList(session.callState.skipFields),
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
  }

  // ✅ Field name aliases - ensures both variations are checked
  static FIELD_ALIASES = {
    'name': ['full name', 'customer name', 'full_name'],
    'full name': ['name', 'customer name', 'full_name'],
    'full_name': ['name', 'full name', 'customer name'],
    'investment goal': ['investment_goal', 'goal'],
    'investment_goal': ['investment goal', 'goal'],
    'time horizon': ['time_horizon', 'horizon', 'term'],
    'time_horizon': ['time horizon', 'horizon', 'term'],
    'risk appetite': ['risk_appetite', 'risk', 'appetite'],
    'risk_appetite': ['risk appetite', 'risk', 'appetite'],
    'contribution amount': ['contribution_amount', 'amount'],
    'contribution_amount': ['contribution amount', 'amount'],
    'contribution preference': ['contribution_preference', 'preference', 'debit order', 'lump sum'],
    'contribution_preference': ['contribution preference', 'preference'],
    'sa id number': ['sa_id_number', 'id number', 'id', 'identity'],
    'sa_id_number': ['sa id number', 'id number', 'id'],
  };

  // ✅ Get all variations of a field name for comprehensive checking
  getFieldVariations(field) {
    const fieldLower = field.toLowerCase();
    const variations = new Set([fieldLower, fieldLower.replace(/_/g, ' '), fieldLower.replace(/\s+/g, '_')]);
    
    // Add aliases
    const aliases = SessionHandler.FIELD_ALIASES[fieldLower];
    if (aliases) {
      aliases.forEach(alias => variations.add(alias.toLowerCase()));
    }
    
    return Array.from(variations);
  }

  // ✅ DEBUG: Check if AI violated context rules (asked about collected field)
  checkContextViolation(responseText) {
    const collectedKeys = Object.keys(this.callState.collectedValues);
    const skipFields = this.callState.skipFields || [];
    
    // Combine collected and skip fields for comprehensive checking
    const allProtectedFields = [...new Set([...collectedKeys, ...skipFields])];
    if (allProtectedFields.length === 0) return null;

    const responseLower = responseText.toLowerCase();
    const violations = [];

    // Common question patterns
    const questionPatterns = [
      "what is your",
      "what's your",
      "may i have your",
      "can you provide",
      "could you tell me",
      "please provide",
      "confirm your",
      "share your",
      "could i get your",
      "can i have your",
      "tell me your",
    ];

    allProtectedFields.forEach((field) => {
      // Get all variations of this field name
      const variations = this.getFieldVariations(field);
      
      variations.forEach(variation => {
        const fieldWords = variation.split(/[\s_]+/);
        
        // Check if response asks about this field
        questionPatterns.forEach((pattern) => {
          if (responseLower.includes(pattern)) {
            fieldWords.forEach((word) => {
              if (word.length > 2 && responseLower.includes(word)) {
                violations.push({ field, variation, pattern, word });
              }
            });
          }
        });
      });
    });

    // Deduplicate violations by field
    const uniqueViolations = [];
    const seenFields = new Set();
    violations.forEach(v => {
      if (!seenFields.has(v.field)) {
        seenFields.add(v.field);
        uniqueViolations.push(v);
      }
    });

    return uniqueViolations.length > 0 ? uniqueViolations : null;
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
  handleAzureMessage(msg) {
    switch (msg.type) {
      case "session.created":
        console.log("[AZURE] ✅ session.created received");
        // ✅ FIX: Increased delay from 1000ms to 2500ms to allow context injection to arrive first
        console.log(
          "[AZURE] ⏳ Waiting 2500ms before sending config (allow context injection to arrive)...",
        );
        setTimeout(() => {
          this.sendConfig();
        }, 2500);
        break;

      case "session.updated":
        console.log("[AZURE] ✅ session.updated - Configuration applied");
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
        this.customerHasSpoken = true; // ✅ NEW: Mark that customer has spoken
        this.lastTranscriptTime = Date.now();
        console.log(
          "[AZURE] 📝 TRANSCRIPTION COMPLETED #" + this.transcriptsReceived,
        );
        console.log("[AZURE] Transcript:", msg.transcript);

        if (msg.transcript && msg.transcript.trim()) {
          const customerText = msg.transcript.trim();

          // ✅ Store in full history (never truncated)
          this.fullConversationHistory.push({
            role: "customer",
            text: customerText,
            timestamp: new Date().toISOString(),
            itemId: msg.item_id,
          });
          console.log(
            "[HISTORY] 📚 Total exchanges:",
            this.fullConversationHistory.length,
          );

          this.sendToSupabase("customer", customerText)
            .then(() => console.log("[SUPABASE] ✅ Customer transcript sent"))
            .catch((err) =>
              console.error("[SUPABASE] ❌ Failed to send:", err.message),
            );
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

        // ✅ DEBUG: Check for context violations
        console.log("[DEBUG] 🔍 CONTEXT VIOLATION CHECK:");
        console.log(
          "[DEBUG] Collected fields:",
          Object.keys(this.callState.collectedValues),
        );

        const violations = this.checkContextViolation(this.currentResponseText);
        if (violations) {
          console.log("[DEBUG] ❌ POTENTIAL VIOLATION DETECTED!");
          violations.forEach((v) => {
            console.log(
              `[DEBUG] ❌ AI may have asked about "${v.field}" (matched: "${v.word}" in "${v.pattern}")`,
            );
          });
        } else {
          console.log("[DEBUG] ✅ No obvious violations detected");
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
    }
  }

  sendConfig() {
    console.log("[AZURE] 📤 SENDING SESSION CONFIGURATION");

    const config = {
      type: "session.update",
      session: {
        modalities: ["text"],
        instructions: this.getSystemPrompt(),
        input_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800, // ✅ INCREASED from 500ms to reduce turn fragmentation
        },
        temperature: 0.7,
        max_response_output_tokens: 150,
      },
    };

    this.sendToAzure(config, "Session configuration");

    // ✅ FIX: Send initial context guidance - prevents asking for fields before context arrives
    const initialContextId = `ctx_init_${Date.now()}`;
    const initialContext = {
      type: "conversation.item.create",
      item: {
        id: initialContextId,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `⏳ CONTEXT LOADING - IMPORTANT INSTRUCTIONS:
            The agent's CRM form is currently loading customer data. You will receive a "⚠️ MANDATORY CONTEXT UPDATE" message shortly with the EXACT fields already collected.

            UNTIL YOU RECEIVE THAT UPDATE:
            1. Use ONLY generic, welcoming responses
            2. DO NOT ask for specific information like name, ID, investment goals, etc.
            3. Simply acknowledge the customer and let them know you're ready to help
            4. Example: "Thank you for calling STANLIB, I'm here to assist you."

            WAIT for the context update before asking any specific questions.
            The context update will tell you EXACTLY which fields are already collected and which are still needed.`,
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

  getSystemPrompt() {
    return `You are whispering suggestions into a call center agent’s ear during a live STANLIB call.

Your role is to guide the agent through the COMPLETE STANLIB INVESTMENT SALES PROCESS while the call is ongoing.

========================
STRICT OUTPUT RULES
========================
- Output ONLY what the agent should SAY next
- Default: ONE sentence maximum
- Exception: When listing documents, requirements, or steps → include ALL required items in natural speech
- NO analysis
- NO explanations
- NO labels
- NO brackets
- English only
- Write exactly as the agent should speak to the customer
- Never mention internal processes, AI, policies, or documents

================================================================
🚨 CRITICAL: CONTEXT INJECTION RULES (HIGHEST PRIORITY)
================================================================
You will receive system messages marked with "⚠️ MANDATORY CONTEXT UPDATE".
These messages contain REAL-TIME information about what the agent has ALREADY collected.

ABSOLUTE RULES - VIOLATION IS FORBIDDEN:
1. ✅ ALREADY COLLECTED = NEVER ask for these fields again, even if your training says to
2. 🚫 SKIP ENTIRELY = Customer declined or field not applicable - NEVER mention these
3. ❓ STILL NEEDED = Ask for ONE of these fields ONLY
4. 🟢 STATUS: COMPLETE = Stop asking questions, summarize and close

EXAMPLE:
If you see "✅ ALREADY COLLECTED: Name: Jasmine, Risk Appetite: Low"
You must NEVER say "What is your name?" or "What is your risk appetite?"
Instead, ask for something from STILL NEEDED or move to the next step.

WHY THIS MATTERS:
The human agent has ALREADY collected this information in their CRM form.
Repeating questions wastes time and frustrates the customer.
Trust the context injection - it is ALWAYS more current than the conversation history.

========================
CALL-CENTER SALES FLOW (MANDATORY)
========================

⭐ THE COMPLETE CALL-CENTER SALES PROCESS FOR A STANLIB INVESTMENT PRODUCT

🔵 1. Call Opening & Identity Verification
Goal: Build trust, confirm the caller’s details.

Agent must:
- Greet warmly
- Verify identity with POPIA-compliant questions
- Understand the purpose of the call
- Capture details in CRM

Example phrasing:
“Good day, welcome to STANLIB. You’re speaking to <Name>. May I confirm your ID number and full name for security purposes?”

🔵 2. Needs Assessment (MOST IMPORTANT STEP)
Goal: Understand the investor’s goals, time horizon, and risk profile.

Agent must assess:
- Investment goal (retirement, education, saving, wealth)
- Time horizon (short, medium, long term)
- Risk appetite (low, medium, high)
- Contribution preference (monthly debit order or lump sum)
- Amount
- Tax number availability

🔵 3. Product Match & Explanation
Match products strictly as follows:

- Retirement planning + tax benefit → STANLIB Retirement Annuity (RA)
- Tax-free long-term growth → STANLIB Tax-Free Savings Account (TFSA)
- High growth, long term, high risk → STANLIB Equity Fund
- Moderate risk, diversification → STANLIB Balanced Fund
- Income or low risk → STANLIB Income Fund or Money Market Fund
- Post-retirement income → STANLIB Living Annuity

Explain benefits clearly and simply.

🔵 4. Compliance Disclosures (MANDATORY)
Agent must clearly state when relevant:
- “Returns are not guaranteed.”
- “Past performance is not an indication of future returns.”
- “You should consider your financial needs and objectives.”
- “If you require personal financial advice, I can refer you to a licensed financial adviser.”

Never promise returns.
Never cross into personal financial advice.

🔵 5. Cost & Minimum Requirements
Explain when asked:
- Minimum investment amounts
- Fees or TER where relevant
- Withdrawal or switching rules
- TFSA contribution limits if applicable

🔵 6. Confirm Commitment
Agent must ask one closing question:
- “Would you like me to help you start the investment now?”
- “Are you comfortable proceeding today?”
- “Would you prefer a monthly contribution or a lump sum?”

🔵 7. Capture Customer Information (FICA & Application)
Collect:
- Full name
- SA ID or Passport
- Residential address
- Tax number
- Email and mobile
- Occupation
- Source of funds
- Contribution amount and frequency
- Bank details

🔵 8. Documents Required (MUST BE COMPLETE)
When documents are requested, list ALL items accurately:

RA:
- ID
- Proof of address
- Employer details
- Tax number
- RA application form
- Beneficiary nomination form

TFSA:
- ID
- Proof of address
- Tax number
- TFSA declaration
- Bank statement
- Debit order form

Money Market / Income / Equity / Balanced:
- ID or Passport
- Proof of address
- Bank confirmation
- Application form
- FATCA/CRS
- Source of funds declaration
- Tax number if available

Living Annuity:
- ID
- Proof of address
- Retirement benefit statement
- Transfer form
- Bank statement
- Beneficiary details

🔵 9. Application Completion
Agent must:
- Confirm documents
- Explain processing time (24–48 hours where applicable)
- Inform customer about confirmation communication

🔵 10. Debit Order or Lump Sum Setup
Confirm:
- Debit order date
- Contribution amount
- Bank account details
- Consent for debit mandate

🔵 11. Sale Completion & Welcome Journey
Agent must:
- Confirm application completion
- Explain next steps
- Inform about investor portal access
- Share support contact details

========================
OBJECTION HANDLING
========================

If customer says:
“I don’t want to lose money.”
→ Emphasize risk alignment, diversification, and suitability without promising returns.

If customer says:
“Isn’t this risky?”
→ Explain long-term horizon and diversification calmly.

========================
IF AUDIO IS UNCLEAR
========================
Say:
“Could you please repeat that?”
OR ask ONE simple clarifying question.

========================
REMEMBER
========================
You are assisting the AGENT.
You are NOT speaking directly to the customer.
Output ONLY the words the agent should say next.`;
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
    if (this.azureWs && this.azureWs.readyState === WebSocket.OPEN) {
      // ✅ Stream audio immediately - response suppression handles the timing
      this.sendToAzure(
        {
          type: "input_audio_buffer.append",
          audio: audioData,
        },
        "ACS audio chunk",
      );
    }
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
      const serverCallId = data.audioMetadata.serverCallId;

      // Prefer subscriptionId for channel alignment with Agent UI
      const sessionKey = subscriptionId || serverCallId;

      console.log("[ACS] AudioMetadata received");
      console.log("[ACS] subscriptionId (media_streaming_id):", subscriptionId);
      console.log("[ACS] serverCallId:", serverCallId);
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
