-- A button names a built-in page the way it names any page: by the page's id.
--
-- The version before this one named the news, the calendar and the broker
-- information page by a key of their own, { "kind": "builtIn", "page": "news" },
-- and led it to the address the product serves the page at. Those pages are
-- rows now, at the same addresses, so every such destination becomes
-- { "kind": "page", "pageId": "built-in-news" } and leads where it led, to
-- everybody it was shown to: a built-in page is public, as the key's page was.
--
-- A destination is rewritten only where a page's body holds one: a button
-- block, a banner's button, and a button in a column. A key no version offered
-- is left as it is - it was never rendered, and the reader still drops it.
-- Neither the revision nor updatedAt moves: the board changed nothing, and
-- every page reads as it did the day before.
--
-- The two functions are this migration's own and are dropped at its end.

CREATE FUNCTION public.openbrf_button_target_as_page(target jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT CASE
        WHEN jsonb_typeof(target) = 'object'
            AND target ->> 'kind' = 'builtIn'
            AND target ->> 'page' IN ('news', 'calendar', 'broker')
        THEN jsonb_build_object(
            'kind', 'page',
            'pageId', CASE target ->> 'page'
                WHEN 'news' THEN 'built-in-news'
                WHEN 'calendar' THEN 'built-in-calendar'
                WHEN 'broker' THEN 'built-in-broker-information'
            END
        )
        ELSE target
    END
$$;

-- Each block of a list with its destinations rewritten, in the order they
-- stand. A columns block's columns are lists of their own, and are rewritten
-- the same way.
CREATE FUNCTION public.openbrf_button_targets_in_blocks(blocks jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF jsonb_typeof(blocks) IS DISTINCT FROM 'array' THEN
        RETURN blocks;
    END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(
            CASE
                WHEN jsonb_typeof(block) IS DISTINCT FROM 'object' THEN block
                WHEN block ->> 'type' = 'button' AND block ? 'target' THEN
                    jsonb_set(
                        block,
                        '{target}',
                        public.openbrf_button_target_as_page(block -> 'target')
                    )
                WHEN block ->> 'type' = 'banner'
                    AND jsonb_typeof(block -> 'button') = 'object'
                    AND block -> 'button' ? 'target' THEN
                    jsonb_set(
                        block,
                        '{button,target}',
                        public.openbrf_button_target_as_page(
                            block -> 'button' -> 'target'
                        )
                    )
                WHEN block ->> 'type' = 'columns'
                    AND jsonb_typeof(block -> 'columns') = 'array' THEN
                    jsonb_set(
                        block,
                        '{columns}',
                        COALESCE((
                            SELECT jsonb_agg(
                                CASE
                                    WHEN jsonb_typeof("column") = 'object'
                                        AND "column" ? 'blocks' THEN
                                        jsonb_set(
                                            "column",
                                            '{blocks}',
                                            public.openbrf_button_targets_in_blocks(
                                                "column" -> 'blocks'
                                            )
                                        )
                                    ELSE "column"
                                END
                                ORDER BY "columnPosition"
                            )
                            FROM jsonb_array_elements(block -> 'columns')
                                WITH ORDINALITY AS "columns" ("column", "columnPosition")
                        ), '[]'::jsonb)
                    )
                ELSE block
            END
            ORDER BY "position"
        )
        FROM jsonb_array_elements(blocks)
            WITH ORDINALITY AS "list" (block, "position")
    ), '[]'::jsonb);
END;
$$;

-- Only the bodies that can hold one: a body without the key has nothing to
-- rewrite, and is left byte for byte as it was.
UPDATE "page"
SET "content" = jsonb_set(
    "content",
    '{blocks}',
    public.openbrf_button_targets_in_blocks("content" -> 'blocks')
)
WHERE jsonb_typeof("content" -> 'blocks') = 'array'
  AND "content"::text LIKE '%"builtIn"%';

DROP FUNCTION public.openbrf_button_targets_in_blocks(jsonb);
DROP FUNCTION public.openbrf_button_target_as_page(jsonb);
