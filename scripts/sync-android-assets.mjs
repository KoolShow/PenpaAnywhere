import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const androidAssetsDir = path.join(rootDir, 'android', 'app', 'src', 'main', 'assets', 'www');

if (!fs.existsSync(distDir)) {
  console.error('dist/ not found. Run `pnpm run build` first.');
  process.exit(1);
}

fs.rmSync(androidAssetsDir, { recursive: true, force: true });
fs.mkdirSync(androidAssetsDir, { recursive: true });
fs.cpSync(distDir, androidAssetsDir, { recursive: true, force: true });
console.log(`Synced dist/ -> ${androidAssetsDir}`);
