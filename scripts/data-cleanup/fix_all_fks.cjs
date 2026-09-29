const fs = require('fs');

const usersRaw = fs.readFileSync('users_clean.csv', 'utf8').trim().split('\n');
const users = new Set(usersRaw.slice(1).map(l => l.split(',')[0]));

const compsRaw = fs.readFileSync('companies_clean.csv', 'utf8').trim().split('\n');
const comps = new Set(compsRaw.slice(1).map(l => l.split(',')[0]));

const vendsRaw = fs.readFileSync('docs/clean-datasets/vendors.csv', 'utf8').trim().split('\n');
const vends = new Set(vendsRaw.slice(1).map(l => l.split(',')[0]));

const glRaw = fs.readFileSync('docs/clean-datasets/gl_accounts.csv', 'utf8').trim().split('\n');
const gls = new Set(glRaw.slice(1).map(l => l.split(',')[0]));

const invRaw = fs.readFileSync('docs/clean-datasets/invoices_clean.csv', 'utf8').trim().split('\n');
const invs = new Set(invRaw.slice(1).map(l => l.split(',')[0]));

function fixFile(file, fkMappings) {
    if (!fs.existsSync(`docs/clean-datasets/${file}`)) return;
    const lines = fs.readFileSync(`docs/clean-datasets/${file}`, 'utf8').trim().split('\n');
    const headerParts = lines[0].split(',');
    
    const checks = [];
    for (const mapping of fkMappings) {
        const idx = headerParts.indexOf(mapping.col);
        if (idx !== -1) checks.push({ idx, validSet: mapping.set, col: mapping.col });
    }
    
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let parts = lines[i].split(',');
        
        for (const check of checks) {
            let val = parts[check.idx];
            if (val && val.trim() !== '') {
                if (check.col === 'user_id' || check.col === 'submitted_by' || check.col === 'decided_by' || check.col === 'changed_by') {
                    if (!val.includes('-D1') && !val.includes('-D2')) {
                        if (users.has(val + '-D1')) val = val + '-D1';
                        else if (users.has(val + '-D2')) val = val + '-D2';
                    }
                }
                
                if (!check.validSet.has(val)) {
                    parts[check.idx] = ''; // invalid FK, nullify
                } else {
                    parts[check.idx] = val;
                }
            }
        }
        lines[i] = parts.join(',');
    }
    fs.writeFileSync(`docs/clean-datasets/${file}`, lines.join('\n'));
    console.log('Fixed ' + file);
}

fixFile('invoices_clean.csv', [
    {col: 'company_id', set: comps},
    {col: 'vendor_id', set: vends},
    {col: 'gl_account', set: gls},
    {col: 'submitted_by', set: users}
]);
fixFile('payments.csv', [
    {col: 'company_id', set: comps},
    {col: 'invoice_id', set: invs}
]);
fixFile('budgets.csv', [
    {col: 'company_id', set: comps}
]);
fixFile('cash_transactions.csv', [
    {col: 'company_id', set: comps}
]);
fixFile('decisions.csv', [
    {col: 'company_id', set: comps},
    {col: 'invoice_id', set: invs},
    {col: 'decided_by', set: users}
]);
fixFile('auth_log.csv', [
    {col: 'company_id', set: comps},
    {col: 'user_id', set: users}
]);
fixFile('vendor_bank_changes.csv', [
    {col: 'company_id', set: comps},
    {col: 'vendor_id', set: vends},
    {col: 'changed_by', set: users}
]);
