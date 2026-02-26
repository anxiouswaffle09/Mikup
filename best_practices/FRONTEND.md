# Best Practices: Frontend (UI/UX)

Updated as of: February 26, 2026

## React 19 (Stable)
React 19 is now the production standard, with the Compiler (`react-compiler`) enabled by default in many Vite setups.

### Key Practices:
- **Zero UseMemo:** The React Compiler handles memoization automatically; remove manual `useMemo` and `useCallback` for cleaner code.
- **Server Components (RSC):** Even in a Tauri app, using the RSC pattern for heavy data-fetching components (like the "Mikup Report" generator) can improve perceived performance.
- **Actions API:** Use `useActionState` and `useFormStatus` for ingestion forms.

## Tailwind CSS v4 (Oxide Engine)
v4 is a complete rewrite in Rust, moving towards a "CSS-first" configuration.

### Key Practices:
- **No `tailwind.config.js`:** All configuration is now done via `@theme` variables in `index.css`.
- **Oxide Engine:** Up to 10x faster build times in large component libraries.
- **CSS Variables:** Direct usage of `var(--color-blue-500)` is preferred for performance over `@apply`.
- **Gap over Space-y:** Migration from `space-y-*` to `flex flex-col gap-*` is recommended for better performance and layout control.

### v4 Config Snippet (`src/index.css`):
```css
@import "tailwindcss";

@theme {
  --color-brand: oklch(0.6 0.1 250);
  --font-display: "Satoshi", "sans-serif";
}

@utility container-mikup {
  max-width: 1400px;
  margin-inline: auto;
  padding: var(--spacing-8);
}
```

## Tauri v2
- **Mobile Support:** Tauri v2 is stable for iOS and Android, allowing the Mikup viewer to run as a native mobile app.
- **Permissions:** Use the new granular permission system in `src-tauri/capabilities/default.json` for filesystem and audio access.
