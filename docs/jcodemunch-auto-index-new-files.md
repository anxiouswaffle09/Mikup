# jcodemunch: Auto-Index New Files

## Problem
Auto-refresh re-reads already-indexed files when they change — it does not discover new files. Any file added mid-session is invisible to jcm until someone manually calls `index_folder(incremental=true)`, which is easy to forget.

## Proposed Fix
Add a file-system watcher on watched directories that detects new files and triggers an incremental `index_folder` automatically. This closes the gap between:
- **Auto-refresh** — handles edits to existing indexed files
- **Auto-index** — would handle newly created files

## Expected Behavior
- New `.rs` / `.py` / `.ts` file created in a watched path → incremental index triggered automatically
- No manual `index_folder` call needed mid-session
- Existing cooldown/debounce logic can apply to avoid hammering on bulk file creation

## Current Workaround
Manually call `index_folder(path=<watched_dir>, incremental=true)` after adding new files mid-session.
