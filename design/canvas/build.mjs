// Assembles each parts/<Name>.body.html into a standalone <Name>.dc.html,
// injecting the shared token stylesheet so every artboard is self-contained.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const tokens = readFileSync('_tokens.css', 'utf8');
const FONTS =
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700' +
  '&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';

for (const file of readdirSync('parts').filter((f) => f.endsWith('.body.html'))) {
  const name = file.replace('.body.html', '');
  const raw = readFileSync(`parts/${file}`, 'utf8');
  const [propsLine, ...bodyLines] = raw.split('\n');
  if (!propsLine.startsWith('<!--props:')) throw new Error(`${file}: missing props header`);
  const props = propsLine.slice('<!--props:'.length, propsLine.lastIndexOf('-->')).trim();
  const body = bodyLines.join('\n').trim();

  const out = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="${FONTS}">
  <style>
${tokens}  </style>
</helmet>
${body}
</x-dc>
<script data-dc-script data-props='${props}'>
class Component extends DCLogic {
  renderVals() {
    return { theme: this.props.theme ?? 'dark' };
  }
}
</script>
</body>
</html>
`;
  writeFileSync(`${name}.dc.html`, out);
  console.log(`built ${name}.dc.html  (${out.length} bytes)`);
}
