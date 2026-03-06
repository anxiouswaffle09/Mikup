# Language Reference: Rust 1.86 (Stable)

Updated as of: March 2, 2026

## 1. Syntax & Core Type Reference
*(... See previous version for Traits/Iterators ...)*

---

## 2. 🚫 Anti-AI Slop (Rust 2024 Edition)
The 2024 Edition (v1.86+) eliminates many common boilerplate patterns. AI models often generate pre-2024 "slop."

**Environment Note:** Codebase, Agents, and Runtime are native to WSL2 (Linux).

| Legacy/Slop Pattern | Modern Standard (2026) | Why? |
| :--- | :--- | :--- |
| `lazy_static!` / `once_cell` | **`std::sync::LazyLock`** | Native `std` support; zero dependencies; `const` compatible. |
| `|| async { ... }` | **`async || { ... }`** | Native **Async Closures** allow borrowing from captures. |
| `match opt { Some(x) => x, _ => return }` | **`let Some(x) = opt else { return };`** | **let-else** reduces nesting and improves readability. |
| `#[async_trait]` crate | **Native `async fn` in Trait** | Native support since 1.75; less macro overhead. |
| `match opt { ... }` cascades | **`get_disjoint_mut`** | Simultaneous mutable access to slices (safe multi-element edit). |
| `&Arc<T>` in closures | **Disjoint Captures** | Rust 2024 captures only specific fields, reducing `clone()` spam. |

---

## 3. Wait-Free Sync (`rtrb` Standard)
```rust
use rtrb::RingBuffer;

let (mut producer, mut consumer) = RingBuffer::new(2);
// Producer on Audio Thread (Wait-Free)
producer.push(playhead_ms).unwrap_or_default();
```

---

## 4. Best Practices for Mikup
1. **Zero Allocations**: No `Box`, `Vec`, or `String` in the audio callback.
2. **Atomic Playhead**: Use `AtomicU64` for sample-accurate time tracking between threads.
3. **Lazy Handles**: Use `LazyLock` for global audio device and engine state.
4. **Environment Safety**: `std::env::set_var` is `unsafe`; use sparingly with docs.
