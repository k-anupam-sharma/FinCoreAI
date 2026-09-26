const fs = require('fs');
const lines = fs.readFileSync('docs/clean-datasets/invoices.csv', 'utf8').trim().split('\n');
const header = 'invoice_id,company_id,vendor_id,department,gl_account,subtotal,tax_amount,total_amount,currency,date,due_date,payment_terms,status,po_number,contract_id,submitted_by,submitted_at,source_channel,ocr_confidence,is_recurring,notes,file_storage_path';
const out = [header];
for (let i = 1; i < lines.length; i++) {
  if (!lines[i].trim()) continue;
  const parts = lines[i].split(',');
  const total_amount = parseFloat(parts[5]) || 0;
  const tax_amount = parseFloat(parts[7]) || 0;
  const subtotal = (total_amount - tax_amount).toFixed(2);
  
  let is_rec = parts[18] ? parts[18].toLowerCase() : 'false';
  is_rec = is_rec === 'true' ? 'true' : 'false';
  
  let source = parts[16];
  if (!source || !source.trim()) source = 'email_upload';
  
  const newRow = [
    parts[0], parts[1], parts[2], parts[3], parts[4],
    subtotal, parts[7], parts[5], parts[6], parts[8], parts[9],
    parts[10], parts[11], parts[12], parts[13], parts[14], parts[15],
    source, parts[17], is_rec, parts[19] || '', ''
  ];
  out.push(newRow.join(','));
}
fs.writeFileSync('docs/clean-datasets/invoices_clean.csv', out.join('\n'));
console.log('invoices_clean.csv generated');
