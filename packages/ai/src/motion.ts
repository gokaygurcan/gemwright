import { GARGOYLE_BODIES } from '@gemwright/common/game/bodies';
import { Layer } from '@gemwright/network/layers';

import type { Mind } from './mind';
import type { Screen } from './perceive';

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
// The body that moves: riding or not, flying or not, whether it has wings to choose with, and the
// stamina it has to run on.
export interface Body {
  mounted: boolean;
  flying: boolean;
  winged: boolean;
  stamina?: number;
}
// Its body as it knows itself (mind.ts), for weighing journeys.
export const bodyOf = (mind: Mind): Body => ({
  mounted: mind.riding,
  flying: mind.self.flying,
  winged: GARGOYLE_BODIES.has(mind.self.body ?? 0),
  stamina: mind.self.stamina?.current
});
// Its body as the screen shows it now (perceive.ts), for the hands that move it.
export const bodyOnScreen = (screen: Screen): Body => {
  const self = screen.entities.get(screen.serial ?? -1);
  return {
    mounted: [...screen.entities.values()].some((e) => e.parent === screen.serial && e.layer === Layer.Mount),
    flying: !!((self?.flags ?? 0) & 4),
    winged: GARGOYLE_BODIES.has(self?.graphic ?? 0),
    stamina: screen.status?.stamina
  };
};
export function motion(body: Body, tiles: number, learned?: Locomotion) {
  return movement(body, learned?.experience, learned?.curiosity)(tiles);
}
export function movement(body: Body, experience: Locomotion['experience'] = () => undefined, curiosity = 0) {
  const { mounted, flying } = body;
  const wings = body.winged ? [flying, !flying] : [flying];
  return (tiles: number) =>
    wings
      .flatMap((flight) =>
        [false, true].map((running) => {
          const key = `${mounted ? 'mounted' : flight ? 'flying' : 'foot'} ${running ? 'run' : 'walk'}`;
          const past = experience(key);
          const prior = (mounted ? 0.2 : 0.4) / (running ? 2 : 1);
          const seconds = (tiles * ((past?.seconds ?? 0) + prior)) / ((past?.steps ?? 0) + 1);
          const fatigue = (tiles * Math.max(0, past?.stamina ?? 0)) / ((past?.steps ?? 0) + 1);
          const chance = fatigue ? Math.min(1, (body.stamina ?? fatigue) / fatigue) : 1;
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
