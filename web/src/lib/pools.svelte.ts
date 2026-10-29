import { api } from "../api";
import type { WorkerPool } from "../../../src/db";
import type { CatalogModel } from "../../../src/models";
import { board } from "./board.svelte";

type EdenError = { value?: unknown };

export function newPoolDraft(): WorkerPool {
  return {
    id: Math.random().toString(36).slice(2, 7),
    name: "",
    enabled: false,
    roles: [],
    slots: [{}],
    updatedAt: Date.now(),
  };
}

class PoolsStore {
  loaded = $state(false);
  pools = $state<WorkerPool[]>([]);
  models = $state<CatalogModel[]>([]);

  private fail(error: EdenError): void {
    const value = error.value as { error?: string } | undefined;
    board.error = value?.error ?? "request failed";
  }

  async load(): Promise<void> {
    const [poolsRes, modelsRes] = await Promise.all([
      api.pools.get(),
      api["pi-models"].get(),
    ]);
    if (poolsRes.error) this.fail(poolsRes.error);
    else {
      this.pools = poolsRes.data.pools ?? [];
      this.loaded = true;
    }
    if (!modelsRes.error) this.models = modelsRes.data.models;
  }

  async save(pool: WorkerPool): Promise<boolean> {
    const { data, error } = await api.pools({ id: pool.id }).put({
      name: pool.name,
      enabled: pool.enabled,
      roles: pool.roles,
      slots: pool.slots,
    });
    if (error) {
      this.fail(error);
      return false;
    }
    const idx = this.pools.findIndex((p) => p.id === pool.id);
    if (idx !== -1) {
      this.pools[idx] = data as WorkerPool;
    } else {
      this.pools.push(data as WorkerPool);
    }
    return true;
  }

  async remove(id: string): Promise<boolean> {
    const { error } = await api.pools({ id }).delete();
    if (error) {
      this.fail(error);
      return false;
    }
    this.pools = this.pools.filter((p) => p.id !== id);
    return true;
  }
}

export const pools = new PoolsStore();
