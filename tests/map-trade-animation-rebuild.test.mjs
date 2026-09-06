/**
 * Source characterization for #7781: decorative trade animation still rebuilds
 * the full layer stack every eligible frame. Isolation is conditional on a
 * measured budget miss; these tests pin the current path so the profile can
 * attribute that cost.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const deckGlMapSrc = readFileSync(resolve(__dirname, '../src/components/DeckGLMap.ts'), 'utf-8');
const harnessSrc = readFileSync(resolve(__dirname, '../src/e2e/map-harness.ts'), 'utf-8');

function previousSignificantChar(source, index) {
  for (let i = index - 1; i >= 0; i--) {
    const ch = source[i];
    if (!/\s/.test(ch)) return ch;
  }
  return '';
}

function canStartRegex(source, index) {
  return !/[)\]\w$]/.test(previousSignificantChar(source, index));
}

function findMatchingBrace(source, braceStart) {
  let depth = 0;
  let state = 'code';
  let regexCharClass = false;

  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i++;
      }
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote' || state === 'template') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (
        (state === 'single-quote' && ch === "'")
        || (state === 'double-quote' && ch === '"')
        || (state === 'template' && ch === '`')
      ) {
        state = 'code';
      }
      continue;
    }
    if (state === 'regex') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '[') regexCharClass = true;
      else if (ch === ']') regexCharClass = false;
      else if (ch === '/' && !regexCharClass) state = 'code';
      continue;
    }
    if (ch === '/' && next === '/') {
      state = 'line-comment';
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block-comment';
      i++;
      continue;
    }
    if (ch === "'") {
      state = 'single-quote';
      continue;
    }
    if (ch === '"') {
      state = 'double-quote';
      continue;
    }
    if (ch === '`') {
      state = 'template';
      continue;
    }
    if (ch === '/' && canStartRegex(source, i)) {
      state = 'regex';
      regexCharClass = false;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function methodSource(name) {
  const start = deckGlMapSrc.indexOf(name);
  assert.ok(start >= 0, `${name} must exist`);
  const braceStart = deckGlMapSrc.indexOf('{', start);
  assert.ok(braceStart > start, `${name} must have a body`);
  const end = findMatchingBrace(deckGlMapSrc, braceStart);
  assert.ok(end > braceStart, `${name} body must have balanced braces`);
  return deckGlMapSrc.slice(start, end);
}

describe('trade animation still full-rebuilds (#7781 characterization)', () => {
  it('calls render() from the animation tick, and render() always rebuilds via updateLayers', () => {
    const startTradeAnimation = methodSource('private startTradeAnimation');
    assert.match(
      startTradeAnimation,
      /shouldRenderTradeAnimationFrame[\s\S]*this\.render\(\)/,
      'animation ticks must still call the full render() path',
    );
    const render = methodSource('public render');
    assert.match(render, /this\.updateLayers\(\)/, 'render() must still schedule updateLayers()');
    const updateLayers = methodSource('private updateLayers');
    assert.match(updateLayers, /this\.buildLayers\(!deferred\)/, 'updateLayers must rebuild the full stack');
    assert.match(updateLayers, /this\.deckOverlay\?\.setProps\(\{\s*layers:\s*built\s*\}\)/, 'updateLayers must commit every layer array');
  });

  it('does not cache nuclear or data-center layer instances across animation frames', () => {
    const nuclear = methodSource('private createNuclearLayer');
    const datacenters = methodSource('private createDatacentersLayer');
    assert.match(nuclear, /return new IconLayer/);
    assert.match(datacenters, /return new IconLayer/);
    assert.equal(nuclear.includes('layerCache'), false, 'nuclear layer must not use layerCache');
    assert.equal(datacenters.includes('layerCache'), false, 'datacenter layer must not use layerCache');
  });

  it('keeps the Wave 1 hint-scan guard on the animation rebuild path', () => {
    const updateLayers = methodSource('private updateLayers');
    const updateZoomHints = methodSource('private updateZoomHints');
    assert.match(updateLayers, /this\.updateZoomHints\(\)/);
    assert.match(updateZoomHints, /this\.zoomHintGuard\.shouldScan/);
  });

  it('exposes a settled-harness profiler for the reproducible before/after command', () => {
    assert.match(harnessSrc, /runTradeAnimationProfile/);
    assert.match(harnessSrc, /TRADE_ANIMATION_PROFILE_LAYERS/);
    assert.match(harnessSrc, /nuclearIdentityChanged/);
    assert.match(harnessSrc, /deckCommitMs/);
    assert.match(
      harnessSrc,
      /layerManager\.updateLayers/,
      'profiler must time LayerManager.updateLayers, not only overlay.setProps',
    );
  });
});
