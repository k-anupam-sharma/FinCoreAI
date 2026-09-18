// FinCore AI — domain types.
//
// These mirror the schema drafted in docs/database-schema.sql. This demo runs
// entirely client-side (Enter Cloud is not provisioned yet) so these types
// are shared between the seed data loader and the deterministic logic
// engine — the same shapes a real backend function would work with.

export type Role =
  | "admin"
  | "ap_clerk"
  | "auditor"
  | "department_head"
  | "finance_manager"
  | "viewer";

export type InvoiceStatus = "Pending" | "Paid" | "Overdue" | "Disputed" | "Cancelled";
export type VendorRiskProfile = "Low" | "Medium" | "High";
export type VendorStatus = "Active" | "Blacklisted" | "Under Review";
export type SourceChannel = "whatsapp_bot" | "email_upload" | "portal_upload" | "scanned_document";
export type DecisionRecommendation =
  | "Approve"
  | "Escalate"
  | "Flag for Review"
  | "Hold - Duplicate Suspected"
  | "Reject";

export interface Company {
  company_id: string;
  name: string;
  industry: string;
  country: string;
  plan_tier: string;
}

export interface FinUser {
  user_id: string;
  name: string;
  email: string;
  role: Role;
  company_id: string;
  mfa_enabled: boolean;
  account_status: "Active" | "Locked" | "Suspended";
  failed_login_attempts: number;
  last_login_at: string | null;
  created_at: string;
}

export interface Vendor {
  vendor_id: string;
  company_id: string;
  name: string;
  category: string;
  risk_profile: VendorRiskProfile;
  status: VendorStatus;
  bank_name: string;
  bank_account_number: string;
  tax_id: string;
  onboarded_date: string;
}

export interface VendorBankChange {
  change_id: string;
  vendor_id: string;
  company_id: string;
  old_account_number: string;
  new_account_number: string;
  old_bank_name: string;
  new_bank_name: string;
  changed_at: string;
  changed_by: string;
}

export interface GlAccount {
  gl_code: string;
  category: string;
  description: string;
}

export interface Invoice {
  invoice_id: string;
  company_id: string;
  vendor_id: string;
  department: string;
  gl_account: string;
  amount: number; // subtotal
  currency: string;
  tax_amount: number;
  date: string;
  due_date: string | null;
  payment_terms: string | null;
  status: InvoiceStatus;
  po_number: string | null;
  contract_id: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  source_channel: SourceChannel;
  ocr_confidence: number | null;
  is_recurring: boolean;
  notes: string | null;
}

export interface Payment {
  payment_id: string;
  company_id: string;
  invoice_id: string;
  amount: number;
  status: "Completed" | "Failed" | "Pending" | "Refunded";
  payment_method: string;
  bank_reference: string;
  payment_date: string;
}

export interface Budget {
  budget_id: string;
  company_id: string;
  department: string;
  period: string; // YYYY-MM
  allocated: number;
  spent: number;
  remaining: number;
}

export interface Transaction {
  transaction_id: string;
  company_id: string;
  date: string;
  type: "inflow" | "outflow";
  category: string;
  amount: number;
}

export interface Decision {
  decision_id: string;
  company_id: string;
  invoice_id: string;
  recommendation: DecisionRecommendation;
  reasoning: string;
  confidence_score: number;
  decided_by: string;
  timestamp: string;
}

export interface AuthLogEntry {
  log_id: string;
  user_id: string | null;
  company_id: string | null;
  event_type:
    | "login_success"
    | "login_failed"
    | "mfa_verified"
    | "password_reset"
    | "otp_requested"
    | "otp_verified"
    | "account_locked";
  ip_address: string | null;
  device: string | null;
  success: boolean;
  timestamp: string;
}

export interface AnomalyAnswerKeyEntry {
  id: string;
  source_table: string;
  related_id: string;
  anomaly_type: string;
  description: string;
}

// --- New, non-CSV, session-local entities -------------------------------

export interface WhatsappAccount {
  phone_number: string;
  user_id: string;
  status: "active" | "unlinked";
  linked_at: string;
}

export interface InvoiceAction {
  id: string;
  invoice_id: string;
  company_id: string;
  action: "approve" | "review" | "defer" | "reject";
  previous_status: InvoiceStatus;
  new_status: InvoiceStatus;
  performed_by: string;
  reason: string | null;
  created_at: string;
}
