import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const targetDir = path.join(rootDir, 'public', 'penpa-edit');
const submoduleDir = process.env.PENPA_SUBMODULE_DIR || path.join(rootDir, 'penpa-edit');
const docsDir = path.join(submoduleDir, 'docs');

if (!fs.existsSync(docsDir)) {
  console.log(`Submodule docs not found at ${docsDir}, initializing git submodule penpa-edit...`);
  execSync('git submodule update --init --recursive penpa-edit', {
    cwd: rootDir,
    stdio: 'inherit',
  });
}

if (!fs.existsSync(docsDir)) {
  console.error(`Error: Penpa+ submodule docs directory not found at ${docsDir}`);
  process.exit(1);
}

const patchDir = path.join(rootDir, 'src', 'penpa-patch');

fs.mkdirSync(targetDir, { recursive: true });
fs.cpSync(docsDir, targetDir, { recursive: true, force: true });

// Cache small CDN assets locally so Tauri / Android overlay runs reliably offline
const vendorDir = path.join(targetDir, 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

const cdnAssets = [
  {
    url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css',
    dest: path.join(vendorDir, 'font-awesome.min.css'),
    replacePattern: /<link\s+href="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/4\.7\.0\/css\/font-awesome\.min\.css"\s+rel="stylesheet">/i,
    replacement: '<link href="./vendor/font-awesome.min.css" rel="stylesheet">',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/sweetalert2@10/dist/sweetalert2.all.min.js',
    dest: path.join(vendorDir, 'sweetalert2.all.min.js'),
    replacePattern: /<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/sweetalert2@10"><\/script>/i,
    replacement: '<script src="./vendor/sweetalert2.all.min.js"></script>',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/pure-md5@0.1.14/lib/index.min.js',
    dest: path.join(vendorDir, 'pure-md5.min.js'),
    replacePattern: /<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/pure-md5@0\.1\.14\/lib\/index\.min\.js"><\/script>/i,
    replacement: '<script src="./vendor/pure-md5.min.js"></script>',
  },
];

async function downloadFile(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100) {
    return true;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(`Cached vendor asset: ${path.basename(dest)} (${buf.length} bytes)`);
    return true;
  } catch (err) {
    console.warn(`Warning: failed to cache ${url}: ${err.message}`);
    return false;
  }
}

async function run() {
  const indexPath = path.join(targetDir, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  for (const asset of cdnAssets) {
    const ok = await downloadFile(asset.url, asset.dest);
    if (ok) {
      html = html.replace(asset.replacePattern, asset.replacement);
    }
  }

  // Strip Google Analytics scripts so offline/transparent overlays don't hang or spam errors
  html = html.replace(
    /<script\s+async\s+src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?[^"]*"><\/script>/gi,
    '',
  );
  html = html.replace(
    /<script>\s*window\.dataLayer\s*=[\s\S]*?<\/script>/gi,
    '',
  );

  // Copy our lightweight non-invasive bridge & dock CSS
  if (fs.existsSync(patchDir)) {
    for (const file of fs.readdirSync(patchDir)) {
      fs.copyFileSync(path.join(patchDir, file), path.join(targetDir, file));
    }
  }

  // Inject our dock stylesheet and bridge script without modifying any penpa core JS
  const dockTag = '    <link rel="stylesheet" type="text/css" href="./penpacanvas-dock.css" />\n';
  const bridgeTag = '    <script type="text/javascript" src="./penpacanvas-bridge.js"></script>\n';

  if (!html.includes('penpacanvas-dock.css')) {
    html = html.replace('</head>', `${dockTag}</head>`);
  }
  if (!html.includes('penpacanvas-bridge.js')) {
    html = html.replace('</body>', `${bridgeTag}</body>`);
  }

  fs.writeFileSync(indexPath, html, 'utf8');
  console.log(`Synced Penpa+ submodule docs (${docsDir}) -> ${targetDir}`);
}

run();
