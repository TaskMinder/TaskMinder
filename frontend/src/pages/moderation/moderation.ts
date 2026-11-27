// Moderation panel, NOT part of the app shell
type ModerationAction = "dismiss" | "remove" | "ban" | "remove_and_ban" | "rotate_class_code";
type Ground = "terms" | "illegal";
// timestamps from the database arrive as strings (BigInt)
type Timestamp = string;
type AccountInfo = { username: string; deleted: boolean; bannedAt: Timestamp | null } | null;
// file of reported upload, downloadable from panel
type CurrentFile = { fileMetaDataId: number; mimeType: string; size: number };

type Overview = {
  loginUntil: number;
  open: {
    reportId: number;
    category: string;
    targetType: string;
    targetId: number;
    classId: number | null;
    description: string | null;
    createdAt: Timestamp;
  }[];
  resolved: {
    reportId: number;
    action: ModerationAction;
    decisionGround: Ground | null;
    decisionReason: string | null;
    resolvedAt: Timestamp;
  }[];
  banned: {
    accountId: number;
    username: string;
    banGround: Ground | null;
    banReason: string | null;
    bannedAt: Timestamp;
  }[];
};

type ReportDetails = {
  loginUntil: number;
  report: {
    reportId: number;
    classId: number | null;
    targetType: string;
    targetId: number;
    targetAccountId: number | null;
    editorAccountId: number | null;
    hasReporterContact: boolean;
    category: string;
    description: string | null;
    snapshot: unknown;
    action: ModerationAction | null;
    decisionGround: Ground | null;
    decisionReason: string | null;
    resolvedAt: Timestamp | null;
    createdAt: Timestamp;
  };
  // the content as it is now; null when it is gone or the account left the class
  current: { files?: CurrentFile[]; [key: string]: unknown } | null;
  changedSinceReport: boolean;
  author: AccountInfo;
  editor: AccountInfo;
  earlierOnTarget: number;
  earlierOnAuthor: number;
  otherOpenOnTarget: number;
  actions: ModerationAction[];
};

const BAN = {
  hint: "Sperrt das Konto für ganz TaskMinder. Ein gesperrter Admin verliert die Rolle; ohne anderen aktiven Admin wird das längste Mitglied Admin.",
  reason: "Pflicht: Das gesperrte Konto und Melder mit E-Mail-Adresse lesen sie.",
  rotate: "Sonst kann das gesperrte Konto sich abmelden und anonym weitermachen."
};

// label: form and button, done: decision already made, hint: what it does, reason: who reads the reason
// (they also get ground and how to appeal), confirm: asked before decisions the panel cannot undo,
// rotate: why one would change the class code as well (only actions that can)
const ACTIONS: Record<ModerationAction, {
  label: string; done: string; hint: string; reason: string; button: string; confirm?: string; rotate?: string;
}> = {
  dismiss: {
    label: "Keine Maßnahme",
    done: "Keine Maßnahme",
    hint: "Inhalt und Konto bleiben unverändert.",
    reason: "Optional: Melder mit E-Mail-Adresse bekommen sie.",
    button: "btn-secondary"
  },
  remove: {
    label: "Inhalt löschen",
    done: "Inhalt gelöscht",
    hint: "Löscht den Inhalt für die ganze Klasse.",
    reason: "Pflicht: Melder mit E-Mail-Adresse lesen sie.",
    button: "btn-danger",
    confirm: "Inhalt wirklich löschen?",
    rotate: "Sinnvoll, wenn der Inhalt anonym erstellt oder bearbeitet wurde."
  },
  ban: { ...BAN, label: "Konto sperren", done: "Konto gesperrt", button: "btn-danger", confirm: "Konto wirklich sperren?" },
  remove_and_ban: {
    ...BAN,
    label: "Löschen und sperren",
    done: "Gelöscht und gesperrt",
    hint: `Löscht den Inhalt. ${BAN.hint}`,
    button: "btn-danger",
    confirm: "Inhalt wirklich löschen und Konto sperren?"
  },
  rotate_class_code: {
    label: "Klassencode ändern",
    done: "Klassencode geändert",
    hint: "Neuer Klassencode wird generiert und alle anonymen Mitglieder werden abgemeldet.",
    reason: "Pflicht: Melder mit E-Mail-Adresse lesen sie.",
    button: "btn-warning",
    confirm: "Klassencode wirklich ändern? Alle anonymen Mitglieder werden abgemeldet."
  }
};

const GROUND_LABELS: Record<Ground, string> = {
  terms: "Nutzungsbedingungen Nr. 3",
  illegal: "Rechtswidrig"
};

const CATEGORY_LABELS: Record<string, string> = {
  illegal: "Rechtswidrig",
  harassment: "Belästigung",
  hate: "Hass",
  sexual: "Sexuelle Inhalte",
  spam: "Spam",
  privacy: "Privatsphäre",
  other: "Sonstiges"
};

// categories that need quick look get stronger color
const CATEGORY_COLORS: Record<string, string> = {
  illegal: "danger",
  hate: "danger",
  harassment: "warning",
  sexual: "warning",
  privacy: "warning"
};

const TARGET_TYPE_LABELS: Record<string, string> = {
  homework: "Hausaufgabe",
  event: "Ereignis",
  upload: "Datei",
  account: "Konto"
};

// only homework, events and uploads have editor besides author
const EDITABLE_TARGET_TYPES = ["homework", "event", "upload"];
// reports open for this long are highlighted
const OLD_REPORT_HOURS = 24;

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function create(tag: string, className = "", text?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function labelOf(labels: Record<string, string>, key: string | null): string {
  return key === null ? "–" : labels[key] ?? key;
}

function formatDateTime(timestamp: Timestamp | number, style: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "short" }): string {
  return new Date(Number(timestamp)).toLocaleString("de-DE", { timeZone: "Europe/Berlin", ...style });
}

function ageCell(createdAt: Timestamp): HTMLElement {
  const hours = Math.floor((Date.now() - Number(createdAt)) / (60 * 60 * 1000));
  const text = hours < 1 ? "gerade eben" : hours < 48 ? `vor ${hours} Std.` : `vor ${Math.floor(hours / 24)} Tagen`;
  const cell = create("td", "text-nowrap", text);
  if (hours >= OLD_REPORT_HOURS) {
    cell.classList.add("text-warning-emphasis", "fw-bold");
  }
  return cell;
}

function categoryBadge(category: string, badge = create("span")): HTMLElement {
  badge.className = `badge rounded-pill text-bg-${CATEGORY_COLORS[category] ?? "secondary"}`;
  badge.textContent = labelOf(CATEGORY_LABELS, category);
  return badge;
}

function targetText(targetType: string, targetId: number): string {
  return `${labelOf(TARGET_TYPE_LABELS, targetType)} #${targetId}`;
}

function accountText(accountId: number | null, account: AccountInfo): string {
  if (accountId === null || account === null) {
    return "unbekannt oder anonym";
  }
  return `#${accountId} ${account.username}${account.deleted ? " (gelöscht)" : ""}${account.bannedAt ? " (gesperrt)" : ""}`;
}

// an account that can still be banned: neither deleted nor banned yet
function isBannable(account: AccountInfo): boolean {
  return account !== null && !account.deleted && account.bannedAt === null;
}

function isBanAction(action: ModerationAction): boolean {
  return action === "ban" || action === "remove_and_ban";
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- API ----------

let csrfToken: string | null = null;

// expected errors come as plain text, failed validation as JSON with `message` and `error`
async function errorText(res: Response): Promise<string> {
  const text = await res.text();
  if (!res.headers.get("content-type")?.includes("application/json")) {
    return text;
  }
  try {
    const { message, error } = JSON.parse(text) as { message?: string; error?: string };
    return [message, error].filter(Boolean).join(": ") || text;
  }
  catch {
    return text;
  }
}

async function getCsrfToken(): Promise<string> {
  if (csrfToken === null) {
    // the panel has its own session, so its own token
    const res = await fetch("/moderation/api/csrf-token", { cache: "no-store" });
    if (!res.ok) {
      throw new ApiError(res.status, await errorText(res));
    }
    csrfToken = (await res.json() as { csrfToken: string }).csrfToken;
  }
  return csrfToken;
}

async function api<T>(method: "GET" | "POST", path: string, body?: object, retryCsrf = true): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method === "POST") {
    headers["X-CSRF-Token"] = await getCsrfToken();
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`/moderation/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store"
  });
  if (!res.ok) {
    const text = await errorText(res);
    // the session behind the token can expire while the page is open; a new token fixes that
    if (res.status === 401 && method === "POST" && retryCsrf && text.startsWith("CSRF Check failed")) {
      csrfToken = null;
      return await api<T>(method, path, body, false);
    }
    throw new ApiError(res.status, text);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

// ---------- Views ----------

const VIEWS = ["login-view", "overview-view", "report-view"] as const;
type View = typeof VIEWS[number];

let activeView: View | null = null;
// the view the login interrupted; shown again as it was after logging in, so typed text survives
let interruptedView: View | null = null;
let logoutTimer: number | undefined;

function showView(view: View): void {
  for (const id of VIEWS) {
    byId(id).hidden = id !== view;
  }
  activeView = view;
  byId("session-controls").hidden = view === "login-view";
}

// alerts use the app's markup: d-none while hidden, d-flex while shown
function toggleAlert(id: string, visible: boolean): void {
  byId(id).classList.toggle("d-none", !visible);
  byId(id).classList.toggle("d-flex", visible);
}

function showPageError(message: string | null): void {
  byId("page-error-text").textContent = message ?? "";
  toggleAlert("page-error", message !== null);
}

function setLoginUntil(loginUntil: number): void {
  byId("login-until").textContent = `angemeldet bis ${formatDateTime(loginUntil, { timeStyle: "short" })}`;
  // shows the login when it runs out, keeping the page below it
  window.clearTimeout(logoutTimer);
  logoutTimer = window.setTimeout(() => showLogin(true, true), Math.max(loginUntil - Date.now(), 0));
}

// `resume`: after logging in, show the current view again as it is instead of loading the URL
function showLogin(expired: boolean, resume: boolean): void {
  window.clearTimeout(logoutTimer);
  if (activeView !== "login-view") {
    interruptedView = resume ? activeView : null;
  }
  toggleAlert("login-expired", expired);
  toggleAlert("login-wrong-password", false);
  toggleAlert("login-too-many", false);
  showPageError(null);
  showView("login-view");
  byId("login-password").focus();
}

// ---------- Overview ----------

// table "<name>-table" with body "<name>-rows", or "<name>-empty" when there are no rows
function fillTable(name: string, rows: HTMLElement[]): void {
  byId(`${name}-rows`).replaceChildren(...rows);
  byId(`${name}-empty`).hidden = rows.length > 0;
  byId(`${name}-table`).hidden = rows.length === 0;
}

function reportRow(reportId: number, cells: HTMLElement[]): HTMLElement {
  const row = create("tr", "report-row");
  const link = create("a", "fw-bold", `#${reportId}`) as HTMLAnchorElement;
  link.href = `/moderation?report=${reportId}`;
  link.dataset.nav = "";
  const first = create("td");
  first.append(link);
  row.append(first, ...cells);
  row.addEventListener("click", ev => {
    if (!(ev.target as Element).closest("a, button")) navigate(link.href);
  });
  return row;
}

function renderOverview(data: Overview): void {
  byId("open-count").textContent = String(data.open.length);
  byId("banned-count").textContent = String(data.banned.length);

  fillTable("open", data.open.map(report => {
    const category = create("td");
    category.append(categoryBadge(report.category));
    return reportRow(report.reportId, [
      ageCell(report.createdAt),
      category,
      create("td", "text-nowrap", targetText(report.targetType, report.targetId)),
      create("td", "", report.classId === null ? "–" : `#${report.classId}`),
      create("td", "text-truncate description-cell", report.description ?? "")
    ]);
  }));

  fillTable("banned", data.banned.map(account => {
    const unban = create("button", "btn btn-sm btn-outline-secondary fw-bold", "Entsperren");
    unban.addEventListener("click", () => void unbanAccount(account.accountId, account.username, unban as HTMLButtonElement));
    const action = create("td", "text-end");
    action.append(unban);
    const row = create("tr");
    row.append(
      create("td", "text-nowrap", `#${account.accountId} ${account.username}`),
      create("td", "text-nowrap", formatDateTime(account.bannedAt)),
      create("td", "text-nowrap", labelOf(GROUND_LABELS, account.banGround)),
      create("td", "text-truncate description-cell", account.banReason ?? ""),
      action
    );
    return row;
  }));

  fillTable("resolved", data.resolved.map(report => reportRow(report.reportId, [
    create("td", "text-nowrap", formatDateTime(report.resolvedAt)),
    create("td", "text-nowrap", ACTIONS[report.action].done),
    create("td", "text-nowrap", labelOf(GROUND_LABELS, report.decisionGround)),
    create("td", "text-truncate description-cell", report.decisionReason ?? "")
  ])));
}

async function unbanAccount(accountId: number, username: string, button: HTMLButtonElement): Promise<void> {
  if (!window.confirm(`${username} entsperren?`)) return;
  button.disabled = true;
  try {
    await api("POST", `/accounts/${accountId}/unban`);
    await route();
  }
  catch (error) {
    button.disabled = false;
    handleError(error);
  }
}

// ---------- Report ----------

let currentReport: ReportDetails | null = null;

function fillFacts(listId: string, facts: [string, string][]): void {
  byId(listId).replaceChildren(...facts.flatMap(([term, value]) => [
    create("dt", "col-sm-5", term),
    create("dd", "col-sm-7", value)
  ]));
}

// last editor is stored as is: the author's id when the author edited last, null after an anonymous edit
function editorText(report: ReportDetails["report"], editor: AccountInfo): string {
  const editorIsAuthor = report.editorAccountId !== null && report.editorAccountId === report.targetAccountId;
  return editorIsAuthor ? "der Autor" : accountText(report.editorAccountId, editor);
}

function reportFacts(data: ReportDetails): [string, string][] {
  const { report, author, editor } = data;
  const editorFact: [string, string][] = EDITABLE_TARGET_TYPES.includes(report.targetType)
    ? [["Letzter Bearbeiter", editorText(report, editor)]]
    : [];
  return [
    ["Eingegangen", formatDateTime(report.createdAt)],
    ["Inhalt", targetText(report.targetType, report.targetId)],
    ["Klasse", report.classId === null ? "–" : `#${report.classId}`],
    ["Autor", accountText(report.targetAccountId, author)],
    ...editorFact,
    ["E-Mail des Melders", report.hasReporterContact ? "angegeben" : "keine"],
    ["Frühere Meldungen zum Inhalt", String(data.earlierOnTarget)],
    ["Frühere Meldungen zum Autor", String(data.earlierOnAuthor)],
    ["Beschreibung", report.description ?? "–"]
  ];
}

// a decision acts on the content as it is now; it is shown in full only when it differs from the snapshot
function renderCurrent(data: ReportDetails): void {
  const { report, current, changedSinceReport } = data;
  const status = byId("report-current-status");
  if (current === null) {
    status.className = "badge rounded-pill text-bg-secondary";
    status.textContent = report.targetType === "account" ? "nicht mehr in der Klasse" : "gelöscht";
  }
  else {
    status.className = `badge rounded-pill ${changedSinceReport ? "text-bg-warning" : "text-bg-success"}`;
    status.textContent = changedSinceReport ? "seit der Meldung geändert" : "unverändert";
  }
  const currentText = byId("report-current");
  currentText.hidden = current === null || !changedSinceReport;
  currentText.textContent = current === null ? "" : JSON.stringify(current, null, 2);

  const files = current?.files ?? [];
  byId("report-files-group").hidden = files.length === 0;
  byId("report-files").replaceChildren(...files.map((file, index) => {
    const text = `Datei ${index + 1} (${file.mimeType}, ${formatSize(file.size)})`;
    const link = create("a", "btn btn-sm btn-outline-secondary fw-bold", text) as HTMLAnchorElement;
    link.href = `/moderation/api/reports/${report.reportId}/files/${file.fileMetaDataId}`;
    link.download = "";
    return link;
  }));
}

function renderReport(data: ReportDetails): void {
  currentReport = data;
  const { report } = data;
  byId("report-title").textContent = `Meldung #${report.reportId}`;
  categoryBadge(report.category, byId("report-category"));
  fillFacts("report-facts", reportFacts(data));
  byId("report-snapshot").textContent = JSON.stringify(report.snapshot, null, 2);
  renderCurrent(data);

  const decided = report.resolvedAt !== null;
  byId("report-decided").hidden = !decided;
  byId("decision-form").hidden = decided;
  if (decided) {
    fillFacts("report-decision-facts", [
      ["Entschieden am", formatDateTime(report.resolvedAt!)],
      ["Entscheidung", report.action === null ? "–" : ACTIONS[report.action].done],
      ["Grund", labelOf(GROUND_LABELS, report.decisionGround)],
      ["Begründung", report.decisionReason ?? "–"]
    ]);
  }
  else {
    renderDecisionForm(data);
  }
}

function renderDecisionForm(data: ReportDetails): void {
  const { report, author, editor } = data;
  byId("decision-scope-text").textContent = data.otherOpenOnTarget > 0
    ? `Die Entscheidung gilt auch für ${data.otherOpenOnTarget} weitere offene Meldung(en) zu diesem Inhalt.`
    : "Es gibt keine weiteren offenen Meldungen zu diesem Inhalt.";

  byId("decision-actions").replaceChildren(...data.actions.flatMap(action => {
    const input = create("input", "btn-check") as HTMLInputElement;
    input.type = "radio";
    input.name = "decision-action";
    input.id = `decision-action-${action}`;
    input.value = action;
    input.checked = action === "dismiss";
    input.addEventListener("change", updateDecisionForm);
    const label = create("label", "btn btn-outline-secondary fw-bold", ACTIONS[action].label) as HTMLLabelElement;
    label.htmlFor = input.id;
    return [input, label];
  }));

  // one ban hits one account, so the operator says which; an account is banned only once, a deleted one never
  const banTarget = byId<HTMLSelectElement>("decision-ban-target");
  banTarget.replaceChildren();
  if (report.targetAccountId !== null && isBannable(author)) {
    banTarget.append(new Option(`Autor ${accountText(report.targetAccountId, author)}`, "author"));
  }
  const editorIsAuthor = report.editorAccountId === report.targetAccountId;
  if (report.editorAccountId !== null && !editorIsAuthor && isBannable(editor)) {
    banTarget.append(new Option(`Letzter Bearbeiter ${accountText(report.editorAccountId, editor)}`, "editor"));
  }
  byId<HTMLSelectElement>("decision-ground").value = "";
  byId<HTMLTextAreaElement>("decision-reason").value = "";
  toggleAlert("decision-error", false);
  updateDecisionForm();
}

function selectedAction(): ModerationAction {
  const checked = document.querySelector<HTMLInputElement>("input[name=decision-action]:checked");
  return (checked?.value ?? "dismiss") as ModerationAction;
}

function updateDecisionForm(): void {
  const action = selectedAction();
  const { hint, reason, rotate, button, label } = ACTIONS[action];
  byId("decision-action-hint").textContent = hint;
  byId("decision-reason-hint").textContent = reason;
  byId("decision-ground-group").hidden = action === "dismiss";
  byId("decision-ban-group").hidden = !isBanAction(action);
  byId("decision-rotate-group").hidden = rotate === undefined || currentReport?.report.classId === null;
  byId("decision-rotate-hint").textContent = rotate ?? "";
  // a banned account still knows the class code, so bans change it unless the operator unticks it
  byId<HTMLInputElement>("decision-rotate").checked = isBanAction(action);
  const submit = byId("decision-submit");
  submit.className = `btn fw-bold ${button}`;
  submit.textContent = label;
}

function showDecisionError(message: string): void {
  byId("decision-error-text").textContent = message;
  toggleAlert("decision-error", true);
}

function rotateChecked(): boolean {
  return !byId("decision-rotate-group").hidden && byId<HTMLInputElement>("decision-rotate").checked;
}

// request body, or message why form cannot be sent yet
function readDecisionForm(): { body: Record<string, unknown> } | { error: string } {
  const action = selectedAction();
  const ground = byId<HTMLSelectElement>("decision-ground").value;
  const reason = byId<HTMLTextAreaElement>("decision-reason").value.trim();
  if (action === "dismiss") {
    return { body: { action, reason } };
  }
  if (ground === "") {
    return { error: "Wähle einen Grund." };
  }
  if (reason === "") {
    return { error: "Schreib eine Begründung. Die Betroffenen lesen sie." };
  }
  return {
    body: {
      action,
      ground,
      reason,
      ...(!byId("decision-rotate-group").hidden ? { rotateClassCode: rotateChecked() } : {}),
      ...(isBanAction(action) ? { banTarget: byId<HTMLSelectElement>("decision-ban-target").value } : {})
    }
  };
}

async function submitDecision(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  if (currentReport === null) return;
  toggleAlert("decision-error", false);

  const form = readDecisionForm();
  if ("error" in form) {
    showDecisionError(form.error);
    return;
  }
  const confirmation = ACTIONS[selectedAction()].confirm;
  const rotateNote = rotateChecked() ? " Der Klassencode wird geändert und alle anonymen Mitglieder werden abgemeldet." : "";
  if (confirmation && !window.confirm(confirmation + rotateNote)) return;

  const submit = byId<HTMLButtonElement>("decision-submit");
  submit.disabled = true;
  try {
    await api("POST", `/reports/${currentReport.report.reportId}/resolve`, form.body);
    navigate("/moderation");
  }
  catch (error) {
    if (error instanceof ApiError && error.status !== 401) {
      showDecisionError(error.message);
    }
    else {
      handleError(error);
    }
  }
  finally {
    submit.disabled = false;
  }
}

// ---------- Routing ----------

function reportIdFromUrl(): number | null {
  const id = new URLSearchParams(location.search).get("report");
  return id !== null && /^\d+$/.test(id) ? Number(id) : null;
}

async function route(): Promise<void> {
  showPageError(null);
  const reportId = reportIdFromUrl();
  try {
    if (reportId === null) {
      const data = await api<Overview>("GET", "/overview");
      renderOverview(data);
      setLoginUntil(data.loginUntil);
      showView("overview-view");
    }
    else {
      const data = await api<ReportDetails>("GET", `/reports/${reportId}`);
      renderReport(data);
      setLoginUntil(data.loginUntil);
      showView("report-view");
    }
  }
  catch (error) {
    handleError(error, false);
  }
}

function navigate(url: string): void {
  history.pushState(null, "", url);
  void route();
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "Keine Verbindung zum Server. Prüf deine Verbindung und lade die Seite neu.";
  }
  return error.status === 429 ? "Zu viele Anfragen. Warte kurz und lade die Seite dann neu." : error.message;
}

function handleError(error: unknown, resume = true): void {
  if (error instanceof ApiError && error.status === 401) {
    const wasLoggedIn = activeView !== null && activeView !== "login-view";
    showLogin(wasLoggedIn, resume && wasLoggedIn);
    return;
  }
  showPageError(errorMessage(error));
  if (activeView === null || activeView === "login-view") {
    // nothing to show below the error
    for (const id of VIEWS) byId(id).hidden = true;
  }
}

// ---------- Login ----------

async function submitLogin(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const input = byId<HTMLInputElement>("login-password");
  toggleAlert("login-wrong-password", false);
  toggleAlert("login-too-many", false);
  if (input.value === "") {
    input.focus();
    return;
  }
  const button = byId<HTMLButtonElement>("login-button");
  button.disabled = true;
  try {
    const login = await api<{ loginUntil: number; csrfToken: string }>("POST", "/login", { password: input.value });
    // the login starts a new session with a new token
    csrfToken = login.csrfToken;
    input.value = "";
    updatePasswordToggle();
    if (interruptedView !== null) {
      showView(interruptedView);
      setLoginUntil(login.loginUntil);
      interruptedView = null;
    }
    else {
      await route();
    }
  }
  catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      toggleAlert("login-expired", false);
      toggleAlert("login-wrong-password", true);
      input.select();
    }
    else if (error instanceof ApiError && error.status === 429) {
      toggleAlert("login-too-many", true);
    }
    else {
      handleError(error);
    }
  }
  finally {
    button.disabled = false;
  }
}

let passwordVisible = false;

function updatePasswordToggle(): void {
  const input = byId<HTMLInputElement>("login-password");
  const toggle = byId<HTMLButtonElement>("login-password-toggle");
  if (input.value === "") passwordVisible = false;
  toggle.hidden = input.value === "";
  input.type = passwordVisible ? "text" : "password";
  toggle.setAttribute("aria-label", passwordVisible ? "Passwort verbergen" : "Passwort anzeigen");
  const icon = toggle.querySelector("i")!;
  icon.classList.toggle("fa-eye", !passwordVisible);
  icon.classList.toggle("fa-eye-slash", passwordVisible);
}

async function logout(): Promise<void> {
  try {
    await api("POST", "/logout");
  }
  catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      handleError(error);
      return;
    }
  }
  // the server destroyed the session and its token
  csrfToken = null;
  interruptedView = null;
  history.replaceState(null, "", "/moderation");
  showLogin(false, false);
}

// ---------- Start ----------

// same rule as app: stored choice first, then system setting
function applyColorTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("colorTheme");
  }
  catch {
    // storage can be blocked, system setting is used then
  }
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = stored === "dark" || stored === "light" ? stored : prefersDark ? "dark" : "light";
  document.documentElement.dataset.bsTheme = theme;
  document.body.dataset.bsTheme = theme;
  document.documentElement.style.background = theme === "dark" ? "#212529" : "#ffffff";
}

applyColorTheme();

byId("login-form").addEventListener("submit", ev => void submitLogin(ev));
byId("login-password").addEventListener("input", updatePasswordToggle);
byId("login-password-toggle").addEventListener("click", () => {
  passwordVisible = !passwordVisible;
  updatePasswordToggle();
  byId("login-password").focus();
});
byId("decision-form").addEventListener("submit", ev => void submitDecision(ev));
byId("logout-button").addEventListener("click", () => void logout());
byId("reload-button").addEventListener("click", () => void route());
byId("open-report-form").addEventListener("submit", ev => {
  ev.preventDefault();
  const id = byId<HTMLInputElement>("open-report-id").value;
  if (/^\d+$/.test(id)) navigate(`/moderation?report=${id}`);
});

// links inside panel switch views without reloading page
document.addEventListener("click", ev => {
  const link = (ev.target as Element).closest<HTMLAnchorElement>("a[data-nav]");
  if (!link || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  ev.preventDefault();
  navigate(link.href);
});
window.addEventListener("popstate", () => void route());

void route();

// make this file module, so helper names stay out of global scope
export {};
