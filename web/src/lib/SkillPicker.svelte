<script lang="ts">
  import { agents } from "./agents.svelte";
  import { filterSkills, offerCustomPath, skillLabel, toggleSkill } from "./skillPicker";

  let {
    selected,
    onchange,
  }: { selected: string[]; onchange: (paths: string[]) => void } = $props();

  let input = $state<HTMLInputElement>();
  let open = $state(false);
  let query = $state("");
  let highlighted = $state(0);

  let filtered = $derived(filterSkills(agents.skills, query));
  let offerCustom = $derived(offerCustomPath(query, filtered.length));
  let total = $derived(filtered.length + (offerCustom ? 1 : 0));
  let showDropdown = $derived(open && total > 0);

  $effect(() => {
    if (total > 0) {
      highlighted = Math.max(0, Math.min(highlighted, total - 1));
    } else {
      highlighted = 0;
    }
  });

  $effect(() => {
    void highlighted;
    if (showDropdown) {
      document.querySelector('.skill-picker-results [aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    }
  });

  function addCustom(): void {
    const path = query.trim();
    if (!path) return;
    onchange(toggleSkill(selected, path));
    query = "";
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!showDropdown || total === 0) return;
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      highlighted = (highlighted + dir + total) % total;
    } else if (e.key === "Enter") {
      if (!showDropdown || total === 0) return;
      e.preventDefault();
      if (highlighted < filtered.length) {
        const item = filtered[highlighted];
        if (item) onchange(toggleSkill(selected, item.path));
      } else if (offerCustom) {
        addCustom();
      }
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      open = false;
    }
  }
</script>

<div class="skill-picker">
  {#if selected.length > 0}
    <div class="skill-chips">
      {#each selected as path (path)}
        {@const info = skillLabel(path, agents.skills)}
        <span
          class="skill-chip"
          class:unknown={!info.known}
          title={info.known ? path : "not in the pi catalog — check this path"}
        >
          <span class="skill-chip-label">{info.label}</span>
          <button
            type="button"
            class="skill-chip-remove"
            aria-label={`remove ${info.label}`}
            onclick={() => onchange(toggleSkill(selected, path))}
          >
            ✕
          </button>
        </span>
      {/each}
    </div>
  {/if}

  <div class="skill-picker-box">
    <input
      class="skill-picker-input"
      type="text"
      placeholder="search skills or type path…"
      aria-label="search skills"
      bind:this={input}
      bind:value={query}
      onfocus={() => (open = true)}
      onblur={() => (open = false)}
      oninput={() => {
        open = true;
        highlighted = 0;
      }}
      onkeydown={onKeydown}
      aria-haspopup="listbox"
    />
    {#if showDropdown}
      <div class="skill-picker-results" role="listbox">
        {#each filtered as skill, i (skill.path)}
          {@const isSelected = selected.includes(skill.path)}
          <button
            type="button"
            class="skill-option"
            class:active={i === highlighted}
            class:selected={isSelected}
            role="option"
            aria-selected={i === highlighted}
            onmousedown={(e) => e.preventDefault()}
            onpointerenter={() => (highlighted = i)}
            onclick={() => onchange(toggleSkill(selected, skill.path))}
          >
            <span class="skill-check">{isSelected ? "✓" : ""}</span>
            <span class="skill-info">
              <span class="skill-name">{skill.name}</span>
              {#if skill.description}
                <span class="skill-desc">{skill.description}</span>
              {/if}
            </span>
          </button>
        {/each}
        {#if offerCustom}
          {@const customIndex = filtered.length}
          <button
            type="button"
            class="skill-option custom-path"
            class:active={customIndex === highlighted}
            role="option"
            aria-selected={customIndex === highlighted}
            onmousedown={(e) => e.preventDefault()}
            onpointerenter={() => (highlighted = customIndex)}
            onclick={addCustom}
          >
            <span class="skill-check">+</span>
            <span class="skill-info">
              <span class="skill-name">add custom path: {query.trim()}</span>
            </span>
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .skill-picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }

  .skill-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .skill-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-subtle);
    color: var(--text);
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    line-height: 16px;
  }

  .skill-chip.unknown {
    color: #d29922;
    border-color: color-mix(in srgb, #d29922 40%, var(--border));
  }

  .skill-chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 220px;
  }

  .skill-chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    padding: 0;
    font-size: 11px;
    line-height: 1;
  }

  .skill-chip-remove:hover {
    color: var(--text);
  }

  .skill-picker-box {
    position: relative;
    width: 100%;
  }

  .skill-picker-input {
    width: 100%;
  }

  .skill-picker-results {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    max-height: 260px;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-panel, 6px);
    background: var(--bg-panel);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    z-index: 30;
  }

  .skill-option {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-small, 4px);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .skill-option.active {
    background: var(--bg-hover);
  }

  .skill-check {
    flex: none;
    width: 16px;
    color: var(--accent);
    font-weight: bold;
    text-align: center;
  }

  .skill-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .skill-name {
    font-weight: 500;
    color: var(--text);
  }

  .skill-desc {
    font-size: 11px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .skill-option.custom-path .skill-name {
    color: var(--accent);
    font-family: var(--font-mono, monospace);
    font-size: 12px;
  }
</style>
