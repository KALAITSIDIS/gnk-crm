# B3 — buyer proposal via expiring magic link (design)

Date: 2026-07-29 · Roadmap: `IMPROVEMENTS.md` §B3 · Migration: **0023**
Completes a documented-but-unbuilt Phase-1 entity: doc 01 §6.1 `share_links`.

---

## 1. What this is

A tokenised, expiring, **no-login** page showing a curated shortlist of
properties with photos, price, areas and the agent's contact card. Every open is
counted, and logged to `events` once per day, so the commission evidence chain
records that the buyer was shown these properties by this agency on this date.

Doc 01 §4 / CLAUDE.md guardrail 4 forbids buyer logins **ever**. Doc 01 §0.1
names the sanctioned replacement exactly: *"no-login magic-link proposal pages
(tokenized URL, expiry date, per-open view tracking)"*. This builds that, and
nothing wider.

`share_links` is listed in doc 01 §6.1 but exists in **no** migration and no DDL
in doc 03 — only the `share_link` slot in `ENTITY_TYPES` was ever added. This is
the same shape as B11 completing `retention_until`: finish the documented
entity, do not invent a new one.

---

## 2. Settled decisions (operator, 2026-07-29)

| # | Question | Decision |
|---|---|---|
| 1 | May a public token append to `events`? | **Yes, throttled** — counter every open, one event per token per Cyprus day |
| 2 | Scope | **Proposals now**, table built generic so document links slot in later |
| 3 | Token policy | Agent-set expiry (**default 14d**), revocable, **multi-open** |
| 4 | Language | **Agent picks en/el/ru per link** |

### Why a token may append where a CSP report may not

HANDOFF constraint 1 forbids `/api/csp-report` from ever writing to `events`:
an *anonymous* caller appending to a hash-chained log is indefensible. A share
link is different in kind — the token is a **bearer credential the agent
minted**, so the append is authorised by something the org issued. An invalid
token appends nothing at all.

The throttle is what keeps that defensible: a buyer refreshing on a train must
not be able to grow the evidence chain without bound. So the **counter** is
exact (every open bumps `view_count`), while the **event** is one per token per
Cyprus day — which is the granularity a commission dispute actually argues over
("you showed them this on the 14th"), not the granularity of page refreshes.

---

## 3. Schema (migration 0023)

```sql
create table share_links (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  kind          text not null default 'proposal' check (kind in ('proposal')),
  token_sha256  text not null unique,
  contact_id    uuid references contacts(id),
  locale        text not null default 'en' check (locale in ('en','el','ru')),
  title         text,
  message       text,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  revoked_by    uuid references profiles(id),
  view_count    int not null default 0,
  first_opened_at timestamptz,
  last_opened_at  timestamptz,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now()
);

create table share_link_properties (
  share_link_id uuid not null references share_links(id) on delete cascade,
  property_id   uuid not null references properties(id),
  sort_order    int not null,
  primary key (share_link_id, property_id)
);
```

- **The token is never stored.** Only `sha256(token)`. A database leak therefore
  yields no working links — the same reasoning as password hashing. Lookup is by
  hash, so it stays a single indexed equality probe.
- **`kind` is CHECK-constrained to `'proposal'` today.** Doc 01's second use case
  (lawyer/bank document links) widens the CHECK later without reshaping the
  table. Same discriminator pattern as `tasks.kind` in 0020.
- **`on delete cascade` on the join table only.** `share_links` rows are never
  deleted — revoked, like everything else here.

---

## 4. The public route

`/p/[token]` — a server component, deliberately **not** under `(app)`.

`proxy.ts` exempts it exactly as it exempts `CSP_REPORT_PATH`, and no wider:
a prefix match on `/p/`, nothing else.

### Anon never reads the table

The page calls one `security definer` RPC:

```sql
resolve_share_link(p_token_sha256 text) returns jsonb
```

which, in a single statement:
1. finds a link whose hash matches, is **not revoked** and **not expired**;
2. bumps `view_count`, sets `first_opened_at`/`last_opened_at`;
3. inserts an `opened` event **only if** no `opened` event exists for this link
   on today's Cyprus date;
4. returns **only allowlisted fields** — or `null`.

`grant execute … to anon` is deliberate here and will be flagged by the Supabase
advisor `0028_anon_security_definer_function_executable`. **That flag is expected
and correct** — it is the one function anon is meant to call. It is recorded in
`verify-restore.sql`'s grant table so the expectation is pinned rather than
rediscovered, and 0007's blanket lockdown is not silently contradicted.

The alternative — a service-role client in the route — was rejected: it would
give a public path the god role, where the RPC's capability is bounded to
"resolve one token".

### The exposure allowlist is explicit, never `select *`

**Exposed:** `reference`, `property_type`, `asking_price`, covered/plot area,
bedrooms, bathrooms, `features`, district + area name, `short_description` and
`public_description` **for the link's locale only**, and public media renditions
(the `media` bucket is already public, migration 0008).

**Never exposed:** `owner_net_price`, `min_acceptable_price`, `internal_notes`,
any mandate or commission field, the owner's contact, KYC, `documents`, and
every other property column. The allowlist lives in the RPC body, so the
boundary is enforced in SQL rather than trusted to a component.

**Archived properties drop out.** A property archived after the link was created
is omitted, and the page says so rather than 404-ing the whole proposal —
otherwise revoking one listing silently breaks an unrelated buyer's link.

### A dead link says nothing

Expired, revoked, unknown token and malformed token all render the **same**
neutral page and the same status. A prober learns nothing about which tokens
exist — the same reasoning that makes `/api/csp-report` always answer 204.

---

## 5. Rate limiting

The roadmap requires one. Being precise about what it is for:

- **Brute force is not the threat.** The token is 32 random bytes; guessing one
  is infeasible, and a limiter does not change that.
- **The real threats are log-flooding and casual scanning.** Both come from
  *failed* lookups, which is where the limiter belongs.

So: failures are counted per IP-hash per 15-minute bucket in a small
`share_link_attempts` table; past a threshold the route returns the same neutral
page without a further lookup. Legitimate opens never touch it. The table is
self-pruning (rows older than the window are deleted opportunistically).

**Stated honestly: this stops scanning and log-flooding, not a real DDoS.**
Platform-level protection (Vercel Firewall) is the answer to that and is an
operator decision, logged in BACKLOG rather than pretended at here.

---

## 6. Events (guardrail 1)

| event_type | entity | actor | when |
|---|---|---|---|
| `created` | `share_link` | agent | link minted |
| `opened` | `share_link` | **null** | first open per Cyprus day |
| `revoked` | `share_link` | agent | revoked |

`opened` carries `actor_id = null` because the opener is a buyer, not a user —
the same convention cron uses. Payload records `property_count` and `locale`,
never anything identifying about the viewer beyond the counter.

All three get `describeEvent` lines and en/el/ru translations with ICU plurals
(Russian one/few/many/other), or `messages.test.ts` fails CI.

---

## 7. Agent-facing UI

- **Create** from the contact page and the properties list: pick properties,
  locale, expiry (default +14d), optional message. The **token is shown exactly
  once**, with a copy button — it is unrecoverable afterwards, by design. Same
  one-shown-once pattern as the invite dialog (T-audit-settings §5).
- **Manage** at `/share-links`: live / expired / revoked, view counts, last
  opened, one-click Revoke.

---

## 8. Testing

- **Unit:** token generate/hash, expiry + revocation state machine, the locale
  field picker, the exposure allowlist shape.
- **RLS (new test 25):** an agent sees only their org's links; anon cannot
  `select` `share_links` **at all**; anon *can* call `resolve_share_link`; a
  revoked and an expired token both return null; a valid token returns only
  allowlisted keys — asserted as an exact key set, so a future `select *` fails
  the test rather than leaking.
- **Cron/throttle proof (psql fixture):** two opens in one day → `view_count` 2,
  exactly **one** `opened` event; an open the next day → a second event;
  `verify_events_chain` true throughout.
- **E2E:** create a link, open `/p/<token>` in a **logged-out** context, assert
  the properties render and no private field appears anywhere in the DOM; revoke
  it; assert the neutral page. Plus the anon gate on `/share-links` in
  `security.spec.ts`.

---

## 9. Deployment

0023 is a production write and needs explicit go-ahead, applied **before** the
code deploys (HANDOVER §4). `get_advisors` must be run afterwards — 0021 was
caused by exactly this step being skipped, and this migration deliberately adds
an anon-executable function, so the new advisor entry must be confirmed as *the
expected one* and not a second surprise.

---

## 10. Out of scope (→ BACKLOG)

- **Lawyer/bank document links** — doc 01's second `share_links` case. Exposes
  the private `documents` bucket publicly; needs signed URLs and per-document
  visibility rules. The `kind` column is ready for it.
- OG/social preview image generation for a proposal.
- A PDF rendering of the proposal (the `@react-pdf/renderer` stack exists).
- Buyer-side interaction (shortlisting, "I like this one") — that is a portal
  by another name and needs its own decision against guardrail 4.
- Vercel Firewall / platform rate limiting.
