# Library Reference: Tailwind CSS v4

Updated as of: March 2, 2026

## 1. Syntax & Core Utilities
*(... See previous version for layout/spacing/typography ...)*

---

## 2. 🚫 Anti-AI Slop (v4 Oxide)
v4 is CSS-first. AI models often generate legacy v3 patterns. The following are prohibited:

| Legacy/Slop Pattern | Modern Standard (2026) | Why? |
| :--- | :--- | :--- |
| `tailwind.config.js` | **`@theme` in CSS** | v4 is zero-config in JS; configuration is native CSS variables. |
| Triple `@tailwind` directives | `@import "tailwindcss"` | v4 uses a single unified import for Oxide/Lightning CSS. |
| `@apply` for everything | **Standard CSS + Variables** | `@apply` is less idiomatic in v4; use native CSS variables. |
| `resolveConfig` in JS | **`getComputedStyle`** | Access theme values via CSS variables (`var(--color-accent)`). |
| Arbitrary values `-[...]` | **Variable in `@theme`** | If a value is used twice, it belongs in the CSS theme block. |
| External Container Plugin | **Native `@container`** | Container queries are built-in; no extra dependency needed. |

---

## 3. CSS-First Theme Configuration (`@theme`)
```css
@import "tailwindcss";

@theme {
  --color-accent: oklch(0.45 0.15 260);
  --color-panel: transparent;
}
```

---

## 4. Best Practices for Mikup
1. **Glassmorphism Standard**: `bg-white/5 backdrop-blur-md border border-white/10`.
2. **Perceptual Consistency**: Always use `oklch()` for diagnostic colors to ensure consistent brightness across hues.
3. **Native Nesting**: Use standard CSS nesting instead of over-complicated Tailwind class combinations for complex state.
