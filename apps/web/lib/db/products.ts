"use server";

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { ProductCreateInput, VersionInputCapability } from "@5pixels/shared";
import type { PublicProductDetail } from "@/types/catalog";
import { coerceCreditCost } from "@/lib/admin/coerce";
import { logAdminAction } from "./audit";
import { requireAdminOrOwner } from "./admin";
import {
  publishProductVersionSchema,
  rollbackProductVersionSchema,
  productStatusTransitionSchema,
} from "@/lib/validation/admin-actions";
import {
  validateCapabilityForRoute,
  validateFamilyAssignment,
  type ParentCandidate,
} from "@/lib/validation/preset-family";
import {
  getProviderEndpoint,
  type ProviderStrategy,
} from "@/lib/ai/provider-routing";
import { getRouteCapability } from "@/lib/ai/route-capabilities";
import { assertVersionQuotable } from "@/lib/validation/route-publish-check";
import { isFamilySchemaUnavailableError } from "./schema-errors";
import { isUserPromptReleased } from "@/lib/generation/user-prompt";
import { isMultiInputReleased } from "@/lib/generation/release-gates";

const REFERENCE_ASSET_ROLES = [
  "style_reference",
  "composition_reference",
  "layout_reference",
] as const;

type FamilyParentRow = ParentCandidate | null;

async function getFamilyParentRow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  parentId: string
): Promise<FamilyParentRow> {
  const { data } = await supabase
    .from("products")
    .select("id, type, public_status, parent_preset_id")
    .eq("id", parentId)
    .maybeSingle();
  return (data as FamilyParentRow) ?? null;
}

async function getChildCount(
  supabase: Awaited<ReturnType<typeof createClient>>,
  productId: string
): Promise<number> {
  const { count } = await supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("parent_preset_id", productId);
  return count ?? 0;
}

async function getAdminReferenceCount(
  supabase: Awaited<ReturnType<typeof createClient>>,
  productId: string
): Promise<number> {
  const { count } = await supabase
    .from("product_assets")
    .select("id", { count: "exact", head: true })
    .eq("product_id", productId)
    .in("role", [...REFERENCE_ASSET_ROLES]);
  return count ?? 0;
}

/**
 * Server enforcement for family assignment + route capability — identical
 * rules to the form-side helpers, so an admin cannot bypass them through a
 * direct request. Throws with actionable messages; never silently rewrites
 * the declared configuration.
 */
async function assertProductConfigAllowed(
  supabase: Awaited<ReturnType<typeof createClient>>,
  input: ProductCreateInput,
  opts: { productId?: string }
): Promise<void> {
  const strategy = input.version.provider_strategy;

  let parent: FamilyParentRow = null;
  if (input.parent_preset_id) {
    parent = await getFamilyParentRow(supabase, input.parent_preset_id);
  }
  const hasChildren = opts.productId
    ? (await getChildCount(supabase, opts.productId)) > 0
    : false;

  const familyErrors = validateFamilyAssignment({
    productId: opts.productId,
    type: input.type,
    parentPresetId: input.parent_preset_id ?? null,
    hasChildren,
    parent,
  });
  if (familyErrors.length > 0) {
    throw new Error(familyErrors.join(" "));
  }

  const adminReferenceCount = opts.productId
    ? await getAdminReferenceCount(supabase, opts.productId)
    : 0;
  const capabilityErrors = validateCapabilityForRoute({
    capability: input.version.input_capability,
    routeCapability: getRouteCapability(
      strategy.primary_provider,
      strategy.primary_model
    ),
    endpoint: getProviderEndpoint(strategy),
    adminReferenceCount,
  });
  if (capabilityErrors.length > 0) {
    throw new Error(capabilityErrors.join(" "));
  }
}

function versionRowToCapability(row: Record<string, unknown>): VersionInputCapability {
  return {
    input_mode: (row.input_mode as "single" | "multi") ?? "single",
    input_min_images: Number(row.input_min_images ?? 1),
    input_max_images: Number(row.input_max_images ?? 1),
    input_image_roles: Array.isArray(row.input_image_roles)
      ? (row.input_image_roles as VersionInputCapability["input_image_roles"])
      : [],
    prompt_override_enabled: Boolean(row.prompt_override_enabled),
    prompt_max_chars: Number(row.prompt_max_chars ?? 0),
  };
}

export async function getProducts(type: "filter" | "poster") {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .select(
      `id, slug, name, short_description, public_status, visibility, featured_rank, created_at, updated_at,
      product_versions(id, version_number, state, credit_cost, created_at)`
    )
    .eq("type", type)
    .order("updated_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function getProductById(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .select(
      `*,
      product_versions(*),
      product_fields(*)`
    )
    .eq("id", id)
    .single();

  if (error) throw error;
  return data;
}

export async function getProductAssetPreviews(
  assetIds: Array<string | null | undefined>
) {
  const ids = [...new Set(assetIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return {};

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("assets")
    .select("id, bucket, storage_key, mime_type, visibility")
    .in("id", ids)
    .eq("bucket", "preset-media")
    .eq("visibility", "public");
  if (error) throw error;

  return Object.fromEntries(
    (data ?? []).map((asset) => [
      asset.id,
      {
        publicUrl: supabase.storage
          .from(asset.bucket)
          .getPublicUrl(asset.storage_key).data.publicUrl,
        mimeType: asset.mime_type,
      },
    ])
  );
}

export async function createProduct(input: ProductCreateInput) {
  await requireAdminOrOwner();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const {
    version,
    fields,
    filter_config,
    poster_config,
    credit_cost,
    prompt_ui,
    ...productData
  } = input;

  await assertProductConfigAllowed(supabase, input, {});

  const { data: product, error: productError } = await supabase
    .from("products")
    .insert({
      ...productData,
      // A new product can never carry a published recipe — activation only
      // happens via publish_product_version/transition_product_status once
      // an active version exists (#233 activation guard).
      public_status: "draft",
      metadata: {
        filter_config,
        poster_config,
        prompt_ui,
      },
    })
    .select()
    .single();

  if (productError) throw productError;

  const { error: versionError } = await supabase
    .from("product_versions")
    .insert({
      product_id: product.id,
      version_number: version.version_number,
      state: "draft",
      private_instruction_template: version.private_instruction_template,
      private_negative_instruction: version.private_negative_instruction,
      provider_strategy: version.provider_strategy,
      model_config: version.model_config,
      output_sizes: version.output_sizes,
      input_validation_config: version.input_validation_config,
      input_mode: version.input_capability.input_mode,
      input_min_images: version.input_capability.input_min_images,
      input_max_images: version.input_capability.input_max_images,
      input_image_roles: version.input_capability.input_image_roles,
      prompt_override_enabled:
        version.input_capability.prompt_override_enabled,
      prompt_max_chars: version.input_capability.prompt_max_chars,
      post_process_config: version.post_process_config,
      safety_config: version.safety_config,
      credit_cost,
      created_by_admin_id: user.id,
    });

  if (versionError) throw versionError;

  if (fields.length > 0) {
    const { error: fieldsError } = await supabase.from("product_fields").insert(
      fields.map((field) => ({
        product_id: product.id,
        field_key: field.field_key,
        label: field.label,
        help_text: field.help_text,
        field_type: field.field_type,
        required: field.required,
        sort_order: field.sort_order,
        config: field.config,
        validation: field.validation,
        active: field.active,
      }))
    );
    if (fieldsError) throw fieldsError;
  }

  await logAdminAction({
    action: "product.create",
    entityType: "product",
    entityId: product.id,
    after: product,
  });

  return product;
}

export async function updateProduct(id: string, input: ProductCreateInput) {
  await requireAdminOrOwner();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const {
    version,
    fields,
    filter_config,
    poster_config,
    credit_cost,
    prompt_ui,
    ...productData
  } = input;

  await assertProductConfigAllowed(supabase, input, { productId: id });

  // Atomic save (#233): one RPC commits the products row, the editable
  // version (cloning a draft first if the source is active), and the field
  // replacement set. Any failure rolls back all three — a partial save can
  // no longer persist.
  const { error } = await supabase.rpc("admin_update_product", {
    p_product_id: id,
    p_product: {
      ...productData,
      metadata: {
        filter_config,
        poster_config,
        prompt_ui,
      },
    },
    p_source_version_id: version.id ?? null,
    p_version: version.id
      ? {
          private_instruction_template: version.private_instruction_template,
          private_negative_instruction: version.private_negative_instruction,
          provider_strategy: version.provider_strategy,
          model_config: version.model_config,
          output_sizes: version.output_sizes,
          input_validation_config: version.input_validation_config,
          input_mode: version.input_capability.input_mode,
          input_min_images: version.input_capability.input_min_images,
          input_max_images: version.input_capability.input_max_images,
          input_image_roles: version.input_capability.input_image_roles,
          prompt_override_enabled:
            version.input_capability.prompt_override_enabled,
          prompt_max_chars: version.input_capability.prompt_max_chars,
          post_process_config: version.post_process_config,
          safety_config: version.safety_config,
          credit_cost,
        }
      : null,
    p_fields: fields.map((field) => ({
      field_key: field.field_key,
      label: field.label,
      help_text: field.help_text,
      field_type: field.field_type,
      required: field.required,
      sort_order: field.sort_order,
      config: field.config,
      validation: field.validation,
      active: field.active,
    })),
  });

  if (error) throw error;

  return { id };
}

export async function publishProductVersion(
  productId: string,
  versionId: string,
  overrideReason?: string
) {
  await requireAdminOrOwner();
  const input = publishProductVersionSchema.parse({
    productId,
    versionId,
    overrideReason,
  });

  const supabase = await createClient();

  // Server-side publish gate (#177): family consistency, verified route
  // capability, and read-only quotability checks mirror the frontend gates —
  // the RPC cannot be reached with an unpublishable recipe, even by a
  // direct request. Read-only; creates no quote rows.
  const product = await getProductById(input.productId);
  const version = Array.isArray(product.product_versions)
    ? product.product_versions.find(
        (v: { id: string; state?: string }) => v.id === input.versionId
      )
    : null;
  if (!version) {
    throw new Error("Cannot publish: version not found on this product.");
  }

  const parent = product.parent_preset_id
    ? await getFamilyParentRow(supabase, product.parent_preset_id)
    : null;
  const familyErrors = validateFamilyAssignment({
    productId: input.productId,
    type: product.type,
    parentPresetId: product.parent_preset_id,
    hasChildren: false,
    parent,
  });
  if (familyErrors.length > 0) {
    throw new Error(`Cannot publish: ${familyErrors.join(" ")}`);
  }
  // A family-dependent variant is only reachable through its parent — refuse
  // to publish it into an orphaned state where no customer can reach it.
  if (
    product.parent_preset_id &&
    !product.standalone_discoverable &&
    parent &&
    parent.public_status !== "active"
  ) {
    throw new Error(
      "Cannot publish: this variant is only shown with its parent, which is not published. Publish the parent first or enable standalone discovery."
    );
  }

  const capability = versionRowToCapability(version);
  const capabilityErrors = validateCapabilityForRoute({
    capability,
    routeCapability: getRouteCapability(
      version.provider_strategy?.primary_provider,
      version.provider_strategy?.primary_model
    ),
    endpoint: getProviderEndpoint(
      version.provider_strategy as ProviderStrategy
    ),
    adminReferenceCount: await getAdminReferenceCount(supabase, input.productId),
  });
  if (capabilityErrors.length > 0) {
    throw new Error(`Cannot publish: ${capabilityErrors.join(" ")}`);
  }

  // Release readiness (#177): admins may prepare drafts, but a preset must
  // not publish capabilities the backend cannot execute.
  // - Multi-image: gated on the server-side release flag
  //   (PRESET_MULTI_INPUT_ENABLED) — OFF until #193 ships the provider
  //   pipeline + DB migration and release QA enables it. The
  //   create_generation RPC keeps rejecting >1 inputs regardless.
  // - Custom prompts: require the release flag (and the protected
  //   release_gates DB row, enforced inside the RPC) to be enabled —
  //   approval-gated by merchant/legal signoff (#183).
  if (
    (capability.input_mode === "multi" || capability.input_max_images > 1) &&
    !isMultiInputReleased()
  ) {
    throw new Error(
      "Cannot publish: multi-image inputs are gated off until the provider pipeline ships (#193) and PRESET_MULTI_INPUT_ENABLED is enabled."
    );
  }
  if (capability.prompt_override_enabled && !isUserPromptReleased()) {
    throw new Error(
      "Cannot publish: custom prompts are gated off until merchant/legal approval enables the protected preset_user_prompt release gates."
    );
  }

  await assertVersionQuotable(createServiceClient(), {
    provider_strategy: version.provider_strategy,
    model_config: version.model_config,
    output_sizes: version.output_sizes,
  });

  const { error } = await supabase.rpc("publish_product_version", {
    p_product_id: input.productId,
    p_version_id: input.versionId,
    p_override_reason: input.overrideReason ?? null,
  });

  if (error) throw error;
}

export async function rollbackProductVersion(
  productId: string,
  targetVersionId: string,
  reason?: string
) {
  await requireAdminOrOwner();
  const input = rollbackProductVersionSchema.parse({
    productId,
    targetVersionId,
    reason,
  });

  const supabase = await createClient();
  const { error } = await supabase.rpc("rollback_product_version", {
    p_product_id: input.productId,
    p_target_version_id: input.targetVersionId,
    p_reason: input.reason ?? null,
  });

  if (error) throw error;
}

export async function transitionProductStatus(
  productId: string,
  newStatus: string,
  reason?: string
) {
  await requireAdminOrOwner();
  const input = productStatusTransitionSchema.parse({
    productId,
    newStatus,
    reason,
  });

  const supabase = await createClient();
  const { error } = await supabase.rpc("transition_product_status", {
    p_product_id: input.productId,
    p_new_status: input.newStatus,
    p_reason: input.reason ?? null,
  });

  if (error) throw error;
}

export async function duplicateProduct(id: string) {
  await requireAdminOrOwner();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const original = await getProductById(id);
  if (!original) throw new Error("Product not found");

  // Atomic server-side copy (#233): the RPC selects the editable version
  // deterministically and inserts product + version + fields + asset links
  // in one transaction — any failure rolls back every write.
  const { data: product, error } = await supabase
    .rpc("admin_duplicate_product", {
      p_source_product_id: id,
      p_slug: `${original.slug}-copy-${Date.now()}`,
      p_name: `${original.name} (Copy)`,
      p_parent_product_id: null,
      p_variant_display_name: null,
    })
    .single();

  if (error) throw error;
  return product as { id: string };
}

/**
 * Select the version an admin should be editing: the current draft if one exists,
 * otherwise the active (published) version. Retired versions are only selectable
 * explicitly via rollback.
 */
export async function selectEditableVersion(
  versions: Array<{ id: string; state: string; version_number: number }>
) {
  const ordered = [...versions].sort((a, b) => {
    const stateRank = (state: string) =>
      ({ draft: 0, testing: 1, active: 2, retired: 3 })[state] ?? 4;
    const rankDiff = stateRank(a.state) - stateRank(b.state);
    if (rankDiff !== 0) return rankDiff;
    return b.version_number - a.version_number;
  });

  const draft = ordered.find((v) => v.state === "draft");
  if (draft) return draft;

  const testing = ordered.find((v) => v.state === "testing");
  if (testing) return testing;

  return ordered.find((v) => v.state === "active") ?? ordered[0] ?? null;
}

/**
 * Admin lab listing — every product regardless of status (drafts are the whole
 * point of the lab), with the editable version's credit cost for display.
 */
export async function getAdminLabProducts() {
  await requireAdminOrOwner();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .select(
      "id, slug, name, type, public_status, hero_asset_id, product_versions(id, state, version_number, credit_cost)"
    )
    .order("name", { ascending: true });
  if (error) throw error;

  return Promise.all(
    (data ?? []).map(async (product) => {
      const versions = Array.isArray(product.product_versions)
        ? (product.product_versions as Array<{
            id: string;
            state: string;
            version_number: number;
            credit_cost: unknown;
          }>)
        : [];
      const selected = await selectEditableVersion(
        versions.map((v) => ({
          id: v.id,
          state: v.state,
          version_number: v.version_number,
        }))
      );
      const version = versions.find((v) => v.id === selected?.id);
      return {
        id: product.id as string,
        slug: product.slug as string,
        name: product.name as string,
        type: product.type as "filter" | "poster",
        public_status: product.public_status as string,
        hero_asset_id: (product.hero_asset_id as string | null) ?? null,
        credit_cost: coerceCreditCost(version?.credit_cost) ?? 0,
      };
    })
  );
}

/**
 * Admin-gated product lookup by slug for the test lab. Unlike
 * `getPublicProductBySlug`, this returns drafts/testing versions too — the
 * lab exists to test presets *before* they're published. Shaped to
 * `PublicProductDetail` so `LabWorkspace` renders identically to the
 * consumer-facing detail data.
 */
export async function getAdminProductBySlug(slug: string) {
  await requireAdminOrOwner();

  const supabase = await createClient();
  const { data: product, error } = await supabase
    .from("products")
    .select(
      `*, categories(slug, name), product_versions(*), product_fields(*)`
    )
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw error;
  if (!product) return null;

  const versions = Array.isArray(product.product_versions)
    ? product.product_versions
    : [];
  const selected = await selectEditableVersion(
    versions.map((v: Record<string, unknown>) => ({
      id: String(v.id),
      state: String(v.state),
      version_number: Number(v.version_number),
    }))
  );
  const version = selected
    ? (versions.find(
        (v: Record<string, unknown>) => v.id === selected.id
      ) as Record<string, unknown> | undefined)
    : undefined;

  const fields = Array.isArray(product.product_fields)
    ? product.product_fields
    : [];

  const modelConfig =
    (version?.model_config as Record<string, unknown> | undefined) ?? {};
  const outputSizes = Array.isArray(version?.output_sizes)
    ? (version!.output_sizes as PublicProductDetail["output_sizes"])
    : modelConfig.width && modelConfig.height
      ? [
          {
            name: `${modelConfig.width}x${modelConfig.height}`,
            width: Number(modelConfig.width),
            height: Number(modelConfig.height),
            is_default: true,
          },
        ]
      : [];

  const category = Array.isArray(product.categories)
    ? product.categories[0]
    : product.categories;

  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    type: product.type,
    short_description: product.short_description ?? null,
    long_description: product.long_description ?? null,
    category_id: product.category_id ?? null,
    category_slug: category?.slug ?? null,
    category_name: category?.name ?? null,
    featured_rank: product.featured_rank ?? null,
    version_id: (version?.id as string | undefined) ?? null,
    version_number: (version?.version_number as number | undefined) ?? null,
    credit_cost: coerceCreditCost(version?.credit_cost) ?? 0,
    output_sizes: outputSizes,
    metadata:
      product.type === "filter"
        ? {
            filter_config:
              (product.metadata as Record<string, unknown> | null)
                ?.filter_config ?? {},
          }
        : product.type === "poster"
          ? {
              poster_config:
                (product.metadata as Record<string, unknown> | null)
                  ?.poster_config ?? {},
            }
          : {},
    hero_asset_id: product.hero_asset_id ?? null,
    poster_asset_id: product.poster_asset_id ?? null,
    preview_gif_asset_id: product.preview_gif_asset_id ?? null,
    preview_video_asset_id: product.preview_video_asset_id ?? null,
    public_assets: [],
    created_at: product.created_at ?? null,
    likeness_level: product.likeness_level ?? null,
    parent_preset_id: product.parent_preset_id ?? null,
    standalone_discoverable: product.standalone_discoverable ?? false,
    variant_count: 0,
    variant_display_name: product.variant_display_name ?? null,
    family_id: product.parent_preset_id ?? product.id,
    input_capability: version
      ? {
          mode: (version.input_mode as "single" | "multi") ?? "single",
          min_images: Number(version.input_min_images ?? 1),
          max_images: Number(version.input_max_images ?? 1),
          roles: Array.isArray(version.input_image_roles)
            ? (version.input_image_roles as { name: string; optional?: boolean }[])
            : [],
          prompt: {
            enabled: Boolean(version.prompt_override_enabled),
            max_chars: Number(version.prompt_max_chars ?? 0),
          },
        }
      : null,
    active_fields: fields
      .filter((f: { active: boolean | null }) => f.active !== false)
      .sort(
        (a: { sort_order: number | null }, b: { sort_order: number | null }) =>
          (a.sort_order ?? 0) - (b.sort_order ?? 0)
      )
      .map((f: Record<string, unknown>) => ({
        id: f.id,
        field_key: f.field_key,
        label: f.label,
        help_text: f.help_text ?? null,
        field_type: f.field_type,
        required: f.required ?? null,
        sort_order: f.sort_order ?? null,
        config: f.config ?? null,
        validation: f.validation ?? null,
      })),
  } as PublicProductDetail;
}

const REFERENCE_ROLES = [
  "style_reference",
  "composition_reference",
  "layout_reference",
] as const;

export async function attachReferenceAsset(input: {
  productId: string;
  assetId: string;
  role: string;
  internalOnly: boolean;
}) {
  await requireAdminOrOwner();
  if (!REFERENCE_ROLES.includes(input.role as (typeof REFERENCE_ROLES)[number])) {
    throw new Error("Invalid reference role");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("product_assets")
    .insert({
      product_id: input.productId,
      asset_id: input.assetId,
      role: input.role,
      internal_only: input.internalOnly,
      sort_order: 0,
    })
    .select("id, role, asset_id, sort_order, internal_only")
    .single();

  if (error) throw error;

  await logAdminAction({
    action: "product.attach_reference",
    entityType: "product",
    entityId: input.productId,
    after: { asset_id: input.assetId, role: input.role },
  });

  return data;
}

export async function detachReferenceAsset(productAssetId: string) {
  await requireAdminOrOwner();

  const supabase = await createClient();
  const { data: existing, error: findError } = await supabase
    .from("product_assets")
    .select("id, product_id, asset_id, role")
    .eq("id", productAssetId)
    .single();

  if (findError || !existing) throw new Error("Reference asset not found");

  const { error } = await supabase
    .from("product_assets")
    .delete()
    .eq("id", productAssetId);

  if (error) throw error;

  await logAdminAction({
    action: "product.detach_reference",
    entityType: "product",
    entityId: existing.product_id as string,
    before: existing,
  });
}

export async function getProductReferenceAssets(productId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("product_assets")
    .select(
      `id, role, asset_id, sort_order, internal_only,
      assets!inner(id, bucket, storage_key, mime_type, visibility)`
    )
    .eq("product_id", productId)
    .in("role", [...REFERENCE_ROLES])
    .order("sort_order", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => {
    const asset = row.assets as unknown as {
      id: string;
      bucket: string;
      storage_key: string;
      mime_type: string;
      visibility: string;
    };
    const publicUrl = supabase.storage
      .from(asset.bucket)
      .getPublicUrl(asset.storage_key).data.publicUrl;
    return {
      id: row.id as string,
      role: row.role as string,
      asset_id: row.asset_id as string,
      sort_order: row.sort_order as number,
      internal_only: row.internal_only as boolean,
      public_url: publicUrl,
      mime_type: asset.mime_type,
    };
  });
}

/* -------------------------------------------------------------------------
 * Preset family operations (#177) — single-level parent → children.
 * Server-enforced: a variant can never become a parent, children default to
 * family-dependent discovery, and every mutation is audited.
 * ---------------------------------------------------------------------- */

export interface EligibleParentPreset {
  id: string;
  slug: string;
  name: string;
  public_status: string;
  hero_asset_id: string | null;
}

/**
 * Root presets eligible to parent a new variant: same type, not retired, not
 * itself a variant, and not the product being edited.
 */
export interface EligibleParentPresetsResult {
  parents: EligibleParentPreset[];
  /** False when the preset-family contract is not deployed on this DB. */
  familySchemaAvailable: boolean;
}

export async function getEligibleParentPresets(
  type: "filter" | "poster",
  excludeProductId?: string
): Promise<EligibleParentPresetsResult> {
  await requireAdminOrOwner();
  const supabase = await createClient();

  let query = supabase
    .from("products")
    .select("id, slug, name, public_status, hero_asset_id")
    .eq("type", type)
    .is("parent_preset_id", null)
    .neq("public_status", "retired")
    .order("name", { ascending: true });
  if (excludeProductId) {
    query = query.neq("id", excludeProductId);
  }

  const { data, error } = await query;
  if (error) {
    if (isFamilySchemaUnavailableError(error)) {
      console.warn(
        "[admin] preset-family schema not deployed — parent picker unavailable:",
        error.message
      );
      return { parents: [], familySchemaAvailable: false };
    }
    throw error;
  }
  return {
    parents: (data ?? []) as EligibleParentPreset[],
    familySchemaAvailable: true,
  };
}

export interface PresetFamilyMember {
  id: string;
  slug: string;
  name: string;
  public_status: string;
  parent_preset_id: string | null;
  standalone_discoverable: boolean;
  variant_display_name: string | null;
  variant_sort_order: number;
  hero_asset_id: string | null;
}

export interface PresetFamily {
  root: PresetFamilyMember;
  /** Direct children ordered by admin-managed display order. */
  children: PresetFamilyMember[];
}

export interface PresetFamilyResult {
  family: PresetFamily | null;
  /** False when the preset-family contract is not deployed on this DB. */
  familySchemaAvailable: boolean;
}

/**
 * The family a product belongs to — itself when it's a root without
 * children. Admin-only; used by the edit page's family panel.
 */
export async function getPresetFamilyForAdmin(
  productId: string
): Promise<PresetFamilyResult> {
  await requireAdminOrOwner();
  const supabase = await createClient();

  const { data: self, error: selfError } = await supabase
    .from("products")
    .select(
      "id, slug, name, public_status, parent_preset_id, standalone_discoverable, variant_display_name, variant_sort_order, hero_asset_id"
    )
    .eq("id", productId)
    .single();
  if (selfError || !self) {
    if (selfError && isFamilySchemaUnavailableError(selfError)) {
      console.warn(
        "[admin] preset-family schema not deployed — family panel unavailable:",
        selfError.message
      );
      return { family: null, familySchemaAvailable: false };
    }
    return { family: null, familySchemaAvailable: true };
  }

  const rootId = (self.parent_preset_id as string | null) ?? self.id;
  const { data: members, error: membersError } = await supabase
    .from("products")
    .select(
      "id, slug, name, public_status, parent_preset_id, standalone_discoverable, variant_display_name, variant_sort_order, hero_asset_id"
    )
    .or(`id.eq.${rootId},parent_preset_id.eq.${rootId}`)
    .order("variant_sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (membersError) {
    if (isFamilySchemaUnavailableError(membersError)) {
      console.warn(
        "[admin] preset-family schema not deployed — family panel unavailable:",
        membersError.message
      );
      return { family: null, familySchemaAvailable: false };
    }
    throw membersError;
  }

  const rows = (members ?? []) as PresetFamilyMember[];
  const root = rows.find((m) => m.id === rootId);
  if (!root) return { family: null, familySchemaAvailable: true };
  return {
    family: {
      root,
      children: rows.filter((m) => m.id !== rootId),
    },
    familySchemaAvailable: true,
  };
}

/**
 * Explicit copy-draft flow: create a new variant that duplicates the
 * parent's catalog fields, editable version recipe, fields, and reference
 * assets as independent rows. Nothing is linked — the variant owns its own
 * draft version and never shares the parent's mutable configuration.
 */
export async function duplicateProductAsVariant(
  parentId: string,
  opts: { slug?: string; variantDisplayName?: string } = {}
) {
  await requireAdminOrOwner();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const parent = await getProductById(parentId);
  if (!parent) throw new Error("Parent preset not found");

  const familyErrors = validateFamilyAssignment({
    type: parent.type,
    parentPresetId: parentId,
    hasChildren: false,
    parent: {
      id: parent.id,
      type: parent.type,
      public_status: parent.public_status,
      parent_preset_id: parent.parent_preset_id,
    },
  });
  if (familyErrors.length > 0) {
    throw new Error(familyErrors.join(" "));
  }

  const siblingCount = await getChildCount(supabase, parentId);
  const slug =
    opts.slug ?? `${parent.slug}-variant-${siblingCount + 1}-${Date.now()}`;
  const displayName = opts.variantDisplayName ?? null;

  // Atomic server-side copy (#233): one transaction creates the variant
  // product, a draft of the parent's editable version, field rows, and
  // reference-asset links — a failure leaves no partial product behind.
  const { data: product, error } = await supabase
    .rpc("admin_duplicate_product", {
      p_source_product_id: parentId,
      p_slug: slug,
      p_name: displayName ?? `${parent.name} — Variant`,
      p_parent_product_id: parentId,
      p_variant_display_name: displayName,
    })
    .single();

  if (error) throw error;
  return product as { id: string };
}

/**
 * Persist a child ordering for a root preset. `orderedChildIds` must contain
 * exactly the current children — a partial list is rejected so reorder can
 * never silently drop a variant.
 */
export async function reorderFamilyVariants(
  parentId: string,
  orderedChildIds: string[]
): Promise<void> {
  await requireAdminOrOwner();
  const supabase = await createClient();

  const parent = await getFamilyParentRow(supabase, parentId);
  if (!parent) throw new Error("Parent preset not found");
  if (parent.parent_preset_id != null) {
    throw new Error("Only a root preset's children can be reordered.");
  }

  const { data: children, error: childrenError } = await supabase
    .from("products")
    .select("id")
    .eq("parent_preset_id", parentId);
  if (childrenError) throw childrenError;

  const currentIds = (children ?? []).map((c: { id: string }) => c.id).sort();
  const nextIds = [...orderedChildIds].sort();
  if (
    currentIds.length !== nextIds.length ||
    currentIds.some((id, i) => id !== nextIds[i])
  ) {
    throw new Error(
      "Reorder must include every variant of this family exactly once."
    );
  }

  for (const [index, childId] of orderedChildIds.entries()) {
    const { error } = await supabase
      .from("products")
      .update({ variant_sort_order: index })
      .eq("id", childId)
      .eq("parent_preset_id", parentId);
    if (error) throw error;
  }

  await logAdminAction({
    action: "product.family.reorder",
    entityType: "product",
    entityId: parentId,
    after: { ordered_child_ids: orderedChildIds },
  });
}

/**
 * Inline variant summary edit (display name + standalone discovery). Only
 * valid on products that already belong to a family.
 */
export async function updateVariantSummary(
  productId: string,
  patch: {
    variantDisplayName?: string | null;
    standaloneDiscoverable?: boolean;
  }
) {
  await requireAdminOrOwner();
  const supabase = await createClient();

  const { data: self, error: selfError } = await supabase
    .from("products")
    .select("id, parent_preset_id")
    .eq("id", productId)
    .single();
  if (selfError) throw selfError;
  if (!self?.parent_preset_id) {
    throw new Error("Variant fields only apply to a preset with a parent.");
  }

  if (patch.variantDisplayName != null && patch.variantDisplayName.length > 120) {
    throw new Error("Variant display name must be 120 characters or fewer.");
  }

  const update: Record<string, unknown> = {};
  if ("variantDisplayName" in patch) {
    update.variant_display_name = patch.variantDisplayName;
  }
  if ("standaloneDiscoverable" in patch) {
    update.standalone_discoverable = patch.standaloneDiscoverable;
  }
  if (Object.keys(update).length === 0) return;

  const { error } = await supabase
    .from("products")
    .update(update)
    .eq("id", productId);
  if (error) throw error;

  await logAdminAction({
    action: "product.update",
    entityType: "product",
    entityId: productId,
    after: update,
  });
}
