// FinCore AI — WhatsApp webhook (Phase 3: signature verification,
// conversation_sessions bootstrap, echo/menu only).
//
// Scope is intentionally narrow, per the milestone plan: this does NOT yet
// run onboarding, invoice analysis, or natural-language Q&A — those are
// later phases and will extend the routing below against real DB-backed
// logic. See .enter/plans/fincore-ai-architecture.md.
//
// NOTE: this project's Edge Function bundler packages only the single
// index.ts file per function — cross-function relative imports to a
// `_shared/` directory are not resolved at deploy time. Until that changes,
// shared WhatsApp/CORS helpers are inlined here; the `supabase/functions/
// _shared/*.ts` files are kept as the documented reference copy other
// functions should inline from, to avoid silent drift.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GRAPH_API_VERSION = "v21.0";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

async function verifyMetaSignature(rawBody: string, signatureHeader: string | null, appSecret: string): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const providedHex = signatureHeader.slice("sha256=".length);

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computedBytes = new Uint8Array(signatureBuffer);

  let providedBytes: Uint8Array;
  try {
    providedBytes = hexToBytes(providedHex);
  } catch {
    return false;
  }

  return timingSafeEqual(computedBytes, providedBytes);
}

interface SendWhatsAppTextResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

async function sendWhatsAppText(to: string, body: string, accessToken: string, phoneNumberId: string): Promise<SendWhatsAppTextResult> {
  try {
    const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return { success: false, error: data?.error?.message ?? `Graph API request failed (${response.status})` };
    }
    return { success: true, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error sending WhatsApp message" };
  }
}

interface WhatsAppInboundMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  interactive?: { type: string; list_reply?: { id: string; title: string }; button_reply?: { id: string; title: string } };
}

interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppInboundMessage[];
        contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
      };
    }>;
  }>;
}

function extractInboundMessages(payload: WhatsAppWebhookPayload): WhatsAppInboundMessage[] {
  const messages: WhatsAppInboundMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        messages.push(message);
      }
    }
  }
  return messages;
}

function summarizeInboundMessage(message: WhatsAppInboundMessage): { messageType: "text" | "image" | "document" | "interactive"; content: string } {
  if (message.type === "text" && message.text) {
    return { messageType: "text", content: message.text.body };
  }
  if (message.type === "image") {
    return { messageType: "image", content: message.image?.caption ?? "[image]" };
  }
  if (message.type === "document") {
    return { messageType: "document", content: message.document?.filename ?? message.document?.caption ?? "[document]" };
  }
  if (message.type === "interactive" && message.interactive) {
    const reply = message.interactive.list_reply ?? message.interactive.button_reply;
    return { messageType: "interactive", content: reply?.title ?? reply?.id ?? "[interactive reply]" };
  }
  return { messageType: "text", content: "[unsupported message type]" };
}

const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "";
const APP_SECRET = Deno.env.get("WHATSAPP_APP_SECRET") ?? "";
const ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
const PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MENU_TEXT = [
  "Main menu",
  "1. Analyze Invoice",
  "2. Financial Overview",
  "3. Vendor Intelligence",
  "4. Budget & Spending",
  "5. Cash Flow Forecast",
  "6. Risk & Alerts",
  "7. Ask FinCore AI",
  "8. Account / Help",
  "",
  "Full processing for these options is being rolled out phase by phase. Reply with a number to see what's available so far.",
].join("\n");

const GREETING_PATTERN = /^(hi|hello|hey|menu|help)$/i;

function buildReply(messageType: string, content: string): string {
  if (messageType === "text" && GREETING_PATTERN.test(content.trim())) {
    return MENU_TEXT;
  }
  if (messageType === "image" || messageType === "document") {
    return "Got your file — invoice processing is coming in a later phase of this build. Type \"menu\" to see what's available now.";
  }
  return `Received: "${content}"\n\nFull onboarding and financial analysis are coming in later phases. Type "menu" to see available options.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // --- GET: Meta's webhook verification handshake ---
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === VERIFY_TOKEN && VERIFY_TOKEN.length > 0) {
      return new Response(challenge ?? "", { status: 200, headers: corsHeaders });
    }
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  // --- POST: inbound message(s) ---
  const rawBody = await req.text();
  const signatureHeader = req.headers.get("x-hub-signature-256");

  const signatureValid = await verifyMetaSignature(rawBody, signatureHeader, APP_SECRET);
  if (!signatureValid) {
    console.error("whatsapp-webhook: rejected request with invalid signature");
    return new Response("Invalid signature", { status: 401, headers: corsHeaders });
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.error("whatsapp-webhook: failed to parse JSON body");
    return new Response("Bad Request", { status: 400, headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const inboundMessages = extractInboundMessages(payload);

  for (const message of inboundMessages) {
    try {
      const waId = message.from;
      const { messageType, content } = summarizeInboundMessage(message);

      // Bootstrap (or reuse) this contact's conversation session.
      const { data: existingSession, error: fetchError } = await supabase
        .from("conversation_sessions")
        .select("id, state, context")
        .eq("wa_id", waId)
        .maybeSingle();
      if (fetchError) throw fetchError;

      let sessionId: string;
      if (existingSession) {
        sessionId = existingSession.id;
        const { error: touchError } = await supabase
          .from("conversation_sessions")
          .update({ last_message_at: new Date().toISOString() })
          .eq("id", sessionId);
        if (touchError) throw touchError;
      } else {
        const { data: createdSession, error: createError } = await supabase
          .from("conversation_sessions")
          .insert({ wa_id: waId, state: "new" })
          .select("id")
          .single();
        if (createError) throw createError;
        sessionId = createdSession.id;
      }

      const { error: inboundInsertError } = await supabase.from("conversation_messages").insert({
        session_id: sessionId,
        direction: "inbound",
        message_type: messageType,
        content,
        wa_message_id: message.id,
      });
      if (inboundInsertError) throw inboundInsertError;

      const replyText = buildReply(messageType, content);

      const { error: outboundInsertError } = await supabase.from("conversation_messages").insert({
        session_id: sessionId,
        direction: "outbound",
        message_type: "text",
        content: replyText,
      });
      if (outboundInsertError) throw outboundInsertError;

      const sendResult = await sendWhatsAppText(waId, replyText, ACCESS_TOKEN, PHONE_NUMBER_ID);
      if (!sendResult.success) {
        console.error(`whatsapp-webhook: failed to send reply to ${waId}: ${sendResult.error}`);
      }
    } catch (err) {
      console.error("whatsapp-webhook: error processing inbound message", err instanceof Error ? err.message : err);
      // Continue processing any remaining messages in this batch; never leak
      // internals in the response to Meta.
    }
  }

  // Meta expects a fast 200 regardless of downstream processing outcome.
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
