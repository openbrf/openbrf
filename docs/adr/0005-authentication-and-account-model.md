# ADR 0005: Authentication, the account model and the 2FA policy

Date: 2026-08-28

## Status

Accepted

## Context

An Open BRF instance holds a statutory register. Who may sign in, and how, is
therefore not a matter of taste: the member register is public on request but the
apartment register is confidential, protected personal data has to stay masked,
and every reveal is recorded against a named person. All of that rests on the
account model underneath it.

The people who need accounts do not fit one shape. A member holds the
tenant-ownership of an apartment. A resident lives in one without holding it - a
partner, a child of thirteen or more, a tenant. An external board member may
have no connection to the building at all, and a housing cooperative is entitled
to seat one. An administrator may be any of those, or none.

The library is Better Auth, which supplies password, magic link, passkeys and
TOTP. Its two-factor plugin gates password sign-in and nothing else, which
matters more than it first appears: a magic link would otherwise be a way past
an enrolled second factor, reachable by anyone who reaches the mailbox.

## Decision

### The person is the record; the account is optional

`Person` is the register entry. `UserAccount` is Better Auth's user, linked to
exactly one person. A person needs no account, no residency and no membership,
and the three are independent:

- **Membership is derived**, never stored as a flag. A person is a member while
  they hold at least one current member-residency. The statutory exit entry is
  written when the last one ends.
- **An external board member is a plain person** with no apartment. Nothing in
  the invitation or the account path treats them as a special case, which is
  what makes seating one a normal act rather than a workaround.
- **Better Auth keeps its own tables.** Credentials, passkeys and TOTP secrets
  live there and are not forked into the domain schema. The link is a
  `personId` on the account.

Authorization is separate again: capabilities are derived per request from the
person's system roles, board positions and residencies. Nothing is granted by
having signed in, and every route is guarded by default.

### How an account comes to exist

There is no open registration. Three paths, and only three:

1. **The first administrator**, created by the setup wizard while the instance
   is unclaimed. Unclaimed means no account exists and setup has never been
   completed. From its second screen the wizard is admin-only, because a
   first-boot wizard that stayed open would be a way to create an account on an
   instance holding a register.
2. **An invitation**, sent by the board or an admin to a person who is already
   in the register. The invitation carries only a person id; it grants no role
   and confers no residency. Activation sets a password against a token that is
   stored hashed and expires in fourteen days.
3. **A sign-up request**, when the cooperative has switched that on. The
   default is off. A visitor types their address and apartment number as free
   text - free text on purpose, because the form is public and must not let a
   stranger enumerate the building - and the board matches the claim against the
   register when it decides. Approval creates or links the person, writes the
   residency and sends the ordinary invitation, so activation is one path rather
   than two.

### The 2FA policy

**A magic link is refused for an account with TOTP enrolled. Passkeys are
unaffected.**

A magic link grants a session on mailbox access alone. For an account whose
owner has deliberately added a second factor, that is a bypass, and Better
Auth's two-factor plugin does not close it: it gates password sign-in only. The
refusal is therefore ours, in the delivery path, and it sends the mailbox owner
an explanation instead of a link.

A passkey is exempt because it is not a weaker factor waiting to be
strengthened. It is a hardware-held private key bound to this origin, so it is
phishing-resistant in a way a password with a one-time code is not. Requiring a
code after one would trade a stronger method for a weaker one and teach people
to reach for the password instead.

### What the public endpoints admit

Sign-in reports the same outcome whether an address is unknown, the password is
wrong, or the account exists. The magic link endpoint reports success for every
address, including one it refused to send to. On an instance holding a member
register, "does this address have an account" is not a question a public
endpoint answers, and neither is "does this account have a second factor".

Sessions are http-only cookies, `Secure` in production, issued for the
instance's own origin - which is why the API serves the client rather than a
second origin doing it. Auth endpoints are rate-limited per client.

## Consequences

- **Email is load-bearing.** Invitations, activation and magic links all go
  through SMTP, so an instance with no email settings cannot bring anyone else
  in. The setup wizard says so where it can be skipped, and the settings screen
  repeats it.
- **A member of a cooperative can hold several residencies**, and one person may
  be a member of one apartment and a resident of another. The account is
  unaffected; the capabilities follow the union.
- **Two accounts for one person are impossible by construction** - the link is
  one to one - and re-inviting someone who already has an account is refused
  rather than silently creating a second.
- **TOTP narrows the recovery paths.** A member who enrols an authenticator app
  and then loses the phone cannot fall back to a magic link. Recovery codes are
  issued at enrolment and shown once; an admin reset path is not built, which is
  a real gap for a volunteer board and is named here rather than discovered.
- **Passkey sign-in needs a secure origin.** `localhost` counts; a plain-http
  address on a server does not. The deployment documentation puts TLS in front
  of the instance for that reason as much as for confidentiality.
- **OIDC is not in phase 1**, and BankID is a paid module. Both are additions to
  this model rather than replacements for it.

## Revisit triggers

- **Recovery becomes a support burden.** A board-initiated second-factor reset
  is the obvious next step, and it needs its own record: it is an admin who can
  remove someone else's second factor, which is a capability worth naming.
- **Better Auth changes its two-factor gating** so that magic link is covered
  upstream. The refusal in the delivery path can then become a check rather than
  a policy.
- **A cooperative asks for enforced two-factor for the board.** The model
  supports it - capabilities are derived per request - but the policy above says
  nothing about requiring a factor, only about which ones may be combined.
