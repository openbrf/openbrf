---
"@openbrf/api": patch
---

The image ships fast-uri 3.1.9 and 4.2.3 and brace-expansion 5.0.12, past the
published advisories against the earlier releases (GHSA-hrr3-gc8f-f4qj,
GHSA-jvvf-x445-j334, GHSA-6j4f-fj2g-mc7p, GHSA-q2hr-2g5m-vwhr and
GHSA-qhr7-859c-m2p7). Both are installed as dependencies of the API server's
own dependencies: fast-uri through Fastify's schema compilers, brace-expansion
through glob.
