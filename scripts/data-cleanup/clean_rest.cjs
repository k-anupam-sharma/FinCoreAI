const fs = require('fs');
const path = require('path');

const srcDir = 'FinCore datasets';
const destDir = 'docs/clean-datasets';
if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.csv') && f !== 'users.csv' && f !== 'companies.csv');

for (const file of files) {
    const raw = fs.readFileSync(path.join(srcDir, file), 'utf8').trim().split('\n');
    if (raw.length === 0) continue;
    
    // Fix header: remove dataset_source
    let header = raw[0].split(',');
    let dsIndex = header.indexOf('dataset_source');
    if (dsIndex !== -1) {
        header.splice(dsIndex, 1);
    }
    
    const out = [header.join(',')];
    
    for (let i = 1; i < raw.length; i++) {
        if (!raw[i].trim()) continue;
        let parts = raw[i].split(',');
        
        if (dsIndex !== -1 && parts.length > dsIndex) {
            parts.splice(dsIndex, 1);
        }
        
        // Globally remove -D1, -D2, -D3... to fix foreign keys
        let rowStr = parts.join(',');
        rowStr = rowStr.replace(/-D\d+/g, '');
        
        out.push(rowStr);
    }
    
    fs.writeFileSync(path.join(destDir, file), out.join('\n'));
    console.log(`Cleaned ${file}`);
}
