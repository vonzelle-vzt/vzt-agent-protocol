---
name: vzt-mobile-release
description: "Mobile store release doctrine — getting an app to real phones on the App Store and Google Play, not just to 'approved'. Use before any `eas build` / `eas update` / `eas submit`, any app version bump, a store rollout, when an in-app 'update available' banner is wrong or silent, when a store submission is refused by a policy declaration, or when setting up Play service-account credentials. Encodes the failure shapes that are SILENT: approval that reaches nobody, an OTA published into an audience of zero, a permission a dependency added for you, and release notes that claim a feature the platform does not have."
---

# Mobile store release — approval is not delivery

Every failure in this document is silent. Nothing errors, no test goes red, the
dashboard is green, and users are simply not receiving the thing you shipped.
That is the whole reason the doctrine exists: on a store release the absence of
an error is not evidence of success, and you must go and *measure* the outcome.

## 1. Three events, not one

Shipping is not one event. It is three, and each can succeed while the next
never happens:

1. **The store approves the build.**
2. **The storefront starts serving it** — a different moment, sometimes hours later.
3. **Users are told** — the in-app "update available" surface, which is usually
   driven by a row in *your* database that nothing updates on its own.

Check all three, separately. A release that is approved and served but not
announced is invisible to everyone who already has the app — which is everyone
who matters.

> Measured: a storefront switched to a new version while the release row still
> named the previous one. `updateAvailable` was FALSE for **every** install
> until someone ran the sync by hand. Twice, on two different releases.

**The storefront is the only authority on what a stranger downloads right now.**
Not the console, which shows your intent. Ask the public listing:

```bash
curl -s "https://itunes.apple.com/lookup?id=<APP_ID>&country=us&t=$(date +%s)" | jq '.results[0].version'
# Play has no API for this — scrape the signed-out listing, and fail LOUD if the
# pattern breaks. A silent "unknown" reads as "no drift", which is the failure
# you were checking for.
```

## 2. An OTA reaches exactly one runtime

With `runtimeVersion: { policy: "appVersion" }`, an install only receives
updates published at **its own** version. So:

- **A version bump orphans everyone on the old version.** They keep receiving
  nothing until they install a new store binary. Publishing feels healthy the
  whole time — the channel is up, updates are going out, into an audience of zero.
- **Ship to every runtime people are actually on**, not just the newest.
- **Never OTA a JS change that needs native code the live binary lacks.** Adding
  a native dependency after a binary was cut and then OTA-ing to it throws at
  import on that binary.

**Verify the published bundle carries its build env.** An OTA published without
the production environment silently ships a build with the flags unset — which
has switched off the ability to pay. Hermes bytecode is binary, so `grep` finds
nothing and looks like proof of absence:

```bash
strings dist/**/*.hbc | grep -c "<a value only the production env sets>"   # NOT grep
```

## 3. Store declarations gate the API — and one of them is a deadlock

A permission you never wrote can reach the merged manifest from a dependency's
AAR. It is not in your app config, so nobody sees it until the store refuses the
upload.

The Play **foreground-service** declaration is the worst shape, and it is a true
deadlock for the API path:

- The declaration does not appear in the Console until a bundle declaring those
  permissions is **saved into a release through the Console**.
- The API cannot commit such a bundle **without** the declaration.
- A failed commit **rolls the edit back** — the bundle never even lands in the
  bundle library, so there is nothing to promote later.
- `changesNotSentForReview: true` does **not** bypass it.
- Uploading by hand surfaces the form, which then demands a **demo video link
  per permission**, recorded on a real device.

Two ways out. Either upload once by hand and answer it, or **remove the
permission and the feature that needs it** and ship the rest.

Inspect what you are actually shipping rather than arguing with the console:

```bash
unzip -q -o app.aab -d x base/manifest/AndroidManifest.xml
strings x/base/manifest/AndroidManifest.xml | grep -i FOREGROUND_SERVICE
```

## 4. A capability gate and its permissions must move together

If you gate a feature off per platform, the permissions it needed must come out
with it — and back in with it. **Both directions ship rather than fail a build:**

| | permissions present | permissions stripped |
|---|---|---|
| **feature on** | correct | throws at `startForeground` on Android 14+, in the field |
| **feature off** | store refuses every upload | correct |

Neither is caught by a typechecker or by running the app on the other platform.
So **grade the coupling from source** — read both files in a test and assert
they agree — and prove the test bites by breaking the coupling on purpose and
watching it fail. An oracle you never saw fail is not an oracle.

Use **one gate constant**, not per-screen platform checks: those drift, and a
leftover entry point is a crash rather than a cosmetic slip. Gate the entry
points *and* redirect the route itself — deep links, typed-route pushes and
stale OTA bundles all still arrive.

## 5. Play credentials — the chain nobody documents

`eas submit --platform android` needs a service-account JSON. Expect this chain:

1. **You may be looking at the wrong developer account.** The bare Play Console
   URL lands on the first signed-in Google account — which can be a *closed*
   developer account, making the whole thing look dead. Find the account that
   actually owns the listing (`/console/u/0/`, `u/1/`, `u/2/`…) and confirm the
   developer name matches the public listing.
2. Create a GCP project, enable **Google Play Android Developer API**, create a
   service account. **No IAM role is needed** — Play grants access its own way.
3. **`iam.disableServiceAccountKeyCreation` is on by default** in many orgs
   (Google secure-by-default). Key creation is refused. The fix is a
   **project-scoped override**, leaving every other project protected.
4. Setting that override needs `roles/orgpolicy.policyAdmin`, which **cannot be
   granted at project scope** — organization or folder only. The role can be
   revoked afterwards; the override survives.
5. Grant the service account access in **Play Console → Users and permissions**,
   scoped to the one app, release permissions only — never admin or financial.
6. Store the key where it cannot be committed (`credentials/` in `.gitignore`,
   `chmod 600`) and verify: `git check-ignore -v <path>`.

Do **not** enter passwords or paste principals into IAM forms on someone's
behalf; hand those specific clicks back to the human.

## 6. Release notes are claims, and platforms differ

Store copy and in-app release notes are load-bearing. Verify each claim against
the code **for the platform you are writing about** before it ships.

> A near-miss: iOS notes said uploads continue while the phone is locked. On
> Android that path was gated `Platform.OS !== 'ios' → null`. Copying the iOS
> copy across would have shipped a false store claim.

```bash
grep -rn "Platform.OS" src/data/<the-feature>.ts   # who actually gets this?
```

Also: if the app renders a server-supplied string (release notes, notifications)
verbatim, that string is subject to the same store policy as your UI. Never
paste store marketing copy into a database field the app prints.

## 7. Build from a clean tree, verify the artifact

- If the working tree carries someone else's unfinished work, **build from a
  clean `git worktree` at your commit** so it cannot leak into a store binary.
  Run a real `npm ci` there; never symlink `node_modules` (it gets committed).
- **Stage only your own files.** Check `git status` before `git add`.
- **Verify the artifact, not the build log.** Download the built binary and
  inspect it. Include a *control* — something that should still be present — so
  a passing check cannot be a broken extraction.

## 8. Announce it, but only what the storefront serves

If you pre-stage a release row before the store serves it, make sure the status
you use is one your "update available" query **excludes** (a `DRAFT`-like
state). Announcing early points users at a store that still hands them the old
binary — a dead-end card.

## Checklist

```
[ ] Storefront (public listing) actually serves the version — not the console
[ ] In-app update row matches the storefront; users on older versions are told
[ ] OTA published to EVERY runtime with live users; env verified via `strings`
[ ] No native dependency added since the live binary was cut
[ ] Store policy declarations answered, or the permission removed with its feature
[ ] Gate ↔ permission coupling graded from source, negative control seen failing
[ ] Release notes verified per platform against the code
[ ] Built from a clean tree; artifact inspected with a control
[ ] Store parity: both stores in step, or you can name which lags and why
```
