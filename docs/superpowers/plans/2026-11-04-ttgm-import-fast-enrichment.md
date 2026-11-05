# Things To Get Me Fast Import, Deduplication & Gentle Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Things To Get Me (TTGM) wishlist importer into a fast, duplicate-proof, two-phase process: instant import with TTGM images saved directly as SQLite BLOBs, deduplication against existing database items, rate-limited Browserless scraping, and a gentle post-import background enrichment queue.

**Architecture:** 
1. **Deduplication & Unlimited Cap:** Parse and deduplicate raw items by key/URL/name, remove the arbitrary 250-item limit, and perform upsert checks against existing wishlist items in SQLite so repeated imports never create duplicate rows.
2. **Direct TTGM Image Ingestion:** Treat TTGM CDN images as primary rather than falling back to store scraping; directly fetch image bytes and cache them as SQLite BLOBs during import.
3. **Deferred Enrichment Queue (`needs_enrichment`):** Fast import inserts items immediately with existing TTGM metadata and marks items missing prices or images as `needs_enrichment = 1`. An asynchronous post-import worker enriches queued items sequentially with Browserless rate-limiting (pacing delay, single-session concurrency) and unconditionally clears `needs_enrichment = 0` upon completion or error.

**Tech Stack:** Node.js, TypeScript, SQLite (`better-sqlite3`), Vitest, Express.

**Spec:** User requirements from chat session:
1. Update import logic to handle deduplication.
2. If an item has an image linking to TTGM, grab the image and import it as a BLOB into our DB directly.
3. Do not enrich unless an item absolutely needs it; import everything first, then queue items needing enrichment (`needs_enrichment` flag) and execute gently post-import, clearing the flag even if enrichment is not 100% successful.
4. Give Browserless breathing room with gentle pacing and rate limiting.
5. Remove or raise the 250-item cap on TTGM import.

## Global Constraints

- **Spoiler-Free:** Wishlist owner must never see reservation state when viewing their list or receiving the import summary.
- **SSRF Safety:** All outbound URLs (including TTGM image downloads) must pass through `validateSafeExternalUrl()` and DNS rebinding protections.
- **Zero Regression:** All existing 48 unit, integration, and security tests must remain green.

## Review Focus

1. **Repeated Import Duplication:** Re-importing the same TTGM list URL twice must not double the item count; existing items must be matched by URL (or name) and updated in-place without overwriting active reservations.
2. **Image Hotlink Protection:** TTGM image URLs must not be discarded; their image bytes must be fetched and stored as SQLite BLOBs, served from `/api/items/:id/image`.
3. **Browserless Flooding Prevention:** Browserless calls must never run in unmetered parallel batches; a concurrency lock and minimum pacing delay (>= 1000ms) must protect Browserless from 429 rate limits.
4. **Enrichment Failure Tolerance:** If post-import enrichment encounters a 403, 429, or network error, `needs_enrichment` must be reset to `0` so the queue never gets stuck.
5. **Full List Ingestion:** A 600+ item wishlist must not be truncated by a 250-item cap.

---

### Task 1: Database Schema & Methods for Deduplication, Upsert, and `needs_enrichment`

**Files:**
- Modify: `src/server/db.ts`
- Modify: `src/shared/types.ts`
- Test: `tests/db.test.ts`

- [ ] **Step 1: Write failing test in `tests/db.test.ts` for deduplication/upsert and `needs_enrichment` flag**
  - Add tests verifying:
    - Adding an item with `needs_enrichment: true` sets `needs_enrichment = 1` in SQLite.
    - `findItemByUrl(wishlistId, url)` and `findItemByName(wishlistId, name)` return existing items.
    - `upsertItem(wishlistId, itemInput)` updates existing matching items without changing `id` or overwriting `is_reserved = 1`.
    - `getPendingEnrichmentItems(wishlistId?)` retrieves items with `needs_enrichment = 1`.
    - `clearNeedsEnrichment(itemId)` sets `needs_enrichment = 0`.
    - `clearWishlistItems(wishlistId)` deletes all items for a given wishlist.

- [ ] **Step 2: Run test to confirm it fails**
  - Run `npx vitest run tests/db.test.ts` and verify test failure.

- [ ] **Step 3: Update `src/shared/types.ts` and `src/server/db.ts`**
  - Add `needs_enrichment?: boolean` to `WishlistItem` and `WishlistItemInput`.
  - Add `needs_enrichment INTEGER NOT NULL DEFAULT 0` column to `wishlist_items` via `PRAGMA table_info` migration check.
  - Implement `findItemByUrl`, `findItemByName`, `upsertItem`, `getPendingEnrichmentItems`, `clearNeedsEnrichment`, and `clearWishlistItems`.

- [ ] **Step 4: Run test to verify it passes**
  - Run `npx vitest run tests/db.test.ts` and ensure all tests pass.

- [ ] **Step 5: Commit changes**
  - `git commit -am "feat(db): add needs_enrichment column, item upsert, and lookup helpers"`

---

### Task 2: Pacing & Concurrency Limiting for Browserless in `fetcher.ts`

**Files:**
- Modify: `src/server/fetcher.ts`
- Test: `tests/fetcher.test.ts`

- [ ] **Step 1: Write test in `tests/fetcher.test.ts` verifying Browserless rate-limiting / serialization**
  - Test that rapid consecutive Browserless calls are sequenced with pacing delay rather than flooding concurrently.

- [ ] **Step 2: Run test to confirm it fails or needs implementation**
  - Run `npx vitest run tests/fetcher.test.ts`.

- [ ] **Step 3: Implement concurrency serialization and spacing in `src/server/fetcher.ts`**
  - Add a serialized queue / mutex (`browserlessLock`) and a minimum pacing delay (`BROWSERLESS_MIN_INTERVAL_MS = 1000`) before triggering `fetchViaBrowserless`.
  - Handle HTTP 429 from Browserless with a graceful backoff log and fallback to partial metadata instead of throwing.

- [ ] **Step 4: Run test to verify it passes**
  - Run `npx vitest run tests/fetcher.test.ts`.

- [ ] **Step 5: Commit changes**
  - `git commit -am "feat(fetcher): serialize Browserless requests with pacing delay to prevent 429 rate limits"`

---

### Task 3: Refactor TTGM Importer to Fast Direct Ingestion & Deduplication

**Files:**
- Modify: `src/server/ttgm-importer.ts`
- Test: `tests/ttgm-importer.test.ts`

- [ ] **Step 1: Write failing tests in `tests/ttgm-importer.test.ts`**
  - Add test verifying TTGM image URLs are directly downloaded as BLOBs without calling `enrich()`.
  - Add test verifying repeated import does not create duplicate items (deduplication by key/URL/name).
  - Add test verifying lists larger than 250 items import completely.
  - Add test verifying items missing price or image are flagged with `needs_enrichment = true`.

- [ ] **Step 2: Run test to confirm failure**
  - Run `npx vitest run tests/ttgm-importer.test.ts`.

- [ ] **Step 3: Implement fast import in `src/server/ttgm-importer.ts`**
  - Remove/raise `MAX_TTGM_IMPORT_ITEMS` from 250 to 5000.
  - In `parseTtgmHtml`: Deduplicate raw items by `key` (and `url`/`name`).
  - In `importTtgmList`:
    - Recognize TTGM image URLs (`thingstogetme.com/public/images/...`) as valid primary images, resolve relative URLs, and download via `downloadImageBlob`.
    - Do NOT call `enrich()` inside the import loop.
    - Check if item is missing price or image (and has a valid `itemUrl`); if so, mark `needs_enrichment = true`.
    - Upsert items using DB deduplication helper (`db.upsertItem`) to prevent duplicates on repeated runs while preserving reservations.

- [ ] **Step 4: Run test to verify it passes**
  - Run `npx vitest run tests/ttgm-importer.test.ts`.

- [ ] **Step 5: Commit changes**
  - `git commit -am "feat(ttgm-importer): direct TTGM image blob ingestion, deduplication, and removal of 250-item cap"`

---

### Task 4: Post-Import Background Enrichment Worker & API Integration

**Files:**
- Create/Modify: `src/server/enrichment-worker.ts`
- Modify: `src/server/app.ts`
- Test: `tests/api.test.ts`

- [ ] **Step 1: Write test in `tests/api.test.ts` for TTGM import response speed and deferred enrichment**
  - Test that `POST /api/wishlists/:slug/import-ttgm` returns immediately without waiting for slow external store scraping.
  - Test that items marked with `needs_enrichment = 1` are processed and their flag is cleared even if enrichment fails.
  - Test `DELETE /api/wishlists/:slug/items` clears all items from the wishlist.

- [ ] **Step 2: Run test to confirm failure**
  - Run `npx vitest run tests/api.test.ts`.

- [ ] **Step 3: Implement background enrichment worker and API routes**
  - Create `processPendingEnrichments(db, wishlistId, options)` that iterates queued items gently (1 by 1, with pacing delay) and clears `needs_enrichment = 0` unconditionally upon finishing each item.
  - Trigger `processPendingEnrichments` asynchronously right after `importTtgmList` finishes.
  - Add `DELETE /api/wishlists/:slug/items` endpoint to allow owners to wipe all items from a list cleanly.

- [ ] **Step 4: Run full test suite to verify everything passes**
  - Run `npm test`.

- [ ] **Step 5: Commit changes**
  - `git commit -am "feat(api): add background enrichment queue and clear-items endpoint"`
