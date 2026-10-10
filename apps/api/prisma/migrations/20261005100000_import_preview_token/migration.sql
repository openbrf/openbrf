-- Ties an apply to the preview it was decided against.
--
-- A preview overwrites the session's mapping and its rows needing a decision,
-- and the apply ran whatever the session held when it was claimed. A second
-- preview of the same upload - another tab, another board member - between
-- one screen's preview and its apply therefore had that screen's decisions
-- applied under a mapping it never showed. Each preview now records a token,
-- returns it, and the apply is claimed only with the same token.
ALTER TABLE "import_session" ADD COLUMN "previewToken" TEXT;
