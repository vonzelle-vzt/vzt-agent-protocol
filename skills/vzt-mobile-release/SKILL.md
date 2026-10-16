---
name: vzt-mobile-release
description: "Mobile store release doctrine — getting an app to real phones on the App Store and Google Play, not just to 'approved'. Use before any `eas build` / `eas update` / `eas submit`, any app version bump, a store rollout, when an in-app 'update available' banner is wrong or silent, when a store submission is refused by a policy declaration, or when setting up Play service-account credentials. Encodes the failure shapes that are SILENT: approval that reaches nobody, an OTA published into an audience of zero, a permission a dependency added for you, and release notes that claim a feature the platform does not have. Also covers OTA env (`eas env`), ota:safety, Play's foreground-service declaration, and the program-gated Android web-billing link-out."
---

# Mobile store release — approval is not delivery

> **Source of truth:** `vzt-protocol-mobile/.claude/skills/mobile-release-delivery.md`
> (protocol v1.6.0). This copy is downstream — edit there first, then copy here.

## When to Use This Skill

Use this before any `eas build`, `eas update` or `eas submit`, any app version bump,
and any store rollout. Use it when an in-app "update available" row is wrong or
silent, when a store refuses an upload over a policy declaration, and when you set up
Play service-account credentials.

Every failure here is silent. Nothing errors, no test goes red, the dashboard stays
green, and users never receive what you shipped. An absent error is not evidence of
success on a store release. Go and measure the outcome.

## Key Patterns

### 1. Three events, not one

Shipping is three events, and each can succeed while the next never happens:

1. **The store approves the build.**
2. **The storefront serves it.** This lands hours after approval.
3. **Users hear about it.** The in-app "update available" surface reads a row in
   your database, and nothing updates that row on its own.

Check all three separately. A release that is approved and served but not announced
is invisible to every user who already has the app.

> Measured: a storefront switched to a new version while the release row still named
> the previous one. `updateAvailable` was false for every install until someone ran
> the sync by hand. It happened twice, on two releases.

The public storefront is the only authority on what a stranger downloads right now.
The console shows your intent, not the outcome.

```bash
curl -s "https://itunes.apple.com/lookup?id=<APP_ID>&country=us&t=$(date +%s)" | jq '.results[0].version'
# Play has no API for this. Scrape the signed-out listing and fail LOUD when the
# pattern breaks. A silent "unknown" reads as "no drift", the failure you were checking for.
```

Announce only what the storefront serves. If you pre-stage a release row, give it a
status your "update available" query excludes (a draft state). Announcing early points
users at a store that still hands them the old binary.

### 2. An OTA reaches exactly one runtime

With `runtimeVersion: { policy: "appVersion" }`, an install receives only updates
published at its own version.

- **A version bump orphans every install on the old version.** They receive nothing
  until they install a new store binary. Publishing looks healthy the whole time: the
  channel is up and updates go out, into an audience of zero. Ship both binaries from
  one commit whenever you bump.
- **Count installs by version before you publish**, then publish to every runtime with
  live users, not only the newest.
- **Confirm what a device is served**, not what you uploaded:

```bash
curl -s "https://u.expo.dev/<projectId>" -H "expo-platform: ios" \
  -H "expo-channel-name: production" -H "expo-runtime-version: <the STORE version>" \
  -H "expo-protocol-version: 1" -H "expo-expect-signature: false" \
  -H "Accept: multipart/mixed" -D - -o /dev/null | grep expo-update-id
```

- **`updates.url` must exist in the FIRST store binary.** An app built without it can
  never receive an OTA. FlagPlay 1.1.0 shipped that way and waited for 1.1.1 to gain
  OTA. Check `updates.url` and `runtimeVersion` before the first build, not after.
- **A native dependency added after a binary was cut crashes that binary's OTA.** The
  module throws at import on the older binary. Run `ota:safety` (exit 30 means native
  drift, do not publish), or load the module optionally so an older binary degrades.
- **An Android-only native change can ship as a new `versionCode` at the same runtime**
  only if the JS falls back when the module is missing. Without that fallback, bump
  the runtime and ship both stores.

### 3. The OTA bundle must carry its build env

`eas update --environment <name>` reads variables from `eas env`, the server-side
store. It does not read `eas.json` `build.<profile>.env`. An empty `eas env` makes the
flag correct on every command and the bundle still ships with no values.

Prove the env reached the bundle by building the OTA condition locally. Hermes output
is bytecode, so a plain `grep` returns nothing and looks like proof of absence. Use
`grep -a`, and always grep a value you know is present as a positive control:

```bash
env -u EXPO_PUBLIC_REVENUECAT_IOS_KEY npx expo export --platform ios --output-dir /tmp/otacheck
grep -a -c 'appl_' /tmp/otacheck/_expo/static/js/ios/*.hbc          # the value under test
grep -a -c '<known-present value>' /tmp/otacheck/_expo/static/js/ios/*.hbc   # positive control
```

Give every value an OTA needs a source that survives an empty environment. A flag
fails open by inversion; a key needs a literal fallback, not `?? ""`.

### 4. An OTA does not retire a server route

Only installs on the OTA's own runtime receive it. Every older build keeps calling the
routes its embedded JS knows.

- Count installs by `version` before you remove or change any route a build calls.
  Keep a legacy door that delegates to the new code.
- Deploy the backend before the OTA that depends on it.
- Text hard-coded in a binary (consent, legal) needs a server-side default version.
- A version gate names the right store for the platform and says "Update".
- Keep a build-to-commit record. Read the shipped code before you change an API it calls.

### 5. Store declarations gate the API, and one deadlocks it

A permission you never wrote can reach the merged manifest from a dependency's AAR. It
is not in your app config, so nobody sees it until the store refuses the upload.

The Play **foreground-service (FGS) declaration** is the worst case. It is a deadlock
for the API path:

- The declaration form does not appear in the Console until a bundle declaring those
  permissions is saved into a release through the Console.
- The API cannot commit such a bundle without the declaration.
- A failed commit rolls the edit back, so the bundle never reaches the bundle library.
- `changesNotSentForReview: true` does not bypass it.
- Uploading by hand surfaces the form, which then demands a demo video link per
  permission, recorded on a real device.

Two ways out. Upload once by hand and answer the form, or remove the permission and
the feature that needs it, then ship the rest. For background transfers, user-initiated
data-transfer jobs avoid the FGS types.

Inspect what you ship. Decode the manifest, as described in
`production-lessons-mobile.md`; a `strings` pass alone over-reports.

### 6. A capability gate and its permissions move together

If you gate a feature off per platform, strip the permissions it needed in the same
change, and restore them together.

| | permissions present | permissions stripped |
|---|---|---|
| **feature on** | correct | throws at `startForeground` on Android 14+, in the field |
| **feature off** | store refuses every upload | correct |

Neither failure shows in a typechecker. Grade the coupling from source: a test reads
both files and asserts they agree. Break the coupling on purpose and watch the test
fail. An oracle you never saw fail is not an oracle.

Use one gate constant, not per-screen platform checks. Gate the entry points and
redirect the route itself, because deep links, typed-route pushes and stale OTA
bundles still arrive.

### 7. Play credentials, the undocumented chain

`eas submit --platform android` needs a service-account JSON. Expect this chain:

1. **Confirm you are in the right developer account.** The bare Play Console URL
   lands on the first signed-in Google account, which can be a closed developer
   account. Find the account that owns the listing (`/console/u/0/`, `u/1/`, `u/2/`)
   and match the developer name to the public listing.
2. Create a GCP project, enable the **Google Play Android Developer API**, create a
   service account. It needs no IAM role.
3. Many orgs enforce `iam.disableServiceAccountKeyCreation`. Override it on that one
   project and leave every other project protected.
4. Setting the override needs `roles/orgpolicy.policyAdmin`, which is grantable at
   organization or folder scope only. You can revoke the role afterwards; the override
   stays.
5. In **Play Console → Users and permissions → Invite user**, grant the service account
   release permissions on the one app. Creating a key is not access. Skipping this
   step produces a permission error at submit time that reads like a bad key.
6. Store the key out of git (`credentials/` in `.gitignore`, `chmod 600`) and verify
   with `git check-ignore -v <path>`. Also upload it to EAS credentials, because a
   workflow runs on EAS servers and has no local file.
7. Dry-run on the `alpha` track before the first production submit.

Do not type passwords or paste principals into IAM forms for the human. Hand those
clicks back.

### 8. Release notes are claims, and platforms differ

Store copy and in-app notes are load-bearing. Verify each claim in the code for the
platform you write about.

> Near miss: iOS notes said uploads continue while the phone is locked. On Android that
> path returned `null` behind `Platform.OS !== 'ios'`. Copying the iOS copy across would
> have shipped a false store claim.

If the app renders a server string (release notes, push copy) verbatim, store policy
applies to that string. Never paste marketing copy into a database field the app
prints, and keep billing words out of in-app notes.

### 9. Build from a clean tree and verify the artifact

- Build from a clean `git worktree` at your commit when the working tree carries
  unfinished work. Run a real `npm ci` there. Never symlink `node_modules`.
- **Push release commits before you build.** EAS builds from the remote ref.
- **Compare the build's `gitCommitHash` to `origin/main` before every submit.** A build
  cut before a merge does not contain the merge.
- Stage only your own files. Check `git status` before `git add`.
- Inspect the built binary, not the build log, and include a control that should still
  be present so a passing check cannot be a broken extraction.
- Read the build number from `ExpoApplication.nativeBuildVersion`, not `app.json`.

### 10. Platform lanes

- **iOS and Android need different EAS profiles.** `--platform all --profile X` is
  never correct when one profile pins a billing flag. A convenience flag that points
  iOS at an Android profile ships a binary with no way to pay.
- **The human submit gate must cover every submit path**, including
  `eas build --auto-submit`, which bypasses a `Bash(eas submit *)` deny rule, and any
  script that takes `SUBMIT=true`.
- **Android billing.** Google Play Payments policy (support.google.com/googleplay/android-developer/answer/9858738,
  section 4) bans steering users to non-Play payment except through programs you enroll
  in. A web link-out on Android is allowed only after enrolling in the US External
  Content Links program (Play Console → Settings → External content links; US users
  only; Google's info-screen API; transaction reporting and fees since 2026-10-01; the
  enrollment deadline for existing link-outs was 2026-01-28) or the EEA External
  Offers program. There is no global "reader" or "multiplatform" exception; NextPlay
  v7.106 relied on one and it is not in the policy. Otherwise use Play Billing, or ship
  Android as a free client. The gate is `ANDROID_WEB_BILLING`: explicit opt-in, default
  off.

## Anti-Patterns

- Treating "approved" or "build finished" as "shipped".
- Publishing an OTA without counting installs per runtime first.
- Trusting `eas.json` env for an OTA. Check `eas env:list <environment>`.
- A plain `grep` on a Hermes bundle with no positive control.
- Adding a native dependency and OTA-ing to a binary cut before it.
- Pre-staging an "update available" row with a status the query includes.
- Copying iOS release notes to Android without reading the Android code path.
- Re-dragging a 79 MB bundle instead of using Add from library.

## Reference Implementation

Checklist before you call a release done:

```
[ ] Public storefront serves the version (not the console)
[ ] In-app update row matches the storefront; older versions are told
[ ] OTA published to EVERY runtime with live users; env proven with grep -a + control
[ ] updates.url + runtimeVersion present in the first binary
[ ] No native dependency added since the live binary was cut (ota:safety)
[ ] Backend deployed before any OTA that needs it; old routes kept for old installs
[ ] Play declarations answered, or the permission removed with its feature
[ ] Gate-to-permission coupling graded from source, negative control seen failing
[ ] Release notes verified per platform against the code
[ ] Built from a clean tree; gitCommitHash matches origin/main; artifact inspected
[ ] Store parity: both stores in step, or you can name which lags and why
```

Related: [[expo-updates-ota]], [[eas-build-submit]], [[play-store-submission]],
[[iap-policy-gating]], [[second-app-fork]].

## Checklist

```
[ ] Storefront (public listing) actually serves the version — not the console
[ ] In-app update row matches the storefront; users on older versions are told
[ ] OTA published to EVERY runtime with live users; env proven in the bundle
    (`grep -a` on the .hbc with a positive control — not `strings`)
[ ] `ota:safety` clean: no native dependency added since the live binary was cut
[ ] `updates.url` + `runtimeVersion` present in the store binary
[ ] Backend deployed before the OTA that calls it; no route old binaries use retired
[ ] Store policy declarations answered, or the permission removed with its feature
[ ] Gate ↔ permission coupling graded from source, negative control seen failing
[ ] Android web-billing link-out only if enrolled in Google's program (US/EEA)
[ ] Release notes verified per platform against the code
[ ] Built from a clean tree at the merged commit; artifact inspected with a control
[ ] Store parity: both stores in step, or you can name which lags and why
```
