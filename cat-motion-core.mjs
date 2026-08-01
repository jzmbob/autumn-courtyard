export const LEG_PHASES = Object.freeze({
  nearFore: 0,
  farHind: 0.25,
  farFore: 0.5,
  nearHind: 0.75,
});

export function wrap01(value) {
  return ((value % 1) + 1) % 1;
}

export function pawTarget(phase, stride = 48, lift = 15) {
  const stanceShare = 0.62;
  const progress = wrap01(phase);

  if (progress < stanceShare) {
    const t = progress / stanceShare;
    const x = stride * (0.5 - t);
    return { x: Math.abs(x) < Number.EPSILON * stride ? 0 : x, y: 0, planted: true };
  }

  const t = (progress - stanceShare) / (1 - stanceShare);
  const smoothstep = t * t * (3 - 2 * t);
  return {
    x: stride * (-0.5 + smoothstep),
    y: -Math.sin(Math.PI * t) * lift,
    planted: false,
  };
}

export function solveTwoBone(origin, target, upperLength, lowerLength, bend) {
  const deltaX = target.x - origin.x;
  const deltaY = target.y - origin.y;
  const targetDistance = Math.hypot(deltaX, deltaY);
  const minimumReach = Math.abs(upperLength - lowerLength);
  const maximumReach = upperLength + lowerLength;
  const reach = Math.min(Math.max(targetDistance, minimumReach), maximumReach);
  const directionX = targetDistance === 0 ? 1 : deltaX / targetDistance;
  const directionY = targetDistance === 0 ? 0 : deltaY / targetDistance;
  const baseAngle = Math.atan2(directionY, directionX);
  const bendDirection = bend < 0 ? -1 : 1;
  const clampCosine = (value) => Math.min(1, Math.max(-1, value));
  const hipOffset = Math.acos(clampCosine(
    (upperLength ** 2 + reach ** 2 - lowerLength ** 2) / (2 * upperLength * reach),
  ));
  const kneeInterior = Math.acos(clampCosine(
    (upperLength ** 2 + lowerLength ** 2 - reach ** 2) / (2 * upperLength * lowerLength),
  ));
  const hipAngle = baseAngle + bendDirection * hipOffset;
  const kneeAngle = bendDirection * (Math.PI - kneeInterior);
  const knee = {
    x: origin.x + Math.cos(hipAngle) * upperLength,
    y: origin.y + Math.sin(hipAngle) * upperLength,
  };
  const paw = {
    x: origin.x + directionX * reach,
    y: origin.y + directionY * reach,
  };

  return { knee, paw, hipAngle, kneeAngle };
}

export function sampleGait(phase) {
  return Object.fromEntries(
    Object.entries(LEG_PHASES).map(([leg, offset]) => [leg, pawTarget(phase + offset)]),
  );
}
export const STRIDE = 48;
export const SETTLE_BEFORE_TURN = 1;
export const TURN_DURATION = 0.75;
export const TURN_FRAMES = 20;
export const SETTLE_AFTER_TURN = 0.25;

export const WALK_SPEED = 42;
const ACCELERATION = 42;

export function createMotionState() {
  return {
    mode: 'accelerate',
    direction: 1,
    x: 0,
    speed: 0,
    gait: 0,
    elapsed: 0,
    turnFrame: 0,
  };
}

function withMovement(state, distance, travel, changes = {}) {
  const x = Math.min(travel, Math.max(0, state.x + state.direction * distance));
  const distanceMoved = Math.abs(x - state.x);

  return {
    ...state,
    ...changes,
    x,
    gait: wrap01(state.gait + distanceMoved / STRIDE),
  };
}

export function advanceMotion(state, dt, travel) {
  const extent = Math.max(0, travel);
  const initial = { ...state, x: Math.min(extent, Math.max(0, state.x)) };
  return advance(initial, Math.max(0, dt), extent);
}

function advance(state, step, extent) {
  if (step === 0) return state;

  const remaining = state.direction === 1 ? extent - state.x : state.x;

  switch (state.mode) {
    case 'accelerate': {
      const stoppingDistance = state.speed ** 2 / (2 * ACCELERATION);
      if (remaining <= stoppingDistance) {
        return advance({ ...state, mode: 'decelerate', elapsed: 0 }, step, extent);
      }

      const timeToWalk = (WALK_SPEED - state.speed) / ACCELERATION;
      const timeToBrake = Math.max(0, (
        Math.sqrt(2 * state.speed ** 2 + 4 * ACCELERATION * remaining) - 2 * state.speed
      ) / (2 * ACCELERATION));
      const transitionTime = Math.min(timeToWalk, timeToBrake);

      if (step < transitionTime) {
        const speed = state.speed + ACCELERATION * step;
        return withMovement(state, (state.speed + speed) * 0.5 * step, extent, {
          speed,
          elapsed: state.elapsed + step,
          turnFrame: 0,
        });
      }

      const speed = state.speed + ACCELERATION * transitionTime;
      const moved = withMovement(
        state,
        (state.speed + speed) * 0.5 * transitionTime,
        extent,
        {
          mode: timeToBrake <= timeToWalk ? 'decelerate' : 'walk',
          speed,
          elapsed: 0,
          turnFrame: 0,
        },
      );
      return advance(moved, step - transitionTime, extent);
    }

    case 'walk': {
      if (state.speed <= 0) {
        return advance({ ...state, mode: 'accelerate', elapsed: 0 }, step, extent);
      }

      const stoppingDistance = state.speed ** 2 / (2 * ACCELERATION);
      if (remaining <= stoppingDistance) {
        return advance(
          { ...state, mode: 'decelerate', elapsed: 0, turnFrame: 0 },
          step,
          extent,
        );
      }

      const transitionTime = (remaining - stoppingDistance) / state.speed;
      if (step < transitionTime) {
        return withMovement(state, state.speed * step, extent, {
          elapsed: state.elapsed + step,
          turnFrame: 0,
        });
      }

      const moved = withMovement(state, state.speed * transitionTime, extent, {
        mode: 'decelerate',
        elapsed: 0,
        turnFrame: 0,
      });
      return advance(moved, step - transitionTime, extent);
    }

    case 'decelerate': {
      if (remaining <= 0 || state.speed <= 0) {
        const arrived = withMovement(state, Math.max(0, remaining), extent, {
          mode: 'settle-before-turn',
          speed: 0,
          elapsed: 0,
          turnFrame: 0,
        });
        return advance(arrived, step, extent);
      }

      const deceleration = state.speed ** 2 / (2 * remaining);
      const transitionTime = (2 * remaining) / state.speed;
      if (step < transitionTime) {
        const speed = state.speed - deceleration * step;
        return withMovement(state, (state.speed + speed) * 0.5 * step, extent, {
          speed,
          elapsed: state.elapsed + step,
          turnFrame: 0,
        });
      }

      const arrived = withMovement(state, remaining, extent, {
        mode: 'settle-before-turn',
        speed: 0,
        elapsed: 0,
        turnFrame: 0,
      });
      return advance(arrived, step - transitionTime, extent);
    }

    case 'settle-before-turn': {
      const elapsed = state.elapsed + step;
      if (elapsed >= SETTLE_BEFORE_TURN) {
        return advance(
          { ...state, mode: 'turn', speed: 0, elapsed: 0, turnFrame: 0 },
          elapsed - SETTLE_BEFORE_TURN,
          extent,
        );
      }
      return { ...state, speed: 0, elapsed, turnFrame: 0 };
    }

    case 'turn': {
      const elapsed = state.elapsed + step;
      if (elapsed >= TURN_DURATION) {
        return advance({
          ...state,
          mode: 'settle-after-turn',
          direction: -state.direction,
          speed: 0,
          elapsed: 0,
          turnFrame: TURN_FRAMES - 1,
        }, elapsed - TURN_DURATION, extent);
      }
      return {
        ...state,
        speed: 0,
        elapsed,
        turnFrame: Math.min(
          TURN_FRAMES - 1,
          Math.floor(elapsed / TURN_DURATION * TURN_FRAMES),
        ),
      };
    }

    case 'settle-after-turn': {
      const elapsed = state.elapsed + step;
      if (elapsed >= SETTLE_AFTER_TURN) {
        return advance(
          { ...state, mode: 'accelerate', speed: 0, elapsed: 0, turnFrame: 0 },
          elapsed - SETTLE_AFTER_TURN,
          extent,
        );
      }
      return { ...state, speed: 0, elapsed, turnFrame: 0 };
    }

    default:
      throw new RangeError('Unknown motion mode: ' + state.mode);
  }
}
