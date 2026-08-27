<!-- PR title must follow Conventional Commits (it becomes the squash commit message), e.g. "feat(register): add move-out purge date". Everything in English. -->

## What and why

<!-- What does this change, and why? Link the issue: Closes #123 (required for features). -->

## Checklist

- [ ] PR title follows Conventional Commits
- [ ] Feature/larger change: linked to an approved issue
- [ ] Tests: regression test for bug fixes, core-logic tests for features (`pnpm test` passes)
- [ ] Changeset added for user-visible changes (`pnpm changeset`)
- [ ] No hardcoded user-facing strings (i18next keys) and no hardcoded colors (tokens only)
- [ ] New domain terms added to GLOSSARY.md
- [ ] No AI attribution in commits or this PR (see CONTRIBUTING.md)

## UI changes only

<!-- Delete this section if no UI is touched. Rules: DESIGN.md. -->

- [ ] Screenshots below in **both light and dark theme**
- [ ] WCAG AA contrast holds; states carry label + pattern, not color alone

| Light | Dark |
| --- | --- |
| | |
