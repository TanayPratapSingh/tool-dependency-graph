/**
 * Canonical entity registry.
 *
 * The naive version of this task matches input parameter names against output
 * field names and calls that a dependency. That fails badly: "id", "name",
 * "query" and "type" appear on dozens of unrelated tools, so a bare name match
 * wires Gmail to GitHub and produces a hairball with no meaning.
 *
 * Instead every handle is resolved to a namespaced entity, and resolution is
 * scoped by the service that owns the tool. A bare "id" on a GMAIL_ tool can
 * only resolve inside the gmail namespace. Anything still ambiguous is left
 * unmapped and reported, rather than guessed.
 */

export type EntityId = string;

export type Entity = {
  id: EntityId;
  label: string;
  /** services whose tools may resolve this entity, or ["*"] for cross service */
  services: string[];
  /** exact leaf names, lowercased, that denote this entity */
  aliases: string[];
  /** object nouns appearing in a tool slug that imply the tool yields this entity */
  objectNouns: string[];
  /**
   * true when the value is an opaque handle a user cannot reasonably invent,
   * so obtaining it requires a prior tool call
   */
  opaque: boolean;
  notes?: string;
};

/**
 * Service inference.
 *
 * The github toolkit is trivially one service. googlesuper is not. It flattens
 * Gmail, Calendar, Drive, Docs, Sheets, Contacts, Tasks, Photos, Ads, Analytics
 * and Maps into a single GOOGLESUPER_ prefix, so the slug alone cannot tell you
 * which API a tool belongs to. GOOGLESUPER_LIST_LABELS is Gmail,
 * GOOGLESUPER_LIST_FILE_LABELS is Drive, and GOOGLESUPER_MUTATE_LABELS is Ads.
 * All three would collapse onto the same token under slug parsing.
 *
 * So service is scored from several signals at once. Parameter names and output
 * type names carry the most weight because calendar_id, spreadsheet_id and
 * thread_id are unambiguous exactly where the slug is not. Tools that score
 * below the confidence floor are parked in google_other rather than guessed,
 * which keeps wrong edges out of the graph at the cost of some coverage.
 */

export type ServiceSignals = {
  slug: string;
  description: string;
  paramNames: string[];
  defNames: string[];
};

type Marker = { pattern: RegExp; weight: number };

const m = (pattern: RegExp, weight: number): Marker => ({ pattern, weight });

const SERVICE_MARKERS: Record<string, Marker[]> = {
  gmail: [
    m(/thread_?id/i, 3), m(/label_?ids/i, 3), m(/message_?body/i, 3),
    m(/gmail/i, 3), m(/draft_?id/i, 3), m(/recipient_?email/i, 3),
    m(/\bis_?html\b/i, 2), m(/\bmailbox\b/i, 2), m(/\bbcc\b/i, 2),
    m(/\bthread\b/i, 1), m(/\bemail\b/i, 1), m(/\bdraft\b/i, 1),
  ],
  googlecalendar: [
    m(/calendar_?id/i, 3), m(/event_?id/i, 3), m(/\bfreebusy\b/i, 3),
    m(/time_?(min|max)/i, 3), m(/\battendees?\b/i, 2), m(/\brecurrence\b/i, 2),
    m(/\bcalendar\b/i, 2), m(/\bevent\b/i, 1),
  ],
  googledrive: [
    m(/file_?id/i, 3), m(/folder_?id/i, 3), m(/shared_?drive/i, 3),
    m(/\bdrive_?id\b/i, 3), m(/mime_?type/i, 2), m(/\bparents\b/i, 2),
    m(/permission_?id/i, 2), m(/\bdrive\b/i, 2), m(/\bfolder\b/i, 1),
  ],
  googledocs: [
    m(/document_?id/i, 3), m(/\bdocs\b/i, 2), m(/\bdocument\b/i, 1),
    m(/\btabs?\b/i, 1),
  ],
  googlesheets: [
    m(/spreadsheet_?id/i, 3), m(/sheet_?id/i, 3), m(/\ba1_?notation\b/i, 3),
    m(/worksheet/i, 2), m(/\bspreadsheet\b/i, 2), m(/value_?input_?option/i, 3),
  ],
  googlecontacts: [
    m(/resource_?name/i, 3), m(/person_?fields/i, 3), m(/other_?contacts/i, 3),
    m(/\bconnections\b/i, 2), m(/\bcontacts?\b/i, 2), m(/\bpeople\b/i, 2),
  ],
  googletasks: [
    m(/task_?list_?id/i, 3), m(/tasklist/i, 3), m(/\btask_?id\b/i, 2),
    m(/\btasks?\b/i, 1),
  ],
  googlephotos: [
    m(/media_?item/i, 3), m(/album_?id/i, 3), m(/\balbum\b/i, 2),
    m(/\bphotos?\b/i, 1),
  ],
  googleads: [
    m(/customer_?id/i, 3), m(/ad_?group/i, 3), m(/campaign_?id/i, 3),
    m(/\bmutate\b/i, 2), m(/\bcampaign\b/i, 2), m(/\bads?\b/i, 1),
  ],
  googleanalytics: [
    m(/property_?id/i, 3), m(/\bga4\b/i, 3), m(/run_?report/i, 3),
    m(/\bdimensions?\b/i, 1), m(/\bmetrics?\b/i, 1),
  ],
  googlemaps: [
    m(/place_?id/i, 3), m(/\blat_?lng\b/i, 3), m(/\bdirections\b/i, 2),
    m(/\broutes?\b/i, 2), m(/\bgeocod/i, 2),
  ],
};

/** Score below this and the tool is parked rather than assigned a service. */
const SERVICE_CONFIDENCE_FLOOR = 3;

export function inferService(signals: ServiceSignals, toolkit: string): string {
  if (toolkit === "github") return "github";

  const params = signals.paramNames.join(" ");
  const defs = signals.defNames.join(" ");
  const slug = signals.slug;
  const description = signals.description;

  let best = "google_other";
  let bestScore = 0;

  for (const [service, markers] of Object.entries(SERVICE_MARKERS)) {
    let score = 0;
    for (const { pattern, weight } of markers) {
      if (pattern.test(params)) score += weight * 3;
      if (pattern.test(defs)) score += weight * 3;
      if (pattern.test(slug)) score += weight * 2;
      if (pattern.test(description)) score += weight;
    }
    if (score > bestScore) {
      bestScore = score;
      best = service;
    }
  }

  return bestScore >= SERVICE_CONFIDENCE_FLOOR ? best : "google_other";
}

