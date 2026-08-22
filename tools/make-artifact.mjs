// Turns dist-single/index.html (a complete web page) into dist-single/artifact.html:
// the same page WITHOUT the <html>/<head>/<body> wrapper, which is the format
// Claude's "Artifact" publishing expects. Run after:  npm run build:single
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../dist-single/index.html', import.meta.url), 'utf8');

const pick = (re) => (src.match(re) || []).map((m) => m);
const title = (src.match(/<title>[\s\S]*?<\/title>/) || [''])[0];
// Google Fonts links are the one external resource the artifact host allows.
const fontLinks = pick(/<link[^>]*fonts\.googleapis\.com[^>]*>/g).join('\n');
const styles = pick(/<style[^>]*>[\s\S]*?<\/style>/g).join('\n');
const scripts = pick(/<script[^>]*>[\s\S]*?<\/script>/g).join('\n');
const body = (src.match(/<body[^>]*>([\s\S]*?)<\/body>/) || ['', ''])[1];

const out = `${title}\n${fontLinks}\n${styles}\n${body}\n${scripts}\n`;
writeFileSync(new URL('../dist-single/artifact.html', import.meta.url), out);
console.log(`artifact.html written (${(out.length / 1024).toFixed(0)} kB)`);
