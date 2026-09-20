import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDTH = 1200;
const OUTER_MARGIN = 24;
const PANEL_GAP = 18;
const PANEL_WIDTH = 372;
const PANEL_HEADER_HEIGHT = 78;
const PANEL_PADDING = 18;
const LINE_HEIGHT = 18;
const BODY_BOTTOM_PADDING = 22;
const MAX_LINE_CHARS = 43;

const COLORS = Object.freeze({
  accent: '#8be9fd',
  command: '#f8f8f2',
  declined: '#8b93a7',
  heading: '#bd93f9',
  muted: '#8b93a7',
  output: '#d6dae4',
  success: '#50fa7b',
});

export function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function wrapLine(text, maxChars = MAX_LINE_CHARS) {
  if (text === '') return [''];

  const leading = text.match(/^\s*/)[0];
  const words = text.trimStart().split(/\s+/);
  const lines = [];
  let current = leading;

  for (const word of words) {
    for (let offset = 0; offset < word.length; offset += maxChars) {
      const chunk = word.slice(offset, offset + maxChars);
      const separator = current.trim() ? ' ' : '';
      if (current.length + separator.length + chunk.length <= maxChars) {
        current += separator + chunk;
      } else {
        lines.push(current);
        current = chunk;
      }
    }
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
}

function visualLines(panel) {
  return panel.lines.flatMap(line =>
    wrapLine(line.text).map(text => ({ kind: line.kind, text }))
  );
}

export function computeLayout(fixture) {
  const lineCount = Math.max(...fixture.panels.map(panel => visualLines(panel).length));
  const panelHeight =
    PANEL_HEADER_HEIGHT + PANEL_PADDING + lineCount * LINE_HEIGHT + BODY_BOTTOM_PADDING;
  return {
    width: WIDTH,
    height: OUTER_MARGIN * 2 + panelHeight,
    panelHeight,
  };
}

function renderPanel(panel, index, panelHeight) {
  const x = OUTER_MARGIN + index * (PANEL_WIDTH + PANEL_GAP);
  const bodyX = x + PANEL_PADDING;
  const bodyY = OUTER_MARGIN + PANEL_HEADER_HEIGHT + PANEL_PADDING + 11;
  const titleX = x + PANEL_PADDING;
  const lines = visualLines(panel);
  const body = lines
    .map((line, lineIndex) => {
      if (line.kind === 'spacer') return '';
      const y = bodyY + lineIndex * LINE_HEIGHT;
      const color = COLORS[line.kind] ?? COLORS.output;
      return `    <text x="${bodyX}" y="${y}" fill="${color}" style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; font-weight: ${line.kind === 'heading' ? '600' : '400'};" xml:space="preserve">${xmlEscape(line.text)}</text>`;
    })
    .filter(Boolean)
    .join('\n');

  return [
    `  <g id="panel-${xmlEscape(panel.id)}">`,
    `    <rect x="${x}" y="${OUTER_MARGIN}" width="${PANEL_WIDTH}" height="${panelHeight}" rx="14" fill="#151821" stroke="#303746" style="stroke-width: 1px;"/>`,
    `    <circle cx="${x + 22}" cy="${OUTER_MARGIN + 24}" r="5" fill="#ff5f57"/>`,
    `    <circle cx="${x + 38}" cy="${OUTER_MARGIN + 24}" r="5" fill="#febc2e"/>`,
    `    <circle cx="${x + 54}" cy="${OUTER_MARGIN + 24}" r="5" fill="#28c840"/>`,
    `    <text x="${titleX}" y="${OUTER_MARGIN + 51}" fill="#f8f8f2" style="font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, sans-serif; font-size: 15px; font-weight: 700;">${xmlEscape(panel.step)} · ${xmlEscape(panel.title)}</text>`,
    `    <text x="${titleX}" y="${OUTER_MARGIN + 67}" fill="#8b93a7" style="font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, sans-serif; font-size: 10px;">${xmlEscape(panel.subtitle)}</text>`,
    `    <rect x="${x + 1}" y="${OUTER_MARGIN + PANEL_HEADER_HEIGHT - 1}" width="${PANEL_WIDTH - 2}" height="1" fill="#303746"/>`,
    body,
    '  </g>',
  ].join('\n');
}

export function renderLoopFigure(fixture) {
  if (!fixture || !Array.isArray(fixture.panels) || fixture.panels.length !== 3) {
    throw new TypeError('loop figure fixture must contain exactly three panels');
  }
  const { width, height, panelHeight } = computeLayout(fixture);
  const panels = fixture.panels
    .map((panel, index) => renderPanel(panel, index, panelHeight))
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="loop-title loop-desc">`,
    `  <title id="loop-title">${xmlEscape(fixture.title)}</title>`,
    `  <desc id="loop-desc">${xmlEscape(fixture.description)}</desc>`,
    `  <rect width="${width}" height="${height}" rx="18" fill="#0b0d12"/>`,
    panels,
    '</svg>',
    '',
  ].join('\n');
}

export function hasRenderDrift(fixture, committedSvg) {
  return renderLoopFigure(fixture) !== committedSvg;
}

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fixturePath = resolve(scriptDir, '../docs/assets/loop-demo.json');
  const outputPath = resolve(scriptDir, '../docs/assets/loop-demo.svg');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const rendered = renderLoopFigure(fixture);
  const args = process.argv.slice(2);
  const checkMode = args.length === 1 && args[0] === '--check';

  if (args.length > 0 && !checkMode) {
    throw new Error('Usage: node scripts/render-loop-figure.mjs [--check]');
  }

  if (checkMode) {
    const committed = readFileSync(outputPath, 'utf8');
    if (hasRenderDrift(fixture, committed)) {
      process.stderr.write('docs/assets/loop-demo.svg is out of date; run node scripts/render-loop-figure.mjs\n');
      process.exitCode = 1;
    }
    return;
  }

  writeFileSync(outputPath, rendered);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) main();
