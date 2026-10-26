<script lang="ts">
  import "./gallery.css";
  import { board } from "../lib/board.svelte";
  import { agents } from "../lib/agents.svelte";
  import { theme, setTheme } from "../lib/theme.svelte";
  import { renderMarkdown } from "../lib/markdown";
  import CardView from "../lib/Card.svelte";
  import LaneView from "../lib/Lane.svelte";
  import Composer from "../lib/Composer.svelte";
  import AddLane from "../lib/AddLane.svelte";
  import SearchBox from "../lib/SearchBox.svelte";
  import IdChip from "../lib/IdChip.svelte";
  import ConfirmDialog from "../lib/ConfirmDialog.svelte";
  import TaskDetail from "../lib/TaskDetail.svelte";
  import TaskEditor from "../lib/TaskEditor.svelte";
  import SettingsPanel from "../lib/SettingsPanel.svelte";
  import AgentsSettings from "../lib/AgentsSettings.svelte";
  import Frame from "./Frame.svelte";
  import { CATALOG, ids, seed } from "./mocks";

  seed();

  // store mutations replace objects, so look everything up by stable mock id
  const byId = (id: string) => board.taskById(id)!;
  const laneOf = (id: string) => board.lanes.find((l) => l.id === id)!;

  let confirming = $state(false);
  let simulatingDrag = $state(false);

  function toggleDrag(): void {
    simulatingDrag = !simulatingDrag;
    const task = byId(ids.working);
    board.dragging = simulatingDrag ? task.id : null;
    board.dropHint = simulatingDrag ? { laneId: task.laneId, index: 1 } : null;
  }

  function toggleCatalog(): void {
    agents.models = agents.models.length ? [] : [...CATALOG];
  }

  // ---------- theme tokens ----------

  const SURFACE = ["--bg", "--bg-panel", "--bg-hover", "--bg-selected", "--bg-subtle", "--border"];
  const TEXT = ["--text", "--text-muted", "--text-dim", "--accent", "--accent-hover", "--accent-contrast"];
  const STATE = ["--error", "--error-border"];
  const LANE_TOKENS = ["--lane-0", "--lane-1", "--lane-2", "--lane-3", "--lane-4", "--lane-5", "--lane-6", "--lane-7"];
  const SYNTAX = [
    "--hl-comment",
    "--hl-keyword",
    "--hl-string",
    "--hl-regexp",
    "--hl-number",
    "--hl-function",
    "--hl-attr",
    "--hl-type",
    "--hl-tag",
    "--hl-meta",
  ];

  let values = $state<Record<string, string>>({});
  $effect(() => {
    void theme.name; // re-read the palette when the theme flips
    const cs = getComputedStyle(document.documentElement);
    values = Object.fromEntries(
      [...SURFACE, ...TEXT, ...STATE, ...LANE_TOKENS, ...SYNTAX].map((n) => [n, cs.getPropertyValue(n).trim()]),
    );
  });

  const codeSample = renderMarkdown(
    [
      "```ts",
      "// syntax palette over the --hl-* tokens",
      "const theme = { bg: cssVar('--bg'), accent: cssVar('--accent') };",
      "export function paint(node: HTMLElement): void {",
      "  node.style.borderColor = theme.accent;",
      "}",
      "```",
    ].join("\n"),
  );

  const SECTIONS = [
    ["tokens", "theme tokens"],
    ["card", "card"],
    ["lane", "lane · add-lane"],
    ["composer", "composer"],
    ["search", "search"],
    ["id-chip", "id chip"],
    ["modals", "modals"],
    ["confirm", "confirm"],
    ["agents", "agents settings"],
  ] as const;
</script>

<div class="gallery">
  <header class="gallery-top">
    <div class="brand"><span class="mark"></span>kanban · gallery</div>
    <span class="hint">dev-only — mock board, no server, writes stay in memory</span>
    <span class="spacer"></span>
    <a class="gallery-link" href="/">← board</a>
    <button
      class="theme-toggle"
      onclick={() => setTheme(theme.name === "dark" ? "light" : "dark")}
      aria-label="toggle theme"
      title="toggle theme"
    >
      {theme.name === "dark" ? "☀" : "☾"}
    </button>
  </header>

  <nav class="gallery-nav" aria-label="gallery sections">
    {#each SECTIONS as [id, label] (id)}
      <a href="#{id}">{label}</a>
    {/each}
  </nav>

  <main class="gallery-main">
    <section class="gallery-section" id="tokens">
      <h2>theme tokens</h2>
      <p class="gallery-desc">
        Every color below is a CSS custom property from app.css; switch the theme in the header to see both palettes.
        This is the checklist for restyling: change a token here, then eyeball every section below.
      </p>
      <div class="gallery-frames">
        <Frame title="surface">
          <div class="swatches">
            {#each SURFACE as name (name)}
              <div class="swatch">
                <div class="swatch-box" style="background: var({name})"></div>
                <div class="swatch-label"><span>{name}</span><span class="swatch-value">{values[name]}</span></div>
              </div>
            {/each}
          </div>
        </Frame>
        <Frame title="text · accent">
          <div class="swatches">
            {#each TEXT as name (name)}
              <div class="swatch">
                <div class="swatch-box" style="background: var({name})"></div>
                <div class="swatch-label"><span>{name}</span><span class="swatch-value">{values[name]}</span></div>
              </div>
            {/each}
          </div>
        </Frame>
        <Frame title="state · error">
          <div class="swatches">
            {#each STATE as name (name)}
              <div class="swatch">
                <div class="swatch-box" style="background: var(--bg-subtle); border-color: var({name})"></div>
                <div class="swatch-label"><span>{name}</span><span class="swatch-value">{values[name]}</span></div>
              </div>
            {/each}
          </div>
        </Frame>
        <Frame title="lane accents (--lane-0…7)">
          <div class="swatches">
            {#each LANE_TOKENS as name (name)}
              <div class="swatch">
                <div class="swatch-box" style="background: var({name})"></div>
                <div class="swatch-label"><span>{name}</span></div>
              </div>
            {/each}
          </div>
        </Frame>
        <Frame title="syntax (--hl-*)" note="swatches + a live highlighted block">
          <div class="swatches">
            {#each SYNTAX as name (name)}
              <div class="swatch">
                <div class="swatch-box" style="background: var({name})"></div>
                <div class="swatch-label"><span>{name}</span></div>
              </div>
            {/each}
          </div>
          <div class="md gallery-code">{@html codeSample}</div>
        </Frame>
        <Frame title="radius · fonts">
          <div class="gallery-row">
            <div class="gallery-radius" style="border-radius: var(--radius-panel)">--radius-panel</div>
            <div class="gallery-radius" style="border-radius: var(--radius-control)">--radius-control</div>
            <div class="gallery-radius" style="border-radius: var(--radius-small)">--radius-small</div>
          </div>
          <div class="gallery-font" style="font-family: var(--font-ui)">--font-ui · The quick brown fox 0123</div>
          <div class="gallery-font" style="font-family: var(--font-mono)">--font-mono · The quick brown fox 0123</div>
        </Frame>
      </div>
    </section>

    <section class="gallery-section" id="card">
      <h2>card</h2>
      <p class="gallery-desc">
        Click a card to open its detail modal. Drag one for real (drop reorders the mock board), or flip the
        simulated-drag state to hold the dashed/drop-gap look still.
      </p>
      <div class="gallery-actions">
        <button class="ghost" onclick={toggleDrag}>
          {simulatingDrag ? "clear simulated drag" : "simulate drag state"}
        </button>
      </div>
      <div class="gallery-frames">
        <Frame title="plain" note="id chip · project chip · waiting ✓ badge · age">
          <CardView task={byId(ids.plain)} />
        </Frame>
        <Frame title="waiting: question" note="? amber badge in card-meta">
          <CardView task={byId(ids.question)} />
        </Frame>
        <Frame title="waiting: rerun" note="↻ badge — muted">
          <CardView task={byId(ids.rerun)} />
        </Frame>
        <Frame title="waiting: capped" note="⏸ badge — muted">
          <CardView task={byId(ids.capped)} />
        </Frame>
        <Frame title="markdown note" note="checklist · fenced code · disclosure + nested child">
          <CardView task={byId(ids.epic)} />
        </Frame>
        <Frame title="all subtasks done" note="progress pill · complete">
          <CardView task={byId(ids.docs)} />
        </Frame>
        <Frame title="cross-lane child" note="↑ parent chip (parent in Plan)">
          <CardView task={byId(ids.crossChild)} />
        </Frame>
        <Frame title="live agent" note="pulsing ◌ chip · detail modal has the streamed log">
          <CardView task={byId(ids.working)} />
        </Frame>
        <Frame title="archived" note="0.72 opacity inside an archive lane">
          <CardView task={byId(ids.archived)} />
        </Frame>
      </div>
    </section>

    <section class="gallery-section" id="lane">
      <h2>lane · add-lane</h2>
      <p class="gallery-desc">
        Double-click a lane name to rename; hover the header for move/delete tools. The archive strip is collapsed —
        click it to expand. Everything writes to the in-memory mock.
      </p>
      <div class="gallery-frames">
        <Frame title="lane" note="cards · add-a-card · composer on click">
          <LaneView lane={laneOf("implement")} index={board.lanes.findIndex((l) => l.id === "implement")} />
        </Frame>
        <Frame title="archive" note="collapsed strip → click to expand">
          <LaneView lane={laneOf("archive")} index={board.lanes.findIndex((l) => l.id === "archive")} />
        </Frame>
        <Frame title="add-lane" note="idle → click → input">
          <AddLane />
        </Frame>
      </div>
    </section>

    <section class="gallery-section" id="composer">
      <h2>composer</h2>
      <p class="gallery-desc">Enter adds a card to the mock backlog (stubbed, no API), Shift+Enter is a newline.</p>
      <div class="gallery-frames">
        <Frame title="composer" note="autofocused · close is a no-op here">
          <Composer lane={laneOf("backlog")} onclose={() => {}} />
        </Frame>
      </div>
    </section>

    <section class="gallery-section" id="search">
      <h2>search</h2>
      <p class="gallery-desc">
        Live against the mock board — press <code>/</code> or type, e.g. "tokens" or "segmented". Enter jumps to the
        card's detail modal.
      </p>
      <div class="gallery-frames">
        <Frame title="search box" note="dropdown · marked matches · lane/ancestor crumbs">
          <SearchBox />
        </Frame>
      </div>
    </section>

    <section class="gallery-section" id="id-chip">
      <h2>id chip</h2>
      <p class="gallery-desc">Click to copy — the ✓ confirmation holds for 1.2s.</p>
      <div class="gallery-frames">
        <Frame title="id chip" note="idle · copied">
          <div class="gallery-row">
            <IdChip id="k7f2m" />
            <IdChip id="demo9" />
          </div>
        </Frame>
      </div>
    </section>

    <section class="gallery-section" id="modals">
      <h2>modals</h2>
      <p class="gallery-desc">
        The real overlays, opened exactly like the board opens them (Escape / backdrop click closes). Comment threads
        and saved agent sessions come from the API, so those two sections render empty here.
      </p>
      <div class="gallery-actions">
        <button class="primary" onclick={() => board.openCard(byId(ids.epic))}>detail · note + plan + subtasks</button>
        <button class="primary" onclick={() => board.openCard(byId(ids.working))}>detail · live agent log</button>
        <button
          class="primary"
          onclick={() => {
            board.openCard(byId(ids.plain));
            board.editMode = true;
          }}
        >
          editor
        </button>
        <button class="primary" onclick={() => (agents.open = true)}>settings dialog</button>
      </div>
    </section>

    <section class="gallery-section" id="confirm">
      <h2>confirm dialog</h2>
      <p class="gallery-desc">Alert dialog layered over whatever is beneath — the editor stacks it at z 45.</p>
      <div class="gallery-frames">
        <Frame title="confirm" note="trigger → overlay">
          <button class="danger" onclick={() => (confirming = true)}>delete something…</button>
        </Frame>
      </div>
    </section>

    <section class="gallery-section" id="agents">
      <h2>agents settings</h2>
      <p class="gallery-desc">
        The settings dialog's agents section, inline. With pi's catalog loaded it shows provider/model selects; empty
        falls back to plain text inputs. Save writes to the mock store only.
      </p>
      <div class="gallery-actions">
        <button class="ghost" onclick={toggleCatalog}>
          {agents.models.length ? "unload pi catalog (→ text inputs)" : "load pi catalog (→ selects)"}
        </button>
      </div>
      <div class="gallery-frames">
        <Frame title="agents settings" note="role seg · model selects · thinking · skills · flags">
          <AgentsSettings />
        </Frame>
      </div>
    </section>
  </main>

  <!-- the real modal stack, mounted exactly like App.svelte mounts it -->
  {#if board.editing}
    {#key board.editing.id}
      {#if board.editMode}
        <TaskEditor />
      {:else}
        <TaskDetail />
      {/if}
    {/key}
  {/if}

  {#if agents.open}
    <SettingsPanel />
  {/if}

  {#if confirming}
    <ConfirmDialog
      title="Delete card"
      message="Permanently delete “old bootstrap task”? There is no undo."
      onconfirm={() => (confirming = false)}
      oncancel={() => (confirming = false)}
    />
  {/if}
</div>
