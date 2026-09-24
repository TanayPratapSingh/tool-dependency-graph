/**
 * Builds the dependency graph and writes data/graph.json.
 *
 *   bun run src/graph.ts
 *
 * Shape of the graph
 * ------------------
 * The obvious encoding is an edge from every producing tool to every consuming
 * tool. At this catalog size that collapses: github.repo_owner alone is required
 * by hundreds of tools and produced by dozens, so that single entity would emit
 * tens of thousands of edges and the picture would say nothing.
 *
 * So the graph is bipartite. Tools and entities are both nodes:
 *
 *     GOOGLESUPER_LIST_THREADS  --produces-->  gmail.thread_id
 *     gmail.thread_id           --requires-->  GOOGLESUPER_REPLY_TO_THREAD
 *
 * Edge count drops from producers times consumers to producers plus consumers,
 * the hub structure becomes visible, and the two hop path is exactly the
 * "run A before B" answer the task asks for.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  ENTITIES,
  classifySlot,
  entityById,
  inferService,
  resolveEntity,
  resolveEntityFromContext,
  producerScore,
  slugImpliesProduction,
  type EntityId,
} from "./entities.ts";
import { coreFieldPath, flattenSchema, normalizeTool, type JsonSchema, type RawTool, type Slot } from "./extract.ts";

type SourceTool = {
  slug: string;
  toolkit: string;
  displayName: string;
  description: string;
  inputSchema: JsonSchema | undefined;
  outputSchema: JsonSchema | undefined;
};

/**
 * Two possible sources. The SDK cache is preferred when present; otherwise the
 * per slug files from the keyless docs endpoint are used. Both are JSON Schema,
 * they differ only in casing and in whether name and description came along.
 */
/** Set by loadTools so a sample run never clobbers a full build. */
let outputPath = "data/graph.json";

async function loadTools(): Promise<SourceTool[]> {
  // Any number of catalog dumps can be dropped into data/catalog/. Falling
  // back to the checked in sample keeps a fresh clone runnable with no
  // credentials and no network.
  const dir = existsSync("data/catalog") ? "data/catalog" : "data/sample";
  outputPath = dir === "data/sample" ? "data/graph.sample.json" : "data/graph.json";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));

  if (files.length === 0) {
    console.error(`No catalog files in ${dir}/. See the README for the expected shape.`);
    process.exit(1);
  }

  const out: SourceTool[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(`${dir}/${file}`, "utf-8")) as RawTool[];
    for (const tool of raw) {
      const normalized = normalizeTool(tool, "unknown");
      out.push({
        slug: normalized.slug,
        toolkit: normalized.toolkit,
        displayName: normalized.displayName,
        description: normalized.description,
        inputSchema: (tool.inputParameters ?? tool.input_parameters) as JsonSchema | undefined,
        outputSchema: (tool.outputParameters ?? tool.output_parameters) as JsonSchema | undefined,
      });
    }
  }

  console.log(`source: ${dir} (${files.length} file(s), ${out.length} tools)`);
  return out;
}

/** $defs type names are a strong service signal, for example GmailMessageResponse. */
function defNames(schema: JsonSchema | undefined): string[] {
  if (!schema) return [];
  const defs = (schema.$defs ?? schema.definitions) as Record<string, unknown> | undefined;
  return defs && typeof defs === "object" ? Object.keys(defs) : [];
}

type ResolvedSlot = {
  path: string;
  name: string;
  required: boolean;
  entityId: EntityId | null;
  category: string;
  reason: string;
};

type ToolNode = {
  slug: string;
  toolkit: string;
  service: string;
  displayName: string;
  slots: ResolvedSlot[];
  produces: Array<{ entityId: EntityId; via: "schema" | "slug_inference"; evidence: string }>;
  hasOutputSchema: boolean;
};

const sources = await loadTools();
const tools: ToolNode[] = [];

for (const source of sources) {
  const inputs = flattenSchema(source.inputSchema);
  const outputs = flattenSchema(source.outputSchema);

  const service = inferService(
    {
      slug: source.slug,
      description: source.description,
      paramNames: inputs.map((s) => s.name),
      defNames: defNames(source.outputSchema),
    },
    source.toolkit,
  );

  const slots: ResolvedSlot[] = inputs.map((slot: Slot) => {
    const resolution = classifySlot(service, slot.name, slot.enumValues !== null);
    return {
      path: slot.path,
      name: slot.name,
      required: slot.required,
      entityId: resolution.entityId,
      category: resolution.category,
      reason: resolution.reason,
    };
  });

  // What this tool yields. Real output schemas first; slug inference only fills
  // the gap where the catalog described no output at all, and is tagged as such.
  type Produced = {
    entityId: EntityId;
    via: "schema" | "slug_inference";
    evidence: string;
    depth: number;
    /** true when yielding this entity is what the tool is for, not a passenger field */
    primary: boolean;
  };
  const produces = new Map<EntityId, Produced>();

  const informative = outputs.filter(
    (s) => !["successful", "success", "error", "log_id", "logId"].includes(s.name),
  );

  for (const slot of informative) {
    const entity = resolveEntityFromContext(service, slot.path, slot.name, source.slug);
    if (!entity) continue;
    const core = coreFieldPath(slot.path) || slot.path;
    const depth = core.split(".").filter(Boolean).length;
    const primary = slugImpliesProduction(source.slug, entity);
    const existing = produces.get(entity.id);
    // Keep the shallowest sighting: that is the one closest to being the point.
    if (existing && existing.depth <= depth) continue;
    produces.set(entity.id, { entityId: entity.id, via: "schema", evidence: core, depth, primary });
  }

  if (informative.length === 0) {
    for (const entity of ENTITIES) {
      const inScope = entity.services.includes(service) || entity.services.includes("*");
      if (inScope && slugImpliesProduction(source.slug, entity)) {
        produces.set(entity.id, {
          entityId: entity.id,
          via: "slug_inference",
          evidence: "slug verb and object noun",
          depth: 1,
          primary: true,
        });
      }
    }
  }

  tools.push({
    slug: source.slug,
    toolkit: source.toolkit,
    service,
    displayName: source.displayName,
    slots,
    produces: [...produces.values()],
    hasOutputSchema: informative.length > 0,
  });
}

// ---------------------------------------------------------------- edges ----

type Edge = { source: string; target: string; kind: "produces" | "requires"; required?: boolean };

const edges: Edge[] = [];
const producersOf = new Map<EntityId, Array<{ slug: string; via: "schema" | "slug_inference"; depth: number; primary: boolean; service: string; toolkit: string }>>();
const consumersOf = new Map<EntityId, string[]>();

for (const tool of tools) {
  for (const produced of tool.produces) {
    edges.push({ source: tool.slug, target: produced.entityId, kind: "produces" });
    producersOf.set(produced.entityId, [
      ...(producersOf.get(produced.entityId) ?? []),
      { slug: tool.slug, via: produced.via, depth: produced.depth, primary: produced.primary,
        service: tool.service, toolkit: tool.toolkit },
    ]);
  }
  const seen = new Set<EntityId>();
  for (const slot of tool.slots) {
    if (!slot.entityId || seen.has(slot.entityId)) continue;
    seen.add(slot.entityId);
    edges.push({ source: slot.entityId, target: tool.slug, kind: "requires", required: slot.required });
    consumersOf.set(slot.entityId, [...(consumersOf.get(slot.entityId) ?? []), tool.slug]);
  }
}

/**
 * Per tool answer to the question the task actually poses: before running this,
 * what must be fetched by another call, and what must be asked of the user.
 */
const PRECURSOR_CAP = 12;
const plans = tools.map((tool) => {
  const precursors: Record<string, string[]> = {};
  const askUser: string[] = [];

  for (const slot of tool.slots) {
    if (slot.entityId) {
      const entity = entityById(slot.entityId);
      const candidates = (producersOf.get(slot.entityId) ?? []).filter((p) => p.slug !== tool.slug);
      if (candidates.length > 0 && entity) {
        // Incidental producers are suppressed entirely whenever a primary one
        // exists, so the answer to "how do I get an issue number" is the issue
        // listing rather than any of the hundreds of tools whose response
        // happens to embed an issue object.
        const primary = candidates.filter((p) => p.primary);
        const byPurpose = primary.length > 0 ? primary : candidates;

        // Stay inside the toolkit when anything there can supply the value.
        const local = byPurpose.filter((p) => p.toolkit === tool.toolkit);
        const pool = local.length > 0 ? local : byPurpose;

        precursors[slot.entityId] = pool
          .map((p) => ({
            slug: p.slug,
            score: producerScore(p.slug, entity, p.via, p.depth, p.primary,
                                 p.service === tool.service, p.toolkit === tool.toolkit),
          }))
          .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
          .slice(0, PRECURSOR_CAP)
          .map((p) => p.slug);
      } else if (slot.required) {
        askUser.push(`${slot.name} (${slot.entityId}, no producer found)`);
      }
    } else if (slot.required && (slot.category === "user_supplied" || slot.category === "unresolved")) {
      askUser.push(`${slot.name} (${slot.category})`);
    }
  }
  return { slug: tool.slug, precursors, askUser };
});

// ---------------------------------------------------------------- stats ----

const allSlots = tools.flatMap((t) => t.slots);
const requiredSlots = allSlots.filter((s) => s.required);
const requiredEntitySlots = requiredSlots.filter((s) => s.entityId);
const satisfiable = requiredEntitySlots.filter((s) => (producersOf.get(s.entityId as string) ?? []).length > 0);
const bySlugInference = tools.filter((t) => t.produces.some((p) => p.via === "slug_inference")).length;

const stats = {
  tools: tools.length,
  entities: ENTITIES.length,
  edges: edges.length,
  inputSlots: allSlots.length,
  requiredSlots: requiredSlots.length,
  requiredSlotsMappedToEntity: requiredEntitySlots.length,
  requiredEntitySlotsWithProducer: satisfiable.length,
  toolsWithOutputSchema: tools.filter((t) => t.hasOutputSchema).length,
  toolsUsingSlugInference: bySlugInference,
  unresolvedHandleSlots: allSlots.filter((s) => s.category === "unresolved").length,
  serviceBreakdown: Object.fromEntries(
    [...tools.reduce((acc, t) => acc.set(t.service, (acc.get(t.service) ?? 0) + 1), new Map<string, number>())].sort(
      (a, b) => b[1] - a[1],
    ),
  ),
};

const entityNodes = ENTITIES.map((e) => ({
  id: e.id,
  label: e.label,
  services: e.services,
  opaque: e.opaque,
  notes: e.notes ?? "",
  producerCount: (producersOf.get(e.id) ?? []).length,
  consumerCount: (consumersOf.get(e.id) ?? []).length,
}));

await writeFile(
  outputPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), stats, entities: entityNodes, tools, edges, plans }, null, 2),
  "utf-8",
);

console.log("\n--- graph ---");
for (const [key, value] of Object.entries(stats)) {
  if (typeof value === "object") continue;
  console.log(`  ${key}: ${value}`);
}
console.log(`  services: ${JSON.stringify(stats.serviceBreakdown)}`);
const pct = requiredEntitySlots.length
  ? ((satisfiable.length / requiredEntitySlots.length) * 100).toFixed(1)
  : "0.0";
console.log(`  required entity slots with at least one producer: ${pct}%`);
console.log(`\nwrote ${outputPath}`);
