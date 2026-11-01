import type { WorldView } from '../world';

// One server packet applied to the world view; the opcode lets one decoder serve a packet pair.
export type Decoder = (world: WorldView, packet: Buffer, opcode: number) => void;
