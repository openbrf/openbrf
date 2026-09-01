# Security posture

What the automated posture checks report, and what this project does about each
one. Written so that the code scanning dashboard means something: an alert that
stays open is work that has not been done, and an alert that is dismissed is a
decision recorded here.

The scanners are CodeQL and Semgrep, which report defects in this repository's
own code, and [OpenSSF Scorecard](https://github.com/ossf/scorecard), which
scores the project's supply-chain and process posture. A Scorecard finding is
not a vulnerability. It is a statement that a practice is absent, and some of
those practices need a second person or a different stage of the project.

Reviewed against the Scorecard run of 2026-09-01, the most recent completed
analysis of `main` at the time of writing.

## Suppressed scanner findings

A Semgrep finding that does not apply is suppressed with a `// nosemgrep:` line
above the code, naming the rule and saying why it does not hold. Those
suppressions do not reach the dashboard: the scan job drops any result carrying
an in-source suppression from the SARIF before it is uploaded, because code
scanning opens an alert for one instead of reading it as suppressed, and an
alert nobody can action is an alert everybody learns to ignore.

The reasoning for a suppression therefore lives beside the code it applies to,
where a reviewer changing that code sees it.

## Scorecard checks

| Check               | State                | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vulnerabilities     | Work, done           | GHSA-rgwj-5xj2-c3m3 in `mysql2`, whose compressed-protocol handler inflates a packet with no output cap, so a hostile server can expand a small packet into gigabytes of client memory. Fixed in 3.23.1. The Prisma CLI depends on `mysql2` at an exact 3.15.3 and better-auth resolves the same copy as an optional peer; no Prisma release carries a fixed version. This project speaks PostgreSQL and never opens a MySQL connection, so the handler is unreachable, but an override in `pnpm-workspace.yaml` moves the copy in the tree to the fixed line rather than leaving the advisory standing on that. |
| Pinned-Dependencies | Work, done           | The base image in `Dockerfile` is pinned by digest, and `.github/dependabot.yml` keeps the pins current. The `npm install --global pnpm@<version>` in the same file stays version-pinned rather than hash-pinned. npm does verify the tarball it downloads against the registry's `dist.integrity`, so what is missing is not integrity but reproducibility: a global install resolves its dependency tree at install time with no lockfile, so two builds of one commit can install two trees. Pinning it would mean corepack, which Node 26 no longer bundles and `CONTRIBUTING.md` forbids.                   |
| Branch-Protection   | Work, partly done    | The `protect-main` ruleset had the repository admin role as a bypass actor, set to bypass always, so every rule on it was advisory for the one person it applied to. That bypass is removed: the pull request, required checks, deletion and non-fast-forward rules now hold for everyone. The remaining warnings - required approvers, CODEOWNERS review, last-push approval - each need a second person with write access, and this project has one maintainer. Revisit when it has two.                                                                                                                       |
| Code-Review         | Accepted             | Scores approved changesets, of which there are none, for the same reason: nobody can approve their own pull request. Every change still goes through a pull request with seven required checks and an automated review, and unresolved review threads block merge.                                                                                                                                                                                                                                                                                                                                               |
| SAST                | Improving on its own | Scores the share of commits scanned. CodeQL and Semgrep run on every pull request and every push to `main`; the commits that count against the score predate the workflows. No action - the score follows the history.                                                                                                                                                                                                                                                                                                                                                                                           |
| Maintained          | Improving on its own | Scores activity, and fails only because the repository was created on 2026-08-27. Clears once it is 90 days old, around 2026-11-25. Left open rather than dismissed: a dismissal would also hide it if the project later went quiet, which is the thing the check is for.                                                                                                                                                                                                                                                                                                                                        |
| Fuzzing             | Accepted, for now    | No fuzzing integration. The inputs worth fuzzing are the CSV and Excel import parsers and the range parser, all of which take a file from a person who is already signed in as the board. Worth revisiting when an unauthenticated parser exists.                                                                                                                                                                                                                                                                                                                                                                |
| CII-Best-Practices  | Accepted             | No OpenSSF best practices badge. The badge is a self-certification questionnaire covering a release process, a vulnerability response record and a test history that a pre-release project does not have yet. Revisit at v1.                                                                                                                                                                                                                                                                                                                                                                                     |

## Dismissals

An alert marked Accepted above is dismissed on the dashboard as "won't fix",
with the reason naming this file. A dismissal is not a fix and does not mean the
finding was wrong; it means the practice is a deliberate choice recorded here,
and it keeps the dashboard showing what is still work.

Anything marked Improving on its own is left open, so that it closes when the
underlying fact changes rather than when somebody decides it has.
