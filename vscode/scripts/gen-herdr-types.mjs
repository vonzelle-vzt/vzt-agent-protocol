#!/usr/bin/env node
/**
 * Generate src/herdr/types.gen.ts from herdr's own API schema.
 *
 * WHY GENERATED, NOT HAND-WRITTEN. herdr is pre-1.0 and its wire protocol moves.
 * Hand-written types drift silently: the daemon changes a field, the extension
 * keeps compiling, and you find out at runtime in front of a broken tree. A
 * generated file plus the emitted HERDR_PROTOCOL constant turns a protocol bump
 * into a BUILD failure and a loud connect-time refusal instead.
 *
 * WHY THIS SCRIPT EXISTS AT ALL, rather than piping the schema straight into
 * json-schema-to-typescript: `herdr api schema --json` does NOT emit a JSON
 * Schema. It emits a CONTAINER of five sibling schemas —
 *
 *   { $schema, protocol, schema_version, title, schemas: { request, event, ... } }
 *
 * with no `type` at the top level, and every internal $ref pointing at
 * `#/schemas/<name>/$defs/X`. Fed to a generator as-is it produces an empty
 * interface; fed one sub-schema at a time it cannot resolve a single $ref,
 * because the pointers are rooted at the container that is no longer there.
 *
 * THE TWO THINGS THAT BITE, both checked below rather than assumed:
 *
 *   1. Refs never cross sub-schema boundaries (event refs only event, etc.), so
 *      each sub-schema can be hoisted to its own root. assertSelfContained().
 *
 *   2. The five sub-schemas REPEAT 27 shared $defs between them — AgentStatus,
 *      PaneInfo, LayoutNode and friends are defined in three or four of them.
 *      Emitting each sub-schema separately and concatenating produces ~40
 *      `TS2300: Duplicate identifier` errors. At protocol 17 all 27 repeats are
 *      structurally IDENTICAL, so they can collapse into one flat namespace —
 *      and mergeDefs() proves that on every build instead of trusting it. If a
 *      future schema makes two same-named defs differ, this fails here with both
 *      sub-schemas named, rather than silently emitting whichever won.
 *
 * So: merge every $def into one shared pool, rewrite all refs to `#/$defs/X`,
 * and compile ONE document containing all five roots. One definition each, no
 * duplicates, no namespacing ceremony.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "src", "herdr", "types.gen.ts");

/** Sub-schemas we generate, and the exported root type name for each. */
const TARGETS = [
  ["request", "HerdrRequest"],
  ["success_response", "HerdrSuccessResponse"],
  ["error_response", "HerdrErrorResponse"],
  ["event", "HerdrEventEnvelope"],
  ["subscription_event", "HerdrSubscriptionEventEnvelope"],
];

function loadSchema() {
  // Ask the INSTALLED herdr for its schema rather than reading a checked-in
  // copy: the whole point is to track the daemon you actually talk to.
  const raw = execFileSync(process.env.HERDR_BIN || "herdr", ["api", "schema", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

/** Rewrite `#/schemas/<name>/$defs/X` -> `#/$defs/X` throughout a value. */
function localiseRefs(value, name) {
  return JSON.parse(
    JSON.stringify(value).replaceAll(`#/schemas/${name}/$defs/`, "#/$defs/")
  );
}

/**
 * Fail loudly if any sub-schema refs another one. The hoist below is correct
 * only under this invariant; without the check a cross-boundary ref would
 * rewrite to a `#/$defs/X` that may not exist and the generator would quietly
 * emit `unknown`.
 */
function assertSelfContained(name, sub) {
  const foreign = new Set();
  for (const [, target] of JSON.stringify(sub).matchAll(/"#\/schemas\/([a-z_]+)\/\$defs\//g)) {
    if (target !== name) foreign.add(target);
  }
  if (foreign.size > 0) {
    throw new Error(
      `sub-schema '${name}' references other sub-schemas (${[...foreign].join(", ")}). ` +
        `This generator assumes self-contained refs — teach it to namespace before regenerating.`
    );
  }
}

/**
 * Collapse the five sub-schemas' $defs into one pool, refusing to guess when a
 * name means two different things.
 */
function mergeDefs(doc) {
  const pool = {};
  const origin = {};
  for (const [name] of TARGETS) {
    const sub = doc.schemas[name];
    for (const [defName, defValue] of Object.entries(sub.$defs || {})) {
      const localised = localiseRefs(defValue, name);
      const fingerprint = JSON.stringify(localised);
      if (defName in pool) {
        if (JSON.stringify(pool[defName]) !== fingerprint) {
          throw new Error(
            `$def '${defName}' differs between sub-schemas '${origin[defName]}' and '${name}'. ` +
              `They can no longer share one flat namespace — emit per-sub-schema modules instead.`
          );
        }
        continue; // identical repeat, already have it
      }
      pool[defName] = localised;
      origin[defName] = name;
    }
  }
  return pool;
}

async function main() {
  const doc = loadSchema();
  const protocol = doc.protocol;
  const schemaVersion = doc.schema_version;
  if (typeof protocol !== "number") {
    throw new Error(`schema has no numeric 'protocol' field (got ${JSON.stringify(protocol)})`);
  }
  for (const [name] of TARGETS) {
    if (!doc.schemas?.[name]) throw new Error(`schema is missing sub-schema '${name}'`);
    assertSelfContained(name, doc.schemas[name]);
  }

  const $defs = mergeDefs(doc);

  // Hoist each sub-schema root into the shared pool under its exported name, and
  // give the document a throwaway root that references all five so the generator
  // walks every branch exactly once.
  for (const [name, title] of TARGETS) {
    const { $defs: _dropped, $schema: _alsoDropped, ...root } = doc.schemas[name];
    $defs[title] = { ...localiseRefs(root, name), title };
  }

  const merged = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "HerdrApi",
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(TARGETS.map(([, title]) => [title, { $ref: `#/$defs/${title}` }])),
    $defs,
  };

  const body = await compile(merged, "HerdrApi", {
    bannerComment: "",
    additionalProperties: false,
    declareExternallyReferenced: true,
    style: { singleQuote: false },
  });

  const header = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced by scripts/gen-herdr-types.mjs from \`herdr api schema --json\`.
 * Regenerate with: npm run gen:types  (runs automatically as part of \`npm run compile\`)
 *
 * Source daemon protocol: ${protocol} (schema_version ${schemaVersion})
 * Roots: ${TARGETS.map(([, t]) => t).join(", ")}
 *
 * \`HerdrApi\` itself is a scaffold the generator needed to reach every branch in
 * one pass — ignore it and import the roots and $defs directly.
 */

/**
 * The wire protocol these types were generated against.
 *
 * The client pings on connect and refuses to run against a daemon reporting a
 * different number. That is the entire safety mechanism: a herdr upgrade
 * regenerates this constant, the mismatch surfaces at connect with both numbers
 * named, and nobody debugs a tree that is subtly wrong.
 */
export const HERDR_PROTOCOL = ${protocol};

/** The schema_version the generator saw, for diagnostics. */
export const HERDR_SCHEMA_VERSION = ${schemaVersion};
`;

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${header}\n${body.trim()}\n`);
  console.log(
    `[gen-herdr-types] wrote ${outFile} (protocol ${protocol}, ${Object.keys($defs).length} definitions)`
  );
}

main().catch((err) => {
  console.error(`[gen-herdr-types] FAILED: ${err.message}`);
  process.exit(1);
});
