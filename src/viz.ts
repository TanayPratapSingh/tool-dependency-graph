/**
 * Inlines data/graph.json into viz.template.html and writes graph.html.
 *
 *   bun run src/viz.ts
 *
 * The data is embedded rather than fetched so the page opens straight from the
 * submitted zip by double clicking it. A fetch would need a local server
 * because file:// requests are blocked by CORS, which is a poor experience for
 * whoever is reviewing this.
 */

import { readFile, writeFile } from "node:fs/promises";

type Graph = {
  stats: Record<string, unknown>;
  entities: unknown[];
  tools: Array<{
    slug: string;
    toolkit: string;
    service: string;
    hasOutputSchema: boolean;
    slots: Array<{ name: string; required: boolean; category: string; entityId: string | null }>;
    produces: Array<{ entityId: string; via: string; primary: boolean }>;
  }>;
  edges: unknown[];
  plans: unknown[];
};

const graph = JSON.parse(await readFile("data/graph.json", "utf-8")) as Graph;

// Drop the fields the page never reads. On the full catalog this roughly halves
// the payload, which matters because it ships inside the HTML.
const slim = {
  stats: graph.stats,
  entities: graph.entities,
  edges: graph.edges,
  plans: graph.plans,
  tools: graph.tools.map((t) => ({
    slug: t.slug,
    toolkit: t.toolkit,
    service: t.service,
    hasOutputSchema: t.hasOutputSchema,
    slots: t.slots.map((s) => ({
      name: s.name,
      required: s.required,
      category: s.category,
      entityId: s.entityId,
    })),
    produces: t.produces.map((p) => ({ entityId: p.entityId, via: p.via, primary: p.primary })),
  })),
};

const template = await readFile("viz.template.html", "utf-8");
// </script> inside the payload would close the host script tag early.
const payload = JSON.stringify(slim).replace(/<\//g, "<\\/");

await writeFile("graph.html", template.replace("__GRAPH_DATA__", payload), "utf-8");

const bytes = Buffer.byteLength(payload, "utf-8");
console.log(`wrote graph.html (${(bytes / 1024 / 1024).toFixed(2)} MB of inlined data)`);
