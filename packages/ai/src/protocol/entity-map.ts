import type { Entity } from './world';

// Entities indexed by parent, so container and equipment lookups never scan every observation.
export class EntityMap extends Map<number, Entity> {
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
    return super.set(serial, entity);
  }

  override delete(serial: number): boolean {
    const parent = super.get(serial)?.parent;
    if (parent !== undefined) this.children.get(parent)?.delete(serial);
    this.children.delete(serial);
    return super.delete(serial);
  }

  override clear(): void {
    this.children.clear();
    super.clear();
  }

  childSerials(parent: number): ReadonlySet<number> {
    return this.children.get(parent) ?? new Set();
  }

  childrenOf(parent: number): Entity[] {
    return [...this.childSerials(parent)].flatMap((serial) => super.get(serial) ?? []);
  }
}
