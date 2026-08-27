# CLA signatures

This branch exists only to store Contributor License Agreement signatures. It
holds no source code, and nothing here is part of the product.

`signatures/cla.json` is written by
[contributor-assistant/github-action](https://github.com/contributor-assistant/github-action),
configured in `.github/workflows/cla.yml` on the default branch. Each entry
records that a contributor commented their agreement on a pull request.

Two things to know before touching this branch:

- **Do not protect it.** The action has to commit here, and a ruleset covering
  it makes every signature attempt fail.
- **Do not rewrite its history.** The signatures are the record that permission
  was given, so they are append-only in practice even though nothing enforces
  that technically.

The agreement itself is [CLA.md](https://github.com/openbrf/openbrf/blob/main/CLA.md)
on the default branch. Note that its wording is still provisional pending legal
review, and that external pull requests are not being accepted yet - see
CONTRIBUTING.md.
