// svelte's internal client has no public declaration file; tests use its
// effect_root/user_effect/flush trio to assert runes reactivity directly.
declare module "svelte/internal/client" {
  export function effect_root(run: () => (() => void) | void): () => void;
  export function user_effect(run: () => void): void;
  export function flush(): void;
}
