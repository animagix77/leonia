#!/usr/bin/env node
/* Produce dist/leonia.html — one self-contained file, no network, no assets.

   The game is written as ~25 real ES modules plus three.js and its jsm addons,
   and it loads 1.9 MB of baked world data over fetch(). Flattening that into a
   single file without a bundler dependency needs two tricks:

   1. MODULES. Rather than rewriting import/export syntax (fragile, and
      three.js has 1.2 MB of it), every module's SOURCE is embedded as a
      string. At runtime we walk them in dependency order, rewrite each
      module's import specifiers to point at the Blob URL of the module it
      depends on, and create its own Blob URL. The browser then runs genuine
      ES modules with genuine semantics — nothing is transformed, so nothing
      can be subtly broken by a bad regex.

   2. DATA. The world JSON is inlined and a tiny fetch() shim serves it from
      memory, so World.load() and every other fetch path works unmodified.
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const ENTRY = 'src/main.js';
const OUT_DIR = path.join(ROOT, 'dist');
const OUT = path.join(OUT_DIR, 'leonia.html');

/* ------------------------------------------------------- module graph -- */

const sources = new Map();     // normalised path -> source text
const deps = new Map();        // normalised path -> [normalised dep paths]

const norm = (p) => p.split(path.sep).join('/');

/** Every static and dynamic import specifier in a module. */
function specifiersOf(src) {
  const out = [];
  const patterns = [
    /(?:^|[^\w.])import\s+[^'"();]*?from\s*['"]([^'"]+)['"]/g,   // import x from 'y'
    /(?:^|[^\w.])import\s*['"]([^'"]+)['"]/g,                     // side-effect import
    /(?:^|[^\w.])export\s+[^'"();]*?from\s*['"]([^'"]+)['"]/g,    // re-export
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                     // dynamic
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** Resolve a specifier from a module, honouring the 'three' import map alias. */
function resolve(fromRel, spec) {
  if (spec === 'three') return 'vendor/three.module.js';
  if (spec.startsWith('.')) {
    return norm(path.normalize(path.join(path.dirname(fromRel), spec)));
  }
  throw new Error(`bare specifier "${spec}" in ${fromRel} — only 'three' is mapped`);
}

function load(rel) {
  if (sources.has(rel)) return;
  const abs = path.join(PUB, rel);
  if (!fs.existsSync(abs)) throw new Error(`missing module: ${rel}`);
  const src = fs.readFileSync(abs, 'utf8');
  sources.set(rel, src);

  const d = [];
  for (const spec of specifiersOf(src)) {
    const r = resolve(rel, spec);
    d.push(r);
    load(r);
  }
  deps.set(rel, d);
}

/** Depth-first topological order, dependencies first. Cycles are reported. */
function topoOrder(entry) {
  const order = [];
  const state = new Map();       // 0 = visiting, 1 = done
  const stack = [];
  (function visit(rel) {
    const s = state.get(rel);
    if (s === 1) return;
    if (s === 0) {
      // A genuine cycle would break Blob-URL ordering; ES modules tolerate
      // cycles but our linear construction does not, so make it loud.
      throw new Error(`import cycle: ${[...stack, rel].join(' -> ')}`);
    }
    state.set(rel, 0);
    stack.push(rel);
    for (const d of deps.get(rel) || []) visit(d);
    stack.pop();
    state.set(rel, 1);
    order.push(rel);
  })(entry);
  return order;
}

/* ------------------------------------------------------------- build --- */

console.log('resolving module graph...');
load(ENTRY);
const order = topoOrder(ENTRY);
console.log(`  ${order.length} modules`);

console.log('reading world data...');
const worldDir = path.join(PUB, 'world');
const worldData = {};
let worldBytes = 0;
for (const f of fs.readdirSync(worldDir).filter((f) => f.endsWith('.json'))) {
  const raw = fs.readFileSync(path.join(worldDir, f), 'utf8');
  worldBytes += raw.length;
  worldData[`world/${f}`] = JSON.parse(raw);
}
console.log(`  ${Object.keys(worldData).length} files, ${(worldBytes / 1048576).toFixed(2)} MB`);

// The shell: everything inside <body> from the dev page, minus its scripts.
const shell = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const headStyle = (shell.match(/<style>[\s\S]*?<\/style>/g) || []).join('\n');
const bodyInner = (shell.match(/<body[^>]*>([\s\S]*?)<\/body>/) || [, ''])[1]
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim();

// JSON.stringify each module source so it survives embedding in a script tag.
/* JSON.stringify does not escape '<', so a literal </script> anywhere in a
   module source or in the world data would close the tag and destroy the file.
   Escaping it as \u003c is invariant under JSON.parse and JS string literals. */
const safe = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

const modulesLiteral = '{\n' + order
  .map((rel) => `  ${safe(rel)}: ${safe(sources.get(rel))}`)
  .join(',\n') + '\n}';

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LEONIA — Civic Duty</title>
${headStyle}
</head>
<body>
${bodyInner}

<script>
/* ------------------------------------------------------------------------
   LEONIA — single-file build.
   Map data (c) OpenStreetMap contributors (ODbL). Elevation: USGS 3DEP.
   Assessment data: NJ MOD-IV (public record). three.js: MIT.
   ------------------------------------------------------------------------ */
(function () {
  'use strict';

  var ORDER = ${safe(order)};
  var SRC = ${modulesLiteral};
  var DATA = ${safe(worldData)};

  /* --- fetch shim: serve the baked world JSON straight out of memory so the
     game's loader works byte-identically to the dev server. */
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var key = url.replace(/^\\.?\\//, '').split('?')[0];
    if (Object.prototype.hasOwnProperty.call(DATA, key)) {
      return Promise.resolve(new Response(JSON.stringify(DATA[key]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    // Optional vehicle-asset manifest is absent by design in this build.
    if (/assets\\/vehicles\\/manifest\\.json$/.test(key)) {
      return Promise.resolve(new Response('', { status: 404 }));
    }
    return realFetch ? realFetch(input, init)
      : Promise.reject(new Error('fetch unavailable: ' + url));
  };

  /* --- module graph: rewrite each module's specifiers to the Blob URL of the
     dependency, then blob it. Built in dependency order so every URL a module
     needs already exists. The browser executes real ES modules. */
  var urls = Object.create(null);

  function resolveSpec(from, spec) {
    if (spec === 'three') return 'vendor/three.module.js';
    if (spec.charAt(0) !== '.') return spec;
    var base = from.split('/').slice(0, -1);
    var parts = spec.split('/');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '.' || parts[i] === '') continue;
      if (parts[i] === '..') base.pop();
      else base.push(parts[i]);
    }
    return base.join('/');
  }

  var SPEC_RE = /(from\\s*|import\\s*\\(\\s*|import\\s*)(['"])([^'"]+)\\2/g;

  for (var i = 0; i < ORDER.length; i++) {
    var rel = ORDER[i];
    var src = SRC[rel];
    /* eslint-disable no-loop-func */
    var rewritten = src.replace(SPEC_RE, function (m, lead, q, spec) {
      var target = resolveSpec(rel, spec);
      var u = urls[target];
      return u ? lead + q + u + q : m;
    });
    urls[rel] = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
  }

  var entry = urls[${JSON.stringify(ENTRY)}];
  import(entry).catch(function (err) {
    console.error(err);
    var m = document.getElementById('loadmsg');
    if (m) m.innerHTML = '<span style="color:#e0554a">failed to start: ' + err.message + '</span>';
  });
})();
</script>
</body>
</html>
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html);
const mb = (fs.statSync(OUT).size / 1048576).toFixed(2);
console.log(`\nwrote ${path.relative(ROOT, OUT)}  —  ${mb} MB, self-contained`);
console.log('open it directly in a browser; no server required.');
