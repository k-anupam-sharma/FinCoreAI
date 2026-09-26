const fs = require('fs');
const path = require('path');

const srcDir = 'FinCore datasets';
const destDir = 'docs/clean-datasets';

const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.csv') && f !== 'users.csv' && f !== 'companies.csv');

for (const file of files) {
    const raw = fs.readFileSync(path.join(srcDir, file), 'utf8').trim().split('\n');
    if (raw.length === 0) continue;
    
    let originalHeader = raw[0].split(',');
    let dsIndex = originalHeader.indexOf('dataset_source');
    let compIndex = originalHeader.indexOf('company_id');
    let statusIndex = originalHeader.indexOf('status');
    
    let header = [...originalHeader];
    if (dsIndex !== -1) header.splice(dsIndex, 1);
    
    const out = [header.join(',')];
    
    for (let i = 1; i < raw.length; i++) {
        if (!raw[i].trim()) continue;
        let parts = raw[i].split(',');
        
        if (compIndex !== -1 && parts[compIndex]) {
            parts[compIndex] = parts[compIndex].replace(/-D\d+/g, '');
        }
        
        if (statusIndex !== -1) {
            if (!parts[statusIndex] || !parts[statusIndex].trim()) {
                if (file === 'vendors.csv') parts[statusIndex] = 'Active';
                else if (file === 'invoices.csv' || file === 'payments.csv') parts[statusIndex] = 'Pending';
            }
        }
        
        if (dsIndex !== -1 && parts.length > dsIndex) {
            parts.splice(dsIndex, 1);
        }
        
        out.push(parts.join(','));
    }
    
    fs.writeFileSync(path.join(destDir, file), out.join('\n'));
    console.log(`Cleaned ${file}`);
}
