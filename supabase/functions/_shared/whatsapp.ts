// Meta WhatsApp Cloud API — shared helpers.
//
// verifyMetaSignature: HMAC-SHA256 signature check for inbound webhook posts.
// sendWhatsAppText: outbound message send via the Graph API.
//
// Kept as a plain shared module (not a separately deployed function) so any
// backend function that needs to send a WhatsApp message can import it
// directly with a relative path — no extra network hop, no passing service
// keys between functions.

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

/**
 * Verifies the `X-Hub-Signature-256` header Meta sends on every webhook POST.
 * Must be run against the raw request body bytes (before any JSON.parse).
 */
export async function verifyMetaSignature(rawBody: string, signatureHeader: string | null, appSecret: string): Promise<boolean> {
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

export interface SendWhatsAppTextResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/** Sends a plain text message via the Graph API. Returns the Meta message id on success. */
export async function sendWhatsAppText(to: string, body: string, accessToken: string, phoneNumberId: string): Promise<SendWhatsAppTextResult> {
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

// ---- Minimal inbound webhook payload types (only the fields we read) -----

export interface WhatsAppInboundMessage {
  from: string; // sender's WhatsApp ID / phone number
  id: string; // Meta message id
  timestamp: string;
  type: "text" | "image" | "document" | "interactive" | string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  interactive?: { type: string; list_reply?: { id: string; title: string }; button_reply?: { id: string; title: string } };
}

export interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppInboundMessage[];
        contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
      };
    }>;
  }>;
}

/** Flattens the nested Meta payload into a simple list of inbound messages. */
export function extractInboundMessages(payload: WhatsAppWebhookPayload): WhatsAppInboundMessage[] {
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

/** Extracts a best-effort text summary for any inbound message type, for storage/echo. */
export function summarizeInboundMessage(message: WhatsAppInboundMessage): { messageType: "text" | "image" | "document" | "interactive"; content: string } {
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
