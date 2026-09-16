# Dev Issues

## Dependency alerts — resolved 2026-09-16

The 19 Dependabot alerts (6 high, 11 medium, 2 low) are down to **1 moderate**.

Most of them came in transitively through `@google/genai`, which was leftover
AI Studio scaffolding with zero references anywhere in the source. Removing it
and regenerating the lockfile cleared `ip-address`, `protobufjs`, `qs`,
`nanoid`, `browserslist`, `postcss` and the rest.

```
$ npm audit
pkg  *  Severity: moderate
Pkg Local Privilege Escalation - GHSA-22r3-9w55-cj54
No fix available
1 moderate severity vulnerability
```

### The one remaining alert: `pkg`

`pkg` is archived upstream and the advisory has no fix. It is a
**devDependency used only at release time**, so it is not part of anything
shipped to users, and the LPE requires local access to the build machine.

Left in place deliberately rather than swapped out, because replacing it
changes how binaries are distributed. Two options when you want it gone:

1. **Drop the single-file executables** and keep only the portable packages the
   release workflow already builds. Those bundle an official signed Node.js
   binary, which is also what the release notes tell users to fall back to when
   SmartScreen or WDAC blocks the `pkg` output. This is the smaller change.
2. **Migrate to Node SEA** (`node --experimental-sea-config`), which is the
   maintained successor and keeps the single-file story intact.

### A note on the original triage

The earlier version of this file called `ip-address` the priority because the
app does peer-to-peer networking. The instinct was right but pointed at the
wrong layer: `ip-address` was only ever transitive build tooling and never
touched a routing decision here. The actual IP trust-boundary bug was in this
repo's own `isLocalIp` / `ipsMatchForDiscovery` logic, where every client
behind a reverse proxy resolved to a private address and therefore landed in a
single shared discovery group. No `npm audit fix` would have found it. It is
fixed in `server.ts` now — see `resolveDiscoveryMode()`.

Live list: https://github.com/zihaaaad/SendFiles/security/dependabot

---

## Known limitations (not bugs, but worth knowing)

- **Direct Beam ECDH is unauthenticated.** A malicious signalling server could
  MITM the key agreement. The six-digit safety code on both screens is the
  mitigation; comparing it is a manual step.
- **Relay throughput is stop-and-wait.** The WebSocket fallback waits for an
  ACK per 1 MB chunk, so throughput is bounded by round-trip latency. A
  windowed ACK scheme would help if the relay path matters to you.
- **Transfer resume is not implemented.** `resumeChunkIndex` exists in the
  protocol and is always sent as 0. An interrupted transfer restarts the
  current file.
- **License headers say Apache-2.0 but `LICENSE` is MIT.** Someone should
  decide which is intended; this was not changed here.
