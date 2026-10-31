export interface User {
  id: number;
  email: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
}

export interface Wishlist {
  id: number;
  user_id: number;
  owner_name: string;
  slug: string;
  title: string;
  description: string;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

export interface WishlistItem {
  id: number;
  wishlist_id: number;
  name: string;
  url: string | null;
  price: string | null;
  image_url: string | null;
  color: string | null;
  size: string | null;
  model: string | null;
  priority: number;
  is_reserved: boolean;
  reserved_by_name: string | null;
  reserved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WishlistViewResponse {
  wishlist: Wishlist;
  is_owner: boolean;
  items: WishlistItem[];
}

export interface FetchedProductMetadata {
  url: string;
  name: string;
  price: string | null;
  image_url: string | null;
  color: string | null;
  size: string | null;
  model: string | null;
  store_name: string | null;
  partial: boolean;
}

export interface TtgmImportSummary {
  imported_count: number;
  skipped_received_count: number;
  enriched_count: number;
  items: WishlistItem[];
}
