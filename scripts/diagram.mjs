/**
 * Generate the Sui architecture diagram as an Excalidraw scene.
 *
 * Layout: three columns — what talks to it, the gateway, where answers come from
 * — with the two optional planes above and below. Bound arrows, fontFamily 5,
 * explicit sizes; a grid so nothing overlaps.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

let seed = 1000;
const nextSeed = () => (seed += 7);
const id = (n) => `sui-${n}`;

const ELEMENTS = [];
let counter = 0;

const BOX = { w: 200, h: 64 };

function box(key, label, x, y, opts = {}) {
  const w = opts.w ?? BOX.w;
  const h = opts.h ?? BOX.h;
  const el = {
    id: id(key),
    type: 'rectangle',
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: opts.stroke ?? '#2f5d50',
    backgroundColor: opts.fill ?? '#e4eeea',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: opts.dashed ? 'dashed' : 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: opts.group ? [id(opts.group)] : [],
    frameId: null,
    index: `a${counter++}`,
    roundness: { type: 3 },
    seed: nextSeed(),
    version: 1,
    versionNonce: nextSeed(),
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
  };
  ELEMENTS.push(el);
  ELEMENTS.push(text(key, label, x + 12, y + h / 2 - 10, w - 24, opts));
  return el;
}

function text(key, label, x, y, w, opts = {}) {
  return {
    id: id(`${key}-t`),
    type: 'text',
    x,
    y,
    width: w,
    height: 20,
    angle: 0,
    strokeColor: opts.textColor ?? '#1a1a18',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: opts.group ? [id(opts.group)] : [],
    frameId: null,
    index: `a${counter++}`,
    roundness: null,
    seed: nextSeed(),
    version: 1,
    versionNonce: nextSeed(),
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    text: label,
    fontSize: opts.fontSize ?? 14,
    fontFamily: 5,
    textAlign: opts.align ?? 'left',
    verticalAlign: 'middle',
    containerId: null,
    originalText: label,
    lineHeight: 1.25,
  };
}

function arrow(from, to, opts = {}) {
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const el = {
    id: id(`arrow-${counter}`),
    type: 'arrow',
    x: startX,
    y: startY,
    width: Math.max(1, endX - startX),
    height: endY - startY,
    angle: 0,
    strokeColor: opts.color ?? '#5c5c56',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: opts.dashed ? 1 : 2,
    strokeStyle: opts.dashed ? 'dashed' : 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `a${counter++}`,
    roundness: { type: 2 },
    seed: nextSeed(),
    version: 1,
    versionNonce: nextSeed(),
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    points: [
      [0, 0],
      [endX - startX, endY - startY],
    ],
    lastCommittedPoint: null,
    startBinding: { elementId: from.id, focus: 0, gap: 8 },
    endBinding: { elementId: to.id, focus: 0, gap: 8 },
    startArrowhead: null,
    endArrowhead: 'arrow',
  };
  ELEMENTS.push(el);
  from.boundElements.push({ id: el.id, type: 'arrow' });
  to.boundElements.push({ id: el.id, type: 'arrow' });
  return el;
}

// ---- column 1: what talks to it
const clients = box('clients', 'Cline · Continue · Cursor · Aider', 40, 120, { w: 240 });
const agent = box('agent', 'an MCP client', 40, 210, { w: 240, dashed: true });
const human = box('human', 'a person, in a browser', 40, 300, { w: 240 });

// ---- column 2: the gateway
const gateway = box('gateway', 'apps/gateway  ·  HTTP · auth · host allowlist · SSE', 380, 150, { w: 300, h: 84, fill: '#d5e5df' });
const guard = box('guard', 'guardrails  ·  size · patterns · clamp', 380, 60, { w: 300, fill: '#ffffff', dashed: true });
const router = box('router', 'packages/router  ·  the decision', 380, 270, { w: 300, fill: '#d5e5df' });
const cache = box('cache', 'telemetry  ·  exact + similarity cache', 380, 360, { w: 300, fill: '#ffffff' });

// ---- column 3: where answers come from
const gate = box('gate', 'paid gate: paidTiers.enabled', 760, 60, { w: 250, fill: '#fff4e5', stroke: '#8a5a00' });
const vault = box('vault', 'packages/vault  ·  sealed keys', 760, 150, { w: 250, fill: '#fff4e5', stroke: '#8a5a00' });
const providers = box('providers', 'providers  ·  openai · anthropic · gemini · mcp · mock', 760, 240, { w: 250, h: 84 });
const free = box('free', 'free tiers', 760, 360, { w: 250, fill: '#ffffff' });
const local = box('local', 'a model on this machine', 760, 440, { w: 250, fill: '#ffffff' });
const paid = box('paid', 'paid providers, gate open', 760, 520, { w: 250, fill: '#ffffff', dashed: true });

// ---- the loop that makes it verification-first
const catalog = box('catalog', 'catalog  ·  29 endpoints, ToS, health', 40, 470, { w: 240, fill: '#ffffff' });
const prober = box('prober', 'prober  ·  liveness · readiness · suitability', 40, 560, { w: 240, fill: '#ffffff' });

// ---- edges
arrow(clients, gateway);
arrow(agent, gateway, { dashed: true });
arrow(human, gateway, { dashed: true });
arrow(gateway, guard);
arrow(gateway, router);
arrow(router, cache);
arrow(router, providers);
arrow(providers, free);
arrow(providers, local);
arrow(providers, paid, { dashed: true });
arrow(gate, vault, { dashed: true });
arrow(vault, providers, { dashed: true });
arrow(catalog, router, { dashed: true, color: '#2f5d50' });
arrow(prober, catalog, { dashed: true, color: '#2f5d50' });

// the two annotations that carry the design
ELEMENTS.push(text('note-prober', 'the prober feeds the catalogue;\nthe catalogue feeds the router', 40, 650, 300, { fontSize: 13, textColor: '#5c5c56' }));
ELEMENTS.push(text('note-gate', 'the gate is a branch in the\nstartup path, not a flag', 760, 620, 250, { fontSize: 13, textColor: '#8a5a00' }));
ELEMENTS.push(text('title', 'sui — verification-first gateway', 40, 40, 420, { fontSize: 20, textColor: '#1a1a18' }));

const scene = {
  type: 'excalidraw',
  version: 2,
  source: 'https://github.com/drsamonline/sui',
  elements: ELEMENTS,
  appState: { viewBackgroundColor: '#ffffff', gridSize: 20 },
  files: {},
};

const out = process.argv[2] ?? 'docs/diagrams/sui-architecture.excalidraw';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(scene, null, 2));
console.log(`wrote ${out} · ${ELEMENTS.length} elements`);

/**
 * The scene is generated, so it is also checkable: unique ids, every arrow bound
 * at both ends to an element that exists, every label at fontFamily 5, and no
 * two boxes overlapping. A diagram that fails these is not editable, it is a
 * picture that happens to be JSON.
 */
export function validateScene(s) {
  const problems = [];
  const ids = new Set();
  for (const e of s.elements) {
    if (ids.has(e.id)) problems.push(`duplicate id: ${e.id}`);
    ids.add(e.id);
  }
  for (const e of s.elements) {
    if (e.type === 'text' && e.fontFamily !== 5) problems.push(`text ${e.id} is not fontFamily 5`);
    if (e.type === 'arrow') {
      for (const [side, binding] of [['start', e.startBinding], ['end', e.endBinding]]) {
        if (!binding?.elementId) problems.push(`arrow ${e.id} has no ${side} binding`);
        else if (!ids.has(binding.elementId)) problems.push(`arrow ${e.id} points at a missing element`);
      }
    }
  }
  const boxes = s.elements.filter((e) => e.type === 'rectangle');
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        problems.push(`boxes overlap: ${a.id} and ${b.id}`);
      }
    }
  }
  return problems;
}
