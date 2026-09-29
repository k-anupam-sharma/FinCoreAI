// Duplicate invoice detection — multi-signal, never a single exact-match rule.
//
// Scores this invoice against other invoices from the same vendor using
// amount closeness, date proximity, PO number match, and free-text
// similarity on notes. Returns the best match plus the evidence used, so
// the decision engine and explanation layer can cite exactly why.

import type { Invoice } from "@/types/fincore";

export interface DuplicateMatch {
  invoiceId: string;
  similarity: number; // 0-100
  evidence: string[];
}

export interface DuplicateResult {
  score: number; // 0-100, best match's similarity
  bestMatch: DuplicateMatch | null;
  allMatches: DuplicateMatch[];
}

function wordSet(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  return new Set(text.toLowerCase().split(/\W+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.abs(a - b) / (1000 * 60 * 60 * 24);
}

export function detectDuplicates(invoice: Invoice, candidates: Invoice[]): DuplicateResult {
  const others = candidates.filter((c) => c.invoice_id !== invoice.invoice_id && c.vendor_id === invoice.vendor_id);
  const matches: DuplicateMatch[] = [];

  for (const other of others) {
    const evidence: string[] = [];
    let score = 0;

    const amountDiffPct = Math.abs(invoice.amount - other.amount) / Math.max(invoice.amount, other.amount, 1);
    if (amountDiffPct < 0.2) {
      const amountScore = 40 * (1 - amountDiffPct / 0.2);
      score += amountScore;
      if (amountDiffPct < 0.02) evidence.push(`Amount is nearly identical to ${other.invoice_id} (within 2%)`);
    }

    const dateDiff = daysBetween(invoice.date, other.date);
    if (dateDiff <= 14) {
      const dateScore = 25 * (1 - dateDiff / 14);
      score += dateScore;
      if (dateDiff <= 3) evidence.push(`Dated within ${Math.round(dateDiff)} day(s) of ${other.invoice_id}`);
    }

    if (invoice.po_number && other.po_number && invoice.po_number === other.po_number) {
      score += 20;
      evidence.push(`Same purchase order (${invoice.po_number}) as ${other.invoice_id}`);
    }

    const notesSim = jaccard(wordSet(invoice.notes), wordSet(other.notes));
    if (notesSim > 0) {
      score += 15 * notesSim;
      if (notesSim > 0.5) evidence.push(`Similar description text to ${other.invoice_id}`);
    }

    score = Math.min(100, Math.round(score));
    if (score > 0) {
      matches.push({ invoiceId: other.invoice_id, similarity: score, evidence });
    }
  }

  matches.sort((a, b) => b.similarity - a.similarity);
  const bestMatch = matches[0] ?? null;
  return { score: bestMatch?.similarity ?? 0, bestMatch, allMatches: matches.slice(0, 5) };
}
