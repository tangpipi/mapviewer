const fs = require('fs');
const path = require('path');

function printUsage() {
  console.log('Usage: node cli/index.js <map-file> [--gap <value>] [--out <report.html>]');
  console.log('  --gap, -g   Optional merge threshold. Examples: 64B, 128, 1KB, 0x40');
  console.log('  --out, -o   Optional output html path. Defaults to <map-name>_report.html beside map file');
}

function parseBytes(text) {
  if (!text) {
    return null;
  }
  const normalized = String(text).trim().replace(/\s+/g, '');
  if (!normalized) {
    return null;
  }

  if (/^0x[0-9a-f]+$/i.test(normalized)) {
    return parseInt(normalized, 16);
  }

  const m = normalized.match(/^(\d+(?:\.\d+)?)(B|BYTES|KB|MB)?$/i);
  if (!m) {
    return null;
  }

  const num = Number.parseFloat(m[1]);
  if (!Number.isFinite(num) || num < 0) {
    return null;
  }

  const unit = (m[2] || 'B').toUpperCase();
  switch (unit) {
    case 'B':
    case 'BYTES':
      return Math.round(num);
    case 'KB':
      return Math.round(num * 1024);
    case 'MB':
      return Math.round(num * 1024 * 1024);
    default:
      return null;
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  let mapArg = null;
  let gapRaw = null;
  let outRaw = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--gap' || arg === '-g') {
      if (i + 1 >= args.length) {
        console.error('Error: Missing value for --gap');
        process.exit(1);
      }
      gapRaw = args[++i];
      continue;
    }
    if (arg === '--out' || arg === '-o') {
      if (i + 1 >= args.length) {
        console.error('Error: Missing value for --out');
        process.exit(1);
      }
      outRaw = args[++i];
      continue;
    }
    if (!mapArg) {
      mapArg = arg;
      continue;
    }
  }

  if (!mapArg) {
    printUsage();
    process.exit(1);
  }

  return { mapArg, gapRaw, outRaw };
}

const { mapArg, gapRaw, outRaw } = parseArgs(process.argv);
const mapFilePath = path.resolve(process.cwd(), mapArg);

if (!fs.existsSync(mapFilePath)) {
  console.error(`Error: Map file not found at ${mapFilePath}`);
  process.exit(1);
}

const gapBytes = gapRaw == null ? null : parseBytes(gapRaw);
if (gapRaw != null && gapBytes == null) {
  console.error(`Error: Invalid --gap value: ${gapRaw}`);
  process.exit(1);
}

const mapContent = fs.readFileSync(mapFilePath, 'utf-8');
const escapedMapContent = mapContent
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')
  .replace(/<\/script>/ig, '<\\/script>');

const distHtmlPath = path.resolve(__dirname, '../dist/index.html');
if (!fs.existsSync(distHtmlPath)) {
  console.error(`Error: Built index.html not found at ${distHtmlPath}. Please run pnpm build first.`);
  process.exit(1);
}

let htmlContent = fs.readFileSync(distHtmlPath, 'utf-8');

const mapPlaceholder = '<script>window.__INJECTED_MAP_DATA__=null;</script>';
const gapPlaceholder = '<script>window.__INJECTED_MERGE_GAP__=null;</script>';
const injectedMap = `<script>window.__INJECTED_MAP_DATA__=\`${escapedMapContent}\`;</script>`;
const injectedGap = `<script>window.__INJECTED_MERGE_GAP__=${gapBytes == null ? 'null' : gapBytes};</script>`;

if (!htmlContent.includes(mapPlaceholder)) {
  console.warn(`Warning: Placeholder not found: ${mapPlaceholder}`);
}
if (!htmlContent.includes(gapPlaceholder)) {
  console.warn(`Warning: Placeholder not found: ${gapPlaceholder}`);
}

htmlContent = htmlContent.replace(mapPlaceholder, injectedMap);
htmlContent = htmlContent.replace(gapPlaceholder, injectedGap);

const parsed = path.parse(mapFilePath);
const outputPath = outRaw
  ? path.resolve(process.cwd(), outRaw)
  : path.resolve(path.dirname(mapFilePath), `${parsed.name}_report.html`);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, htmlContent, 'utf-8');

console.log(`Report generated: ${outputPath}`);
if (gapBytes != null) {
  console.log(`Injected merge gap: ${gapBytes} B`);
}
