import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type {
  FavoriteProduct,
  PublicProductSummary,
  PublicProductDetail,
} from "@/types/catalog";

const GENERIC_ERROR = "Unable to load the catalog. Please try again.";

export interface CatalogResult<T> {
  data: T;
  error?: string;
  totalCount?: number;
}

export type CatalogSort =
  | "featured"
  | "newest"
  | "name_asc"
  | "name_desc"
  | "credits_asc"
  | "credits_desc";

/**
 * Fetch public-safe product summaries for the consumer catalog.
 *
 * Uses a SECURITY DEFINER RPC that exposes only public metadata, the active
 * version number, credit cost, and public asset references. Private recipe
 * columns are never returned.
 */
export async function getPublicProducts(
  type?: "filter" | "poster",
  categorySlug?: string,
  productIds?: string[],
  search?: string,
  sort: CatalogSort = "featured",
  page = 1,
  pageSize = 24
): Promise<CatalogResult<PublicProductSummary[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_public_catalog", {
    p_type: type ?? null,
    p_category_slug: categorySlug ?? null,
    p_product_ids: productIds?.length ? productIds : null,
    p_search: search?.trim() || null,
    p_sort: sort,
    p_page: page,
    p_page_size: pageSize,
  });

  if (error) {
    console.error("[getPublicProducts] catalog RPC failed", error);
    return { data: [], error: GENERIC_ERROR };
  }

  const typedData = (data ?? []) as (PublicProductSummary & { total_count?: number })[];
  const totalCount = typedData.length > 0 ? (typedData[0].total_count ?? 0) : 0;
  const products = typedData.map(({ id, slug, name, type, short_description, long_description, category_id, category_slug, category_name, featured_rank, version_id, version_number, credit_cost, output_sizes, metadata, hero_asset_id, poster_asset_id, preview_gif_asset_id, preview_video_asset_id, public_assets, created_at, likeness_level }) => ({ id, slug, name, type, short_description, long_description, category_id, category_slug, category_name, featured_rank, version_id: version_id ?? null, version_number, credit_cost: Number(credit_cost), output_sizes: Array.isArray(output_sizes) ? output_sizes : [], metadata, hero_asset_id, poster_asset_id, preview_gif_asset_id, preview_video_asset_id, public_assets, created_at: created_at ?? null, likeness_level: likeness_level ?? null }));

  return { data: products as PublicProductSummary[], totalCount };
}

export async function getPublicProductBySlug(
  slug: string
): Promise<CatalogResult<PublicProductDetail | null>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_public_product_by_slug", {
    p_slug: slug,
  });

  if (error) {
    console.error("[getPublicProductBySlug] detail RPC failed", error);
    return { data: null, error: GENERIC_ERROR };
  }

  const rows = (data ?? []) as PublicProductDetail[];
  if (rows.length === 0) {
    return { data: null };
  }

  const row = rows[0];
  return {
    data: {
      ...row,
      version_id: row.version_id ?? null,
      credit_cost: Number(row.credit_cost),
      output_sizes: Array.isArray(row.output_sizes) ? row.output_sizes : [],
    } as PublicProductDetail,
  };
}

export async function getPublicAssetUrl(
  bucket: string,
  storageKey: string
): Promise<string | null> {
  const supabase = await createClient();
  const { data } = supabase.storage.from(bucket).getPublicUrl(storageKey);
  return data?.publicUrl ?? null;
}

/**
 * Return the product IDs favorited by the currently authenticated user.
 * Returns an empty set when anonymous or on error.
 */
export async function getActiveCategories(): Promise<
  { slug: string; name: string }[]
> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("categories")
    .select("slug, name")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("[getActiveCategories] categories query failed", error);
    return [];
  }

  return (data ?? []) as { slug: string; name: string }[];
}

/**
 * Favorited products for the signed-in user, including presets that have
 * since been retired or hidden. Rows arrive sorted by most recently saved.
 */
export async function getUserFavoriteProducts(): Promise<
  CatalogResult<FavoriteProduct[]>
> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_user_favorite_products");

  if (error) {
    console.error("[getUserFavoriteProducts] RPC failed", error);
    return { data: [], error: GENERIC_ERROR };
  }

  const rows = (data ?? []) as (PublicProductSummary & {
    is_available?: boolean;
    favorited_at?: string;
  })[];

  return {
    data: rows.map(
      ({ is_available, favorited_at, credit_cost, output_sizes, ...rest }) => ({
        product: {
          ...rest,
          credit_cost: Number(credit_cost),
          output_sizes: Array.isArray(output_sizes) ? output_sizes : [],
          created_at: rest.created_at ?? null,
          likeness_level: rest.likeness_level ?? null,
        } as PublicProductSummary,
        isAvailable: is_available === true,
        favoritedAt: favorited_at ?? "",
      })
    ),
  };
}

export async function getUserFavoriteProductIds(): Promise<string[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from("favorites")
    .select("product_id")
    .eq("user_id", user.id);

  if (error) {
    console.error("[getUserFavoriteProductIds] favorites query failed", error);
    return [];
  }

  return (data ?? []).map((row) => row.product_id);
}

export interface CatalogCostProfile {
  /** Median credit cost of a Filter transformation across the catalogue. */
  filterCost: number;
  /** Median credit cost of a Poster generation (image + layout render). */
  posterCost: number;
}

const FALLBACK_FILTER_COST = 6;
const FALLBACK_POSTER_COST = 12;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

/**
 * Median credit cost per product type — powers the pricing plan-finder's
 * "≈ N credits each" labels and monthly estimate. Falls back to fixed
 * defaults when the catalogue is empty.
 */
export const getCatalogCostProfile = cache(async function getCatalogCostProfile(): Promise<CatalogCostProfile> {
  const { data } = await getPublicProducts(
    undefined,
    undefined,
    undefined,
    undefined,
    "featured",
    1,
    200
  );
  const costs = (data ?? [])
    .filter((p) => typeof p.credit_cost === "number" && p.credit_cost > 0);
  const filters = costs.filter((p) => p.type === "filter").map((p) => p.credit_cost);
  const posters = costs.filter((p) => p.type === "poster").map((p) => p.credit_cost);
  return {
    filterCost: median(filters) ?? FALLBACK_FILTER_COST,
    posterCost: median(posters) ?? FALLBACK_POSTER_COST,
  };
});
