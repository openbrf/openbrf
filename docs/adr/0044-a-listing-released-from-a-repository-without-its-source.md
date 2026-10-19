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
nor the public can read, and the catalog, which holds the attestation to the
release repository and its own release workflow, refuses it. That workflow is
public, so anyone can read how it fetched the source and which build it ran.
The build's own steps, such as the package's scripts, are in the source and
are as private as it is.

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
while the tarball's bytes are fixed by the digest the entry states. The record
travels with the bytes every instance installs, and cannot change after the
release.

The attestation does not prove the record. It says that the release workflow
produced these bytes, and that workflow also writes `source.json`, so the
record is the author's statement of the source, not something GitHub signed
for. Two rules keep that statement from borrowing anyone else's:

- **The record is the release repository's pin.** The release repository keeps
  its own `source.json` at its root, moved by a reviewed pull request for each
  release, and the release workflow copies it into the package unchanged. The
  catalog reads that file at the commit the attestation names as the source,
  and refuses the package unless its `source.json` has the same bytes. A
  package without one is refused when the release repository pins one. The
  record is then a commit in the public history of the repository that signed
  the package.
- **The source it names is not public.** A package whose source is public is
  released from the repository the source is in (ADR 0020), so a record naming
  a public repository would only borrow that repository's name. The catalog
  asks GitHub whether the repository is public and refuses the record if it is.
  GitHub does not tell a private repository from one that does not exist, so a
  record naming a repository nobody can read passes: it misleads no one who
  cannot read the source, and whoever can, can tell. The nightly run asks
  again, so a source made public later is refused then.

The catalog's check also refuses a `source.json` that is not a JSON object with
exactly those two fields, each named once; a `repository` that is not exactly
`https://github.com/<owner>/<repository>`, without `.git`, a trailing slash or a
further path; a `repository` that is the release's own repository; and a
`commit` that is not a full commit id: 40 or 64 lowercase hexadecimal
characters. The source is on GitHub because GitHub is the host the check can
ask whether a repository is public. A package without the record, from a
release repository that pins none, was built from the commit its attestation
names, in the repository the release is in, as before.

The check cannot read a private source, so it holds the record to its form and
not to the commit's existence, nor to the tarball being what that commit builds
to. What binds them is the release workflow, which is public and attested.
Whoever can read the source, a licensee or an auditor, can check out that commit
and build it with the same steps. A build that is not reproducible is traceable
to its commit, not proven equal to it.

### The release workflow of a release-only repository

The commit to build is pinned in a reviewed commit of the release repository:
its own `source.json`, moved by a pull request for each release, with the tag
pushed on the merge. A tag ruleset lets only the repository's maintainers
create a `v*` tag, and nobody move or delete one. The workflow reads the pin at
the tagged commit, checks out exactly that commit of the source, builds and
packs the package with the pin copied in unchanged, attests the tarball and
publishes the release.

Reading the source takes a credential. The rules for it are exact, because the
looser readings of them isolate nothing:

- It is an **environment secret**, of an environment whose deployment rule
  allows only `v*` tags. A repository secret is open to every workflow and job
  in the repository, whatever environment a job names.
- It reads the one source repository and nothing else: a read-only deploy key
  on the source repository, a GitHub App installation token minted in the run
  for that repository alone with `contents: read`, or a fine-grained personal
  access token limited to that repository with `contents: read`. Never a
  classic personal access token, whose `repo` scope reads and writes every
  repository its owner can reach.
- The source is checked out with `persist-credentials: false`, so the
  credential is not left in `.git/config` for the build to read.
- Building and attesting are separate jobs. The job that holds the credential
  checks out and builds, without the `id-token` and `attestations`
  permissions; the job that attests and publishes has those permissions and not
  the credential, and takes the tarball from the first.

The credential is never in the package, the release or the catalog, and no
credential is added to the catalog or to an instance: the artifact stays a
public download.

## Consequences

- An author can list a package whose source they do not publish. The built
  package is public, as every listed tarball is, and a plugin's server bundle is
  read by a person before its listing is merged.
- The check cannot tell a release-only repository that pins nothing and leaves
  `source.json` out from a repository that holds its source. The maintainer
  reviewing the listing looks at the repository, and refuses a release-only
  listing without the record.
- For a private source the record stays the author's word, pinned in public
  history. Only someone who can read the source and rebuilds the commit can
  check it.
- The release repository holds a credential that reads the source. A leak of it
  discloses the source. Held as above, it publishes nothing the catalog
  accepts, which only takes a tarball the public workflow attested on a tag.
  The build runs the source's own code with the credential present, which
  this design cannot avoid.
- A record naming a source on another host than GitHub is refused until the
  check can ask that host whether a repository is public.
- `source.json` at a package's root, and at the root of the repository it is
  released from, means this, so a package or repository carrying one for
  another purpose is refused until the file is renamed.
- Nothing changes for an instance. It does not read `source.json`, and verifies
  the digest as ADR 0020 states.

## Revisit triggers

- **Attestations verified in the instance** (ADR 0020's trigger): whether the
  instance also shows the board the source commit of a release-only listing,
  as text the author wrote rather than as a link.
- **A source on another host**: whether the check learns to ask that host
  whether a repository is public, so that a record naming it can be accepted.
- **Reproducible builds**: once a release workflow builds reproducibly, whether
  a licensee's rebuild of the named commit is something the catalog asks for.
