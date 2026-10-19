# ADR 0044: A listing released from a repository without its source

Date: 2026-10-19

## Status

Accepted. Amends [ADR 0020](0020-the-public-catalog-and-the-published-packages.md)
on which repository a listed tarball is released from.

## Context

ADR 0020 lists a tarball only as an asset of an immutable GitHub release of the
repository its source lives in, attested by that repository's release workflow.
An instance and the catalog's check download the tarball without credentials:
`OPENBRF_CATALOG_TOKEN` is sent only to the index's own origin, and the curated
index needs none. A private repository's release assets cannot be downloaded
without one, so under that rule a listed package's source is public.

A paid plugin may be licensed on terms that show its source to licensees and
not to the public. Its tarball still has to be a public download. An artifact
origin that asks for a credential per licence would put a network request in
front of a licence meant to be verified offline, and publishing the source
changes the terms it is licensed on. What is left is to release the built
package from a public repository that holds no source, and to keep the build
traceable to the source it was made from.

The provenance ADR 0020 asks for rests on the attestation: GitHub signs that a
run of a workflow in a named repository, on a named tag, produced these bytes.
Where the source is in that repository, the commit the attestation names is the
source. Where it is not, the attestation says which workflow made the tarball
but not from what.

## Decision

### The listing's own repository

A listed tarball is an asset of an immutable GitHub release of the listing's own
public repository. That is either the repository its source lives in or a
**release-only repository**: a public repository that holds the release
workflow and builds the package from source kept elsewhere. Every other rule of
ADR 0020 holds for both: the tag `v<version>`, a release that is neither a draft
nor a pre-release, its immutability, the digest and size, the package agreeing
with its entry, the package check or the install lint, and a person reading a
plugin's server bundle before its listing is merged.

The build attestation comes from the release workflow of the repository the
release is in, in a run on its tag, on a GitHub-hosted runner, as before. A
workflow in the source repository could attest the bytes and upload them to the
public release, but its signer would then be a repository neither the catalog
nor the public can read, and `gh attestation verify --repo <owner>/<repo>`,
which the catalog runs with the release's repository, refuses it. The release
repository's workflow is public, so anyone can read how it fetched the source
and what it did with it.

### The package names the commit it was built from

A package released from a release-only repository carries a `source.json` at
its root naming the repository its source is in and the full commit id it was
built from:

```json
{
  "repository": "https://github.com/<owner>/<source repository>",
  "commit": "<full commit id>"
}
```

The record is in the tarball rather than in the release notes because the title
and notes of an immutable release can still be edited after it is published,
while the tarball's bytes are fixed by the digest the entry states and covered
by the attestation. The record is signed with the build and travels with the
bytes every instance installs.

The catalog's check refuses a `source.json` that is not a JSON object with
exactly those two fields, a `repository` that is not an https address written
without credentials, query or fragment, a `repository` that is the release's
own repository, and a `commit` that is not a full commit id: 40 or 64 lowercase
hexadecimal characters. A package without one was built from the commit its
attestation names, in the repository the release is in, as before.

The check cannot read a private source, so it holds the record to its form and
not to the commit's existence, nor to the tarball being what that commit builds
to. What binds them is the release workflow, which is public and attested.
Whoever can read the source, a licensee or an auditor, can check out that commit
and build it with the same steps. A build that is not reproducible is traceable
to its commit, not proven equal to it.

### The release workflow of a release-only repository

The commit to build is pinned in a reviewed commit of the release repository:
its own `source.json`, moved by a pull request for each release, with the tag
pushed on the merge. The workflow reads the pin at the tagged commit, checks
out exactly that commit of the source, builds and packs the package with the
pin copied in, attests the tarball and publishes the release.

Reading the source takes a credential, kept as a secret of the release
repository. It reads the one source repository and nothing else, and is
available only to the release job, through an environment whose deployments are
limited to `v*` tags. It is never in the package, the release or the catalog,
and no credential is added to the catalog or to an instance: the artifact stays
a public download.

## Consequences

- An author can list a package whose source they do not publish. The built
  package is public, as every listed tarball is, and a plugin's server bundle is
  read by a person before its listing is merged.
- The check cannot tell a release-only repository that leaves `source.json` out
  from a repository that holds its source. The maintainer reviewing the listing
  looks at the repository, and refuses a release-only listing without the
  record.
- The release repository holds a credential that reads the source. A leak of it
  discloses the source; it does not publish anything the catalog accepts, which
  only takes a tarball the public workflow attested on a tag.
- `source.json` at a package's root means this, so a package carrying one for
  another purpose is refused until the file is renamed.
- Nothing changes for an instance. It does not read `source.json`, and verifies
  the digest as ADR 0020 states.

## Revisit triggers

- **Attestations verified in the instance** (ADR 0020's trigger): whether the
  instance also shows the board the source commit of a release-only listing.
- **A release-only listing from outside the organization**: whether the check
  also requires the release repository's own `source.json`, at the commit the
  attestation names, to match the package's, instead of the README asking for
  it.
- **Reproducible builds**: once a release workflow builds reproducibly, whether
  a licensee's rebuild of the named commit is something the catalog asks for.
