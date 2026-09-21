// Relative base so the build works from any subpath (GitHub Pages serves at
// /<repo-name>/).
//
// __APP_VERSION__ / __BUILD_STAMP__ feed the on-screen version watermark. The
// stamp is fixed when this config is evaluated — server start in dev, build
// time in production — so a reload that still shows the old stamp means the
// page came from cache rather than from the code on disk.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

export default {
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_STAMP__: JSON.stringify(stamp),
  },
};
