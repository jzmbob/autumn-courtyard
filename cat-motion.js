import {
  advanceMotion,
  createMotionState,
  sampleGait,
  solveTwoBone,
} from './cat-motion-core.mjs';

const VIEWBOX_WIDTH = 360;
const BASELINE = 224;
const UPPER_LENGTH = 31;
const LOWER_LENGTH = 28;
const STANCE_SHARE = 0.62;
const MAX_REACH = UPPER_LENGTH + LOWER_LENGTH;
const MIN_REACH = Math.abs(UPPER_LENGTH - LOWER_LENGTH);

// Each origin is deliberately hidden low inside the torso. The original visible
// shoulder coordinates cannot reach the 48-unit stride with fixed 31/28 bones.
export const LEG_RIGS = Object.freeze({
  farHind: Object.freeze({ id: 'leg-far-hind', anchorX: 224, origin: Object.freeze({ x: 224, y: 171 }), bend: -1 }),
  farFore: Object.freeze({ id: 'leg-far-fore', anchorX: 126, origin: Object.freeze({ x: 126, y: 171 }), bend: -1 }),
  nearHind: Object.freeze({ id: 'leg-near-hind', anchorX: 245, origin: Object.freeze({ x: 245, y: 171 }), bend: 1 }),
  nearFore: Object.freeze({ id: 'leg-near-fore', anchorX: 145, origin: Object.freeze({ x: 145, y: 171 }), bend: 1 }),
});

export function assertReachEnvelope(samples = 240) {
  for (let index = 0; index <= samples; index += 1) {
    const gait = sampleGait(index / samples);
    for (const [name, rig] of Object.entries(LEG_RIGS)) {
      const offset = gait[name];
      const target = { x: rig.anchorX + offset.x, y: BASELINE + offset.y };
      const distance = Math.hypot(target.x - rig.origin.x, target.y - rig.origin.y);
      if (!Number.isFinite(distance) || distance < MIN_REACH || distance > MAX_REACH) {
        throw new RangeError(`${rig.id} target leaves the fixed 31/28 reach envelope`);
      }
    }
  }
  return true;
}

assertReachEnvelope();

export function motionPixelsPerUnit(svgScale) {
  return svgScale / STANCE_SHARE;
}
function readPoint(value) {
  const coordinates = value.trim().split(/\s+/).map(Number);
  return coordinates.length === 2 && coordinates.every(Number.isFinite)
    ? { x: coordinates[0], y: coordinates[1] }
    : null;
}

function cacheDom() {
  const scene = document.querySelector('.scene');
  const path = document.querySelector('.cat-path');
  const rig = document.getElementById('cat-rig');
  const profile = document.getElementById('profile-view');
  const threeQuarter = document.getElementById('turn-three-quarter');
  const front = document.getElementById('turn-front');
  const body = document.getElementById('cat-body');
  const head = document.getElementById('cat-head');
  const tailBase = document.getElementById('cat-tail-base');
  const tailTip = document.getElementById('cat-tail-tip');

  if (!scene || !path || !rig || !profile || !threeQuarter || !front
      || !body || !head || !tailBase || !tailTip) {
    return null;
  }

  const legs = {};
  for (const [name, config] of Object.entries(LEG_RIGS)) {
    const group = document.getElementById(config.id);
    const upper = group?.querySelector('[data-segment="upper"]');
    const lower = group?.querySelector('[data-segment="lower"]');
    const paw = group?.querySelector('[data-segment="paw"]');
    const origin = group ? readPoint(group.dataset.ikOrigin ?? '') : null;
    if (!group || !upper || !lower || !paw || !origin
        || origin.x !== config.origin.x || origin.y !== config.origin.y) {
      return null;
    }
    legs[name] = { upper, lower, paw, origin, config };
  }

  return {
    scene,
    path,
    rig,
    profile,
    threeQuarter,
    front,
    body,
    head,
    tailBase,
    tailTip,
    legs,
  };
}

const degrees = radians => radians * 180 / Math.PI;
const number = value => Number(value.toFixed(3));

function renderLeg(leg, offset) {
  const target = {
    x: leg.config.anchorX + offset.x,
    y: BASELINE + offset.y,
  };
  const solution = solveTwoBone(
    leg.origin,
    target,
    UPPER_LENGTH,
    LOWER_LENGTH,
    leg.config.bend,
  );
  const upperAngle = degrees(solution.hipAngle);
  const lowerAngle = degrees(Math.atan2(
    solution.paw.y - solution.knee.y,
    solution.paw.x - solution.knee.x,
  ));

  leg.upper.setAttribute(
    'transform',
    `translate(${number(leg.origin.x)} ${number(leg.origin.y)}) rotate(${number(upperAngle)})`,
  );
  leg.lower.setAttribute(
    'transform',
    `translate(${number(solution.knee.x)} ${number(solution.knee.y)}) rotate(${number(lowerAngle)})`,
  );
  leg.paw.setAttribute(
    'transform',
    `translate(${number(solution.paw.x)} ${number(solution.paw.y)})`,
  );
}

function setOpacity(node, opacity) {
  node.setAttribute('opacity', String(number(Math.max(0, Math.min(1, opacity)))));
}

function mirrorView(node, mirrored) {
  if (mirrored) {
    node.setAttribute('transform', `translate(${VIEWBOX_WIDTH} 0) scale(-1 1)`);
  } else {
    node.removeAttribute('transform');
  }
}

export function turnViewState(turnFrame) {
  const frame = Math.max(0, Math.min(19, turnFrame));
  const view = {
    profile: 0,
    threeQuarter: 0,
    front: 0,
    mirrorProfile: frame >= 15,
    mirrorThreeQuarter: frame >= 10,
  };

  if (frame <= 4) {
    const blend = frame / 4;
    return { ...view, profile: 1 - blend, threeQuarter: blend };
  }
  if (frame <= 9) {
    const blend = (frame - 5) / 4;
    return { ...view, threeQuarter: 1 - blend, front: blend };
  }
  if (frame <= 14) {
    const blend = (frame - 10) / 4;
    return { ...view, front: 1 - blend, threeQuarter: blend };
  }

  if (frame === 19) return view;
  const blend = (frame - 15) / 4;
  return { ...view, threeQuarter: 1 - blend, profile: blend };
}

function renderTurn(state, nodes) {
  if (state.mode !== 'turn') {
    setOpacity(nodes.profile, 1);
    setOpacity(nodes.threeQuarter, 0);
    setOpacity(nodes.front, 0);
    mirrorView(nodes.profile, false);
    mirrorView(nodes.threeQuarter, false);
    return;
  }

  const view = turnViewState(state.turnFrame);
  setOpacity(nodes.profile, view.profile);
  setOpacity(nodes.threeQuarter, view.threeQuarter);
  setOpacity(nodes.front, view.front);
  mirrorView(nodes.profile, view.mirrorProfile);
  mirrorView(nodes.threeQuarter, view.mirrorThreeQuarter);
}
function renderArtwork(state, nodes) {
  const bodyBob = Math.sin(state.gait * Math.PI * 4) * 0.5;
  const counterRotation = Math.sin(state.gait * Math.PI * 2) * 2;

  nodes.body.setAttribute('transform', `translate(0 ${number(bodyBob)})`);
  nodes.head.setAttribute(
    'transform',
    `translate(0 ${number(bodyBob)}) rotate(${number(-counterRotation)} 91 110)`,
  );
  nodes.tailBase.setAttribute(
    'transform',
    `translate(0 ${number(bodyBob)}) rotate(${number(counterRotation)} 262 132)`,
  );
  nodes.tailTip.setAttribute(
    'transform',
    `rotate(${number(counterRotation * 0.5)} 313 178)`,
  );
}

function render(state, nodes, motionPixelsPerUnit) {
  const stationary = state.mode === 'settle-before-turn'
    || state.mode === 'turn'
    || state.mode === 'settle-after-turn';
  const gait = stationary
    ? Object.fromEntries(Object.keys(LEG_RIGS).map(name => [name, { x: 0, y: 0, planted: true }]))
    : sampleGait(state.gait);

  for (const [name, leg] of Object.entries(nodes.legs)) {
    renderLeg(leg, gait[name]);
  }

  nodes.path.style.transform = `translateX(${number(state.x * motionPixelsPerUnit)}px)`;
  nodes.rig.style.transformOrigin = 'center center';
  nodes.rig.style.transform = state.direction < 0 && state.mode !== 'turn' ? 'scaleX(-1)' : '';
  renderTurn(state, nodes);
  renderArtwork(state, nodes);
}

function measureTravel(nodes) {
  const rigWidth = nodes.rig.getBoundingClientRect().width || nodes.path.offsetWidth;
  const svgScale = rigWidth > 0 ? rigWidth / VIEWBOX_WIDTH : 1;
  const availableCssPixels = Math.max(
    0,
    nodes.scene.clientWidth - nodes.path.offsetLeft * 2 - nodes.path.offsetWidth,
  );
  // Core stance covers 0.62 of a 48-unit cycle. This conversion makes its
  // reverse paw travel cancel the path's CSS translation at every SVG scale.
  const pixelsPerMotionUnit = motionPixelsPerUnit(svgScale);
  return {
    motionPixelsPerUnit: pixelsPerMotionUnit,
    travelPixels: availableCssPixels / pixelsPerMotionUnit,
  };
}

function startMotion(nodes) {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const forceMotion = window.__FORCE_CAT_MOTION__ === true;
  if (reducedMotion && !forceMotion) {
    nodes.path.dataset.motion = 'reduced';
    return;
  }

  nodes.path.dataset.motion = 'active';
  let state = createMotionState();
  let lastTimestamp = null;

  function tick(timestamp) {
    const dtSeconds = lastTimestamp === null
      ? 0
      : Math.min(0.1, Math.max(0, (timestamp - lastTimestamp) / 1000));
    lastTimestamp = timestamp;

    if (!document.hidden) {
      const { travelPixels, motionPixelsPerUnit } = measureTravel(nodes);
      state = advanceMotion(state, dtSeconds, travelPixels);
      render(state, nodes, motionPixelsPerUnit);
    }

    window.requestAnimationFrame(tick);
  }

  tick(window.performance.now());
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const nodes = cacheDom();
  if (nodes) startMotion(nodes);
}