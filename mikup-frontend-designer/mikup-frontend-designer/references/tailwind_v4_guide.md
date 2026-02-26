# Tailwind CSS v4 Guide

## Configuration (v4 CSS-First)

All configuration is now done in `src/index.css` using `@theme` and `@utility` rules.

### `src/index.css` Example:

```css
@import "tailwindcss";

@theme {
  --color-brand: oklch(0.6 0.1 250);
  --font-display: "Satoshi", "sans-serif";
  --radius-mikup: 12px;
}

@utility container-mikup {
  max-width: 1400px;
  margin-inline: auto;
  padding: var(--spacing-8);
}

@utility glass-morphism {
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
```

## Best Practices

- **Gap over Space-y**: Migration from `space-y-*` to `flex flex-col gap-*` is mandatory for better performance and layout control.
- **Oxide Engine**: Take advantage of the 10x faster build times; iterate rapidly on complex components.
- **CSS Variables**: Use `var(--color-brand)` directly in custom CSS when needed, rather than `@apply`.
- **OKLCH**: Use the `oklch()` color space for perceptually uniform colors (perfect for accessibility and consistent branding).

## Layout Guidelines

- **Container**: Use `@utility container-mikup` for main page containers.
- **Grid**: Prefer CSS Grid (`grid grid-cols-*`) for complex dashboards like the `MetricsPanel`.
- **Responsive**: Design mobile-first; Tauri v2 supports mobile builds.
