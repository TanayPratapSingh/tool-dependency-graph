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

export const ENTITIES: Entity[] = [
  // ---------- Gmail ----------
  {
    id: "gmail.thread_id",
    label: "Gmail thread id",
    services: ["gmail"],
    aliases: ["thread_id", "threadid", "thread"],
    objectNouns: ["THREAD", "THREADS", "EMAIL", "EMAILS", "MESSAGE", "MESSAGES"],
    opaque: true,
    notes: "Gmail message resources carry threadId, so message listings also yield thread ids.",
  },
  {
    id: "gmail.message_id",
    label: "Gmail message id",
    services: ["gmail"],
    aliases: ["message_id", "messageid", "msg_id", "email_id"],
    objectNouns: ["EMAIL", "EMAILS", "MESSAGE", "MESSAGES", "THREAD", "THREADS"],
    opaque: true,
  },
  {
    id: "gmail.draft_id",
    label: "Gmail draft id",
    services: ["gmail"],
    aliases: ["draft_id", "draftid"],
    objectNouns: ["DRAFT", "DRAFTS"],
    opaque: true,
  },
  {
    id: "gmail.label_id",
    label: "Gmail label id",
    services: ["gmail"],
    aliases: ["label_id", "label_ids", "labelid", "add_label_ids", "remove_label_ids"],
    objectNouns: ["LABEL", "LABELS"],
    opaque: true,
  },
  {
    id: "gmail.attachment_id",
    label: "Gmail attachment id",
    services: ["gmail"],
    aliases: ["attachment_id", "attachmentid"],
    objectNouns: ["ATTACHMENT", "ATTACHMENTS"],
    opaque: true,
  },

  // ---------- People, cross service ----------
  {
    id: "person.email_address",
    label: "Person email address",
    services: ["*"],
    aliases: [
      "email", "email_address", "recipient_email", "to", "cc", "bcc",
      "to_email", "recipient", "attendee_email", "member_email", "user_email",
    ],
    objectNouns: ["CONTACT", "CONTACTS", "PEOPLE", "PERSON", "DIRECTORY", "EMAIL_ADDRESS", "EMAIL_ADDRESSES"],
    opaque: false,
    notes:
      "Semi opaque. A user often knows the address, but when they supply only a name "
      + "a contacts lookup has to run first. This is the readme's second worked example.",
  },

  // ---------- Google Calendar ----------
  {
    id: "googlecalendar.calendar_id",
    label: "Calendar id",
    services: ["googlecalendar"],
    aliases: ["calendar_id", "calendarid"],
    objectNouns: ["CALENDAR", "CALENDARS"],
    opaque: true,
    notes: "Defaults to the literal 'primary' on many tools, which makes it optional in practice.",
  },
  {
    id: "googlecalendar.event_id",
    label: "Calendar event id",
    services: ["googlecalendar"],
    aliases: ["event_id", "eventid"],
    objectNouns: ["EVENT", "EVENTS"],
    opaque: true,
  },

  // ---------- Google Drive and editors ----------
  {
    id: "googledrive.file_id",
    label: "Drive file id",
    services: ["googledrive", "googlephotos"],
    aliases: ["file_id", "fileid", "drive_file_id"],
    objectNouns: ["FILE", "FILES"],
    opaque: true,
  },
  {
    id: "googledrive.folder_id",
    label: "Drive folder id",
    services: ["googledrive"],
    aliases: ["folder_id", "folderid", "parent_id", "parent_folder_id"],
    objectNouns: ["FOLDER", "FOLDERS"],
    opaque: true,
  },
  {
    id: "googledocs.document_id",
    label: "Google Docs document id",
    services: ["googledocs"],
    aliases: ["document_id", "documentid", "doc_id"],
    objectNouns: ["DOCUMENT", "DOCUMENTS", "DOC", "DOCS"],
    opaque: true,
  },
  {
    id: "googlesheets.spreadsheet_id",
    label: "Spreadsheet id",
    services: ["googlesheets"],
    aliases: ["spreadsheet_id", "spreadsheetid"],
    objectNouns: ["SPREADSHEET", "SPREADSHEETS"],
    opaque: true,
  },
  {
    id: "googlesheets.sheet_id",
    label: "Worksheet id",
    services: ["googlesheets"],
    aliases: ["sheet_id", "sheetid", "worksheet_id"],
    objectNouns: ["SHEET", "SHEETS", "WORKSHEET"],
    opaque: true,
  },
  {
    id: "googletasks.tasklist_id",
    label: "Task list id",
    services: ["googletasks"],
    aliases: ["tasklist_id", "task_list_id", "tasklist"],
    objectNouns: ["TASKLIST", "TASKLISTS", "TASK_LIST"],
    opaque: true,
  },
  {
    id: "googletasks.task_id",
    label: "Task id",
    services: ["googletasks"],
    aliases: ["task_id", "taskid"],
    objectNouns: ["TASK", "TASKS"],
    opaque: true,
  },
  {
    id: "googlecontacts.contact_id",
    label: "Contact resource name",
    services: ["googlecontacts"],
    aliases: ["contact_id", "resource_name", "person_id", "people_id"],
    objectNouns: ["CONTACT", "CONTACTS", "PEOPLE", "PERSON"],
    opaque: true,
  },

  // ---------- GitHub ----------
  {
    id: "github.repo_owner",
    label: "Repository owner",
    services: ["github"],
    aliases: ["owner", "repo_owner", "org", "organization", "org_name", "owner_name"],
    objectNouns: ["REPO", "REPOS", "REPOSITORY", "REPOSITORIES", "ORG", "ORGS", "ORGANIZATION", "ORGANIZATIONS"],
    opaque: false,
    notes: "A user usually knows this, but it is also produced by repo and org listings.",
  },
  {
    id: "github.repo_name",
    label: "Repository name",
    services: ["github"],
    aliases: ["repo", "repo_name", "repository", "repository_name"],
    objectNouns: ["REPO", "REPOS", "REPOSITORY", "REPOSITORIES"],
    opaque: false,
  },
  {
    id: "github.issue_number",
    label: "Issue number",
    services: ["github"],
    aliases: ["issue_number", "issuenumber", "issue"],
    objectNouns: ["ISSUE", "ISSUES"],
    opaque: true,
  },
  {
    id: "github.pr_number",
    label: "Pull request number",
    services: ["github"],
    aliases: ["pull_number", "pr_number", "pullnumber", "pull_request_number"],
    objectNouns: ["PULL", "PULLS", "PULL_REQUEST", "PULL_REQUESTS", "PR"],
    opaque: true,
  },
  {
    id: "github.comment_id",
    label: "Comment id",
    services: ["github"],
    aliases: ["comment_id", "commentid"],
    objectNouns: ["COMMENT", "COMMENTS"],
    opaque: true,
  },
  {
    id: "github.review_id",
    label: "Review id",
    services: ["github"],
    aliases: ["review_id", "reviewid"],
    objectNouns: ["REVIEW", "REVIEWS"],
    opaque: true,
  },
  {
    id: "github.commit_sha",
    label: "Commit sha",
    services: ["github"],
    aliases: ["sha", "commit_sha", "commit_id", "base_sha", "head_sha"],
    objectNouns: ["COMMIT", "COMMITS"],
    opaque: true,
  },
  {
    id: "github.branch_ref",
    label: "Branch or ref",
    services: ["github"],
    aliases: ["branch", "ref", "base", "head", "branch_name", "base_branch", "head_branch"],
    objectNouns: ["BRANCH", "BRANCHES", "REF", "REFS"],
    opaque: false,
    notes: "Often known to the user, but also produced by branch listings.",
  },
  {
    id: "github.user_login",
    label: "GitHub username",
    services: ["github"],
    aliases: ["username", "login", "assignee", "assignees", "reviewer", "reviewers", "user"],
    objectNouns: ["USER", "USERS", "MEMBER", "MEMBERS", "COLLABORATOR", "COLLABORATORS"],
    opaque: false,
  },
  {
    id: "github.gist_id",
    label: "Gist id",
    services: ["github"],
    aliases: ["gist_id", "gistid"],
    objectNouns: ["GIST", "GISTS"],
    opaque: true,
  },
  {
    id: "github.release_id",
    label: "Release id",
    services: ["github"],
    aliases: ["release_id", "releaseid"],
    objectNouns: ["RELEASE", "RELEASES"],
    opaque: true,
  },
  {
    id: "github.workflow_id",
    label: "Workflow id",
    services: ["github"],
    aliases: ["workflow_id", "workflowid"],
    objectNouns: ["WORKFLOW", "WORKFLOWS"],
    opaque: true,
  },
  {
    id: "github.run_id",
    label: "Workflow run id",
    services: ["github"],
    aliases: ["run_id", "runid", "check_run_id"],
    objectNouns: ["RUN", "RUNS"],
    opaque: true,
  },
  {
    id: "github.team_slug",
    label: "Team slug",
    services: ["github"],
    aliases: ["team_slug", "team_id", "teamslug"],
    objectNouns: ["TEAM", "TEAMS"],
    opaque: true,
  },
  {
    id: "github.file_path",
    label: "Repository file path",
    services: ["github"],
    aliases: ["path", "file_path", "filepath"],
    objectNouns: ["CONTENT", "CONTENTS", "TREE", "FILE", "FILES"],
    opaque: false,
  },
  {
    id: "github.repository_id",
    label: "Repository numeric id",
    services: ["github"],
    aliases: ["repository_id", "repo_id"],
    objectNouns: ["REPO", "REPOS", "REPOSITORY", "REPOSITORIES"],
    opaque: true,
    notes: "Distinct from owner/repo. Some endpoints key on the numeric id only.",
  },
  {
    id: "github.issue_id",
    label: "Issue global id",
    services: ["github"],
    aliases: ["issue_id", "sub_issue_id"],
    objectNouns: ["ISSUE", "ISSUES"],
    opaque: true,
    notes: "Global database id, not the per repository issue_number.",
  },
  {
    id: "github.project_id",
    label: "Project id or number",
    services: ["github"],
    aliases: ["project_id", "project_number"],
    objectNouns: ["PROJECT", "PROJECTS"],
    opaque: true,
  },
  {
    id: "github.project_item_id",
    label: "Project item id",
    services: ["github"],
    aliases: ["item_id"],
    objectNouns: ["ITEM", "ITEMS"],
    opaque: true,
  },
  {
    id: "github.project_field_id",
    label: "Project field id",
    services: ["github"],
    aliases: ["field_id"],
    objectNouns: ["FIELD", "FIELDS"],
    opaque: true,
  },
  {
    id: "github.runner_id",
    label: "Actions runner id",
    services: ["github"],
    aliases: ["runner_id", "runner_group_id"],
    objectNouns: ["RUNNER", "RUNNERS"],
    opaque: true,
  },
  {
    id: "github.invitation_id",
    label: "Invitation id",
    services: ["github"],
    aliases: ["invitation_id"],
    objectNouns: ["INVITATION", "INVITATIONS"],
    opaque: true,
  },
  {
    id: "github.migration_id",
    label: "Migration id",
    services: ["github"],
    aliases: ["migration_id"],
    objectNouns: ["MIGRATION", "MIGRATIONS"],
    opaque: true,
  },
  {
    id: "github.deployment_id",
    label: "Deployment id",
    services: ["github"],
    aliases: ["deployment_id", "pages_deployment_id"],
    objectNouns: ["DEPLOYMENT", "DEPLOYMENTS"],
    opaque: true,
  },
  {
    id: "github.installation_id",
    label: "App installation id",
    services: ["github"],
    aliases: ["installation_id"],
    objectNouns: ["INSTALLATION", "INSTALLATIONS"],
    opaque: true,
  },
  {
    id: "github.milestone_number",
    label: "Milestone number",
    services: ["github"],
    aliases: ["milestone_number", "milestone"],
    objectNouns: ["MILESTONE", "MILESTONES"],
    opaque: true,
  },
  {
    id: "github.discussion_number",
    label: "Discussion number",
    services: ["github"],
    aliases: ["discussion_number"],
    objectNouns: ["DISCUSSION", "DISCUSSIONS"],
    opaque: true,
  },
  {
    id: "github.alert_number",
    label: "Security alert number",
    services: ["github"],
    aliases: ["alert_number"],
    objectNouns: ["ALERT", "ALERTS"],
    opaque: true,
  },
  {
    id: "github.asset_id",
    label: "Release asset id",
    services: ["github"],
    aliases: ["asset_id"],
    objectNouns: ["ASSET", "ASSETS"],
    opaque: true,
  },
  {
    id: "github.check_run_id",
    label: "Check run or suite id",
    services: ["github"],
    aliases: ["check_suite_id"],
    objectNouns: ["CHECK", "CHECKS", "SUITE"],
    opaque: true,
  },
];

const BY_ID = new Map(ENTITIES.map((e) => [e.id, e]));
export const entityById = (id: EntityId): Entity | undefined => BY_ID.get(id);

/**
 * Leaf names that are content the user authors, never a handle fetched from a
 * prior call. Keeps freeform text out of the dependency graph.
 */
const USER_SUPPLIED = new Set([
  "subject", "body", "message_body", "text", "content", "title", "description",
  "comment", "comment_body", "note", "notes", "summary", "snippet", "message",
  "query", "q", "search_query", "keywords", "name", "display_name", "filename",
  "commit_message", "location", "timezone", "time_zone", "start_time", "end_time",
  "start_date", "end_date", "due_date", "date", "datetime", "recurrence",
  "mime_type", "content_type", "color", "url", "link", "html", "markdown",
]);

/** Paging, formatting and other machine set knobs that are not dependencies. */
const CONTROL_PARAMS = new Set([
  "page", "per_page", "page_size", "page_token", "next_page_token", "cursor",
  "limit", "offset", "max_results", "maxresults", "order", "order_by", "sort",
  "direction", "format", "fields", "include", "expand", "filter", "state",
  "verbose", "dry_run", "force", "user_id", "userid",
  // auth and GraphQL protocol plumbing, supplied by the connection not a prior tool
  "access_token", "client_id", "client_secret", "refresh_token", "api_key",
  "client_mutation_id", "headers", "accept",
]);

export type SlotCategory = "tool_derived" | "user_supplied" | "control" | "enum_or_constant" | "unresolved";

export type SlotResolution = {
  entityId: EntityId | null;
  category: SlotCategory;
  /** why the classifier landed here, carried through to the write up */
  reason: string;
};

function normalizeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Singular and plural forms collapse, so label_ids matches label_id. */
function nameVariants(name: string): string[] {
  const base = normalizeName(name);
  const variants = new Set([base]);
  if (base.endsWith("s")) variants.add(base.slice(0, -1));
  variants.add(`${base}s`);
  return [...variants];
}

/**
 * Resolves one input slot to a canonical entity, scoped to the owning service.
 * Returns null rather than guessing when nothing matches cleanly.
 */
