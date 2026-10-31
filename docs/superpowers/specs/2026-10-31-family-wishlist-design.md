# Family Wishlist Web Application — Design Specification

**Date:** 2026-10-31  
**Status:** Draft (Pending User Approval)

---

## 1. Intent and the Why

The user and their family rely on a shared wishlist workflow (especially around the holidays) modeled after *Things To Get Me*:
1. A family member creates a wishlist and adds items they want.
2. They share their wishlist link in the family's Facebook Messenger group chat.
3. Other family members open the link and **reserve** items they plan to buy.
4. Reserving an item removes it from the available list for other gift-buyers while keeping the reservation completely hidden from the wishlist's creator (spoiler-free).

**Why build this now:** *Things To Get Me*'s automatic URL product fetching has been broken for some time, forcing manual entry. The family needs a self-hosted replacement that preserves the simple, spoiler-free Messenger link-sharing and no-login guest reservation flow, while providing reliable product metadata fetching from Amazon and major big-box retailers (Walmart, Target, Best Buy, Kohl's, etc.) and running easily as a Docker container on an Unraid server.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Frictionless Wishlist Creation & Sharing:** Authenticated users can create wishlists, add/edit/delete items, and copy a clean shareable URL (with rich OpenGraph preview tags so links look great when pasted into Facebook Messenger).
- **Reliable Multi-Store URL Fetching:** Pasting a product URL automatically extracts **Name, Price, Photo(s), and Link**, plus **Color, Size, and Model** when present on the page, working across Amazon, Walmart, Target, Best Buy, Kohl's, and general e-commerce stores using OpenGraph / `schema.org/Product` JSON-LD / store-specific parsers / headless browser fallback.
- **One-Click *Things To Get Me* List Import:** Family members can paste their existing `thingstogetme.com/<code-or-url>` link to migrate their list in one step:
  - Parses the embedded `window.ttgmList` / `window.list` JSON payload from the *Things To Get Me* page.
  - **Skips already-received items** from past holidays (`item.received !== null`).
  - **Migrates active reservations** (`item.received === null && item.item_users.length > 0`) silently in the background without revealing them to the list creator.
  - **Auto-enriches missing details:** For imported items that have a product `url` but are missing an image, price, or variant details (due to *Things To Get Me*'s broken fetcher), automatically runs our multi-layer URL fetcher to fill in the missing photos and metadata.
  - Cleans up legacy *Things To Get Me* note artifacts (e.g., stripping `> medium, > Needs 1 has 0` boilerplate while preserving meaningful notes like `Size: 34x28` or `Dark Gray/Blue, Size 10.5` and mapping detected Size/Color into their structured fields).
- **Always-Editable Item Fields:** Every fetched field (Name, Price, Photo URL, Product Link, Color, Size, Model/Notes) is immediately editable before and after saving so users are never blocked if a store hides a variant or price.
- **No-Login Guest Viewing & Reserving:** Family members opening a shared link do **not** need an account or login to view the list or reserve items. If not signed in, clicking "Reserve" simply asks for their name (e.g., "Aunt Linda"). If signed in, their account display name is pre-filled.
- **Spoiler-Free Creator View vs. Two-Tab Visitor View:**
  - **Creator View:** When the owner views their own list, they see all items they added (with Edit/Delete controls) and **zero indication** of which items are reserved or who reserved them.
  - **Visitor View:** Anyone else viewing the list (guest or another signed-in family member) sees two tabs:
    - **Available Tab:** Unreserved items with a "Reserve" action and direct link to the store.
    - **Reserved Tab:** Reserved items moved out of the main view to avoid visual clutter, showing who reserved each item (`Reserved by <Name>`) and an **Unreserve** button in case plans change or an item was reserved by mistake.
- **OAuth Authentication:** Support signing in via **Google**, **Facebook**, and **Login with Amazon** (plus a configurable local/passphrase fallback so the admin can use/test the app immediately on LAN before or alongside configuring external OAuth developer apps).
- **Eye-Friendly Dark UI:** Dark theme by default (`#0f172a` / `#1e293b` surfaces and input boxes with `#f8fafc` crisp white/light text—never blinding white textboxes on dark backgrounds).
- **Turnkey Unraid Docker Deployment:** Single self-contained Docker container with SQLite persistence in a single `/data` volume mount, `docker-compose.yml`, `.env.example`, and an Unraid Community Applications XML template (`unraid-template.xml`).

### Non-Goals
- **In-app payment processing or checkout:** Gift-buyers click through to the retailer (Amazon, Target, etc.) to purchase the item themselves.
- **Complex social networking features:** No friend-request graphs, activity feeds, or messaging inside the app—sharing happens via links in Facebook Messenger.
- **Price history tracking or stock alerts:** Prices are captured at fetch/edit time for gift-buyer reference, not continuously polled in the background.

### Anti-Goals (What Would Make This a Failure Even If It Works)
- **Requiring gift-buyers to create an account or log in just to view a list or reserve an item.** (Must work immediately for guests via link + typing their name.)
- **Leaking reservation status to the list creator** (whether in the UI, page title, item ordering, or API response returned to the list owner).
- **Hard-failing item creation when URL scraping is blocked.** If a retailer blocks automated fetching, the UI must gracefully let the user fill in or adjust fields manually (and provide a browser bookmarklet helper as a backup).
- **Unreadable UI contrast** such as dark text on dark inputs or harsh white input boxes inside a dark theme.

---

## 3. Constraints

- **Hosting Environment:** Self-hosted on the user's Unraid server via Docker.
- **Single-Container Simplicity:** Should not require external database containers (Redis, Postgres, etc.) to run; all persistent state lives in `/data` (SQLite database + any cached images/session state).
- **Network / Reverse Proxy Compatibility:** Must work both on local LAN (`http://<unraid-ip>:<port>`) and behind a reverse proxy (`https://wishlist.example.com`) with configurable `APP_URL` / `TRUST_PROXY` for OAuth callback URLs and Messenger share links.

---

## 4. User-Decided Design & Behavior

1. **Authentication Providers:**
   - OAuth 2.0 login supporting **Google**, **Facebook**, and **Amazon** ("Login with Amazon").
   - Login is only required to **create and manage** wishlists.
2. **Product Metadata & URL Fetching:**
   - Fields captured per item: **Name**, **Price**, **Photo**, **Link**, and optional **Color**, **Size**, **Model / Notes**.
   - Target stores: Amazon primarily, plus big-box stores including Walmart, Target, Best Buy, Kohl's, and general retail sites.
3. **Sharing & Reservation Workflow:**
   - Each wishlist has a shareable URL (`https://<host>/w/<slug-or-id>`) suitable for pasting into Facebook Messenger.
   - Visitors without an account can view the list and reserve items by typing their name.
   - Visitors see two tabs: **Available** (active unreserved items) and **Reserved** (claimed items showing who reserved them + option to unreserve).
   - The wishlist creator never sees reservations.
4. **Visual Styling:**
   - Dark theme where form inputs and textboxes also have a dark background (`#0f172a`) with crisp white/light text (`#f8fafc`) and subtle borders (`#334155`).
5. ***Things To Get Me* List Migration (`thingstogetme.com` Import):**
   - Users can paste a *Things To Get Me* URL (e.g., `https://www.thingstogetme.com/902589a87070`) or list code (`902589a87070`) to import an existing list (either into a new wishlist named after `ttgmList.name` or into an existing wishlist).
   - **Skip Received Items:** Any item where `received !== null` (gifts received in past years) is automatically skipped.
   - **Migrate Active Reservations Spoiler-Free:** Any active item (`received === null`) with `item_users.length > 0` is imported with `is_reserved = true` (and `reserved_by_name = "Reserved (Imported)"` if *Things To Get Me* anonymized the visitor key) on the backend without exposing the reservation state to the importing list owner.
   - **Auto-Fetch Missing Details:** For any imported item that has a `url` but is missing its `image`, `price`, `color`, or `size` (such as recently added items affected by *Things To Get Me*'s broken scraper), the importer automatically runs the product URL fetcher to populate the missing photo and metadata.

---

## 5. Builder's Calls (Sensible Defaults Chosen by the Builder)

These architectural and UX details were delegated to the builder ("Sensible defaults are fine") and are documented here explicitly as the builder's calls:

1. **Tech Stack (Builder's Call):**
   - **Runtime & Backend:** Node.js 20+ with TypeScript and Express (or Fastify), serving both the JSON API, server-side OpenGraph meta tags for `/w/:slug` (so Facebook Messenger link previews show the wishlist title and owner's name), and the frontend SPA bundle.
   - **Database:** SQLite via `better-sqlite3` stored at `/data/wishlist.db` with automatic schema migrations on startup.
   - **Frontend:** React + TypeScript + Vite + Tailwind CSS (configured with the dark slate palette `#0f172a` / `#1e293b` and `#f8fafc` text).
2. **Multi-Layered URL Fetcher Architecture (Builder's Call):**
   - When the user pastes a URL into "Add Item" and clicks **Fetch** (or pastes a URL which auto-triggers fetch):
     - **Layer 1 — Store-Aware Structured Extraction:** Normalizes URLs (handling shortened `a.co` / `amzn.to` redirects) and parses HTML using `cheerio` for:
       - `application/ld+json` (`Product`, `AggregateOffer`, `Offers`, `color`, `size`, `model`, `sku`, `image`)
       - Embedded store state blobs (`__NEXT_DATA__` on Target/Walmart, Amazon `#productTitle`, `#corePriceDisplay_desktop_feature_div`, `#landingImage`, `#variation_color_name`, `#variation_size_name`, `#twister`, meta `og:title`, `og:image`, `product:price:amount`)
       - Target RedSky product API / Best Buy / Kohl's JSON-LD & OpenGraph fallbacks.
     - **Layer 2 — Headless Browser Fallback:** If Layer 1 receives a bot challenge (403/503/CAPTCHA shell) or missing core fields, falls back to headless Chromium (`playwright-core` bundled in the Docker image) with stealth headers to render the DOM and extract product details.
     - **Layer 3 — Browser Bookmarklet ("+ Add to Wishlist") & Manual Edit:** Includes a draggable "+ Add to Wishlist" bookmarklet on the user's dashboard that reads the current store tab's DOM directly in the user's own browser and opens the wishlist Add Item modal pre-populated. All fields remain manually editable at any time.
3. **OAuth Configuration + Zero-Config Local Auth Fallback (Builder's Call):**
   - OAuth providers (Google, Facebook, Amazon) are enabled automatically whenever their respective `GOOGLE_CLIENT_ID`, `FACEBOOK_CLIENT_ID`, or `AMAZON_CLIENT_ID` environment variables are provided (or configured in an Admin Settings screen stored in `/data`).
   - Because setting up developer apps on Facebook, Google, and Amazon takes time, the app also supports a built-in **Email + Password / Quick Family Sign-In** mode out of the box so the family can start creating lists immediately after spinning up the container on Unraid.
4. **How the App Distinguishes Creator vs. Visitor on `/w/:slug` (Builder's Call):**
   - If the currently logged-in user is the owner of `/w/:slug`, the API strips `reserved`, `reserved_by`, and `reserved_at` fields at the server serialization layer before sending the response, and the UI renders the **Creator View** (Add Item button, Edit/Delete item buttons, Share Link button, no Available/Reserved tabs).
   - Provide a "Preview as Visitor" info banner explaining that reservations are hidden from them; even if the owner logs out or opens an incognito window to look at `/w/:slug`, a polite "Are you <Owner Name>? Don't peek at your own list!" warning banner or toggle protects against accidental spoilers while allowing guests to click straight through.
5. **Multiple Wishlists & Family Directory (Builder's Call):**
   - Each signed-in user gets a default wishlist automatically (e.g., "<Name>'s Holiday Wishlist") and can create additional lists if desired (e.g., "Birthday", "Kids' List").
   - In addition to individual share links (`/w/:slug`), a public `/family` directory page lists all shared family wishlists in one place so family members can bookmark a single page for the whole family if they want.
6. **Guest Name Memory (Builder's Call):**
   - When a guest types their name (e.g., "Aunt Linda") to reserve an item, the browser saves that name in `localStorage` so if they reserve a second item on the same or another family member's list, their name is already pre-filled.

---

## 6. Data Model Overview (Left to Builder to Refine)

- **`users`**: `id`, `email`, `display_name`, `avatar_url`, `password_hash` (nullable), `created_at`
- **`oauth_accounts`**: `id`, `user_id`, `provider` (`google` | `facebook` | `amazon`), `provider_account_id`, `created_at`
- **`wishlists`**: `id`, `user_id`, `slug` (unique URL-friendly slug), `title`, `description`, `is_public` (default true), `created_at`, `updated_at`
- **`wishlist_items`**:
  - `id`, `wishlist_id`
  - `name` (required)
  - `url` (nullable)
  - `price` (nullable string/formatted price, e.g., `$349.99`)
  - `image_url` (nullable)
  - `color` (nullable)
  - `size` (nullable)
  - `model` (nullable / notes)
  - `priority` / `sort_order`
  - `is_reserved` (boolean, default false)
  - `reserved_by_name` (nullable string)
  - `reserved_by_user_id` (nullable FK)
  - `reserved_at` (nullable timestamp)
  - `created_at`, `updated_at`
