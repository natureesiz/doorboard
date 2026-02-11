/**
 * Doorboard v1 (statik, offline destekli)
 * - localStorage key: "doorboard.v1"
 * - iPad Safari uyumlu: safe-area, touch, localStorage, file:// hata toleransı
 * - Hava: Worker endpoint (önerilen) -> çalışmazsa Open-Meteo fallback
 */

const STORAGE_KEY = "doorboard.v1";
const ENDPOINT_STORAGE_KEY = "doorboard.weatherEndpoint";
const memoryStorage = new Map();
let storageWarningShown = false;

function warnStorageFallback(err){
  if (storageWarningShown) return;
  storageWarningShown = true;
  console.warn("Persistent storage unavailable, using in-memory fallback.", err);
}

function readStorage(key){
  try {
    return localStorage.getItem(key);
  } catch (err){
    warnStorageFallback(err);
    return memoryStorage.get(key) ?? null;
  }
}

function writeStorage(key, value){
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err){
    warnStorageFallback(err);
    memoryStorage.set(key, String(value));
    return false;
  }
}

function isPersistentStorageAvailable(){
  const probeKey = "__doorboard_storage_probe__";
  try {
    localStorage.setItem(probeKey, "1");
    localStorage.removeItem(probeKey);
    return true;
  } catch (err){
    warnStorageFallback(err);
    return false;
  }
}

/**
 * ÖNERİLEN: Cloudflare Worker endpoint (env ile değiştirilebilir mantığı)
 * Kullanıcı bunu Edit modundan ayarlayabilir. Ayrıca spec gereği şu satır korunur:
 */
const WEATHER_ENDPOINT =
  readStorage(ENDPOINT_STORAGE_KEY) ||
  "https://YOUR_WORKER_DOMAIN/weather.json";

// İzmir koordinatları (merkez)
const IZMIR = { lat: 38.4237, lon: 27.1428, tz: "Europe/Istanbul" };

// Gün içi odak: 08:00–18:00 (v1: günlük özet kullanıyoruz)
const WEATHER_REFRESH_MS = 30 * 60 * 1000; // 30 dk
const CLOCK_TICK_MS = 1000; // 1 sn
const PIXEL_SHIFT_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_DEPARTURE_TIME = "07:35";
const CHECK_GROUPS = ["ruzgar", "bulut"];

let importStaged = null; // geçici import buffer

// ---------- Utils ----------
function pad2(n){ return String(n).padStart(2, "0"); }
function nowTs(){ return Date.now(); }

function todayISO(d = new Date()){
  // YYYY-MM-DD, local timezone
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  return `${y}-${m}-${dd}`;
}

function deepClone(obj){
  try { return JSON.parse(JSON.stringify(obj)); }
  catch { return obj; }
}

function safeJsonParse(str){
  try { return JSON.parse(str); } catch { return null; }
}

function uid(){
  // basit id
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

function isOnline(){
  // navigator.onLine iOS'ta bazen "optimistic" olabilir; yine de temel sinyal
  return navigator.onLine === true;
}

function fmtTimeHM(date = new Date()){
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function fmtTurkishDateLine(date = new Date()){
  // "11 Şubat 2026 Çarşamba"
  const fmt = new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    weekday: "long"
  });
  // "11 Şubat 2026 Çarşamba" formatına çok yakın döner
  // Bazı iOS sürümlerinde virgül gelebilir; temizleyelim.
  return fmt.format(date).replace(",", "");
}

function downloadJson(filename, dataObj){
  const blob = new Blob([JSON.stringify(dataObj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function clamp(n, min, max){
  return Math.max(min, Math.min(max, n));
}

async function fetchJsonWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- State ----------
function defaultState(){
  const d = new Date();
  const tISO = todayISO(d);

  return {
    settings: {
      weatherEndpoint: WEATHER_ENDPOINT,
      autoClearDoneAtNight: true,
      theme: "dark",
      pixelShift: false,
      departureTime: DEFAULT_DEPARTURE_TIME
    },
    today: {
      date: tISO,
      schedule: [
        { id: uid(), time: "09:30", text: "Okul", done: false },
        { id: uid(), time: "18:00", text: "Market", done: false },
        { id: uid(), time: "", text: "Kargoyu kontrol et", done: false },
      ],
      notes: {
        ruzgar: "• Kapüşonlu montu hazırla\n• Su almayı unutma",
        bulut: "• Gün içinde serinleyebilir\n• Çantada ince hırka bulunsun"
      },
      checklists: {
        ruzgar: [
          { id: uid(), text: "Anahtar", done: false },
          { id: uid(), text: "Cüzdan", done: false },
          { id: uid(), text: "Telefon", done: false }
        ],
        bulut: [
          { id: uid(), text: "Kart", done: false },
          { id: uid(), text: "Şarj", done: false },
          { id: uid(), text: "Kulaklık", done: false }
        ]
      }
    },
    tomorrow: {
      date: shiftISO(tISO, 1),
      schedule: [
        { id: uid(), time: "10:00", text: "Randevu", done: false },
        { id: uid(), time: "", text: "Kısa yürüyüş", done: false }
      ]
    },
    weatherCache: {
      fetchedAt: 0,
      payload: null // normalized
    }
  };
}

function shiftISO(iso, days){
  const [y,m,d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return todayISO(dt);
}

function loadState(){
  const raw = readStorage(STORAGE_KEY);
  const parsed = raw ? safeJsonParse(raw) : null;
  if (!parsed || typeof parsed !== "object") {
    const s = defaultState();
    saveState(s);
    return s;
  }

  // Şema toleransı: eksikleri tamamla
  const base = defaultState();
  const merged = mergeDeep(base, parsed);
  normalizeTodayData(merged);
  merged.settings.departureTime = normalizeDepartureTime(merged.settings.departureTime || DEFAULT_DEPARTURE_TIME);
  // Endpoint ayrıca spec'teki keyde de tutulmalı
  try {
    if (merged?.settings?.weatherEndpoint) {
      writeStorage(ENDPOINT_STORAGE_KEY, merged.settings.weatherEndpoint);
    }
  } catch {}
  saveState(merged);
  return merged;
}

function normalizeTodayData(s){
  if (!s || !s.today) return;
  const legacyChecklist = Array.isArray(s.today.checklist) ? s.today.checklist : [];
  if (!s.today.notes || typeof s.today.notes !== "object"){
    const text = (typeof s.today.notes === "string") ? s.today.notes : "";
    s.today.notes = { ruzgar: text, bulut: "" };
  } else {
    s.today.notes.ruzgar = String(s.today.notes.ruzgar ?? "");
    s.today.notes.bulut = String(s.today.notes.bulut ?? "");
  }

  if (!s.today.checklists || typeof s.today.checklists !== "object"){
    s.today.checklists = { ruzgar: legacyChecklist, bulut: [] };
  }
  for (const group of CHECK_GROUPS){
    if (!Array.isArray(s.today.checklists[group])) s.today.checklists[group] = [];
  }
  if (
    legacyChecklist.length > 0 &&
    s.today.checklists.ruzgar.length === 0 &&
    s.today.checklists.bulut.length === 0
  ){
    s.today.checklists.ruzgar = legacyChecklist;
  }
}

function saveState(state){
  writeStorage(STORAGE_KEY, JSON.stringify(state));
}

function mergeDeep(target, source){
  // basit deep merge (object->object). Array'leri source ile overwrite eder.
  const out = deepClone(target);
  if (!source || typeof source !== "object") return out;

  for (const k of Object.keys(source)){
    const sv = source[k];
    const tv = out[k];
    if (Array.isArray(sv)) out[k] = sv;
    else if (sv && typeof sv === "object" && tv && typeof tv === "object" && !Array.isArray(tv)){
      out[k] = mergeDeep(tv, sv);
    } else {
      out[k] = sv;
    }
  }
  return out;
}

let state = loadState();

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);

const hhEl = $("#hh");
const mmEl = $("#mm");
const colonEl = $("#colon");
const dateLineEl = $("#dateLine");
const exitPlanTimeEl = $("#exitPlanTime");
const exitCountdownEl = $("#exitCountdown");

const netDot = $("#netDot");
const netText = $("#netText");
const lastWeatherEl = $("#lastWeather");

const wSky = $("#wSky");
const wRain = $("#wRain");
const wTemp = $("#wTemp");
const wWind = $("#wWind");
const wTips = $("#wTips");
const wHint = $("#wHint");
const weatherVisual = $("#weatherVisual");

const todayList = $("#todayList");
const tomorrowList = $("#tomorrowList");
const ruzgarNotesBox = $("#ruzgarNotesBox");
const bulutNotesBox = $("#bulutNotesBox");
const ruzgarExitList = $("#ruzgarExitList");
const bulutExitList = $("#bulutExitList");
const goodLuckBanner = $("#goodLuckBanner");

const editBtn = $("#editBtn");
const modalBackdrop = $("#modalBackdrop");
const closeModalBtn = $("#closeModalBtn");
const cancelBtn = $("#cancelBtn");
const saveBtn = $("#saveBtn");

const endpointInput = $("#endpointInput");
const pixelShiftToggle = $("#pixelShiftToggle");
const departureTimeInput = $("#departureTimeInput");

const todayTimeInput = $("#todayTimeInput");
const todayTextInput = $("#todayTextInput");
const addTodayBtn = $("#addTodayBtn");
const editTodayList = $("#editTodayList");

const tomTimeInput = $("#tomTimeInput");
const tomTextInput = $("#tomTextInput");
const addTomBtn = $("#addTomBtn");
const editTomList = $("#editTomList");

const ruzgarNotesInput = $("#ruzgarNotesInput");
const bulutNotesInput = $("#bulutNotesInput");
const newRuzgarCheckItemInput = $("#newRuzgarCheckItemInput");
const addRuzgarCheckItemBtn = $("#addRuzgarCheckItemBtn");
const editRuzgarExitList = $("#editRuzgarExitList");
const newBulutCheckItemInput = $("#newBulutCheckItemInput");
const addBulutCheckItemBtn = $("#addBulutCheckItemBtn");
const editBulutExitList = $("#editBulutExitList");

const exportBtn = $("#exportBtn");
const importFile = $("#importFile");
const importActions = $("#importActions");
const importOverwriteBtn = $("#importOverwriteBtn");
const importMergeBtn = $("#importMergeBtn");
const importCancelBtn = $("#importCancelBtn");
const importHint = $("#importHint");

const clearDoneBtn = $("#clearDoneBtn");
const autoClearToggle = $("#autoClearToggle");
const resetChecklistBtn = $("#resetChecklistBtn");

const themeToggleBtn = $("#themeToggleBtn");
const modeChip = $("#modeChip");

const pixelShiftWrap = $("#pixelShiftWrap");
const runtimeWarningEl = $("#runtimeWarning");
let storagePersistent = true;

// ---------- Clock / Date ----------
function renderClock(){
  const d = new Date();
  hhEl.textContent = pad2(d.getHours());
  mmEl.textContent = pad2(d.getMinutes());
  dateLineEl.textContent = fmtTurkishDateLine(d);
  renderDepartureCountdown(d);

  // çok hafif "tick": colon opacity
  const sec = d.getSeconds();
  colonEl.style.opacity = (sec % 2 === 0) ? "0.55" : "0.95";
}

function parseDepartureTarget(now = new Date()){
  const raw = normalizeDepartureTime(state?.settings?.departureTime || DEFAULT_DEPARTURE_TIME);
  const [h, m] = raw.split(":").map(Number);
  const target = new Date(now);
  target.setHours(Number.isFinite(h) ? h : 7, Number.isFinite(m) ? m : 35, 0, 0);
  return { raw, target };
}

function formatMinSec(totalSec){
  const safe = Math.max(0, Math.floor(totalSec));
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  return `${pad2(mm)}:${pad2(ss)}`;
}

function renderDepartureCountdown(now = new Date()){
  const { raw, target } = parseDepartureTarget(now);
  exitPlanTimeEl.textContent = `Evden çıkış: ${raw}`;

  const diffSec = Math.floor((target.getTime() - now.getTime()) / 1000);
  exitCountdownEl.classList.remove("overdue", "frozen");

  if (diffSec >= 0){
    exitCountdownEl.textContent = `Kalan: ${formatMinSec(diffSec)}`;
    return;
  }

  const overdueSec = Math.abs(diffSec);
  if (overdueSec <= 600){
    exitCountdownEl.classList.add("overdue");
    exitCountdownEl.textContent = `Gecikme: +${formatMinSec(overdueSec)}`;
    return;
  }

  exitCountdownEl.classList.add("overdue", "frozen");
  exitCountdownEl.textContent = "Gecikme: +10:00";
}

function renderNet(){
  const online = isOnline();
  netDot.style.background = online ? "var(--good)" : "var(--bad)";
  netText.textContent = online ? "Online" : "Offline";
}

// ---------- Rendering Lists ----------
function renderScheduleList(ul, items, onToggle){
  ul.innerHTML = "";
  if (!items || items.length === 0){
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "—";
    ul.appendChild(li);
    return;
  }

  for (const it of items.slice(0, 8)){
    const li = document.createElement("li");
    li.className = "checkItem" + (it.done ? " done" : "");
    li.dataset.id = it.id;

    const left = document.createElement("div");
    left.className = "itemLeft";

    const cb = document.createElement("div");
    cb.className = "cb";
    cb.innerHTML = "<span>✓</span>";

    const txt = document.createElement("div");
    txt.className = "itemText";
    txt.textContent = it.text || "";

    left.appendChild(cb);
    left.appendChild(txt);

    const meta = document.createElement("div");
    meta.className = "itemMeta";
    meta.textContent = (it.time && it.time.trim()) ? `${it.time} —` : "";

    li.appendChild(left);
    li.appendChild(meta);

    // Touch/click: toggle
    li.addEventListener("click", () => onToggle(it.id));
    ul.appendChild(li);
  }
}

function renderMiniList(ul, items){
  ul.innerHTML = "";
  const slice = (items || []).slice(0, 3);
  if (slice.length === 0){
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "—";
    ul.appendChild(li);
    return;
  }
  for (const it of slice){
    const li = document.createElement("li");
    const t = (it.time && it.time.trim()) ? `${it.time} — ` : "";
    li.textContent = t + (it.text || "");
    ul.appendChild(li);
  }
}

function renderChecklist(ul, items, onToggle){
  ul.innerHTML = "";
  if (!items || items.length === 0){
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "—";
    ul.appendChild(li);
    return;
  }

  for (const it of items){
    const li = document.createElement("li");
    li.className = it.done ? "done" : "";
    li.dataset.id = it.id;

    const left = document.createElement("div");
    left.className = "itemLeft";

    const cb = document.createElement("div");
    cb.className = "cb";
    cb.innerHTML = "<span>✓</span>";

    const txt = document.createElement("div");
    txt.className = "itemText";
    txt.textContent = it.text || "";

    left.appendChild(cb);
    left.appendChild(txt);

    li.appendChild(left);
    const spacer = document.createElement("div");
    spacer.className = "itemMeta";
    spacer.textContent = "";
    li.appendChild(spacer);

    li.addEventListener("click", () => onToggle(it.id));
    ul.appendChild(li);
  }
}

// ---------- Weather ----------
function setWeatherUI(normalized, hintText){
  if (!normalized){
    wSky.textContent = "—";
    wRain.textContent = "—";
    wTemp.textContent = "—";
    wWind.textContent = "—";
    wTips.innerHTML = `<li class="muted">Hava verisi yok.</li>`;
    wHint.textContent = hintText || "";
    setWeatherVisual(null);
    return;
  }

  wSky.textContent = normalized.skyLabel || "—";
  wRain.textContent = normalized.rainLabel || "—";
  wTemp.textContent = (normalized.minTemp != null && normalized.maxTemp != null)
    ? `${Math.round(normalized.minTemp)}–${Math.round(normalized.maxTemp)}°C`
    : "—";
  wWind.textContent = normalized.windLabel || "—";

  wTips.innerHTML = "";
  const tips = Array.isArray(normalized.tips) ? normalized.tips.slice(0, 3) : [];
  if (tips.length === 0){
    wTips.innerHTML = `<li class="muted">—</li>`;
  } else {
    for (const t of tips){
      const li = document.createElement("li");
      li.textContent = t;
      wTips.appendChild(li);
    }
  }

  wHint.textContent = hintText || "";
  setWeatherVisual(normalized);
}

function setWeatherVisual(normalized){
  if (!weatherVisual) return;
  weatherVisual.classList.remove("weather-sun", "weather-rain", "weather-cloud", "weather-wind", "weather-unknown");
  if (!normalized){
    weatherVisual.classList.add("weather-unknown");
    return;
  }
  const sky = (normalized.skyLabel || "").toLowerCase();
  const rain = (normalized.rainLabel || "").toLowerCase();
  const wind = (normalized.windLabel || "").toLowerCase();

  if (rain.includes("var")){
    weatherVisual.classList.add("weather-rain");
    return;
  }
  if (wind.includes("kuvvetli")){
    weatherVisual.classList.add("weather-wind");
    return;
  }
  if (sky.includes("güneşli") || sky.includes("az bulutlu")){
    weatherVisual.classList.add("weather-sun");
    return;
  }
  if (sky.includes("bulut") || sky.includes("sis")){
    weatherVisual.classList.add("weather-cloud");
    return;
  }
  weatherVisual.classList.add("weather-unknown");
}

function updateLastWeatherLine(){
  const ts = state?.weatherCache?.fetchedAt || 0;
  if (!ts){
    lastWeatherEl.textContent = "Hava: —";
    return;
  }
  const d = new Date(ts);
  lastWeatherEl.textContent = `Hava: ${fmtTimeHM(d)}`;
}

function normalizeWeather(payload){
  /**
   * Normalization contract:
   * - skyLabel
   * - rainLabel (var/yok + düşük/orta/yüksek)
   * - minTemp, maxTemp
   * - windLabel (hafif/orta/kuvvetli)
   * - tips[] (2-3)
   *
   * payload iki tip olabilir:
   * 1) Zaten normalized gibi: { skyLabel, rainLabel, ... }
   * 2) Open-Meteo raw response
   */

  if (!payload || typeof payload !== "object") return null;

  // Already normalized?
  if (typeof payload.skyLabel === "string" && typeof payload.rainLabel === "string"){
    const out = {
      skyLabel: payload.skyLabel,
      rainLabel: payload.rainLabel,
      minTemp: payload.minTemp ?? null,
      maxTemp: payload.maxTemp ?? null,
      windLabel: payload.windLabel ?? "—",
      tips: Array.isArray(payload.tips) ? payload.tips : []
    };
    // tips boşsa üretebiliriz
    if (!out.tips || out.tips.length === 0){
      out.tips = buildTips(out);
    }
    return out;
  }

  // Open-Meteo raw
  // Beklenen: daily.temperature_2m_min[0], daily.temperature_2m_max[0],
  // daily.precipitation_probability_max[0], daily.windspeed_10m_max[0], daily.weathercode[0]
  const daily = payload.daily;
  if (!daily) return null;

  const minTemp = numOrNull(daily.temperature_2m_min?.[0]);
  const maxTemp = numOrNull(daily.temperature_2m_max?.[0]);
  const pop = numOrNull(daily.precipitation_probability_max?.[0]); // 0..100
  const wind = numOrNull(daily.windspeed_10m_max?.[0]); // km/h
  const code = numOrNull(daily.weathercode?.[0]);

  const skyLabel = skyFromOpenMeteoCode(code);
  const { rainLabel, rainLevel } = rainFromPop(pop, code);
  const windLabel = windLabelFromSpeed(wind);

  const out = { skyLabel, rainLabel, minTemp, maxTemp, windLabel, tips: [] };
  out.tips = buildTips(out, { rainLevel });
  return out;
}

function numOrNull(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function skyFromOpenMeteoCode(code){
  // Open-Meteo weathercode mapping (özet)
  // 0 Clear, 1-3 mainly clear/partly cloudy/overcast
  // 45-48 fog, 51-57 drizzle, 61-67 rain, 71-77 snow, 80-82 rain showers, 95-99 thunderstorm
  if (code == null) return "—";
  if (code === 0) return "Güneşli";
  if (code >= 1 && code <= 2) return "Az bulutlu";
  if (code === 3) return "Bulutlu";
  if (code >= 45 && code <= 48) return "Sisli";
  if (code >= 51 && code <= 57) return "Çiseleme";
  if (code >= 61 && code <= 67) return "Yağmurlu";
  if (code >= 71 && code <= 77) return "Karlı";
  if (code >= 80 && code <= 82) return "Sağanak";
  if (code >= 95) return "Gök gürültülü";
  return "Parçalı bulutlu";
}

function rainFromPop(pop, code){
  // Yağış var/yok + düşük/orta/yüksek
  // pop yoksa koda göre sezdir
  let p = pop;
  if (p == null){
    // code yağışlı gruplara giriyorsa "orta"
    if (code != null && (code >= 51 && code <= 67 || code >= 80 && code <= 82 || code >= 95)){
      p = 60;
    } else {
      p = 10;
    }
  }
  const level = (p >= 65) ? "yüksek" : (p >= 35) ? "orta" : "düşük";
  const has = p >= 20 || (code != null && (code >= 51 && code <= 67 || code >= 80 && code <= 82 || code >= 95));
  const rainLabel = has ? `Var (ihtimal: ${level})` : `Yok (ihtimal: ${level})`;
  return { rainLabel, rainLevel: level, hasRain: has };
}

function windLabelFromSpeed(kmh){
  if (kmh == null) return "—";
  if (kmh < 18) return "Hafif";
  if (kmh < 35) return "Orta";
  return "Kuvvetli";
}

function buildTips(norm, extra = {}){
  const tips = [];

  // Rain tips
  const rainText = (norm.rainLabel || "").toLowerCase();
  const hasRain = rainText.includes("var");
  const rainLevel = extra.rainLevel || (rainText.includes("yüksek") ? "yüksek" : rainText.includes("orta") ? "orta" : "düşük");

  if (hasRain){
    tips.push(rainLevel === "yüksek" ? "Kapüşonlu mont tercih et, suya dayanıklı ayakkabı seç." : "Kapüşonlu ince mont tercih etmek rahat olur.");
  } else {
    tips.push("Yağış beklenmiyor: hızlı çıkış için ideal.");
  }

  // Temperature tips
  const minT = norm.minTemp;
  const maxT = norm.maxTemp;
  if (minT != null && minT <= 8){
    tips.push("Sabah serin: mont/kalın üst iyi olur.");
  } else if (maxT != null && maxT >= 27){
    tips.push("Sıcak: su + açık renk kıyafet önerilir.");
  } else if (minT != null && maxT != null && (maxT - minT) >= 10){
    tips.push("Gün içi fark yüksek: katmanlı giyin.");
  }

  // Sky tips
  const sky = (norm.skyLabel || "").toLowerCase();
  if (sky.includes("güneşli") || sky.includes("az bulutlu")){
    tips.push("Güneş gözlüğü işe yarar.");
  }

  // Wind tips
  const wind = (norm.windLabel || "").toLowerCase();
  if (wind.includes("kuvvetli")){
    tips.push("Rüzgar kuvvetli: hafif eşyaları sabitle.");
  }

  // 2-3 arası tut
  // Öncelik: yağış, sıcaklık, güneş
  const uniq = [];
  for (const t of tips){
    if (!uniq.includes(t)) uniq.push(t);
  }
  return uniq.slice(0, 3);
}

async function fetchWeather(){
  const online = isOnline();
  renderNet();

  if (!online){
    // Offline: cache göster
    const cached = state?.weatherCache?.payload || null;
    setWeatherUI(cached, "Offline: son kayıt gösteriliyor.");
    updateLastWeatherLine();
    return;
  }

  // Online: 1) Worker endpoint dene 2) Open-Meteo fallback
  const endpoint = (state?.settings?.weatherEndpoint || WEATHER_ENDPOINT || "").trim();

  let normalized = null;
  let fetchedAt = 0;
  let hint = "";

  if (endpoint && endpoint.startsWith("http")){
    try {
      const data = await fetchJsonWithTimeout(endpoint);
      normalized = normalizeWeather(data);
      if (!normalized) throw new Error("Normalize failed (endpoint payload)");
      fetchedAt = nowTs();
      hint = "Hava: endpoint";
    } catch (e){
      console.warn("Weather endpoint failed:", e);
      hint = "Endpoint başarısız. Fallback deneniyor…";
    }
  } else {
    hint = "Endpoint yok. Fallback deneniyor…";
  }

  if (!normalized){
    try {
      const url = openMeteoUrl();
      const data = await fetchJsonWithTimeout(url);
      normalized = normalizeWeather(data);
      if (!normalized) throw new Error("Normalize failed (open-meteo payload)");
      fetchedAt = nowTs();
      hint = "Hava: Open-Meteo";
    } catch (e){
      console.warn("Open-Meteo failed:", e);
      // Sessizce cache göster
      const cached = state?.weatherCache?.payload || null;
      if (cached){
        setWeatherUI(cached, "Hava güncellenemedi, son veri gösteriliyor.");
        updateLastWeatherLine();
      } else {
        setWeatherUI(null, "Hava alınamadı.");
      }
      return;
    }
  }

  // Başarılı: cache yaz
  state.weatherCache = { fetchedAt, payload: normalized };
  saveState(state);

  setWeatherUI(normalized, hint);
  updateLastWeatherLine();
}

function openMeteoUrl(){
  const params = new URLSearchParams({
    latitude: String(IZMIR.lat),
    longitude: String(IZMIR.lon),
    daily: "weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max",
    timezone: IZMIR.tz
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

// ---------- Day rollover / auto-clear ----------
function maybeRollover(){
  const tISO = todayISO(new Date());

  // Eğer gün değiştiyse: today -> archive mantığı yok; sadece date'leri güncelle
  if (state.today.date !== tISO){
    normalizeTodayData(state);
    // "tomorrow"u bugüne taşı
    const newToday = {
      date: tISO,
      schedule: (state.tomorrow?.schedule || []).map(x => ({...x, done:false})),
      notes: {
        ruzgar: state.today.notes?.ruzgar || "",
        bulut: state.today.notes?.bulut || ""
      },
      checklists: {
        ruzgar: (state.today.checklists?.ruzgar || []).map(x => ({...x, done:false})),
        bulut: (state.today.checklists?.bulut || []).map(x => ({...x, done:false}))
      }
    };

    // yeni yarın
    const newTomorrow = {
      date: shiftISO(tISO, 1),
      schedule: []
    };

    state.today = newToday;
    state.tomorrow = newTomorrow;
    saveState(state);
  }

  // gece otomatik temizleme: 03:00 civarı done temizle (basit)
  if (state.settings.autoClearDoneAtNight){
    const hr = new Date().getHours();
    if (hr === 3){
      // yalnızca bir kez çalıştırmak için: bu saat içinde bir flag atabiliriz (basit tutuldu)
      clearDoneInToday();
    }
  }
}

function clearDoneInToday(){
  state.today.schedule = (state.today.schedule || []).filter(it => !it.done);
  saveState(state);
  renderAll();
}

// ---------- UI render ----------
function renderAll(){
  normalizeTodayData(state);
  applyTheme();
  renderClock();
  renderNet();
  updateLastWeatherLine();

  renderScheduleList(todayList, state.today.schedule, (id) => {
    toggleTodayDone(id);
  });

  renderMiniList(tomorrowList, state.tomorrow.schedule);

  ruzgarNotesBox.textContent = state.today.notes?.ruzgar || "—";
  bulutNotesBox.textContent = state.today.notes?.bulut || "—";

  renderChecklist(ruzgarExitList, state.today.checklists?.ruzgar, (id) => {
    toggleExitDone("ruzgar", id);
  });
  renderChecklist(bulutExitList, state.today.checklists?.bulut, (id) => {
    toggleExitDone("bulut", id);
  });
  renderGoodLuckBanner();

  autoClearToggle.checked = !!state.settings.autoClearDoneAtNight;
  pixelShiftToggle.checked = !!state.settings.pixelShift;

  modeChip.textContent = state.settings.theme === "light" ? "Aydınlık" : "Karanlık";
}

function toggleTodayDone(id){
  const it = (state.today.schedule || []).find(x => x.id === id);
  if (!it) return;
  it.done = !it.done;
  saveState(state);
  renderAll();
}

function toggleExitDone(group, id){
  normalizeTodayData(state);
  const list = state.today.checklists?.[group] || [];
  const it = list.find(x => x.id === id);
  if (!it) return;
  it.done = !it.done;
  saveState(state);
  renderAll();
}

function renderGoodLuckBanner(){
  const allItems = [
    ...(state.today.checklists?.ruzgar || []),
    ...(state.today.checklists?.bulut || [])
  ];
  const doneAll = allItems.length > 0 && allItems.every((it) => !!it.done);
  goodLuckBanner.hidden = !doneAll;
}

// ---------- Theme / Pixel shift ----------
function applyTheme(){
  const theme = state?.settings?.theme || "dark";
  document.documentElement.setAttribute("data-theme", theme);
}

function toggleTheme(){
  state.settings.theme = (state.settings.theme === "light") ? "dark" : "light";
  saveState(state);
  renderAll();
}

let pixelShiftTimer = null;
let pixelShiftPhase = 0;
let isModalOpen = false;

function applyPixelShiftEnabled(enabled){
  const canShift = enabled && !isModalOpen;
  if (pixelShiftTimer) {
    clearInterval(pixelShiftTimer);
    pixelShiftTimer = null;
  }
  if (!canShift) {
    pixelShiftWrap.style.transform = "translate(0px,0px)";
    return;
  }

  pixelShiftTimer = setInterval(() => {
    // 1-2px hafif kaydırma
    pixelShiftPhase = (pixelShiftPhase + 1) % 4;
    const dx = (pixelShiftPhase % 2 === 0) ? 1 : -1;
    const dy = (pixelShiftPhase < 2) ? 1 : -1;
    pixelShiftWrap.style.transform = `translate(${dx}px, ${dy}px)`;
  }, PIXEL_SHIFT_MS);
}

// ---------- Modal ----------
function ensureModalTopLayer(){
  // iOS Safari'de fixed modal, transform'lu bir wrapper ile aynı stacking ortamına
  // girdiğinde touch hedeflemesi bozulabiliyor. Bu nedenle backdrop'u doğrudan body'de tutuyoruz.
  if (modalBackdrop && modalBackdrop.parentElement !== document.body){
    document.body.appendChild(modalBackdrop);
  }
}

function setModalOpen(nextOpen){
  isModalOpen = !!nextOpen;
  document.body.classList.toggle("modal-open", isModalOpen);
  applyPixelShiftEnabled(!!state.settings.pixelShift);
}

function openModal(){
  normalizeTodayData(state);
  endpointInput.value = state.settings.weatherEndpoint || "";
  departureTimeInput.value = state.settings.departureTime || DEFAULT_DEPARTURE_TIME;
  ruzgarNotesInput.value = state.today.notes?.ruzgar || "";
  bulutNotesInput.value = state.today.notes?.bulut || "";
  pixelShiftToggle.checked = !!state.settings.pixelShift;

  renderEditLists();

  modalBackdrop.hidden = false;
  setModalOpen(true);
  // Fokus
  setTimeout(() => endpointInput.focus(), 50);
}

function closeModal(){
  modalBackdrop.hidden = true;
  setModalOpen(false);
  importActions.hidden = true;
  importHint.textContent = "";
  importStaged = null;
}

function renderEditLists(){
  normalizeTodayData(state);
  // Today editor list
  editTodayList.innerHTML = "";
  for (const it of (state.today.schedule || []).slice(0, 20)){
    editTodayList.appendChild(makeEditRow(it, "today"));
  }

  // Tomorrow editor list
  editTomList.innerHTML = "";
  for (const it of (state.tomorrow.schedule || []).slice(0, 20)){
    editTomList.appendChild(makeEditRow(it, "tomorrow"));
  }

  // Exit checklist editors
  editRuzgarExitList.innerHTML = "";
  for (const it of (state.today.checklists?.ruzgar || []).slice(0, 30)){
    editRuzgarExitList.appendChild(makeEditRow(it, "exit-ruzgar"));
  }
  editBulutExitList.innerHTML = "";
  for (const it of (state.today.checklists?.bulut || []).slice(0, 30)){
    editBulutExitList.appendChild(makeEditRow(it, "exit-bulut"));
  }
}

function makeEditRow(item, kind){
  const li = document.createElement("li");
  li.className = "editItem";

  const time = document.createElement("input");
  time.type = "text";
  time.placeholder = "Saat";
  time.value = item.time || "";
  time.disabled = kind.startsWith("exit");
  time.addEventListener("input", () => {
    item.time = time.value;
  });

  const text = document.createElement("input");
  text.type = "text";
  text.placeholder = "Metin";
  text.value = item.text || "";
  text.addEventListener("input", () => {
    item.text = text.value;
  });

  const del = document.createElement("button");
  del.type = "button";
  del.className = "delBtn";
  del.textContent = "Sil";
  del.addEventListener("click", () => {
    if (kind === "today"){
      state.today.schedule = (state.today.schedule || []).filter(x => x.id !== item.id);
    } else if (kind === "tomorrow"){
      state.tomorrow.schedule = (state.tomorrow.schedule || []).filter(x => x.id !== item.id);
    } else if (kind === "exit-ruzgar"){
      state.today.checklists.ruzgar = (state.today.checklists.ruzgar || []).filter(x => x.id !== item.id);
    } else {
      state.today.checklists.bulut = (state.today.checklists.bulut || []).filter(x => x.id !== item.id);
    }
    saveState(state);
    renderEditLists();
    renderAll();
  });

  li.appendChild(time);
  li.appendChild(text);
  li.appendChild(del);
  return li;
}

function addTodayItem(){
  const text = (todayTextInput.value || "").trim();
  if (!text) return;
  const time = normalizeTime(todayTimeInput.value);

  state.today.schedule = state.today.schedule || [];
  if (state.today.schedule.length >= 8){
    // max 8 (UI)
    state.today.schedule = state.today.schedule.slice(0, 7);
  }
  state.today.schedule.push({ id: uid(), time, text, done:false });

  todayTextInput.value = "";
  todayTimeInput.value = "";
  saveState(state);
  renderEditLists();
  renderAll();
}

function addTomorrowItem(){
  const text = (tomTextInput.value || "").trim();
  if (!text) return;
  const time = normalizeTime(tomTimeInput.value);

  state.tomorrow.schedule = state.tomorrow.schedule || [];
  if (state.tomorrow.schedule.length >= 3){
    // max 3
    state.tomorrow.schedule = state.tomorrow.schedule.slice(0, 2);
  }
  state.tomorrow.schedule.push({ id: uid(), time, text, done:false });

  tomTextInput.value = "";
  tomTimeInput.value = "";
  saveState(state);
  renderEditLists();
  renderAll();
}

function addExitItem(group){
  const isRuzgar = group === "ruzgar";
  const input = isRuzgar ? newRuzgarCheckItemInput : newBulutCheckItemInput;
  const text = (input.value || "").trim();
  if (!text) return;

  normalizeTodayData(state);
  state.today.checklists[group].push({ id: uid(), text, done:false });

  input.value = "";
  saveState(state);
  renderEditLists();
  renderAll();
}

function normalizeTime(v){
  // "0930" -> "09:30", "9:3" -> "09:03"
  const s = (v || "").trim();
  if (!s) return "";
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length === 4){
    return `${digits.slice(0,2)}:${digits.slice(2,4)}`;
  }
  if (s.includes(":")){
    const [h,m] = s.split(":");
    if (h != null && m != null){
      return `${pad2(Number(h))}:${pad2(Number(m))}`;
    }
  }
  return s;
}

function normalizeDepartureTime(v){
  const t = normalizeTime(v);
  if (!/^\d{2}:\d{2}$/.test(t)) return DEFAULT_DEPARTURE_TIME;
  const [h, m] = t.split(":").map(Number);
  return `${pad2(clamp(h, 0, 23))}:${pad2(clamp(m, 0, 59))}`;
}

function saveFromModal(){
  normalizeTodayData(state);
  const endpoint = (endpointInput.value || "").trim();
  state.settings.weatherEndpoint = endpoint;
  writeStorage(ENDPOINT_STORAGE_KEY, endpoint);

  state.settings.pixelShift = !!pixelShiftToggle.checked;
  state.settings.departureTime = normalizeDepartureTime(departureTimeInput.value);
  state.today.notes.ruzgar = ruzgarNotesInput.value || "";
  state.today.notes.bulut = bulutNotesInput.value || "";

  saveState(state);
  renderAll();
  applyPixelShiftEnabled(state.settings.pixelShift);

  // hava endpoint değiştiyse hemen dene
  fetchWeather().catch(()=>{});
  closeModal();
}

// ---------- Backup Import/Export ----------
function exportData(){
  const data = loadState(); // en güncel
  downloadJson("doorboard-backup.json", data);
}

function validateImported(obj){
  // Çok sıkı olmayan doğrulama: temel alanlar var mı?
  if (!obj || typeof obj !== "object") return { ok:false, msg:"JSON nesnesi değil." };
  if (!obj.settings || !obj.today || !obj.tomorrow) return { ok:false, msg:"Zorunlu alanlar eksik (settings/today/tomorrow)." };
  if (typeof obj.today.date !== "string") return { ok:false, msg:"today.date geçersiz." };
  const hasLegacyChecklist = Array.isArray(obj?.today?.checklist);
  const hasGroupedChecklist =
    obj?.today?.checklists &&
    typeof obj.today.checklists === "object" &&
    Array.isArray(obj.today.checklists.ruzgar) &&
    Array.isArray(obj.today.checklists.bulut);
  if (!Array.isArray(obj.today.schedule) || (!hasLegacyChecklist && !hasGroupedChecklist)){
    return { ok:false, msg:"today.schedule ve checklist/checklists alanlari gecersiz." };
  }
  return { ok:true, msg:"OK" };
}

function stageImport(file){
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    const obj = safeJsonParse(text);
    const v = validateImported(obj);
    if (!v.ok){
      importHint.textContent = `İçe aktarma hatası: ${v.msg}`;
      importActions.hidden = true;
      importStaged = null;
      return;
    }
    importStaged = obj;
    importHint.textContent = "Dosya doğrulandı.";
    importActions.hidden = false;
  };
  reader.onerror = () => {
    importHint.textContent = "Dosya okunamadı.";
    importActions.hidden = true;
    importStaged = null;
  };
  reader.readAsText(file);
}

function doImport(mode){
  if (!importStaged) return;

  if (mode === "overwrite"){
    state = importStaged;
  } else if (mode === "merge"){
    // defaultState + currentState + importStaged (import kazanır)
    const base = defaultState();
    const cur = loadState();
    state = mergeDeep(mergeDeep(base, cur), importStaged);
  }

  // ids olmayan elemanlara id ver
  ensureIds(state);
  state.settings.departureTime = normalizeDepartureTime(state?.settings?.departureTime || DEFAULT_DEPARTURE_TIME);

  saveState(state);

  // endpoint mirror
  try {
    if (state?.settings?.weatherEndpoint != null){
      writeStorage(ENDPOINT_STORAGE_KEY, state.settings.weatherEndpoint);
    }
  } catch {}

  renderAll();
  applyPixelShiftEnabled(!!state.settings.pixelShift);
  fetchWeather().catch(()=>{});
  importHint.textContent = "İçe aktarma tamamlandı.";
  importActions.hidden = true;
  importStaged = null;
}

function ensureIds(s){
  normalizeTodayData(s);
  const fixArr = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const it of arr){
      if (!it.id) it.id = uid();
      if (it.done == null) it.done = false;
      if (typeof it.text !== "string") it.text = String(it.text ?? "");
      if (typeof it.time !== "string") it.time = String(it.time ?? "");
    }
  };
  fixArr(s?.today?.schedule);
  fixArr(s?.tomorrow?.schedule);
  fixArr(s?.today?.checklists?.ruzgar);
  fixArr(s?.today?.checklists?.bulut);
}

// ---------- Buttons ----------
editBtn.addEventListener("click", openModal);
closeModalBtn.addEventListener("click", closeModal);
cancelBtn.addEventListener("click", closeModal);
saveBtn.addEventListener("click", saveFromModal);
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop){
    closeModal();
  }
});

addTodayBtn.addEventListener("click", addTodayItem);
addTomBtn.addEventListener("click", addTomorrowItem);
addRuzgarCheckItemBtn.addEventListener("click", () => addExitItem("ruzgar"));
addBulutCheckItemBtn.addEventListener("click", () => addExitItem("bulut"));

todayTextInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addTodayItem(); });
tomTextInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addTomorrowItem(); });
newRuzgarCheckItemInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addExitItem("ruzgar"); });
newBulutCheckItemInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addExitItem("bulut"); });

exportBtn.addEventListener("click", exportData);
importFile.addEventListener("change", (e) => stageImport(e.target.files?.[0]));

importOverwriteBtn.addEventListener("click", () => doImport("overwrite"));
importMergeBtn.addEventListener("click", () => doImport("merge"));
importCancelBtn.addEventListener("click", () => {
  importActions.hidden = true;
  importHint.textContent = "İçe aktarma iptal edildi.";
  importStaged = null;
});

clearDoneBtn.addEventListener("click", () => {
  clearDoneInToday();
});

autoClearToggle.addEventListener("change", () => {
  state.settings.autoClearDoneAtNight = !!autoClearToggle.checked;
  saveState(state);
});

resetChecklistBtn.addEventListener("click", () => {
  normalizeTodayData(state);
  for (const it of (state.today.checklists?.ruzgar || [])) it.done = false;
  for (const it of (state.today.checklists?.bulut || [])) it.done = false;
  saveState(state);
  renderAll();
});

themeToggleBtn.addEventListener("click", toggleTheme);

// Modal ESC close
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalBackdrop.hidden){
    closeModal();
  }
});

// Online/offline events
window.addEventListener("online", () => { renderNet(); fetchWeather().catch(()=>{}); });
window.addEventListener("offline", () => { renderNet(); fetchWeather().catch(()=>{}); });

// ---------- Init ----------
function init(){
  storagePersistent = isPersistentStorageAvailable();
  if (!storagePersistent && runtimeWarningEl){
    runtimeWarningEl.hidden = false;
    runtimeWarningEl.textContent = "Uyari: localStorage kapali. Veriler sadece bu oturumda tutulur.";
  }

  ensureModalTopLayer();

  // Gün değişimi kontrolü
  maybeRollover();

  // İlk render
  renderAll();

  // Weather: önce cache göster, sonra fetch
  if (state?.weatherCache?.payload){
    setWeatherUI(state.weatherCache.payload, isOnline() ? "Son kayıt (yenileniyor…)" : "Offline: son kayıt");
  } else {
    setWeatherUI(null, isOnline() ? "Hava alınıyor…" : "Offline");
  }
  updateLastWeatherLine();

  // Timers
  setInterval(() => {
    renderClock();
    renderNet();
    // nadiren rollover kontrol
    if (new Date().getMinutes() % 5 === 0 && new Date().getSeconds() === 0){
      maybeRollover();
    }
  }, CLOCK_TICK_MS);

  // Weather refresh
  fetchWeather().catch(()=>{});
  setInterval(() => {
    // online ise yenile
    if (isOnline()) fetchWeather().catch(()=>{});
  }, WEATHER_REFRESH_MS);

  // Pixel shift
  applyPixelShiftEnabled(!!state.settings.pixelShift);

  // Service Worker (opsiyonel; GitHub Pages üzerinde çalışır, file:// altında çalışmayabilir)
  tryRegisterSW();
}

function tryRegisterSW(){
  if (!("serviceWorker" in navigator)) return;

  // file:// altında genelde service worker kayıt olmaz; hata yut.
  navigator.serviceWorker.register("./sw.js").catch((e) => {
    console.info("SW register skipped/failed:", e?.message || e);
  });
}

// ---------- Minimal SW file injection (no extra file requested) ----------
/**
 * İstenilen dosyalar listesinde sw.js yok ama offline deneyimini iyileştirmek için
 * runtime'da oluşturamayız. Yine de register çağrısı var; eğer kullanıcı sw.js eklerse devreye girer.
 * (README'de not var.)
 */

init();
