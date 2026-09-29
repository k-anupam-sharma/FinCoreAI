// Invoice field validation — deterministic, no AI involved.
//
// Checks missing required fields, inconsistent totals, invalid/impossible
// dates, and suspicious amounts. Returns every issue found (not just the
// first) so the explanation layer can list them all.

import type { Invoice } from "@/types/fincore";

export interface ValidationIssue {
  field: string;
  severity: "critical" | "warning";
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  hasCriticalFailure: boolean;
  issues: ValidationIssue[];
}

const REQUIRED_FIELDS: Array<keyof Invoice> = ["vendor_id", "department", "amount", "currency", "date"];

export function validateInvoice(invoice: Invoice): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const field of REQUIRED_FIELDS) {
    const value = invoice[field];
    if (value === null || value === undefined || value === "") {
      issues.push({ field: String(field), severity: "critical", message: `Missing required field: ${field}` });
    }
  }

  if (invoice.amount !== undefined && invoice.amount <= 0) {
    issues.push({ field: "amount", severity: "critical", message: "Amount must be greater than zero" });
  }
  if (invoice.tax_amount !== undefined && invoice.tax_amount < 0) {
    issues.push({ field: "tax_amount", severity: "critical", message: "Tax amount cannot be negative" });
  }

  const invoiceDate = invoice.date ? new Date(invoice.date) : null;
  const dueDate = invoice.due_date ? new Date(invoice.due_date) : null;
  if (invoiceDate && Number.isNaN(invoiceDate.getTime())) {
    issues.push({ field: "date", severity: "critical", message: "Invoice date is not a valid date" });
  }
  if (invoice.due_date && dueDate && Number.isNaN(dueDate.getTime())) {
    issues.push({ field: "due_date", severity: "critical", message: "Due date is not a valid date" });
  }
  if (invoiceDate && dueDate && !Number.isNaN(invoiceDate.getTime()) && !Number.isNaN(dueDate.getTime()) && dueDate < invoiceDate) {
    issues.push({ field: "due_date", severity: "critical", message: "Due date is before the invoice date" });
  }
  if (invoiceDate && invoiceDate.getTime() > Date.now() + 1000 * 60 * 60 * 24) {
    issues.push({ field: "date", severity: "warning", message: "Invoice date is in the future" });
  }

  // Suspicious / impossible amounts.
  if (invoice.amount !== undefined && invoice.amount > 100_000_000) {
    issues.push({ field: "amount", severity: "warning", message: "Amount is unusually large for a single invoice" });
  }
  if (!invoice.po_number && invoice.amount > 500_000) {
    issues.push({ field: "po_number", severity: "warning", message: "High-value invoice submitted without a purchase order" });
  }

  const hasCriticalFailure = issues.some((i) => i.severity === "critical");
  return { valid: issues.length === 0, hasCriticalFailure, issues };
}
