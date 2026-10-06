"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const RECOMMENDED_MODELS = [
  { name: "qwen3-vl:8b-instruct", note: "recommended, sees thumbnails, ~6 GB, best on 16 GB Macs" },
  { name: "gemma3:4b", note: "smaller and faster, sees thumbnails, ~3.3 GB, fine on 8 GB Macs" },
];
const NUMBER_FIELDS = ["target_count", "pool_size", "agents", "time_limit_min", "min_duration", "max_duration",
  "min_views", "min_likes", "max_age_days", "min_score", "closeness"];
const STATUS_TEXT = {
  queued: "Waiting to be checked", checking: "AI is checking", scored: "Checked",
  picked: "Picked — saving soon", downloading: "Saving", watching: "Checking the frames", downloaded: "✓ Saved",
  skipped: "Skipped (your filters)", notpicked: "Checked — not in the top picks",
  failed: "Couldn't save — next best used instead", unchecked: "Not checked (stopped)",
};
const DONE_NOT_SAVED = ["skipped", "failed", "unchecked", "notpicked"];
const AGENT_STATE = {
  opening: "Opening search", scrolling: "Scrolling",
  captcha: "Needs you: captcha", login: "Needs you: log in", error: "Error", done: "Finished",
  limited: "Not logged in — first results only",
};
const PHASE_TEXT = {
  starting: "Starting the agents…", searching: "Looking at videos", checking: "Scoring the last videos",
  downloading: "Saving the best ones", done: "Done",
};

const form = $("#options");
let settings = null;
let status = null;
let running = false;
let testing = false;
let huntUsesReference = false;  // the current hunt scores videos by how they look like a reference
const cards = new Map();
const agents = new Map();
const references = new Map();
const MAX_REFERENCES = 5;

// ------------------------------------------------------------------ helpers

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-Reel-Finder": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail;
    const msg = typeof detail === "string" ? detail
      : Array.isArray(detail) ? detail.map((d) => `${d.loc?.slice(-1)[0]}: ${d.msg}`).join(", ")
      : data.error || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

let toastTimer;
function toast(text, ms = 4500) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function fmt(n) {
  if (n === null || n === undefined) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

const PLATFORM_NAMES = { tiktok: "TikTok", instagram: "Instagram", pinterest: "Pinterest" };
const PLATFORM_BADGE = { tiktok: "TikTok", instagram: "IG", pinterest: "Pinterest" };

function autoPool(target) {
  return Math.min(Math.max(target * 4, target + 20, 40), 600);
}

// ------------------------------------------------------------------ settings form

function fillForm(s) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el.name === "platforms") el.checked = s.platforms.includes(el.value);
    else if (el.type === "checkbox") el.checked = !!s[el.name];
    else if (el.name === "model") continue;
    else el.value = s[el.name] === 0 && el.placeholder ? "" : s[el.name];
  }
  updateOutputs();
}

function readForm() {
  const s = { ...settings };
  s.platforms = $$("input[name=platforms]:checked").map((el) => el.value);
  for (const el of form.elements) {
    if (!el.name || el.name === "platforms") continue;
    if (el.type === "checkbox") s[el.name] = el.checked;
    else if (el.name === "model") s.model = el.value || settings.model;
    else if (NUMBER_FIELDS.includes(el.name)) s[el.name] = el.value === "" ? 0 : Math.max(0, Math.round(+el.value));
    else s[el.name] = el.value;
  }
  return s;
}

// Mirrors reelfinder/similarity.py: closeness_label() and min_look().
function closenessLabel(v) {
  return v < 35 ? "Same kind of video" : v < 70 ? "Same look" : v < 90 ? "Very close" : "Nearly identical";
}
function closenessHint(v) {
  const floor = v < 50 ? 0 : Math.round((v - 50) * 1.4);
  if (v < 35) return "Same subject and vibe, any style. Always saves the number you asked for.";
  if (!floor) return "Same subject, setting and style — the most alike are saved first. Always saves the number you asked for.";
  const strict = v >= 70 ? " May save fewer than you asked for if not enough are found." : "";
  return `Videos that look less than ${floor}% like your reference are left out, also after checking their frames.${strict}`;
}

function updateOutputs() {
  $("#agents_out").textContent = $("#agents").value;
  const min = +$("#min_score").value;
  $("#min_score_out").textContent = min ? min : "off";
  $("#pool_size").placeholder = `auto (${autoPool(+$("#target_count").value || 20)})`;
  const close = +$("#closeness").value;
  $("#closeness_out").textContent = closenessLabel(close);
  $("#closeness_hint").textContent = closenessHint(close);
}

let saveTimer;
function scheduleSave() {
  updateOutputs();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { settings = await api("/api/settings", { method: "PUT", body: readForm() }); }
    catch (err) { toast(err.message); }
  }, 500);
}

form.addEventListener("input", (e) => {
  if (e.target.name === "model") renderModelHint();
  scheduleSave();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (running) {
    // First press: stop searching and save the best found so far. Second press: stop everything.
    const finishing = document.body.classList.contains("finishing");
    if (!finishing) document.body.classList.add("finishing");
    await api(finishing ? "/api/hunt/stop" : "/api/hunt/finish", { method: "POST" })
      .catch((err) => toast(err.message));
    return;
  }
  const s = readForm();
  try {
    resetLive();
    setRunning(true);
    const res = await api("/api/hunt/start", {
      method: "POST",
      body: { settings: s, screen_w: window.screen.availWidth || 1440, screen_h: window.screen.availHeight || 900 },
    });
    settings = s;
    $("#headline").textContent = "Starting the agents…";
    $("#subline").textContent = res.folder;
  } catch (err) {
    setRunning(false);
    toast(err.message, 6000);
  }
});

$("#browse").addEventListener("click", async () => {
  try {
    const { path } = await api("/api/pick-folder", { method: "POST" });
    if (path) { $("#output_dir").value = path; scheduleSave(); }
  } catch (err) { toast(err.message); }
});

$("#open_folder").addEventListener("click", () => {
  api("/api/open-folder", { method: "POST", body: {} }).catch((err) => toast(err.message));
});

$$(".connect").forEach((btn) => btn.addEventListener("click", async () => {
  try {
    await api(`/api/login/${btn.dataset.platform}`, { method: "POST" });
    toast(`Log in to ${PLATFORM_NAMES[btn.dataset.platform]} in the window that opened, then come back here.`, 7000);
    setTimeout(refreshStatus, 4000);
  } catch (err) { toast(err.message); }
}));

$("#pull").addEventListener("click", async () => {
  const model = $("#model").value;
  try {
    await api("/api/ollama/pull", { method: "POST", body: { model } });
    $("#pull").disabled = true;
    $("#model_hint").textContent = `Downloading ${model}…`;
  } catch (err) { toast(err.message); }
});

// ------------------------------------------------------------------ status pills

function pill(text, kind, title = "") {
  const el = document.createElement("span");
  el.className = `pill ${kind}`;
  el.textContent = text;
  if (title) el.title = title;
  return el;
}

function renderStatus() {
  if (!status) return;
  const pills = $("#pills");
  pills.replaceChildren();
  $("#build").textContent = status.build ? `· version ${status.build}` : "";
  if (status.update_available) {
    pills.append(pill("Update ready — quit and reopen the app", "warn",
      "A newer version is out. Open the Reel Finder app again (or close this Terminal window first) to install it."));
  }
  const o = status.ollama;
  if (!o.running) pills.append(pill("AI off — keyword mode", "warn", "Start Ollama to let the AI judge videos"));
  else if (!o.installed) pills.append(pill(`AI model missing`, "warn", `Download ${o.model} (left side)`));
  else pills.append(pill(`AI: ${o.model}`, "ok"));
  pills.append(status.ffmpeg ? pill("ffmpeg", "ok") : pill("ffmpeg missing", "bad"));
  const sim = status.similarity;
  if (sim && !sim.installed) pills.append(pill("Look-matching off", "warn", "Quit and reopen Reel Finder to install it"));
  else if (sim?.error) pills.append(pill("Look-matching off", "warn", sim.error));
  else if (sim) pills.append(pill("Look-matching", "ok", sim.downloaded ? "Compares how videos look"
    : "The model (~600 MB) downloads the first time you add a reference or start a hunt"));
  for (const p of ["tiktok", "instagram", "pinterest"]) {
    const ok = !!status.logins[p];
    pills.append(pill(`${PLATFORM_NAMES[p]} ${ok ? "connected" : "not connected"}`, ok ? "ok" : ""));
    const btn = $(`.connect[data-platform=${p}]`);
    btn.textContent = ok ? "Connected ✓" : "Connect";
    btn.classList.toggle("connected", ok);
  }
  renderModels();
  if (status.hunting !== running) setRunning(status.hunting);
  if (status.testing !== testing) { testing = status.testing; updateBusy(); }
}

let modelsSignature = "";
function renderModels() {
  const select = $("#model");
  const current = select.value || settings?.model;
  const installed = status?.ollama.models || [];
  const signature = JSON.stringify([installed, current]);
  if (signature === modelsSignature) { renderModelHint(); return; }
  modelsSignature = signature;
  const names = new Set(installed.map((m) => m.name));
  select.replaceChildren();
  const add = (value, label) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.append(opt);
  };
  for (const m of installed) add(m.name, `${m.name}${m.vision ? " · sees images" : " · text only"}`);
  for (const r of RECOMMENDED_MODELS) {
    if (!names.has(r.name)) add(r.name, `${r.name} · not installed`);
  }
  if (current && ![...select.options].some((o) => o.value === current)) add(current, `${current} · not installed`);
  select.value = current;
  renderModelHint();
}

function renderModelHint() {
  const o = status?.ollama;
  const model = $("#model").value;
  const installed = (o?.models || []).some((m) => m.name === model || m.name === `${model}:latest`);
  const pull = $("#pull");
  pull.hidden = !o?.running || installed;
  pull.disabled = !!o?.pulling;
  const hint = $("#model_hint");
  if (!o) hint.textContent = "";
  else if (!o.running) hint.textContent = "Ollama isn't running. Quit and reopen Reel Finder; it installs and starts Ollama for you. Until then, videos are matched by keywords.";
  else if (!installed) {
    const rec = RECOMMENDED_MODELS.find((r) => r.name === model);
    hint.textContent = o.pulling ? "Downloading model…"
      : `Press Download to install this model (one time).${rec ? ` ${model}: ${rec.note}.` : ""}`;
  } else {
    const m = o.models.find((x) => x.name === model || x.name === `${model}:latest`);
    hint.textContent = m && !m.vision ? "This model can't see thumbnails, so it judges captions only." : "";
  }
}

async function refreshStatus() {
  try {
    status = await api("/api/status");
    renderStatus();
  } catch { /* server restarting */ }
}

// ------------------------------------------------------------------ self-test & report

const STEP_ICON = { ok: "✓", warn: "!", fail: "✕", skip: "–", pending: "", running: "…" };

function renderSelfTest(t) {
  const panel = $("#selftest");
  panel.hidden = false;
  $("#selftest_title").textContent =
    `${PLATFORM_NAMES[t.platform]} self-test · searching “${t.query}”${t.running ? "" : " · done"}`;
  $("#selftest_steps").replaceChildren(...t.steps.map((step) => {
    const li = document.createElement("li");
    li.className = "step";
    li.dataset.status = step.status;
    li.innerHTML = '<span class="step-icon" aria-hidden="true"></span><span class="step-name"></span><span class="step-detail"></span>';
    $(".step-icon", li).textContent = STEP_ICON[step.status] ?? "";
    $(".step-name", li).textContent = step.name;
    $(".step-detail", li).textContent = step.status === "pending" ? "Waiting…" : step.detail;
    return li;
  }));
  const fails = t.steps.filter((s) => s.status === "fail").length;
  const warns = t.steps.filter((s) => s.status === "warn").length;
  $("#selftest_hint").textContent = t.running ? ""
    : fails ? "Something isn't working. Click Copy report and paste it into a chat with Claude."
    : warns ? "It works — see the notes marked “!”."
    : `Everything works for ${PLATFORM_NAMES[t.platform]} on this computer.`;
  testing = t.running;
  updateBusy();
}

$$(".selftest-btn").forEach((btn) => btn.addEventListener("click", async () => {
  const platform = btn.dataset.platform;
  try {
    testing = true;
    updateBusy();
    const { query } = await api(`/api/selftest/${platform}`, { method: "POST", body: { settings: readForm() } });
    renderSelfTest({ platform, query, running: true, steps: [] });
    $("#selftest").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    testing = false;
    updateBusy();
    toast(err.message);
  }
}));

$("#close_selftest").addEventListener("click", () => { $("#selftest").hidden = true; });

async function copyReport() {
  let text;
  try {
    const res = await fetch("/api/report");
    text = await res.text();
  } catch (err) {
    toast(`Couldn't build the report: ${err.message}`);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Report copied — paste it into a chat with Claude.", 6000);
  } catch {
    window.open("/api/report", "_blank");  // the clipboard is blocked: show it to copy by hand
  }
}
$("#copy_report").addEventListener("click", copyReport);
$("#copy_report_log").addEventListener("click", copyReport);
$("#open_log").addEventListener("click", () => {
  api("/api/open-log", { method: "POST" }).catch((err) => toast(err.message));
});

// ------------------------------------------------------------------ live view

function setRunning(on) {
  running = on;
  document.body.classList.toggle("running", on);
  if (!on) document.body.classList.remove("finishing");
  updateBusy();
}

// The hunt and the self-test share the agents' browser, so only one runs at a time.
function updateBusy() {
  $$(".selftest-btn").forEach((b) => { b.disabled = running || testing; });
  $("#start").disabled = testing && !running;
}

function resetLive() {
  cards.clear();
  agents.clear();
  $("#feed").replaceChildren();
  $("#agents_grid").replaceChildren();
  $("#log").replaceChildren();
  renderCounts();
}

function renderProgress(p) {
  if (!p) return;
  huntUsesReference = !!p.matching_looks;
  $("#downloaded").textContent = p.downloaded;
  $("#target").textContent = p.target;
  const pct = p.target ? Math.min(100, (100 * p.downloaded) / p.target) : 0;
  $("#bar_fill").style.width = `${pct}%`;
  $("#bar").setAttribute("aria-valuenow", String(p.downloaded));
  $("#bar").setAttribute("aria-valuemax", String(p.target));
  if (p.running) {
    let head = PHASE_TEXT[p.phase] || "Hunting…";
    if (p.phase === "searching") head += ` — ${p.looked_at} of ${p.pool_target}`;
    if (p.phase === "checking") head += ` — ${p.queued} to go${p.quick ? " (from captions)" : ""}`;
    if (p.finishing) head = `Finishing up — ${head.toLowerCase()}`;
    $("#headline").textContent = head;
    const how = p.matching_looks ? ` · matching ${p.references > 1 ? `${p.references} references` : "your reference"} (${p.closeness.toLowerCase()})` : "";
    $("#subline").textContent = `${p.folder}${p.brain ? ` · scored by ${p.brain}` : ""}${how}`;
    document.body.classList.toggle("finishing", !!p.finishing || document.body.classList.contains("finishing"));
  } else if (p.finished_reason) {
    $("#headline").textContent = p.finished_reason;
    $("#subline").textContent = p.folder;
  }
  const stats = [
    ["Looked at", `${p.looked_at ?? 0} / ${p.pool_target ?? "–"}`], ["Scored", p.scored ?? 0],
    ["Waiting for AI", p.queued], ["Saving", p.downloading], ["Skipped by filters", p.skipped ?? 0],
    ["Replaced", p.failed], ["Already had", p.already_have], ["Time", fmtTime(p.elapsed)],
  ];
  $("#stats").replaceChildren(...stats.map(([k, v]) => {
    const span = document.createElement("span");
    span.innerHTML = `${k} <b></b>`;
    span.querySelector("b").textContent = v;
    return span;
  }));
  if (p.running !== running) setRunning(p.running);
}

function renderAgent(a) {
  agents.set(a.id, a);
  let el = $(`#agent-${a.id}`);
  if (!el) {
    el = document.createElement("div");
    el.className = "panel agent";
    el.id = `agent-${a.id}`;
    el.innerHTML = `<div class="agent-top"><span class="agent-name"></span><span class="agent-found"></span></div>
      <div class="agent-query"></div><div class="agent-state"><span class="dot"></span><span class="txt"></span></div>
      <div class="agent-note"></div>`;
    $("#agents_grid").append(el);
  }
  el.dataset.state = a.state;
  $(".agent-name", el).textContent = `Agent ${a.id} · ${PLATFORM_NAMES[a.platform]}`;
  $(".agent-found", el).textContent = `${a.found} found`;
  $(".agent-query", el).textContent = a.query ? `“${a.query}”` : "—";
  $(".agent-query", el).title = a.query;
  $(".txt", el).textContent = `${AGENT_STATE[a.state] || a.state}${a.state === "scrolling" ? ` · ${a.scrolls} scrolls` : ""}`;
  const urgent = ["captcha", "login", "error", "limited"].includes(a.state);
  $(".agent-note", el).textContent = urgent ? a.note : "";
}

function renderCandidate(c) {
  const key = `${c.platform}:${c.id}`;
  let el = cards.get(key);
  if (!el) {
    el = $("#card_tpl").content.firstElementChild.cloneNode(true);
    cards.set(key, el);
    $("#feed").prepend(el);
    $("#empty").hidden = true;
  }
  el.dataset.status = c.status;
  const link = $(".thumb", el);
  link.href = c.url;
  const img = $("img", el);
  const local = c.thumb ? `/thumbs/${encodeURIComponent(c.thumb)}` : "";
  if (local && img.dataset.src !== local) {
    img.dataset.src = img.src = local;
  } else if (!img.dataset.src && c.thumbnail_url) {
    // Until the AI has fetched a copy, try the site's own cover image.
    img.referrerPolicy = "no-referrer";
    img.onerror = () => { if (!img.src.includes("/thumbs/")) img.removeAttribute("src"); };
    img.dataset.src = img.src = c.thumbnail_url;
  }
  $(".badge.platform", el).textContent =
    (PLATFORM_BADGE[c.platform] || c.platform) + (c.kind === "image" ? " · image" : "");
  const hasScore = c.score !== null && c.score !== undefined;
  const score = $(".badge.score", el);
  score.textContent = hasScore ? c.score : "";
  score.title = c.quick ? "Scored quickly (no AI look)" : c.look != null ? `Score: AI ${c.ai_score} + look ${c.look}` : "AI score";
  score.className = `badge score ${c.score >= 70 ? "good" : c.score >= 40 ? "meh" : ""}`;
  // The "Best" tab shows everything that's been scored, highest first.
  el.style.setProperty("--order", String(hasScore ? 1000 - c.score : 2000));
  $(".status", el).textContent = STATUS_TEXT[c.status] || c.status;
  $(".caption", el).textContent = c.caption || "(no caption yet)";
  $(".caption", el).title = c.caption || "";
  const meta = [c.author && `@${c.author}`, c.views != null && `${fmt(c.views)} views`,
    c.likes != null && `${fmt(c.likes)} likes`, c.duration && `${Math.round(c.duration)}s`].filter(Boolean);
  $(".meta", el).textContent = meta.join(" · ");
  renderLook(el, c);
  $(".reason", el).textContent = c.reason || "";
  const more = $(".more-like", el);
  more.hidden = c.kind === "image" || !["scored", "picked", "downloading", "watching", "downloaded", "notpicked"].includes(c.status);
  more.onclick = () => addReferenceLink(c.url, { fromCard: true });
  renderCounts();
}

function renderLook(el, c) {
  const box = $(".look", el);
  const value = c.frames_look ?? c.look;
  box.hidden = value === null || value === undefined;
  if (box.hidden) return;
  $(".look-bar > span", box).style.width = `${value}%`;
  box.dataset.level = value >= 70 ? "high" : value >= 40 ? "mid" : "low";
  const what = huntUsesReference ? "like your reference" : "matches your description";
  const parts = [`${huntUsesReference ? "Looks " : "Picture "}${value}% ${what}`];
  if (c.frames_look != null && c.look != null) parts.push(`cover ${c.look}%`);
  $(".look-text", box).textContent = parts.join(" · ");
  box.title = c.frames_look != null ? "Measured on the downloaded video's own frames" : "Measured on the cover image";
}

function renderCounts() {
  const all = [...cards.values()];
  const by = (pred) => all.filter((el) => pred(el.dataset.status)).length;
  $("#n_all").textContent = all.length || "";
  $("#n_downloaded").textContent = by((s) => s === "downloaded") || "";
  $("#n_rejected").textContent = by((s) => s === "skipped" || s === "failed" || s === "unchecked") || "";
  $("#n_best").textContent = by((s) => BEST_STATES.includes(s)) || "";
}

const BEST_STATES = ["scored", "picked", "downloading", "watching", "downloaded", "notpicked"];

// ------------------------------------------------------------------ save a link

$("#save_link").addEventListener("click", saveLink);
$("#link_url").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveLink(); } });

async function saveLink() {
  const url = $("#link_url").value.trim();
  if (!url) return;
  const hint = $("#link_hint");
  const before = hint.textContent;
  hint.textContent = "Saving…";  // before the request: a quick save can finish before the reply arrives
  try {
    await api("/api/save-link", { method: "POST", body: { url } });
  } catch (err) {
    hint.textContent = before;
    toast(err.message);
  }
}

function renderLink(d) {
  const hint = $("#link_hint");
  if (d.status === "working") hint.textContent = "Saving…";
  else if (d.status === "done") {
    hint.textContent = `✓ Saved: ${d.summary}. In “Saved links”.`;
    $("#link_url").value = "";
    toast("Video saved to “Saved links”.");
  } else {
    hint.textContent = `Couldn't save it: ${d.error}`;
  }
}

// ------------------------------------------------------------------ reference videos

function renderReferences() {
  const list = $("#refs");
  const refs = [...references.values()].sort((a, b) => a.created - b.created);
  list.replaceChildren(...refs.map(referenceCard));
  const ready = refs.some((r) => r.status === "ready");
  $("#closeness_box").hidden = !refs.length;
  $("#dropzone").classList.toggle("compact", refs.length > 0);
  $("#dropzone").hidden = refs.length >= MAX_REFERENCES;
  $("#description_label").textContent = refs.length ? "Anything to add? (optional)" : "What are you looking for?";
  $("#description").placeholder = refs.length
    ? "e.g. only night shots, no talking — or leave empty and let the reference speak"
    : "e.g. Cinematic slow-motion car drifts at night with smoke, no talking, filmed from low angles";
  if (!running && $("#headline").textContent === "Ready when you are") {
    $("#subline").textContent = ready ? "Press Start hunt to find videos that look like your reference."
      : "Drop a reference video or describe what you need, then press Start hunt.";
  }
}

function referenceCard(r) {
  const el = document.createElement("div");
  el.className = "ref";
  el.dataset.status = r.status;
  const frames = document.createElement("div");
  frames.className = "ref-frames";
  if (r.uploading) {
    frames.textContent = "⤒";
  } else {
    const picks = r.frames <= 4 ? [...Array(r.frames).keys()] : [0, 2, 5, 7].filter((i) => i < r.frames);
    for (const i of picks) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = `/references/${r.id}/frame/${i + 1}.jpg`;
      frames.append(img);
    }
  }
  const body = document.createElement("div");
  body.className = "ref-body";
  const name = document.createElement("div");
  name.className = "ref-name";
  name.textContent = r.source === "link" ? (r.author ? `@${r.author}` : r.name) : r.name;
  name.title = r.name;
  const state = document.createElement("div");
  state.className = "ref-state";
  state.textContent = r.uploading ? "Uploading…"
    : r.status === "analyzing" ? (r.step || "Analysing…")
    : r.status === "failed" ? `Couldn't use it: ${r.error}`
    : `Ready${r.tags?.length ? ` · ${r.tags.join(", ")}` : ""}`;
  body.append(name, state);
  if (r.description) {
    const desc = document.createElement("p");
    desc.className = "ref-desc";
    desc.textContent = r.description;
    body.append(desc);
  }
  if (r.note) {
    const note = document.createElement("p");
    note.className = "ref-note";
    note.textContent = r.note;
    body.append(note);
  }
  el.append(frames, body);
  if (!r.uploading) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ref-remove";
    remove.setAttribute("aria-label", `Remove ${r.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      api(`/api/references/${r.id}`, { method: "DELETE" })
        .then(() => { references.delete(r.id); renderReferences(); })
        .catch((err) => toast(err.message));
    });
    el.append(remove);
  }
  return el;
}

async function uploadReference(file) {
  if (references.size >= MAX_REFERENCES) { toast(`Up to ${MAX_REFERENCES} reference videos — remove one first.`); return; }
  if (!/^(video|image)\//.test(file.type) && !/\.(mp4|mov|m4v|webm|mkv|avi|gif|jpe?g|png|webp|heic)$/i.test(file.name)) {
    toast(`“${file.name}” isn't a video or picture.`);
    return;
  }
  const temp = `upload-${Date.now()}-${Math.random()}`;
  references.set(temp, { id: temp, name: file.name, uploading: true, status: "analyzing", created: Date.now() / 1000, frames: 0 });
  renderReferences();
  try {
    const res = await fetch(`/api/references/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "X-Reel-Finder": "1", "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Upload failed (${res.status})`);
    if (!references.has(data.id)) references.set(data.id, data);
  } catch (err) {
    toast(err.message, 6000);
  } finally {
    references.delete(temp);
    renderReferences();
  }
}

async function addReferenceLink(url, { fromCard = false } = {}) {
  url = (url || "").trim();
  if (!url) return;
  try {
    const ref = await api("/api/references/link", { method: "POST", body: { url } });
    if (!references.has(ref.id)) references.set(ref.id, ref);
    renderReferences();
    if (!fromCard) $("#ref_link").value = "";
    else toast(running ? "Added as a reference for your next hunt." : "Added as a reference — press Start hunt to find more like it.", 6000);
  } catch (err) { toast(err.message, 6000); }
}

const dropzone = $("#dropzone");
$("#ref_choose").addEventListener("click", () => $("#ref_file").click());
dropzone.addEventListener("click", (e) => { if (e.target === dropzone) $("#ref_file").click(); });
$("#ref_file").addEventListener("change", (e) => {
  [...e.target.files].forEach(uploadReference);
  e.target.value = "";
});
for (const ev of ["dragenter", "dragover"]) {
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("over"); });
}
for (const ev of ["dragleave", "drop"]) {
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("over"); });
}
dropzone.addEventListener("drop", (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) files.forEach(uploadReference);
  else {
    const url = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
    if (url && /^https?:\/\//.test(url)) addReferenceLink(url);
  }
});
// A file dropped anywhere else on the page would make the browser open it and leave Reel Finder.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
$("#ref_add_link").addEventListener("click", () => addReferenceLink($("#ref_link").value));
$("#ref_link").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addReferenceLink($("#ref_link").value); }
});

async function loadReferences() {
  try {
    const refs = await api("/api/references");
    references.clear();
    refs.forEach((r) => references.set(r.id, r));
  } catch { /* server restarting */ }
  renderReferences();
}

function addLog(entry, { silent = false } = {}) {
  const row = document.createElement("div");
  row.className = entry.level === "warn" ? "warn" : "";
  const time = document.createElement("time");
  time.textContent = new Date(entry.t * 1000).toLocaleTimeString();
  row.append(time, document.createTextNode(entry.text));
  const log = $("#log");
  log.append(row);
  while (log.childElementCount > 300) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  if (entry.level === "warn" && !silent) toast(entry.text, 7000);
}

$$(".tab").forEach((tab) => tab.addEventListener("click", () => {
  $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  $("#feed").dataset.filter = tab.dataset.filter;
}));

// ------------------------------------------------------------------ websocket

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (event) => {
    const { type, data } = JSON.parse(event.data);
    switch (type) {
      case "snapshot":
        if (!data) break;
        resetLive();
        renderProgress(data.progress);
        data.agents.forEach(renderAgent);
        data.candidates.forEach(renderCandidate);
        data.logs.forEach((l) => addLog(l, { silent: true }));
        break;
      case "progress": renderProgress(data); break;
      case "agent": renderAgent(data); break;
      case "candidate": renderCandidate(data); break;
      case "log": addLog(data); break;
      case "finished":
        renderProgress(data);
        setRunning(false);
        if (data.downloaded) $(".tab[data-filter=downloaded]").click();
        toast(`${data.finished_reason}.`, 7000);
        refreshStatus();
        break;
      case "selftest": renderSelfTest(data); break;
      case "link": renderLink(data); break;
      case "reference": references.set(data.id, data); renderReferences(); break;
      case "reference_removed": references.delete(data.id); renderReferences(); break;
      case "model_pull":
        if (data.error) { toast(data.error, 7000); refreshStatus(); }
        else if (data.done) { toast(`${data.model} is ready.`); refreshStatus(); }
        else $("#model_hint").textContent = `Downloading ${data.model}: ${data.percent ?? "…"}${data.percent != null ? "%" : ""} ${data.status || ""}`;
        break;
    }
  };
  ws.onopen = () => loadReferences();  // catch up on anything that changed while disconnected
  ws.onclose = () => setTimeout(connect, 1500);
}

// ------------------------------------------------------------------ boot

(async function boot() {
  try {
    settings = await api("/api/settings");
    fillForm(settings);
  } catch (err) {
    toast(`Couldn't load settings: ${err.message}`);
  }
  await refreshStatus();
  await loadReferences();
  connect();
  setInterval(refreshStatus, 5000);
})();
