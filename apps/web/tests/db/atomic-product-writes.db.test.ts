import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { asService, asUser, withDb } from "./helpers/db";
import { makeUser } from "./helpers/fixtures";

/**
 * Issue #233 — atomic admin product writes.
 *
 * `admin_duplicate_product` / `admin_update_product` replace the old
 * multi-statement PostgREST flows whose failures left orphan products with
 * zero versions, stripped fields, or dropped reference-asset links. These
 * tests pin complete-copy fidelity, deterministic source-version selection,
 * independence of the copy, and full rollback on any failed write — for
 * Filters, Posters, and variant ("copy draft") duplication alike.
 */

async function makeStaff(client: Client): Promise<string> {
  const userId = randomUUID();
  // Seed is_admin at INSERT time — the privilege-escalation guard trigger
  // blocks promotion after creation (same pattern as
  // preset-family-input-contract.db.test.ts).
  await client.query("SET session_replication_role = 'replica'");
  try {
    await client.query(
      `INSERT INTO auth.users (
         id, instance_id, aud, role, email, encrypted_password,
         email_confirmed_at, created_at, updated_at,
         raw_app_meta_data, raw_user_meta_data
       ) VALUES (
         $1, '00000000-0000-0000-0000-000000000000',
         'authenticated', 'authenticated', $2, '',
         NOW(), NOW(), NOW(), '{}'::jsonb, '{}'::jsonb
       )`,
      [userId, `dbtest-staff-${userId}@example.invalid`]
    );
    await client.query(
      `INSERT INTO public.profiles (id, email, status, is_admin)
       VALUES ($1, $2, 'active', true)`,
      [userId, `dbtest-staff-${userId}@example.invalid`]
    );
  } finally {
    await client.query("SET session_replication_role = 'origin'");
  }
  return userId;
}

interface SourceOpts {
  type?: "filter" | "poster";
  state?: string;
  status?: string;
}

/**
 * A source product carrying every copyable surface: recipe + capability
 * columns on the version, one schema field, one reference-asset link.
 */
async function makeRichSource(
  client: Client,
  ownerId: string,
  opts: SourceOpts = {}
): Promise<{ productId: string; versionId: string; assetId: string }> {
  const productId = randomUUID();
  const versionId = randomUUID();
  const slug = `dbtest-src-${productId.slice(0, 8)}`;
  await client.query(
    `INSERT INTO public.products (
       id, type, slug, name, short_description, long_description,
       public_prompt_recipe, public_status, visibility, likeness_level,
       featured_rank, metadata
     ) VALUES ($1, $2, $3, $4, 'short copy', 'long copy',
       'public recipe', $5, 'public', 'creative', 3,
       '{"filter_config":{"intensity":0.7},"prompt_ui":{"placeholder":"Describe your tweak","examples":["warmer","softer light"],"helper":"Short plain-English edits only"}}'::jsonb)`,
    [
      productId,
      opts.type ?? "filter",
      slug,
      `Source ${slug}`,
      opts.status ?? "active",
    ]
  );
  await client.query(
    `INSERT INTO public.product_versions (
       id, product_id, version_number, state,
       private_instruction_template, private_negative_instruction,
       provider_strategy, model_config, output_sizes,
       input_validation_config, input_mode, input_min_images,
       input_max_images, input_image_roles, prompt_override_enabled,
       prompt_max_chars, post_process_config, safety_config, credit_cost
     ) VALUES (
       $1, $2, 1, $3,
       'private instruction v1', 'avoid artifacts',
       '{"primary_provider":"fal","primary_model":"m1"}'::jsonb,
       '{"cfg":7}'::jsonb, '["1024x1024"]'::jsonb,
       '{"min":1024}'::jsonb, 'multi', 2, 3,
       '[{"name":"subject"},{"name":"style","optional":true}]'::jsonb,
       true, 500,
       '{"upscale":true}'::jsonb, '{"nsfw":false}'::jsonb, 42
     )`,
    [versionId, productId, opts.state ?? "draft"]
  );
  const assetId = randomUUID();
  await client.query(
    `INSERT INTO public.assets (
       id, owner_user_id, storage_provider, storage_key, bucket,
       media_type, mime_type, moderation_status
     ) VALUES ($1, $2, 'supabase', $3, 'admin-assets', 'image',
       'image/png', 'approved')`,
    [assetId, ownerId, `dbtest/${assetId}.png`]
  );
  await client.query(
    `INSERT INTO public.product_assets (
       product_id, product_version_id, asset_id, role, sort_order,
       internal_only, rights_metadata
     ) VALUES ($1, $2, $3, 'style_reference', 0, true,
       '{"license":"internal"}'::jsonb)`,
    [productId, versionId, assetId]
  );
  await client.query(
    `INSERT INTO public.product_fields (
       product_id, field_key, label, help_text, field_type, required,
       sort_order, config, validation, active
     ) VALUES ($1, 'strength', 'Strength', 'how strong', 'intensity', true,
       0, '{"min":0,"max":1}'::jsonb, '{"max":1}'::jsonb, true)`,
    [productId]
  );
  return { productId, versionId, assetId };
}

async function duplicate(
  client: Client,
  staffId: string,
  sourceId: string,
  extra: { parentId?: string; displayName?: string } = {}
): Promise<string> {
  return asUser(client, staffId, async () => {
    const result = await client.query(
      `SELECT (public.admin_duplicate_product(
         $1, $2, $3, $4, $5
       )).id AS id`,
      [
        sourceId,
        `dbtest-copy-${randomUUID().slice(0, 8)}`,
        "Copied Product",
        extra.parentId ?? null,
        extra.displayName ?? null,
      ]
    );
    return result.rows[0].id as string;
  });
}

describe("admin_duplicate_product — complete atomic copy", () => {
  it("duplicates a Filter with full recipe, fields, and asset links", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId, assetId } = await makeRichSource(client, ownerId);

      const copyId = await duplicate(client, staffId, productId);

      const copy = await asService(client, async () => {
        const product = await client.query(
          `SELECT type, public_status, short_description, long_description,
                  public_prompt_recipe, likeness_level, featured_rank,
                  metadata, parent_preset_id, standalone_discoverable
           FROM public.products WHERE id = $1`,
          [copyId]
        );
        const version = await client.query(
          `SELECT version_number, state, private_instruction_template,
                  private_negative_instruction, provider_strategy,
                  model_config, output_sizes, input_validation_config,
                  input_mode, input_min_images, input_max_images,
                  input_image_roles, prompt_override_enabled,
                  prompt_max_chars, post_process_config, safety_config,
                  credit_cost, published_at, retired_at,
                  created_by_admin_id
           FROM public.product_versions WHERE product_id = $1`,
          [copyId]
        );
        const fields = await client.query(
          `SELECT field_key, label, help_text, field_type, required,
                  sort_order, config, validation, active
           FROM public.product_fields WHERE product_id = $1`,
          [copyId]
        );
        const links = await client.query(
          `SELECT product_version_id, asset_id, role, sort_order,
                  internal_only, rights_metadata
           FROM public.product_assets WHERE product_id = $1`,
          [copyId]
        );
        return {
          product: product.rows[0],
          version: version.rows[0],
          fields: fields.rows,
          links: links.rows,
        };
      });

      expect(copy.product).toMatchObject({
        type: "filter",
        public_status: "draft",
        short_description: "short copy",
        long_description: "long copy",
        public_prompt_recipe: "public recipe",
        likeness_level: "creative",
        parent_preset_id: null,
        standalone_discoverable: false,
        metadata: {
          filter_config: { intensity: 0.7 },
          prompt_ui: {
            placeholder: "Describe your tweak",
            examples: ["warmer", "softer light"],
            helper: "Short plain-English edits only",
          },
        },
      });
      expect(copy.version).toMatchObject({
        version_number: 1,
        state: "draft",
        private_instruction_template: "private instruction v1",
        private_negative_instruction: "avoid artifacts",
        input_mode: "multi",
        input_min_images: 2,
        input_max_images: 3,
        prompt_override_enabled: true,
        prompt_max_chars: 500,
      });
      expect(Number(copy.version.credit_cost)).toBe(42);
      expect(copy.version.provider_strategy).toEqual({
        primary_provider: "fal",
        primary_model: "m1",
      });
      expect(copy.version.model_config).toEqual({ cfg: 7 });
      expect(copy.version.output_sizes).toEqual(["1024x1024"]);
      expect(copy.version.input_validation_config).toEqual({ min: 1024 });
      expect(copy.version.post_process_config).toEqual({ upscale: true });
      expect(copy.version.safety_config).toEqual({ nsfw: false });
      // The copy must not look published: no publish/retire timestamps,
      // and ownership is attributed to the duplicating admin.
      expect(copy.version.published_at).toBeNull();
      expect(copy.version.retired_at).toBeNull();
      expect(copy.version.created_by_admin_id).toBe(staffId);
      expect(copy.version.input_image_roles).toEqual([
        { name: "subject" },
        { name: "style", optional: true },
      ]);
      expect(copy.fields).toHaveLength(1);
      expect(copy.fields[0]).toMatchObject({
        field_key: "strength",
        label: "Strength",
        help_text: "how strong",
        field_type: "intensity",
        required: true,
        active: true,
      });
      // Asset link is copied and rebound to the copy's own version.
      expect(copy.links).toHaveLength(1);
      expect(copy.links[0]).toMatchObject({
        asset_id: assetId,
        role: "style_reference",
        internal_only: true,
        rights_metadata: { license: "internal" },
      });
      const copyVersionId = (
        await asService(client, () =>
          client.query(
            `SELECT id FROM public.product_versions WHERE product_id = $1`,
            [copyId]
          )
        )
      ).rows[0].id;
      expect(copy.links[0].product_version_id).toBe(copyVersionId);
    });
  });

  it("duplicates a Poster with the same fidelity", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId } = await makeRichSource(client, ownerId, {
        type: "poster",
      });

      const copyId = await duplicate(client, staffId, productId);
      const { rows } = await asService(client, () =>
        client.query(
          `SELECT p.type, p.public_status, v.state, v.credit_cost,
                  (SELECT COUNT(*) FROM public.product_fields
                    WHERE product_id = p.id) AS field_count,
                  (SELECT COUNT(*) FROM public.product_assets
                    WHERE product_id = p.id) AS link_count
           FROM public.products p
           JOIN public.product_versions v ON v.product_id = p.id
           WHERE p.id = $1`,
          [copyId]
        )
      );
      expect(rows[0]).toMatchObject({
        type: "poster",
        public_status: "draft",
        state: "draft",
      });
      expect(Number(rows[0].credit_cost)).toBe(42);
      expect(Number(rows[0].field_count)).toBe(1);
      expect(Number(rows[0].link_count)).toBe(1);
    });
  });

  it("prefers the latest draft version over an active one", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId } = await makeRichSource(client, ownerId, {
        state: "active",
      });
      await client.query(
        `INSERT INTO public.product_versions (
           id, product_id, version_number, state,
           private_instruction_template, credit_cost
         ) VALUES ($1, $2, 2, 'draft', 'newer draft template', 7)`,
        [randomUUID(), productId]
      );

      const copyId = await duplicate(client, staffId, productId);
      const { rows } = await asService(client, () =>
        client.query(
          `SELECT private_instruction_template, credit_cost, state
           FROM public.product_versions WHERE product_id = $1`,
          [copyId]
        )
      );
      expect(rows[0]).toMatchObject({
        private_instruction_template: "newer draft template",
        state: "draft",
      });
      expect(Number(rows[0].credit_cost)).toBe(7);
    });
  });

  it("creates an independent copy — later source edits don't leak", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId, versionId } = await makeRichSource(client, ownerId);

      const copyId = await duplicate(client, staffId, productId);

      await asService(client, async () => {
        await client.query(
          `UPDATE public.product_versions
             SET private_instruction_template = 'mutated template'
           WHERE id = $1`,
          [versionId]
        );
        await client.query(
          `DELETE FROM public.product_fields WHERE product_id = $1`,
          [productId]
        );
      });

      const { rows } = await asService(client, () =>
        client.query(
          `SELECT v.private_instruction_template,
                  (SELECT COUNT(*) FROM public.product_fields
                    WHERE product_id = $1) AS field_count
           FROM public.product_versions v WHERE v.product_id = $1`,
          [copyId]
        )
      );
      expect(rows[0].private_instruction_template).toBe(
        "private instruction v1"
      );
      expect(Number(rows[0].field_count)).toBe(1);
    });
  });

  it("rolls back every write when the products insert fails", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId } = await makeRichSource(client, ownerId);

      const { rows: before } = await asService(client, () =>
        client.query(`SELECT COUNT(*) AS c FROM public.products`)
      );

      // Colliding slug → unique violation inside the RPC → the function
      // transaction aborts; nothing can persist.
      await expect(
        asUser(client, staffId, () =>
          client.query(
            `SELECT public.admin_duplicate_product(
               $1, (SELECT slug FROM public.products WHERE id = $1),
               'Clash', NULL, NULL
             )`,
            [productId]
          )
        )
      ).rejects.toThrow();

      const { rows: after } = await asService(client, async () => ({
        rows: [
          {
            products: (
              await client.query(
                `SELECT COUNT(*) AS c FROM public.products`
              )
            ).rows[0].c,
            versions: (
              await client.query(
                `SELECT COUNT(*) AS c FROM public.product_versions
                 WHERE product_id NOT IN (SELECT id FROM public.products)`
              )
            ).rows[0].c,
          },
        ],
      }));
      expect(after[0].products).toBe(before[0].c);
      expect(Number(after[0].versions)).toBe(0);
    });
  });

  it("rejects a source product with no editable version — writes nothing", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const productId = randomUUID();
      await client.query(
        `INSERT INTO public.products (id, type, slug, name, public_status, visibility)
         VALUES ($1, 'filter', $2, 'Versionless', 'draft', 'internal')`,
        [productId, `dbtest-nov-${productId.slice(0, 8)}`]
      );

      const { rows: before } = await asService(client, () =>
        client.query(`SELECT COUNT(*) AS c FROM public.products`)
      );

      await expect(
        duplicate(client, staffId, productId)
      ).rejects.toThrow(/no editable source version/i);

      const { rows: after } = await asService(client, () =>
        client.query(`SELECT COUNT(*) AS c FROM public.products`)
      );
      expect(after[0].c).toBe(before[0].c);
    });
  });

  it("rejects a product whose only versions are retired", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      // The source's only version is retired — nothing editable remains.
      const { productId } = await makeRichSource(client, ownerId, {
        state: "retired",
      });

      const { rows: before } = await asService(client, () =>
        client.query(`SELECT COUNT(*) AS c FROM public.products`)
      );

      await expect(
        duplicate(client, staffId, productId)
      ).rejects.toThrow(/no editable source version/i);

      const { rows: after } = await asService(client, () =>
        client.query(`SELECT COUNT(*) AS c FROM public.products`)
      );
      expect(after[0].c).toBe(before[0].c);
    });
  });

  it("copies only product-level links and the selected version's links", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId, versionId, assetId } = await makeRichSource(
        client,
        ownerId
      );

      // A retired predecessor version carries its own link — it must NOT
      // be inherited by the copy. A product-level link (version NULL) must.
      const retiredVersionId = randomUUID();
      const staleAssetId = randomUUID();
      const productLevelAssetId = randomUUID();
      await client.query(
        `INSERT INTO public.product_versions (
           id, product_id, version_number, state,
           private_instruction_template, credit_cost
         ) VALUES ($1, $2, 0, 'retired', 'old template', 0)`,
        [retiredVersionId, productId]
      );
      for (const [asset, linkVersion, role] of [
        [staleAssetId, retiredVersionId, "style_reference"],
        [productLevelAssetId, null, "example_result"],
      ] as const) {
        await client.query(
          `INSERT INTO public.assets (
             id, owner_user_id, storage_provider, storage_key, bucket,
             media_type, mime_type, moderation_status
           ) VALUES ($1, $2, 'supabase', $3, 'admin-assets', 'image',
             'image/png', 'approved')`,
          [asset, ownerId, `dbtest/${asset}.png`]
        );
        await client.query(
          `INSERT INTO public.product_assets (
             product_id, product_version_id, asset_id, role, sort_order
           ) VALUES ($1, $2, $3, $4, 5)`,
          [productId, linkVersion, asset, role]
        );
      }

      const copyId = await duplicate(client, staffId, productId);
      const { rows: links } = await asService(client, () =>
        client.query(
          `SELECT asset_id, product_version_id, role
           FROM public.product_assets WHERE product_id = $1
           ORDER BY role`,
          [copyId]
        )
      );
      // Selected-version link + product-level link only — the retired
      // version's stale reference stays behind.
      expect(links.map((l: { asset_id: string }) => l.asset_id).sort()).toEqual(
        [assetId, productLevelAssetId].sort()
      );
      const selectedBound = links.find(
        (l: { role: string }) => l.role === "style_reference"
      );
      const productLevel = links.find(
        (l: { role: string }) => l.role === "example_result"
      );
      const { rows: newVersion } = await asService(client, () =>
        client.query(
          `SELECT id FROM public.product_versions WHERE product_id = $1`,
          [copyId]
        )
      );
      expect(selectedBound.product_version_id).toBe(newVersion[0].id);
      expect(productLevel.product_version_id).toBeNull();
      expect(newVersion).toHaveLength(1);
      void versionId;
    });
  });

  it("denies non-admin callers and writes nothing", async () => {
    await withDb(async (client) => {
      const { userId } = await makeUser(client);
      const { productId } = await makeRichSource(client, userId);
      const sentinel = `forbidden-${randomUUID().slice(0, 8)}`;

      await expect(
        asUser(client, userId, () =>
          client.query(
            `SELECT public.admin_duplicate_product(
               $1, $2, $2, NULL, NULL)`,
            [productId, sentinel]
          )
        )
      ).rejects.toThrow(/admin or owner/);

      const { rows } = await asService(client, () =>
        client.query(
          `SELECT COUNT(*) AS c FROM public.products WHERE slug = $1`,
          [sentinel]
        )
      );
      expect(Number(rows[0].c)).toBe(0);
    });
  });
});

describe("admin_duplicate_product — variant (copy draft)", () => {
  it("attaches to the parent as a family-only draft variant", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId } = await makeRichSource(client, ownerId);

      const variantId = await duplicate(client, staffId, productId, {
        parentId: productId,
        displayName: "Warm Alt",
      });

      const { rows } = await asService(client, () =>
        client.query(
          `SELECT parent_preset_id, standalone_discoverable,
                  variant_display_name, variant_sort_order, public_status,
                  (SELECT COUNT(*) FROM public.product_versions
                    WHERE product_id = $1) AS version_count,
                  (SELECT COUNT(*) FROM public.product_assets
                    WHERE product_id = $1) AS link_count
           FROM public.products WHERE id = $1`,
          [variantId]
        )
      );
      expect(rows[0]).toMatchObject({
        parent_preset_id: productId,
        standalone_discoverable: false,
        variant_display_name: "Warm Alt",
        variant_sort_order: 0,
        public_status: "draft",
      });
      expect(Number(rows[0].version_count)).toBe(1);
      expect(Number(rows[0].link_count)).toBe(1);
    });
  });

  it("rejects a variant parent of a different type", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId: posterId } = await makeRichSource(client, ownerId, {
        type: "poster",
      });
      const { productId: filterId } = await makeRichSource(client, ownerId);

      await expect(
        asUser(client, staffId, () =>
          client.query(
            `SELECT public.admin_duplicate_product(
               $1, 'x-v', 'x', $2, 'v')`,
            [filterId, posterId]
          )
        )
      ).rejects.toThrow();
    });
  });
});

describe("admin_update_product — atomic save", () => {
  async function callUpdate(
    client: Client,
    staffId: string,
    productId: string,
    versionId: string | null,
    versionPayload: Record<string, unknown> | null,
    fieldsPayload: unknown[] | null
  ) {
    return asUser(client, staffId, () =>
      client.query(
        `SELECT public.admin_update_product($1, $2, $3, $4, $5) AS result`,
        [
          productId,
          JSON.stringify({ name: "Renamed" }),
          versionId,
          versionPayload ? JSON.stringify(versionPayload) : null,
          fieldsPayload ? JSON.stringify(fieldsPayload) : null,
        ]
      )
    );
  }

  it("commits product, version, and fields together", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId, versionId } = await makeRichSource(client, ownerId);

      const { rows } = await callUpdate(
        client,
        staffId,
        productId,
        versionId,
        { credit_cost: 99 },
        [
          {
            field_key: "mood",
            label: "Mood",
            field_type: "select",
            required: false,
            sort_order: 0,
          },
        ]
      );
      expect(rows[0].result.effective_version_id).toBe(versionId);

      const check = await asService(client, async () => ({
        name: (
          await client.query(
            `SELECT name FROM public.products WHERE id = $1`,
            [productId]
          )
        ).rows[0].name,
        cost: (
          await client.query(
            `SELECT credit_cost FROM public.product_versions
             WHERE id = $1`,
            [versionId]
          )
        ).rows[0].credit_cost,
        fields: (
          await client.query(
            `SELECT field_key FROM public.product_fields
             WHERE product_id = $1`,
            [productId]
          )
        ).rows.map((r: { field_key: string }) => r.field_key),
      }));
      expect(check.name).toBe("Renamed");
      expect(Number(check.cost)).toBe(99);
      expect(check.fields).toEqual(["mood"]);
    });
  });

  it("rolls the product rename back when the version write fails", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId, versionId } = await makeRichSource(client, ownerId);

      // input_mode 'multi' with max 1 violates the input-contract CHECK —
      // the whole call must abort, including the products rename.
      await expect(
        callUpdate(
          client,
          staffId,
          productId,
          versionId,
          { input_mode: "multi", input_min_images: 1, input_max_images: 1 },
          null
        )
      ).rejects.toThrow();

      const { rows } = await asService(client, () =>
        client.query(
          `SELECT name FROM public.products WHERE id = $1`,
          [productId]
        )
      );
      expect(rows[0].name).not.toBe("Renamed");
    });
  });

  it("rolls back a field insert failure without touching metadata", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId, versionId } = await makeRichSource(client, ownerId);

      await expect(
        callUpdate(client, staffId, productId, versionId, { credit_cost: 5 }, [
          { field_key: null, label: "Broken", field_type: "short_text" },
        ])
      ).rejects.toThrow();

      const { rows } = await asService(client, () =>
        client.query(
          `SELECT p.name,
                  (SELECT COUNT(*) FROM public.product_fields
                    WHERE product_id = p.id) AS field_count,
                  (SELECT credit_cost FROM public.product_versions
                    WHERE id = $2) AS version_cost
           FROM public.products p WHERE p.id = $1`,
          [productId, versionId]
        )
      );
      expect(rows[0].name).not.toBe("Renamed");
      expect(Number(rows[0].field_count)).toBe(1);
      expect(Number(rows[0].version_cost)).toBe(42);
    });
  });

  it("rejects the save when no editable version is supplied", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId } = await makeRichSource(client, ownerId);

      await expect(
        callUpdate(client, staffId, productId, null, null, null)
      ).rejects.toThrow(/no editable source version/i);

      const { rows } = await asService(client, () =>
        client.query(
          `SELECT name FROM public.products WHERE id = $1`,
          [productId]
        )
      );
      expect(rows[0].name).not.toBe("Renamed");
    });
  });

  it("preserves existing metadata keys on a partial metadata update", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId, versionId } = await makeRichSource(client, ownerId);
      // makeRichSource seeds metadata.filter_config + prompt_ui.

      // A patch carrying only filter_config must not drop prompt_ui.
      await asUser(client, staffId, () =>
        client.query(
          `SELECT public.admin_update_product($1, $2, $3, $4, NULL)`,
          [
            productId,
            JSON.stringify({
              metadata: { filter_config: { intensity: 0.9 } },
            }),
            versionId,
            JSON.stringify({ credit_cost: 42 }),
          ]
        )
      );

      const { rows } = await asService(client, () =>
        client.query(
          `SELECT metadata FROM public.products WHERE id = $1`,
          [productId]
        )
      );
      expect(rows[0].metadata).toEqual({
        filter_config: { intensity: 0.9 },
        prompt_ui: {
          placeholder: "Describe your tweak",
          examples: ["warmer", "softer light"],
          helper: "Short plain-English edits only",
        },
      });
    });
  });

  it("rejects catalog activation when no version is published", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      // Draft product whose only version is a draft — the Retro Slam
      // Manga anomaly path: status must not reach 'active' via save.
      const { productId, versionId } = await makeRichSource(client, ownerId, {
        status: "draft",
        state: "draft",
      });

      await expect(
        asUser(client, staffId, () =>
          client.query(
            `SELECT public.admin_update_product($1, $2, $3, $4, NULL)`,
            [
              productId,
              JSON.stringify({ name: "Activated", public_status: "active" }),
              versionId,
              JSON.stringify({ credit_cost: 42 }),
            ]
          )
        )
      ).rejects.toThrow(/requires an active version/i);

      // Atomic: the rename did not persist either.
      const { rows } = await asService(client, () =>
        client.query(
          `SELECT name, public_status FROM public.products WHERE id = $1`,
          [productId]
        )
      );
      expect(rows[0].public_status).toBe("draft");
      expect(rows[0].name).not.toBe("Activated");
    });
  });

  it("allows activation through save when an active version exists", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      // Paused product with a published version — legitimate reactivation.
      const { productId, versionId } = await makeRichSource(client, ownerId, {
        status: "paused",
        state: "active",
      });

      await asUser(client, staffId, () =>
        client.query(
          `SELECT public.admin_update_product($1, $2, $3, $4, NULL)`,
          [
            productId,
            JSON.stringify({ public_status: "active" }),
            versionId,
            JSON.stringify({ credit_cost: 42 }),
          ]
        )
      );

      const { rows } = await asService(client, () =>
        client.query(
          `SELECT public_status FROM public.products WHERE id = $1`,
          [productId]
        )
      );
      expect(rows[0].public_status).toBe("active");
    });
  });

  it("keeps already-active products editable even with only drafts", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      // The existing anomaly shape: status 'active' + only draft versions.
      // The save must still succeed so the record stays repairable — the
      // rule only gates the transition INTO active.
      const { productId, versionId } = await makeRichSource(client, ownerId, {
        status: "active",
        state: "draft",
      });

      await asUser(client, staffId, () =>
        client.query(
          `SELECT public.admin_update_product($1, $2, $3, $4, NULL)`,
          [
            productId,
            JSON.stringify({ name: "Repaired" }),
            versionId,
            JSON.stringify({ credit_cost: 42 }),
          ]
        )
      );

      const { rows } = await asService(client, () =>
        client.query(
          `SELECT name, public_status FROM public.products WHERE id = $1`,
          [productId]
        )
      );
      expect(rows[0]).toMatchObject({ name: "Repaired", public_status: "active" });
    });
  });

  it("clones an active version to draft before editing it", async () => {
    await withDb(async (client) => {
      const staffId = await makeStaff(client);
      const { userId: ownerId } = await makeUser(client);
      const { productId, versionId } = await makeRichSource(client, ownerId, {
        state: "active",
      });

      const { rows } = await callUpdate(
        client,
        staffId,
        productId,
        versionId,
        { credit_cost: 55, private_instruction_template: "edited" },
        null
      );
      const effectiveId = rows[0].result.effective_version_id as string;
      expect(effectiveId).not.toBe(versionId);

      const check = await asService(client, async () => ({
        original: (
          await client.query(
            `SELECT state, credit_cost FROM public.product_versions
             WHERE id = $1`,
            [versionId]
          )
        ).rows[0],
        draft: (
          await client.query(
            `SELECT state, credit_cost, private_instruction_template,
                    input_mode, input_max_images, prompt_max_chars
             FROM public.product_versions WHERE id = $1`,
            [effectiveId]
          )
        ).rows[0],
      }));
      // The active version is untouched; the clone carries the edit and —
      // crucially — the input/prompt capability columns it used to drop.
      expect(check.original.state).toBe("active");
      expect(Number(check.original.credit_cost)).toBe(42);
      expect(check.draft).toMatchObject({
        state: "draft",
        private_instruction_template: "edited",
        input_mode: "multi",
        input_max_images: 3,
        prompt_max_chars: 500,
      });
      expect(Number(check.draft.credit_cost)).toBe(55);
    });
  });
});
