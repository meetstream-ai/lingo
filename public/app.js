const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const state = {
  config: null,
  summaryBusy: new Set(),
  meetings: [],
  library: null,
  page: 1,
  query: "",
  filter: "all",
  libraryLayout: localStorage.getItem("meeting-library-layout") === "list" ? "list" : "grid",
  panel: "overview",
  selectionEpoch: 0,
  libraryEpoch: 0,
  recording: null,
  recordingTimer: null,
  snapshot: null,
  language: localStorage.getItem("caption-language") || "en",
  kind: "live",
  view: "captions",
  paused: false,
  stream: null,
  lastAnnounced: null,
  clientId: crypto.randomUUID(),
  receipts: new Set(),
  clockOffset: 0,
  connectedAt: 0,
  reviewCue: null,
};
const label = (code) =>
  state.config?.languages[code]?.split(" · ").at(-1) ||
  code ||
  "Detecting language";
const time = (seconds) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds) % 60).padStart(2, "0")}`;
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), 5000);
}
function error(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("The server returned an unexpected response.");
  }
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/login") {
      state.stream?.close();
      if (!$("login-dialog").open) $("login-dialog").showModal();
    }
    throw new Error(body.error || "Request failed.");
  }
  return body;
}
const post = (path, body = {}) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
const panels = {
  overview: "Overview",
  captions: "Live captions",
  transcript: "Transcript",
  recording: "Recordings",
  notes: "Notes & actions",
  summary: "Summary",
};
function routeHref({
  destination = state.view,
  meeting = state.snapshot?.meeting.id,
  kind = state.kind,
  panel = state.panel,
} = {}) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.pathname=destination==='captions' && meeting?`/workspace/meetings/${encodeURIComponent(meeting)}${panel==='overview'?'':'/'+panel}`:({sessions:'/workspace/meetings',settings:'/workspace/connections',measurements:'/workspace/health',captions:'/workspace/captions'})[destination] || '/workspace/captions';
  if (meeting && destination!=='captions') url.searchParams.set("meeting", meeting);
  if (kind === "final") url.searchParams.set("kind", "final");
  if (meeting && destination!=="captions" && panel !== "overview") url.searchParams.set("panel", panel);
  if (state.page > 1) url.searchParams.set("page", state.page);
  if (state.query) url.searchParams.set("q", state.query);
  if (state.filter !== "all") url.searchParams.set("status", state.filter);
  return url.href;
}
let restorationEpoch = 0;
let scrollTimer,
  restoringRoute = false;
history.scrollRestoration = "manual";
function rememberScroll() {
  history.replaceState(
    { ...history.state, scrollY: window.scrollY },
    "",
    location.href,
  );
}
window.addEventListener(
  "scroll",
  () => {
    clearTimeout(scrollTimer);
    if (!restoringRoute) scrollTimer = setTimeout(rememberScroll, 500);
  },
  { passive: true },
);
function saveRoute(mode = "push") {
  if (mode === "none") return;
  const url = routeHref();
  if (url !== location.href) {
    clearTimeout(scrollTimer);
    if (mode === "push") rememberScroll();
    history[mode === "replace" ? "replaceState" : "pushState"](
      mode === "replace" ? history.state : { scrollY: 0 },
      "",
      url,
    );
  }
}
let breadcrumbKey = "";
function renderBreadcrumb() {
  const m = state.snapshot?.meeting;
  const name = {
    captions: m ? panels[state.panel] : "Captions",
    sessions: "Meetings",
    measurements: "Meeting health",
    settings: "Connections",
  }[state.view];
  const items =
    state.view === "captions" && m
      ? `<a href="${esc(routeHref({ destination: "sessions" }))}" data-library>Meetings</a><span aria-hidden="true">/</span><a href="${esc(routeHref({ destination: "captions", panel: "overview" }))}" data-panel="overview" title="${esc(m.title)}">${esc(m.title)}</a><span aria-hidden="true">/</span><span aria-current="page">${name}</span>`
      : `<a href="${esc(routeHref({ destination: "sessions" }))}" data-library>Workspace</a><span aria-hidden="true">/</span><span aria-current="page">${name}</span>`;
  if (items !== breadcrumbKey) {
    breadcrumbKey = items;
    $("breadcrumb").innerHTML = items;
  }
  document.title = `${m && state.view === "captions" ? m.title + " · " : ""}${name} · Lingo`;
}
function pauseRecording() {
  for(const id of ["audio-player", "video-player"]) if(!$(id).paused) $(id).pause();
}
function renderMeetingPanels() {
  const m = state.snapshot?.meeting,
    all = state.panel === "overview";
  $("view-captions").classList.toggle("meeting-selected", !!m);
  $("workspace-heading").textContent = m?.title || "Every voice, understood.";
  $("workspace-description").textContent = m
    ? {
        overview:
          "Captions, transcripts, recordings and follow-ups in one place.",
        captions: "Follow the conversation in your selected language.",
        transcript: "Review the original words alongside their translation.",
        recording: "Play or download the saved meeting recording.",
        summary: "A short overview in your selected language.",
        notes: "Keep decisions and follow-ups with this conversation.",
      }[state.panel]
    : "Follow the conversation in the language that works for you.";
  $("sample-notice").hidden =
    !m || m.mode !== "demo" || !["overview", "captions"].includes(state.panel);
  $("meeting-sections").hidden = !m;
  $("back-to-meetings").hidden = !m;
  $("back-to-meetings").href = routeHref({ destination: "sessions" });
  for (const a of $("meeting-sections").querySelectorAll("[data-panel]")) {
    a.href = routeHref({ destination: "captions", panel: a.dataset.panel });
    if (a.dataset.panel === state.panel) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  $("caption-panel").hidden = !!m && (m.endedAt ? state.panel !== "captions" : !all && state.panel !== "captions");
  $("detail-layout").classList.toggle("recording-workspace", !!m?.endedAt && m.mode === "live" && ["overview", "transcript"].includes(state.panel));
  $("transcript-panel").hidden = !!m && !all && state.panel !== "transcript";
  $("summary-panel").hidden = !m || (!all && state.panel !== "summary");
  $("notebook-panel").hidden = !m || (!all && state.panel !== "notes");
  $("recording-panel").hidden =
    !m || m.mode !== "live" || (!all && state.panel !== "recording" && !(m.endedAt && state.panel === "transcript"));
  $("recording-empty").hidden =
    !m || m.mode !== "demo" || state.panel !== "recording";
  if($("recording-panel").hidden || state.view !== "captions") pauseRecording();
  if (!captionsVisible()) {
    $("announcer").textContent = "";
    state.lastAnnounced = null;
  }
  renderBreadcrumb();
}
function captionsVisible() {
  return (
    state.view === "captions" &&
    ["overview", "captions"].includes(state.panel) &&
    !state.paused &&
    (!state.snapshot?.meeting.endedAt || state.panel === "captions") &&
    document.visibilityState === "visible"
  );
}
document.addEventListener("visibilitychange", () => {
  if (state.snapshot && captionsVisible()) renderCaption();
});
function normalNavigation(event) {
  return (
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    event.button === 0
  );
}
function sectionNavigation(event) {
  if (!normalNavigation(event)) return;
  if (event.target.closest("[data-library]")) {
    event.preventDefault();
    view("sessions");
  }
  const a = event.target.closest("[data-panel]");
  if (a && state.snapshot) {
    event.preventDefault();
    state.panel = a.dataset.panel;
    view("captions");
  }
}
$("breadcrumb").addEventListener("click", sectionNavigation);
$("meeting-sections").addEventListener("click", sectionNavigation);
$("back-to-meetings").addEventListener("click", sectionNavigation);
function view(name, mode = "push") {
  if(typeof stopTranslatedAudio === "function") stopTranslatedAudio();
  if (mode !== "none") {
    restorationEpoch++;
    restoringRoute = false;
  }
  if (!["captions", "sessions", "measurements", "settings"].includes(name))
    name = "captions";
  state.selectionEpoch++;
  state.view = name;
  saveRoute(mode);
  document
    .querySelectorAll(".view")
    .forEach((x) => (x.hidden = x.id !== `view-${name}`));
  document.querySelectorAll("[data-view]").forEach((x) => {
    const active = x.dataset.view === name;
    x.classList.toggle("active", active);
    if (active) x.setAttribute("aria-current", "page");
    else x.removeAttribute("aria-current");
  });
  renderMeetingPanels();
  if (name === "captions" && state.snapshot && !state.paused) renderCaption();
  if (mode === "push") {
    $("main").focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  if (name === "sessions") refreshMeetings().catch((e) => toast(e.message));
  if (name === "measurements") renderMetrics();
  if (name === "settings") refreshConfig().catch((e) => toast(e.message));
}
document.querySelectorAll("[data-view]").forEach((button) =>
  button.addEventListener("click", () => {
    if (button.dataset.view === "captions")
      state.panel = state.snapshot ? "captions" : "overview";
    view(button.dataset.view);
  }),
);
document
  .querySelectorAll("[data-close]")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
  );
function openNew() {
  updateProviderChoices();
  const link = new URL(location.href).searchParams.get("meetingLink");
  if (link) { $("meeting-form").elements.meetingLink.value = link; $("meeting-form").elements.mode.value = "live"; updateMode(); }
  error("new-error", "");
  $("new-dialog").showModal();
}
document
  .querySelectorAll("[data-new-meeting]")
  .forEach((button) => button.addEventListener("click", openNew));
function setupConfig() {
  $("source-language").innerHTML =
    '<option value="auto">Detect automatically</option>' +
    Object.entries(state.config.languages)
      .map(([code, name]) => `<option value="${code}">${esc(name)}</option>`)
      .join("");
  $("target-options").querySelector(".target-choices")?.remove();
  $("target-options").insertAdjacentHTML(
    "beforeend",
    '<div class="target-choices">' +
      Object.entries(state.config.languages)
        .map(
          ([code, name]) =>
            `<label><input type="checkbox" name="targets" value="${code}" ${["en", "hi"].includes(code) ? "checked" : ""}>${esc(name)}</label>`,
        )
        .join("") +
      "</div>",
  );
  $("profile-language").innerHTML = Object.entries(state.config.languages)
    .map(([code, name]) => `<option value="${code}">${esc(name)}</option>`)
    .join("");
  updateMode();
  renderConnections();
  updateProviderChoices();
}
function updateProviderChoices() {
  const form=$("meeting-form"), config=state.config;
  for(const option of form.elements.translationProvider.options) {
    option.disabled=!config.providers[option.value] || config.connections?.find(c=>c.id===option.value)?.check?.status === "failed";
  }
  for(const name of ["liveProvider","postCallProvider"]) for(const option of form.elements[name].options) {
    const provider=option.value.replace("_streaming", ""), check=provider === "deepgram" ? config.deepgram : config.managedChecks?.[provider === "jigsawstack" ? "jigsawstack_asr" : provider];
    option.disabled=check?.status === "failed";
  }
  const selected=form.elements.translationProvider.selectedOptions[0];
  if(selected?.disabled) form.elements.translationProvider.value="";
  if(!form.elements.translationProvider.value) {
    const usable=[...form.elements.translationProvider.options].find(o=>!o.disabled);
    if(usable) form.elements.translationProvider.value=usable.value;
  }
  $("provider-readiness").textContent="Providers with missing credentials or a failed check are unavailable. Text translation is checked again before a bot can join. Speech access is confirmed when captions arrive.";
  updateMode();
}
function updateMode() {
  const live = new FormData($("meeting-form")).get("mode") === "live";
  $("live-fields").hidden = !live;
  $("create-meeting").textContent = live ? "Join meeting" : "Start sample";
  const provider = $("meeting-form").elements.translationProvider.value;
  const supported = state.config.translationLanguages[provider];
  document.querySelectorAll("#target-options input").forEach((x) => {
    const unavailable = live ? (!supported || !Object.hasOwn(supported, x.value)) : !["en", "hi", "ta"].includes(x.value);
    x.disabled = unavailable;
    const query = $("target-search").value.toLocaleLowerCase();
    x.closest("label").hidden = unavailable || (!x.checked && !(`${x.value} ${x.closest("label").textContent}`.toLocaleLowerCase().includes(query)));
    if (unavailable) x.checked = false;
  });
}
$("meeting-form").addEventListener("change", (event) => {
  if (["mode", "translationProvider"].includes(event.target.name)) updateMode();
  if (event.target.name === "liveProvider") {
    $("post-call-provider").value =
      ({ deepgram_streaming: "deepgram", jigsawstack_streaming: "jigsawstack", assemblyai_streaming: "assemblyai" }[event.target.value] || "meetstream");
    if (event.target.value === "assemblyai_streaming") $("source-language").value = "en";
  }
});
$("meeting-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("create-meeting");
  button.disabled = true;
  error("new-error", "");
  try {
    const form = new FormData(event.currentTarget),
      body = Object.fromEntries(form);
    if(!body.title?.trim()){body.title=body.mode==='live'?'Meeting':'Sample conversation';body.autoTitle=body.mode==='live';}
    if(body.mode === "live") for(const field of ["liveProvider","postCallProvider","translationProvider"]) {
      const select=event.currentTarget.elements[field];
      if(!select.value || select.selectedOptions[0]?.disabled) throw Error("Choose available speech and translation providers. Repair failed connections in Connections before joining.");
    }
    body.targets = form.getAll("targets");
    if (body.mode === "demo") {
      body.source = "auto";
      body.translationProvider = "google"; // Samples use the handwritten English/Hindi/Tamil catalog.
      body.liveProvider = "meetstream_streaming";
      body.postCallProvider = "meetstream";
    }
    const m = await post("/api/meetings", body);
    $("new-dialog").close();
    await refreshMeetings();
    await selectMeeting(m.id);
  } catch (e) {
    error("new-error", e.message);
  } finally {
    button.disabled = false;
  }
});
$("start-sample").addEventListener("click", async () => {
  $("start-sample").disabled = true;
  try {
    const m = await post("/api/meetings", {
      title: "A more accessible team sync",
      mode: "demo",
      targets: ["en", "hi"],
    });
    await refreshMeetings();
    await selectMeeting(m.id);
  } catch (e) {
    toast(e.message);
  } finally {
    $("start-sample").disabled = false;
  }
});
async function refreshMeetings() {
  const epoch = ++state.libraryEpoch;
  $("meeting-page").textContent = "Loading meetings…";
  $("meeting-prev").disabled = true;
  $("meeting-next").disabled = true;
  let result;
  try { result = await api(
    `/api/meetings?${new URLSearchParams({ page: state.page, q: state.query, status: state.filter })}`,
  ); } catch(e) { if(epoch === state.libraryEpoch) { $("meeting-page").textContent = "Meetings could not be refreshed."; $("library-error").textContent = e.message + " Use Refresh to retry."; $("library-error").hidden = false; } throw e; }
  if (epoch !== state.libraryEpoch) return;
  $("library-error").hidden = true;
  state.library = result;
  state.page = result.page;
  state.meetings = result.items;
  if (state.view === "sessions") saveRoute("replace");
  renderMeetings();
}
function renderMeetings() {
  $("meeting-page").textContent = state.library
    ? `Page ${state.page} of ${state.library.pages} · ${state.library.total} meetings`
    : "Loading meetings…";
  $("meeting-prev").disabled = state.page <= 1;
  $("meeting-next").disabled =
    !state.library || state.page >= state.library.pages;
  const current = state.snapshot?.meeting.id || "";
  $("meeting-picker").innerHTML =
    '<option value="">Select meeting</option>' +
    [
      ...state.meetings,
      ...(state.snapshot && !state.meetings.some((m) => m.id === current)
        ? [state.snapshot.meeting]
        : []),
    ]
      .map(
        (m) =>
          `<option value="${m.id}" ${current === m.id ? "selected" : ""}>${esc(m.title)}</option>`,
      )
      .join("");
  $("meeting-list").classList.toggle("layout-list", state.libraryLayout === "list");
  $("library-grid").setAttribute("aria-pressed", String(state.libraryLayout === "grid"));
  $("library-list").setAttribute("aria-pressed", String(state.libraryLayout === "list"));
  const groups = new Map();
  for (const m of state.meetings) {
    const month = new Date(m.createdAt).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(m);
  }
  $("meeting-list").innerHTML = groups.size ? [...groups].map(([month, meetings]) => `<section class="meeting-group"><h2 class="meeting-month">${esc(month)}<span>${meetings.length} on this page</span></h2><div class="meeting-grid">${meetings.map(m => {
    const href = routeHref({ destination: "captions", meeting: m.id, kind: m.postCallStatus === "ready" && m.endedAt ? "final" : "live", panel: m.postCallStatus === "ready" && m.endedAt ? "transcript" : "overview" });
    const attention = m.status === "failed" || m.postCallStatus === "failed";
    const status = attention ? "Needs attention" : m.postCallStatus === "ready" ? "Transcript ready" : ({live:"Live",connecting:"Connecting",joining:"Joining",waiting:"Waiting for admission",stopping:"Ending",stopped:"Processing",completed:"Completed"}[m.status] || m.status);
    const platform = m.mode === "demo" ? "Sample replay" : /meet\.google\.com/.test(m.meetingLink || "") ? "Google Meet" : /zoom\.us/.test(m.meetingLink || "") ? "Zoom" : /teams\.(microsoft|live)\.com/.test(m.meetingLink || "") ? "Microsoft Teams" : "Meeting";
    return `<article class="meeting-card"><a class="meeting-cover" href="${esc(href)}" data-open-meeting="${m.id}" aria-label="Open meeting ${esc(m.title)}"><span class="meeting-platform">${platform}</span><svg aria-hidden="true"><use href="#captions-icon" /></svg><span class="meeting-media-type">${m.mode === "demo" ? "Handwritten sample" : m.recordVideo ? "Video + audio" : "Audio meeting"}</span></a><div class="meeting-card-body"><div class="meeting-card-meta"><time datetime="${esc(new Date(m.createdAt).toISOString())}">${esc(new Date(m.createdAt).toLocaleDateString(undefined,{day:"numeric",month:"short"}))}</time><span class="meeting-badge ${attention ? "attention" : m.status === "live" ? "live" : ""}">${esc(status)}</span></div><h3><a class="meeting-title" href="${esc(href)}" data-open-meeting="${m.id}" dir="auto">${esc(m.title)}</a></h3><p class="meeting-language-tags">${m.targets.slice(0,3).map(code=>`<span>${esc(label(code))}</span>`).join("")}${m.targets.length > 3 ? `<span>+${m.targets.length - 3} languages</span>` : ""}</p>${m.actions?.length ? `<p class="meeting-actions-count">${m.actions.filter(a=>a.done).length} / ${m.actions.length} action items completed</p>` : ""}<button class="text-button meeting-open" data-open-meeting="${m.id}">Open meeting <span aria-hidden="true">↗</span></button></div></article>`;
  }).join("")}</div></section>`).join("") : `<div class="library-empty"><svg aria-hidden="true"><use href="#sessions-icon" /></svg><h2>${state.query || state.filter !== "all" ? "No matching meetings" : "Your meetings belong here"}</h2><p>${state.query || state.filter !== "all" ? "Try a different search or status filter." : "Start a meeting to save its recording, translated transcript, and follow-ups."}</p></div>`;

}
for (const [id, layout] of [["library-grid", "grid"], ["library-list", "list"]]) $(id).addEventListener("click", () => {
  state.libraryLayout = layout; localStorage.setItem("meeting-library-layout", layout); renderMeetings();
});
$("library-refresh").addEventListener("click", async event => {
  event.currentTarget.disabled = true;
  try { await refreshMeetings(); } catch(e) { toast(e.message); } finally { $("library-refresh").disabled = false; }
});
$("meeting-list").addEventListener("click", (event) => {
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  )
    return;
  const id = event.target.closest("[data-open-meeting]")?.dataset.openMeeting;
  if (id) {
    event.preventDefault();
    const m = state.meetings.find((x) => x.id === id),
      final = m?.endedAt && m.postCallStatus === "ready";
    selectMeeting(id, {
      kind: final ? "final" : "live",
      panel: final ? "transcript" : "overview",
    }).catch((e) => toast(e.message));
  }
});
$("meeting-picker").addEventListener("change", (event) => {
  if (event.target.value)
    selectMeeting(event.target.value).catch((e) => toast(e.message));
});
async function selectMeeting(
  id,
  {
    mode = "push",
    kind = "live",
    destination = "captions",
    panel = "overview",
  } = {},
) {
  const epoch = ++state.selectionEpoch;
  const snapshot = await api(`/api/meetings/${encodeURIComponent(id)}`);
  if (epoch !== state.selectionEpoch) return;
  clearTimeout(state.recordingTimer);
  pauseRecording();
  state.recording = null;
  state.stream?.close();
  state.snapshot = snapshot;
  state.paused = false;
  state.lastAnnounced = null;
  state.kind = kind;
  state.panel = panel;
  $("transcript-search").value = "";
  state.connectedAt = Date.now() + state.clockOffset;
  const preferred = localStorage.getItem("caption-language");
  if (snapshot.meeting.targets.includes(preferred)) state.language = preferred;
  if (!snapshot.meeting.targets.includes(state.language))
    state.language = snapshot.meeting.targets[0];
  $("viewer-language").innerHTML = snapshot.meeting.targets
    .map(
      (code) =>
        `<option value="${code}">${esc(state.config.languages[code])}</option>`,
    )
    .join("");
  $("viewer-language").value = state.language;
  $("pause-view").setAttribute("aria-pressed", "false");
  $("pause-view").textContent = "Pause display";
  renderSnapshot();
  renderMeetings();
  view(destination, mode);
  void refreshRecording();
  const stream = new EventSource(
    `/api/meetings/${encodeURIComponent(id)}/events`,
  );
  state.stream = stream;
  stream.onopen = () => {
    if (state.snapshot?.meeting.id === id) renderSnapshot();
  };
  stream.onmessage = (event) => {
    if (state.snapshot?.meeting.id !== id) return;
    try {
      state.snapshot = JSON.parse(event.data);
      renderSnapshot();
    } catch {
      toast("A caption update could not be read. Reconnect to the meeting.");
    }
  };
  stream.onerror = () => {
    if (state.snapshot?.meeting.id === id)
      $("stream-status").textContent = "Connection interrupted · reconnecting";
  };
}
function renderSnapshot() {
  const { meeting: m, cues, failures } = state.snapshot;
  document.body.dataset.meetingId = m.id;
  const listed = state.meetings.find((meeting) => meeting.id === m.id);
  if (
    listed &&
    (listed.status !== m.status || listed.metadataVersion !== m.metadataVersion)
  ) {
    Object.assign(listed, m);
    renderMeetings();
  }
  $("session-title").textContent = m.title;
  const parts=$('recording-parts');parts.hidden=!m.previousMeetingId && !m.nextMeetingId && !m.languageSwitch;
  parts.replaceChildren();
  for(const [id,title] of [[m.previousMeetingId,'Previous recording part'],[m.nextMeetingId,'Continue to next recording part']]) {
    if(!id)continue;const link=document.createElement('a');link.href=routeHref({destination:'captions',meeting:id,panel:'overview',kind:'live'});link.textContent=title;link.addEventListener('click',e=>{e.preventDefault();selectMeeting(id).catch(e=>toast(e.message));});parts.append(link);
  }
  if(m.languageSwitch && !m.nextMeetingId){const status=document.createElement('span');status.setAttribute('role','status');status.textContent=m.languageSwitch.cancelled?'Language switch cancelled':m.languageSwitch.status==='failed'?'Language switch needs attention. Use Retry after checking the error.':`Changing spoken language to ${label(m.languageSwitch.source)} — ${m.languageSwitch.status==='starting'?'starting next recording':'waiting for the bot to leave'}…`;parts.append(status);}

  $("spoken-language-info").disabled=false;$("refresh-meeting-name").hidden=m.mode!=="live" || !state.config.integrations.calendar;$("meeting-name-status").textContent=m.titleSource==="calendar"?"Name from Google Calendar":m.titleSource==="browser"?"Name from your meeting tab":m.nameError?"Calendar name unavailable. You can edit the name.":"";
  $("meeting-services").hidden=false;
  const services=m.services;
  $("meeting-services").innerHTML=services?`<span><small>Live speech to text</small><strong>${esc(services.speech)}</strong></span><span><small>Text translation</small><strong>${esc(services.translation)}</strong></span><span><small>Post-call transcript</small><strong>${esc(services.postCall)}</strong></span><span><small>Spoken language</small><strong>${esc(services.source)}</strong></span>`:'';
  $("join-call").hidden = !m.meetingLink;
  if (m.meetingLink) $("join-call").href = m.meetingLink;
  $("copy-meeting-link").disabled = false;
  $("save-archive").disabled = false;
  $("saved-status").textContent = "Saved automatically in this workspace";
  $("edit-meeting").disabled = false;
  renderNotebook();
  renderSummary();
  renderRecording();
  $("session-status").textContent =
    {
      live: m.mode === "demo" ? "Sample replay" : "Live",
      completed: "Completed",
      connecting: "Connecting",
      joining: "Joining",
      waiting: "Waiting for admission",
      stopping: "Ending",
      stopped: "Post-call processing",
      failed: "Needs attention",
    }[m.status] || m.status;
  $("session-status").className =
    `status ${["live", "completed"].includes(m.status) ? "" : ["failed", "waiting"].includes(m.status) ? "warning" : "neutral"}`;
  $("session-detail").textContent =
    `${new Set(cues.map((c) => c.speaker)).size} speaker${new Set(cues.map((c) => c.speaker)).size === 1 ? "" : "s"} · ${m.mode === "demo" ? "Simulated dialogue" : m.postCallStatus === "ready" && m.endedAt ? ({meetstream:"MeetStream",deepgram:"Deepgram",assemblyai:"AssemblyAI",jigsawstack:"JigsawStack"}[m.postCallProvider] || m.postCallProvider || "Unknown") + " post-call" : ({ meetstream_streaming: "MeetStream", deepgram_streaming: "Deepgram", assemblyai_streaming: "AssemblyAI", jigsawstack_streaming: "JigsawStack" }[m.liveProvider] || m.liveProvider) + " transcription"}`;
  $("sample-notice").hidden = m.mode !== "demo";
  $("stream-status").textContent = m.status === "failed" || m.liveError
    ? "Live captions unavailable · provider needs attention"
    : m.endedAt ? "Meeting ended · saved captions"
      : m.mode === "demo" ? "Sample stream connected"
        : m.status === "live" ? "Receiving caption updates"
          : m.status === "waiting" ? "Waiting for bot admission"
            : m.status === "stopping" ? "Ending meeting · saving captions"
              : "Connecting meeting bot";
  $("add-language-open").disabled = !state.snapshot;
  $("stop-meeting").disabled =
    ["completed", "stopped", "failed", "stopping"].includes(m.status) ||
    !!m.endedAt;
  $("export-open").disabled = !cues.length;
  $("show-live").setAttribute("aria-pressed", String(state.kind === "live"));
  $("show-final").setAttribute("aria-pressed", String(state.kind === "final"));
  $("meeting-error").hidden = !m.lastError && !m.liveError && !failures.length;
  $("meeting-error").innerHTML =
    m.lastError || m.liveError || failures.length
      ? `${m.postCallStatus === "ready" && m.liveError ? `Live captions failed in this call; the saved transcript was recovered using ${esc(m.postCallProvider)}. ` : ""}${esc(m.liveError || m.lastError || "Some work needs attention. Your original captions are preserved.")} ${failures.length || m.postCallStatus === "failed" ? '<button class="secondary" id="retry-work">Retry failed work</button>' : ""}`
      : "";
  if (!state.paused) renderCaption();
  renderTranscript();
  renderMeetingPanels();
  if (state.view === "measurements") renderMetrics();
}
function renderCaption() {
  const m = state.snapshot?.meeting;
  const latest = state.snapshot?.cues.filter((c) => c.kind === "live").at(-1);
  $("caption-empty").hidden = !!latest || !!state.snapshot;
  $("caption-waiting").hidden = !!latest || !state.snapshot;
  $("caption-waiting").textContent = m?.status === "failed" || m?.liveError
    ? `Live captions are unavailable. ${m.liveError || m.lastError || "Check the meeting error and Connections before retrying."}`
    : m?.endedAt
      ? "This call has ended. Review its saved live record or post-call transcript below."
      : "Waiting for speech. Admit the bot and speak in the meeting to begin captions.";
  $("caption-content").hidden = !latest;
  if (!latest) return;
  const t = latest.translations[state.language];
  $("current-speaker").textContent = latest.speaker;
  $("current-avatar").textContent = latest.speaker
    .split(" ")
    .map((x) => x[0])
    .slice(0, 2)
    .join("");
  $("caption-time").textContent = time(latest.start);
  $("original-label").textContent =
    `Original · ${latest.source || t?.detectedSource
      ? label(latest.source || t.detectedSource)
      : t?.status === "ready" || t?.status === "failed"
        ? "Language not reported"
        : "Detecting language"}`;
  $("translated-label").textContent = state.config.languages[state.language];
  $("caption-original").textContent = latest.text;
  $("caption-original").lang = latest.source || t?.detectedSource || "und";
  $("caption-translated").lang = state.language;
  $("caption-translated").textContent =
    t?.status === "ready"
      ? t.text
      : t?.status === "failed"
        ? "Translation failed. Retry failed work to translate this caption."
        : "Translating…";
  $("caption-translated").classList.toggle("pending", t?.status !== "ready");
  if (t?.status === "ready" && captionsVisible()) {
    const key = `${latest.id}:${state.language}`;
    if (state.lastAnnounced !== key) {
      $("announcer").lang = state.language;
      $("announcer").textContent = `${latest.speaker}: ${t.text}`;
      state.lastAnnounced = key;
    }
    if (
      !state.receipts.has(key) &&
      !t.passthrough &&
      t.readyAt >= state.connectedAt
    ) {
      const target = state.language;
      requestAnimationFrame(() => {
        if (
          !captionsVisible() ||
          state.snapshot?.meeting.id !== latest.meetingId ||
          state.language !== target ||
          state.receipts.has(key)
        )
          return;
        const delay = Date.now() + state.clockOffset - t.readyAt;
        if (delay >= 0 && delay < 60000) {
          state.receipts.add(key);
          post(`/api/meetings/${latest.meetingId}/receipts`, {
            cueId: latest.id,
            target,
            clientId: state.clientId,
            delayMs: delay,
          }).catch(() => {});
        }
      });
    }
  }
}
function syncReadingLanguages() {
  const targets = state.snapshot?.meeting.targets || [];
  for(const id of ["viewer-language", "transcript-language"]) {
    const select = $(id); select.disabled = !targets.length;
    if(targets.length && (select.options.length !== targets.length || targets.some((code,i)=>select.options[i]?.value !== code))) select.replaceChildren(...targets.map(code=>new Option(state.config.languages[code] || code, code)));
    if(targets.length) select.value = state.language;
  }
}
function renderTranscript() {
  syncReadingLanguages();
  const focusedReview = document.activeElement?.dataset.review;
  const focusedListen = document.activeElement?.dataset.listen;
  const query = $("transcript-search").value.toLocaleLowerCase();
  const all = state.snapshot?.cues || [];
  const cues = all.filter(
    (c) =>
      c.kind === state.kind &&
      `${c.speaker} ${c.text} ${c.translations[state.language]?.text || ""}`
        .toLocaleLowerCase()
        .includes(query),
  );
  $("turn-count").textContent =
    `${cues.length} ${cues.length === 1 ? "turn" : "turns"}`;
  $("transcript-target-label").textContent = label(state.language);
  $("transcript-description").textContent =
    state.kind === "final"
      ? `Post-call status: ${state.snapshot?.meeting.postCallStatus || "pending"}. Translations complete asynchronously.`
      : "Original words. Shared understanding.";
  $("transcript-rows").innerHTML = cues.length
    ? cues
        .map((c) => {
          const t = c.translations[state.language],
            review = state.snapshot.reviews.find(
              (r) => r.cueId === c.id && r.target === state.language,
            );
          return `<article class="transcript-row"><div class="turn-person"><div class="turn-speaker">${esc(c.speaker)}</div><div class="turn-time">${state.snapshot.meeting.mode === "live" && state.snapshot.meeting.endedAt && c.timing === "provider-relative" ? `<button class="seek-time" data-seek-cue="${c.id}" aria-label="Seek recording to ${time(c.start)}">${time(c.start)}</button>` : time(c.start)} – ${time(c.end)}${c.timing === "receipt-estimate" ? " · estimated" : ""}</div></div><p class="turn-text" lang="${esc(c.source || t?.detectedSource || "und")}" dir="auto">${esc(c.text)}</p><div><p class="turn-text turn-translation ${t?.status === "ready" ? "" : "pending"}" lang="${state.language}" dir="auto">${esc(t?.status === "ready" ? t.text : t?.status === "failed" ? "Translation failed" : "Translating…")}</p>${t?.status === "ready" ? `<button class="review-button" data-review="${c.id}" aria-label="Review translation by ${esc(c.speaker)} at ${time(c.start)}">${review ? `Reviewed ${review.score}/5 · edit` : "Review translation"}</button><button class="review-button listen-turn" data-listen="${c.id}" aria-pressed="false" aria-label="Listen to translation by ${esc(c.speaker)} at ${time(c.start)}">Listen</button>` : ""}</div></article>`;
        })
        .join("")
    : `<p class="empty-record">${query ? "No matching turns. Try another word." : state.kind === "final" ? "The post-call transcript appears after the meeting ends." : "Your speaker-attributed transcript will appear here."}</p>`;
  if(focusedListen)document.querySelector(`[data-listen="${CSS.escape(focusedListen)}"]`)?.focus({preventScroll:true});
  if (focusedReview)
    document
      .querySelector(`[data-review="${CSS.escape(focusedReview)}"]`)
      ?.focus({ preventScroll: true });
}
function changeReadingLanguage(e) {
  window.LingoSpeech.stop();
  state.language = e.target.value;
  localStorage.setItem("caption-language", state.language);
  if (!state.paused) renderCaption();
  renderTranscript();
  renderSummary();
}
$("viewer-language").addEventListener("change", changeReadingLanguage);
$("transcript-language").addEventListener("change", changeReadingLanguage);
$("caption-size").addEventListener("change", (e) => {
  document.documentElement.style.setProperty(
    "--caption-size",
    `${e.target.value}px`,
  );
  localStorage.setItem("caption-size", e.target.value);
});
$("high-contrast").addEventListener("click", () => {
  const enabled = document.body.classList.toggle("high-contrast");
  $("high-contrast").setAttribute("aria-pressed", String(enabled));
  localStorage.setItem("caption-contrast", String(enabled));
});
$("pause-view").addEventListener("click", () => {
  state.paused = !state.paused;
  $("pause-view").setAttribute("aria-pressed", String(state.paused));
  $("pause-view").textContent = state.paused
    ? "Resume display"
    : "Pause display";
  if (!state.paused) renderCaption();
});
$("fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $("caption-panel").requestFullscreen();
  } catch {
    toast("Full-screen captions are unavailable in this browser.");
  }
});
$("transcript-search").addEventListener("input", renderTranscript);
$("show-live").addEventListener("click", () => {
  state.kind = "live";
  saveRoute();
  if (state.snapshot) renderSnapshot();
});
$("show-final").addEventListener("click", () => {
  state.kind = "final";
  saveRoute();
  if (state.snapshot) renderSnapshot();
});
$("meeting-error").addEventListener("click", async (e) => {
  if (e.target.id !== "retry-work") return;
  e.target.disabled = true;
  try {
    await post(`/api/meetings/${state.snapshot.meeting.id}/retry`);
    toast("Failed work queued for retry.");
  } catch (e) {
    toast(e.message);
  }
});
$("stop-meeting").addEventListener("click", async () => {
  if (!state.snapshot) return;
  $("stop-meeting").disabled = true;
  try {
    await post(`/api/meetings/${state.snapshot.meeting.id}/stop`);
    toast("Meeting ending. The transcript will be retained.");
  } catch (e) {
    toast(e.message);
    $("stop-meeting").disabled = false;
  }
});
$("export-open").addEventListener("click", () => {
  $("export-language").innerHTML =
    '<option value="original">Original languages · always available</option>' +
    state.snapshot.meeting.targets
      .map(
        (c) =>
          `<option value="${c}">${esc(state.config.languages[c])}</option>`,
      )
      .join("");
  $("export-language").value = state.language;
  $("export-form").elements.kind.value = state.kind;
  $("share-slack").disabled = !state.config.integrations.slack;
  $("share-discord").disabled=!state.config.integrations.discord;
  $("share-drive").disabled = !state.config.integrations.drive;
  $("share-gmail").disabled = !state.config.integrations.gmail;
  $("share-native").hidden = !navigator.share;
  error("export-error", "");
  $("export-dialog").showModal();
});
function exportOptions() {
  const data = Object.fromEntries(new FormData($("export-form")));
  data.bilingual = $("export-form").elements.bilingual.checked;
  return data;
}
$("export-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  error("export-error", "");
  $("download-export").disabled = true;
  try {
    const options = exportOptions(),
      res = await fetch(
        `/api/meetings/${state.snapshot.meeting.id}/export?${new URLSearchParams(options)}`,
      );
    if (!res.ok) {
      const b = await res.json();
      throw new Error(b.error || "Download failed.");
    }
    const blob = await res.blob(),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = decodeURIComponent(res.headers.get("X-Export-Filename"));
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Transcript downloaded.");
  } catch (e) {
    error("export-error", e.message);
  } finally {
    $("download-export").disabled = false;
  }
});
async function share(destination) {
  error("export-error", "");
  const button = $("share-" + destination);
  button.disabled = true;
  try {
    const result = await post(`/api/meetings/${state.snapshot.meeting.id}/share`, {
      ...exportOptions(),
      destination,
    });
    toast(
      destination === "discord"?"Transcript shared to Discord.":destination === "slack"
        ? "Transcript shared to Slack."
        : destination === "gmail" ? "Gmail draft created. Review it in Gmail before sending." : "Transcript saved to Google Drive.",
    );
    if (destination === "gmail") { $("gmail-draft-link").hidden = false; $("gmail-draft-link").href = result.url; }
  } catch (e) {
    error("export-error", e.message);
  } finally {
    button.disabled = false;
  }
}
$("share-slack").addEventListener("click", () => share("slack"));
$("share-drive").addEventListener("click", () => share("drive"));
$("share-gmail").addEventListener("click", () => share("gmail"));
$("transcript-rows").addEventListener("click", async event => {
  const button = event.target.closest("[data-seek-cue]"); if(!button) return;
  const meetingId = state.snapshot?.meeting.id, cue = state.snapshot?.cues.find(c=>c.id === button.dataset.seekCue);
  if(!cue || !Number.isFinite(cue.start)) return;
  button.disabled = true;
  try {
    if(!state.recording) await refreshRecording();
    if(state.snapshot?.meeting.id !== meetingId) return;
    const player = !$("video-player").hidden ? $("video-player") : !$("audio-player").hidden ? $("audio-player") : null;
    if(!player) throw Error("The recording is not available yet. Use Refresh recording and try again.");
    if(player.readyState < 1) await new Promise((resolve,reject)=>{
      const done = error => { clearTimeout(timer); player.removeEventListener("loadedmetadata", ready); player.removeEventListener("error", failed); error ? reject(error) : resolve(); };
      const ready = () => done(), failed = () => done(Error("The recording could not be loaded. Refresh and try again."));
      const timer = setTimeout(()=>failed(), 10000);
      player.addEventListener("loadedmetadata", ready); player.addEventListener("error", failed);
      player.preload = "metadata"; player.load();
    });
    if(state.snapshot?.meeting.id !== meetingId || $("recording-panel").hidden || state.view !== "captions") return;
    if(!Number.isFinite(player.duration) || cue.start < 0 || cue.start >= player.duration) throw Error("This transcript time falls outside the available recording.");
    player.currentTime = cue.start;
    player.focus({preventScroll:true});
    toast(`Recording moved to ${time(cue.start)}. Press Play to listen; timing alignment can vary.`);
  } catch(e) { toast(e.message); } finally { button.disabled = false; }
});
$("transcript-rows").addEventListener("click", (event) => {
  const id = event.target.closest("[data-review]")?.dataset.review;
  if (!id) return;
  state.reviewCue = id;
  const c = state.snapshot.cues.find((c) => c.id === id),
    review = state.snapshot.reviews.find(
      (r) => r.cueId === id && r.target === state.language,
    );
  $("review-original").textContent = c.text;
  $("review-original").lang = c.source || "und";
  $("review-translation").textContent = c.translations[state.language].text;
  $("review-translation").lang = state.language;
  $("review-form").elements.score.value = review?.score || "5";
  $("review-form").elements.notes.value = review?.notes || "";
  error("review-error", "");
  $("review-dialog").showModal();
});
$("review-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  try {
    await post(`/api/meetings/${state.snapshot.meeting.id}/reviews`, {
      cueId: state.reviewCue,
      target: state.language,
      score: Number(f.get("score")),
      notes: f.get("notes"),
    });
    $("review-dialog").close();
    toast("Translation review saved.");
  } catch (e) {
    error("review-error", e.message);
  }
});
$("review-dialog").addEventListener("close", () => {
  document
    .querySelector(`[data-review="${CSS.escape(state.reviewCue)}"]`)
    ?.focus({ preventScroll: true });
});
$("download-measurements").addEventListener("click", async () => {
  try {
    const report = await api(
        `/api/meetings/${state.snapshot.meeting.id}/measurements`,
      ),
      url = URL.createObjectURL(
        new Blob([JSON.stringify(report, null, 2)], {
          type: "application/json",
        }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = report.filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    toast(e.message);
  }
});
function renderMetrics() {
  $("download-measurements").disabled = !state.snapshot;
  if (!state.snapshot) {
    $("metrics-body").innerHTML =
      '<p class="empty-record">Select a meeting to check its captions and translations.</p>';
    return;
  }
  const metrics = state.snapshot.metrics.filter((x) => x.samples || x.failures || x.reviewCount),
    m = state.snapshot.meeting;
  const ms = (value) => (value === null ? "Unmeasured" : `${value} ms`);
  const technicalOpen=$("metrics-body").querySelector(".technical-health")?.open || false;
  const healthKind=m.postCallStatus==='ready' && state.snapshot.cues.some(c=>c.kind==='final')?'final':'live';
  const healthCues=state.snapshot.cues.filter(c=>c.kind===healthKind);
  const ready=healthCues.filter(c=>Object.values(c.translations || {}).some(t=>t.status==='ready')).length;
  const failed=healthCues.filter(c=>Object.values(c.translations || {}).some(t=>t.status==='failed')).length;
  const health=`<h2 class="health-meeting-title">${esc(m.title)}</h2><div class="health-summary"><article><h2>Ready to read</h2><strong>${ready}</strong><p>Transcript turns with a ready translation.</p></article><article><h2>Needs attention</h2><strong>${failed}</strong><p>Turns where a language failed. Originals remain saved.</p></article><article><h2>Recording</h2><strong>${esc(m.endedAt?'Finished':m.status)}</strong><p>${esc(m.services?.speech || 'Speech provider')} speech · ${esc(m.services?.translation || 'Text translator')}</p></article></div><p>Typical translation time by language:</p><ul>${metrics.map(g=>`<li>${esc(g.pair.split(' → ').map(label).join(' → '))}: ${g.translationP50===null?'Not available':(g.translationP50/1000).toFixed(2)+' seconds'} · ${g.quality===null?'Not yet reviewed':g.quality+'/5 from your reviews'}</li>`).join('')}</ul>`;
  $("metrics-body").innerHTML = health+`<details class="technical-health" ${technicalOpen?'open':''}><summary>Technical details</summary>`+
    `<div class="metric-summary"><strong>${esc(m.title)} · ${m.mode === "demo" ? "Simulated sample" : "Real meeting"}</strong>${m.mode === "demo" ? "Sample translations are handwritten; zero provider duration is expected and is not a latency benchmark." : "These measurements exclude audio capture and speech recognition. Small sample sizes and network conditions affect percentile estimates."}</div>` +
    (metrics.length
      ? `<div class="table-wrap"><table class="metrics-table"><caption class="sr-only">Language pair measurements</caption><thead><tr><th scope="col">Language pair</th><th scope="col">Samples</th><th scope="col">Translation p50 / p95</th><th scope="col">Processing p50 / p95</th><th scope="col">Browser receipt p50</th><th scope="col">Quality / 5</th><th scope="col">Failed</th></tr></thead><tbody>${metrics.map((g) => `<tr><th scope="row">${esc(g.pair.split(" → ").map(label).join(" → "))}</th><td>${g.samples}</td><td>${ms(g.translationP50)} / ${ms(g.translationP95)}</td><td>${ms(g.pipelineP50)} / ${ms(g.pipelineP95)}</td><td>${ms(g.displayP50)} (${g.displaySamples} reports)</td><td>${g.quality === null ? "Not reviewed" : `${g.quality} (${g.reviewCount} reviews)`}</td><td>${g.failures}</td></tr>`).join("")}</tbody></table></div>`
      : '<p class="empty-record">Translation details appear as captions arrive.</p>')+'</details>';
}
const connectionDescriptions = {
  calendar:"Read meeting names from your Google Calendar. Matches invitation links near the call time. No calendar events are changed.",
  discord:"Share a transcript attachment to the webhook’s Discord channel when you choose. Connection tests send no messages.",
  meetstream:
    "Meeting bots, live captions, recordings and post-call transcripts.",
  google_tts: "Optional cloud read-aloud. Enable Google Cloud Text-to-Speech and billing. Uses the existing Google Translation key if no separate speech key is saved. Device voices are the fallback.",
  google: "Automatic text language detection and multilingual translations.",
  azure: "An alternative text translation provider.",
  deepl: "Optional text translation with a DeepL API Free or Pro key. This adapter exposes a conservative verified catalog; Hindi and Tamil targets remain available through Google, Azure and JigsawStack.",
  jigsawstack: "Text translation in 162 languages. This key is used by this server; speech recognition uses the integration in your MeetStream account.",
  gmail: "Create a draft with a transcript attachment. You choose recipients and send it in Gmail.",
  slack: "Share exported transcripts to a channel when you choose.",
  drive: "Save exported artifacts to your chosen Google Drive folder.",
};
async function refreshConfig() {
  state.config = await api("/api/config");
  renderConnections();
  updateProviderChoices();
}
function checkMessage(check) {
  return check
    ? `<p class="connection-result" role="status">${esc(check.message)} <span class="subtle">Checked ${esc(new Date(check.at).toLocaleString())}</span></p>`
    : "";
}
function renderConnections() {
  const c = state.config;
  $("meetstream-key-source").textContent = c.meetstreamCredential?.fingerprint
    ? `This project uses the MeetStream API key from ${c.meetstreamCredential.source}. Key fingerprint: ${c.meetstreamCredential.fingerprint} (a hash, not the secret).`
    : "Save a MeetStream API key above to connect this project.";
  $("connections").innerHTML =
    `<div class="connection-grid">${(c.connections || []).map((x) => `<article class="connection"><h2>${esc(x.name)}</h2><span class="status ${x.check?.status === "failed" ? "warning" : x.configured ? "" : "neutral"}">${x.check?.status === "passed" ? "Test passed" : x.check?.status === "failed" ? "Check failed" : x.configured ? "Saved · not tested" : "Not configured"}</span><p>${connectionDescriptions[x.id]}</p>${checkMessage(x.check)}<div class="connection-actions"><button class="secondary" data-configure="${x.id}" ${c.connectionsEditable ? "" : "disabled"}>Configure</button><button class="secondary" data-test-connection="${x.id}" ${x.configured && c.connectionsEditable ? "" : "disabled"}>Test connection</button></div></article>`).join("")}<article class="connection"><h2>Deepgram</h2><span class="status ${c.deepgram?.status === "failed" ? "warning" : "neutral"}">${c.deepgram?.status === "passed" ? (c.deepgram.kind === "live_transcription" ? "Live captions received" : "Saved-audio test passed") : c.deepgram?.status === "processing" ? "Test processing" : c.deepgram?.status === "failed" ? "Check failed" : "Managed by MeetStream"}</span><p>Uses the Deepgram integration already saved in your MeetStream workspace. No separate Deepgram key is needed here or in .env.</p>${checkMessage(c.deepgram)}<div class="connection-actions"><a class="secondary" href="https://app.meetstream.ai/integrations" target="_blank" rel="noreferrer">Manage in MeetStream ↗</a><button class="secondary" id="deepgram-test-open" ${c.connectionsEditable ? "" : "disabled"}>Test saved audio</button>${c.deepgram?.status === "processing" ? '<button class="secondary" id="deepgram-refresh">Refresh test</button>' : ""}</div></article></div>`;
  for (const [id, name, description] of [["assemblyai", "AssemblyAI", "English live captions and Universal-2 post-call transcription. Configure its speech key in the MeetStream account used by this project's API key."], ["jigsawstack_asr", "JigsawStack speech", "Multilingual live on Google Meet, and post-call on all supported platforms. Configure its speech key in your MeetStream account."]]) {
    const check = c.managedChecks?.[id];
    $("connections").querySelector(".connection-grid").insertAdjacentHTML("beforeend", `<article class="connection"><h2>${name}</h2><span class="status ${check?.status === "failed" ? "warning" : "neutral"}">${check?.status === "passed" ? (check.kind === "live_transcription" ? "Live captions received" : "Saved-audio test passed") : check?.status === "processing" ? "Test processing" : check?.status === "failed" ? "Check failed" : "Managed by MeetStream"}</span><p>${description}</p>${checkMessage(check)}<div class="connection-actions"><a class="secondary" href="https://app.meetstream.ai/integrations" target="_blank" rel="noreferrer">Configure ${name} in MeetStream ↗</a><button class="secondary" data-provider-test="${id}" ${c.connectionsEditable ? "" : "disabled"}>Test saved audio</button>${check?.status === "processing" ? `<button class="secondary" data-provider-refresh="${id}">Refresh test</button>` : ""}</div></article>`);
  }
  $("extension-pair").disabled = !c.connectionsEditable;
  $("extension-revoke").disabled = !c.connectionsEditable;
  const selected = $("extension-meeting").value || state.snapshot?.meeting.id;
  $("extension-meeting").replaceChildren(...state.meetings.map(m => new Option(m.title,m.id)));
  if (selected) $("extension-meeting").value = selected;
  $("connection-edit-notice").hidden = c.connectionsEditable;
  $("lifecycle-url").textContent =
    c.lifecycleUrl ||
    "Add NGROK_AUTHTOKEN to .env and restart npm start to get an HTTPS endpoint";
}
let notebookKey = "";
function renderNotebook() {
  const m = state.snapshot?.meeting;
  $("notebook-panel").hidden = !m;
  if (!m) return;
  const key = JSON.stringify([m.id, m.notes, m.actions, m.metadataVersion]);
  if (key === notebookKey) return;
  notebookKey = key;
  const focused = document.activeElement?.dataset.action;
  $("notebook-notes").textContent =
    m.notes ||
    "No notes yet. Add decisions, questions or context for this conversation.";
  $("download-notes").href = `/api/meetings/${m.id}/notes`;
  $("notebook-actions").innerHTML = m.actions?.length
    ? m.actions
        .map(
          (a) =>
            `<label class="notebook-action"><input type="checkbox" data-action="${esc(a.id)}" ${a.done ? "checked" : ""}><span><span class="${a.done ? "action-done" : ""}" dir="auto">${esc(a.text)}</span>${a.owner ? `<small>Owner: ${esc(a.owner)}</small>` : ""}</span></label>`,
        )
        .join("")
    : '<p class="subtle">No action items yet.</p>';
  if (focused)
    [...$("notebook-actions").querySelectorAll("input")]
      .find((x) => x.dataset.action === focused)
      ?.focus({ preventScroll: true });
}
function addActionEditor(
  a = { id: crypto.randomUUID(), text: "", owner: "", done: false },
) {
  $("details-actions").insertAdjacentHTML(
    "beforeend",
    `<div class="action-editor" data-action-id="${esc(a.id)}"><label>Action description<input data-action-text value="${esc(a.text)}" maxlength="500" required></label><label>Owner<input data-action-owner value="${esc(a.owner)}" maxlength="100" placeholder="Optional"></label><div class="action-editor-footer"><label class="checkbox-label"><input type="checkbox" data-action-done ${a.done ? "checked" : ""}>Completed</label><button class="secondary" type="button" data-remove-action>Remove action</button></div></div>`,
  );
}
function openDetails() {
  const m = state.snapshot?.meeting;
  if (!m) return;
  const form = $("details-form");
  form.dataset.meeting = m.id;
  form.dataset.version = m.metadataVersion || 0;
  $("details-meeting-title").value = m.title;
  $("details-notes").value = m.notes || "";
  $("details-actions").replaceChildren();
  for (const action of m.actions || []) addActionEditor(action);
  error("details-error", "");
  $("details-dialog").showModal();
}
$("edit-meeting").addEventListener("click", openDetails);
$("edit-notes").addEventListener("click", openDetails);
$("add-action").addEventListener("click", () => {
  if ($("details-actions").children.length >= 50)
    return error("details-error", "A meeting supports up to 50 action items.");
  addActionEditor();
  $("details-actions").lastElementChild.querySelector("input").focus();
});
$("details-actions").addEventListener("click", (event) => {
  if (event.target.closest("[data-remove-action]"))
    event.target.closest(".action-editor").remove();
});
async function saveDetails(id, body) {
  const snapshot = await api(`/api/meetings/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (state.snapshot?.meeting.id === id) {
    state.snapshot = snapshot;
    renderSnapshot();
  }
  await refreshMeetings();
}
$("details-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $("details-save").disabled = true;
  error("details-error", "");
  const actions = [...$("details-actions").children].map((row) => ({
    id: row.dataset.actionId,
    text: row.querySelector("[data-action-text]").value,
    owner: row.querySelector("[data-action-owner]").value,
    done: row.querySelector("[data-action-done]").checked,
  }));
  try {
    await saveDetails(form.dataset.meeting, {
      title: $("details-meeting-title").value,
      notes: $("details-notes").value,
      actions,
      version: Number(form.dataset.version),
    });
    $("details-dialog").close();
    toast("Meeting details saved.");
  } catch (e) {
    error("details-error", e.message);
  } finally {
    $("details-save").disabled = false;
  }
});
$("notebook-actions").addEventListener("change", async (event) => {
  if (!event.target.matches("[data-action]")) return;
  const m = state.snapshot.meeting,
    checkbox = event.target;
  checkbox.disabled = true;
  try {
    await saveDetails(m.id, {
      title: m.title,
      notes: m.notes || "",
      actions: m.actions.map((a) =>
        a.id === checkbox.dataset.action ? { ...a, done: checkbox.checked } : a,
      ),
      version: m.metadataVersion || 0,
    });
  } catch (e) {
    checkbox.checked = !checkbox.checked;
    toast(e.message);
  } finally {
    checkbox.disabled = false;
  }
});
$("connections").addEventListener("click", async (event) => {
  const configure = event.target.closest("[data-configure]");
  if (configure) {
    const c = state.config.connections.find(
      (x) => x.id === configure.dataset.configure,
    );
    $("connection-form").dataset.connection = c.id;
    $("connection-title").textContent = `Configure ${c.name}`;
    $("connection-fields").innerHTML = c.fields
      .map(
        (f) =>
          `<label>${esc(f.label)}<input name="${f.key}" type="${f.secret ? "password" : "text"}" autocomplete="off" spellcheck="false" maxlength="8192" value="${esc(f.value || "")}" placeholder="${f.secret && f.configured ? "Saved · leave blank to keep" : ""}"><small class="field-help">${f.configured ? "A value is already saved." : "Required for this connection."}</small></label>`,
      )
      .join("");
    $("disconnect-connection").disabled = !c.fields.some((f) => f.configured);
    error("connection-error", "");
    $("connection-dialog").showModal();
    return;
  }
  const test = event.target.closest("[data-test-connection]");
  if (test) {
    test.disabled = true;
    test.textContent = "Testing…";
    try {
      await post(`/api/connections/${test.dataset.testConnection}/test`, {});
      toast("Connection test passed.");
    } catch (e) {
      toast(e.message);
    } finally {
      await refreshConfig().catch((e) => toast(e.message));
    }
  }
  const providerTest = event.target.closest("[data-provider-test]");
  if (event.target.closest("#deepgram-test-open") || providerTest) {
    const provider = providerTest?.dataset.providerTest || "deepgram";
    $("deepgram-form").dataset.provider = provider;
    $("deepgram-title").textContent = `Test ${provider === "jigsawstack_asr" ? "JigsawStack" : provider === "assemblyai" ? "AssemblyAI" : "Deepgram"} with saved audio`;
    const languages = state.config.speechLanguages[provider];
    $("deepgram-form").elements.source.replaceChildren(...Object.entries(languages).map(([code,name]) => new Option(name,code)));
    $("provider-test-help").textContent = "Starts a billable post-call transcription of existing audio. This checks provider access; the meeting's saved transcript is preserved. Use audio in the selected language, within provider retention.";
    try {
      const meetings = await api("/api/meetings");
      const usable = meetings.filter(
        (m) => m.mode === "live" && m.botId && m.endedAt,
      );
      $("deepgram-meeting").innerHTML = usable
        .map((m) => `<option value="${m.id}">${esc(m.title)}</option>`)
        .join("");
      $("deepgram-submit").disabled = !usable.length;
      error(
        "deepgram-error",
        usable.length
          ? ""
          : "Complete a real recorded meeting first. Samples have no audio.",
      );
      $("deepgram-dialog").showModal();
    } catch (e) {
      toast(e.message);
    }
  }
  const providerRefresh = event.target.closest("[data-provider-refresh]");
  if (event.target.closest("#deepgram-refresh") || providerRefresh) {
    const provider = providerRefresh?.dataset.providerRefresh || "deepgram";
    event.target.disabled = true;
    try {
      const result = await post(`/api/connections/${provider}/refresh`, {});
      toast(result.message);
    } catch (e) {
      toast(e.message);
    } finally {
      await refreshConfig().catch((e) => toast(e.message));
    }
  }
});
$("connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = $("connection-save");
  button.disabled = true;
  error("connection-error", "");
  try {
    await post(`/api/connections/${form.dataset.connection}`, {
      values: Object.fromEntries(new FormData(form)),
    });
    form.reset();
    $("connection-dialog").close();
    await refreshConfig();
    toast("Connection saved. Changes are active now.");
  } catch (e) {
    error("connection-error", e.message);
  } finally {
    button.disabled = false;
  }
});
$("connection-dialog").addEventListener("close", () => {
  $("connection-form").reset();
  $("connection-fields").replaceChildren();
});
$("disconnect-connection").addEventListener("click", async (event) => {
  event.target.disabled = true;
  try {
    await post(`/api/connections/${$("connection-form").dataset.connection}`, {
      disconnect: true,
    });
    $("connection-dialog").close();
    await refreshConfig();
    toast("Connection disconnected for this application.");
  } catch (e) {
    error("connection-error", e.message);
    event.target.disabled = false;
  }
});
$("deepgram-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("deepgram-submit").disabled = true;
  error("deepgram-error", "");
  try {
    await post(
      `/api/connections/${event.currentTarget.dataset.provider || "deepgram"}/test`,
      Object.fromEntries(new FormData(event.currentTarget)),
    );
    $("deepgram-dialog").close();
    await refreshConfig();
    toast("Provider test accepted. Use Refresh test to check processing.");
  } catch (e) {
    error("deepgram-error", e.message);
    await refreshConfig();
  } finally {
    $("deepgram-submit").disabled = false;
  }
});
$("login-dialog").addEventListener("cancel", (e) => e.preventDefault());
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  error("login-error", "");
  try {
    await post("/api/login", {
      password: new FormData(e.currentTarget).get("password"),
    });
    $("login-dialog").close();
    $("login-form").reset();
    await initialize();
  } catch (e) {
    error("login-error", e.message);
  }
});
$("logout").addEventListener("click", async () => {
  try {
    await post("/api/logout");
    state.stream?.close();
    location.reload();
  } catch (e) {
    toast(e.message);
  }
});
async function initialize() {
  const auth = await api("/api/auth");
  $("logout").hidden = !auth.passwordRequired || !auth.authenticated;
  if (!auth.authenticated) {
    $("login-dialog").showModal();
    return;
  }
  const began = Date.now();
  state.config = await api("/api/config");
  state.clockOffset = state.config.serverTime - (began + Date.now()) / 2;
  if (!$("target-options").querySelector("input")) setupConfig();
  else renderConnections();
  $("profile-open").disabled = false;
  await refreshMeetings();
  await restoreRoute();
  saveRoute("replace");
}
function clearMeeting() {
  state.stream?.close();
  clearTimeout(state.recordingTimer);
  state.snapshot = null;
  state.recording = null;
  $("session-title").textContent = "No meeting selected";$("meeting-services").hidden=true;$("spoken-language-info").disabled=true;
  $("session-status").textContent = "Ready";
  $("session-detail").textContent = "Start a sample or connect a real meeting";
  $("caption-empty").hidden = false;
  $("caption-waiting").hidden = true;
  $("caption-content").hidden = true;
  $("sample-notice").hidden = true;
  $("meeting-error").hidden = true;
  for (const button of [
    "export-open",
    "stop-meeting",
    "save-archive",
    "copy-meeting-link",
    "edit-meeting",
  ])
    $(button).disabled = true;
  $("join-call").hidden = true;
  $("recording-panel").hidden = true;
  $("notebook-panel").hidden = true;
  state.panel = "overview";
  renderMeetingPanels();
  $("saved-status").textContent = "Original captions are saved as they arrive";
  renderTranscript();
  renderMeetings();
}
async function restoreRoute() {
  const epoch = ++restorationEpoch;
  clearTimeout(scrollTimer);
  restoringRoute = true;
  const requestedUrl = location.href,
    restoreY = history.state?.scrollY || 0;
  try {
    const params = new URL(location.href).searchParams;
    const path=location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const pathMeeting=path[0]==='workspace' && path[1]==='meetings' && path[2];
    const pathView=pathMeeting?'captions':({meetings:'sessions',connections:'settings',health:'measurements',captions:'captions'})[path[1]];
    state.page = Math.max(1, Number.parseInt(params.get("page"), 10) || 1);
    state.query = (params.get("q") || "").slice(0, 100);
    state.filter = ["all", "active", "finished", "attention"].includes(
      params.get("status"),
    )
      ? params.get("status")
      : "all";
    $("meeting-filter").value = state.filter;
    state.panel = Object.hasOwn(panels, pathMeeting && path[3] || params.get("panel"))
      ? (pathMeeting && path[3] || params.get("panel"))
      : "overview";
    $("meeting-search").value = state.query;
    state.kind = params.get("kind") === "final" ? "final" : "live";
    const destination = pathView || params.get("view") || "captions",
      id = pathMeeting || params.get("meeting");
    if (id && state.snapshot?.meeting.id !== id) {
      try {
        await selectMeeting(id, {
          mode: "none",
          kind: state.kind,
          destination,
          panel: state.panel,
        });
      } catch (e) {
        if (location.href !== requestedUrl) return;
        toast(e.message);
        clearMeeting();
        view("sessions", "replace");
      }
    } else {
      if (!id && state.snapshot) {
        clearMeeting();
      }
      view(destination, "none");
      if (state.snapshot) renderSnapshot();
    }
    if (location.href === requestedUrl) window.scrollTo(0, restoreY);
  } finally {
    if (epoch === restorationEpoch) restoringRoute = false;
  }
}
window.addEventListener("popstate", () => {
  if (state.config) void restoreRoute();
});
$("meeting-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  state.query = $("meeting-search").value.trim();
  state.filter = $("meeting-filter").value;
  state.page = 1;
  view("sessions");
});
$("meeting-filter").addEventListener("change", () =>
  $("meeting-search-form").requestSubmit(),
);
for (const [id, step] of [
  ["meeting-prev", -1],
  ["meeting-next", 1],
])
  $(id).addEventListener("click", () => {
    state.page += step;
    view("sessions");
  });
async function copy(text) {
  if (!navigator.clipboard?.writeText)
    throw new Error(
      "Clipboard access is unavailable. Download a text transcript instead.",
    );
  await navigator.clipboard.writeText(text);
}
$("copy-meeting-link").addEventListener("click", async () => {
  try {
    await copy(routeHref({ destination: "captions" }));
    toast("Workspace link copied. Recipients need the workspace password.");
  } catch (e) {
    toast(e.message);
  }
});
$("save-archive").addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = `/api/meetings/${state.snapshot.meeting.id}/archive`;
  link.download = "";
  link.click();
});
$("copy-transcript").addEventListener("click", async () => {
  error("export-error", "");
  try {
    const options = { ...exportOptions(), format: "txt" };
    const res = await fetch(
      `/api/meetings/${state.snapshot.meeting.id}/export?${new URLSearchParams(options)}`,
    );
    if (!res.ok) throw new Error((await res.json()).error);
    await copy(await res.text());
    toast("Transcript copied with speakers and timestamps.");
  } catch (e) {
    error("export-error", e.message);
  }
});
$("print-transcript").addEventListener("click", async () => {
  const options = { ...exportOptions(), format: "html", inline: "true" };
  // Open synchronously from the click, before the async request, to avoid popup blockers.
  const preview = window.open("about:blank", "_blank");
  if (preview) preview.opener = null;
  try {
    const url = `/api/meetings/${state.snapshot.meeting.id}/export?${new URLSearchParams(options)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.json()).error);
    if (!preview) throw new Error("Allow popups to open the print preview.");
    preview.location.replace(url);
    toast("Use Print in the preview to save as PDF.");
  } catch (e) {
    preview?.close();
    error("export-error", e.message);
  }
});
function renderRecording() {
  const m = state.snapshot?.meeting;
  $("recording-panel").hidden =
    !m || m.mode !== "live" || !(["overview", "recording"].includes(state.panel) || (m.endedAt && state.panel === "transcript"));
  if (!m || m.mode !== "live") return;
  $("recording-artwork").hidden = state.recording?.video?.status === "ready";
  const provider = ({ deepgram_streaming:"Deepgram", assemblyai_streaming:"AssemblyAI", jigsawstack_streaming:"JigsawStack", meetstream_streaming:"MeetStream" })[m.liveProvider] || "MeetStream";
  $("recording-meta").innerHTML = `<div><dt>Created</dt><dd>${esc(new Date(m.createdAt).toLocaleString())}</dd></div><div><dt>Live speech provider</dt><dd>${provider}</dd></div><div><dt>Post-call provider</dt><dd>${esc(m.services?.postCall || "Unknown")}</dd></div><div><dt>Spoken language</dt><dd>${m.source === "auto" ? "Automatic detection" : esc(label(m.source))}</dd></div><div><dt>Translations</dt><dd>${m.targets.map(label).map(esc).join(", ")}</dd></div>`;
  const audio = state.recording?.audio;
  $("recording-status").textContent =
    audio?.message ||
    (audio?.status === "ready"
      ? "Audio ready · download to keep a copy before provider retention expires."
      : m.endedAt
        ? "Checking post-call recording…"
        : "Recording starts when the bot is admitted. Playback is available after the call.");
  for (const [kind, element] of [
    ["audio", "audio-player"],
    ["video", "video-player"],
  ]) {
    const ready = state.recording?.[kind]?.status === "ready";
    $(element).hidden = !ready || (kind === "audio" && state.recording?.video?.status === "ready");
    if($(element).hidden && !$(element).paused) $(element).pause();
    $("download-" + kind).hidden = !ready;
    if (ready) {
      const path = `/api/meetings/${m.id}/recording/${kind}`;
      if ($(element).getAttribute("src") !== path) $(element).src = path;
      $("download-" + kind).href = path + "?download=true";
    } else {
      $(element).removeAttribute("src");
    }
  }
  const captionKind = m.postCallStatus === "ready" ? "final" : "live";
  const hasCaptions = state.snapshot.cues.some((c) => c.kind === captionKind);
  const captionPath = hasCaptions
    ? `/api/meetings/${m.id}/export?format=vtt&target=original&kind=${captionKind}`
    : null;
  if (captionPath && $("video-captions").getAttribute("src") !== captionPath)
    $("video-captions").src = captionPath;
  if (!captionPath) $("video-captions").removeAttribute("src");
  $("retranscribe").hidden =
    !m.endedAt || m.postCallStatus === "ready" || audio?.status !== "ready";
}
async function refreshRecording() {
  clearTimeout(state.recordingTimer);
  state.recordingTimer = null;
  const m = state.snapshot?.meeting;
  if (!m || m.mode !== "live") return;
  try {
    const result = await api(`/api/meetings/${m.id}/recording`);
    if (state.snapshot?.meeting.id !== m.id) return;
    state.recording = result;
    renderRecording();
    if (
      [result.audio.status, result.video.status].some((s) =>
        ["processing", "recording"].includes(s),
      )
    )
      state.recordingTimer = setTimeout(refreshRecording, 15000);
  } catch (e) {
    if (state.snapshot?.meeting.id === m.id)
      $("recording-status").textContent =
        e.message + " Use Refresh recording to try again.";
  }
}
$("refresh-recording").addEventListener("click", refreshRecording);
$("retranscribe").addEventListener("click", () => {
  $("recovery-source").replaceChildren(new Option("Detect automatically","auto"),...Object.entries(state.config.languages).map(([code,name])=>new Option(name,code)));
  $("recovery-source").value=state.snapshot.meeting.source || "auto";
  error("recovery-error", ""); $("recovery-dialog").showModal();
});
$("recovery-form").addEventListener("submit",async(event)=>{
  event.preventDefault();$("recover-save").disabled=true;error("recovery-error", "");
  try {await post(`/api/meetings/${state.snapshot.meeting.id}/retranscribe`,{provider:$("recovery-provider").value,source:$("recovery-source").value});$("recovery-dialog").close();toast("Recovery queued. Your original recording and error history are preserved.");}
  catch(e){error("recovery-error",e.message);}finally{$("recover-save").disabled=false;}
});
for (const id of ["audio-player", "video-player"])
  $(id).addEventListener("error", () => {
    $("recording-status").textContent =
      "Playback failed. Refresh the recording or download a copy.";
  });
function renderProfile() {
  const name = localStorage.getItem("viewer-name") || "Meeting participant";
  $("profile-initials").textContent = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] || "")
    .join("")
    .toLocaleUpperCase();
}
$("profile-open").addEventListener("click", () => {
  $("profile-name").value = localStorage.getItem("viewer-name") || "";
  $("profile-language").value =
    localStorage.getItem("caption-language") || state.language;
  $("profile-size").value = $("caption-size").value;
  $("profile-contrast").checked =
    document.body.classList.contains("high-contrast");
  $("profile-dialog").showModal();
});
$("profile-form").addEventListener("submit", (event) => {
  event.preventDefault();
  localStorage.setItem("viewer-name", $("profile-name").value.trim());
  const language = $("profile-language").value;
  localStorage.setItem("caption-language", language);
  if (!state.snapshot || state.snapshot.meeting.targets.includes(language)) {
    state.language = language;
    $("viewer-language").value = language;
    if (state.snapshot) {
      renderCaption();
      renderTranscript();
    }
  }
  $("caption-size").value = $("profile-size").value;
  $("caption-size").dispatchEvent(new Event("change"));
  if (
    $("profile-contrast").checked !==
    document.body.classList.contains("high-contrast")
  )
    $("high-contrast").click();
  renderProfile();
  $("profile-dialog").close();
  toast("Reading preferences saved in this browser.");
});
renderProfile();
const size = localStorage.getItem("caption-size");
if (["24", "30", "38"].includes(size)) {
  $("caption-size").value = size;
  document.documentElement.style.setProperty("--caption-size", `${size}px`);
}
if (localStorage.getItem("caption-contrast") === "true") {
  document.body.classList.add("high-contrast");
  $("high-contrast").setAttribute("aria-pressed", "true");
}
initialize().catch((e) => toast(e.message));

$("target-search").addEventListener("input", event => {
  const query = event.target.value.toLocaleLowerCase();
  for (const input of $("target-options").querySelectorAll("input")) input.closest("label").hidden = input.disabled || (!input.checked && !(`${input.value} ${input.closest("label").textContent}`.toLocaleLowerCase().includes(query)));
});
$("extension-pair").addEventListener("click", async () => {
  try { const r = await post("/api/extension/pairing", { meetingId: $("extension-meeting").value }); $("extension-code").value = r.code; $("extension-code-area").hidden = false; $("extension-status").textContent = `Connect ${r.meetingTitle} in the extension. Use workspace URL ${location.origin}.`; setTimeout(() => { $("extension-code-area").hidden = true; $("extension-code").value = ""; }, 300000); } catch(e) { toast(e.message); }
});
$("extension-revoke").addEventListener("click", async () => { try { await post("/api/extension/revoke"); $("extension-code-area").hidden = true; $("extension-code").value = ""; $("extension-status").textContent = "All extension connections revoked. Generate a new code to reconnect."; } catch(e) { toast(e.message); } });
$("extension-copy").addEventListener("click", async () => { try { await copy($("extension-code").value); toast("One-time pairing code copied."); } catch(e) { toast(e.message); } });
$("add-language-open").addEventListener("click", () => {
  const m = state.snapshot.meeting;
  $("add-language").replaceChildren(...Object.entries(state.config.translationLanguages[m.translationProvider]).filter(([c]) => !m.targets.includes(c)).map(([c,n]) => new Option(n,c)));
  error("add-language-error", ""); $("add-language-dialog").showModal();
});
$("add-language-form").addEventListener("submit", async event => {
  event.preventDefault(); $("add-language-save").disabled = true;
  try { state.snapshot = await post(`/api/meetings/${state.snapshot.meeting.id}/language`, { target: $("add-language").value }); renderSnapshot(); $("add-language-dialog").close(); toast("Language added. Translation is queued."); } catch(e) { error("add-language-error", e.message); } finally { $("add-language-save").disabled = false; }
});
$("share-native").addEventListener("click", async () => {
  try { const options = exportOptions(); const res = await fetch(`/api/meetings/${state.snapshot.meeting.id}/export?${new URLSearchParams(options)}`); if (!res.ok) throw Error((await res.json()).error); const file = new File([await res.blob()], decodeURIComponent(res.headers.get("X-Export-Filename")), { type: res.headers.get("Content-Type").split(";")[0] }); if (!navigator.canShare?.({ files: [file] })) throw Error("This browser cannot share this file type. Download it and attach it in your communication app."); await navigator.share({ files: [file], title: state.snapshot.meeting.title }); } catch(e) { if(e.name !== "AbortError") error("export-error",e.message); }
});

function renderSummary() {
  const m=state.snapshot?.meeting;if(!m)return;
  const select=$("summary-language"), value=select.value || state.language;
  if([...select.options].map(o=>o.value).join() !== m.targets.join()) select.replaceChildren(...m.targets.map(c=>new Option(label(c),c)));
  select.value=m.targets.includes(value)?value:state.language;
  const result=m.summaries?.[select.value];
  $("summary-heading").textContent=m.endedAt?"Post-call summary":"Meeting summary";
  $("summary-points").innerHTML=result ? result.points.map(p=>`<li><p lang="${esc(result.target)}" dir="auto">${esc(p.text)}</p>${p.speaker ? `<small>${esc(p.speaker)} · ${time(p.start)}</small>` : ""}</li>`).join("") : "";
  $("summary-status").textContent=result ? `${result.kind === "ai" ? "AI-generated · review for accuracy" : "Selected transcript excerpts"} · ${result.turnCount} ${result.sourceKind === "final" ? "post-call" : "live"} turns · ${new Date(result.generatedAt).toLocaleString()}` : m.endedAt ? m.postCallStatus==='ready' ? 'Waiting for this language’s post-call translations. The overview appears automatically when they are ready. Retry failed translations in Meeting health.' : ['failed','unavailable'].includes(m.postCallStatus) ? 'The post-call transcript is unavailable. Recover the recording, or generate an overview from saved live captions.' : 'Preparing the post-call transcript. Your overview will appear here automatically.' : 'A post-call overview appears here automatically after the meeting. You can also generate an overview from the live captions.';
  $("generate-summary").disabled=!state.snapshot.cues.length || state.summaryBusy.has(m.id);
  $("listen-summary").disabled=$("copy-summary").disabled=!result;
  $("download-summary").hidden=!result;
  $("download-summary").href=`/api/meetings/${m.id}/summary.txt?target=${encodeURIComponent(select.value)}`;
}
$("summary-language").addEventListener("change",()=>{LingoSpeech.stop();renderSummary();error("summary-error", "");});
$("generate-summary").addEventListener("click",async()=>{
  const meetingId=state.snapshot.meeting.id;state.summaryBusy.add(meetingId);$("generate-summary").disabled=true;error("summary-error", "");$("summary-status").textContent="Generating summary…";
  try {const result=await post(`/api/meetings/${meetingId}/summary`,{target:$("summary-language").value,kind:$("summary-type").value});if(state.snapshot.meeting.id===meetingId){state.snapshot.meeting.summaries={...state.snapshot.meeting.summaries,[result.target]:result};renderSummary();}}
  catch(e){if(state.snapshot?.meeting.id===meetingId){renderSummary();error("summary-error",e.message);}}finally{state.summaryBusy.delete(meetingId);if(state.snapshot?.meeting.id===meetingId)$("generate-summary").disabled=!state.snapshot.cues.length;}
});
$("copy-summary").addEventListener("click",async()=>{try{await copy(state.snapshot.meeting.summaries[$("summary-language").value].points.map(p=>p.text).join("\n\n"));toast("Summary copied.");}catch(e){toast(e.message);}});
$("listen-summary").addEventListener("click",async e=>{try{const s=state.snapshot.meeting.summaries[$("summary-language").value];await listenTranslation({summary:true},s.points.map(p=>p.text).join(". "),s.target,e.currentTarget);}catch(e){toast(e.message);}});
$("transcript-rows").addEventListener("click",async e=>{const button=e.target.closest("[data-listen]");if(!button)return;const c=state.snapshot.cues.find(c=>c.id===button.dataset.listen);try{await listenTranslation({cueId:c.id},c.translations[state.language].text,state.language,button);}catch(e){toast(e.message);}});
document.addEventListener("speech-error",e=>toast(e.detail));

let cloudAudio=null,cloudButton=null,cloudUrl=null,audioEpoch=0;
function stopTranslatedAudio(){audioEpoch++;cloudAudio?.pause();if(cloudUrl)URL.revokeObjectURL(cloudUrl);cloudUrl=null;cloudAudio=null;cloudButton?.setAttribute('aria-pressed','false');cloudButton=null;LingoSpeech.stop();}
async function listenTranslation(input,text,target,button){
  if(cloudButton===button || button.getAttribute('aria-pressed')==='true'){stopTranslatedAudio();return;}
  stopTranslatedAudio();const epoch=audioEpoch,meetingId=state.snapshot.meeting.id;button.disabled=true;
  try {
    const data=await post(`/api/meetings/${meetingId}/speech`,{...input,target});
    if(epoch!==audioEpoch || state.snapshot?.meeting.id!==meetingId)return;
    const bytes=Uint8Array.from(atob(data.audioContent),c=>c.charCodeAt(0));cloudUrl=URL.createObjectURL(new Blob([bytes],{type:data.type}));
    cloudAudio=new Audio(cloudUrl);cloudButton=button;button.setAttribute('aria-pressed','true');cloudAudio.onended=stopTranslatedAudio;cloudAudio.onerror=()=>{stopTranslatedAudio();toast('Translated audio playback failed. Try again.');};await cloudAudio.play();
  }catch(cloudError){
    if(epoch!==audioEpoch)return;
    cloudAudio?.pause();if(cloudUrl)URL.revokeObjectURL(cloudUrl);cloudAudio=null;cloudUrl=null;cloudButton=null;button.setAttribute('aria-pressed','false');
    try {await LingoSpeech.speak(text,target,button);toast('Using a device voice. Cloud speech is unavailable.');}
    catch(deviceError){toast(`${cloudError.message} ${deviceError.message}`);}
  }finally{button.disabled=false;}
}
window.addEventListener('pagehide',stopTranslatedAudio);
document.addEventListener('click',e=>{if(e.target.closest('[data-panel],[data-view],[data-library],[data-meeting]'))stopTranslatedAudio();});
for(const id of ['viewer-language','transcript-language','meeting-picker','summary-language'])$(id).addEventListener('change',stopTranslatedAudio);

$('share-discord').addEventListener('click',()=>share('discord'));
function spokenChoices(m) {
  const provider=m.liveProvider.replace('_streaming','');
  let values=provider==='meetstream'?{auto:'Detect automatically',...state.config.languages}:provider==='jigsawstack'?{auto:'Detect automatically',...state.config.speechLanguages[provider]}:state.config.speechLanguages[provider];
  if(m.postCallProvider!=='meetstream' && m.postCallProvider!=='jigsawstack') values=Object.fromEntries(Object.entries(values).filter(([c])=>Object.hasOwn(state.config.speechLanguages[m.postCallProvider],c)));
  return values;
}
$('spoken-language-info').addEventListener('click',()=>{
  const m=state.snapshot?.meeting;if(!m)return;
  $('spoken-current').textContent=`Currently: ${m.services.source} · ${m.services.speech}`;
  $('spoken-help').textContent=m.languageSwitch?`Language switch: ${m.languageSwitch.cancelled?'cancelled':m.languageSwitch.status}. ${m.lastError || ''}`:m.services.sourceHelp;
  $('spoken-source').replaceChildren(...Object.entries(spokenChoices(m)).filter(([c])=>c!==m.source).map(([c,n])=>new Option(n,c)));
  $('spoken-source').disabled=$('spoken-save').disabled=!m.services.canRestartSource || !$('spoken-source').options.length;
  if(!$('spoken-source').options.length)$('spoken-help').textContent='This provider combination supports no other spoken language. Start a new recording with a different speech provider.';
  error('spoken-error','');$('spoken-form').dataset.meetingId=m.id;$('spoken-dialog').showModal();
});
$('spoken-form').addEventListener('submit',async event=>{
  event.preventDefault();const id=$('spoken-form').dataset.meetingId;$('spoken-save').disabled=true;error('spoken-error','');
  try {await post(`/api/meetings/${id}/source`,{source:$('spoken-source').value,confirmed:true});$('spoken-dialog').close();toast('Changing spoken language. Captions resume after the bot rejoins.');if(state.snapshot?.meeting.id===id)await selectMeeting(id,{mode:'replace'});}
  catch(e){error('spoken-error',e.message);}finally{$('spoken-save').disabled=false;}
});

$('refresh-meeting-name').addEventListener('click',async()=>{const button=$('refresh-meeting-name');button.disabled=true;try{const result=await post(`/api/meetings/${state.snapshot.meeting.id}/name/refresh`);state.snapshot.meeting=result.meeting;renderSnapshot();toast(result.matched?'Meeting name updated from Calendar.':'No matching scheduled meeting found. You can edit the name.');}catch(e){toast(e.message);}finally{button.disabled=false;}});
