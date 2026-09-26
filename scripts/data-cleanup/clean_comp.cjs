const fs = require('fs');
const lines = fs.readFileSync('docs/seed-data/companies.csv', 'utf8').trim().split('\n');
const header = 'company_id,name,industry,country,plan_tier,created_at';
const out = [header];
for (let i = 1; i < lines.length; i++) {
  if (!lines[i].trim()) continue;
  out.push(`${lines[i]},2025-01-01 00:00:00`);
}
fs.writeFileSync('companies_clean.csv', out.join('\n'));
console.log('Cleaned companies.csv created!');
