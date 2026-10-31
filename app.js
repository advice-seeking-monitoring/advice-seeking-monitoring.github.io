// The Advice Tracker test monitor, for the study team: what the test participants (participant IDs
// that start with TEST-) are doing, read live from the study server. The page holds no data:
// config.js names the server, and everything shown comes from it after sign-in:
//   POST /dashboard/login  {name, password}              -> {token, name, expires_at (ms)}
//   GET  /dashboard/data   Authorization: Bearer <token> -> {prefix, generated_at, relay, judgments,
//                                                           events, in_flight}
//   GET  /health           (open)                        -> the server tiles
// `judgments` and `events` are the test participants' rows of the server's judgments.jsonl and
// events.jsonl, as stored; `in_flight` the judgments queued or being judged now (never their texts).
// NOTE: [thought process] every piece of data goes into the page as text, through element() below.
// A transcript holds whatever a participant typed, and markup in it must show as the characters it
// is, never run. The Content-Security-Policy in index.html is a second wall: no inline script runs.
"use strict";

const SERVER = String(window.DASHBOARD_CONFIG?.server || "").replace(/\/+$/, "");
const SESSION_KEY = "monitor-session";
const REFRESH_SECONDS = 30;
// NOTE: [edge case callout] a server that holds a connection without answering (its event loop stuck on a slow
// disk, say) would keep a request, and the refreshes behind it, waiting for ever: after this long, no answer
const ANSWER_SECONDS = 20;
const ROWS_AT_A_TIME = 100;                 // timeline rows shown at first, and added by "Show more"
const WINDOW_SECONDS = { all: Infinity, week: 7 * 86400, day: 86400 };
// judgments of conversations the extension read from the chat site itself (extension 0.6), not typed on the web
const BACKGROUND_SOURCES = { past: "past conversation", app: "other device" };
const TRACKING_TONES = { on: "good", paused: "warn", off: "bad", removed: "bad" };
// the colour mark of a timeline row, by event type (judgments: by their answer)
const EVENT_TONES = { episode_rating: "answer", checkin: "answer", past_annotation: "answer", episode_transcript: "text",
                      not_advice: "skip", past_skipped: "skip", uninstalled: "alert" };
const SESSION_ENDED = "Your session ended; sign in again";
const NO_ANSWER = "The study server does not answer";

const byId = (id) => document.getElementById(id);
const signInView = byId("sign-in-view");
const nameInput = byId("account-name");
const passwordInput = byId("password");
const signInButton = byId("sign-in-button");
const signInMessage = byId("sign-in-message");
const monitorView = byId("monitor-view");
const tiles = byId("tiles");
const participantFilter = byId("filter-participant");
const siteFilter = byId("filter-site");
const windowFilter = byId("filter-window");
const updatedLabel = byId("updated");
const autoRefresh = byId("auto-refresh");
const refreshProblem = byId("refresh-problem");
const emptyState = byId("empty-state");
const participantsBody = byId("participants-body");
const inFlightBody = byId("in-flight-body");
const timeline = byId("timeline");
const showMoreButton = byId("show-more");

let session = null;          // {token, name, expires_at} while signed in (also in sessionStorage)
let data = null;             // the last answer of /dashboard/data
let health = null;           // the last answer of /health; null when the server did not answer
let clockOffset = 0;         // this computer's clock minus the study server's, in seconds
let refreshTimer = null;
let refreshing = false;
let rowsShown = ROWS_AT_A_TIME;
const timelineNodes = new Map();   // key of a timeline row -> its <li>, kept from one refresh to the next
let knownKeys = null;              // the keys of every row at the last refresh (null before the first)
let arrivedKeys = new Set();       // rows that came in at the last refresh: highlighted for a moment
let panelCount = 0;                // numbers the details panels (their ids)
let shownParticipants = "";        // what the two tables show (as JSON): they are rebuilt only when it changes
let shownInFlight = "";

// The one way anything reaches the page. A string child becomes a text node (append() does that),
// so "<script>" in a transcript is shown as those eight characters; attributes are set with
// setAttribute, whose values are never read as HTML. (No attribute set here is a handler or a link.)
function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === true) node.setAttribute(name, "");
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(name, String(value));
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

// NOTE: [edge case callout] anyone with the study key (it ships in every copy of the extension) can
// send an event, so a type can be any string, "constructor" too: tables are read only by their own keys
const lookup = (table, key, otherwise) => (Object.hasOwn(table, key) ? table[key] : otherwise);

// ---------------- times and numbers ----------------
// NOTE: [thought process] relative times are measured on the study server's clock (its generated_at
// at each refresh), so a computer whose clock is a few minutes off still says "40 s ago" rightly
const relayNow = () => Date.now() / 1000 - clockOffset;
const asDate = (seconds) => new Date(seconds * 1000);
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const shortFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function ago(seconds) {
  const passed = Math.max(0, relayNow() - seconds);
  if (passed < 90) return `${Math.round(passed)} s ago`;
  if (passed < 90 * 60) return `${Math.round(passed / 60)} min ago`;
  if (passed < 36 * 3600) return `${Math.round(passed / 3600)} h ago`;
  return `${Math.round(passed / 86400)} days ago`;
}

function duration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "?";
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 600) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// an answer or a field in a few words: lists joined, true/false as yes/no, anything nested as JSON
function plain(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length ? value.map(plain).join(", ") : "none";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// relative times ("3 min ago", "for 42 s") move on between refreshes
function updateRelativeTimes() {
  for (const node of document.querySelectorAll("[data-ago]")) node.textContent = ago(Number(node.dataset.ago));
  for (const node of document.querySelectorAll("[data-since]")) node.textContent = duration(Math.max(0, relayNow() - Number(node.dataset.since)));
}

// ---------------- signing in and out ----------------
// NOTE: [thought process] the session lives in sessionStorage, not localStorage: it is gone when the
// tab closes, and no other tab or later visit can use it
// NOTE: [edge case callout] a browser that blocks storage for this site (all cookies blocked) throws at the
// mere mention of sessionStorage: the session then lives in this page only, and a reload asks to sign in again
const sessionStore = (() => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
})();

function savedSession() {
  const saved = JSON.parse(sessionStore?.getItem(SESSION_KEY) || "null");
  if (saved && saved.expires_at > Date.now()) return saved;
  sessionStore?.clear();                    // an expired session is forgotten
  return null;
}

function showSignIn(message) {
  monitorView.hidden = true;
  signInView.hidden = false;
  signInMessage.textContent = message;
  (nameInput.value ? passwordInput : nameInput).focus();     // after a failed attempt the name is still there
}

function showMonitor() {
  signInView.hidden = true;
  monitorView.hidden = false;
  byId("account-label").textContent = session.name;
  updatedLabel.textContent = "Loading…";
  byId("monitor-title").focus();
  refresh();
}

// the server's own words for a refusal ({"detail": ...}), e.g. 429: too many failed sign-ins
async function refusal(response) {
  const detail = await response.json().then((body) => body.detail).catch(() => "");
  const words = typeof detail === "string" ? detail : "";
  return response.status === 429 && words ? words : `The study server answered ${response.status}${words ? `: ${words}` : ""}`;
}

byId("sign-in-form").addEventListener("submit", async (event) => {
  event.preventDefault();                   // the script signs in; the form itself never goes anywhere
  const name = nameInput.value.trim();
  const password = passwordInput.value;
  passwordInput.value = "";                 // cleared after every attempt, whatever its outcome
  signInMessage.textContent = "";
  signInButton.disabled = true;
  const response = await fetch(`${SERVER}/dashboard/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, password }),
    signal: AbortSignal.timeout(ANSWER_SECONDS * 1000),
  }).catch(() => null);                     // no answer at all: the server is down, or this computer is offline
  signInButton.disabled = false;
  if (!response) return showSignIn(NO_ANSWER);
  if (response.status === 401) return showSignIn("Wrong name or password");
  if (!response.ok) return showSignIn(await refusal(response));
  const answer = await response.json().catch(() => null);
  if (!answer?.token) return showSignIn("The study server's answer holds no session");
  session = { token: answer.token, name: answer.name, expires_at: answer.expires_at };
  sessionStore?.setItem(SESSION_KEY, JSON.stringify(session));
  showMonitor();
});

function signOut(message) {
  session = data = health = null;
  clearTimeout(refreshTimer);
  sessionStore?.clear();
  // nothing of the data stays in the page: every part it filled is emptied
  for (const filled of [tiles, participantsBody, inFlightBody, timeline, participantFilter, siteFilter, emptyState, byId("account-label"),
                        byId("participants-count"), byId("in-flight-count"), byId("timeline-count")]) filled.replaceChildren();
  timelineNodes.clear();
  knownKeys = null;
  arrivedKeys = new Set();
  shownParticipants = shownInFlight = "";
  rowsShown = ROWS_AT_A_TIME;
  updatedLabel.textContent = "";
  refreshProblem.hidden = true;
  showSignIn(message);
}

byId("sign-out").addEventListener("click", () => signOut(""));

// ---------------- refreshing ----------------
// NOTE: [performance improvement] /dashboard/data sends every test row at each refresh, which is fine
// for test data; for months of rows, an `after` parameter (only the rows since the last refresh) would
// send just the new ones. A hidden tab could also skip its refreshes (document.hidden).
async function refresh() {
  if (!session || refreshing) return;
  if (Date.now() >= session.expires_at) return signOut(SESSION_ENDED);
  refreshing = true;
  clearTimeout(refreshTimer);
  const token = session.token;
  // NOTE: [pedagogical] the token goes in a header, to the study server only: never into an address,
  // where it could end up in a log or in another site's Referer
  // (a time limit ends a request and the reading of its answer alike: an answer cut off counts as none)
  const [dataResponse, healthAnswer] = await Promise.all([
    fetch(`${SERVER}/dashboard/data`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
                                        signal: AbortSignal.timeout(ANSWER_SECONDS * 1000) }).catch(() => null),
    fetch(`${SERVER}/health`, { cache: "no-store", signal: AbortSignal.timeout(ANSWER_SECONDS * 1000) })
      .then((response) => (response.ok ? response.json() : null)).catch(() => null),
  ]);
  const answer = dataResponse?.ok ? await dataResponse.json().catch(() => null) : null;
  refreshing = false;
  // NOTE: [edge case callout] signed out (or in again) while the requests ran: their answers belong
  // to the session that ended, and are dropped. A session signed in meanwhile found this refresh
  // running and skipped its own, so it gets one now (refresh() does nothing while signed out).
  if (session?.token !== token) return refresh();
  if (dataResponse?.status === 401) return signOut(SESSION_ENDED);
  health = healthAnswer;
  if (answer) {
    data = answer;
    clockOffset = Date.now() / 1000 - data.generated_at;
    updatedLabel.textContent = `Updated ${clockFormat.format(new Date())}`;
    refreshProblem.hidden = true;
  } else {
    refreshProblem.textContent = `Refresh failed at ${clockFormat.format(new Date())}. ${dataResponse ? await refusal(dataResponse) : NO_ANSWER}`;
    refreshProblem.hidden = false;
  }
  render(Boolean(answer));
  scheduleRefresh();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (session && autoRefresh.checked) refreshTimer = setTimeout(refresh, REFRESH_SECONDS * 1000);
}

byId("refresh-now").addEventListener("click", refresh);
autoRefresh.addEventListener("change", () => (autoRefresh.checked ? refresh() : clearTimeout(refreshTimer)));
for (const filter of [participantFilter, siteFilter, windowFilter]) {
  filter.addEventListener("change", () => {
    rowsShown = ROWS_AT_A_TIME;
    render(false);
  });
}
showMoreButton.addEventListener("click", () => {
  rowsShown += ROWS_AT_A_TIME;
  render(false);
});

// ---------------- what the rows say ----------------
// Every stored row as one timeline entry, newest first. The events of one participant's episode are
// numbered (episode 1, 2, ...) in the order the server got them, so its answers, conversation and
// check-in are easy to match up; the episode's full id is in each row's details.
function timelineItems() {
  const episodeNumbers = new Map();         // participant -> Map(episode id -> its number)
  // NOTE: [edge case callout] the extension's prompt events (its pop-ups' answers) name no site: they take
  // the site of their episode's other events, so a filter by site keeps them with the rest of the episode
  const episodeSites = new Map();           // "<participant> <episode id>" -> its site
  for (const row of data.events) {
    if (typeof row.payload?.episode === "string" && row.payload.site) {
      episodeSites.set(`${row.participant_id} ${row.payload.episode}`, row.payload.site);
    }
  }
  const items = data.events.map((row, index) => {
    const payload = row.payload || {};
    let episode = null;
    if (typeof payload.episode === "string") {
      if (!episodeNumbers.has(row.participant_id)) episodeNumbers.set(row.participant_id, new Map());
      const numbers = episodeNumbers.get(row.participant_id);
      if (!numbers.has(payload.episode)) numbers.set(payload.episode, numbers.size + 1);
      episode = numbers.get(payload.episode);
    }
    return { key: `event ${index} ${row.received_at}`, type: String(row.type), row, episode, at: row.received_at,
             participant: row.participant_id,
             site: String(payload.site ?? episodeSites.get(`${row.participant_id} ${payload.episode}`) ?? "") };
  });
  data.judgments.forEach((row, index) => items.push({ key: `judgment ${index} ${row.received_at}`, type: "judgment", row,
                                                      at: row.received_at, participant: row.participant_id, site: String(row.site ?? "") }));
  // NOTE: [thought process] a judgment's received_at is when the extension asked for it; its row is
  // written once it is judged (queue.waited_s + queue.judge_s later), so it shows up at the time its
  // turn was sent, maybe below events that came in while it was being judged
  return items.sort((a, b) => b.at - a.at);
}

const trackingWord = (payload) => (payload.tracking ? "on" : payload.paused ? "paused" : "off");
const turns = (payload) => (typeof payload.turns === "number" ? plural(payload.turns, "turn") : "");
const messages = (payload) => (Array.isArray(payload.transcript) ? plural(payload.transcript.length, "message")
                               : payload.transcript === null ? "no conversation" : "");
const siteList = (label, sites) => (Array.isArray(sites) && sites.length ? `${label} ${sites.join(", ")}` : "");
const answersOf = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

// the useful fields of each event type, in a few words (Details shows the whole row)
const EVENT_SUMMARIES = {
  heartbeat: (payload) => [`extension ${payload.version}`, `${payload.rating_mode} mode`, `tracking ${trackingWord(payload)}`,
                           plural(payload.open_episodes ?? 0, "open episode")],
  status: (payload) => [`tracking ${trackingWord(payload)}`, siteList("listening on", payload.listening_sites),
                        siteList("excluded", payload.excluded_sites), siteList("no access to", payload.sites_without_access)],
  consent: (payload) => [`${payload.feature} ${payload.accepted ? "agreed to" : "withdrawn"}`, `consent text ${payload.version}`],
  prompt: (payload, episode) => [episode, `${payload.prompt} pop-up: ${payload.answer}`, turns(payload)],
  episode_rating: (payload, episode) => [episode, `${payload.stage} answers`,
                                         ...["helpful", "trust", "harmful"].filter((key) => key in answersOf(payload.rating))
                                                                           .map((key) => `${key} ${payload.rating[key]}`),
                                         turns(payload), messages(payload)],
  not_advice: (payload, episode) => [episode, turns(payload), payload.open ? "still open" : "", payload.had_answers ? "had answers" : ""],
  checkin: (payload, episode) => [episode, answersOf(payload.answers).followed ? `followed: ${payload.answers.followed}` : "",
                                  typeof payload.transcript === "string" ? "conversation reviewed" : ""],
  episode_transcript: (payload, episode) => [episode, messages(payload), payload.closed_by ? `closed by ${payload.closed_by}` : ""],
  past_annotation: (payload, episode) => [episode, turns(payload),
                                          typeof payload.days_since === "number" ? `${payload.days_since} days old` : "", messages(payload)],
  past_skipped: (payload, episode) => [episode],
  uninstalled: () => ["the extension was removed"],
};
// any other type: its first few plain fields
const otherSummary = (payload) => Object.entries(payload).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
                                        .slice(0, 4).map(([name, value]) => `${name} ${value}`);

// one line: what happened, in bold, then the details that matter
function summaryOf(item) {
  const row = item.row;
  if (item.type === "judgment") {
    const verdict = row[row.kind] === true ? "yes" : row[row.kind] === false ? "no" : "?";
    const where = lookup(BACKGROUND_SOURCES, row.source, "") ? ` (${BACKGROUND_SOURCES[row.source]})` : "";
    const stages = row.stage1 ? ` (stage1 ${row.stage1}, stage2 ${row.stage2})` : "";
    return [element("strong", {}, `${row.kind}, turn ${row.turn}${where}: ${verdict}`),
            `${stages}, waited ${duration(row.queue?.waited_s)}, judged ${duration(row.queue?.judge_s)}`];
  }
  const summarize = lookup(EVENT_SUMMARIES, item.type, otherSummary);
  const parts = summarize(row.payload || {}, item.episode ? `episode ${item.episode}` : "").filter(Boolean);
  return [element("strong", {}, item.type), parts.length ? `: ${parts.join(", ")}` : ""];
}

function toneOf(item) {
  if (item.type === "judgment") return item.row[item.row.kind] === true ? "yes" : "no";
  return lookup(EVENT_TONES, item.type, "system");
}

// ---------------- a row's details: answers, conversation, the stored row ----------------
const block = (title, content) => element("section", { class: "block" }, element("h4", {}, title), content);

function fieldList(object) {
  return element("dl", { class: "fields" }, Object.entries(object).map(([name, value]) =>
    element("div", {}, element("dt", {}, name), element("dd", {}, plain(value)))));
}

function conversation(transcript) {
  return element("ol", { class: "conversation" }, transcript.map((message) => {
    const role = message?.role === "assistant" ? "assistant" : "user";
    return element("li", { class: role },
      element("span", { class: "role" }, lookup({ user: "User", assistant: "Assistant" }, message?.role, String(message?.role))),
      element("p", {}, String(message?.content ?? "")));
  }));
}

function detailsOf(item) {
  const row = item.row;
  const payload = row.payload || {};
  const answers = payload.rating ?? payload.answers;
  const parts = [];
  if (answers && typeof answers === "object" && !Array.isArray(answers)) parts.push(block("Answers", fieldList(answers)));
  if (Array.isArray(payload.transcript)) {
    parts.push(block(`Conversation, ${plural(payload.transcript.length, "message")}`, conversation(payload.transcript)));
  }
  if (typeof payload.transcript === "string") {
    parts.push(block("Conversation, as reviewed at the check-in", element("pre", { class: "text" }, payload.transcript)));
  }
  // the whole row as stored; folded when the parts above already show its long fields
  parts.push(element("details", { class: "stored", open: parts.length === 0 },
    element("summary", {}, "Stored row (JSON)"), element("pre", {}, JSON.stringify(row, null, 2))));
  return parts;
}

// ---------------- the page ----------------
function tile(label, value, tone, wide) {
  return element("div", { class: wide ? "tile wide" : "tile", "data-tone": tone }, element("dt", {}, label), element("dd", {}, value));
}

function renderTiles() {
  if (!health) {
    tiles.replaceChildren(tile("Study server", "does not answer", "problem"));
    return;
  }
  const quiet = health.seconds_since_worker_poll;
  const polledAt = typeof quiet === "number" ? relayNow() - quiet : null;
  const problems = Array.isArray(health.problems) ? health.problems : [];
  const background = health.waiting_background ? ` · ${health.waiting_background} in the background` : "";
  tiles.replaceChildren(
    tile("Relay version", health.version),
    tile("Classifier", element("span", { class: "mono" }, health.classifier), null, true),
    tile("Last worker poll", polledAt === null ? "none since the relay started" : element("span", { "data-ago": polledAt }, ago(polledAt)),
         polledAt === null || quiet > 600 ? "problem" : null),
    tile("Queue", `${health.waiting} waiting · ${health.judging} judging${background}`),
    tile("Problems", problems.length ? element("ul", {}, problems.map((problem) => element("li", {}, problem))) : "none",
         problems.length ? "problem" : null));
}

// a filter's options: "everything", then each value found; the choice stays while its value exists
function fillSelect(select, everything, values) {
  if (JSON.stringify([...select.options].map((option) => option.value)) === JSON.stringify(["", ...values])) return;
  const chosen = select.value;
  select.replaceChildren(element("option", { value: "" }, everything), ...values.map((value) => element("option", { value }, value)));
  select.value = values.includes(chosen) ? chosen : "";
}

function participantRow(cells) {
  const cell = (column, value, number) => element("td", { "data-column": column, class: number ? "number" : null }, value);
  const count = (column, value) => element("td", { "data-column": column, class: value ? "number" : "number zero" }, value.toLocaleString());
  return element("tr", { "data-participant": cells.id },
    element("th", { scope: "row", "data-column": "participant" }, element("span", { class: "id" }, cells.id)),
    cell("joined", cells.joined === null ? "—" : shortFormat.format(asDate(cells.joined))),
    cell("last", cells.last === null ? "—" : element("span", { "data-ago": cells.last, title: asDate(cells.last).toLocaleString() }, ago(cells.last))),
    cell("extension", cells.extension),
    cell("tracking", cells.tracking === "—" ? "—" : element("span", { class: `pill ${lookup(TRACKING_TONES, cells.tracking, "")}` }, cells.tracking)),
    cell("advice", cells.advice, true),
    cell("continuation", cells.continuation, true),
    count("background", cells.background),
    cell("median", cells.median, true),
    count("rated", cells.rated),
    count("not-advice", cells.notAdvice),
    count("checkins", cells.checkins),
    count("transcripts", cells.transcripts),
    count("in-flight", cells.inFlight));
}

// One row per participant: what they are now (joined, last activity, extension, tracking) from all
// their rows, and what they did (the counts) from the rows the filters let through.
function renderParticipants(everyItem, shownItems, shownJobs, ids) {
  const rows = new Map(ids.map((id) => [id, {
    id, joined: Infinity, last: -Infinity, extension: "—", tracking: "—", advice: [0, 0], continuation: [0, 0],   // [yes, no]
    background: 0, seconds: [], rated: new Set(), notAdvice: new Set(), checkins: new Set(), transcripts: new Set(),
    inFlight: 0, listed: false,
  }]));
  // newest first by the extension's own clock (sent_at): the first heartbeat (or status) met is the latest one
  // NOTE: [edge case callout] an event the extension could not send at once goes later, from its queue, after
  // newer ones: the order of arrival is not the order of events. ("uninstalled" carries the server's time.)
  const newestFirst = [...everyItem].sort((a, b) => (b.row.sent_at ?? 0) - (a.row.sent_at ?? 0));
  for (const item of newestFirst) {
    const row = rows.get(item.participant);
    const payload = item.row.payload || {};
    row.joined = Math.min(row.joined, item.at);
    row.last = Math.max(row.last, item.at);
    if (item.type === "heartbeat" && row.extension === "—") row.extension = `${payload.version} · ${payload.rating_mode}`;
    if (["status", "heartbeat", "uninstalled"].includes(item.type) && row.tracking === "—") {
      row.tracking = item.type === "uninstalled" ? "removed" : trackingWord(payload);
    }
  }
  // a judgment waiting now is activity too (a participant whose first turn is queued has no row yet)
  for (const job of data.in_flight) rows.get(job.participant_id).last = Math.max(rows.get(job.participant_id).last, job.queued_at);
  for (const item of shownItems) {
    const row = rows.get(item.participant);
    const judgment = item.row;
    row.listed = true;
    if (item.type === "judgment" && lookup(BACKGROUND_SOURCES, judgment.source, "")) row.background += 1;
    else if (item.type === "judgment") {
      const answer = judgment[judgment.kind] === true ? 0 : 1;
      if (judgment.kind === "advice") row.advice[answer] += 1;
      if (judgment.kind === "continuation") row.continuation[answer] += 1;
      row.seconds.push((judgment.queue?.waited_s ?? 0) + (judgment.queue?.judge_s ?? 0));
    }
    // (episodes, not rows: a post the server stored, but answered too late, is sent again from the queue)
    if (item.type === "episode_rating") row.rated.add(judgment.payload?.episode);
    if (item.type === "not_advice") row.notAdvice.add(judgment.payload?.episode);
    if (item.type === "checkin") row.checkins.add(judgment.payload?.episode);
    if (item.type === "episode_transcript") row.transcripts.add(judgment.payload?.episode);
  }
  for (const job of shownJobs) {
    rows.get(job.participant_id).inFlight += 1;
    rows.get(job.participant_id).listed = true;
  }
  // most recently active first
  const listed = [...rows.values()].filter((row) => row.listed).sort((a, b) => b.last - a.last || a.id.localeCompare(b.id));
  const table = listed.map((row) => ({
    id: row.id, joined: Number.isFinite(row.joined) ? row.joined : null, last: Number.isFinite(row.last) ? row.last : null,
    extension: row.extension, tracking: row.tracking,
    advice: `${row.advice[0]} / ${row.advice[1]}`, continuation: `${row.continuation[0]} / ${row.continuation[1]}`,
    background: row.background, median: row.seconds.length ? duration(median(row.seconds)) : "—",
    rated: row.rated.size, notAdvice: row.notAdvice.size, checkins: row.checkins.size, transcripts: row.transcripts.size,
    inFlight: row.inFlight,
  }));
  byId("participants-count").textContent = plural(table.length, "participant");
  byId("participants-none").hidden = table.length > 0;
  const signature = JSON.stringify(table);
  if (signature === shownParticipants) return;
  shownParticipants = signature;
  participantsBody.replaceChildren(...table.map(participantRow));
}

function renderInFlight(jobs) {
  byId("in-flight-section").hidden = jobs.length === 0;
  byId("in-flight-count").textContent = plural(jobs.length, "judgment");
  const signature = JSON.stringify(jobs);
  if (signature === shownInFlight) return;
  shownInFlight = signature;
  inFlightBody.replaceChildren(...jobs.map((job) => {
    const since = job.state === "judging" ? job.started_at : job.queued_at;
    const kind = lookup(BACKGROUND_SOURCES, job.source, "") ? `${job.kind} (${BACKGROUND_SOURCES[job.source]})` : job.kind;
    return element("tr", { "data-participant": job.participant_id },
      element("th", { scope: "row" }, element("span", { class: "id" }, job.participant_id)),
      element("td", {}, job.site || "—"),
      element("td", {}, kind),
      element("td", { class: "number" }, String(job.turn)),
      element("td", { "data-column": "state" }, element("span", { class: `pill ${job.state === "judging" ? "active" : ""}` }, job.state)),
      element("td", { class: "number", "data-since": since }, duration(Math.max(0, relayNow() - since))));
  }));
}

function dayNode(day) {
  const label = day === dayFormat.format(new Date()) ? `Today, ${day}` : day;
  if (!timelineNodes.has(`day ${label}`)) timelineNodes.set(`day ${label}`, element("li", { class: "day" }, element("h3", {}, label)));
  return timelineNodes.get(`day ${label}`);
}

function timelineNode(item) {
  if (timelineNodes.has(item.key)) return timelineNodes.get(item.key);
  panelCount += 1;
  const summary = summaryOf(item);
  const panel = element("div", { class: "details", id: `details-${panelCount}`, hidden: true });
  // a screen reader's list of buttons tells them apart by the name, which starts with the word shown
  const name = `Details: ${summary[0].textContent}, ${item.participant}, ${clockFormat.format(asDate(item.at))}`;
  const button = element("button", { type: "button", class: "details-button", "aria-expanded": "false", "aria-controls": panel.id,
                                     "aria-label": name }, "Details");
  button.addEventListener("click", () => {
    const opening = panel.hidden;
    if (opening && !panel.firstChild) panel.append(...detailsOf(item));      // built the first time it opens
    panel.hidden = !opening;
    button.setAttribute("aria-expanded", String(opening));
  });
  const node = element("li", { class: arrivedKeys.has(item.key) ? "item fresh" : "item", "data-tone": toneOf(item),
                               "data-type": item.type, "data-participant": item.participant },
    element("span", { class: "when", title: asDate(item.at).toLocaleString() },
      element("time", { datetime: asDate(item.at).toISOString() }, clockFormat.format(asDate(item.at))),
      element("span", { class: "ago", "data-ago": item.at }, ago(item.at))),
    element("span", { class: "who", title: item.participant }, item.participant),
    element("span", { class: "site", title: item.site }, item.site || "—"),
    element("span", { class: "what" }, ...summary),
    button,
    panel);
  // the highlight of a new row plays once (a row moved later by a filter must not flash again)
  node.addEventListener("animationend", () => node.classList.remove("fresh"), { once: true });
  timelineNodes.set(item.key, node);
  return node;
}

function renderTimeline(shownItems) {
  byId("timeline-count").textContent = plural(shownItems.length, "row");
  byId("timeline-none").hidden = shownItems.length > 0;
  const wanted = [];
  let previousDay = "";
  for (const item of shownItems.slice(0, rowsShown)) {
    const day = dayFormat.format(asDate(item.at));
    if (day !== previousDay) wanted.push(dayNode(day));
    previousDay = day;
    wanted.push(timelineNode(item));
  }
  // NOTE: [thought process] the rows already on the page stay the same nodes: only new ones are
  // inserted and gone ones removed. So a refresh leaves open details open and the keyboard focus
  // where it was, and the browser keeps the reader's place (scroll anchoring) when rows arrive above.
  let cursor = timeline.firstChild;
  for (const node of wanted) {
    if (node === cursor) cursor = cursor.nextSibling;
    else timeline.insertBefore(node, cursor);       // a new row, or one moved up (insertBefore moves it)
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
  const older = shownItems.length - Math.min(rowsShown, shownItems.length);
  showMoreButton.hidden = older === 0;
  showMoreButton.textContent = `Show ${Math.min(ROWS_AT_A_TIME, older)} more (${older.toLocaleString()} older)`;
}

// `arrived`: called with new data from the server (not for a change of filter)
function render(arrived) {
  renderTiles();
  if (!data) return;
  const everyItem = timelineItems();
  if (arrived) {
    arrivedKeys = new Set(knownKeys ? everyItem.map((item) => item.key).filter((key) => !knownKeys.has(key)) : []);
    knownKeys = new Set(everyItem.map((item) => item.key));
  }
  const naturalOrder = (a, b) => a.localeCompare(b, undefined, { numeric: true });     // TEST-2 before TEST-10
  const ids = [...new Set([...everyItem.map((item) => item.participant), ...data.in_flight.map((job) => job.participant_id)])].sort(naturalOrder);
  const sites = [...new Set([...everyItem.map((item) => item.site), ...data.in_flight.map((job) => job.site)])].filter(Boolean).sort(naturalOrder);
  fillSelect(participantFilter, "All test participants", ids);
  fillSelect(siteFilter, "All sites", sites);
  const participant = participantFilter.value;
  const site = siteFilter.value;
  const since = relayNow() - WINDOW_SECONDS[windowFilter.value];
  const shownItems = everyItem.filter((item) => (!participant || item.participant === participant) && (!site || item.site === site)
                                                && item.at >= since);
  const shownJobs = data.in_flight.filter((job) => (!participant || job.participant_id === participant) && (!site || job.site === site));
  const nothingYet = ids.length === 0;
  emptyState.textContent = `No test participant yet. Participant IDs must start with ${data.prefix}.`;
  emptyState.hidden = !nothingYet;
  byId("participants-section").hidden = nothingYet;
  byId("timeline-section").hidden = nothingYet;
  renderParticipants(everyItem, shownItems, shownJobs, ids);
  renderInFlight(shownJobs);
  renderTimeline(shownItems);
  updateRelativeTimes();
}

// ---------------- start ----------------
byId("server-address").textContent = SERVER || "none (config.js is missing)";
byId("time-zone").textContent = `Times in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
setInterval(updateRelativeTimes, 10 * 1000);
// NOTE: [edge case callout] without config.js (a failed download, say) the page knows no server, and a saved
// session's requests would go to the page's own address, with its token: the session waits, kept, for a
// load that has config.js
session = SERVER ? savedSession() : null;
if (session) showMonitor();
else showSignIn(SERVER ? "" : "This copy of the page names no study server: its config.js is missing.");
signInButton.disabled = !SERVER;
