# Library Reference: React 19 (Stable)

Updated as of: March 2, 2026

## 1. Syntax & Hook Reference
*(... See previous version for full hook signatures ...)*

---

## 2. 🚫 Anti-AI Slop (React 19)
AI models often default to legacy patterns. The following are strictly prohibited:

| Legacy/Slop Pattern | Modern Standard (2026) | Why? |
| :--- | :--- | :--- |
| `useState` + `useEffect` for forms | `useActionState` | Native pending/error handling without manual sync. |
| `forwardRef` wrapping | Pass `ref` as a standard prop | Ref is now a first-class prop; reduces boilerplate. |
| `useEffect` for data fetching | `use(Promise)` | Integrated with `<Suspense>`; avoids waterfalls and race conditions. |
| `useMemo` / `useCallback` | **Zero Manual Memoization** | The React Compiler handles this; manual use is now "slop." |
| `react-helmet` / manual head | Native `<title>`, `<meta>` | React 19 hoists these to the head automatically. |
| `key={index}` | **Stable UUIDs** | AI defaults to index keys; mandatory unique IDs for Mikup events. |

---

## 3. The React Compiler (Rules)
- **Directives:** Use `"use memo"` only for non-standard functions. Use `"use no memo"` to opt-out.
- **Purity:** All components must be pure. Side effects in render will cause compiler bail-out.

---

## 4. Best Practices for Mikup
1. **Action-First Flow**: Use `useActionState` for all Tauri `invoke()` calls.
2. **Ref Cleanup**: Use the new return-callback syntax in `ref` for Canvas setup/teardown.
3. **Optimistic UI**: Use `useOptimistic` for mixer controls to bypass IPC latency.
