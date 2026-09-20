import './helpers/tmp-kb.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  computeLayout,
  hasRenderDrift,
  renderLoopFigure,
} from '../scripts/render-loop-figure.mjs';

function readText(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function getLineText(panel) {
  return panel.lines.map(line => line.text);
}

const fixtureText = readText('docs/assets/loop-demo.json');
const fixture = JSON.parse(fixtureText);
const committedSvg = readText('docs/assets/loop-demo.svg');
const readme = readText('README.md');
const wakeupSource = readText('src/cli/wakeup-hook.js');
const hintSource = readText('src/cli/prompt-hint.js');
const toolsSource = readText('src/tools.js');

describe('README knowledge-loop figure', () => {
  it('matches the deterministic JSON rendering byte for byte', () => {
    assert.equal(renderLoopFigure(fixture), committedSvg);
    assert.equal(hasRenderDrift(fixture, committedSvg), false);
    assert.equal(hasRenderDrift(fixture, `${committedSvg}<!-- stale -->\n`), true);
  });

  it('escapes every fixture string before placing it in XML', () => {
    const hostile = structuredClone(fixture);
    hostile.title = `A < B & "quoted" 'once'`;
    hostile.panels[0].lines[0].text = `<script>&"'`;

    const svg = renderLoopFigure(hostile);

    assert.match(svg, /A &lt; B &amp; &quot;quoted&quot; &apos;once&apos;/);
    assert.match(svg, /&lt;script&gt;&amp;&quot;&apos;/);
    assert.doesNotMatch(svg, /<script>/);
  });

  it('contains only privacy-safe synthetic fixture and SVG text', () => {
    const publicBytes = `${fixtureText}\n${committedSvg}`;
    const forbidden = [
      /\/(?:Users|home)\//i,
      /\b(?:tinyfish|mino)\b/i,
      /\bPF-\d+\b/i,
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
      /\b(?:Bearer\s+|sk-|ghp_|phc_|xox[baprs]-)[A-Za-z0-9._-]{8,}/i,
    ];

    for (const pattern of forbidden) assert.doesNotMatch(publicBytes, pattern);
  });

  it('uses current runtime prefixes and handler response shape', () => {
    const briefing = getLineText(fixture.panels.find(panel => panel.id === 'briefing'));
    assert.ok(briefing[0].startsWith('KB BRIEFING ('));
    assert.match(wakeupSource, /`KB BRIEFING \(knowledge-base MCP;/);
    assert.ok(briefing.includes('Active workstreams (kb_read for current state):'));
    assert.ok(briefing.includes('Recently updated:'));
    assert.ok(briefing.some(line => line.startsWith('Before non-trivial work: kb_search(query, tags)')));
    assert.ok(briefing.some(line => line.startsWith('At a durable boundary, call kb_write directly;')));
    assert.ok(briefing.some(line => line.includes('synthetic example')));

    const hint = getLineText(fixture.panels.find(panel => panel.id === 'hint'));
    assert.ok(hint.some(line => line.startsWith('KB HINT: the knowledge base has entries relevant to this prompt:')));
    assert.match(hintSource, /`KB HINT: the knowledge base has entries relevant to this prompt:/);
    assert.ok(hint.includes('(no hint)'));

    const capture = fixture.panels.find(panel => panel.id === 'capture');
    assert.deepEqual(capture.input, {
      title: 'Retry boundaries',
      content: 'Cap retries at three attempts and surface the final error.',
      type: 'lesson',
      project: 'example-app',
      tier: 'verified',
      tier_ref: '#88',
    });
    assert.match(
      capture.lines.at(-1).text,
      /^Note #43 saved to agents\/lessons\/\S+\.md as verified; indexed 1 changed, 0 unchanged$/,
    );
    assert.match(toolsSource, /`Note\$\{idNote\} saved to \$\{result\.path\} as \$\{result\.tier\}/);
  });

  it('places the asset after badges and before the concise introduction', () => {
    const badgeEnd = readme.indexOf('](LICENSE)');
    const image = readme.indexOf(
      '[![Three-step kb-graph loop: session briefing, targeted prompt hint, and durable capture](docs/assets/loop-demo.svg)](docs/assets/loop-demo.svg)',
    );
    const caption = readme.indexOf(
      '*Static demonstration with synthetic data; open it for the full-size view. Claude Code is shown; Codex receives equivalent hook context; Cursor receives the session briefing only.*',
    );
    const intro = readme.indexOf('kb-graph gives Claude Code');

    assert.ok(badgeEnd < image);
    assert.ok(image < caption);
    assert.ok(caption < intro);
  });

  it('stays compact, accessible, and within the supported SVG subset', () => {
    const { width, height } = computeLayout(fixture);
    assert.equal(width, 1200);
    assert.match(
      committedSvg,
      new RegExp(
        `<svg[^>]+width="${width}"[^>]+height="${height}"[^>]+viewBox="0 0 ${width} ${height}"`,
      ),
    );
    assert.match(committedSvg, /role="img" aria-labelledby="loop-title loop-desc"/);
    assert.match(committedSvg, /<title id="loop-title">/);
    assert.match(committedSvg, /<desc id="loop-desc">/);
    assert.doesNotMatch(committedSvg, /<(?:script|foreignObject|image|use|a)\b|(?:href|xlink:href)=/i);
    assert.ok(Buffer.byteLength(committedSvg) < 30_000, 'SVG should remain under 30 KB');

    const tags = [...committedSvg.matchAll(/<\/?([A-Za-z][\w:-]*)\b/g)].map(match => match[1]);
    const supported = new Set(['svg', 'title', 'desc', 'g', 'rect', 'circle', 'text', 'tspan']);
    for (const tag of tags) assert.ok(supported.has(tag), `unsupported SVG element <${tag}>`);
  });
});
