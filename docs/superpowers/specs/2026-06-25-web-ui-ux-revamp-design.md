# Web UI/UX Revamp Design Specification (V2)

## Overview
This document specifies a comprehensive UI/UX overhaul for the `oc-switch` Web Dashboard. Based on feedback, the design will transition from a sparse card layout to a highly compact IDE-style master-detail view for models, introduce a floating Theme Switcher (supporting dark/light/system modes), streamline interactive controls by using icon-only hover action bars, and tighten visual spacing globally to increase information density.

## Core Architectural Changes

### 1. Dual-Theme Support (Dark/Light/System)
- **Theme Engine**: Implement standard Tailwind dark mode using the class-based approach (`selector` or `class` strategy).
- **Theme Toggle**: A floating, glassmorphism-styled Theme Switcher positioned at the top right of the viewport (`fixed top-4 right-4 z-50`).
- **Initial Load Script**: Inline script in `index.html` to check `localStorage.theme` and system preference (`prefers-color-scheme: dark`) to prevent flashing during load.
- **Color Palettes**:
  - **Light Mode**:
    - Background: `bg-slate-50`
    - Cards/Dialogs: `bg-white` with `shadow-sm` and `border-slate-200/60`
    - Text: `text-slate-900` primary, `text-slate-500` secondary
  - **Dark Mode**:
    - Background: `bg-slate-950`
    - Cards/Dialogs: `bg-slate-900/60` with `border-slate-800`
    - Text: `text-slate-100` primary, `text-slate-400` secondary

### 2. High-Density Layout & Compact Paddings
- Reduce global padding and row heights by roughly 30-40%.
- Restrict maximum widths of tables and forms (e.g., `max-w-4xl`) to prevent horizontal stretching and excessive empty spaces on wide screens.

---

## Component & View Designs

### 1. IDE-style Master-Detail Models View (`ModelsView.tsx`)
- **Master Column (Left Sidebar)**:
  - Width: Fixed `260px` with a subtle right border (`border-r`).
  - Contains a filter input for quickly searching providers.
  - Lists all available Providers vertically.
  - Each item shows:
    - Provider ID.
    - Model count badge (e.g., `minimax-portal (2)`).
  - Selected item gets a background highlight and a left border indicator (`border-l-2 border-primary bg-primary/10`).
- **Detail Column (Right Pane)**:
  - Width: Flexible, but content limited to `max-w-4xl` to keep it compact.
  - Displays the active Provider's title.
  - Renders a dense table of models for the active Provider.
- **Model Rows & Hover Actions**:
  - **Status Differentiation**:
    - Enabled models: Standard styling. The current primary model has a gold star `★` icon and a "当前主模型" badge.
    - Disabled models: Subdued style (`opacity-60 grayscale-[0.2]`).
  - **Hover Action Bar**:
    - Positioned in the "操作" (Actions) column.
    - By default, the buttons are hidden (`opacity-0 group-hover:opacity-100 transition-opacity`).
    - The action bar displays icon-only, borderless buttons:
      - `Star` (Set Primary): Solid gold star if active (disabled click); empty star if inactive (click sets as primary).
      - `Switch` (Enable/Disable toggle): Small Radix Switch component.
      - `Edit3` (Edit): Opens `ModelDialog`.
      - `Trash2` (Delete): Opens `ConfirmDialog`.

### 2. Global Dialog Styling (`ui/dialog.tsx`, `ConfirmDialog.tsx`)
- Ensure both light and dark modes are properly styled with appropriate background, text, border, and backdrop colors.

---

## Self-Review Checklist
- [x] Vague placeholders removed.
- [x] Clean separation of concerns (all styles controlled via Tailwind variables and Tailwind config).
- [x] Design solves the stretch/emptiness issue (two-column layout contains the width).
- [x] The theme engine works in isolation (independent React state + body class).
- [x] Accessibility (ARIA triggers for custom buttons and Switch toggles).
