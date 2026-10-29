import type { Entity } from './world';

// Entities indexed by parent, so container and equipment lookups never scan every observation.
export class EntityMap extends Map<number, Entity> {
  constructor(private readonly changed: (serial: number, removed?: boolean) => void = () => {}) {
    super();
  }
  private readonly children = new Map<number, Set<number>>();

  override set(serial: number, entity: Entity): this {
    const previous = super.get(serial)?.parent;
    if (previous !== entity.parent) {
      if (previous !== undefined) this.children.get(previous)?.delete(serial);
      if (entity.parent !== undefined) {
        const set = this.children.get(entity.parent) ?? new Set<number>();
        this.children.set(entity.parent, set);
        set.add(serial);
      }
    }
    super.set(serial, entity);
    this.changed(serial);
    return this;
  }

  override delete(serial: number): boolean {
    const parent = super.get(serial)?.parent;
    if (parent !== undefined) this.children.get(parent)?.delete(serial);
    this.children.delete(serial);
    const removed = super.delete(serial);
    if (removed) this.changed(serial, true);
    return removed;
  }

  override clear(): void {
    for (const serial of [...this.keys()]) this.delete(serial);
    this.children.clear();
  }

  childSerials(parent: number): ReadonlySet<number> {
    return this.children.get(parent) ?? new Set();
  }

  childrenOf(parent: number): Entity[] {
    return [...this.childSerials(parent)].flatMap((serial) => super.get(serial) ?? []);
  }
}
