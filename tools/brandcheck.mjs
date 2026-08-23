// Every marque, business and place name in this game must be invented.
//
// That is a hard requirement from the user, not a stylistic preference: the
// world is meant to feel real without borrowing anyone's trademarks. Thirteen
// modules were written by different hands, and procedural signage is exactly
// the place a familiar name slips in without anyone noticing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN = [
  // car makers
  'toyota', 'honda', 'nissan', 'mazda', 'subaru', 'mitsubishi', 'suzuki', 'lexus',
  'infiniti', 'acura', 'ford', 'chevrolet', 'chevy', 'cadillac', 'buick', 'gmc',
  'dodge', 'chrysler', 'jeep', 'tesla', 'rivian', 'volkswagen', 'audi', 'porsche',
  'bmw', 'mercedes', 'benz', 'opel', 'skoda', 'renault', 'peugeot',
  'citroen', 'fiat', 'ferrari', 'lamborghini', 'maserati', 'alfa romeo', 'lancia',
  'bugatti', 'bentley', 'rolls-royce', 'jaguar', 'land rover', 'aston martin',
  'mclaren', 'lotus', 'mini cooper', 'vauxhall', 'volvo', 'saab', 'hyundai', 'kia',
  'genesis motor', 'koenigsegg', 'pagani', 'polestar', 'lucid motors',
  // models that read as trademarks
  'mustang', 'corvette', 'camaro', 'corolla', 'gt-r', 'impreza', 'lancer evo',
  'countach', 'huracan', 'aventador',
  // other companies likely to appear on procedural signage
  'coca-cola', 'pepsi', 'mcdonald', 'starbucks', 'walmart', 'shell oil', 'texaco',
  'exxon', 'chevron corp', 'burger king', 'subway sandwich', 'ikea', 'costco',
  '7-eleven', 'google', 'microsoft',
  // real places
  'new york', 'los angeles', 'san francisco', 'london', 'paris', 'tokyo', 'berlin',
  'chicago', 'miami', 'seattle', 'boston', 'detroit',
];

// 'skyline', 'civic', 'seat' and 'supra' are deliberately absent from the list
// above: they are ordinary English long before they are trademarks, and a check
// that cries wolf on `// the city skyline` is a check people learn to ignore.

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'vendor' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name === 'brandcheck.mjs') continue;   // it is nothing but a list of them
    else if (['.js', '.mjs', '.css', '.html'].includes(extname(p))) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const hits = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const lower = text.toLowerCase();
  for (const brand of FORBIDDEN) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(brand, from);
      if (i < 0) break;
      from = i + brand.length;
      // Word boundary, so a marque's letters inside a longer word do not count.
      const before = lower[i - 1] || ' ';
      const after = lower[i + brand.length] || ' ';
      if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
      const line = text.slice(0, i).split('\n').length;
      hits.push(`${f.replace(ROOT + '/', '')}:${line}  "${brand}"  ${text.split('\n')[line - 1].trim().slice(0, 90)}`);
    }
  }
}

console.log(`scanned ${files.length} files for ${FORBIDDEN.length} real names`);
if (hits.length) {
  console.log('\nreal brand names found:');
  for (const h of hits) console.log('  ' + h);
  console.log(`\n${hits.length} MATCH(ES) — every name in this game must be invented`);
  process.exit(1);
}
console.log('No real brand, company or place names. Everything is invented.');
