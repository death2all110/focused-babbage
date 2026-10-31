# Family Wishlist

A self-hosted, spoiler-free family wishlist web application built for Unraid & Docker, designed as a modern replacement for *Things To Get Me*.

## Key Features

- **Multi-Store Product URL Fetcher:** Paste product links from **Amazon, Target, Walmart, Best Buy, Kohl's, Harbor Freight, GameStop**, and general online stores to automatically fill in **Name, Price, Photo, Link, Color, Size, and Model/Notes**. Every field remains editable.
- **One-Click *Things To Get Me* List Importer:** Paste any `https://www.thingstogetme.com/<code>` link or code to migrate an existing list:
  - Skips gifts already marked `received` in past years.
  - Migrates active reservations spoiler-free in the background without revealing them to the list owner.
  - Automatically runs the product URL fetcher on imported items that are missing product photos or prices.
  - Cleans legacy Amazon-import note boilerplate while extracting Size & Color.
- **No-Login Guest Reservations with Separate Tabs:** Family members opening a link shared in Facebook Messenger do **not** need to log in to view the list or reserve an item—they just type their name. Visitors see two tabs (**Available** and **Reserved**) to keep the active list clutter-free while still allowing visitors to check who claimed an item or unreserve it if plans change.
- **Spoiler-Free Creator View:** When the list owner views their own list, reservation data is stripped at the API level and the Reserved tab is hidden.
- **OAuth 2.0 + Local Auth:** Supports **Google**, **Facebook**, and **Login with Amazon** OAuth 2.0 alongside built-in email/password accounts.
- **Eye-Friendly Dark UI:** Dark slate surfaces (`#0f172a` / `#020617`) with dark input boxes and crisp light text (`#f8fafc`).

---

## Deploying on Unraid

### Option A: Docker Compose (Unraid Compose Manager or SSH)

1. Copy this repository to your Unraid server (e.g., `/mnt/user/appdata/family-wishlist-src`).
2. Copy `.env.example` to `.env` and set `APP_URL` and `SESSION_SECRET`.
3. Build and start the container:
   ```bash
   docker compose up -d --build
   ```
   All SQLite database files are persisted in `/mnt/user/appdata/family-wishlist` (mounted to `/data` inside the container).

### Option B: Unraid Docker UI Template

1. Build the image on your Unraid server:
   ```bash
   docker build -t family-wishlist:latest .
   ```
2. Copy `unraid-template.xml` to `/boot/config/plugins/dockerMan/templates-user/my-family-wishlist.xml`.
3. In the Unraid WebGUI, go to **Docker -> Add Container**, select **family-wishlist** from your User Templates, and click **Apply**.

---

## Configuring OAuth Providers (Optional)

Email/password registration works immediately out of the box. To enable OAuth sign-in buttons, configure any of the following environment variables and set their callback URLs in each provider's developer console:

- **Google:**
  - Callback URL: `<APP_URL>/api/auth/oauth/google/callback`
  - Variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- **Facebook:**
  - Callback URL: `<APP_URL>/api/auth/oauth/facebook/callback`
  - Variables: `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`
- **Login with Amazon:**
  - Allowed Return URL: `<APP_URL>/api/auth/oauth/amazon/callback`
  - Variables: `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`
