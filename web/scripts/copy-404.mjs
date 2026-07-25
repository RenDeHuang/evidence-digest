// GitHub Pages has no server-side rewrite, so a deep link (e.g. /evidence-digest/study/123)
// 404s on a hard refresh. GitHub's documented workaround is to serve a 404.html that is a
// copy of index.html: the SPA boots, reads location.pathname, and the router takes it from
// there. This runs as a postbuild step so `dist/404.html` always mirrors the real entry point.
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, '..', 'dist');

await copyFile(path.join(dist, 'index.html'), path.join(dist, '404.html'));
console.log('copied dist/index.html -> dist/404.html');
