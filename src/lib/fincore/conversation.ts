// FinCore AI — conversation state machine.
//
// This is the "bot" the WhatsApp-style UI talks to. It is a pure function
// of (state, draft, incoming text) -> (new state, new draft, reply
// messages) plus a small set of store mutations (creating the demo company/
// user, linking the device phone, recording invoice actions). Nothing here
// depends on React; the chat UI is just one possible caller.

import * as store from "@/data/fincoreStore";
import * as session from "./session";
import { analyzeInvoice } from "./pipeline";
import { conciseInvoiceMessage, detailedInvoiceMessage, formatCurrency } from "./explain";
import { answerFinancialQuestion, getBudgetSummary, getFinancialOverview, getForecast, getVendorRiskSummary, scanRiskAlerts } from "./queries";
import type { FinUser, InvoiceStatus } from "@/types/fincore";

const NL = String.fromCharCode(10);

export type ChatState =
  | "unlinked"
  | "onboarding_name"
  | "onboarding_company"
  | "onboarding_role"
  | "onboarding_industry"
  | "onboarding_spend"
  | "onboarding_email"
  | "onboarding_otp"
  | "recovery_email"
  | "recovery_otp"
  | "main_menu"
  | "invoice_pick_mode"
  | "invoice_new_vendor"
  | "invoice_new_department"
  | "invoice_new_amount"
  | "invoice_new_tax"
  | "invoice_new_date"
  | "invoice_new_po"
  | "invoice_pending_action"
  | "vendor_lookup_pick"
  | "awaiting_question";

export interface ChatDraft {
  name?: string;
  companyName?: string;
  roleTitle?: string;
  industry?: string;
  monthlySpend?: string;
  email?: string;
  isNewCompany?: boolean;
  resolvedCompanyId?: string;
  otpCode?: string;
  otpExpiresAt?: number;
  otpAttempts?: number;
  recoveryUserId?: string;
  pendingInvoiceId?: string;
  newInvoice?: {
    vendorId?: string;
    vendorName?: string;
    department?: string;
    amount?: number;
    taxAmount?: number;
    date?: string;
    po?: string | null;
  };
}

export interface ChatContext {
  state: ChatState;
  draft: ChatDraft;
}

export interface BotReply {
  text: string;
  quickReplies?: string[];
}

export interface ChatResult {
  context: ChatContext;
  replies: BotReply[];
}

export function initialContext(): ChatContext {
  const phone = session.getDevicePhoneNumber();
  const link = store.getWhatsappAccount(phone);
  if (link && link.status === "active") {
    return { state: "main_menu", draft: {} };
  }
  return { state: "unlinked", draft: {} };
}

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
  "Reply with a number, or just type your question.",
].join(NL);

const MENU_QUICK_REPLIES = ["Analyze Invoice", "Financial Overview", "Risk & Alerts", "Ask FinCore AI"];

function menuReply(prefix?: string): BotReply {
  return { text: prefix ? `${prefix}${NL}${NL}${MENU_TEXT}` : MENU_TEXT, quickReplies: MENU_QUICK_REPLIES };
}

function currentUser(): FinUser | null {
  const link = store.getWhatsappAccount(session.getDevicePhoneNumber());
  if (!link || link.status !== "active") return null;
  return store.getUser(link.user_id) ?? null;
}

type MenuKey =
  | "analyze_invoice"
  | "financial_overview"
  | "vendor_intelligence"
  | "budget_spending"
  | "cash_flow_forecast"
  | "risk_alerts"
  | "ask_fincore_ai"
  | "account_help";

const MENU_OPTIONS: Array<{ n: string; key: MenuKey; labels: string[] }> = [
  { n: "1", key: "analyze_invoice", labels: ["analyze invoice", "invoice"] },
  { n: "2", key: "financial_overview", labels: ["financial overview", "overview"] },
  { n: "3", key: "vendor_intelligence", labels: ["vendor intelligence", "vendor"] },
  { n: "4", key: "budget_spending", labels: ["budget & spending", "budget and spending", "budget"] },
  { n: "5", key: "cash_flow_forecast", labels: ["cash flow forecast", "forecast", "cash flow"] },
  { n: "6", key: "risk_alerts", labels: ["risk & alerts", "risk and alerts", "risk", "alerts"] },
  { n: "7", key: "ask_fincore_ai", labels: ["ask fincore ai", "ask"] },
  { n: "8", key: "account_help", labels: ["account / help", "account", "help"] },
];

function matchMenuOption(text: string): MenuKey | null {
  const t = text.trim().toLowerCase();
  const byNumber = MENU_OPTIONS.find((o) => o.n === t);
  if (byNumber) return byNumber.key;
  const byLabel = MENU_OPTIONS.find((o) => o.labels.some((l) => t === l || t.includes(l)));
  return byLabel ? byLabel.key : null;
}

function parseWorkflowCommand(text: string): { action: "approve" | "review" | "defer" | "reject"; invoiceId: string | null } | null {
  const match = text.trim().match(/^(approve|review|defer|reject)\b\s*(INV[-\w]*|DEMO-INV[-\w]*)?/i);
  if (!match) return null;
  return { action: match[1].toLowerCase() as "approve" | "review" | "defer" | "reject", invoiceId: match[2] ? match[2].toUpperCase() : null };
}

function isEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

function formatMenuList(companyId: string): string {
  const overview = getFinancialOverview(companyId);
  return [
    "Financial Overview",
    `Period: ${overview.period}`,
    `Monthly Spend: ${formatCurrency(overview.monthlySpend, overview.currency)}`,
    `Budget Used: ${Math.round(overview.budgetUsedPct)}%`,
    `Pending Invoices: ${overview.pendingInvoicesCount}`,
    `Risk Alerts: ${overview.riskAlertsCount}`,
    `Upcoming Payments (14d): ${formatCurrency(overview.upcomingPaymentsTotal, overview.currency)} across ${overview.upcomingPaymentsCount} invoice(s)`,
  ].join(NL);
}

function formatBudgetSummary(companyId: string): string {
  const rows = getBudgetSummary(companyId);
  if (rows.length === 0) return "No budget records found for the current period.";
  const lines = [`Budget & Spending (${store.getDemoCurrentPeriod()})`];
  for (const r of rows) {
    lines.push(`${r.department}: ${Math.round(r.utilizationPct)}% used - allocated ${formatCurrency(r.allocated)}, remaining ${formatCurrency(r.remaining)}`);
  }
  return lines.join(NL);
}

function formatForecast(companyId: string): string {
  const lines = ["Cash Flow Forecast (estimates)"];
  for (const horizon of [30, 60, 90] as const) {
    const f = getForecast(companyId, horizon);
    lines.push(`${horizon}-day: net ${formatCurrency(f.projectedNet)}, projected position ${formatCurrency(f.projectedCashPosition)}`);
  }
  const f90 = getForecast(companyId, 90);
  if (f90.topOutflowContributors.length > 0) {
    lines.push("", `Top outflow drivers: ${f90.topOutflowContributors.map((c) => c.category).join(", ")}`);
  }
  lines.push("", f90.disclaimer);
  return lines.join(NL);
}

function formatRiskAlerts(companyId: string): string {
  const alerts = scanRiskAlerts(companyId);
  if (alerts.length === 0) return "No open risk alerts right now — every pending invoice cleared the decision engine.";
  const lines = ["Risk & Alerts"];
  for (const a of alerts) {
    lines.push(`${a.invoice.invoice_id} - ${a.decision.action} (anomaly ${a.anomaly.score}/100): ${a.decision.reasons[0]}`);
  }
  return lines.join(NL);
}

function formatVendorRisk(companyId: string, query: string): string {
  const summary = getVendorRiskSummary(companyId, query);
  if (!summary) return `I couldn't find a vendor matching "${query}". Try another name.`;
  const r = summary.risk;
  const lines = [
    `Vendor Intelligence - ${summary.vendorName}`,
    `Computed risk: ${r.computedRisk} (score ${r.score}/100)`,
    `Invoices: ${r.invoiceCount}, total spend ${formatCurrency(r.totalSpend)}, avg ${formatCurrency(r.avgInvoiceAmount)}`,
  ];
  if (r.onTimePaymentRate !== null) lines.push(`On-time payment rate: ${Math.round(r.onTimePaymentRate * 100)}%`);
  lines.push("Why:");
  r.reasons.forEach((reason, i) => lines.push(`${i + 1}. ${reason}`));
  return lines.join(NL);
}

function formatAccountHelp(user: FinUser): string {
  const company = store.getCompany(user.company_id);
  return [
    "Account / Help",
    `Name: ${user.name}`,
    `Company: ${company?.name ?? user.company_id}`,
    `Role: ${user.role}`,
    `Email: ${user.email}`,
    "",
    "Commands: Approve/Review/Defer/Reject INV-x, Details, Menu.",
    "Type \"Switch Device\" to simulate recovering your account from a new phone.",
  ].join(NL);
}

function runMenuAction(key: MenuKey, user: FinUser, context: ChatContext): ChatResult {
  switch (key) {
    case "analyze_invoice":
      return {
        context: { state: "invoice_pick_mode", draft: {} },
        replies: [{ text: `Reply with an existing invoice ID (e.g. ${store.getInvoicesByCompany(user.company_id)[0]?.invoice_id ?? "INV-00001"}) to analyze it, or type NEW to submit a new invoice.` }],
      };
    case "financial_overview":
      return { context: { state: "main_menu", draft: {} }, replies: [menuReply(formatMenuList(user.company_id))] };
    case "vendor_intelligence":
      return { context: { state: "vendor_lookup_pick", draft: {} }, replies: [{ text: "Which vendor would you like to check? Type a vendor name." }] };
    case "budget_spending":
      return { context: { state: "main_menu", draft: {} }, replies: [menuReply(formatBudgetSummary(user.company_id))] };
    case "cash_flow_forecast":
      return { context: { state: "main_menu", draft: {} }, replies: [menuReply(formatForecast(user.company_id))] };
    case "risk_alerts":
      return { context: { state: "main_menu", draft: {} }, replies: [menuReply(formatRiskAlerts(user.company_id))] };
    case "ask_fincore_ai":
      return { context: { state: "awaiting_question", draft: {} }, replies: [{ text: "Ask me anything about your finances, e.g. \"Which vendor has the highest spend?\"" }] };
    case "account_help":
      return { context: { state: "main_menu", draft: {} }, replies: [menuReply(formatAccountHelp(user))] };
  }
}

function runWorkflowCommand(command: { action: "approve" | "review" | "defer" | "reject"; invoiceId: string | null }, user: FinUser, draft: ChatDraft): BotReply {
  const invoiceId = command.invoiceId ?? draft.pendingInvoiceId ?? null;
  if (!invoiceId) return { text: "Which invoice? For example: Approve INV-00123." };

  const invoice = store.getInvoice(invoiceId);
  if (!invoice || invoice.company_id !== user.company_id) {
    return { text: `I couldn't find ${invoiceId} in your company's records.` };
  }

  const previousStatus: InvoiceStatus = invoice.status;
  const newStatus: InvoiceStatus = command.action === "reject" ? "Cancelled" : previousStatus;

  store.addInvoiceAction({ invoice_id: invoice.invoice_id, company_id: invoice.company_id, action: command.action, previous_status: previousStatus, new_status: newStatus, performed_by: user.user_id, reason: null });
  if (newStatus !== previousStatus) store.updateInvoiceStatus(invoice.invoice_id, newStatus);

  return {
    text: [
      `Action recorded: ${command.action.toUpperCase()} on ${invoice.invoice_id}`,
      `By: ${user.name}`,
      `Status: ${previousStatus} -> ${newStatus}`,
    ].join(NL),
  };
}

export function handleMessage(context: ChatContext, rawInput: string): ChatResult {
  const input = rawInput.trim();
  const lower = input.toLowerCase();
  const { state, draft } = context;

  // Global shortcuts available once an account is linked.
  if (state !== "unlinked" && !state.startsWith("onboarding_") && state !== "recovery_email" && state !== "recovery_otp") {
    const user = currentUser();
    if (user) {
      if (lower === "menu" || lower === "help") return { context: { state: "main_menu", draft: {} }, replies: [menuReply()] };
      if (lower === "switch device") {
        session.switchDevice();
        return { context: { state: "unlinked", draft: {} }, replies: [{ text: "You're now on a new (demo) device, unlinked from your account. Type Login to recover it, or Hi to create a new one." }] };
      }
      const workflow = parseWorkflowCommand(input);
      if (workflow) {
        const reply = runWorkflowCommand(workflow, user, draft);
        return { context: { state: "main_menu", draft: {} }, replies: [reply, menuReply()] };
      }
    }
  }

  switch (state) {
    case "unlinked": {
      if (/^(login|recover|recover account)/i.test(input)) {
        return { context: { state: "recovery_email", draft: {} }, replies: [{ text: "Let's recover your account. What's your registered recovery email?" }] };
      }
      return {
        context: { state: "onboarding_name", draft: {} },
        replies: [{ text: `Hi! I'm FinCore AI, your financial intelligence assistant.${NL}${NL}Let's set up your account. What's your name?` }],
      };
    }

    case "onboarding_name": {
      if (!input) return { context, replies: [{ text: "What's your name?" }] };
      return { context: { state: "onboarding_company", draft: { ...draft, name: input } }, replies: [{ text: `Nice to meet you, ${input}! What's your company or business name?` }] };
    }

    case "onboarding_company": {
      if (!input) return { context, replies: [{ text: "What's your company or business name?" }] };
      const existing = store.findCompanyByName(input);
      const nextDraft: ChatDraft = existing
        ? { ...draft, companyName: input, isNewCompany: false, resolvedCompanyId: existing.company_id }
        : { ...draft, companyName: input, isNewCompany: true };
      const note = existing ? `${input} is already on FinCore AI - I'll add you to that team.${NL}${NL}` : "";
      return { context: { state: "onboarding_role", draft: nextDraft }, replies: [{ text: `${note}What's your role at ${input}?` }] };
    }

    case "onboarding_role": {
      if (!input) return { context, replies: [{ text: "What's your role?" }] };
      return { context: { state: "onboarding_industry", draft: { ...draft, roleTitle: input } }, replies: [{ text: "What's your business type or industry?" }] };
    }

    case "onboarding_industry": {
      if (!input) return { context, replies: [{ text: "What's your business type or industry?" }] };
      return { context: { state: "onboarding_spend", draft: { ...draft, industry: input } }, replies: [{ text: "Roughly what's your monthly financial activity or spend (e.g. 500000)?" }] };
    }

    case "onboarding_spend": {
      if (!input) return { context, replies: [{ text: "Roughly what's your monthly financial activity or spend?" }] };
      return { context: { state: "onboarding_email", draft: { ...draft, monthlySpend: input } }, replies: [{ text: "Last step - what's a recovery email we can use if you ever switch phones?" }] };
    }

    case "onboarding_email": {
      if (!isEmail(input)) return { context, replies: [{ text: "That doesn't look like a valid email. Please try again." }] };
      const otp = session.generateOtp();
      const nextDraft: ChatDraft = { ...draft, email: input, otpCode: otp, otpExpiresAt: Date.now() + 10 * 60 * 1000, otpAttempts: 0 };
      return {
        context: { state: "onboarding_otp", draft: nextDraft },
        replies: [{ text: `[DEMO MODE] In production this code is emailed to ${input}. Your verification code is: ${otp}${NL}${NL}Reply with the code to confirm your email.` }],
      };
    }

    case "onboarding_otp": {
      const attempts = draft.otpAttempts ?? 0;
      if (Date.now() > (draft.otpExpiresAt ?? 0)) {
        return { context: { state: "unlinked", draft: {} }, replies: [{ text: "That code expired. Type Hi to start again." }] };
      }
      if (input !== draft.otpCode) {
        const nextAttempts = attempts + 1;
        if (nextAttempts >= 5) {
          return { context: { state: "unlinked", draft: {} }, replies: [{ text: "Too many incorrect attempts. Type Hi to start again." }] };
        }
        return { context: { state, draft: { ...draft, otpAttempts: nextAttempts } }, replies: [{ text: `That code doesn't match. Attempts left: ${5 - nextAttempts}.` }] };
      }

      const companyId = draft.isNewCompany ? store.createCompany(draft.companyName ?? "My Company", draft.industry ?? "Other").company_id : draft.resolvedCompanyId!;
      const role = draft.isNewCompany ? "admin" : "viewer";
      const user = store.createUser({ name: draft.name ?? "Demo User", email: draft.email ?? "", role, company_id: companyId });
      store.linkWhatsappAccount(session.getDevicePhoneNumber(), user.user_id);

      return {
        context: { state: "main_menu", draft: {} },
        replies: [menuReply(`Your FinCore account has been created. Welcome, ${user.name}!`)],
      };
    }

    case "recovery_email": {
      if (!isEmail(input)) return { context, replies: [{ text: "That doesn't look like a valid email. Please try again, or type Hi to create a new account." }] };
      const user = store.findUserByEmail(input);
      if (!user) return { context, replies: [{ text: "I couldn't find an account with that email. Try again, or type Hi to create a new account." }] };
      const otp = session.generateOtp();
      return {
        context: { state: "recovery_otp", draft: { recoveryUserId: user.user_id, otpCode: otp, otpExpiresAt: Date.now() + 10 * 60 * 1000, otpAttempts: 0 } },
        replies: [{ text: `[DEMO MODE] In production this code is emailed to ${input}. Your recovery code is: ${otp}` }],
      };
    }

    case "recovery_otp": {
      const attempts = draft.otpAttempts ?? 0;
      if (Date.now() > (draft.otpExpiresAt ?? 0)) {
        return { context: { state: "unlinked", draft: {} }, replies: [{ text: "That code expired. Type Login to try again." }] };
      }
      if (input !== draft.otpCode) {
        const nextAttempts = attempts + 1;
        if (nextAttempts >= 5) {
          return { context: { state: "unlinked", draft: {} }, replies: [{ text: "Too many incorrect attempts - account recovery locked for this session. Try again later." }] };
        }
        return { context: { state, draft: { ...draft, otpAttempts: nextAttempts } }, replies: [{ text: `That code doesn't match. Attempts left: ${5 - nextAttempts}.` }] };
      }
      const user = store.getUser(draft.recoveryUserId!);
      if (!user) return { context: { state: "unlinked", draft: {} }, replies: [{ text: "Something went wrong finding your account. Type Hi to start again." }] };
      store.linkWhatsappAccount(session.getDevicePhoneNumber(), user.user_id);
      return { context: { state: "main_menu", draft: {} }, replies: [menuReply(`Welcome back, ${user.name}! Your account and history have been restored.`)] };
    }

    case "main_menu": {
      const user = currentUser();
      if (!user) return { context: { state: "unlinked", draft: {} }, replies: [{ text: "Session expired. Type Hi to start again." }] };
      const menuKey = matchMenuOption(input);
      if (menuKey) return runMenuAction(menuKey, user, context);
      // Free-form question, per spec both menu and NL input are supported directly.
      return { context, replies: [{ text: answerFinancialQuestion(user.company_id, input) }] };
    }

    case "awaiting_question": {
      const user = currentUser();
      if (!user) return { context: { state: "unlinked", draft: {} }, replies: [{ text: "Session expired. Type Hi to start again." }] };
      return { context: { state: "main_menu", draft: {} }, replies: [{ text: answerFinancialQuestion(user.company_id, input) }, menuReply()] };
    }

    case "vendor_lookup_pick": {
      const user = currentUser();
      if (!user) return { context: { state: "unlinked", draft: {} }, replies: [{ text: "Session expired. Type Hi to start again." }] };
      return { context: { state: "main_menu", draft: {} }, replies: [menuReply(formatVendorRisk(user.company_id, input))] };
    }

    case "invoice_pick_mode": {
      const user = currentUser();
      if (!user) return { context: { state: "unlinked", draft: {} }, replies: [{ text: "Session expired. Type Hi to start again." }] };
      if (lower === "new") {
        return { context: { state: "invoice_new_vendor", draft: { newInvoice: {} } }, replies: [{ text: "Which vendor is this invoice from? Type part of the name." }] };
      }
      const invoice = store.getInvoice(input.toUpperCase());
      if (!invoice || invoice.company_id !== user.company_id) {
        return { context, replies: [{ text: "I couldn't find that invoice ID in your company's records. Try again, or type NEW." }] };
      }
      const analysis = analyzeInvoice(invoice.invoice_id);
      if (!analysis) return { context, replies: [{ text: "Something went wrong analyzing that invoice." }] };
      return { context: { state: "invoice_pending_action", draft: { pendingInvoiceId: invoice.invoice_id } }, replies: [{ text: conciseInvoiceMessage(analysis), quickReplies: ["Approve", "Review", "Defer", "Details"] }] };
    }

    case "invoice_new_vendor": {
      const user = currentUser();
      if (!user) return { context: { state: "unlinked", draft: {} }, replies: [{ text: "Session expired. Type Hi to start again." }] };
      const vendors = store.getVendorsByCompany(user.company_id);
      const vendor = vendors.find((v) => v.name.toLowerCase().includes(lower));
      if (!vendor) {
        const suggestions = vendors.slice(0, 5).map((v) => v.name).join(", ");
        return { context, replies: [{ text: `I couldn't match that vendor. A few in your records: ${suggestions}` }] };
      }
      return {
        context: { state: "invoice_new_department", draft: { newInvoice: { vendorId: vendor.vendor_id, vendorName: vendor.name } } },
        replies: [{ text: `Got it - ${vendor.name}. Which department is this for? (e.g. Marketing, Engineering, Finance)` }],
      };
    }

    case "invoice_new_department": {
      if (!input) return { context, replies: [{ text: "Which department is this for?" }] };
      return { context: { state: "invoice_new_amount", draft: { newInvoice: { ...draft.newInvoice, department: input } } }, replies: [{ text: "What's the invoice subtotal (before tax)?" }] };
    }

    case "invoice_new_amount": {
      const amount = Number(input.replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount <= 0) return { context, replies: [{ text: "Please enter a valid amount greater than zero." }] };
      return { context: { state: "invoice_new_tax", draft: { newInvoice: { ...draft.newInvoice, amount } } }, replies: [{ text: "What's the tax amount? Type 0 if none." }] };
    }

    case "invoice_new_tax": {
      const tax = Number(input.replace(/,/g, ""));
      if (!Number.isFinite(tax) || tax < 0) return { context, replies: [{ text: "Please enter a valid tax amount (0 or more)." }] };
      return { context: { state: "invoice_new_date", draft: { newInvoice: { ...draft.newInvoice, taxAmount: tax } } }, replies: [{ text: "What's the invoice date? (YYYY-MM-DD, or type today)" }] };
    }

    case "invoice_new_date": {
      const resolved = lower === "today" ? store.getDemoNowDate() : input;
      if (Number.isNaN(new Date(resolved).getTime())) return { context, replies: [{ text: "Please enter a valid date as YYYY-MM-DD." }] };
      return { context: { state: "invoice_new_po", draft: { newInvoice: { ...draft.newInvoice, date: resolved } } }, replies: [{ text: "Do you have a purchase order number? Type it, or NO if none." }] };
    }

    case "invoice_new_po": {
      const user = currentUser();
      if (!user) return { context: { state: "unlinked", draft: {} }, replies: [{ text: "Session expired. Type Hi to start again." }] };
      const po = lower === "no" ? null : input;
      const ni = draft.newInvoice ?? {};
      const invoice = store.createInvoice({
        company_id: user.company_id,
        vendor_id: ni.vendorId!,
        department: ni.department!,
        gl_account: store.getGlAccounts()[0]?.gl_code ?? "6000",
        amount: ni.amount!,
        currency: "INR",
        tax_amount: ni.taxAmount ?? 0,
        date: ni.date!,
        due_date: null,
        payment_terms: null,
        po_number: po,
        contract_id: null,
        submitted_by: user.user_id,
        ocr_confidence: null,
        is_recurring: false,
        notes: null,
      });
      const analysis = analyzeInvoice(invoice.invoice_id);
      if (!analysis) return { context: { state: "main_menu", draft: {} }, replies: [menuReply("Something went wrong analyzing that invoice.")] };
      return { context: { state: "invoice_pending_action", draft: { pendingInvoiceId: invoice.invoice_id } }, replies: [{ text: conciseInvoiceMessage(analysis), quickReplies: ["Approve", "Review", "Defer", "Details"] }] };
    }

    case "invoice_pending_action": {
      const user = currentUser();
      if (!user) return { context: { state: "unlinked", draft: {} }, replies: [{ text: "Session expired. Type Hi to start again." }] };
      if (lower === "details" && draft.pendingInvoiceId) {
        const analysis = analyzeInvoice(draft.pendingInvoiceId);
        if (analysis) return { context, replies: [{ text: detailedInvoiceMessage(analysis) }] };
      }
      const workflow = parseWorkflowCommand(input);
      if (workflow) {
        const reply = runWorkflowCommand(workflow, user, draft);
        return { context: { state: "main_menu", draft: {} }, replies: [reply, menuReply()] };
      }
      return { context, replies: [{ text: "Reply Approve, Review, Defer, or Reject - or type Details to see the full breakdown. Type Menu to go back." }] };
    }

    default:
      return { context: { state: "unlinked", draft: {} }, replies: [{ text: "Something went off track. Type Hi to start again." }] };
  }
}
