#!/usr/bin/env node
// One-time utility: convert docs/seed-data/*.csv into chunked INSERT SQL.
// Usage:
//   node scripts/seed-sql.mjs info                    -> list tables, row counts, chunk counts
//   node scripts/seed-sql.mjs <table> <chunkIdx>      -> print chunkIdx-th INSERT (0-based)
// Chunk sizes chosen so each printed chunk stays well under ~28 KB stdout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'docs', 'seed-data');

// Parses RFC-4180-ish CSV (quoted fields, doubled quotes, CRLF) into rows of fields.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const lit = (v) => (v === '' ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
const boolLit = (v) => (v === '' ? 'NULL' : v.toLowerCase() === 'true' ? 'true' : 'false');
const numLit = (v) => (v === '' ? 'NULL' : v);

// T = target table, F = csv filename, C = columns [name, kind], X = optional row transformer
const TABLES = {
  companies: {
    file: 'companies.csv',
    cols: [['company_id', 't'], ['name', 't'], ['industry', 't'], ['country', 't'], ['plan_tier', 't']],
  },
  gl_accounts: {
    file: 'gl_accounts.csv',
    cols: [['gl_code', 't'], ['category', 't'], ['description', 't']],
  },
  users: {
    file: 'users.csv',
    cols: [['user_id', 't'], ['name', 't'], ['email', 't'], ['legacy_password_hash', 't'], ['role', 't'], ['company_id', 't'], ['mfa_enabled', 'b'], ['account_status', 't'], ['failed_login_attempts', 'n'], ['last_login_at', 't'], ['created_at', 't']],
  },
  vendors: {
    file: 'vendors.csv',
    cols: [['vendor_id', 't'], ['company_id', 't'], ['name', 't'], ['category', 't'], ['risk_profile', 't'], ['status', 't'], ['bank_name', 't'], ['bank_account_number', 't'], ['tax_id', 't'], ['onboarded_date', 't']],
  },
  vendor_bank_changes: {
    file: 'vendor_bank_changes.csv',
    cols: [['change_id', 't'], ['vendor_id', 't'], ['company_id', 't'], ['old_account_number', 't'], ['new_account_number', 't'], ['old_bank_name', 't'], ['new_bank_name', 't'], ['changed_at', 't'], ['changed_by', 't']],
  },
  invoices: {
    file: 'invoices.csv',
    cols: [['invoice_id', 't'], ['company_id', 't'], ['vendor_id', 't'], ['department', 't'], ['gl_account', 't'], ['subtotal', 'n'], ['tax_amount', 'n'], ['total_amount', 'n'], ['currency', 't'], ['date', 't'], ['due_date', 't'], ['payment_terms', 't'], ['status', 't'], ['po_number', 't'], ['contract_id', 't'], ['submitted_by', 't'], ['submitted_at', 't'], ['source_channel', 't'], ['ocr_confidence', 'n'], ['is_recurring', 'b'], ['notes', 't']],
    // CSV cols: 0 invoice_id 1 company_id 2 vendor_id 3 department 4 gl_account 5 amount 6 currency 7 tax_amount ...
    map: (r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[7], (parseFloat(r[5]) + parseFloat(r[7])).toFixed(2), r[6], r[8], r[9], r[10], r[11], r[12], r[13], r[14], r[15], r[16], r[17], r[18], r[19]],
  },
  payments: {
    file: 'payments.csv',
    cols: [['payment_id', 't'], ['company_id', 't'], ['invoice_id', 't'], ['amount', 'n'], ['status', 't'], ['payment_method', 't'], ['bank_reference', 't'], ['payment_date', 't']],
  },
  budgets: {
    file: 'budgets.csv',
    cols: [['budget_id', 't'], ['company_id', 't'], ['department', 't'], ['period', 't'], ['allocated', 'n'], ['spent', 'n'], ['remaining', 'n']],
  },
  transactions: {
    file: 'cash_transactions.csv',
    cols: [['transaction_id', 't'], ['company_id', 't'], ['date', 't'], ['type', 't'], ['category', 't'], ['amount', 'n']],
  },
  decisions: {
    file: 'decisions.csv',
    cols: [['decision_id', 't'], ['company_id', 't'], ['invoice_id', 't'], ['recommendation', 't'], ['reasoning', 't'], ['confidence_score', 'n'], ['decided_by', 't'], ['"timestamp"', 't']],
  },
  auth_log: {
    file: 'auth_log.csv',
    cols: [['log_id', 't'], ['user_id', 't'], ['company_id', 't'], ['event_type', 't'], ['ip_address', 't'], ['device', 't'], ['success', 'b'], ['"timestamp"', 't']],
  },
  demo_anomaly_answer_key: {
    file: 'anomaly_answer_key.csv',
    cols: [['id', 't'], ['source_table', 't'], ['related_id', 't'], ['anomaly_type', 't'], ['description', 't']],
  },
};

const DEFAULT_CHUNK = {
  companies: 500, gl_accounts: 500, users: 500, vendors: 500, vendor_bank_changes: 500,
  invoices: 100, payments: 200, budgets: 250, transactions: 400, decisions: 100,
  auth_log: 200, demo_anomaly_answer_key: 500,
};

function toSqlValue(v, kind) {
  if (kind === 'b') return boolLit(v);
  if (kind === 'n') return numLit(v);
  return lit(v);
}

function buildRows(table) {
  const spec = TABLES[table];
  const raw = parseCsv(fs.readFileSync(path.join(DATA_DIR, spec.file), 'utf8'));
  const header = raw[0];
  const data = raw.slice(1);
  return data.map((r) => (spec.map ? spec.map(r) : r));
}

const table = process.argv[2];
if (table === 'info') {
  for (const t of Object.keys(TABLES)) {
    const rows = buildRows(t);
    const chunk = DEFAULT_CHUNK[t];
    console.log(`${t}\t${rows.length}\t${Math.ceil(rows.length / chunk)}`);
  }
  process.exit(0);
}

if (!TABLES[table]) {
  console.error(`Unknown table '${table}'.`);
  process.exit(1);
}

const chunkIdx = parseInt(process.argv[3] || '0', 10);
const chunkSize = process.argv[4] ? parseInt(process.argv[4], 10) : DEFAULT_CHUNK[table];
const rows = buildRows(table);
const spec = TABLES[table];

const start = chunkIdx * chunkSize;
const slice = rows.slice(start, start + chunkSize);
if (slice.length === 0) {
  console.error(`Chunk ${chunkIdx} out of range (0..${Math.ceil(rows.length / chunkSize) - 1}).`);
  process.exit(1);
}

const colList = spec.cols.map(([n]) => n).join(', ');
const values = slice.map((r) => `(${r.map((v, i) => toSqlValue(v, spec.cols[i][1])).join(', ')})`).join(',\n  ');
console.log(`insert into ${table} (${colList}) values\n  ${values};`);
