"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const RECOMMENDED_MODELS = [
  { name: "qwen3-vl:8b-instruct", note: "recommended, sees thumbnails, ~6 GB, best on 16 GB Macs" },
  { name: "gemma3:4b", note: "smaller and faster, sees thumbnails, ~3.3 GB, fine on 8 GB Macs" },
];
const NUMBER_FIELDS = ["target_count", "agents", "time_limit_min", "min_duration", "max_duration",
  "min_views", "min_likes", "max_age_days", "strictness"];
const STATUS_TEXT = {
  queued: "In line", found: "Found", judging: "AI is checking", accepted: "Match — downloading soon",
  downloading: "Downloading", checking: "Watch-check", downloaded: "✓ Downloaded",
  rejected: "Skipped", failed: "Failed", spare: "Match — target already reached",
  unchecked: "Not checked (hunt ended)",
};
const DONE_NOT_SAVED = ["rejected", "failed", "spare", "unchecked"];
const AGENT_STATE = {
  opening: "Opening search", scrolling: "Scrolling", waiting: "Waiting for the AI",
  captcha: "Needs you: captcha", login: "Needs you: log in", error: "Error", done: "Finished",
};

const form = $("#options");
let settings = null;
let status = null;
let running = false;
const cards = new Map();
const agents = new Map();

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

const PLATFORM_NAMES = { tiktok: "TikTok", instagram: "Instagram" };

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

function updateOutputs() {
  $("#agents_out").textContent = $("#agents").value;
  $("#strictness_out").textContent = $("#strictness").value;
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
    await api("/api/hunt/stop", { method: "POST" }).catch((err) => toast(err.message));
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
  const o = status.ollama;
  if (!o.running) pills.append(pill("AI off — keyword mode", "warn", "Start Ollama to let the AI judge videos"));
  else if (!o.installed) pills.append(pill(`AI model missing`, "warn", `Download ${o.model} (left side)`));
  else pills.append(pill(`AI: ${o.model}`, "ok"));
  pills.append(status.ffmpeg ? pill("ffmpeg", "ok") : pill("ffmpeg missing", "bad"));
  for (const p of ["tiktok", "instagram"]) {
    const ok = status.logins[p];
    pills.append(pill(`${PLATFORM_NAMES[p]} ${ok ? "connected" : "not connected"}`, ok ? "ok" : ""));
    const btn = $(`.connect[data-platform=${p}]`);
    btn.textContent = ok ? "Connected ✓" : "Connect";
    btn.classList.toggle("connected", ok);
  }
  renderModels();
  if (status.hunting !== running) setRunning(status.hunting);
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
  else if (!o.running) hint.textContent = "Ollama isn't running. Open the Ollama app (or run start.command again). Until then, videos are matched by keywords.";
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

// ------------------------------------------------------------------ live view

function setRunning(on) {
  running = on;
  document.body.classList.toggle("running", on);
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
  $("#downloaded").textContent = p.downloaded;
  $("#target").textContent = p.target;
  const pct = p.target ? Math.min(100, (100 * p.downloaded) / p.target) : 0;
  $("#bar_fill").style.width = `${pct}%`;
  $("#bar").setAttribute("aria-valuenow", String(p.downloaded));
  $("#bar").setAttribute("aria-valuemax", String(p.target));
  if (p.running) {
    $("#headline").textContent = p.downloaded ? "Hunting — saving matches as they're found" : "Hunting…";
    $("#subline").textContent = `${p.folder}${p.brain ? ` · judged by ${p.brain}` : ""}`;
  } else if (p.finished_reason) {
    $("#headline").textContent = `${p.finished_reason} — ${p.downloaded} video${p.downloaded === 1 ? "" : "s"} saved`;
    $("#subline").textContent = p.folder;
  }
  const stats = [
    ["Found", p.found], ["Waiting for AI", p.queued], ["Downloading", p.downloading],
    ["Skipped", p.rejected], ["Already had", p.already_have], ["Failed", p.failed], ["Time", fmtTime(p.elapsed)],
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
  const urgent = a.state === "captcha" || a.state === "login" || a.state === "error";
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
  $(".badge.platform", el).textContent = c.platform === "tiktok" ? "TikTok" : "IG";
  const score = $(".badge.score", el);
  score.textContent = c.score === null || c.score === undefined ? "" : c.score;
  score.className = `badge score ${c.score >= (settings?.strictness ?? 70) ? "good" : c.score >= 40 ? "meh" : ""}`;
  $(".status", el).textContent = STATUS_TEXT[c.status] || c.status;
  $(".caption", el).textContent = c.caption || "(no caption yet)";
  $(".caption", el).title = c.caption || "";
  const meta = [c.author && `@${c.author}`, c.views != null && `${fmt(c.views)} views`,
    c.likes != null && `${fmt(c.likes)} likes`, c.duration && `${Math.round(c.duration)}s`].filter(Boolean);
  $(".meta", el).textContent = meta.join(" · ");
  $(".reason", el).textContent = c.reason || "";
  renderCounts();
}

function renderCounts() {
  const all = [...cards.values()];
  const by = (pred) => all.filter((el) => pred(el.dataset.status)).length;
  $("#n_all").textContent = all.length || "";
  $("#n_downloaded").textContent = by((s) => s === "downloaded") || "";
  $("#n_rejected").textContent = by((s) => DONE_NOT_SAVED.includes(s)) || "";
  $("#n_active").textContent = by((s) => s !== "downloaded" && !DONE_NOT_SAVED.includes(s)) || "";
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
        toast(`${data.finished_reason}: ${data.downloaded} video${data.downloaded === 1 ? "" : "s"} saved.`, 6000);
        refreshStatus();
        break;
      case "model_pull":
        if (data.error) { toast(data.error, 7000); refreshStatus(); }
        else if (data.done) { toast(`${data.model} is ready.`); refreshStatus(); }
        else $("#model_hint").textContent = `Downloading ${data.model}: ${data.percent ?? "…"}${data.percent != null ? "%" : ""} ${data.status || ""}`;
        break;
    }
  };
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
  connect();
  setInterval(refreshStatus, 5000);
})();
