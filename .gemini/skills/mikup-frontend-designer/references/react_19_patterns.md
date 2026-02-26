# React 19 Patterns

## Key Principles

- **Zero UseMemo/UseCallback**: The React Compiler handles memoization automatically. Avoid these unless specific profiling identifies a need.
- **Actions API**: Use `useActionState` and `useFormStatus` for ingestion forms.
- **Transitions**: Use `useTransition` for state updates that might block the UI.

### Example: Form Action for Ingestion

```tsx
import { useActionState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function IngestionHeader() {
  const [state, formAction, isPending] = useActionState(async (prevState: any, formData: FormData) => {
    const audioPath = formData.get("audioPath") as string;
    const result = await invoke("process_audio", { audioPath });
    return JSON.parse(result as string);
  }, null);

  return (
    <form action={formAction}>
      <input name="audioPath" type="text" placeholder="Path to audio..." />
      <button type="submit" disabled={isPending}>
        {isPending ? "Processing..." : "Start Ingestion"}
      </button>
      {state && <div>Process Complete!</div>}
    </form>
  );
}
```

## State Management

- **Global State**: Managed in `App.tsx` and passed down to specialized components (`MetricsPanel`, `WaveformVisualizer`).
- **Local State**: Use `useState` for component-specific UI state (e.g., chat input, panel visibility).
- **Data Fetching**: Mock data is loaded via standard `fetch()` in development; real data is received via Tauri `invoke()`.
