import type { Position } from './world-types';

// Acknowledgements confirm horizontal movement; z remains inferred until a full server update.
export class MovementTrail {
  private steps: { from: Position; to: Position; facet: number | null }[] = [];
  record(from: Position, to: Position, facet: number | null) {
    if (Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) !== 1) return;
    this.steps.push({ from: { ...from }, to: { ...to }, facet });
    if (this.steps.length > 128) this.steps.shift();
  }
  reverse(at: Position, facet: number | null): Position | undefined {
    return this.steps.findLast((s) => s.facet === facet && s.to.x === at.x && s.to.y === at.y && s.to.z === at.z)?.from;
  }
  clear() {
    this.steps = [];
  }
}
