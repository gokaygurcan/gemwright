import { GARGOYLE_BODIES } from '@gemwright/common/game/bodies';
import { Layer } from '@gemwright/network/layers';
import type { WorldView } from '@gemwright/network/world';

export interface Travel {
  steps: number;
  seconds: number;
  stamina: number;
}
export interface Locomotion {
  experience: (key: string) => Travel | undefined;
  curiosity: number;
  observed: (key: string, steps: number, seconds: number, stamina: number) => void;
}
type Visible = Pick<WorldView, 'entities' | 'serial'> & Partial<Pick<WorldView, 'status'>>;
export function motion(world: Visible, tiles: number, learned?: Locomotion) {
  return movement(world, learned?.experience, learned?.curiosity)(tiles);
}
export function movement(world: Visible, experience: Locomotion['experience'] = () => undefined, curiosity = 0) {
  const mounted = [...world.entities.values()].some((e) => e.parent === world.serial && e.layer === Layer.Mount);
  const self = world.entities.get(world.serial ?? -1);
  const flying = !!((self?.flags ?? 0) & 4);
  const wings = GARGOYLE_BODIES.has(self?.graphic ?? 0) ? [flying, !flying] : [flying];
  return (tiles: number) =>
    wings
      .flatMap((flight) =>
        [false, true].map((running) => {
          const key = `${mounted ? 'mounted' : flight ? 'flying' : 'foot'} ${running ? 'run' : 'walk'}`;
          const past = experience(key);
          const prior = (mounted ? 0.2 : 0.4) / (running ? 2 : 1);
          const seconds = (tiles * ((past?.seconds ?? 0) + prior)) / ((past?.steps ?? 0) + 1);
          const fatigue = (tiles * Math.max(0, past?.stamina ?? 0)) / ((past?.steps ?? 0) + 1);
          const chance = fatigue ? Math.min(1, (world.status?.stamina ?? fatigue) / fatigue) : 1;
          return {
            key,
            running,
            flying: flight,
            seconds,
            cost: seconds / (chance || Number.MIN_VALUE) / (1 + curiosity / ((past?.steps ?? 0) + 1))
          };
        })
      )
      .reduce((best, mode) => (mode.cost < best.cost ? mode : best));
}
