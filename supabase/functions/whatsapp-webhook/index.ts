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
  errorMessage: string;
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
].join(NL);

const GREETING_PATTERN = /^(hi|hello|hey|menu|help)$/i;

function buildReply(messageType: string, content: string): string {
  if (messageType === "text" && GREETING_PATTERN.test(content.trim())) {
    return MENU_TEXT;
  }
  if (messageType === "image" || messageType === "document") {
    return "Got your file - invoice processing is coming in a later phase of this build. Type 'menu' to see what's available now.";
  }
  return ["Received: " + JSON.stringify(content), "", "Full financial analysis is coming in later phases. Type \"menu\" to see available options."].join(NL);
}

const INVOICE_BUCKET = "fincore-invoices";
const MAX_INVOICE_BYTES = 10 * 1024 * 1024;
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
  const metadataResponse = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const metadata = await metadataResponse.json();
  if (!metadataResponse.ok || !metadata?.url) {
    throw new Error(metadata?.error?.message ?? `WhatsApp media metadata request failed (${metadataResponse.status})`);
  }

  const mediaResponse = await fetch(metadata.url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
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
    return { success: true, invoiceId, errorMessage: "" };
  } catch (error) {
    console.error("whatsapp-webhook: invoice ingest failed", error instanceof Error ? error.message : error);
    return { success: false, errorMessage: "I couldn't save that invoice. Please try sending it again." };
  }
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
    const response = await fetch("https://api.resend.com/emails", {
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
        const ingestResult = await ingestWhatsAppInvoice(supabase, summary, linkedUser.company_id, linkedAccount.user_id);
        replyText = ingestResult.success
          ? `Invoice ${ingestResult.invoiceId} received and queued for analysis. Extraction and risk analysis will follow in the next phase.`
          : ingestResult.errorMessage;
      } else {
        replyText = buildReply(messageType, content);
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
