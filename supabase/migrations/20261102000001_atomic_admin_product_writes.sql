-- #233: atomic admin product writes — duplication and save must be
-- all-or-nothing.
--
-- Until now `duplicateProduct` / `duplicateProductAsVariant` / `updateProduct`
-- issued separate PostgREST writes per table. A failure after the `products`
-- insert left an orphan product with zero versions; a fields-insert failure
-- left a product stripped of fields; the variant flow could also lose
-- reference-asset links. Hosted already contains three such incomplete
-- copies.
--
-- This migration adds two SECURITY DEFINER plpgsql RPCs — one per write
-- unit — following the `clone_version_as_draft` convention (explicit
-- is_admin()/is_owner() check, internal audit row, authenticated-only
-- EXECUTE). Everything inside a function body is a single transaction:
-- any error rolls back every insert/update including the audit row.
--
-- It also extends `clone_version_as_draft` to copy the input-capability and
-- prompt columns — the legacy body silently dropped them when an active
-- version was cloned for editing.

-- 1. Atomic product duplication -------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_duplicate_product(
  p_source_product_id UUID,
  p_slug TEXT,
  p_name TEXT,
  p_parent_product_id UUID DEFAULT NULL,
  p_variant_display_name TEXT DEFAULT NULL
)
RETURNS public.products
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
  v_source public.products;
  v_source_version public.product_versions;
  v_new public.products;
  v_new_version_id UUID;
  v_sibling_count INT;
BEGIN
  IF v_user_id IS NULL OR NOT (public.is_admin() OR public.is_owner()) THEN
    RAISE EXCEPTION 'Forbidden: admin or owner required';
  END IF;

  SELECT * INTO v_source
  FROM public.products WHERE id = p_source_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source product not found';
  END IF;

  IF p_parent_product_id IS NOT NULL THEN
    -- Variant rules (single level): the parent must be a root of the same
    -- type. The products trigger enforces these too; surfacing here keeps
    -- the failure inside the same atomic call.
    PERFORM 1 FROM public.products
    WHERE id = p_parent_product_id
      AND type = v_source.type
      AND parent_preset_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid variant parent';
    END IF;
  END IF;

  -- Deterministic editable source version: latest draft, else testing,
  -- else active — mirrors selectEditableVersion() app-side. Retired
  -- versions are never an editable source: a product whose only versions
  -- are retired has no duplicable recipe and fails the check below.
  SELECT * INTO v_source_version
  FROM public.product_versions
  WHERE product_id = p_source_product_id
    AND state IN ('draft', 'testing', 'active')
  ORDER BY
    CASE state WHEN 'draft' THEN 0 WHEN 'testing' THEN 1 ELSE 2 END,
    version_number DESC
  LIMIT 1;

  -- Fail closed: a source with no usable version must never produce
  -- another incomplete product row.
  IF v_source_version.id IS NULL THEN
    RAISE EXCEPTION 'Cannot duplicate: product has no editable source version';
  END IF;

  SELECT COUNT(*) INTO v_sibling_count
  FROM public.products
  WHERE parent_preset_id = p_parent_product_id;

  INSERT INTO public.products (
    type, slug, name, short_description, long_description,
    public_prompt_recipe, category_id, public_status, visibility,
    likeness_level, featured_rank, hero_asset_id, poster_asset_id,
    preview_video_asset_id, preview_gif_asset_id, metadata,
    parent_preset_id, standalone_discoverable, variant_display_name,
    variant_sort_order
  )
  SELECT
    type, p_slug, p_name, short_description, long_description,
    public_prompt_recipe, category_id, 'draft', visibility,
    likeness_level, featured_rank, hero_asset_id, poster_asset_id,
    preview_video_asset_id, preview_gif_asset_id, metadata,
    p_parent_product_id,
    FALSE,
    CASE WHEN p_parent_product_id IS NULL THEN NULL
         ELSE p_variant_display_name END,
    CASE WHEN p_parent_product_id IS NULL THEN 0
         ELSE v_sibling_count END
  FROM public.products
  WHERE id = p_source_product_id
  RETURNING * INTO v_new;

  INSERT INTO public.product_versions (
    product_id, version_number, state, private_instruction_template,
    private_negative_instruction, provider_strategy, model_config,
    output_sizes, input_validation_config, input_mode, input_min_images,
    input_max_images, input_image_roles, prompt_override_enabled,
    prompt_max_chars, post_process_config, safety_config, credit_cost,
    created_by_admin_id
  )
  SELECT
    v_new.id, 1, 'draft', private_instruction_template,
    private_negative_instruction, provider_strategy, model_config,
    output_sizes, input_validation_config, input_mode, input_min_images,
    input_max_images, input_image_roles, prompt_override_enabled,
    prompt_max_chars, post_process_config, safety_config, credit_cost,
    v_user_id
  FROM public.product_versions
  WHERE id = v_source_version.id
  RETURNING id INTO v_new_version_id;

  INSERT INTO public.product_fields (
    product_id, field_key, label, help_text, field_type, required,
    sort_order, config, validation, active
  )
  SELECT
    v_new.id, field_key, label, help_text, field_type, required,
    sort_order, config, validation, active
  FROM public.product_fields
  WHERE product_id = p_source_product_id;

  -- Asset links: only product-level links and links bound to the SELECTED
  -- editable version are copied — references pinned to older versions must
  -- not leak into the new draft. Version-bound links rebind to the copy's
  -- new version so a later source edit never mutates this draft.
  INSERT INTO public.product_assets (
    product_id, product_version_id, asset_id, role, sort_order,
    internal_only, rights_metadata
  )
  SELECT
    v_new.id,
    CASE WHEN product_version_id IS NULL THEN NULL
         ELSE v_new_version_id END,
    asset_id, role, sort_order, internal_only, rights_metadata
  FROM public.product_assets
  WHERE product_id = p_source_product_id
    AND (product_version_id IS NULL
         OR product_version_id = v_source_version.id);

  INSERT INTO public.admin_audit_logs (
    admin_user_id, action, entity_type, entity_id, before, after
  )
  VALUES (
    v_user_id,
    'product.duplicate',
    'product',
    v_new.id,
    jsonb_build_object('source_product_id', p_source_product_id),
    jsonb_build_object(
      'new_product_id', v_new.id,
      'parent_product_id', p_parent_product_id,
      'source_version_id', v_source_version.id
    )
  );

  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_duplicate_product(UUID, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_duplicate_product(UUID, TEXT, TEXT, UUID, TEXT)
  TO authenticated;

-- 2. Atomic product save ---------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_update_product(
  p_product_id UUID,
  p_product JSONB,
  p_source_version_id UUID,
  p_version JSONB,
  p_fields JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
  v_before public.products;
  v_after public.products;
  v_p public.products;
  v_v public.product_versions;
  v_existing_version public.product_versions;
  v_effective_version_id UUID := p_source_version_id;
BEGIN
  IF v_user_id IS NULL OR NOT (public.is_admin() OR public.is_owner()) THEN
    RAISE EXCEPTION 'Forbidden: admin or owner required';
  END IF;

  SELECT * INTO v_before
  FROM public.products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  -- Fail closed: never report a successful save for a product with no
  -- editable version — that is exactly the incomplete state #233 removes.
  IF p_source_version_id IS NULL OR p_version IS NULL THEN
    RAISE EXCEPTION 'Cannot save: product has no editable source version';
  END IF;

  -- Merge onto the before-image: keys absent from p_product keep their
  -- current value instead of being nulled out.
  v_p := jsonb_populate_record(
    NULL::public.products, to_jsonb(v_before) || p_product
  );

  -- Catalog activation must go through a published recipe — the same rule
  -- transition_product_status() enforces; a save must not bypass it by
  -- writing public_status directly. Products that are already 'active'
  -- keep saving so their metadata remains editable/repairable; only the
  -- transition INTO active is gated here.
  IF v_before.public_status IS DISTINCT FROM 'active'
     AND v_p.public_status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM public.product_versions
       WHERE product_id = p_product_id AND state = 'active'
     ) THEN
    RAISE EXCEPTION
      'A product requires an active version before it can be activated';
  END IF;

  UPDATE public.products SET
    type = v_p.type,
    slug = v_p.slug,
    name = v_p.name,
    short_description = v_p.short_description,
    long_description = v_p.long_description,
    public_prompt_recipe = v_p.public_prompt_recipe,
    category_id = v_p.category_id,
    public_status = v_p.public_status,
    visibility = v_p.visibility,
    likeness_level = v_p.likeness_level,
    featured_rank = v_p.featured_rank,
    hero_asset_id = v_p.hero_asset_id,
    poster_asset_id = v_p.poster_asset_id,
    preview_video_asset_id = v_p.preview_video_asset_id,
    preview_gif_asset_id = v_p.preview_gif_asset_id,
    -- Partial metadata updates merge: keys absent from the patch (e.g.
    -- prompt_ui when only filter_config is submitted) keep their value.
    metadata = COALESCE(v_before.metadata, '{}'::JSONB)
               || COALESCE(v_p.metadata, '{}'::JSONB),
    parent_preset_id = v_p.parent_preset_id,
    standalone_discoverable = COALESCE(v_p.standalone_discoverable, FALSE),
    variant_display_name = v_p.variant_display_name,
    variant_sort_order = COALESCE(v_p.variant_sort_order, 0)
  WHERE id = p_product_id
  RETURNING * INTO v_after;

  -- Editable version: update in place unless the source is active — the
  -- recipe is immutable once published, so clone then edit the clone.
  PERFORM 1 FROM public.product_versions
  WHERE id = p_source_version_id AND product_id = p_product_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source version not found';
  END IF;

  IF (SELECT state FROM public.product_versions WHERE id = p_source_version_id)
     = 'active' THEN
    v_effective_version_id :=
      (SELECT id FROM public.clone_version_as_draft(p_source_version_id));
  END IF;

  -- Merge the patch onto the effective row (the clone when the source was
  -- active): keys absent from p_version keep their current value.
  SELECT * INTO v_existing_version
  FROM public.product_versions WHERE id = v_effective_version_id;
  v_v := jsonb_populate_record(
    NULL::public.product_versions,
    to_jsonb(v_existing_version) || p_version
  );

  UPDATE public.product_versions SET
    private_instruction_template = v_v.private_instruction_template,
    private_negative_instruction = v_v.private_negative_instruction,
    provider_strategy = v_v.provider_strategy,
    model_config = v_v.model_config,
    output_sizes = v_v.output_sizes,
    input_validation_config = v_v.input_validation_config,
    input_mode = v_v.input_mode,
    input_min_images = v_v.input_min_images,
    input_max_images = v_v.input_max_images,
    input_image_roles = v_v.input_image_roles,
    prompt_override_enabled = v_v.prompt_override_enabled,
    prompt_max_chars = v_v.prompt_max_chars,
    post_process_config = v_v.post_process_config,
    safety_config = v_v.safety_config,
    credit_cost = v_v.credit_cost
  WHERE id = v_effective_version_id;

  -- NULL p_fields = fields untouched; [] = delete all; array = replace set.
  IF p_fields IS NOT NULL THEN
    DELETE FROM public.product_fields WHERE product_id = p_product_id;
    INSERT INTO public.product_fields (
      product_id, field_key, label, help_text, field_type, required,
      sort_order, config, validation, active
    )
    SELECT
      p_product_id, field_key, label, help_text, field_type,
      COALESCE(required, FALSE), COALESCE(sort_order, 0),
      COALESCE(config, '{}'::JSONB), COALESCE(validation, '{}'::JSONB),
      COALESCE(active, TRUE)
    FROM jsonb_populate_recordset(NULL::public.product_fields, p_fields);
  END IF;

  INSERT INTO public.admin_audit_logs (
    admin_user_id, action, entity_type, entity_id, before, after
  )
  VALUES (
    v_user_id,
    'product.update',
    'product',
    p_product_id,
    to_jsonb(v_before),
    to_jsonb(v_after)
  );

  RETURN jsonb_build_object(
    'product_id', p_product_id,
    'effective_version_id', v_effective_version_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_product(UUID, JSONB, UUID, JSONB, JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_product(UUID, JSONB, UUID, JSONB, JSONB)
  TO authenticated;

-- 3. clone_version_as_draft: copy the input-capability columns too ---------

CREATE OR REPLACE FUNCTION public.clone_version_as_draft(
  p_source_version_id UUID
)
RETURNS public.product_versions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := (SELECT auth.uid());
  v_source public.product_versions;
  v_product_id UUID;
  v_next_version INT;
  v_new public.product_versions;
BEGIN
  IF v_user_id IS NULL OR NOT (public.is_admin() OR public.is_owner()) THEN
    RAISE EXCEPTION 'Forbidden: admin or owner required';
  END IF;

  SELECT * INTO v_source FROM public.product_versions WHERE id = p_source_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source version not found';
  END IF;

  v_product_id := v_source.product_id;

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_next_version
  FROM public.product_versions
  WHERE product_id = v_product_id;

  INSERT INTO public.product_versions (
    product_id, version_number, state, private_instruction_template,
    private_negative_instruction, provider_strategy, model_config,
    output_sizes, input_validation_config, input_mode, input_min_images,
    input_max_images, input_image_roles, prompt_override_enabled,
    prompt_max_chars, post_process_config, safety_config, credit_cost,
    created_by_admin_id
  )
  SELECT
    product_id, v_next_version, 'draft', private_instruction_template,
    private_negative_instruction, provider_strategy, model_config,
    output_sizes, input_validation_config, input_mode, input_min_images,
    input_max_images, input_image_roles, prompt_override_enabled,
    prompt_max_chars, post_process_config, safety_config, credit_cost,
    (SELECT auth.uid())
  FROM public.product_versions
  WHERE id = p_source_version_id
  RETURNING * INTO v_new;

  INSERT INTO public.admin_audit_logs (admin_user_id, action, entity_type, entity_id, before, after)
  VALUES (
    v_user_id,
    'product_version.clone_draft',
    'product_version',
    v_new.id,
    jsonb_build_object('source_version_id', p_source_version_id),
    jsonb_build_object(
      'product_id', v_product_id,
      'version_number', v_next_version
    )
  );

  RETURN v_new;
END;
$$;
