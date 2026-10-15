// Builds the live demo into one self-contained index.html (no server needed).
// Usage: npm install && npm run build
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

const result = await build({
  entryPoints: ['src/main.jsx'],
  bundle: true,
  minify: true,
  write: false,
  format: 'iife',
  target: ['es2019'],
  jsx: 'automatic',
  loader: { '.csv': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ISP Customer Analytics</title>
<meta name="description" content="Live demo of an M-Pesa customer analytics app for a Kenyan ISP, built by Gidraff Mbugua Mwangi. Runs on synthetic data.">
<style>html,body{margin:0;background:#F6F3EC}</style>
</head>
<body>
<div id="root"></div>
<noscript>This demo needs JavaScript.</noscript>
<script>${js}</script>
</body>
</html>
`;
writeFileSync('index.html', html);
console.log('index.html written:', (html.length / 1024).toFixed(0), 'KB');
