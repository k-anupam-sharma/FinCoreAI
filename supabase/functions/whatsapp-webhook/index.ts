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

async function callEnterAI(systemPrompt: string, userText: string, maxOutputTokens = 500): Promise<string | null> {
  if (!ENTER_AI_API_KEY) return null;
  try {
    const response = await fetchWithTimeout(`${ENTER_AI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ENTER_AI_API_KEY}`,
        "Content-Type": "application/json",
        "X-Enter-Project-ID": AI_PROJECT_ID,
      },
      body: JSON.stringify({
        model: "meta/llama-3.1-70b-instruct",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
        max_tokens: maxOutputTokens,
        temperature: 0,
      }),
    }, 20000);
    const data = await response.json();
    if (!response.ok) {
      console.error(`whatsapp-webhook: Enter AI request failed (${response.status})`);
      return null;
    }
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content.trim() : null;
  } catch (error) {
    console.error("whatsapp-webhook: Enter AI request failed", error instanceof Error ? error.message : error);
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
const ENTER_AI_API_KEY = Deno.env.get("ENTER_AI_API_KEY") ?? "";
const ENTER_AI_API_BASE = "https://api.enter.pro/v1";
const ALLOWED_INVOICE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

// ---- Safe Query Executor (Hybrid Layer 2) ----

const APPROVED_TABLES: Record<string, { columns: string[]; has_company_id: boolean; aliases: string[] }> = {
  companies: { columns: ['company_id', 'name', 'industry', 'country', 'plan_tier', 'created_at'], has_company_id: false, aliases: ['company', 'organization', 'business'] },
  users: { columns: ['user_id', 'name', 'email', 'role', 'account_status', 'mfa_enabled', 'created_at'], has_company_id: true, aliases: ['user', 'employee', 'staff', 'account'] },
  vendors: { columns: ['vendor_id', 'name', 'category', 'risk_profile', 'status', 'bank_name', 'bank_account_number', 'tax_id', 'onboarded_date'], has_company_id: true, aliases: ['vendor', 'supplier', 'contractor'] },
  invoices: { columns: ['invoice_id', 'vendor_id', 'department', 'gl_account', 'subtotal', 'tax_amount', 'total_amount', 'currency', 'date', 'due_date', 'status', 'po_number', 'contract_id', 'submitted_by', 'submitted_at', 'source_channel', 'ocr_confidence', 'is_recurring', 'notes', 'file_storage_path'], has_company_id: true, aliases: ['invoice', 'bill', 'receipt'] },
  payments: { columns: ['payment_id', 'invoice_id', 'amount', 'status', 'payment_method', 'bank_reference', 'payment_date'], has_company_id: true, aliases: ['payment', 'transaction', 'cash transaction', 'cash flow', 'cash movement', 'money movement'] },
  budgets: { columns: ['budget_id', 'department', 'period', 'allocated', 'spent', 'remaining'], has_company_id: true, aliases: ['budget', 'allocation', 'budget line'] },
  decisions: { columns: ['decision_id', 'invoice_id', 'recommendation', 'reasoning', 'confidence_score', 'decided_by', 'timestamp'], has_company_id: true, aliases: ['decision', 'approval', 'review', 'recommendation'] },
  transactions: { columns: ['transaction_id', 'date', 'type', 'category', 'amount'], has_company_id: true, aliases: ['transaction', 'cash transaction', 'cash flow', 'cash movement', 'money movement'] },
  auth_log: { columns: ['log_id', 'user_id', 'event_type', 'ip_address', 'device', 'success', 'timestamp'], has_company_id: true, aliases: ['auth log', 'login log', 'security log', 'authentication'] },
  vendor_bank_changes: { columns: ['change_id', 'vendor_id', 'old_account_number', 'new_account_number', 'old_bank_name', 'new_bank_name', 'changed_at', 'changed_by'], has_company_id: true, aliases: ['bank change', 'vendor bank', 'account change'] },
  gl_accounts: { columns: ['gl_code', 'category', 'description'], has_company_id: false, aliases: ['gl account', 'general ledger', 'account code'] },
  demo_anomaly_answer_key: { columns: ['id', 'source_table', 'related_id', 'anomaly_type', 'description'], has_company_id: false, aliases: ['anomaly', 'anomaly key', 'label'] },
  decision_rules_config: { columns: ['rule_key', 'threshold_value', 'description'], has_company_id: true, aliases: ['rule', 'threshold', 'config'] },
  invoice_analysis: { columns: ['invoice_id', 'extracted_fields', 'validation_result', 'duplicate_score', 'duplicate_evidence', 'vendor_risk_snapshot', 'budget_impact', 'anomaly_score', 'anomaly_reasons', 'created_at'], has_company_id: false, aliases: ['analysis', 'invoice analysis', 'extraction'] },
  invoice_items: { columns: ['invoice_id', 'line_no', 'description', 'quantity', 'unit_price', 'amount', 'gl_account'], has_company_id: false, aliases: ['line item', 'invoice line', 'item'] },
  risk_alerts: { columns: ['id', 'alert_type', 'severity', 'related_invoice_id', 'related_vendor_id', 'message', 'status', 'created_at', 'resolved_at', 'resolved_by'], has_company_id: true, aliases: ['alert', 'risk', 'risk alert', 'warning'] },
  forecast_records: { columns: ['id', 'generated_at', 'horizon_days', 'projected_inflow', 'projected_outflow', 'projected_net', 'projected_cash_position', 'top_contributors', 'disclaimer'], has_company_id: true, aliases: ['forecast', 'projection', 'cash flow forecast'] },
};

const APPROVED_JOINS: Record<string, { from_table: string; from_column: string; to_table: string; to_column: string; join_type: string }> = {
  invoices_vendors: { from_table: 'invoices', from_column: 'vendor_id', to_table: 'vendors', to_column: 'vendor_id', join_type: 'LEFT' },
  invoices_users: { from_table: 'invoices', from_column: 'submitted_by', to_table: 'users', to_column: 'user_id', join_type: 'LEFT' },
  invoices_gl_accounts: { from_table: 'invoices', from_column: 'gl_account', to_table: 'gl_accounts', to_column: 'gl_code', join_type: 'LEFT' },
  invoices_analysis: { from_table: 'invoices', from_column: 'invoice_id', to_table: 'invoice_analysis', to_column: 'invoice_id', join_type: 'LEFT' },
  invoices_items: { from_table: 'invoices', from_column: 'invoice_id', to_table: 'invoice_items', to_column: 'invoice_id', join_type: 'LEFT' },
  invoices_payments: { from_table: 'invoices', from_column: 'invoice_id', to_table: 'payments', to_column: 'invoice_id', join_type: 'LEFT' },
  invoices_decisions: { from_table: 'invoices', from_column: 'invoice_id', to_table: 'decisions', to_column: 'invoice_id', join_type: 'LEFT' },
  invoices_risk_alerts: { from_table: 'invoices', from_column: 'invoice_id', to_table: 'risk_alerts', to_column: 'related_invoice_id', join_type: 'LEFT' },
  vendors_bank_changes: { from_table: 'vendors', from_column: 'vendor_id', to_table: 'vendor_bank_changes', to_column: 'vendor_id', join_type: 'LEFT' },
  users_auth_log: { from_table: 'users', from_column: 'user_id', to_table: 'auth_log', to_column: 'user_id', join_type: 'LEFT' },
};

const TABLES_WITH_COMPANY_ID = ['users', 'vendors', 'invoices', 'payments', 'budgets', 'decisions', 'transactions', 'auth_log', 'vendor_bank_changes', 'decision_rules_config', 'risk_alerts', 'forecast_records'];

const TABLES_VIA_PARENT: Record<string, { parent: string; join_column: string }> = {
  invoice_analysis: { parent: 'invoices', join_column: 'invoice_id' },
  invoice_items: { parent: 'invoices', join_column: 'invoice_id' },
};

interface SafeQuery {
  in_scope: boolean;
  table: string;
  columns: string[];
  filters: Array<{ column: string; operator: string; value: string | number }>;
  joins?: Array<{ to_table: string }>;
  aggregations?: Array<{ function: string; column: string; alias: string }>;
  group_by?: string;
  order_by?: string;
  order_direction?: 'asc' | 'desc';
  limit?: number;
  original_question?: string;
}

function normalizeSafeQuery(value: Record<string, unknown>): SafeQuery | null {
  const table = typeof value.table === 'string' && APPROVED_TABLES[value.table] ? value.table : null;
  if (!table) return null;
  const config = APPROVED_TABLES[table];
  const columns = Array.isArray(value.columns)
    ? (value.columns as string[]).filter((col) => typeof col === 'string' && config.columns.includes(col)).slice(0, 20)
    : [];
  if (!columns.length) return null;
  const rawFilters = Array.isArray(value.filters) ? value.filters : [];
  const filters = rawFilters.map((entry) => {
    const filter = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const column = typeof filter.column === 'string' && config.columns.includes(filter.column) ? filter.column : null;
    const operator = filter.operator;
    const filterValue = typeof filter.value === 'string' || typeof filter.value === 'number' ? filter.value : null;
    return column && column !== 'company_id' && (operator === 'eq' || operator === 'ilike' || operator === 'gte' || operator === 'lte') && filterValue !== null
      ? { column, operator, value: filterValue }
      : null;
  }).filter((f): f is { column: string; operator: string; value: string | number } => f !== null).slice(0, 5);
  const rawJoins = Array.isArray(value.joins) ? value.joins : [];
  const joins = rawJoins.map((entry) => {
    const join = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const toTable = typeof join.to_table === 'string' ? join.to_table : null;
    const joinKey = `${table}_${toTable}`;
    return toTable && APPROVED_JOINS[joinKey] ? { to_table: toTable } : null;
  }).filter((j): j is { to_table: string } => j !== null).slice(0, 3);
  const rawLimit = Number(value.limit);
  return {
    in_scope: value.in_scope === true,
    table,
    columns,
    filters,
    joins: joins.length ? joins : undefined,
    aggregations: Array.isArray(value.aggregations) ? (value.aggregations as Array<{ function: string; column: string; alias: string }>).filter((agg) => agg && typeof agg.function === 'string' && typeof agg.column === 'string').slice(0, 5) : undefined,
    group_by: typeof value.group_by === 'string' && config.columns.includes(value.group_by) ? value.group_by : undefined,
    order_by: typeof value.order_by === 'string' && config.columns.includes(value.order_by) ? value.order_by : undefined,
    order_direction: value.order_direction === 'asc' ? 'asc' : 'desc',
    limit: Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 50,
    original_question: typeof value.original_question === 'string' ? value.original_question : undefined,
  };
}

async function classifySafeQuery(question: string): Promise<SafeQuery | null> {
  const content = await callEnterAI(
    `You are a FinCore query planner. Return JSON only with: in_scope (boolean), table (one approved table), columns (array of approved columns), filters (array with column/operator/value), joins (array with to_table), aggregations (optional), group_by (optional), order_by (optional), order_direction (asc/desc), limit (1-100), original_question (string).

Approved tables: ${Object.keys(APPROVED_TABLES).join(', ')}.

Rules:
- NEVER include company_id in filters (backend enforces it)
- NEVER request mutations
- If question cannot be answered, set in_scope: false`,
    question,
    600,
  );
  const parsed = content ? parseJsonObject(content) : null;
  return parsed ? normalizeSafeQuery(parsed) : null;
}

async function executeSafeQuery(query: SafeQuery, companyId: string, userId: string): Promise<{ data: unknown[] | null; error: string | null }> {
  try {
    const config = APPROVED_TABLES[query.table];
    if (!config) throw new Error(`Table '${query.table}' not approved`);
    const invalidCols = query.columns.filter((col) => !config.columns.includes(col));
    if (invalidCols.length) throw new Error(`Columns not approved: ${invalidCols.join(', ')}`);
    let supabaseQuery = supabase.from(query.table).select(query.columns.join(','));
    if (TABLES_WITH_COMPANY_ID.includes(query.table)) {
      supabaseQuery = supabaseQuery.eq('company_id', companyId);
    } else if (TABLES_VIA_PARENT[query.table]) {
      const parent = TABLES_VIA_PARENT[query.table];
      const { data: parentRows, error: parentError } = await supabase.from(parent).select('invoice_id').eq('company_id', companyId).limit(500);
      if (parentError) throw parentError;
      const parentIds = (parentRows ?? []).map((row) => row.invoice_id);
      if (!parentIds.length) return { data: [], error: null };
      supabaseQuery = supabaseQuery.in(parent.join_column, parentIds);
    }
    for (const filter of query.filters) {
      if (filter.column === 'company_id') throw new Error('Cannot filter by company_id');
      if (filter.operator === 'eq') supabaseQuery = supabaseQuery.eq(filter.column, filter.value);
      if (filter.operator === 'ilike') supabaseQuery = supabaseQuery.ilike(filter.column, `%${String(filter.value).replace(/[%_]/g, '')}%`);
      if (filter.operator === 'gte') supabaseQuery = supabaseQuery.gte(filter.column, filter.value);
      if (filter.operator === 'lte') supabaseQuery = supabaseQuery.lte(filter.column, filter.value);
    }
    if (query.joins) {
      for (const join of query.joins) {
        const joinKey = `${query.table}_${join.to_table}`;
        const joinDef = APPROVED_JOINS[joinKey];
        if (!joinDef) throw new Error(`JOIN not approved: ${joinKey}`);
        supabaseQuery = supabaseQuery.select(`${query.columns.join(',')}, ${join.to_table}!${joinKey}(${APPROVED_TABLES[join.to_table].columns.slice(0, 10).join(',')})`);
      }
    }
    if (query.group_by) supabaseQuery = supabaseQuery.order(query.group_by, { ascending: query.order_direction !== 'desc' });
    else if (query.order_by) supabaseQuery = supabaseQuery.order(query.order_by, { ascending: query.order_direction !== 'desc' });
    supabaseQuery = supabaseQuery.limit(Math.min(query.limit || 50, 100));
    const { data, error } = await Promise.race([
      supabaseQuery,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Query timeout')), 10000)),
    ]);
    if (error) throw error;
    await supabase.from('query_logs').insert({
      user_id: userId,
      company_id: companyId,
      user_question: query.original_question ?? '',
      query_type: 'safe_query',
      tables_accessed: [query.table, ...(query.joins?.map((j) => j.to_table) || [])],
      execution_status: 'success',
      rows_returned: data?.length ?? 0,
    });
    return { data: data ?? [], error: null };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await supabase.from('query_logs').insert({
      user_id: userId,
      company_id: companyId,
      user_question: query.original_question ?? '',
      query_type: 'safe_query',
      tables_accessed: [query.table],
      execution_status: 'failed',
      rows_returned: 0,
      error_message: errorMsg,
    });
    return { data: null, error: errorMsg };
  }
}

async function explainQueryResult(question: string, data: unknown[], query: SafeQuery): Promise<string> {
  const facts = JSON.stringify({ table: query.table, row_count: data.length, rows: data.slice(0, 20) }, null, 2).slice(0, 18000);
  const geminiAnswer = await callEnterAI(
    'Answer the user question using only the supplied database facts. Be concise. If data is empty, say so clearly.',
    `Question: ${question}${NL}${NL}Database result:${NL}${facts}`,
    600,
  );
  if (geminiAnswer) return geminiAnswer;
  // Fallback to NVIDIA API
  return await callNvidiaText(
    'Answer the user question using only the supplied database facts. Be concise. If data is empty, say so clearly.',
    `Question: ${question}${NL}${NL}Database result:${NL}${facts}`,
    600,
  ) || `Query returned ${data.length} row(s) from ${query.table}.`;
}

async function callNvidiaText(systemPrompt: string, userText: string, maxTokens = 500): Promise<string | null> {
  if (!NVIDIA_API_KEY) return null;
  try {
    const response = await fetchWithTimeout(`${NVIDIA_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "meta/llama-3.1-70b-instruct",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
        max_tokens: maxTokens,
        temperature: 0,
      }),
    }, 15000);
    const data = await response.json();
    if (!response.ok) {
      console.error(`whatsapp-webhook: NVIDIA API request failed (${response.status})`);
      return null;
    }
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content.trim() : null;
  } catch (error) {
    console.error("whatsapp-webhook: NVIDIA API request failed", error instanceof Error ? error.message : error);
    return null;
  }
}

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
    }, 30000);
    const data = await response.json();
    if (!response.ok) {
      const errorMsg = data?.error?.message ?? `AI request failed (${response.status})`;
      console.error(`whatsapp-webhook: OCR API error: ${errorMsg}`);
      throw new Error(errorMsg);
    }
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

// ---- FinCore Intelligence Query Functions ----

async function getCompanyOverview(supabase: SupabaseClient, companyId: string): Promise<Record<string, unknown>> {
  const [company, invoices, payments, budgets, transactions, alerts] = await Promise.all([
    supabase.from("companies").select("company_id,name,industry,country,plan_tier").eq("company_id", companyId).maybeSingle(),
    supabase.from("invoices").select("invoice_id,total_amount,status").eq("company_id", companyId),
    supabase.from("payments").select("payment_id,amount,status").eq("company_id", companyId),
    supabase.from("budgets").select("budget_id,allocated,spent,remaining,department,period").eq("company_id", companyId),
    supabase.from("transactions").select("transaction_id,amount,type").eq("company_id", companyId),
    supabase.from("risk_alerts").select("id,alert_type,severity,message,status").eq("company_id", companyId).eq("status", "open"),
  ]);
  const totalInvoiceValue = (invoices.data ?? []).reduce((sum, inv) => sum + Number(inv.total_amount ?? 0), 0);
  const totalPayments = (payments.data ?? []).reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
  const totalBudget = (budgets.data ?? []).reduce((sum, b) => sum + Number(b.allocated ?? 0), 0);
  const totalSpent = (budgets.data ?? []).reduce((sum, b) => sum + Number(b.spent ?? 0), 0);
  const cashInflow = (transactions.data ?? []).filter((t) => t.type === "inflow").reduce((sum, t) => sum + Number(t.amount ?? 0), 0);
  const cashOutflow = (transactions.data ?? []).filter((t) => t.type === "outflow").reduce((sum, t) => sum + Number(t.amount ?? 0), 0);
  const pendingInvoices = (invoices.data ?? []).filter((inv) => inv.status === "Pending").length;
  return {
    company: company.data,
    total_invoice_value: totalInvoiceValue,
    total_payments: totalPayments,
    total_budget_allocated: totalBudget,
    total_budget_spent: totalSpent,
    cash_inflow: cashInflow,
    cash_outflow: cashOutflow,
    net_cash_position: cashInflow - cashOutflow,
    pending_invoices: pendingInvoices,
    open_risk_alerts: alerts.data ?? [],
  };
}

async function getInvoiceIntelligence(supabase: SupabaseClient, companyId: string, invoiceId?: string): Promise<Record<string, unknown>[]> {
  let query = supabase.from("invoices").select("invoice_id,vendor_id,department,gl_account,subtotal,tax_amount,total_amount,currency,date,due_date,status,po_number,payment_terms,ocr_confidence,is_recurring,notes").eq("company_id", companyId);
  if (invoiceId) query = query.eq("invoice_id", invoiceId);
  const { data, error } = await query.order("date", { ascending: false }).limit(50);
  if (error) throw error;
  return data ?? [];
}

async function getVendorIntelligence(supabase: SupabaseClient, companyId: string, vendorId?: string): Promise<Record<string, unknown>[]> {
  const vendors = await supabase.from("vendors").select("vendor_id,name,category,risk_profile,status,bank_name,tax_id,onboarded_date").eq("company_id", companyId);
  if (vendorId) vendors.data = (vendors.data ?? []).filter((v) => v.vendor_id === vendorId);
  const vendorIds = (vendors.data ?? []).map((v) => v.vendor_id);
  const [invoices, payments, bankChanges] = await Promise.all([
    vendorIds.length ? supabase.from("invoices").select("vendor_id,invoice_id,total_amount").eq("company_id", companyId).in("vendor_id", vendorIds) : { data: [], error: null },
    vendorIds.length ? supabase.from("payments").select("invoice_id,amount,status").eq("company_id", companyId) : { data: [], error: null },
    vendorIds.length ? supabase.from("vendor_bank_changes").select("vendor_id,change_id,old_bank_name,new_bank_name,changed_at").eq("company_id", companyId).in("vendor_id", vendorIds) : { data: [], error: null },
  ]);
  const vendorStats = new Map<string, { spend: number; count: number; payments: number }>();
  for (const inv of invoices.data ?? []) {
    const stats = vendorStats.get(inv.vendor_id) ?? { spend: 0, count: 0, payments: 0 };
    stats.spend += Number(inv.total_amount ?? 0);
    stats.count++;
    vendorStats.set(inv.vendor_id, stats);
  }
  return (vendors.data ?? []).map((v) => ({
    ...v,
    total_spend: vendorStats.get(v.vendor_id)?.spend ?? 0,
    invoice_count: vendorStats.get(v.vendor_id)?.count ?? 0,
    bank_changes: (bankChanges.data ?? []).filter((bc) => bc.vendor_id === v.vendor_id),
  }));
}

async function getBudgetIntelligence(supabase: SupabaseClient, companyId: string, department?: string, period?: string): Promise<Record<string, unknown>[]> {
  let query = supabase.from("budgets").select("budget_id,department,period,allocated,spent,remaining").eq("company_id", companyId);
  if (department) query = query.eq("department", department);
  if (period) query = query.eq("period", period);
  const { data, error } = await query.order("period", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((b) => ({
    ...b,
    utilization_pct: Number(b.allocated) > 0 ? (Number(b.spent) / Number(b.allocated)) * 100 : 0,
    is_over_budget: Number(b.remaining) < 0,
  }));
}

async function getCashFlowIntelligence(supabase: SupabaseClient, companyId: string, months = 6): Promise<Record<string, unknown>> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const { data, error } = await supabase.from("transactions").select("transaction_id,date,type,category,amount").eq("company_id", companyId).gte("date", cutoff.toISOString().slice(0, 10));
  if (error) throw error;
  const transactions = data ?? [];
  const inflows = transactions.filter((t) => t.type === "inflow");
  const outflows = transactions.filter((t) => t.type === "outflow");
  const totalInflow = inflows.reduce((sum, t) => sum + Number(t.amount ?? 0), 0);
  const totalOutflow = outflows.reduce((sum, t) => sum + Number(t.amount ?? 0), 0);
  const byCategory = new Map<string, { inflow: number; outflow: number }>();
  for (const t of transactions) {
    const cat = byCategory.get(t.category) ?? { inflow: 0, outflow: 0 };
    if (t.type === "inflow") cat.inflow += Number(t.amount ?? 0);
    else cat.outflow += Number(t.amount ?? 0);
    byCategory.set(t.category, cat);
  }
  return {
    period: `${months} months`,
    total_inflow: totalInflow,
    total_outflow: totalOutflow,
    net_cash_flow: totalInflow - totalOutflow,
    transaction_count: transactions.length,
    by_category: Array.from(byCategory.entries()).map(([category, amounts]) => ({ category, ...amounts })),
  };
}

async function getPaymentIntelligence(supabase: SupabaseClient, companyId: string, status?: string): Promise<Record<string, unknown>[]> {
  let query = supabase.from("payments").select("payment_id,invoice_id,amount,status,payment_method,bank_reference,payment_date").eq("company_id", companyId);
  if (status) query = query.eq("status", status);
  const { data, error } = await query.order("payment_date", { ascending: false }).limit(100);
  if (error) throw error;
  return data ?? [];
}

async function getDecisionIntelligence(supabase: SupabaseClient, companyId: string, recommendation?: string): Promise<Record<string, unknown>[]> {
  let query = supabase.from("decisions").select("decision_id,invoice_id,recommendation,reasoning,confidence_score,decided_by,timestamp").eq("company_id", companyId);
  if (recommendation) query = query.eq("recommendation", recommendation);
  const { data, error } = await query.order("timestamp", { ascending: false }).limit(100);
  if (error) throw error;
  return data ?? [];
}

async function getAnomalyIntelligence(supabase: SupabaseClient, companyId: string): Promise<Record<string, unknown>[]> {
  const { data: invoices, error: invoiceError } = await supabase.from("invoices").select("invoice_id").eq("company_id", companyId);
  if (invoiceError) throw invoiceError;
  const invoiceIds = (invoices?.data ?? []).map((inv) => inv.invoice_id);
  if (!invoiceIds.length) return [];
  const { data, error } = await supabase.from("invoice_analysis").select("invoice_id,duplicate_score,anomaly_score,anomaly_reasons,validation_result").in("invoice_id", invoiceIds).order("anomaly_score", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []).filter((a) => Number(a.anomaly_score ?? 0) > 30 || Number(a.duplicate_score ?? 0) > 50);
}

async function getAuthIntelligence(supabase: SupabaseClient, companyId: string, userId?: string): Promise<Record<string, unknown>[]> {
  let query = supabase.from("auth_log").select("log_id,user_id,event_type,success,device,timestamp").eq("company_id", companyId);
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query.order("timestamp", { ascending: false }).limit(100);
  if (error) throw error;
  return data ?? [];
}

async function getVendorBankChangeIntelligence(supabase: SupabaseClient, companyId: string, vendorId?: string): Promise<Record<string, unknown>[]> {
  let query = supabase.from("vendor_bank_changes").select("change_id,vendor_id,old_account_number,new_account_number,old_bank_name,new_bank_name,changed_at,changed_by").eq("company_id", companyId);
  if (vendorId) query = query.eq("vendor_id", vendorId);
  const { data, error } = await query.order("changed_at", { ascending: false }).limit(50);
  if (error) throw error;
  return data ?? [];
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
  const answer = await callEnterAI(
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
  const content = await callEnterAI(
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
  const content = await callEnterAI(
    "Create a read-only FinCore dataset query plan as JSON only. Allowed tables are companies, users, vendors, invoices, payments, budgets, transactions, decisions, invoice_analysis, risk_alerts, forecast_records. Use only fields needed to answer. Set in_scope false for non-financial or external questions. Never request mutations, joins, raw SQL, credentials, or another company.",
    question,
    500,
  );
  const parsed = content ? parseJsonObject(content) : null;
  return parsed ? normalizeDatasetPlan(parsed) : null;
}

async function answerFullCompanyDatasetQuestion(supabase: SupabaseClient, companyId: string, question: string): Promise<string | null> {
  const { data: scopedInvoices, error: invoiceIdError } = await supabase.from("invoices").select("invoice_id").eq("company_id", companyId).limit(2000);
  if (invoiceIdError) throw invoiceIdError;
  const invoiceIds = (scopedInvoices ?? []).map((row) => row.invoice_id);
  const [company, users, vendors, invoices, payments, budgets, transactions, decisions, bankChanges, authLog, analyses, items, alerts, forecasts] = await Promise.all([
    supabase.from("companies").select("company_id,name,industry,country,plan_tier").eq("company_id", companyId).maybeSingle(),
    supabase.from("users").select("user_id,name,role,account_status,created_at").eq("company_id", companyId).limit(100),
    supabase.from("vendors").select("vendor_id,name,category,risk_profile,status").eq("company_id", companyId).limit(100),
    supabase.from("invoices").select("invoice_id,vendor_id,department,subtotal,tax_amount,total_amount,currency,date,due_date,status,po_number,ocr_confidence,file_storage_path").eq("company_id", companyId).limit(2000),
    supabase.from("payments").select("payment_id,invoice_id,amount,status,payment_method,payment_date").eq("company_id", companyId).limit(2000),
    supabase.from("budgets").select("budget_id,department,period,allocated,spent,remaining").eq("company_id", companyId).limit(1000),
    supabase.from("transactions").select("transaction_id,date,type,category,amount").eq("company_id", companyId).limit(2000),
    supabase.from("decisions").select("decision_id,invoice_id,recommendation,reasoning,confidence_score,timestamp").eq("company_id", companyId).limit(1000),
    supabase.from("vendor_bank_changes").select("change_id,vendor_id,new_bank_name,changed_at").eq("company_id", companyId).limit(200),
    supabase.from("auth_log").select("log_id,user_id,event_type,success,device,timestamp").eq("company_id", companyId).limit(1000),
    invoiceIds.length ? supabase.from("invoice_analysis").select("invoice_id,extracted_fields,validation_result,duplicate_score,duplicate_evidence,vendor_risk_snapshot,budget_impact,anomaly_score,anomaly_reasons,created_at").in("invoice_id", invoiceIds) : Promise.resolve({ data: [], error: null }),
    invoiceIds.length ? supabase.from("invoice_items").select("invoice_id,line_no,description,quantity,unit_price,amount,gl_account").in("invoice_id", invoiceIds).limit(4000) : Promise.resolve({ data: [], error: null }),
    supabase.from("risk_alerts").select("id,alert_type,severity,related_invoice_id,message,status,created_at,resolved_at").eq("company_id", companyId).limit(500),
    supabase.from("forecast_records").select("id,generated_at,horizon_days,projected_inflow,projected_outflow,projected_net,projected_cash_position,disclaimer").eq("company_id", companyId).limit(20),
  ]);
  const results = [company, users, vendors, invoices, payments, budgets, transactions, decisions, bankChanges, authLog, analyses, items, alerts, forecasts];
  const failed = results.find((result) => result.error);
  if (failed?.error) throw failed.error;
  const snapshot = { company: company.data, users: users.data, vendors: vendors.data, invoices: invoices.data, payments: payments.data, budgets: budgets.data, transactions: transactions.data, decisions: decisions.data, vendor_bank_changes: bankChanges.data, auth_log: authLog.data, invoice_analysis: analyses.data, invoice_items: items.data, risk_alerts: alerts.data, forecast_records: forecasts.data };
  const facts = JSON.stringify(snapshot).slice(0, 350000);
  return callEnterAI(
    "You are the FinCore demo chatbot. Answer only from the complete company-scoped dataset snapshot supplied below. You may answer any question about those records, but never invent values, use external knowledge, reveal secrets, expose another company, or claim data that is absent. If a value is absent or a dataset is empty, say so clearly. Do not perform mutations. Keep the answer concise and show calculations only when directly supported by the records.",
    `Question: ${question}${NL}${NL}Complete company dataset snapshot:${NL}${facts}`,
    900,
  );
}

async function answerDatasetQuestion(supabase: SupabaseClient, companyId: string, userId: string, question: string): Promise<string | null> {
  // Layer 1: Full snapshot for common questions
  const fullAnswer = await answerFullCompanyDatasetQuestion(supabase, companyId, question);
  if (fullAnswer && !fullAnswer.includes("I don't have enough data")) return fullAnswer;
  // Layer 2: Safe query executor for complex/custom questions
  const queryPlan = await classifySafeQuery(question);
  if (queryPlan && queryPlan.in_scope) {
    const result = await executeSafeQuery(queryPlan, companyId, userId);
    if (result.data && result.data.length > 0) {
      return await explainQueryResult(question, result.data, queryPlan);
    }
    if (result.data && result.data.length === 0) {
      return "No matching records were found in your company dataset.";
    }
  }
  // Layer 3: Clear fallback
  return null;
}

async function answerFinancialQuestion(supabase: SupabaseClient, companyId: string, question: string): Promise<string> {
  try {
  const lower = question.toLowerCase();

  // Risk/Anomaly detection (check BEFORE generic invoice pattern)
  if (/(risky|suspicious|risk alert|anomal|unusual)/.test(lower)) {
    const { data: invoices } = await supabase.from("invoices").select("invoice_id").eq("company_id", companyId).in("status", ["Pending", "Overdue"]);
    const invoiceIds = (invoices ?? []).map((row) => row.invoice_id);
    if (!invoiceIds.length) return "No pending invoices to analyze for risk.";
    const { data: analyses } = await supabase.from("invoice_analysis").select("invoice_id,anomaly_score,duplicate_score,vendor_risk_snapshot").in("invoice_id", invoiceIds).order("anomaly_score", { ascending: false }).limit(5);
    const rows = analyses ?? [];
    if (!rows.length) return "No analyzed risk alerts were found.";
    return ["Highest-risk pending invoices:", ...rows.map((row) => `${row.invoice_id}: anomaly ${Number(row.anomaly_score ?? 0)}/100, duplicate ${Number(row.duplicate_score ?? 0)}%, vendor risk ${(row.vendor_risk_snapshot as Record<string, unknown> | null)?.computed_risk ?? "unknown"}`)].join(NL);
  }

  // Duplicate detection
  if (/(duplicate|duplicates|same invoice|repeated invoice)/.test(lower)) {
    const { data: invoices } = await supabase.from("invoices").select("invoice_id").eq("company_id", companyId);
    const invoiceIds = (invoices ?? []).map((row) => row.invoice_id);
    if (!invoiceIds.length) return "No invoices found to check for duplicates.";
    const { data: analyses } = await supabase.from("invoice_analysis").select("invoice_id,duplicate_score,duplicate_evidence").in("invoice_id", invoiceIds).order("duplicate_score", { ascending: false }).limit(5);
    const rows = (analyses ?? []).filter((row) => Number(row.duplicate_score ?? 0) > 50);
    if (!rows.length) return "No duplicate invoices detected. All invoices appear to be unique.";
    return ["Potential duplicate invoices:", ...rows.map((row) => `${row.invoice_id}: ${Number(row.duplicate_score).toFixed(0)}% similarity - ${(row.duplicate_evidence as Record<string, unknown> | null)?.best_match?.invoice_id ?? "N/A"}`)].join(NL);
  }

  // Company overview
  if (/(overview|summary|company info|total spending|total spend|cash position|monthly spend|spend this month)/.test(lower)) {
    const overview = await getCompanyOverview(supabase, companyId);
    return [
      `Company: ${(overview.company as Record<string, unknown>)?.name ?? "Unknown"}`,
      `Total Invoice Value: INR ${Number(overview.total_invoice_value ?? 0).toFixed(2)}`,
      `Total Payments: INR ${Number(overview.total_payments ?? 0).toFixed(2)}`,
      `Budget Allocated: INR ${Number(overview.total_budget_allocated ?? 0).toFixed(2)}`,
      `Budget Spent: INR ${Number(overview.total_budget_spent ?? 0).toFixed(2)}`,
      `Cash Inflow: INR ${Number(overview.cash_inflow ?? 0).toFixed(2)}`,
      `Cash Outflow: INR ${Number(overview.cash_outflow ?? 0).toFixed(2)}`,
      `Net Cash Position: INR ${Number(overview.net_cash_position ?? 0).toFixed(2)}`,
      `Pending Invoices: ${overview.pending_invoices ?? 0}`,
      `Open Risk Alerts: ${(overview.open_risk_alerts as unknown[]).length ?? 0}`,
    ].join(NL);
  }

  // Invoice intelligence
  if (/(invoice|invoices|pending invoice|unpaid)/.test(lower)) {
    const status = /pending/.test(lower) ? "Pending" : undefined;
    const invoices = await getInvoiceIntelligence(supabase, companyId);
    const filtered = status ? invoices.filter((inv) => inv.status === status) : invoices;
    if (!filtered.length) return "No invoices found for your company.";
    const top5 = filtered.slice(0, 5);
    return [`Invoices (${filtered.length} total):`, ...top5.map((inv) => `${inv.invoice_id}: INR ${Number(inv.total_amount).toFixed(2)} - ${inv.status} (${inv.department ?? "N/A"})`)].join(NL);
  }

  // Vendor intelligence
  if (/(vendor|vendors|supplier|top vendor|highest spend)/.test(lower)) {
    const vendors = await getVendorIntelligence(supabase, companyId);
    if (!vendors.length) return "No vendors found for your company.";
    const sorted = vendors.sort((a, b) => Number(b.total_spend ?? 0) - Number(a.total_spend ?? 0));
    const top5 = sorted.slice(0, 5);
    return [`Top Vendors by Spend:`, ...top5.map((v, i) => `${i + 1}. ${v.name}: INR ${Number(v.total_spend).toFixed(2)} (${v.invoice_count} invoices)`)].join(NL);
  }

  // Budget intelligence
  if (/(budget|budgets|over budget|remaining budget|budget left)/.test(lower)) {
    const budgets = await getBudgetIntelligence(supabase, companyId);
    if (!budgets.length) return "No budgets found for your company.";
    const overBudget = budgets.filter((b) => b.is_over_budget);
    if (/over budget/.test(lower) && overBudget.length) {
      return [`Departments Over Budget:`, ...overBudget.map((b) => `${b.department} (${b.period}): ${Number(b.utilization_pct).toFixed(0)}% used, over by INR ${Number(Math.abs(b.remaining)).toFixed(2)}`)].join(NL);
    }
    return [`Budget Status:`, ...budgets.slice(0, 10).map((b) => `${b.department} (${b.period}): INR ${Number(b.remaining).toFixed(2)} remaining (${Number(b.utilization_pct).toFixed(0)}% used)`)].join(NL);
  }

  // Cash flow intelligence
  if (/(cash flow|cash position|cash movement|inflow|outflow)/.test(lower)) {
    const cashFlow = await getCashFlowIntelligence(supabase, companyId);
    return [
      `Cash Flow (${cashFlow.period}):`,
      `Total Inflow: INR ${Number(cashFlow.total_inflow).toFixed(2)}`,
      `Total Outflow: INR ${Number(cashFlow.total_outflow).toFixed(2)}`,
      `Net Cash Flow: INR ${Number(cashFlow.net_cash_flow).toFixed(2)}`,
      `Transactions: ${cashFlow.transaction_count}`,
    ].join(NL);
  }

  // Payment intelligence
  if (/(payment|payments|paid|overdue)/.test(lower)) {
    const status = /overdue/.test(lower) ? "Pending" : undefined;
    const payments = await getPaymentIntelligence(supabase, companyId, status);
    if (!payments.length) return "No payments found for your company.";
    return [`Payments (${payments.length} total):`, ...payments.slice(0, 10).map((p) => `${p.payment_id}: INR ${Number(p.amount).toFixed(2)} - ${p.status} (${p.payment_date ?? "N/A"})`)].join(NL);
  }

  // Decision intelligence
  if (/(decision|decisions|approval|review|reject)/.test(lower)) {
    const decisions = await getDecisionIntelligence(supabase, companyId);
    if (!decisions.length) return "No decisions found for your company.";
    return [`Recent Decisions:`, ...decisions.slice(0, 10).map((d) => `${d.decision_id}: ${d.recommendation} for ${d.invoice_id} (${Number(d.confidence_score ?? 0).toFixed(2)} confidence)`)].join(NL);
  }

  // Anomaly intelligence
  if (/(anomal|unusual|suspicious|risky|risk alert)/.test(lower)) {
    const anomalies = await getAnomalyIntelligence(supabase, companyId);
    if (!anomalies.length) return "No unusual invoices detected for your company.";
    return [`Unusual Invoices:`, ...anomalies.slice(0, 10).map((a) => `${a.invoice_id}: Anomaly ${Number(a.anomaly_score).toFixed(0)}%, Duplicate ${Number(a.duplicate_score).toFixed(0)}%`)].join(NL);
  }

  // Vendor bank changes
  if (/(bank change|bank detail|vendor bank)/.test(lower)) {
    const changes = await getVendorBankChangeIntelligence(supabase, companyId);
    if (!changes.length) return "No vendor bank changes found for your company.";
    return [`Vendor Bank Changes:`, ...changes.slice(0, 10).map((c) => `${c.vendor_id}: ${c.old_bank_name ?? "Unknown"} → ${c.new_bank_name ?? "Unknown"} on ${c.changed_at}`)].join(NL);
  }

  // Auth/security intelligence
  if (/(login|auth|security|user activity)/.test(lower)) {
    const authLog = await getAuthIntelligence(supabase, companyId);
    if (!authLog.length) return "No authentication events found for your company.";
    return [`Recent Auth Events:`, ...authLog.slice(0, 10).map((e) => `${e.event_type} - ${e.success ? "Success" : "Failed"} (${e.timestamp})`)].join(NL);
  }

  // User count
  if (/(how many users|number of users|user count)/.test(lower)) {
    const { count, error } = await supabase.from("users").select("user_id", { count: "exact", head: true }).eq("company_id", companyId);
    if (error) throw error;
    return `Your company has ${count ?? 0} users in the FinCore Database.`;
  }

  // Dataset count
  if (/(how many datasets|number of datasets|datasets.*present)/.test(lower)) {
    const datasetNames = ["companies", "users", "vendors", "invoices", "payments", "budgets", "transactions", "decisions", "invoice_analysis", "risk_alerts", "forecast_records"];
    const counts = await Promise.all(datasetNames.map(async (table) => {
      const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true }).eq("company_id", companyId);
      return { table, count: error ? null : count ?? 0 };
    }));
    return ["FinCore datasets for your company:", ...counts.map((item) => `- ${item.table}: ${item.count === null ? "unavailable" : `${item.count} records`}`)].join(NL);
  }

  // Default: return helpful menu
  return ["I can answer questions about:", "- monthly spend and overview", "- top vendors", "- pending or risky invoices", "- budgets and affordability", "- cash-flow summaries", "- user and invoice counts", "", "Please rephrase your question or type menu."].join(NL);
  } catch (error) {
    console.error("whatsapp-webhook: answerFinancialQuestion failed", error instanceof Error ? error.message : error);
    return "I encountered an error processing your question. Please try again or type menu for options.";
  }
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
  if (lower === "switch company" || lower === "change company" || lower === "list companies") {
    const { data: companies, error } = await supabase.from("companies").select("company_id,name,industry").order("company_id");
    if (error) throw error;
    const list = (companies ?? []).map((c, i) => `${i + 1}. ${c.company_id} - ${c.name} (${c.industry})`).join(NL);
    return `Available companies:${NL}${list}${NL}${NL}Reply with "switch to <number>" or "switch to <company_id>" to change your active company.`;
  }
  const switchMatch = lower.match(/^switch to\s+(.+)$/i);
  if (switchMatch) {
    const target = switchMatch[1].trim();
    const { data: companies, error } = await supabase.from("companies").select("company_id,name").order("company_id");
    if (error) throw error;
    const companyList = companies ?? [];
    let targetCompany = companyList.find((c) => c.company_id.toLowerCase() === target.toLowerCase());
    if (!targetCompany) {
      const index = Number(target);
      if (Number.isFinite(index) && index >= 1 && index <= companyList.length) {
        targetCompany = companyList[index - 1];
      }
    }
    if (!targetCompany) return `Company not found. Use "switch company" to see the list.`;
    const { error: updateError } = await supabase.from("users").update({ company_id: targetCompany.company_id }).eq("user_id", userId);
    if (updateError) throw updateError;
    return `Switched to ${targetCompany.company_id} - ${targetCompany.name}. Send "Hi" to refresh your session.`;
  }
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
              replyText = await answerDatasetQuestion(supabase, linkedUser.company_id, linkedAccount.user_id, qnaQuestion) ?? await answerFinancialQuestion(supabase, linkedUser.company_id, qnaQuestion);
            }
          }
        }
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
