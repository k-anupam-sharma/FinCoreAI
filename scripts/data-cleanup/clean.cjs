const fs = require('fs');
const lines = fs.readFileSync('docs/seed-data/users.csv', 'utf8').trim().split('\n');
const header = 'user_id,name,email,legacy_password_hash,role,company_id,mfa_enabled,account_status,failed_login_attempts,last_login_at,created_at';
const out = [header];
for (let i = 1; i < lines.length; i++) {
  const parts = lines[i].split(',');
  if (parts.length < 11) continue;
  const user_id = parts[0];
  const name = parts[1];
  const email = parts[2];
  const pass = parts[3];
  const role = parts[4];
  const company = parts[5].replace('-D1', '');
  const mfa = parts[6];
  const status = parts[7];
  const failed = parseInt(parts[8]) || 0;
  const last = parts[9];
  const created = parts[10];
  out.push(`${user_id},${name},${email},${pass},${role},${company},${mfa},${status},${failed},${last},${created}`);
}
fs.writeFileSync('users_clean.csv', out.join('\n'));
console.log('Cleaned users.csv created!');
