// FinCore AI - WhatsApp webhook.
//
// Phase 3: signature verification, conversation_sessions bootstrap, echo/menu.
// Phase 4: full onboarding + account creation state machine.
// Phase 5 (this revision): OTP account recovery + number linking (recovery_email/recovery_otp states).
// Later phases (invoice analysis, Q&A, alerts, forecasting) still extend the
// same routing below. See .enter/plans/fincore-ai-architecture.md.
//
// NOTE: this project's Edge Function bundler packages only the single
// index.ts file per function - cross-function relative imports to a
// `_shared/` directory are not resolved at deploy time. Until that changes,
// shared WhatsApp/CORS helpers are inlined here; the `supabase/functions/
// _shared/*.ts` files are kept as the documented reference copy other
// functions should inline from, to avoid silent drift.
//
// Onboarding + OTP verification are implemented as local functions in this
// same file (not a separately deployed function): they are only ever
// invoked from within this webhook's own per-message loop, so a same-file
// implementation avoids an internal HTTP hop and service-role token
// passing between functions. See the Phase 4 section of the plan for the
// reasoning.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Used instead of the two-character escape sequence for "newline" in string
// literals throughout this file (multi-line WhatsApp replies), for
// compatibility with this project's source-writing tooling.
const NL = String.fromCharCode(10);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GRAPH_API_VERSION = "v22.0";

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function callGeminiText(systemPrompt: string, userText: string, maxOutputTokens = 500): Promise<string | null> {
  if (!AI_API_TOKEN) return null;
  try {
    const response = await fetchWithTimeout(`${AI_API_BASE}/code/api/ai/v1beta/models/${CHAT_MODEL}:streamGenerateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": AI_API_TOKEN,
        "Content-Type": "application/json",
        "X-Enter-Project-ID": AI_PROJECT_ID,
        "X-Session-ID": `chatbot-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: { temperature: 0, maxOutputTokens },
      }),
    });
    const body = await response.text();
    if (!response.ok) {
      console.error(`whatsapp-webhook: Gemini chatbot request failed (${response.status})`);
      return null;
    }
    const chunks: string[] = [];
    for (const line of body.split(String.fromCharCode(10))) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        const data = JSON.parse(trimmed.slice(5).trim());
        const text = data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("");
        if (text) chunks.push(text);
      } catch {
        // Ignore non-JSON SSE lines and continue collecting text chunks.
      }
    }
    return chunks.join("").trim() || null;
  } catch (error) {
    console.error("whatsapp-webhook: Gemini chatbot request failed", error instanceof Error ? error.message : error);
    return null;
  }
}

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
    const response = await fetchWithTimeout(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
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

interface InboundSummary {
  messageType: "text" | "image" | "document" | "interactive";
  content: string;
  mediaId?: string;
  mimeType?: string;
  filename?: string;
}

interface InvoiceIngestResult {
  success: boolean;
  invoiceId?: string;
  storagePath?: string;
  mimeType?: string;
  errorMessage: string;
}

interface ExtractedInvoiceFields {
  invoice_number: string | null;
  vendor_name: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  subtotal: number | null;
  tax_amount: number | null;
  total_amount: number | null;
  po_number: string | null;
  payment_terms: string | null;
  department: string | null;
  description: string | null;
  confidence: number | null;
  line_items: Array<{ description: string | null; quantity: number | null; unit_price: number | null; amount: number | null }>;
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

function summarizeInboundMessage(message: WhatsAppInboundMessage): InboundSummary {
  if (message.type === "text" && message.text) {
    return { messageType: "text", content: message.text.body };
  }
  if (message.type === "image") {
    return {
      messageType: "image",
      content: message.image?.caption ?? "[image]",
      mediaId: message.image?.id,
      mimeType: message.image?.mime_type,
      filename: "invoice-image",
    };
  }
  if (message.type === "document") {
    return {
      messageType: "document",
      content: message.document?.filename ?? message.document?.caption ?? "[document]",
      mediaId: message.document?.id,
      mimeType: message.document?.mime_type,
      filename: message.document?.filename,
    };
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
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MENU_TEXT = [
  "Main menu",
  "1 — upload invoice",
  "2 — financial overview",
  "3 — top vendors",
  "4 — budget status",
  "5 — 30-day forecast",
  "6 — risk alerts",
  "7 — ask a finance question",
  "8 — account/help",
].join(NL);

const GREETING_PATTERN = /^(hi|hello|hey|menu|help)$/i;

function buildReply(messageType: string, content: string): string {
  if (messageType === "text" && GREETING_PATTERN.test(content.trim())) {
    return ["Hi! I'm FinCore AI, your financial intelligence assistant.", "", MENU_TEXT].join(NL);
  }
  if (messageType === "image" || messageType === "document") {
    return "Got your file - invoice processing is coming in a later phase of this build. Type 'menu' to see what's available now.";
  }
  return ["Received: " + JSON.stringify(content), "", "Full financial analysis is coming in later phases. Type \"menu\" to see available options."].join(NL);
}

const INVOICE_BUCKET = "fincore-invoices";
const MAX_INVOICE_BYTES = 10 * 1024 * 1024;
const AI_API_TOKEN = Deno.env.get("AI_API_TOKEN_207130282296") ?? "";
const AI_API_BASE = "https://api.enter.pro";
const AI_PROJECT_ID = "20713028229644c2839e687ec9379bee";
const OCR_MODEL = "alibaba/qwen-3.7-plus";
const CHAT_MODEL = "google/gemini-3.1-flash-lite-preview";
const ALLOWED_INVOICE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

function invoiceExtension(mimeType: string, filename?: string): string {
  const filenameExtension = filename?.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (filenameExtension === "pdf" || filenameExtension === "jpg" || filenameExtension === "jpeg" || filenameExtension === "png") {
    return filenameExtension === "jpeg" ? "jpg" : filenameExtension;
  }
  return mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg";
}

async function ensureInvoiceBucket(supabase: SupabaseClient): Promise<void> {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw listError;
  if (buckets?.some((bucket) => bucket.name === INVOICE_BUCKET)) return;
  const { error: createError } = await supabase.storage.createBucket(INVOICE_BUCKET, { public: false });
  if (createError && !/already exists|duplicate/i.test(createError.message)) throw createError;
}

async function fetchWhatsAppMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const metadataResponse = await fetchWithTimeout(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const metadata = await metadataResponse.json();
  if (!metadataResponse.ok || !metadata?.url) {
    throw new Error(metadata?.error?.message ?? `WhatsApp media metadata request failed (${metadataResponse.status})`);
  }

  const mediaResponse = await fetchWithTimeout(metadata.url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!mediaResponse.ok) throw new Error(`WhatsApp media download failed (${mediaResponse.status})`);
  const contentLength = Number(mediaResponse.headers.get("content-length") ?? "0");
  if (contentLength > MAX_INVOICE_BYTES) throw new Error("Invoice file exceeds the 10 MB limit");
  const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
  if (bytes.byteLength > MAX_INVOICE_BYTES) throw new Error("Invoice file exceeds the 10 MB limit");
  return { bytes, mimeType: metadata.mime_type ?? mediaResponse.headers.get("content-type")?.split(";")[0] ?? "" };
}

async function ingestWhatsAppInvoice(
  supabase: SupabaseClient,
  summary: InboundSummary,
  companyId: string,
  userId: string,
): Promise<InvoiceIngestResult> {
  if (!summary.mediaId) return { success: false, errorMessage: "I couldn't read that file. Please send the invoice again as a PDF, JPG, or PNG." };
  if (summary.mimeType && !ALLOWED_INVOICE_TYPES.has(summary.mimeType)) {
    return { success: false, errorMessage: "Please send an invoice as a PDF, JPG, or PNG file (maximum 10 MB)." };
  }

  let media: { bytes: Uint8Array; mimeType: string };
  try {
    media = await fetchWhatsAppMedia(summary.mediaId);
  } catch (error) {
    console.error("whatsapp-webhook: invoice media fetch failed", error instanceof Error ? error.message : error);
    return { success: false, errorMessage: "I couldn't download that invoice. Please send it again." };
  }
  if (!ALLOWED_INVOICE_TYPES.has(media.mimeType)) {
    return { success: false, errorMessage: "Please send an invoice as a PDF, JPG, or PNG file (maximum 10 MB)." };
  }

  const invoiceId = newId("INV");
  const extension = invoiceExtension(media.mimeType, summary.filename);
  const storagePath = `invoices/${companyId}/${invoiceId}.${extension}`;
  try {
    await ensureInvoiceBucket(supabase);

    const { data: pendingVendor, error: vendorLookupError } = await supabase
      .from("vendors")
      .select("vendor_id")
      .eq("company_id", companyId)
      .eq("name", "Pending Vendor")
      .maybeSingle();
    if (vendorLookupError) throw vendorLookupError;

    let vendorId = pendingVendor?.vendor_id;
    if (!vendorId) {
      vendorId = `VEN-PENDING-${companyId.replace(/[^A-Za-z0-9]/g, "").slice(-8)}`;
      const { error: vendorInsertError } = await supabase.from("vendors").insert({
        vendor_id: vendorId,
        company_id: companyId,
        name: "Pending Vendor",
        status: "Active",
        risk_profile: "Low",
      });
      if (vendorInsertError && !/duplicate|unique/i.test(vendorInsertError.message)) throw vendorInsertError;
    }

    const { error: uploadError } = await supabase.storage.from(INVOICE_BUCKET).upload(storagePath, media.bytes, {
      contentType: media.mimeType,
      upsert: false,
    });
    if (uploadError) throw uploadError;

    const { error: invoiceError } = await supabase.from("invoices").insert({
      invoice_id: invoiceId,
      company_id: companyId,
      vendor_id: vendorId,
      date: new Date().toISOString().slice(0, 10),
      subtotal: 0,
      tax_amount: 0,
      total_amount: 0,
      currency: "INR",
      status: "Pending",
      source_channel: "whatsapp_bot",
      submitted_by: userId,
      file_storage_path: storagePath,
      notes: "Awaiting Phase 7 extraction",
      submitted_at: new Date().toISOString(),
    });
    if (invoiceError) {
      await supabase.storage.from(INVOICE_BUCKET).remove([storagePath]);
      throw invoiceError;
    }
    return { success: true, invoiceId, storagePath, mimeType: media.mimeType, errorMessage: "" };
  } catch (error) {
    console.error("whatsapp-webhook: invoice ingest failed", error instanceof Error ? error.message : error);
    return { success: false, errorMessage: "I couldn't save that invoice. Please try sending it again." };
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const value = JSON.parse(cleaned);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeExtractedFields(value: Record<string, unknown>): ExtractedInvoiceFields {
  const rawItems = Array.isArray(value.line_items) ? value.line_items : [];
  return {
    invoice_number: stringOrNull(value.invoice_number),
    vendor_name: stringOrNull(value.vendor_name),
    invoice_date: stringOrNull(value.invoice_date),
    due_date: stringOrNull(value.due_date),
    currency: stringOrNull(value.currency),
    subtotal: numberOrNull(value.subtotal),
    tax_amount: numberOrNull(value.tax_amount),
    total_amount: numberOrNull(value.total_amount),
    po_number: stringOrNull(value.po_number),
    payment_terms: stringOrNull(value.payment_terms),
    department: stringOrNull(value.department),
    description: stringOrNull(value.description),
    confidence: numberOrNull(value.confidence),
    line_items: rawItems.map((item) => {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        description: stringOrNull(row.description),
        quantity: numberOrNull(row.quantity),
        unit_price: numberOrNull(row.unit_price),
        amount: numberOrNull(row.amount),
      };
    }),
  };
}

function validateExtractedFields(fields: ExtractedInvoiceFields): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!fields.invoice_date || !/^\d{4}-\d{2}-\d{2}$/.test(fields.invoice_date)) errors.push("Invoice date is missing or not YYYY-MM-DD");
  if (fields.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(fields.due_date)) errors.push("Due date is not YYYY-MM-DD");
  if (fields.invoice_date && fields.due_date && fields.due_date < fields.invoice_date) errors.push("Due date is before invoice date");
  if (fields.total_amount === null) errors.push("Total amount is missing");
  for (const [name, amount] of [["subtotal", fields.subtotal], ["tax_amount", fields.tax_amount], ["total_amount", fields.total_amount]] as Array<[string, number | null]>) {
    if (amount !== null && amount < 0) errors.push(`${name} cannot be negative`);
  }
  if (fields.subtotal !== null && fields.tax_amount !== null && fields.total_amount !== null && Math.abs(fields.subtotal + fields.tax_amount - fields.total_amount) > 1) {
    errors.push("Subtotal plus tax does not match total");
  }
  if (fields.confidence === null || fields.confidence < 0 || fields.confidence > 1) errors.push("Confidence must be between 0 and 1");
  if (fields.line_items.length === 0) warnings.push("No line items were extracted");
  if (fields.vendor_name === null) warnings.push("Vendor name was not extracted");
  return { valid: errors.length === 0, errors, warnings };
}

async function analyzeStoredInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
  storagePath: string,
  mimeType: string,
  companyId: string,
): Promise<{ success: boolean; summary: string }> {
  if (!mimeType.startsWith("image/")) {
    return { success: false, summary: "The invoice is stored safely. PDF extraction will be enabled in the next extraction update." };
  }
  if (!AI_API_TOKEN) {
    console.error("whatsapp-webhook: AI token is not configured");
    return { success: false, summary: "The invoice is stored safely, but extraction is temporarily unavailable." };
  }

  try {
    const { data: file, error: downloadError } = await supabase.storage.from(INVOICE_BUCKET).download(storagePath);
    if (downloadError || !file) throw downloadError ?? new Error("Stored invoice could not be downloaded");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const imageDataUrl = `data:${mimeType};base64,${btoa(binary)}`;
    const prompt = [
      "Extract only facts visibly present in this invoice image.",
      "Return one JSON object only, with exactly these keys:",
      "invoice_number, vendor_name, invoice_date, due_date, currency, subtotal, tax_amount, total_amount, po_number, payment_terms, department, description, confidence, line_items.",
      "Use YYYY-MM-DD dates, numbers for monetary values, confidence from 0 to 1, and an array of line_items with description, quantity, unit_price, amount.",
      "Use null for any missing or unreadable value. Never guess, infer, or calculate a missing value.",
    ].join(" ");
    const response = await fetchWithTimeout(`${AI_API_BASE}/code/api/v1/ai/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AI_API_TOKEN}`,
        "Content-Type": "application/json",
        "X-Enter-Project-ID": AI_PROJECT_ID,
        "X-Session-ID": `invoice-${invoiceId}`,
      },
      body: JSON.stringify({
        model: OCR_MODEL,
        stream: false,
        temperature: 0,
        max_tokens: 1800,
        messages: [
          { role: "system", content: "You are a precise invoice OCR extractor. Output JSON only." },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message ?? `AI request failed (${response.status})`);
    const content = data?.choices?.[0]?.message?.content;
    const parsed = typeof content === "string" ? parseJsonObject(content) : null;
    if (!parsed) throw new Error("AI returned malformed JSON");

    const fields = normalizeExtractedFields(parsed);
    const validation = validateExtractedFields(fields);
    const { data: matchingVendor, error: vendorError } = fields.vendor_name
      ? await supabase.from("vendors").select("vendor_id").eq("company_id", companyId).ilike("name", fields.vendor_name).maybeSingle()
      : { data: null, error: null };
    if (vendorError) throw vendorError;

    const invoiceUpdate: Record<string, unknown> = {
      subtotal: fields.subtotal ?? 0,
      tax_amount: fields.tax_amount ?? 0,
      total_amount: fields.total_amount ?? 0,
      currency: fields.currency ?? "INR",
      ocr_confidence: fields.confidence,
      due_date: fields.due_date,
      payment_terms: fields.payment_terms,
      po_number: fields.po_number,
      department: fields.department,
      notes: fields.description,
    };
    if (fields.invoice_date && /^\d{4}-\d{2}-\d{2}$/.test(fields.invoice_date)) invoiceUpdate.date = fields.invoice_date;
    if (matchingVendor?.vendor_id) invoiceUpdate.vendor_id = matchingVendor.vendor_id;

    const { error: invoiceUpdateError } = await supabase.from("invoices").update(invoiceUpdate).eq("invoice_id", invoiceId);
    if (invoiceUpdateError) throw invoiceUpdateError;
    const { error: analysisError } = await supabase.from("invoice_analysis").insert({
      invoice_id: invoiceId,
      extracted_fields: fields,
      validation_result: validation,
    });
    if (analysisError) throw analysisError;

    const totalText = fields.total_amount === null ? "an unread total" : `${fields.currency ?? "INR"} ${fields.total_amount.toFixed(2)}`;
    return { success: true, summary: `Extraction complete for ${invoiceId}: total ${totalText}. Validation: ${validation.valid ? "passed" : "needs review"}.` };
  } catch (error) {
    console.error("whatsapp-webhook: invoice extraction failed", error instanceof Error ? error.message : error);
    return { success: false, summary: "The invoice is stored safely, but extraction needs a retry." };
  }
}

interface DuplicateHistoryInvoice {
  invoice_id: string;
  vendor_id: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  date: string;
  due_date: string | null;
  po_number: string | null;
  notes: string | null;
}

function normalizedWords(value: string | null | undefined): Set<string> {
  return new Set((value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function wordSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const left = normalizedWords(a);
  const right = normalizedWords(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const word of left) if (right.has(word)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function dateDistanceDays(a: string, b: string): number {
  const left = new Date(a).getTime();
  const right = new Date(b).getTime();
  return Number.isFinite(left) && Number.isFinite(right) ? Math.abs(left - right) / 86400000 : Infinity;
}

function scoreDuplicateInvoice(
  current: DuplicateHistoryInvoice,
  candidate: DuplicateHistoryInvoice,
  currentNumber: string | null,
  candidateNumber: string | null,
): { score: number; evidence: string[] } {
  let score = 0;
  const evidence: string[] = [];
  if (currentNumber && candidateNumber && currentNumber.toLowerCase() === candidateNumber.toLowerCase()) {
    score += 45;
    evidence.push(`Exact invoice number match: ${candidate.invoice_id}`);
  }
  const maxAmount = Math.max(current.total_amount, candidate.total_amount, 1);
  const amountDifference = Math.abs(current.total_amount - candidate.total_amount) / maxAmount;
  if (amountDifference <= 0.2) {
    score += Math.round(30 * (1 - amountDifference / 0.2));
    if (amountDifference <= 0.02) evidence.push(`Nearly identical total amount to ${candidate.invoice_id}`);
  }
  const days = dateDistanceDays(current.date, candidate.date);
  if (days <= 30) {
    score += Math.round(15 * (1 - days / 30));
    if (days <= 3) evidence.push(`Invoice dates are within ${Math.round(days)} day(s)`);
  }
  if (current.po_number && candidate.po_number && current.po_number.toLowerCase() === candidate.po_number.toLowerCase()) {
    score += 25;
    evidence.push(`Same purchase order as ${candidate.invoice_id}`);
  }
  const descriptionSimilarity = wordSimilarity(current.notes, candidate.notes);
  if (descriptionSimilarity > 0) {
    score += Math.round(15 * descriptionSimilarity);
    if (descriptionSimilarity >= 0.5) evidence.push(`Similar description text to ${candidate.invoice_id}`);
  }
  return { score: Math.min(100, score), evidence };
}

async function enrichInvoiceIntelligence(
  supabase: SupabaseClient,
  invoiceId: string,
  companyId: string,
): Promise<{ summary: string }> {
  let stage = "start";
  try {
    stage = "load current invoice";
    const { data: current, error: currentError } = await supabase
      .from("invoices")
      .select("invoice_id,vendor_id,subtotal,tax_amount,total_amount,date,due_date,po_number,notes")
      .eq("invoice_id", invoiceId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (currentError) throw currentError;
    if (!current) throw new Error("Analyzed invoice not found");

    stage = "load current analysis";
    const { data: currentAnalysis, error: currentAnalysisError } = await supabase
      .from("invoice_analysis")
      .select("extracted_fields")
      .eq("invoice_id", invoiceId)
      .maybeSingle();
    if (currentAnalysisError) throw currentAnalysisError;
    const currentFields = (currentAnalysis?.extracted_fields ?? {}) as Record<string, unknown>;
    const currentNumber = stringOrNull(currentFields.invoice_number);

    stage = "load vendor invoice history";
    const { data: history, error: historyError } = await supabase
      .from("invoices")
      .select("invoice_id,vendor_id,subtotal,tax_amount,total_amount,date,due_date,po_number,notes")
      .eq("company_id", companyId)
      .eq("vendor_id", current.vendor_id)
      .neq("invoice_id", invoiceId);
    if (historyError) throw historyError;
    const candidates = (history ?? []) as DuplicateHistoryInvoice[];
    const candidateIds = candidates.map((item) => item.invoice_id);
    stage = "load prior invoice analyses";
    const { data: historyAnalyses, error: historyAnalysisError } = candidateIds.length
      ? await supabase.from("invoice_analysis").select("invoice_id,extracted_fields,duplicate_score").in("invoice_id", candidateIds)
      : { data: [], error: null };
    if (historyAnalysisError) throw historyAnalysisError;
    const analysisByInvoice = new Map((historyAnalyses ?? []).map((item) => [item.invoice_id, item]));
    const duplicateMatches = candidates.map((candidate) => {
      const candidateFields = (analysisByInvoice.get(candidate.invoice_id)?.extracted_fields ?? {}) as Record<string, unknown>;
      const scored = scoreDuplicateInvoice(current as DuplicateHistoryInvoice, candidate as DuplicateHistoryInvoice, currentNumber, stringOrNull(candidateFields.invoice_number));
      return { invoiceId: candidate.invoice_id, similarity: scored.score, evidence: scored.evidence };
    }).filter((match) => match.similarity > 0).sort((a, b) => b.similarity - a.similarity);
    const bestDuplicate = duplicateMatches[0] ?? null;

    stage = "load vendor profile";
    const { data: vendor, error: vendorError } = await supabase
      .from("vendors")
      .select("vendor_id,name,status,risk_profile,onboarded_date")
      .eq("vendor_id", current.vendor_id)
      .eq("company_id", companyId)
      .maybeSingle();
    if (vendorError) throw vendorError;
    if (!vendor) throw new Error("Invoice vendor not found");
    const vendorInvoices = [current as DuplicateHistoryInvoice, ...candidates];
    const totalSpend = vendorInvoices.reduce((sum, item) => sum + Number(item.total_amount ?? 0), 0);
    const averageSpend = vendorInvoices.length ? totalSpend / vendorInvoices.length : 0;
    const ninetyDaysAgo = Date.now() - 90 * 86400000;
    const recentInvoiceCount = vendorInvoices.filter((item) => new Date(item.date).getTime() >= ninetyDaysAgo).length;
    stage = "load vendor payments";
    const { data: payments, error: paymentsError } = await supabase
      .from("payments")
      .select("invoice_id,status,payment_date")
      .eq("company_id", companyId)
      .in("invoice_id", vendorInvoices.map((item) => item.invoice_id));
    if (paymentsError) throw paymentsError;
    const completedPayments = (payments ?? []).filter((payment) => payment.status === "Completed");
    const onTimePayments = completedPayments.filter((payment) => {
      const invoice = vendorInvoices.find((item) => item.invoice_id === payment.invoice_id);
      return invoice && invoice.due_date && payment.payment_date && new Date(payment.payment_date).getTime() <= new Date(invoice.due_date).getTime();
    }).length;
    const onTimeRate = completedPayments.length ? onTimePayments / completedPayments.length : null;
    stage = "load bank changes";
    const { data: bankChanges, error: bankError } = await supabase
      .from("vendor_bank_changes")
      .select("changed_at")
      .eq("company_id", companyId)
      .eq("vendor_id", current.vendor_id)
      .gte("changed_at", new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
    if (bankError) throw bankError;

    let vendorScore = 0;
    const vendorReasons: string[] = [];
    if (vendor.status === "Blacklisted") { vendorScore += 60; vendorReasons.push("Vendor is blacklisted"); }
    if (vendor.status === "Under Review") { vendorScore += 30; vendorReasons.push("Vendor is under review"); }
    if (onTimeRate !== null && onTimeRate < 0.7) { vendorScore += 20; vendorReasons.push(`On-time payment rate is ${Math.round(onTimeRate * 100)}%`); }
    if (bestDuplicate && bestDuplicate.similarity >= 70) { vendorScore += 20; vendorReasons.push("Prior invoice history contains a high-similarity duplicate"); }
    if ((bankChanges ?? []).length > 0) { vendorScore += 25; vendorReasons.push("Vendor bank details changed within 30 days"); }
    if (vendorInvoices.length <= 2 && averageSpend > 200000) { vendorScore += 15; vendorReasons.push("New vendor relationship with a large average invoice"); }
    vendorScore = Math.min(100, vendorScore);
    const computedRisk = vendorScore >= 60 ? "High" : vendorScore >= 30 ? "Medium" : "Low";
    if (!vendorReasons.length) vendorReasons.push("No elevated risk indicators found in vendor history");
    const vendorSnapshot = {
      vendor_id: vendor.vendor_id,
      vendor_name: vendor.name,
      computed_risk: computedRisk,
      score: vendorScore,
      invoice_count: vendorInvoices.length,
      total_spend: totalSpend,
      average_invoice_amount: averageSpend,
      recent_invoice_count_90d: recentInvoiceCount,
      on_time_payment_rate: onTimeRate,
      recent_bank_change: (bankChanges ?? []).length > 0,
      reasons: vendorReasons,
    };
    stage = "save duplicate and vendor intelligence";
    const { error: analysisUpdateError } = await supabase.from("invoice_analysis").upsert({
      invoice_id: invoiceId,
      duplicate_score: bestDuplicate?.similarity ?? 0,
      duplicate_evidence: { best_match: bestDuplicate, matches: duplicateMatches.slice(0, 5) },
      vendor_risk_snapshot: vendorSnapshot,
    }, { onConflict: "invoice_id" });
    if (analysisUpdateError) throw analysisUpdateError;
    return {
      summary: `Duplicate score: ${bestDuplicate?.similarity ?? 0}%. Vendor risk: ${computedRisk} (${vendorScore}/100). ${bestDuplicate?.evidence[0] ?? vendorReasons[0]}`,
    };
  } catch (error) {
    console.error(`whatsapp-webhook: invoice intelligence failed at ${stage}`, error instanceof Error ? error.message : error);
    return { summary: "Duplicate and vendor intelligence is temporarily unavailable; the extracted invoice remains safely stored." };
  }
}

const DEFAULT_ANALYSIS_THRESHOLDS = {
  budgetReviewThresholdPct: 85,
  budgetDeferThresholdPct: 95,
  anomalyReviewThreshold: 60,
  vendorAmountMultiplierThreshold: 3,
  bankChangeLookbackDays: 30,
};

async function enrichBudgetAndAnomalies(
  supabase: SupabaseClient,
  invoiceId: string,
  companyId: string,
): Promise<{ summary: string }> {
  try {
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select("invoice_id,vendor_id,department,subtotal,tax_amount,total_amount,date,po_number,submitted_at,ocr_confidence")
      .eq("invoice_id", invoiceId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (invoiceError) throw invoiceError;
    if (!invoice) throw new Error("Invoice not found for anomaly analysis");
    const period = String(invoice.date).slice(0, 7);
    const invoiceTotal = Number(invoice.total_amount ?? 0);

    const { data: budget, error: budgetError } = await supabase
      .from("budgets")
      .select("allocated,spent,remaining,department,period")
      .eq("company_id", companyId)
      .eq("department", invoice.department ?? "")
      .eq("period", period)
      .maybeSingle();
    if (budgetError) throw budgetError;

    const budgetImpact = budget
      ? {
          found: true,
          department: invoice.department,
          period,
          allocated: Number(budget.allocated),
          spentBefore: Number(budget.spent),
          remainingBefore: Number(budget.remaining),
          utilizationBeforePct: Number(budget.allocated) > 0 ? (Number(budget.spent) / Number(budget.allocated)) * 100 : 0,
          invoiceAmount: invoiceTotal,
          projectedSpent: Number(budget.spent) + invoiceTotal,
          projectedRemaining: Number(budget.allocated) - Number(budget.spent) - invoiceTotal,
          projectedUtilizationPct: Number(budget.allocated) > 0 ? ((Number(budget.spent) + invoiceTotal) / Number(budget.allocated)) * 100 : 0,
          impact: "low" as "low" | "medium" | "high",
        }
      : {
          found: false,
          department: invoice.department,
          period,
          allocated: 0,
          spentBefore: 0,
          remainingBefore: 0,
          utilizationBeforePct: 0,
          invoiceAmount: invoiceTotal,
          projectedSpent: invoiceTotal,
          projectedRemaining: -invoiceTotal,
          projectedUtilizationPct: 0,
          impact: "medium" as "low" | "medium" | "high",
        };
    budgetImpact.impact = budgetImpact.projectedUtilizationPct >= 95 ? "high" : budgetImpact.projectedUtilizationPct >= 70 ? "medium" : "low";

    const { data: rules, error: rulesError } = await supabase
      .from("decision_rules_config")
      .select("rule_key,threshold_value")
      .eq("company_id", companyId);
    if (rulesError) throw rulesError;
    const thresholds = { ...DEFAULT_ANALYSIS_THRESHOLDS };
    for (const rule of rules ?? []) {
      if (rule.rule_key === "budget_review_threshold" || rule.rule_key === "budget_review_threshold_pct") thresholds.budgetReviewThresholdPct = Number(rule.threshold_value);
      if (rule.rule_key === "budget_defer_threshold" || rule.rule_key === "budget_defer_threshold_pct") thresholds.budgetDeferThresholdPct = Number(rule.threshold_value);
      if (rule.rule_key === "anomaly_review_threshold") thresholds.anomalyReviewThreshold = Number(rule.threshold_value);
      if (rule.rule_key === "vendor_amount_multiplier_threshold") thresholds.vendorAmountMultiplierThreshold = Number(rule.threshold_value);
      if (rule.rule_key === "bank_change_lookback_days") thresholds.bankChangeLookbackDays = Number(rule.threshold_value);
    }

    const { data: vendorInvoices, error: vendorInvoicesError } = await supabase
      .from("invoices")
      .select("invoice_id,department,subtotal,tax_amount,total_amount,date,po_number")
      .eq("company_id", companyId)
      .eq("vendor_id", invoice.vendor_id)
      .neq("invoice_id", invoiceId);
    if (vendorInvoicesError) throw vendorInvoicesError;
    const historical = vendorInvoices ?? [];
    const historicalAverage = historical.length ? historical.reduce((sum, item) => sum + Number(item.total_amount ?? 0), 0) / historical.length : 0;
    const nearby = historical.filter((item) => Math.abs(new Date(item.date).getTime() - new Date(invoice.date).getTime()) <= 5 * 86400000);
    const { data: currentAnalysis, error: currentAnalysisError } = await supabase
      .from("invoice_analysis")
      .select("duplicate_score,vendor_risk_snapshot")
      .eq("invoice_id", invoiceId)
      .maybeSingle();
    if (currentAnalysisError) throw currentAnalysisError;

    const signals: Array<{ type: string; description: string; weight: number }> = [];
    const duplicateScore = Number(currentAnalysis?.duplicate_score ?? 0);
    if (duplicateScore >= 40) signals.push({ type: "duplicate_invoice", description: `${Math.round(duplicateScore)}% similarity to a prior invoice from the same vendor`, weight: Math.round(duplicateScore * 0.4) });
    if (historicalAverage > 0 && invoiceTotal / historicalAverage >= thresholds.vendorAmountMultiplierThreshold) {
      const multiplier = invoiceTotal / historicalAverage;
      signals.push({ type: "vendor_spend_spike", description: `Amount is ${multiplier.toFixed(1)}x this vendor's historical average`, weight: Math.min(30, Math.round(multiplier * 5)) });
    }
    if (historical.length <= 1 && invoiceTotal > 200000) signals.push({ type: "new_vendor_large_invoice", description: "Large invoice from a vendor with little prior history", weight: 20 });
    if (!invoice.po_number && invoiceTotal > 500000) signals.push({ type: "missing_po_high_value", description: "High-value invoice has no purchase order", weight: 15 });
    const { data: bankChanges, error: bankError } = await supabase
      .from("vendor_bank_changes")
      .select("changed_at")
      .eq("company_id", companyId)
      .eq("vendor_id", invoice.vendor_id)
      .gte("changed_at", new Date(Date.now() - thresholds.bankChangeLookbackDays * 86400000).toISOString().slice(0, 10));
    if (bankError) throw bankError;
    if ((bankChanges ?? []).length) signals.push({ type: "post_bank_change_invoice", description: "Vendor bank details changed recently", weight: 25 });
    if (invoiceTotal > 0 && invoiceTotal % 10000 === 0) signals.push({ type: "round_number_pattern", description: "Invoice amount is a suspiciously round number", weight: 10 });
    if (nearby.length >= 2 && nearby.every((item) => Number(item.total_amount) <= 500000) && invoiceTotal <= 500000 && invoiceTotal + nearby.reduce((sum, item) => sum + Number(item.total_amount), 0) > 500000) {
      signals.push({ type: "split_invoice_suspected", description: "Nearby invoices combine into a high-value spend pattern", weight: 20 });
    }
    if (invoice.submitted_at) {
      const hour = new Date(invoice.submitted_at).getHours();
      if (hour < 7 || hour >= 21) signals.push({ type: "off_hours_submission", description: `Submitted off-hours at ${String(hour).padStart(2, "0")}:00`, weight: 10 });
    }
    if (invoice.ocr_confidence !== null && Number(invoice.ocr_confidence) < 0.7) signals.push({ type: "low_ocr_confidence_needs_review", description: `OCR confidence is ${Math.round(Number(invoice.ocr_confidence) * 100)}%`, weight: 10 });
    if (budgetImpact.found && budgetImpact.projectedUtilizationPct >= thresholds.budgetReviewThresholdPct) signals.push({ type: "abnormal_budget_impact", description: `Projected budget utilization reaches ${Math.round(budgetImpact.projectedUtilizationPct)}%`, weight: 15 });
    const anomalyScore = Math.min(100, signals.reduce((sum, signal) => sum + signal.weight, 0));
    const { error: updateError } = await supabase.from("invoice_analysis").update({ budget_impact: budgetImpact, anomaly_score: anomalyScore, anomaly_reasons: signals }).eq("invoice_id", invoiceId);
    if (updateError) throw updateError;
    const topReasons = signals.slice(0, 2).map((signal) => signal.description).join("; ");
    return { summary: `Budget: ${budgetImpact.found ? `${Math.round(budgetImpact.projectedUtilizationPct)}% projected utilization` : "no matching budget"}. Anomaly score: ${anomalyScore}/100.${topReasons ? ` ${topReasons}` : " No anomaly signals detected."}` };
  } catch (error) {
    console.error("whatsapp-webhook: budget/anomaly enrichment failed", error instanceof Error ? error.message : error);
    return { summary: "Budget and anomaly analysis is temporarily unavailable; prior invoice intelligence was preserved." };
  }
}

type DecisionAction = "APPROVE" | "REVIEW" | "DEFER" | "REJECT";

function decideInvoiceFromFacts(facts: {
  validation: Record<string, unknown>;
  duplicateScore: number;
  vendorRisk: string;
  recentBankChange: boolean;
  budgetImpact: Record<string, unknown>;
  anomalyScore: number;
  thresholds: typeof DEFAULT_ANALYSIS_THRESHOLDS;
}): { action: DecisionAction; recommendation: string; reasons: string[] } {
  const reasons: string[] = [];
  const criticalIssues = Array.isArray(facts.validation.errors) ? facts.validation.errors as string[] : [];
  if (facts.duplicateScore >= 70) {
    reasons.push(`Duplicate similarity score is ${Math.round(facts.duplicateScore)}%, at or above the review threshold (70%)`);
    return { action: "REVIEW", recommendation: "Hold - Duplicate Suspected", reasons };
  }
  if (criticalIssues.length >= 2) return { action: "REJECT", recommendation: "Reject", reasons: criticalIssues };
  if (criticalIssues.length === 1) return { action: "REVIEW", recommendation: "Flag for Review", reasons: criticalIssues };
  if (facts.vendorRisk === "High") return { action: "REVIEW", recommendation: "Flag for Review", reasons: ["Vendor's computed risk profile is High"] };
  if (facts.recentBankChange) return { action: "REVIEW", recommendation: "Flag for Review", reasons: ["Vendor changed bank account details recently"] };
  const utilization = Number(facts.budgetImpact.projectedUtilizationPct ?? 0);
  if (facts.budgetImpact.found === true && utilization >= facts.thresholds.budgetDeferThresholdPct) {
    reasons.push(`Projected budget utilization would reach ${Math.round(utilization)}%, at or above the defer threshold (${facts.thresholds.budgetDeferThresholdPct}%)`);
    return { action: "DEFER", recommendation: "Escalate", reasons };
  }
  if (facts.budgetImpact.found === true && utilization >= facts.thresholds.budgetReviewThresholdPct) {
    reasons.push(`Projected budget utilization would reach ${Math.round(utilization)}%, at or above the review threshold (${facts.thresholds.budgetReviewThresholdPct}%)`);
    return { action: "REVIEW", recommendation: "Flag for Review", reasons };
  }
  if (facts.anomalyScore >= facts.thresholds.anomalyReviewThreshold) {
    reasons.push(`Anomaly score is ${Math.round(facts.anomalyScore)}, at or above the review threshold (${facts.thresholds.anomalyReviewThreshold})`);
    return { action: "REVIEW", recommendation: "Flag for Review", reasons };
  }
  return { action: "APPROVE", recommendation: "Approve", reasons: ["No critical validation issues, vendor risk is acceptable, budget impact is manageable, and the anomaly score is low"] };
}

async function createInvoiceDecision(
  supabase: SupabaseClient,
  invoiceId: string,
  companyId: string,
): Promise<{ summary: string }> {
  try {
    const { data: analysis, error: analysisError } = await supabase
      .from("invoice_analysis")
      .select("validation_result,duplicate_score,vendor_risk_snapshot,budget_impact,anomaly_score")
      .eq("invoice_id", invoiceId)
      .maybeSingle();
    if (analysisError) throw analysisError;
    if (!analysis) throw new Error("Invoice analysis not found for decision");
    const vendorRisk = (analysis.vendor_risk_snapshot ?? {}) as Record<string, unknown>;
    const budgetImpact = (analysis.budget_impact ?? {}) as Record<string, unknown>;
    const { data: rules, error: rulesError } = await supabase.from("decision_rules_config").select("rule_key,threshold_value").eq("company_id", companyId);
    if (rulesError) throw rulesError;
    const thresholds = { ...DEFAULT_ANALYSIS_THRESHOLDS };
    for (const rule of rules ?? []) {
      if (rule.rule_key === "budget_review_threshold" || rule.rule_key === "budget_review_threshold_pct") thresholds.budgetReviewThresholdPct = Number(rule.threshold_value);
      if (rule.rule_key === "budget_defer_threshold" || rule.rule_key === "budget_defer_threshold_pct") thresholds.budgetDeferThresholdPct = Number(rule.threshold_value);
      if (rule.rule_key === "anomaly_review_threshold") thresholds.anomalyReviewThreshold = Number(rule.threshold_value);
    }
    const decision = decideInvoiceFromFacts({
      validation: (analysis.validation_result ?? {}) as Record<string, unknown>,
      duplicateScore: Number(analysis.duplicate_score ?? 0),
      vendorRisk: String(vendorRisk.computed_risk ?? "Low"),
      recentBankChange: vendorRisk.recent_bank_change === true,
      budgetImpact,
      anomalyScore: Number(analysis.anomaly_score ?? 0),
      thresholds,
    });
    const { error: decisionError } = await supabase.from("decisions").upsert({
      decision_id: `DEC-${invoiceId.replace(/^INV-/, "")}`,
      invoice_id: invoiceId,
      company_id: companyId,
      recommendation: decision.recommendation,
      reasoning: decision.reasons.join(" | "),
      confidence_score: decision.action === "APPROVE" ? 0.9 : 0.8,
      decided_by: "system_rules",
    }, { onConflict: "decision_id" });
    if (decisionError) throw decisionError;
    return { summary: `Decision: ${decision.action} (${decision.recommendation}). ${decision.reasons.join(" ")}` };
  } catch (error) {
    console.error("whatsapp-webhook: decision engine failed", error instanceof Error ? error.message : error);
    return { summary: "The recommendation is temporarily unavailable; the invoice remains safely Pending." };
  }
}

function extractQuestionAmount(question: string): number | null {
  const match = question.replace(/,/g, "").match(/(?:₹|rs\.?|inr\s*)?(\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : null;
}

async function explainFinancialFacts(question: string, facts: string): Promise<string> {
  const answer = await callGeminiText(
    "Answer the user's finance question using only the supplied company-scoped facts. Do not invent, recalculate, or add unsupported numbers. Be concise and preserve disclaimers.",
    `Question: ${question}${NL}${NL}Facts:${NL}${facts}`,
    500,
  );
  return answer ?? facts;
}

async function handleNumericMenu(supabase: SupabaseClient, companyId: string, text: string): Promise<string | null> {
  const option = text.trim();
  if (!/^[1-8]$/.test(option)) return null;
  if (option === "1") return "Please send your invoice as a PDF, JPG, or PNG image (maximum 10 MB). I will store it securely, extract the details, check risks, and return a recommendation.";
  if (option === "2") return answerFinancialQuestion(supabase, companyId, "How much did we spend this month?");
  if (option === "3") return answerFinancialQuestion(supabase, companyId, "Which vendor has the highest spend?");
  if (option === "4") return answerFinancialQuestion(supabase, companyId, "How much budget is left?");
  if (option === "5") return handleForecastCommand(supabase, companyId, "30 day forecast");
  if (option === "6") return scanCompanyAlerts(supabase, companyId);
  if (option === "7") return "Ask me a finance question in plain English, such as: Which vendor has the highest spend?";
  if (option === "8") return `Your FinCore account is active. You can use the numbered menu, upload invoices, ask questions in plain English, or type alerts to review risks.`;
  return null;
}

async function clearChatHistory(supabase: SupabaseClient, sessionId: string): Promise<string> {
  const { error: deleteError } = await supabase.from("conversation_messages").delete().eq("session_id", sessionId);
  if (deleteError) throw deleteError;
  const { error: resetError } = await supabase.from("conversation_sessions").update({ state: "active", context: {}, last_message_at: new Date().toISOString() }).eq("id", sessionId);
  if (resetError) throw resetError;
  return "FinCore chat history has been cleared from the backend. Your invoices, files, analyses, account, and financial data were not changed. To remove the messages already visible in WhatsApp, delete this chat from WhatsApp too.";
}

interface NaturalLanguageIntent {
  intent: "menu" | "alerts" | "workflow_action" | "forecast" | "qna" | "unknown";
  action: "approve" | "review" | "defer" | "reject" | null;
  invoice_id: string | null;
  alert_id: string | null;
  horizon_days: 30 | 60 | 90 | null;
  question: string | null;
}

function normalizeNaturalLanguageIntent(value: Record<string, unknown>): NaturalLanguageIntent {
  const allowed = new Set<NaturalLanguageIntent["intent"]>(["menu", "alerts", "workflow_action", "forecast", "qna", "unknown"]);
  const rawIntent = typeof value.intent === "string" && allowed.has(value.intent as NaturalLanguageIntent["intent"]) ? value.intent as NaturalLanguageIntent["intent"] : "unknown";
  const rawAction = typeof value.action === "string" && /^(approve|review|defer|reject)$/i.test(value.action) ? value.action.toLowerCase() as NaturalLanguageIntent["action"] : null;
  const rawHorizon = Number(value.horizon_days);
  return {
    intent: rawIntent,
    action: rawAction,
    invoice_id: typeof value.invoice_id === "string" && /^INV-[A-Z0-9]+$/i.test(value.invoice_id) ? value.invoice_id.toUpperCase() : null,
    alert_id: typeof value.alert_id === "string" && /^[0-9a-f-]{8,}$/i.test(value.alert_id) ? value.alert_id : null,
    horizon_days: rawHorizon === 30 || rawHorizon === 60 || rawHorizon === 90 ? rawHorizon : null,
    question: typeof value.question === "string" && value.question.trim() ? value.question.trim() : null,
  };
}

async function classifyNaturalLanguageCommand(text: string): Promise<NaturalLanguageIntent | null> {
  const content = await callGeminiText(
    "Classify the user's finance command. Return JSON only with intent (menu|alerts|workflow_action|forecast|qna|unknown), action (approve|review|defer|reject|null), invoice_id (INV-... or null), alert_id (or null), horizon_days (30|60|90|null), and question (or null). Never invent IDs.",
    text,
    220,
  );
  const parsed = content ? parseJsonObject(content) : null;
  return parsed ? normalizeNaturalLanguageIntent(parsed) : null;
}

type DatasetPlan = {
  in_scope: boolean;
  table: string | null;
  columns: string[];
  filters: Array<{ column: string; operator: "eq" | "ilike" | "gte" | "lte"; value: string | number }>;
  aggregate: "none" | "count" | "sum";
  aggregate_column: string | null;
  group_by: string | null;
  sort_column: string | null;
  sort_direction: "asc" | "desc";
  limit: number;
};

const DATASET_ALLOWLIST: Record<string, { columns: Set<string>; companyScoped: boolean }> = {
  companies: { columns: new Set(["company_id", "name", "industry", "country", "plan_tier"]), companyScoped: true },
  users: { columns: new Set(["user_id", "name", "role", "account_status", "created_at"]), companyScoped: true },
  vendors: { columns: new Set(["vendor_id", "name", "category", "risk_profile", "status"]), companyScoped: true },
  invoices: { columns: new Set(["invoice_id", "vendor_id", "department", "subtotal", "tax_amount", "total_amount", "currency", "date", "due_date", "status", "po_number", "ocr_confidence"]), companyScoped: true },
  payments: { columns: new Set(["payment_id", "invoice_id", "amount", "status", "payment_method", "payment_date"]), companyScoped: true },
  budgets: { columns: new Set(["budget_id", "department", "period", "allocated", "spent", "remaining"]), companyScoped: true },
  transactions: { columns: new Set(["transaction_id", "date", "type", "category", "amount"]), companyScoped: true },
  decisions: { columns: new Set(["decision_id", "invoice_id", "recommendation", "reasoning", "confidence_score", "timestamp"]), companyScoped: true },
  risk_alerts: { columns: new Set(["id", "alert_type", "severity", "related_invoice_id", "related_vendor_id", "message", "status", "created_at", "resolved_at"]), companyScoped: true },
  forecast_records: { columns: new Set(["id", "generated_at", "horizon_days", "projected_inflow", "projected_outflow", "projected_net", "projected_cash_position", "disclaimer"]), companyScoped: true },
  invoice_analysis: { columns: new Set(["invoice_id", "extracted_fields", "validation_result", "duplicate_score", "duplicate_evidence", "vendor_risk_snapshot", "budget_impact", "anomaly_score", "anomaly_reasons", "created_at"]), companyScoped: false },
};

function normalizeDatasetPlan(value: Record<string, unknown>): DatasetPlan | null {
  const table = typeof value.table === "string" && DATASET_ALLOWLIST[value.table] ? value.table : null;
  const config = table ? DATASET_ALLOWLIST[table] : null;
  const rawColumns = Array.isArray(value.columns) ? value.columns.filter((column): column is string => typeof column === "string") : [];
  const columns = config ? rawColumns.filter((column) => config.columns.has(column)).slice(0, 12) : [];
  const rawFilters = Array.isArray(value.filters) ? value.filters : [];
  const filters = config ? rawFilters.map((entry) => {
    const filter = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const column = typeof filter.column === "string" && config.columns.has(filter.column) ? filter.column : null;
    const operator = filter.operator;
    const value = typeof filter.value === "string" || typeof filter.value === "number" ? filter.value : null;
    return column && (operator === "eq" || operator === "ilike" || operator === "gte" || operator === "lte") && value !== null ? { column, operator, value } : null;
  }).filter((entry): entry is DatasetPlan["filters"][number] => entry !== null).slice(0, 4) : [];
  const rawLimit = Number(value.limit);
  return {
    in_scope: value.in_scope === true,
    table,
    columns,
    filters,
    aggregate: value.aggregate === "count" || value.aggregate === "sum" ? value.aggregate : "none",
    aggregate_column: config && typeof value.aggregate_column === "string" && config.columns.has(value.aggregate_column) ? value.aggregate_column : null,
    group_by: config && typeof value.group_by === "string" && config.columns.has(value.group_by) ? value.group_by : null,
    sort_column: config && typeof value.sort_column === "string" && config.columns.has(value.sort_column) ? value.sort_column : null,
    sort_direction: value.sort_direction === "asc" ? "asc" : "desc",
    limit: Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 50,
  };
}

async function classifyDatasetPlan(question: string): Promise<DatasetPlan | null> {
  const content = await callGeminiText(
    "Create a read-only FinCore dataset query plan as JSON only. Allowed tables are companies, users, vendors, invoices, payments, budgets, transactions, decisions, invoice_analysis, risk_alerts, forecast_records. Use only fields needed to answer. Set in_scope false for non-financial or external questions. Never request mutations, joins, raw SQL, credentials, or another company.",
    question,
    500,
  );
  const parsed = content ? parseJsonObject(content) : null;
  return parsed ? normalizeDatasetPlan(parsed) : null;
}

async function answerDatasetQuestion(supabase: SupabaseClient, companyId: string, question: string): Promise<string | null> {
  const plan = await classifyDatasetPlan(question);
  if (!plan || !plan.in_scope || !plan.table || !plan.columns.length) return null;
  const config = DATASET_ALLOWLIST[plan.table];
  let query = supabase.from(plan.table).select(plan.columns.join(","));
  if (config.companyScoped) query = query.eq("company_id", companyId);
  if (plan.table === "invoice_analysis") {
    const { data: scopedInvoices, error: scopedInvoiceError } = await supabase.from("invoices").select("invoice_id").eq("company_id", companyId).limit(500);
    if (scopedInvoiceError) throw scopedInvoiceError;
    const ids = (scopedInvoices ?? []).map((row) => row.invoice_id);
    if (!ids.length) return "No data was found in your company dataset.";
    query = query.in("invoice_id", ids);
  }
  for (const filter of plan.filters) {
    if (filter.operator === "eq") query = query.eq(filter.column, filter.value);
    if (filter.operator === "ilike") query = query.ilike(filter.column, `%${String(filter.value).replace(/[%_]/g, "")}%`);
    if (filter.operator === "gte") query = query.gte(filter.column, filter.value);
    if (filter.operator === "lte") query = query.lte(filter.column, filter.value);
  }
  if (plan.sort_column) query = query.order(plan.sort_column, { ascending: plan.sort_direction === "asc" });
  const { data, error } = await query.limit(plan.limit);
  if (error) throw error;
  const rows = data ?? [];
  if (!rows.length) return "No matching records were found in your company dataset.";
  const aggregateValue = plan.aggregate === "count" ? rows.length : plan.aggregate === "sum" && plan.aggregate_column ? rows.reduce((sum, row) => sum + Number(row[plan.aggregate_column!] ?? 0), 0) : null;
  const facts = JSON.stringify({ table: plan.table, row_count: rows.length, aggregate: aggregateValue, rows }, null, 2).slice(0, 18000);
  return explainFinancialFacts(question, `The following are the only authorized company-scoped database facts:\n${facts}`);
}

async function answerFinancialQuestion(supabase: SupabaseClient, companyId: string, question: string): Promise<string> {
  const lower = question.toLowerCase();
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const { data: invoices, error: invoiceError } = await supabase
    .from("invoices")
    .select("invoice_id,vendor_id,department,subtotal,tax_amount,total_amount,currency,date,due_date,status")
    .eq("company_id", companyId)
    .limit(500);
  if (invoiceError) throw invoiceError;
  const rows = invoices ?? [];
  let facts = "";

  if (/(how many datasets|number of datasets|datasets.*present)/.test(lower)) {
    const datasetNames = ["companies", "users", "vendors", "invoices", "payments", "budgets", "transactions", "decisions", "invoice_analysis", "risk_alerts", "forecast_records"];
    const counts = await Promise.all(datasetNames.map(async (table) => {
      if (table === "invoice_analysis") {
        const { data: scopedInvoices, error: invoiceError } = await supabase.from("invoices").select("invoice_id").eq("company_id", companyId).limit(500);
        if (invoiceError || !scopedInvoices?.length) return { table, count: invoiceError ? null : 0 };
        const { count, error } = await supabase.from(table).select("invoice_id", { count: "exact", head: true }).in("invoice_id", scopedInvoices.map((row) => row.invoice_id));
        return { table, count: error ? null : count ?? 0 };
      }
      const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true }).eq("company_id", companyId);
      return { table, count: error ? null : count ?? 0 };
    }));
    facts = ["FinCore currently exposes these approved company-scoped datasets:", ...counts.map((item) => `- ${item.table}: ${item.count === null ? "unavailable" : `${item.count} records`}`)].join(NL);
  } else if (/(how many invoices|number of invoices|invoice count|invoices.*do we have)/.test(lower)) {
    const { count, error } = await supabase.from("invoices").select("invoice_id", { count: "exact", head: true }).eq("company_id", companyId);
    if (error) throw error;
    facts = `Your company currently has ${count ?? 0} invoices in the FinCore Database.`;
  } else if (/(how much.*spend|spend this month|monthly spend|overview)/.test(lower)) {
    const monthlySpend = rows.filter((row) => String(row.date).startsWith(currentPeriod)).reduce((sum, row) => sum + Number(row.total_amount), 0);
    const { data: budgets, error: budgetError } = await supabase.from("budgets").select("allocated,spent").eq("company_id", companyId).eq("period", currentPeriod);
    if (budgetError) throw budgetError;
    const allocated = (budgets ?? []).reduce((sum, row) => sum + Number(row.allocated), 0);
    const spent = (budgets ?? []).reduce((sum, row) => sum + Number(row.spent), 0);
    facts = `Monthly spend for ${currentPeriod}: INR ${monthlySpend.toFixed(2)}. Budget utilization: ${allocated > 0 ? Math.round((spent / allocated) * 100) : 0}%. Pending invoices: ${rows.filter((row) => row.status === "Pending").length}.`;
  } else if (/(highest spend|top vendor|biggest vendor)/.test(lower)) {
    const { data: vendors, error: vendorError } = await supabase.from("vendors").select("vendor_id,name").eq("company_id", companyId);
    if (vendorError) throw vendorError;
    const ranked = (vendors ?? []).map((vendor) => ({ name: vendor.name, total: rows.filter((row) => row.vendor_id === vendor.vendor_id).reduce((sum, row) => sum + Number(row.total_amount), 0) })).sort((a, b) => b.total - a.total).slice(0, 5);
    facts = ranked.length ? ["Top vendors by total spend:", ...ranked.map((row, index) => `${index + 1}. ${row.name}: INR ${row.total.toFixed(2)}`)].join(NL) : "No vendor spend data was found for this company.";
  } else if (/(pending invoice|unpaid invoice)/.test(lower)) {
    const pending = rows.filter((row) => row.status === "Pending" || row.status === "Overdue").sort((a, b) => Number(b.total_amount) - Number(a.total_amount)).slice(0, 5);
    facts = pending.length ? ["Pending invoices:", ...pending.map((row) => `${row.invoice_id}: INR ${Number(row.total_amount).toFixed(2)} (${row.status})`)].join(NL) : "No pending invoices right now.";
  } else if (/(risky|suspicious|risk alert|anomal)/.test(lower)) {
    const { data: analyses, error: analysisError } = await supabase.from("invoice_analysis").select("invoice_id,anomaly_score,duplicate_score,vendor_risk_snapshot").in("invoice_id", rows.filter((row) => row.status === "Pending").map((row) => row.invoice_id)).order("anomaly_score", { ascending: false }).limit(5);
    if (analysisError) throw analysisError;
    facts = analyses?.length ? ["Highest-risk pending invoices:", ...analyses.map((row) => `${row.invoice_id}: anomaly ${Number(row.anomaly_score ?? 0)}/100, duplicate ${Number(row.duplicate_score ?? 0)}%, vendor risk ${(row.vendor_risk_snapshot as Record<string, unknown> | null)?.computed_risk ?? "unknown"}`)].join(NL) : "No analyzed risk alerts were found.";
  } else if (/(over budget|overspend|budget left|remaining budget|how much budget)/.test(lower)) {
    const { data: budgets, error: budgetError } = await supabase.from("budgets").select("department,allocated,spent,remaining").eq("company_id", companyId).eq("period", currentPeriod).order("remaining", { ascending: true }).limit(10);
    if (budgetError) throw budgetError;
    facts = budgets?.length ? ["Budget status:", ...budgets.map((row) => `${row.department}: INR ${Number(row.remaining).toFixed(2)} remaining (${Number(row.allocated) > 0 ? Math.round((Number(row.spent) / Number(row.allocated)) * 100) : 0}% used)`)].join(NL) : `No budget was found for ${currentPeriod}.`;
  } else if (/(afford|can we pay|can i pay)/.test(lower)) {
    const amount = extractQuestionAmount(question);
    if (amount === null) return "Please include an invoice amount, for example: Can we afford an INR 300000 invoice?";
    const { data: budgets, error: budgetError } = await supabase.from("budgets").select("department,allocated,spent,remaining").eq("company_id", companyId).eq("period", currentPeriod).limit(20);
    if (budgetError) throw budgetError;
    const totalAllocated = (budgets ?? []).reduce((sum, row) => sum + Number(row.allocated), 0);
    const totalSpent = (budgets ?? []).reduce((sum, row) => sum + Number(row.spent), 0);
    facts = `Affordability check for INR ${amount.toFixed(2)}: current spend INR ${totalSpent.toFixed(2)} of INR ${totalAllocated.toFixed(2)}; projected utilization after payment ${totalAllocated > 0 ? Math.round(((totalSpent + amount) / totalAllocated) * 100) : 0}%. This is a budget arithmetic check, not an approval.`;
  } else if (/(cash position|cash flow|forecast)/.test(lower)) {
    const { data: transactions, error: transactionError } = await supabase.from("transactions").select("type,amount,date").eq("company_id", companyId).limit(1000);
    if (transactionError) throw transactionError;
    const inflow = (transactions ?? []).filter((row) => row.type === "inflow").reduce((sum, row) => sum + Number(row.amount), 0);
    const outflow = (transactions ?? []).filter((row) => row.type === "outflow").reduce((sum, row) => sum + Number(row.amount), 0);
    facts = `Historical cash-flow summary: inflow INR ${inflow.toFixed(2)}, outflow INR ${outflow.toFixed(2)}, net INR ${(inflow - outflow).toFixed(2)}. Estimate based on historical patterns - not a guaranteed forecast.`;
  } else {
    return ["I can answer questions about:", "- monthly spend and overview", "- top vendors", "- pending or risky invoices", "- budgets and affordability", "- cash-flow summaries", "", "Please rephrase your question or type menu."].join(NL);
  }
  return explainFinancialFacts(question, facts);
}

const WORKFLOW_ROLES = new Set(["admin", "finance_manager", "department_head"]);

async function scanCompanyAlerts(supabase: SupabaseClient, companyId: string): Promise<string> {
  const { data: invoices, error: invoiceError } = await supabase.from("invoices").select("invoice_id,vendor_id,status").eq("company_id", companyId).in("status", ["Pending", "Overdue"]);
  if (invoiceError) throw invoiceError;
  const invoiceIds = (invoices ?? []).map((invoice) => invoice.invoice_id);
  if (!invoiceIds.length) return "No pending invoices currently need attention.";
  const { data: analyses, error: analysisError } = await supabase.from("invoice_analysis").select("invoice_id,duplicate_score,vendor_risk_snapshot,anomaly_score").in("invoice_id", invoiceIds);
  if (analysisError) throw analysisError;
  const { data: decisions, error: decisionError } = await supabase.from("decisions").select("invoice_id,recommendation,reasoning").in("invoice_id", invoiceIds);
  if (decisionError) throw decisionError;
  const analysisById = new Map((analyses ?? []).map((row) => [row.invoice_id, row]));
  const decisionById = new Map((decisions ?? []).map((row) => [row.invoice_id, row]));
  const candidates = (invoices ?? []).map((invoice) => {
    const analysis = analysisById.get(invoice.invoice_id);
    const decision = decisionById.get(invoice.invoice_id);
    const risk = (analysis?.vendor_risk_snapshot ?? {}) as Record<string, unknown>;
    const score = Number(analysis?.anomaly_score ?? 0);
    const severity = decision?.recommendation === "Reject" || String(risk.computed_risk) === "High" || score >= 85 ? "high" : decision?.recommendation === "Flag for Review" || Number(analysis?.duplicate_score ?? 0) >= 70 || score >= 60 ? "medium" : null;
    return { invoice, analysis, decision, risk, score, severity };
  }).filter((item) => item.severity);
  if (!candidates.length) return "No open risk alerts found.";
  for (const item of candidates) {
    const alertType = item.decision?.recommendation === "Reject" ? "decision_reject" : Number(item.analysis?.duplicate_score ?? 0) >= 70 ? "duplicate_invoice" : "invoice_anomaly";
    const { data: existing, error: existingError } = await supabase.from("risk_alerts").select("id").eq("company_id", companyId).eq("related_invoice_id", item.invoice.invoice_id).eq("alert_type", alertType).eq("status", "open").maybeSingle();
    if (existingError) throw existingError;
    if (!existing) {
      const { error: insertError } = await supabase.from("risk_alerts").insert({
        company_id: companyId,
        alert_type: alertType,
        severity: item.severity,
        related_invoice_id: item.invoice.invoice_id,
        related_vendor_id: item.invoice.vendor_id,
        message: item.decision?.reasoning ?? `Anomaly score ${item.score}/100`,
        status: "open",
      });
      if (insertError) throw insertError;
    }
  }
  const ordered = candidates.sort((a, b) => ({ high: 3, medium: 2, low: 1 }[b.severity!] - ({ high: 3, medium: 2, low: 1 }[a.severity!] as number))).slice(0, 5);
  return ["Open risk alerts:", ...ordered.map((item) => `- ${item.invoice.invoice_id}: ${item.severity} — ${item.decision?.reasoning ?? `Anomaly ${item.score}/100`}`)].join(NL);
}

async function handleWorkflowCommand(supabase: SupabaseClient, userId: string, companyId: string, role: string, text: string): Promise<string | null> {
  const lower = text.trim().toLowerCase();
  if (lower === "alerts" || lower === "risk alerts") return scanCompanyAlerts(supabase, companyId);
  const resolveMatch = lower.match(/^resolve alert ([0-9a-f-]+)$/i);
  if (resolveMatch) {
    if (!WORKFLOW_ROLES.has(role)) return "You do not have permission to resolve alerts.";
    const { data: alert, error: alertError } = await supabase.from("risk_alerts").select("id").eq("id", resolveMatch[1]).eq("company_id", companyId).eq("status", "open").maybeSingle();
    if (alertError) throw alertError;
    if (!alert) return "That alert was not found for your company or is already resolved.";
    const { error: updateError } = await supabase.from("risk_alerts").update({ status: "resolved", resolved_at: new Date().toISOString(), resolved_by: userId }).eq("id", alert.id).eq("company_id", companyId);
    if (updateError) throw updateError;
    return `Alert ${alert.id} resolved.`;
  }
  const actionMatch = lower.match(/^(approve|review|defer|reject)\s+(inv-[a-z0-9]+)$/i);
  if (!actionMatch) return null;
  if (!WORKFLOW_ROLES.has(role)) return "You do not have permission to perform invoice workflow actions.";
  const action = actionMatch[1].toLowerCase();
  const invoiceId = actionMatch[2].toUpperCase();
  const { data: invoice, error: invoiceError } = await supabase.from("invoices").select("invoice_id,status").eq("invoice_id", invoiceId).eq("company_id", companyId).maybeSingle();
  if (invoiceError) throw invoiceError;
  if (!invoice) return "That invoice was not found for your company.";
  const { data: decision, error: decisionError } = await supabase.from("decisions").select("recommendation").eq("invoice_id", invoiceId).maybeSingle();
  if (decisionError) throw decisionError;
  if (!decision) return "This invoice does not have a system recommendation yet.";
  const { error: actionError } = await supabase.from("invoice_actions").insert({
    invoice_id: invoiceId,
    company_id: companyId,
    action,
    previous_status: invoice.status,
    new_status: invoice.status,
    performed_by: userId,
    reason: `User requested ${action}; system recommendation was ${decision.recommendation}. Invoice status remains ${invoice.status}.`,
  });
  if (actionError) throw actionError;
  return `${action.toUpperCase()} recorded for ${invoiceId}. The invoice remains ${invoice.status} until the payment/status workflow is completed.`;
}

async function handleForecastCommand(supabase: SupabaseClient, companyId: string, question: string): Promise<string | null> {
  const match = question.toLowerCase().match(/\b(30|60|90)\s*(?:day|days)?\b/);
  if (!/(forecast|cash flow|cash position)/i.test(question) && !match) return null;
  const horizon = (Number(match?.[1] ?? 30) as 30 | 60 | 90);
  const { data: transactions, error: transactionError } = await supabase
    .from("transactions")
    .select("date,type,category,amount")
    .eq("company_id", companyId)
    .order("date", { ascending: true })
    .limit(2000);
  if (transactionError) throw transactionError;
  const referenceDate = Date.now();
  const lookbackStart = referenceDate - 90 * 86400000;
  const history = (transactions ?? []).filter((transaction) => {
    const date = new Date(transaction.date).getTime();
    return Number.isFinite(date) && date >= lookbackStart && date <= referenceDate;
  });
  const inflow = history.filter((transaction) => transaction.type === "inflow");
  const outflow = history.filter((transaction) => transaction.type === "outflow");
  const totalInflow = inflow.reduce((sum, transaction) => sum + Number(transaction.amount), 0);
  const totalOutflow = outflow.reduce((sum, transaction) => sum + Number(transaction.amount), 0);
  const projectedInflow = (totalInflow / 90) * horizon;
  const projectedOutflow = (totalOutflow / 90) * horizon;
  const cumulativePosition = (transactions ?? []).filter((transaction) => new Date(transaction.date).getTime() <= referenceDate).reduce((sum, transaction) => sum + (transaction.type === "inflow" ? Number(transaction.amount) : -Number(transaction.amount)), 0);
  const topCategories = (type: string) => {
    const totals = new Map<string, number>();
    for (const transaction of history.filter((item) => item.type === type)) totals.set(transaction.category, (totals.get(transaction.category) ?? 0) + Number(transaction.amount));
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category, amount]) => `${category}: INR ${amount.toFixed(2)}`);
  };
  const disclaimer = "Estimate based on recent historical patterns in your transaction data — not a guaranteed forecast.";
  const forecast = {
    horizon_days: horizon,
    projected_inflow: projectedInflow,
    projected_outflow: projectedOutflow,
    projected_net: projectedInflow - projectedOutflow,
    projected_cash_position: cumulativePosition + projectedInflow - projectedOutflow,
    top_contributors: { inflow: topCategories("inflow"), outflow: topCategories("outflow") },
    disclaimer,
  };
  const { data: existing, error: existingError } = await supabase.from("forecast_records").select("id").eq("company_id", companyId).eq("horizon_days", horizon).maybeSingle();
  if (existingError) throw existingError;
  const forecastPayload = { ...forecast, company_id: companyId, generated_at: new Date().toISOString() };
  const { error: persistError } = existing
    ? await supabase.from("forecast_records").update(forecastPayload).eq("id", existing.id)
    : await supabase.from("forecast_records").insert(forecastPayload);
  if (persistError) throw persistError;
  if (!history.length) return `There is not enough transaction history for a reliable ${horizon}-day forecast. No values were invented. ${disclaimer}`;
  return [`${horizon}-day cash-flow estimate`, `Projected inflow: INR ${projectedInflow.toFixed(2)}`, `Projected outflow: INR ${projectedOutflow.toFixed(2)}`, `Projected net: INR ${(projectedInflow - projectedOutflow).toFixed(2)}`, `Projected cash position: INR ${forecast.projected_cash_position.toFixed(2)}`, `Top outflow categories: ${topCategories("outflow").join(", ") || "none"}`, "", disclaimer].join(NL);
}

// ---- Onboarding + OTP (Phase 4) -------------------------------------------

interface OnboardingContext {
  name?: string;
  companyName?: string;
  isNewCompany?: boolean;
  resolvedCompanyId?: string;
  roleTitle?: string;
  industry?: string;
  monthlySpend?: string;
  email?: string;
  otpSessionId?: string;
  otpHash?: string;
  otpExpiresAt?: string;
  otpAttempts?: number;
  recoveryUserId?: string;
  recoveryName?: string;
  recoveryCompanyId?: string;
}

async function sha256Hex(text: string): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateOtp(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

function isValidEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

async function sendOtpEmail(email: string, code: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetchWithTimeout("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "FinCore AI <onboarding@resend.dev>",
        to: [email],
        subject: "Your FinCore AI verification code",
        text: `Your FinCore AI verification code is ${code}. It expires in 10 minutes.`,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      return { success: false, error: data?.message ?? `Resend request failed (${response.status})` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error sending email" };
  }
}

async function updateSession(supabase: SupabaseClient, sessionId: string, state: string, context: OnboardingContext) {
  const { error } = await supabase.from("conversation_sessions").update({ state, context }).eq("id", sessionId);
  if (error) throw error;
}

async function insertAuthLog(
  supabase: SupabaseClient,
  eventType: string,
  success: boolean,
  userId?: string | null,
  companyId?: string | null
) {
  const { error } = await supabase.from("auth_log").insert({
    log_id: newId("LOG"),
    event_type: eventType,
    success,
    user_id: userId ?? null,
    company_id: companyId ?? null,
    device: "whatsapp",
  });
  if (error) throw error;
}

/** Runs one step of the onboarding/OTP state machine and returns the reply text. Mutates the DB as a side effect. */
async function handleOnboardingMessage(
  supabase: SupabaseClient,
  sessionId: string,
  state: string,
  context: OnboardingContext,
  waId: string,
  messageType: string,
  content: string
): Promise<string> {
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();

  if (state === "new" || !state) {
    if (messageType === "text" && /^(login|recover( account)?)/.test(lower)) {
      await updateSession(supabase, sessionId, "recovery_email", {});
      return "Let's get you back in. What's the recovery email registered to your FinCore account?";
    }
    await updateSession(supabase, sessionId, "onboarding_name", {});
    return ["Hi! I'm FinCore AI, your financial intelligence assistant.", "", "Let's set up your account. What's your name?"].join(NL);
  }

  if (messageType !== "text") {
    return "Please reply with text to continue setting up your account.";
  }

  switch (state) {
    case "onboarding_name": {
      if (!trimmed) return "What's your name?";
      await updateSession(supabase, sessionId, "onboarding_company", { ...context, name: trimmed });
      return `Nice to meet you, ${trimmed}! What's your company or business name?`;
    }

    case "onboarding_company": {
      if (!trimmed) return "What's your company or business name?";
      const escaped = trimmed.replace(/[%_]/g, (m) => "\\" + m);
      const { data: match, error } = await supabase.from("companies").select("company_id,name").ilike("name", escaped).maybeSingle();
      if (error) throw error;

      const nextContext: OnboardingContext = match
        ? { ...context, companyName: trimmed, isNewCompany: false, resolvedCompanyId: match.company_id }
        : { ...context, companyName: trimmed, isNewCompany: true };
      await updateSession(supabase, sessionId, "onboarding_role", nextContext);

      const lines: string[] = [];
      if (match) {
        lines.push(`${match.name} is already on FinCore AI - I'll add you to that team.`, "");
      }
      lines.push(`What's your role at ${trimmed}?`);
      return lines.join(NL);
    }

    case "onboarding_role": {
      if (!trimmed) return "What's your role?";
      await updateSession(supabase, sessionId, "onboarding_industry", { ...context, roleTitle: trimmed });
      return "What's your business type or industry?";
    }

    case "onboarding_industry": {
      if (!trimmed) return "What's your business type or industry?";
      await updateSession(supabase, sessionId, "onboarding_spend", { ...context, industry: trimmed });
      return "Roughly what's your monthly financial activity or spend (e.g. 500000)?";
    }

    case "onboarding_spend": {
      if (!trimmed) return "Roughly what's your monthly financial activity or spend?";
      await updateSession(supabase, sessionId, "onboarding_email", { ...context, monthlySpend: trimmed });
      return "Last step - what's a recovery email we can use if you ever switch phones?";
    }

    case "onboarding_email": {
      if (!isValidEmail(trimmed)) return "That doesn't look like a valid email. Please try again.";

      const code = generateOtp();
      const otpHash = await sha256Hex(code);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const { data: otpRow, error: otpError } = await supabase
        .from("otp_sessions")
        .insert({
          channel: "email",
          destination: trimmed,
          otp_hash: otpHash,
          purpose: "signup_email_verify",
          expires_at: expiresAt,
          max_attempts: 5,
          status: "pending",
          requester_phone: waId,
        })
        .select("id")
        .single();
      if (otpError) throw otpError;

      const emailResult = await sendOtpEmail(trimmed, code);
      if (!emailResult.success) {
        console.error(`whatsapp-webhook: failed to send OTP email to ${trimmed}: ${emailResult.error}`);
      }

      await updateSession(supabase, sessionId, "onboarding_otp", {
        ...context,
        email: trimmed,
        otpSessionId: otpRow.id,
        otpHash,
        otpExpiresAt: expiresAt,
        otpAttempts: 0,
      });
      return `I've sent a 6-digit verification code to ${trimmed}. Reply with the code to confirm (it expires in 10 minutes).`;
    }

    case "onboarding_otp": {
      if (!context.otpHash || !context.otpExpiresAt) {
        await updateSession(supabase, sessionId, "new", {});
        return "Something went wrong with your verification. Type 'Hi' to start again.";
      }

      if (Date.now() > new Date(context.otpExpiresAt).getTime()) {
        if (context.otpSessionId) await supabase.from("otp_sessions").update({ status: "expired" }).eq("id", context.otpSessionId);
        await updateSession(supabase, sessionId, "new", {});
        return "That code expired. Type 'Hi' to start again.";
      }

      const inputHash = await sha256Hex(trimmed);
      if (inputHash !== context.otpHash) {
        const attempts = (context.otpAttempts ?? 0) + 1;
        if (attempts >= 5) {
          if (context.otpSessionId) await supabase.from("otp_sessions").update({ status: "locked", attempt_count: attempts }).eq("id", context.otpSessionId);
          await updateSession(supabase, sessionId, "new", {});
          return "Too many incorrect attempts. Type 'Hi' to start again.";
        }
        if (context.otpSessionId) await supabase.from("otp_sessions").update({ attempt_count: attempts }).eq("id", context.otpSessionId);
        await updateSession(supabase, sessionId, "onboarding_otp", { ...context, otpAttempts: attempts });
        return `That code doesn't match. Attempts left: ${5 - attempts}.`;
      }

      if (context.otpSessionId) await supabase.from("otp_sessions").update({ status: "verified" }).eq("id", context.otpSessionId);

      let companyId: string;
      let role: string;
      if (context.isNewCompany) {
        companyId = newId("CO");
        const { error: companyError } = await supabase.from("companies").insert({
          company_id: companyId,
          name: context.companyName ?? "My Company",
          industry: context.industry ?? null,
          country: "India",
          plan_tier: "Growth",
        });
        if (companyError) throw companyError;
        role = "admin";
      } else {
        companyId = context.resolvedCompanyId!;
        role = "viewer";
      }

      const userId = newId("USR");
      const { error: userError } = await supabase.from("users").insert({
        user_id: userId,
        name: context.name ?? "FinCore User",
        email: context.email!,
        role,
        company_id: companyId,
      });
      if (userError) throw userError;

      const { error: authMethodError } = await supabase.from("auth_methods").insert({
        user_id: userId,
        method_type: "recovery_email",
        value: context.email!,
        verified_at: new Date().toISOString(),
      });
      if (authMethodError) throw authMethodError;

      const { error: linkError } = await supabase.from("whatsapp_accounts").insert({
        user_id: userId,
        phone_number: waId,
        wa_id: waId,
        status: "active",
        last_inbound_at: new Date().toISOString(),
      });
      if (linkError) throw linkError;

      await updateSession(supabase, sessionId, "active", {});
      return [`Your FinCore account has been created. Welcome, ${context.name ?? "there"}!`, "", MENU_TEXT].join(NL);
    }

    case "recovery_email": {
      if (!isValidEmail(trimmed)) return "That doesn't look like a valid email. Please try again.";

      const { data: methodRow, error: methodError } = await supabase
        .from("auth_methods")
        .select("user_id")
        .eq("method_type", "recovery_email")
        .not("verified_at", "is", null)
        .ilike("value", trimmed)
        .limit(1)
        .maybeSingle();
      if (methodError) throw methodError;

      if (!methodRow) {
        await insertAuthLog(supabase, "login_failed", false);
        return "I couldn't find a FinCore account with that email. Type 'Hi' to create a new account, or reply with a different recovery email.";
      }

      const { data: matchedUser, error: userLookupError } = await supabase
        .from("users")
        .select("user_id,name,company_id,account_status")
        .eq("user_id", methodRow.user_id)
        .maybeSingle();
      if (userLookupError) throw userLookupError;

      if (!matchedUser || matchedUser.account_status !== "Active") {
        await insertAuthLog(supabase, "login_failed", false, matchedUser?.user_id, matchedUser?.company_id);
        await updateSession(supabase, sessionId, "new", {});
        return "This account is currently locked or suspended. Please contact your FinCore admin for help.";
      }

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count: recentOtpCount, error: rateLimitError } = await supabase
        .from("otp_sessions")
        .select("id", { count: "exact", head: true })
        .eq("requester_phone", waId)
        .eq("purpose", "account_recovery")
        .gt("created_at", oneHourAgo);
      if (rateLimitError) throw rateLimitError;

      if ((recentOtpCount ?? 0) >= 5) {
        return "Too many recovery attempts from this number. Please try again later.";
      }

      const code = generateOtp();
      const otpHash = await sha256Hex(code);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const { data: otpRow, error: otpError } = await supabase
        .from("otp_sessions")
        .insert({
          channel: "email",
          destination: trimmed,
          otp_hash: otpHash,
          purpose: "account_recovery",
          expires_at: expiresAt,
          max_attempts: 5,
          status: "pending",
          requester_phone: waId,
          user_id: matchedUser.user_id,
        })
        .select("id")
        .single();
      if (otpError) throw otpError;

      const emailResult = await sendOtpEmail(trimmed, code);
      if (!emailResult.success) {
        console.error(`whatsapp-webhook: failed to send recovery OTP email to ${trimmed}: ${emailResult.error}`);
      }

      await insertAuthLog(supabase, "otp_requested", true, matchedUser.user_id, matchedUser.company_id);

      await updateSession(supabase, sessionId, "recovery_otp", {
        recoveryUserId: matchedUser.user_id,
        recoveryName: matchedUser.name,
        recoveryCompanyId: matchedUser.company_id,
        otpSessionId: otpRow.id,
        otpHash,
        otpExpiresAt: expiresAt,
        otpAttempts: 0,
      });
      return `I've sent a 6-digit recovery code to ${trimmed}. Reply with the code to confirm (it expires in 10 minutes).`;
    }

    case "recovery_otp": {
      if (!context.otpHash || !context.otpExpiresAt || !context.recoveryUserId) {
        await updateSession(supabase, sessionId, "new", {});
        return "Something went wrong with your recovery. Type 'login' to start again.";
      }

      if (Date.now() > new Date(context.otpExpiresAt).getTime()) {
        if (context.otpSessionId) await supabase.from("otp_sessions").update({ status: "expired" }).eq("id", context.otpSessionId);
        await updateSession(supabase, sessionId, "new", {});
        return "That code expired. Type 'login' to start again.";
      }

      const recoveryInputHash = await sha256Hex(trimmed);
      if (recoveryInputHash !== context.otpHash) {
        const attempts = (context.otpAttempts ?? 0) + 1;
        if (attempts >= 5) {
          if (context.otpSessionId) await supabase.from("otp_sessions").update({ status: "locked", attempt_count: attempts }).eq("id", context.otpSessionId);
          const { error: lockError } = await supabase.from("users").update({ account_status: "Locked" }).eq("user_id", context.recoveryUserId);
          if (lockError) throw lockError;
          await insertAuthLog(supabase, "account_locked", false, context.recoveryUserId, context.recoveryCompanyId);
          await updateSession(supabase, sessionId, "new", {});
          return "Too many incorrect attempts. Your account has been locked for security. Contact your FinCore admin to unlock it.";
        }
        if (context.otpSessionId) await supabase.from("otp_sessions").update({ attempt_count: attempts }).eq("id", context.otpSessionId);
        await updateSession(supabase, sessionId, "recovery_otp", { ...context, otpAttempts: attempts });
        return `That code doesn't match. Attempts left: ${5 - attempts}.`;
      }

      if (context.otpSessionId) await supabase.from("otp_sessions").update({ status: "verified" }).eq("id", context.otpSessionId);
      await insertAuthLog(supabase, "otp_verified", true, context.recoveryUserId, context.recoveryCompanyId);

      const { error: unlinkError } = await supabase
        .from("whatsapp_accounts")
        .update({ status: "unlinked" })
        .eq("user_id", context.recoveryUserId)
        .eq("status", "active")
        .neq("phone_number", waId);
      if (unlinkError) throw unlinkError;

      // phone_number is globally unique, so a number that was previously
      // linked (to this or any other account) already has a row - reuse it
      // instead of inserting, which would violate that uniqueness.
      const { data: existingNumberRow, error: existingNumberError } = await supabase
        .from("whatsapp_accounts")
        .select("id")
        .eq("phone_number", waId)
        .maybeSingle();
      if (existingNumberError) throw existingNumberError;

      if (existingNumberRow) {
        const { error: reuseError } = await supabase
          .from("whatsapp_accounts")
          .update({
            user_id: context.recoveryUserId,
            wa_id: waId,
            status: "active",
            linked_at: new Date().toISOString(),
            last_inbound_at: new Date().toISOString(),
          })
          .eq("id", existingNumberRow.id);
        if (reuseError) throw reuseError;
      } else {
        const { error: relinkError } = await supabase.from("whatsapp_accounts").insert({
          user_id: context.recoveryUserId,
          phone_number: waId,
          wa_id: waId,
          status: "active",
          last_inbound_at: new Date().toISOString(),
        });
        if (relinkError) throw relinkError;
      }

      await insertAuthLog(supabase, "login_success", true, context.recoveryUserId, context.recoveryCompanyId);

      await updateSession(supabase, sessionId, "active", {});
      return [`Welcome back, ${context.recoveryName ?? "there"}! Your FinCore account is now linked to this number.`, "", MENU_TEXT].join(NL);
    }

    default: {
      await updateSession(supabase, sessionId, "new", {});
      return "Something went off track. Type 'Hi' to start again.";
    }
  }
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
      const { error: receiptError } = await supabase.from("whatsapp_message_receipts").insert({
        wa_message_id: message.id,
        wa_id: waId,
      });
      if (receiptError) {
        if (receiptError.code === "23505") {
          console.info(`whatsapp-webhook: ignoring duplicate Meta message ${message.id}`);
          continue;
        }
        throw receiptError;
      }
      const summary = summarizeInboundMessage(message);
      const { messageType, content } = summary;

      // Bootstrap (or reuse) this contact's conversation session.
      const { data: existingSession, error: fetchError } = await supabase
        .from("conversation_sessions")
        .select("id, state, context")
        .eq("wa_id", waId)
        .maybeSingle();
      if (fetchError) throw fetchError;

      let sessionId: string;
      let sessionState: string;
      let sessionContext: OnboardingContext;

      if (existingSession) {
        sessionId = existingSession.id;
        sessionState = existingSession.state;
        sessionContext = (existingSession.context ?? {}) as OnboardingContext;
        const { error: touchError } = await supabase
          .from("conversation_sessions")
          .update({ last_message_at: new Date().toISOString() })
          .eq("id", sessionId);
        if (touchError) throw touchError;
      } else {
        const { data: createdSession, error: createError } = await supabase
          .from("conversation_sessions")
          .insert({ wa_id: waId, state: "new" })
          .select("id, state, context")
          .single();
        if (createError) throw createError;
        sessionId = createdSession.id;
        sessionState = createdSession.state;
        sessionContext = (createdSession.context ?? {}) as OnboardingContext;
      }

      const { error: inboundInsertError } = await supabase.from("conversation_messages").insert({
        session_id: sessionId,
        direction: "inbound",
        message_type: messageType,
        content,
        wa_message_id: message.id,
      });
      if (inboundInsertError) throw inboundInsertError;

      // Identity: is this WhatsApp number already linked to a FinCore account?
      const { data: linkedAccount, error: linkedAccountError } = await supabase
        .from("whatsapp_accounts")
        .select("user_id")
        .eq("wa_id", waId)
        .eq("status", "active")
        .maybeSingle();
      if (linkedAccountError) throw linkedAccountError;

      let replyText: string;
      if (!linkedAccount) {
        replyText = await handleOnboardingMessage(supabase, sessionId, sessionState, sessionContext, waId, messageType, content);
      } else if ((messageType === "image" || messageType === "document") && linkedAccount.user_id) {
        const { data: linkedUser, error: linkedUserError } = await supabase
          .from("users")
          .select("company_id")
          .eq("user_id", linkedAccount.user_id)
          .maybeSingle();
        if (linkedUserError) throw linkedUserError;
        if (!linkedUser) throw new Error("Linked WhatsApp account has no user record");
        const interimReply = "OCR output will be ready shortly.";
        const { error: interimInsertError } = await supabase.from("conversation_messages").insert({
          session_id: sessionId,
          direction: "outbound",
          message_type: "text",
          content: interimReply,
        });
        if (interimInsertError) throw interimInsertError;
        const interimSendResult = await sendWhatsAppText(waId, interimReply, ACCESS_TOKEN, PHONE_NUMBER_ID);
        if (!interimSendResult.success) {
          console.error(`whatsapp-webhook: failed to send OCR interim reply to ${waId}: ${interimSendResult.error}`);
        }
        const ingestResult = await ingestWhatsAppInvoice(supabase, summary, linkedUser.company_id, linkedAccount.user_id);
        if (!ingestResult.success) {
          replyText = ingestResult.errorMessage;
        } else if (ingestResult.invoiceId && ingestResult.storagePath && ingestResult.mimeType) {
          const analysisResult = await analyzeStoredInvoice(
            supabase,
            ingestResult.invoiceId,
            ingestResult.storagePath,
            ingestResult.mimeType,
            linkedUser.company_id,
          );
          if (analysisResult.success) {
            const intelligenceResult = await enrichInvoiceIntelligence(supabase, ingestResult.invoiceId, linkedUser.company_id);
            const anomalyResult = await enrichBudgetAndAnomalies(supabase, ingestResult.invoiceId, linkedUser.company_id);
            const decisionResult = await createInvoiceDecision(supabase, ingestResult.invoiceId, linkedUser.company_id);
            replyText = [analysisResult.summary, intelligenceResult.summary, anomalyResult.summary, decisionResult.summary].join(NL);
          } else {
            replyText = `Invoice ${ingestResult.invoiceId} received. ${analysisResult.summary}`;
          }
        } else {
          replyText = `Invoice ${ingestResult.invoiceId} received and stored safely.`;
        }
      } else {
        if (messageType === "text" && GREETING_PATTERN.test(content.trim())) {
          replyText = buildReply(messageType, content);
        } else if (linkedAccount.user_id) {
          const { data: linkedUser, error: linkedUserError } = await supabase.from("users").select("company_id,role").eq("user_id", linkedAccount.user_id).maybeSingle();
          if (linkedUserError) throw linkedUserError;
          if (!linkedUser) throw new Error("Linked WhatsApp account has no user record");
          const normalizedContent = content.trim().toLowerCase();
          if (/^(clear|clear chat|clear history|delete chat|delete history)$/.test(normalizedContent)) {
            replyText = await clearChatHistory(supabase, sessionId);
          } else {
            const numericReply = await handleNumericMenu(supabase, linkedUser.company_id, content);
            const forecastReply = numericReply ?? await handleForecastCommand(supabase, linkedUser.company_id, content);
          const workflowReply = forecastReply ?? await handleWorkflowCommand(supabase, linkedAccount.user_id, linkedUser.company_id, linkedUser.role, content);
          if (workflowReply) {
            replyText = workflowReply;
          } else {
            const intent = await classifyNaturalLanguageCommand(content);
            if (intent?.intent === "alerts") {
              replyText = await scanCompanyAlerts(supabase, linkedUser.company_id);
            } else if (intent?.intent === "workflow_action" && intent.action && intent.invoice_id) {
              replyText = await handleWorkflowCommand(supabase, linkedAccount.user_id, linkedUser.company_id, linkedUser.role, `${intent.action} ${intent.invoice_id}`) ?? "I couldn't interpret that workflow action.";
            } else if (intent?.intent === "forecast") {
              replyText = await handleForecastCommand(supabase, linkedUser.company_id, `${intent.horizon_days ?? 30} day forecast`) ?? "I couldn't interpret that forecast request.";
            } else if (intent?.intent === "menu") {
              replyText = MENU_TEXT;
            } else {
              const qnaQuestion = intent?.question ?? content;
              replyText = await answerDatasetQuestion(supabase, linkedUser.company_id, qnaQuestion) ?? await answerFinancialQuestion(supabase, linkedUser.company_id, qnaQuestion);
            }
          }
        }
      } else {
          replyText = buildReply(messageType, content);
        }
      }

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
