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

