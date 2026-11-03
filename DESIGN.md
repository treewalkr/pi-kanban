---
name: Pi Kanban
description: Local-first kanban board for the pi agent — a dense, quiet operations surface styled after pi-web.
colors:
  accent: "#a4c2f4"
  accent-hover: "#c3d8fa"
  accent-contrast: "#182234"
  bg: "#1a1a1a"
  bg-panel: "#242424"
  bg-hover: "#2e2e2e"
  bg-selected: "#383838"
  bg-subtle: "rgba(255, 255, 255, 0.04)"
  border: "#454545"
  text: "#e8e8e8"
  text-muted: "#b7b7b7"
  text-dim: "#a4a4a4"
  error: "#f87171"
  warn: "#d29922"
  user-bg: "#292929"
  lane-gray: "#a4a4a4"
  lane-blue: "#a4c2f4"
  lane-amber: "#e8b27a"
  lane-violet: "#cdb4f0"
  lane-green: "#acccb7"
  lane-rose: "#f0a8a8"
  lane-cyan: "#8ccfe0"
  lane-lilac: "#e0d0f7"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    lineHeight: 1.45
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.35
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.2
  meta:
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "11px"
    lineHeight: 1.4
rounded:
  panel: "8px"
  control: "7px"
  small: "5px"
  pill: "999px"
spacing:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-contrast}"
    rounded: "{rounded.control}"
    padding: "4px 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.small}"
    padding: "2px 7px"
  button-ghost-hover:
    backgroundColor: "{colors.bg-hover}"
    textColor: "{colors.text}"
  card:
    backgroundColor: "{colors.bg-hover}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  chip:
    backgroundColor: "{colors.bg-subtle}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "4px 8px"
  modal:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "14px 16px"
  code-block:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "7px"
---

# Design System: Pi Kanban

Ported from **pi-web** (`../pi-web`, `app/globals.css`): neutral grays, one soft accent, mono meta text, flat bordered panels, `color-mix` borders, focus-visible outlines, quiet scrollbars. Pi-web ships twelve `[data-theme]` skins (mist, rose, pine, sand, slate, dusk, lilac, ember, contrast pair, zenburn); kanban carries two — dark (default, `:root`/`[data-theme="dark"]`) and light. The lane accents are lifted from pi-web's theme accents.

## Overview

**Creative North Star: "The Quiet Workbench"**

A board is an operations room, not a landing page. Everything is flat, bordered, and quiet: neutral gray surfaces stack by tone, hairline borders do the separating, and exactly one soft blue accent is allowed to speak. Density is a feature — a kanban card carries an id, a title, chips, and a lane color in two lines of 12px text, and the board still breathes. The work is the color; the interface is the wall it hangs on.

The mono voice carries all metadata. Card ids, paths, lane names, counts, timestamps, and version chips are 11px JetBrains Mono in muted grays — the terminal cadence of the pi agent the board serves. Body and titles are the native system stack, never decorative.

Light theme is the same system on white: the gray ladder flips direction, the accent deepens for contrast on white, and nothing else changes. Themes swap token values only; no component ever hardcodes a theme.

**Key Characteristics:**
- Flat surfaces, 1px borders, tonal layering — shadows only for floating layers (modals, drawers, popovers)
- One accent (soft slate blue) at ≤10% of any screen; eight muted lane hues are the only other colors
- Mono 11px for all meta; system sans for body and titles
- Tight radii: 8px panels, 7px controls, 5px small bits
- Focus-visible outlines everywhere: 2px accent, offset 2px
- Scrollbars invisible until their container scrolls

## Colors

Dark grays stepped one from another; the accent is a pastel blue that reads as "interactive", not "branded". Frontmatter values are the dark (default) theme; light values map 1:1 by token name.

### Primary
- **Quiet Blue** (`accent` #a4c2f4): the single interactive color — primary buttons, links, focus rings, selected states, drag hints. Its rarity is the point.
- **Quiet Blue Hover** (`accent-hover` #c3d8fa): one step lighter, hover only.
- **Accent Ink** (`accent-contrast` #182234): text on accent fills — a dark navy, never pure black or white.

### Neutral
- **Canvas** (`bg` #1a1a1a): the page.
- **Panel** (`bg-panel` #242424): sidebars, column headers, table headers, popovers' parents.
- **Hover** (`bg-hover` #2e2e2e): hover fill for rows, cards, ghost buttons. Also the resting card surface — cards are "pre-hovered" panels.
- **Selected** (`bg-selected` #383838): active/pressed/selected fills.
- **Subtle Wash** (`bg-subtle` rgba(255,255,255,0.04)): inset tints — inline code, chips, quiet rows.
- **Hairline** (`border` #454545): every border. Translucent variants are always `color-mix(in srgb, var(--border) N%, transparent)`, never a second hex.
- **Text** (`text` #e8e8e8), **Muted** (`text-muted` #b7b7b7), **Dim** (`text-dim` #a4a4a4): the three-stop text ladder — body / secondary / meta.

### Tertiary
- **Lane Eight** (`lane-gray` → `lane-lilac`): eight muted hues (gray, blue, amber, violet, green, rose, cyan, lilac) assigned to lanes by index. Pastel on dark, deeper on light. The only sanctioned multi-hue zone in the product.
- **Error** (`error` #f87171) and **Warn** (`warn` #d29922): status only. Warn is the CLI's ⚠ amber; error borders are `color-mix(in srgb, var(--error) 35%, var(--border))`.
- **User Bubble** (`user-bg` #292929): chat user-message background, inherited from pi-web.

### Light theme mapping
`bg` #ffffff, `bg-panel` #f5f5f5, `bg-hover` #eeeeee, `bg-selected` #e8e8e8, `border` #e0e0e0, `text` #1a1a1a, `text-muted` #515c6b, `text-dim` #5e6673, `accent` #245bce, `accent-hover` #1d4ed8, `accent-contrast` #ffffff, `user-bg` #eff6ff, `bg-subtle` rgba(0,0,0,0.03), `error` #dc2626, `warn` #9a6700; lane accents swap to their deeper light-theme values (same hues).

### Named Rules
**The One Voice Rule.** The accent appears on ≤10% of any screen. If everything is accented, nothing is.

**The Hairline Rule.** Separation is a 1px border or a tone step, never a shadow at rest and never a second border color.

**The Fixed Palette Rule.** No new hues. UI color = grays + accent; lanes = the eight lane hues; status = error/warn. Anything else is a bug in the design, not a feature.

## Typography

**Display Font:** system sans (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`)
**Body Font:** system sans
**Label/Mono Font:** JetBrains Mono (`"JetBrains Mono", "Fira Code", ui-monospace, "SF Mono", Menlo, Consolas, monospace`)

**Character:** The system stack keeps the app native and invisible; the mono face does all the identity work, marking data (ids, paths, counts, versions) as machine-adjacent. No display faces, no font downloads, no @font-face — system stacks only.

### Hierarchy
- **Display** (700, 16px, 1.2): the brand mark and modal titles. Rare — one per surface.
- **Title** (600, 13px, 1.35): card titles in detail views, section headings, column headers.
- **Body** (400, 14px, 1.45): base body size; most board text is this or smaller.
- **Meta** (400, 11px mono, 1.4): card ids, lane chips, counts, timestamps, paths, version strings. Uppercase only for column headers, never for data.
- **Small** (400, 10–12px): chips and dense rows; never below 10px.

### Named Rules
**The Mono-Meta Rule.** If a string would be typed into a terminal (id, path, sha, command, count), it renders in mono at meta size. If a human wrote it as prose, it's sans.

## Layout

A fixed left sidebar (resizable, default 260px, collapsible) and a horizontal lane scroller filling the rest. Lanes are equal-width columns (~260–300px) with a header row (name, WIP count chip) and a card stack; fixed lanes "Waiting on you" and "Backlog" lead, Done trails. Cards are 2-line-max dense blocks (id + title + chips).

Modals overlay centered (min(720px, 90vw) for the card editor and the card detail; min(960px, 94vw) for the file preview; 520px × min(620px, 100dvh − 16px) for the directory picker, a direct pi-web `DirectoryPicker` port). Drawers slide from the right (chat) or bottom. The chrome z-ladder is fixed: content < sticky headers < modals (40) < palettes/confirm (45) < expanded chat (55); any persistent chrome above 40 hides while a modal is open.

Breakpoints: 640px (sidebar becomes a slide-in overlay, touch targets grow to 44px), 450px (header folds to two rows, search first), 420px (three rows). Spacing rhythm is 6/8/10/12px; card interiors pad 8px 10px; row gaps 6–8px. Density beats air: the board is meant to be scanned, not admired.

## Elevation & Depth

Flat by default. Depth is tonal — `bg` → `bg-panel` → `bg-hover` → `bg-selected` steps and hairline borders carry all hierarchy at rest. Shadows exist only for things that float above the board:

### Shadow Vocabulary
- **Popover** (`0 6px 20px rgba(0, 0, 0, 0.1)`): menus, palettes, search dropdowns — border + shadow together.
- **Modal** (`0 8px 32px rgba(0, 0, 0, 0.18)`): centered dialogs — the card editor, the directory picker and its sub-dialogs. Lifted from pi-web's dialog panels.
- **Drawer** (`8px 0 24px rgba(0, 0, 0, 0.25)`): the mobile/right-side chat drawer, directional.
- **Overlay scrim** (`rgba(0, 0, 0, 0.35)`): modal backdrops and in-modal sub-dialog scrims. Never opaque, never tinted.

### Named Rules
**The Flat-By-Default Rule.** Nothing at rest casts a shadow. A shadow means "I float above the board" — popover, drawer, modal — and nothing else.

## Shapes

Tight, quiet corners: 8px on panels/modals, 7px on controls/cards/inputs/code blocks, 5px on small bits (inline code, mini buttons), full-radius pills for chips. No rounded-corner decoration, no cut corners, no circular anything except status dots and scroll-to-bottom pills. Cards are rectangles with a 1px border and a 3px lane-accent bar on top — the lane color is the card's only ornament.

## Components

### Buttons
- **Shape:** control radius (7px); icon buttons square to their glyph (1.75-stroke Lucide SVGs, currentColor, 14–16px).
- **Primary:** accent fill, accent-contrast text, 4px 12px padding, 12–13px text.
- **Ghost (default):** transparent, text-muted; hover fills `bg-hover` and text goes full `text`. Most buttons in the app are ghosts.
- **Focus:** `:focus-visible` only — 2px solid accent outline, 2px offset. Never `outline: none` without a replacement.

### Chips
Pills (`999px`, `0 8px` padding, 10–12px) on `bg-subtle` with text-muted — tags, lane counts, WIP warnings, waiting-state markers. Priority glyphs (▲ ▼) and state glyphs (⊘ ‖ ✓) are text, not icons; icon vocabulary belongs to Lucide buttons only. Multi-value filters live in a popover, never as inline chip rows in chrome.

### Cards / Containers
- **Corner Style:** 7px.
- **Background:** `bg-hover` resting; drag lifts to `bg-selected` + popover shadow.
- **Border:** 1px `border`; lane accent as a 3px top bar.
- **Internal Padding:** 8px 10px.

### Inputs / Fields
Border 1px `border`, `bg` fill, control radius, 4px 8px padding, mono for path/id/URL fields. Inputs sit one tone **above** their container: `bg` on `bg-panel` surfaces, and `bg-panel` inside `bg` modals (the directory picker's pattern, from pi-web). Focus: border shifts to accent + `0 0 0 3px` accent-at-18% ring (`color-mix`). Textareas (editor, chat composer) use panel radius and grow downward; the composer borrows pi-web's 14px soft-corner card. Under 640px, inputs go 16px font to stop iOS focus zoom.

### Navigation
Sidebar: panel background, hairline right border, mono 11px section labels, ghost rows with hover fill; active row = `bg-selected` + accent text cue. Column headers: 12px title + count chip on `bg-panel`, hairline below.

### Board Chat
Per-card chat and the manager drawer use pi-web's chat anatomy: user bubbles on `user-bg`, assistant on `bg`, tool blocks on `bg-panel` in mono 11px, 820px max content width in the drawer.

### Code Blocks
`bg` fill, 1px border, 7px radius, mono 11–12px, header strip (`bg-panel`, 11px) with the language. Long lines **scroll, never wrap** (settled taste, REVIEW.md).

## Do's and Don'ts

### Do:
- **Do** use `color-mix(in srgb, var(--border) N%, transparent)` for translucent borders — one border token, infinite alphas.
- **Do** give every interactive element a `:focus-visible` style (2px accent, 2px offset) — the board is keyboard-driven as much as mouse-driven.
- **Do** render ids, paths, counts, and commands in mono meta text.
- **Do** stack toggle states with multiple cues (filled icon + tinted pill + accent), never hue alone.
- **Do** keep touch targets ≥44px under 640px and on coarse pointers.
- **Do** check the z-ladder before adding any fixed/overlay element (40 / 45 / 55), and hide chrome above 40 when a modal opens.

### Don't:
- **Don't** add a new hue, gradient, or font — grays + accent + lane eight + error/warn is the whole palette; system stacks are the whole type system.
- **Don't** shadow anything at rest, or use borders on floating layers without their popover shadow.
- **Don't** wrap code blocks; they scroll.
- **Don't** use emoji or icon fonts in the UI; Lucide SVGs for buttons, text glyphs for chips and CLI-rendered states.
- **Don't** let an accent fill exceed ~10% of a screen — primary buttons stay small and rare.
- **Don't** invent per-component colors that bypass the token vars; theme switching (dark ↔ light) must stay a pure token swap.
