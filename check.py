"""
Hand written spot check of the dependency graph.

Eight assertions written by hand, covering the two dependency shapes the
project exists to get right plus one GitHub chain. This is a spot check, not
an eval set: it is here so the claims in the README are reproducible rather
than asserted.

    python3 check.py                       # full build, else the fixture
    python3 check.py data/graph.json       # a specific build
"""
import json
import os
import sys

# Works against a full build or the checked in fixture, whichever is present.
PATHS = [sys.argv[1]] if len(sys.argv) > 1 else ["data/graph.json", "data/graph.sample.json"]
path = next((p for p in PATHS if os.path.exists(p)), None)
if path is None:
    print(f"no graph found, looked for: {', '.join(PATHS)}")
    sys.exit(2)
print(f"  checking {path}\n")

graph = json.load(open(path))
plans = {p["slug"]: p for p in graph["plans"]}

def precursors(slug):
    return plans.get(slug, {}).get("precursors", {})

def ask_user(slug):
    return plans.get(slug, {}).get("askUser", [])

REPLY = "GOOGLESUPER_REPLY_TO_THREAD"
SEND = "GOOGLESUPER_SEND_EMAIL"
COMMENT = "GITHUB_CREATE_AN_ISSUE_COMMENT"

checks = [
    ("replying to a thread needs a thread id",
     "gmail.thread_id" in precursors(REPLY)),
    ("  and LIST_THREADS is named as a producer",
     "GOOGLESUPER_LIST_THREADS" in precursors(REPLY).get("gmail.thread_id", [])),

    ("sending mail resolves a recipient address",
     "person.email_address" in precursors(SEND)),
    ("  and a contacts tool can supply it",
     any("CONTACT" in x or "PEOPLE" in x
         for x in precursors(SEND).get("person.email_address", []))),
    ("  and no GitHub tool leaks into a Gmail plan",
     not any(x.startswith("GITHUB_")
             for v in precursors(SEND).values() for x in v)),

    ("fields inside the optional attachment are not required input",
     not any(k.startswith(("s3key", "mimetype")) for k in ask_user(REPLY))),

    ("github: commenting needs an issue number",
     "github.issue_number" in precursors(COMMENT)),
    ("  and an issue listing supplies it",
     any("ISSUE" in x and any(v in x for v in ("LIST", "GET", "SEARCH"))
         for x in precursors(COMMENT).get("github.issue_number", []))),
]

failures = 0
for name, ok in checks:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    failures += 0 if ok else 1

print(f"\n  {len(checks) - failures}/{len(checks)} passing")
sys.exit(1 if failures else 0)
