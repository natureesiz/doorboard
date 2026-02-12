/**
 * Doorboard (static, iOS 12.5.8 compatible)
 * - Single storage key: doorboard.v1
 * - No optional chaining / no nullish / no arrow functions
 * - Modal touch-safe for iPad Safari
 */

var STORAGE_KEY = "doorboard.v1";
var ENDPOINT_STORAGE_KEY = "doorboard.weatherEndpoint";

var WEATHER_ENDPOINT_FALLBACK = "https://YOUR_WORKER_DOMAIN/weather.json";
var WEATHER_REFRESH_MS = 30 * 60 * 1000;
var CLOCK_TICK_MS = 1000;
var PIXEL_SHIFT_MS = 2 * 60 * 1000;
var FETCH_TIMEOUT_MS = 8000;
var DEFAULT_LEAVE_TIME = "07:35";
var DEFAULT_BEFORE_MIN = 10;
var DEFAULT_AFTER_MIN = 10;

var DEFAULT_KID_ITEMS = [
  "Anahtar",
  "Cüzdan",
  "Telefon",
  "Kart",
  "Şarj",
  "Kulaklık"
];

var IZMIR = { lat: 38.4237, lon: 27.1428, tz: "Europe/Istanbul" };

var memoryStorage = {};
var storageWarningShown = false;
var importStaged = null;
var pixelShiftTimer = null;
var pixelShiftPhase = 0;
var isModalOpen = false;
var lastLeaveDeltaText = "";
var lastFullscreenSecond = null;
var wallpaperLoadToken = 0;
var lastInteractionTimestamp = Date.now();
var dashboardReturningUntil = 0;
var audioCtx = null;
var audioUnlocked = false;
var lastCountdownSoundSecond = null;
var lastCountdownSoundTargetKey = "";
var soundHintShown = false;
var screenSaverMinuteStamp = "";
var screenSaverShiftIndex = 0;
var screenSaverOffsets = [
  { x: 0, y: 0 },
  { x: 10, y: 4 },
  { x: -10, y: 6 },
  { x: 8, y: -6 },
  { x: -8, y: -4 }
];

function warnStorageFallback(err){
  if (storageWarningShown) return;
  storageWarningShown = true;
  try { console.warn("Storage unavailable, using in-memory fallback.", err); } catch(e) {}
}

function readStorage(key){
  try {
    return localStorage.getItem(key);
  } catch(err){
    warnStorageFallback(err);
    return memoryStorage.hasOwnProperty(key) ? memoryStorage[key] : null;
  }
}

function writeStorage(key, value){
  try {
    localStorage.setItem(key, value);
    return true;
  } catch(err){
    warnStorageFallback(err);
    memoryStorage[key] = String(value);
    return false;
  }
}

function isPersistentStorageAvailable(){
  var probe = "__doorboard_probe__";
  try {
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch(err){
    warnStorageFallback(err);
    return false;
  }
}

function $(sel){
  return document.querySelector(sel);
}

function pad2(n){
  var s = String(Math.floor(Math.abs(n)));
  return s.length < 2 ? "0" + s : s;
}

function todayISO(date){
  var d = date || new Date();
  var y = d.getFullYear();
  var m = pad2(d.getMonth() + 1);
  var day = pad2(d.getDate());
  return y + "-" + m + "-" + day;
}

function shiftISO(iso, days){
  var p = String(iso || "").split("-");
  if (p.length !== 3) return todayISO(new Date());
  var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  dt.setDate(dt.getDate() + Number(days || 0));
  return todayISO(dt);
}

function safeJsonParse(txt){
  try { return JSON.parse(txt); } catch(e){ return null; }
}

function deepClone(obj){
  try { return JSON.parse(JSON.stringify(obj)); } catch(e){ return obj; }
}

function uid(){
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

function escapeHtml(str){
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clamp(n, min, max){
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function isOnline(){
  return navigator.onLine === true;
}

function fmtTimeHM(date){
  var d = date || new Date();
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function fmtTurkishDateLine(date){
  var d = date || new Date();
  var days = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
  var months = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
  return d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear() + " " + days[d.getDay()];
}

function normalizeTime(raw){
  var s = String(raw || "").trim();
  if (!s) return "";
  var digits = s.replace(/[^\d]/g, "");
  if (digits.length === 4){
    return digits.slice(0,2) + ":" + digits.slice(2,4);
  }
  if (s.indexOf(":") > -1){
    var p = s.split(":");
    if (p.length >= 2){
      var hh = clamp(Number(p[0]) || 0, 0, 23);
      var mm = clamp(Number(p[1]) || 0, 0, 59);
      return pad2(hh) + ":" + pad2(mm);
    }
  }
  return s;
}

function normalizeLeaveTime(raw){
  var t = normalizeTime(raw);
  if (!/^\d{2}:\d{2}$/.test(t)) return DEFAULT_LEAVE_TIME;
  var p = t.split(":");
  var hh = clamp(Number(p[0]) || 0, 0, 23);
  var mm = clamp(Number(p[1]) || 0, 0, 59);
  return pad2(hh) + ":" + pad2(mm);
}

function buildDefaultKidChecklist(){
  var out = [];
  var i;
  for (i = 0; i < DEFAULT_KID_ITEMS.length; i++){
    out.push({ id: uid(), text: DEFAULT_KID_ITEMS[i], done: false });
  }
  return out;
}

function buildDefaultExitItems(){
  var items = [];
  var i;
  for (i = 0; i < DEFAULT_KID_ITEMS.length; i++){
    items.push({ id: uid(), text: DEFAULT_KID_ITEMS[i] });
  }
  return items;
}

function createDoneMapFromItems(items){
  var m = {};
  var i;
  for (i = 0; i < items.length; i++) m[items[i].id] = false;
  return m;
}

function defaultState(){
  var tISO = todayISO(new Date());
  var endpoint = readStorage(ENDPOINT_STORAGE_KEY) || WEATHER_ENDPOINT_FALLBACK;
  var defaultExitItems = buildDefaultExitItems();
  return {
    settings: {
      weatherEndpoint: endpoint,
      autoClearDoneAtNight: true,
      theme: "dark",
      pixelShift: false,
      soundEnabled: true,
      screenSaverEnabled: true,
      screenSaverTimeoutMinutes: 10
    },
    leaveTimeSettings: {
      leaveTime: DEFAULT_LEAVE_TIME,
      beforeMinutes: DEFAULT_BEFORE_MIN,
      afterMinutes: DEFAULT_AFTER_MIN,
      enableLateMode: true
    },
    notes: {
      lastResetDate: tISO,
      items: []
    },
    persistentNotes: "",
    exitChecklist: {
      lastResetDate: tISO,
      items: defaultExitItems,
      bulutDone: createDoneMapFromItems(defaultExitItems),
      ruzgarDone: createDoneMapFromItems(defaultExitItems)
    },
    kids: {
      ruzgar: buildDefaultKidChecklist(),
      bulut: buildDefaultKidChecklist()
    },
    screenSaverMode: false,
    today: {
      date: tISO,
      schedule: [
        { id: uid(), time: "09:30", text: "Okul", done: false },
        { id: uid(), time: "18:00", text: "Market", done: false },
        { id: uid(), time: "", text: "Kargoyu kontrol et", done: false }
      ]
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
      payload: null
    }
  };
}

function mergeDeep(target, source){
  var out = deepClone(target);
  if (!source || typeof source !== "object") return out;
  var keys = Object.keys(source);
  var i;
  for (i = 0; i < keys.length; i++){
    var k = keys[i];
    var sv = source[k];
    var tv = out[k];
    if (Object.prototype.toString.call(sv) === "[object Array]"){
      out[k] = sv;
    } else if (sv && typeof sv === "object" && tv && typeof tv === "object" && Object.prototype.toString.call(tv) !== "[object Array]"){
      out[k] = mergeDeep(tv, sv);
    } else {
      out[k] = sv;
    }
  }
  return out;
}

function migrateStateSchema(target, source){
  if (!target || !source || typeof source !== "object") return;

  if (source.settings && source.settings.departureTime && !(source.leaveTimeSettings && source.leaveTimeSettings.leaveTime)){
    target.leaveTimeSettings.leaveTime = source.settings.departureTime;
  }

  if (typeof source.persistentNotes !== "string"){
    if (source.today && typeof source.today.notes === "string"){
      target.persistentNotes = source.today.notes;
    } else if (source.today && source.today.notes && typeof source.today.notes === "object"){
      var t1 = source.today.notes.ruzgar || "";
      var t2 = source.today.notes.bulut || "";
      target.persistentNotes = (t1 + "\n" + t2).replace(/^\n+|\n+$/g, "");
    }
  }

  var legacyChecklist = (source.today && source.today.checklist && Object.prototype.toString.call(source.today.checklist) === "[object Array]") ? source.today.checklist : [];
  var legacyGrouped = source.today && source.today.checklists ? source.today.checklists : null;

  if (!source.ruzgarChecklist || Object.prototype.toString.call(source.ruzgarChecklist) !== "[object Array]"){
    if (legacyGrouped && Object.prototype.toString.call(legacyGrouped.ruzgar) === "[object Array]"){
      target.ruzgarChecklist = legacyGrouped.ruzgar;
    } else if (legacyChecklist.length){
      target.ruzgarChecklist = legacyChecklist;
    }
  }

  if (!source.bulutChecklist || Object.prototype.toString.call(source.bulutChecklist) !== "[object Array]"){
    if (legacyGrouped && Object.prototype.toString.call(legacyGrouped.bulut) === "[object Array]"){
      target.bulutChecklist = legacyGrouped.bulut;
    }
  }

  if (!source.kids || typeof source.kids !== "object"){
    target.kids = {
      ruzgar: (source.ruzgarChecklist && Object.prototype.toString.call(source.ruzgarChecklist) === "[object Array]") ? source.ruzgarChecklist : (target.ruzgarChecklist || []),
      bulut: (source.bulutChecklist && Object.prototype.toString.call(source.bulutChecklist) === "[object Array]") ? source.bulutChecklist : (target.bulutChecklist || [])
    };
  }

  if (!source.exitChecklist || typeof source.exitChecklist !== "object"){
    var legacyR = [];
    var legacyB = [];
    var i;
    var itemByText = {};
    var items = [];
    var bulutDone = {};
    var ruzgarDone = {};

    if (source.kids && source.kids.ruzgar && Object.prototype.toString.call(source.kids.ruzgar) === "[object Array]"){
      legacyR = source.kids.ruzgar;
    } else if (source.ruzgarChecklist && Object.prototype.toString.call(source.ruzgarChecklist) === "[object Array]"){
      legacyR = source.ruzgarChecklist;
    }
    if (source.kids && source.kids.bulut && Object.prototype.toString.call(source.kids.bulut) === "[object Array]"){
      legacyB = source.kids.bulut;
    } else if (source.bulutChecklist && Object.prototype.toString.call(source.bulutChecklist) === "[object Array]"){
      legacyB = source.bulutChecklist;
    }

    function attachLegacy(arr){
      var j;
      for (j = 0; j < arr.length; j++){
        var it = arr[j];
        var rawText = "";
        if (typeof it === "string") rawText = it;
        else if (it && typeof it === "object") rawText = String(it.text == null ? "" : it.text);
        var text = String(rawText || "").replace(/^\s+|\s+$/g, "");
        var key;
        if (!text) continue;
        key = text.toLowerCase();
        if (!itemByText[key]){
          itemByText[key] = { id: uid(), text: text };
          items.push(itemByText[key]);
        }
      }
    }

    attachLegacy(legacyB);
    attachLegacy(legacyR);
    if (!items.length){
      items = buildDefaultExitItems();
      for (i = 0; i < items.length; i++) itemByText[items[i].text.toLowerCase()] = items[i];
    }

    for (i = 0; i < items.length; i++){
      bulutDone[items[i].id] = false;
      ruzgarDone[items[i].id] = false;
    }

    for (i = 0; i < legacyB.length; i++){
      var b = legacyB[i];
      var bText = (typeof b === "string") ? b : (b && typeof b === "object" ? String(b.text == null ? "" : b.text) : "");
      var bKey = String(bText || "").replace(/^\s+|\s+$/g, "").toLowerCase();
      var bItem = itemByText[bKey];
      if (bItem && b && typeof b === "object" && b.done) bulutDone[bItem.id] = true;
    }

    for (i = 0; i < legacyR.length; i++){
      var r = legacyR[i];
      var rText = (typeof r === "string") ? r : (r && typeof r === "object" ? String(r.text == null ? "" : r.text) : "");
      var rKey = String(rText || "").replace(/^\s+|\s+$/g, "").toLowerCase();
      var rItem = itemByText[rKey];
      if (rItem && r && typeof r === "object" && r.done) ruzgarDone[rItem.id] = true;
    }

    target.exitChecklist = {
      lastResetDate: source.exitChecklist && source.exitChecklist.lastResetDate ? source.exitChecklist.lastResetDate : (source.today && source.today.date ? source.today.date : todayISO(new Date())),
      items: items,
      bulutDone: bulutDone,
      ruzgarDone: ruzgarDone
    };
  }

  if (!source.notes || typeof source.notes !== "object"){
    var noteItems = [];
    var notesRaw = "";
    var k;
    if (typeof source.persistentNotes === "string" && source.persistentNotes.replace(/\s/g, "")){
      notesRaw = source.persistentNotes;
    } else if (source.today && typeof source.today.notes === "string"){
      notesRaw = source.today.notes;
    } else if (source.today && source.today.notes && typeof source.today.notes === "object"){
      notesRaw = (source.today.notes.ruzgar || "") + "\n" + (source.today.notes.bulut || "");
    }
    if (notesRaw){
      var lines = String(notesRaw).split(/\r?\n/);
      for (k = 0; k < lines.length; k++){
        var line = String(lines[k] || "").replace(/^\s+|\s+$/g, "");
        if (line) noteItems.push({ id: uid(), text: line, done: false });
      }
    }
    target.notes = {
      lastResetDate: todayISO(new Date()),
      items: noteItems
    };
  }
}

function normalizeItemArray(arr, allowTime){
  var out = [];
  var i;
  if (!arr || Object.prototype.toString.call(arr) !== "[object Array]") return out;
  for (i = 0; i < arr.length; i++){
    var raw = arr[i];
    if (raw && typeof raw === "object" && Object.prototype.toString.call(raw) !== "[object Array]"){
      out.push({
        id: raw.id ? String(raw.id) : uid(),
        text: String(raw.text == null ? "" : raw.text),
        done: !!raw.done,
        time: allowTime ? String(raw.time == null ? "" : raw.time) : ""
      });
    } else if (typeof raw === "string"){
      out.push({ id: uid(), text: raw, done: false, time: allowTime ? "" : "" });
    }
  }
  return out;
}

function normalizeExitItems(items){
  var out = [];
  var i;
  if (!items || Object.prototype.toString.call(items) !== "[object Array]") return out;
  for (i = 0; i < items.length; i++){
    var raw = items[i];
    var text = "";
    var id = "";
    if (typeof raw === "string"){
      text = String(raw).replace(/^\s+|\s+$/g, "");
      id = uid();
    } else if (raw && typeof raw === "object"){
      text = String(raw.text == null ? "" : raw.text).replace(/^\s+|\s+$/g, "");
      id = raw.id ? String(raw.id) : uid();
    }
    if (text){
      out.push({ id: id, text: text });
    }
  }
  return out;
}

function normalizeNotesItems(items){
  var out = [];
  var i;
  if (!items || Object.prototype.toString.call(items) !== "[object Array]") return out;
  for (i = 0; i < items.length; i++){
    var raw = items[i];
    var text = "";
    var id = "";
    var done = false;
    if (typeof raw === "string"){
      text = String(raw).replace(/^\s+|\s+$/g, "");
      id = uid();
    } else if (raw && typeof raw === "object"){
      text = String(raw.text == null ? "" : raw.text).replace(/^\s+|\s+$/g, "");
      id = raw.id ? String(raw.id) : uid();
      done = !!raw.done;
    }
    if (text){
      out.push({ id: id, text: text, done: done });
    }
  }
  return out;
}

function normalizeDoneMap(map, items){
  var out = {};
  var i;
  if (map && typeof map === "object"){
    for (i = 0; i < items.length; i++){
      var id = items[i].id;
      out[id] = !!map[id];
    }
    return out;
  }
  for (i = 0; i < items.length; i++) out[items[i].id] = false;
  return out;
}

function normalizeState(s){
  if (!s || typeof s !== "object") return;
  if (!s.settings || typeof s.settings !== "object") s.settings = {};
  if (!s.today || typeof s.today !== "object") s.today = { date: todayISO(new Date()), schedule: [] };
  if (!s.tomorrow || typeof s.tomorrow !== "object") s.tomorrow = { date: shiftISO(todayISO(new Date()), 1), schedule: [] };
  if (!s.weatherCache || typeof s.weatherCache !== "object") s.weatherCache = { fetchedAt: 0, payload: null };

  if (typeof s.settings.weatherEndpoint !== "string") s.settings.weatherEndpoint = readStorage(ENDPOINT_STORAGE_KEY) || WEATHER_ENDPOINT_FALLBACK;
  s.settings.autoClearDoneAtNight = s.settings.autoClearDoneAtNight !== false;
  s.settings.theme = (s.settings.theme === "light") ? "light" : "dark";
  s.settings.pixelShift = !!s.settings.pixelShift;
  if (typeof s.settings.soundEnabled !== "boolean") s.settings.soundEnabled = true;
  s.settings.soundEnabled = !!s.settings.soundEnabled;
  if (typeof s.settings.screenSaverEnabled !== "boolean"){
    if (typeof s.settings.clockOnlyEnabled === "boolean") s.settings.screenSaverEnabled = !!s.settings.clockOnlyEnabled;
    else s.settings.screenSaverEnabled = true;
  }
  s.settings.screenSaverEnabled = !!s.settings.screenSaverEnabled;
  if (!s.settings.screenSaverTimeoutMinutes){
    s.settings.screenSaverTimeoutMinutes = s.settings.idleTimeoutMinutes;
  }
  s.settings.screenSaverTimeoutMinutes = clamp(Number(s.settings.screenSaverTimeoutMinutes) || 10, 1, 240);

  if (!s.leaveTimeSettings || typeof s.leaveTimeSettings !== "object"){
    s.leaveTimeSettings = {
      leaveTime: DEFAULT_LEAVE_TIME,
      beforeMinutes: DEFAULT_BEFORE_MIN,
      afterMinutes: DEFAULT_AFTER_MIN,
      enableLateMode: true
    };
  }
  s.leaveTimeSettings.leaveTime = normalizeLeaveTime(s.leaveTimeSettings.leaveTime || DEFAULT_LEAVE_TIME);
  s.leaveTimeSettings.beforeMinutes = clamp(Number(s.leaveTimeSettings.beforeMinutes) || DEFAULT_BEFORE_MIN, 0, 240);
  s.leaveTimeSettings.afterMinutes = clamp(Number(s.leaveTimeSettings.afterMinutes) || DEFAULT_AFTER_MIN, 0, 240);
  s.leaveTimeSettings.enableLateMode = s.leaveTimeSettings.enableLateMode !== false;

  s.persistentNotes = String(s.persistentNotes == null ? "" : s.persistentNotes);

  if (!s.notes || typeof s.notes !== "object") s.notes = {};
  s.notes.lastResetDate = String(s.notes.lastResetDate || todayISO(new Date()));
  s.notes.items = normalizeNotesItems(s.notes.items);

  if (!s.exitChecklist || typeof s.exitChecklist !== "object") s.exitChecklist = {};
  s.exitChecklist.items = normalizeExitItems(s.exitChecklist.items);
  if (!s.exitChecklist.items.length) s.exitChecklist.items = buildDefaultExitItems();
  s.exitChecklist.lastResetDate = String(s.exitChecklist.lastResetDate || todayISO(new Date()));
  s.exitChecklist.bulutDone = normalizeDoneMap(s.exitChecklist.bulutDone, s.exitChecklist.items);
  s.exitChecklist.ruzgarDone = normalizeDoneMap(s.exitChecklist.ruzgarDone, s.exitChecklist.items);

  if (!s.kids || typeof s.kids !== "object") s.kids = {};
  if (!s.kids.ruzgar || Object.prototype.toString.call(s.kids.ruzgar) !== "[object Array]"){
    s.kids.ruzgar = (s.ruzgarChecklist && Object.prototype.toString.call(s.ruzgarChecklist) === "[object Array]") ? s.ruzgarChecklist : buildDefaultKidChecklist();
  }
  if (!s.kids.bulut || Object.prototype.toString.call(s.kids.bulut) !== "[object Array]"){
    s.kids.bulut = (s.bulutChecklist && Object.prototype.toString.call(s.bulutChecklist) === "[object Array]") ? s.bulutChecklist : buildDefaultKidChecklist();
  }

  s.kids.ruzgar = normalizeItemArray(s.kids.ruzgar, false);
  s.kids.bulut = normalizeItemArray(s.kids.bulut, false);
  if (s.kids.ruzgar.length === 0) s.kids.ruzgar = buildDefaultKidChecklist();
  if (s.kids.bulut.length === 0) s.kids.bulut = buildDefaultKidChecklist();

  if (typeof s.screenSaverMode !== "boolean"){
    s.screenSaverMode = !!s.clockOnlyMode;
  }
  s.screenSaverMode = !!s.screenSaverMode;

  if (typeof s.today.date !== "string") s.today.date = todayISO(new Date());
  if (typeof s.tomorrow.date !== "string") s.tomorrow.date = shiftISO(s.today.date, 1);
  s.today.schedule = normalizeItemArray(s.today.schedule, true);
  s.tomorrow.schedule = normalizeItemArray(s.tomorrow.schedule, true);
}

function saveState(st){
  normalizeState(st);
  writeStorage(STORAGE_KEY, JSON.stringify(st));
}

function loadState(){
  var raw = readStorage(STORAGE_KEY);
  var parsed = raw ? safeJsonParse(raw) : null;
  if (!parsed || typeof parsed !== "object"){
    var s = defaultState();
    saveState(s);
    return s;
  }
  var base = defaultState();
  var merged = mergeDeep(base, parsed);
  migrateStateSchema(merged, parsed);
  normalizeState(merged);
  if (merged.settings.weatherEndpoint){
    writeStorage(ENDPOINT_STORAGE_KEY, merged.settings.weatherEndpoint);
  }
  saveState(merged);
  return merged;
}

var state = loadState();

// ---------- DOM ----------
var hhEl = $("#hh");
var mmEl = $("#mm");
var colonEl = $("#colon");
var dateLineEl = $("#dateLine");

var netDot = $("#netDot");
var netText = $("#netText");
var lastWeatherEl = $("#lastWeather");

var leaveBlockEl = $("#leaveBlock");
var leaveOverlayEl = $("#leaveOverlay");
var leaveTargetTimeEl = $("#leaveTargetTime");
var leaveDeltaEl = $("#leaveDelta");

var fullscreenCountdownEl = $("#fullscreenCountdown");
var fullscreenCountdownValueEl = $("#fullscreenCountdownValue");
var screenSaverLayerEl = $("#screenSaverLayer");
var screenSaverInfoEl = $("#screenSaverInfo");
var ssHhEl = $("#ssHh");
var ssMmEl = $("#ssMm");
var ssDateLineEl = $("#ssDateLine");
var ssWeatherLinesEl = $("#ssWeatherLines");

var bgEl = $("#bg");

var wSky = $("#wSky");
var wRain = $("#wRain");
var wTemp = $("#wTemp");
var wWind = $("#wWind");
var wTips = $("#wTips");
var wHint = $("#wHint");
var wIcon = $("#wIcon");

var notesList = $("#notesList");
var exitMatrixRows = $("#exitMatrixRows");
var ruzgarWish = $("#ruzgarWish");
var bulutWish = $("#bulutWish");

var editBtn = $("#editBtn");
var soundToggleBtn = $("#soundToggleBtn");
var soundHintEl = $("#soundHint");
var modalBackdrop = $("#modalBackdrop");
var closeModalBtn = $("#closeModalBtn");
var cancelBtn = $("#cancelBtn");
var saveBtn = $("#saveBtn");

var endpointInput = $("#endpointInput");
var pixelShiftToggle = $("#pixelShiftToggle");
var soundEnabledToggle = $("#soundEnabledToggle");
var departureTimeInput = $("#departureTimeInput");
var beforeMinutesInput = $("#beforeMinutesInput");
var afterMinutesInput = $("#afterMinutesInput");
var enableLateModeToggle = $("#enableLateModeToggle");
var screenSaverEnabledToggle = $("#screenSaverEnabledToggle");
var screenSaverTimeoutInput = $("#screenSaverTimeoutInput");

var newNoteItemInput = $("#newNoteItemInput");
var addNoteItemBtn = $("#addNoteItemBtn");
var editNotesList = $("#editNotesList");
var newExitItemInput = $("#newExitItemInput");
var addExitItemBtn = $("#addExitItemBtn");
var editExitItemsList = $("#editExitItemsList");

var exportBtn = $("#exportBtn");
var importFile = $("#importFile");
var importActions = $("#importActions");
var importOverwriteBtn = $("#importOverwriteBtn");
var importMergeBtn = $("#importMergeBtn");
var importCancelBtn = $("#importCancelBtn");
var importHint = $("#importHint");

var resetChecklistBtn = $("#resetChecklistBtn");

var themeToggleBtn = $("#themeToggleBtn");
var modeChip = $("#modeChip");
var pixelShiftWrap = $("#pixelShiftWrap");
var runtimeWarningEl = $("#runtimeWarning");

// ---------- Helpers ----------
function on(el, event, handler, opts){
  if (!el) return;
  if (opts && typeof opts === "object"){
    el.addEventListener(event, handler, opts);
  } else {
    el.addEventListener(event, handler, false);
  }
}

function getAudioContext(){
  if (audioCtx) return audioCtx;
  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    audioCtx = new Ctx();
  } catch(err){
    audioCtx = null;
  }
  return audioCtx;
}

function unlockAudioContext(){
  var ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "running"){
    audioUnlocked = true;
    setSoundHintVisible(false);
    return;
  }
  if (!ctx.resume) return;
  try {
    var p = ctx.resume();
    if (p && typeof p.then === "function"){
      p.then(function(){
        audioUnlocked = true;
        setSoundHintVisible(false);
      }, function(){});
    }
  } catch(err){}
}

function playTone(freq, durationSec, gainLevel, type){
  var ctx = getAudioContext();
  if (!ctx || ctx.state !== "running") return;
  try {
    var t0 = ctx.currentTime;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || "sine";
    osc.frequency.value = Number(freq || 880);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(Number(gainLevel || 0.03), t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + Number(durationSec || 0.08));
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + Number(durationSec || 0.08) + 0.02);
  } catch(err){}
}

function maybePlayCountdownSound(second, targetKey){
  if (!state.settings.soundEnabled) return;
  if (!audioUnlocked){
    showSoundHintIfNeeded();
    return;
  }
  if (targetKey !== lastCountdownSoundTargetKey){
    lastCountdownSoundTargetKey = targetKey;
    lastCountdownSoundSecond = null;
  }
  if (lastCountdownSoundSecond === second) return;

  if (second >= 1 && second <= 5){
    playTone(880, 0.08, 0.03, "square");
  } else if (second === 0){
    playTone(760, 0.78, 0.04, "square");
  } else {
    return;
  }
  lastCountdownSoundSecond = second;
}

function setSoundHintVisible(visible){
  if (!soundHintEl) return;
  soundHintEl.hidden = !visible;
}

function showSoundHintIfNeeded(){
  if (!state.settings.soundEnabled) return;
  if (audioUnlocked) return;
  if (soundHintShown) return;
  soundHintShown = true;
  setSoundHintVisible(true);
  setTimeout(function(){ setSoundHintVisible(false); }, 5200);
}

function renderSoundToggle(){
  var onState = !!(state.settings && state.settings.soundEnabled);
  if (soundToggleBtn){
    soundToggleBtn.textContent = onState ? "🔊" : "🔈";
    soundToggleBtn.setAttribute("aria-pressed", onState ? "true" : "false");
  }
  if (soundEnabledToggle){
    soundEnabledToggle.checked = onState;
  }
  if (!onState) setSoundHintVisible(false);
}

function parseLeaveTarget(now){
  var d = now || new Date();
  var raw = normalizeLeaveTime(state.leaveTimeSettings.leaveTime || DEFAULT_LEAVE_TIME);
  var p = raw.split(":");
  var h = Number(p[0]) || 0;
  var m = Number(p[1]) || 0;
  var t = new Date(d.getTime());
  t.setHours(h, m, 0, 0);
  return { raw: raw, target: t };
}

function showFullscreenCountdown(second){
  if (!fullscreenCountdownEl || !fullscreenCountdownValueEl) return;
  fullscreenCountdownValueEl.textContent = String(second);
  fullscreenCountdownEl.hidden = false;
}

function hideFullscreenCountdown(){
  if (!fullscreenCountdownEl) return;
  fullscreenCountdownEl.hidden = true;
  lastFullscreenSecond = null;
}

function setScreenSaverMode(enabled){
  state.screenSaverMode = !!enabled;
  if (!screenSaverLayerEl) return;
  if (state.screenSaverMode){
    screenSaverLayerEl.hidden = false;
    screenSaverLayerEl.classList.add("is-visible");
    document.body.classList.add("screen-saver-active");
    screenSaverMinuteStamp = "";
  } else {
    screenSaverLayerEl.classList.remove("is-visible");
    document.body.classList.remove("screen-saver-active");
    dashboardReturningUntil = Date.now() + 260;
    setTimeout(function(){
      if (!state.screenSaverMode && screenSaverLayerEl) screenSaverLayerEl.hidden = true;
    }, 240);
  }
}

function buildScreenSaverWeatherLines(){
  var payload = state.weatherCache && state.weatherCache.payload ? state.weatherCache.payload : null;
  if (!payload){
    return ["Sabah: veri yok", "Öğle: veri yok", "Gece: bulutlu/serin"];
  }
  var sky = String(payload.skyLabel || "bulutlu").toLowerCase();
  var rain = String(payload.rainLabel || "yok").toLowerCase();
  var minTemp = (typeof payload.minTemp === "number") ? payload.minTemp : null;

  var morning = "Sabah: " + (rain.indexOf("var") > -1 ? "yağış ihtimali" : (sky.indexOf("güneş") > -1 || sky.indexOf("gunes") > -1 ? "açık" : sky));
  var noon = "Öğle: " + (rain.indexOf("yüksek") > -1 || rain.indexOf("yuksek") > -1 ? "yağış ihtimali yüksek" : (rain.indexOf("var") > -1 ? "yağış ihtimali" : sky));
  var night = "Gece: ";
  if (minTemp != null && minTemp <= 8) night += "serin";
  else if (sky.indexOf("açık") > -1 || sky.indexOf("acik") > -1) night += "açık";
  else night += "bulutlu";

  return [morning, noon, night];
}

function updateScreenSaverShift(d){
  if (!screenSaverInfoEl) return;
  var stamp = String(d.getFullYear()) + "-" + String(d.getMonth()) + "-" + String(d.getDate()) + "-" + String(d.getHours()) + "-" + String(d.getMinutes());
  if (stamp === screenSaverMinuteStamp) return;
  screenSaverMinuteStamp = stamp;
  screenSaverShiftIndex = (screenSaverShiftIndex + 1) % screenSaverOffsets.length;
  var off = screenSaverOffsets[screenSaverShiftIndex];
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches){
    off = { x: 0, y: 0 };
  }
  screenSaverInfoEl.style.transform = "translate(" + off.x + "px," + off.y + "px)";
}

function updateScreenSaver(d){
  if (!ssHhEl || !ssMmEl || !ssDateLineEl || !ssWeatherLinesEl) return;
  ssHhEl.textContent = pad2(d.getHours());
  ssMmEl.textContent = pad2(d.getMinutes());
  ssDateLineEl.textContent = fmtTurkishDateLine(d);
  ssWeatherLinesEl.innerHTML = "";
  var lines = buildScreenSaverWeatherLines();
  var i;
  for (i = 0; i < lines.length; i++){
    var li = document.createElement("li");
    li.textContent = lines[i];
    ssWeatherLinesEl.appendChild(li);
  }
  if (state.screenSaverMode) updateScreenSaverShift(d);
}

function registerInteraction(){
  lastInteractionTimestamp = Date.now();
  unlockAudioContext();
  if (state.screenSaverMode){
    setScreenSaverMode(false);
  }
}

function applyIdleModeTick(nowTs){
  var now = Number(nowTs || Date.now());
  if (!state.settings.screenSaverEnabled) return;
  if (isModalOpen) return;
  if (state.screenSaverMode) return;
  if (now < dashboardReturningUntil) return;
  var timeoutMs = (Number(state.settings.screenSaverTimeoutMinutes) || 10) * 60 * 1000;
  if ((now - lastInteractionTimestamp) >= timeoutMs){
    setScreenSaverMode(true);
  }
}

function renderLeaveStatus(now){
  if (!leaveBlockEl || !leaveTargetTimeEl || !leaveDeltaEl) return;
  var info = parseLeaveTarget(now);
  var diffSec = Math.floor((now.getTime() - info.target.getTime()) / 1000); // after => positive
  var beforeSec = (Number(state.leaveTimeSettings.beforeMinutes) || DEFAULT_BEFORE_MIN) * 60;
  var afterSec = (Number(state.leaveTimeSettings.afterMinutes) || DEFAULT_AFTER_MIN) * 60;
  var within = (diffSec >= -beforeSec && diffSec <= afterSec);

  leaveTargetTimeEl.textContent = info.raw;
  leaveBlockEl.classList.toggle("is-visible", within);
  if (leaveOverlayEl) leaveOverlayEl.classList.toggle("is-visible", within);

  if (within){
    var targetKey = todayISO(now) + "|" + info.raw;
    var absSec = Math.abs(diffSec);
    var mm = pad2(Math.floor(absSec / 60));
    var ss = pad2(absSec % 60);
    var text = mm + ":" + ss;
    if (lastLeaveDeltaText !== text){
      leaveDeltaEl.textContent = text;
      leaveDeltaEl.classList.remove("tick");
      void leaveDeltaEl.offsetWidth;
      leaveDeltaEl.classList.add("tick");
      lastLeaveDeltaText = text;
    }

    var remain = -diffSec;
    var blink = remain > 0 && remain <= 30;
    leaveBlockEl.classList.toggle("is-blink", blink);

    if (remain >= 0 && remain <= 10){
      var secDisplay = Math.ceil(remain);
      if (secDisplay < 0) secDisplay = 0;
      if (secDisplay <= 5) maybePlayCountdownSound(secDisplay, targetKey);
      if (lastFullscreenSecond !== secDisplay){
        lastFullscreenSecond = secDisplay;
        showFullscreenCountdown(secDisplay);
      }
      if (secDisplay === 0){
        hideFullscreenCountdown();
      }
    } else {
      hideFullscreenCountdown();
    }
  } else {
    leaveBlockEl.classList.remove("is-blink");
    if (leaveOverlayEl) leaveOverlayEl.classList.remove("is-visible");
    hideFullscreenCountdown();
    lastCountdownSoundSecond = null;
    lastCountdownSoundTargetKey = "";
  }

  var late = now.getTime() > info.target.getTime();
  var lateEnabled = state.leaveTimeSettings.enableLateMode !== false;
  document.body.classList.toggle("late-mode", !!(late && lateEnabled));
}

function renderClock(){
  var d = new Date();
  if (hhEl) hhEl.textContent = pad2(d.getHours());
  if (mmEl) mmEl.textContent = pad2(d.getMinutes());
  if (dateLineEl) dateLineEl.textContent = fmtTurkishDateLine(d);
  if (colonEl) colonEl.style.opacity = (d.getSeconds() % 2 === 0) ? "0.5" : "0.95";
  updateScreenSaver(d);
  renderLeaveStatus(d);
  applyIdleModeTick(d.getTime());
}

function renderNet(){
  var online = isOnline();
  if (netDot) netDot.style.background = online ? "var(--good)" : "var(--bad)";
  if (netText) netText.textContent = online ? "Online" : "Offline";
}

function applyTheme(){
  document.documentElement.setAttribute("data-theme", state.settings.theme || "dark");
}

function toggleTheme(){
  state.settings.theme = (state.settings.theme === "light") ? "dark" : "light";
  saveState(state);
  renderAll();
}

function renderMiniList(ul, items){
  if (!ul) return;
  ul.innerHTML = "";
  var list = items || [];
  if (!list.length){
    var em = document.createElement("li");
    em.className = "muted";
    em.textContent = "—";
    ul.appendChild(em);
    return;
  }
  var i;
  for (i = 0; i < Math.min(3, list.length); i++){
    var it = list[i];
    var li = document.createElement("li");
    var t = (it.time && String(it.time).trim()) ? (it.time + " — ") : "";
    li.textContent = t + (it.text || "");
    ul.appendChild(li);
  }
}

function renderChecklist(ul, items, onToggle){
  if (!ul) return;
  ul.innerHTML = "";
  var list = items || [];
  if (!list.length){
    var em = document.createElement("li");
    em.className = "muted";
    em.textContent = "—";
    ul.appendChild(em);
    return;
  }
  var i;
  for (i = 0; i < list.length; i++){
    (function(it){
      var li = document.createElement("li");
      li.className = it.done ? "done" : "";

      var left = document.createElement("div");
      left.className = "itemLeft";

      var cb = document.createElement("div");
      cb.className = "cb";
      cb.innerHTML = "<span>✓</span>";

      var txt = document.createElement("div");
      txt.className = "itemText";
      txt.textContent = it.text || "";

      left.appendChild(cb);
      left.appendChild(txt);
      li.appendChild(left);

      var meta = document.createElement("div");
      meta.className = "itemMeta";
      meta.textContent = "";
      li.appendChild(meta);

      on(li, "click", function(){ onToggle(it.id); });
      ul.appendChild(li);
    })(list[i]);
  }
}

function renderScheduleList(ul, items, onToggle){
  if (!ul) return;
  ul.innerHTML = "";
  var list = items || [];
  if (!list.length){
    var em = document.createElement("li");
    em.className = "muted";
    em.textContent = "—";
    ul.appendChild(em);
    return;
  }
  var i;
  for (i = 0; i < Math.min(8, list.length); i++){
    (function(it){
      var li = document.createElement("li");
      li.className = "checkItem" + (it.done ? " done" : "");

      var left = document.createElement("div");
      left.className = "itemLeft";
      var cb = document.createElement("div");
      cb.className = "cb";
      cb.innerHTML = "<span>✓</span>";
      var txt = document.createElement("div");
      txt.className = "itemText";
      txt.textContent = it.text || "";

      left.appendChild(cb);
      left.appendChild(txt);
      li.appendChild(left);

      var meta = document.createElement("div");
      meta.className = "itemMeta";
      meta.textContent = (it.time && String(it.time).trim()) ? (it.time + " —") : "";
      li.appendChild(meta);

      on(li, "click", function(){ onToggle(it.id); });
      ul.appendChild(li);
    })(list[i]);
  }
}

function isChecklistComplete(checklistArray){
  var arr = checklistArray || [];
  if (!arr.length) return false;
  var i;
  for (i = 0; i < arr.length; i++){
    if (!arr[i].done) return false;
  }
  return true;
}

function getKidChecklistArray(kind){
  var out = [];
  var ex = state.exitChecklist || {};
  var items = ex.items || [];
  var doneMap = (kind === "ruzgar") ? (ex.ruzgarDone || {}) : (ex.bulutDone || {});
  var i;
  for (i = 0; i < items.length; i++){
    out.push({ id: items[i].id, done: !!doneMap[items[i].id] });
  }
  return out;
}

function renderKidWishes(){
  if (!ruzgarWish || !bulutWish) return;
  var rzDone = isChecklistComplete(getKidChecklistArray("ruzgar"));
  var blDone = isChecklistComplete(getKidChecklistArray("bulut"));
  ruzgarWish.hidden = !rzDone;
  bulutWish.hidden = !blDone;
}

function renderExitMatrix(){
  if (!exitMatrixRows) return;
  var ex = state.exitChecklist || {};
  var items = ex.items || [];
  var bMap = ex.bulutDone || {};
  var rMap = ex.ruzgarDone || {};
  exitMatrixRows.innerHTML = "";

  if (!items.length){
    var empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "Öğe yok";
    exitMatrixRows.appendChild(empty);
    return;
  }

  var i;
  for (i = 0; i < items.length; i++){
    (function(it){
      var bDone = !!bMap[it.id];
      var rDone = !!rMap[it.id];

      var row = document.createElement("div");
      row.className = "matrixRow";

      var left = document.createElement("div");
      left.className = "matrixCell";
      var bCb = document.createElement("button");
      bCb.type = "button";
      bCb.className = "matrixCb" + (bDone ? " is-checked" : "");
      bCb.innerHTML = '<span class=\"matrixCbTick\">✓</span>';
      on(bCb, "click", function(){ toggleKidDone("bulut", it.id); });
      left.appendChild(bCb);

      var center = document.createElement("div");
      center.className = "matrixLabel";
      center.innerHTML = '<span class="matrixLabelText">' + escapeHtml(it.text) + '</span>';
      if (bDone || rDone){
        center.style.opacity = "0.62";
        center.style.textDecoration = "line-through";
      } else {
        center.style.opacity = "";
        center.style.textDecoration = "";
      }

      var right = document.createElement("div");
      right.className = "matrixCell";
      var rCb = document.createElement("button");
      rCb.type = "button";
      rCb.className = "matrixCb" + (rDone ? " is-checked" : "");
      rCb.innerHTML = '<span class=\"matrixCbTick\">✓</span>';
      on(rCb, "click", function(){ toggleKidDone("ruzgar", it.id); });
      right.appendChild(rCb);

      row.appendChild(left);
      row.appendChild(center);
      row.appendChild(right);
      exitMatrixRows.appendChild(row);
    })(items[i]);
  }
}

function renderNotes(){
  if (!notesList) return;
  notesList.innerHTML = "";
  var items = state.notes && state.notes.items ? state.notes.items : [];
  if (!items.length){
    var empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "—";
    notesList.appendChild(empty);
    return;
  }
  var i;
  for (i = 0; i < items.length; i++){
    (function(it){
      var li = document.createElement("li");
      li.className = "notesChecklistItem" + (it.done ? " is-done" : "");

      var cb = document.createElement("button");
      cb.type = "button";
      cb.className = "matrixCb" + (it.done ? " is-checked" : "");
      cb.innerHTML = '<span class=\"matrixCbTick\">✓</span>';
      on(cb, "click", function(){ toggleNoteDone(it.id); });

      var txt = document.createElement("span");
      txt.className = "notesChecklistText";
      txt.textContent = it.text || "";

      li.appendChild(cb);
      li.appendChild(txt);
      notesList.appendChild(li);
    })(items[i]);
  }
}

function toggleTodayDone(id){
  var i, list = state.today.schedule || [];
  for (i = 0; i < list.length; i++){
    if (list[i].id === id){
      list[i].done = !list[i].done;
      break;
    }
  }
  saveState(state);
  renderAll();
}

function toggleKidDone(kind, id){
  var ex = state.exitChecklist || {};
  var doneMap = (kind === "ruzgar") ? ex.ruzgarDone : ex.bulutDone;
  if (!doneMap || !doneMap.hasOwnProperty(id)) doneMap[id] = false;
  doneMap[id] = !doneMap[id];
  saveState(state);
  renderAll();
}

function toggleNoteDone(id){
  var items = state.notes && state.notes.items ? state.notes.items : [];
  var i;
  for (i = 0; i < items.length; i++){
    if (items[i].id === id){
      items[i].done = !items[i].done;
      break;
    }
  }
  saveState(state);
  renderAll();
}

function resetExitDoneStates(){
  var ex = state.exitChecklist || {};
  var items = ex.items || [];
  var i;
  ex.bulutDone = {};
  ex.ruzgarDone = {};
  for (i = 0; i < items.length; i++){
    ex.bulutDone[items[i].id] = false;
    ex.ruzgarDone[items[i].id] = false;
  }
  ex.lastResetDate = todayISO(new Date());
}

function resetNotesDoneStates(){
  var n = state.notes || {};
  var items = n.items || [];
  var i;
  for (i = 0; i < items.length; i++) items[i].done = false;
  n.lastResetDate = todayISO(new Date());
}

function maybeRollover(){
  var nowDate = todayISO(new Date());
  var ex = state.exitChecklist || {};
  var n = state.notes || {};
  var changed = false;
  if (ex.lastResetDate !== nowDate){
    resetExitDoneStates();
    changed = true;
  }
  if (n.lastResetDate !== nowDate){
    resetNotesDoneStates();
    changed = true;
  }
  if (changed){
    saveState(state);
  }
}

function clearDoneInToday(){
  var src = state.today.schedule || [];
  var dst = [];
  var i;
  for (i = 0; i < src.length; i++) if (!src[i].done) dst.push(src[i]);
  state.today.schedule = dst;
  saveState(state);
  renderAll();
}

function updateLastWeatherLine(){
  if (!lastWeatherEl) return;
  var ts = state.weatherCache && state.weatherCache.fetchedAt ? state.weatherCache.fetchedAt : 0;
  if (!ts){
    lastWeatherEl.textContent = "Hava: —";
    return;
  }
  lastWeatherEl.textContent = "Hava: " + fmtTimeHM(new Date(ts));
}

function weatherIconSvg(type){
  if (type === "sunny") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none"></circle><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3"/></svg>';
  if (type === "partly") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="9" r="3.5" fill="currentColor" stroke="none"></circle><path d="M8 17h9a3 3 0 0 0 .1-6 4.5 4.5 0 0 0-8.8-1.2A3.3 3.3 0 0 0 8 17Z" fill="currentColor" stroke="none"/></svg>';
  if (type === "rain") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 13h11a3 3 0 0 0 .1-6 4.5 4.5 0 0 0-8.8-1.1A3.4 3.4 0 0 0 6 13Z" fill="currentColor" stroke="none"/><path d="m8 15-1 3m5-3-1 3m5-3-1 3"/></svg>';
  if (type === "storm") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 12h11a3 3 0 0 0 .1-6 4.5 4.5 0 0 0-8.8-1.1A3.4 3.4 0 0 0 6 12Z" fill="currentColor" stroke="none"/><path d="m11 13-2.2 4.2h2.5L10 21l4.2-5h-2.6l1.4-3Z"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 17h11.2a3.2 3.2 0 0 0 .1-6.3 4.9 4.9 0 0 0-9.5-1.4A3.7 3.7 0 0 0 6 17Z" fill="currentColor" stroke="none"/></svg>';
}

function pickWallpaper(normalized){
  if (!normalized) return "bulutlu.png";
  var sky = String(normalized.skyLabel || "").toLowerCase();
  var rain = String(normalized.rainLabel || "").toLowerCase();
  var wind = String(normalized.windLabel || "").toLowerCase();
  var minT = (typeof normalized.minTemp === "number") ? normalized.minTemp : null;
  var maxT = (typeof normalized.maxTemp === "number") ? normalized.maxTemp : null;

  if (sky.indexOf("gök") > -1 || sky.indexOf("fırt") > -1 || sky.indexOf("firt") > -1) return "firtina.png";
  if ((minT != null && minT <= 6) || (maxT != null && maxT <= 10)) return "soguk.png";
  if (wind.indexOf("kuvvet") > -1) return "ruzgarli.png";

  if (rain.indexOf("var") > -1){
    if (rain.indexOf("yüksek") > -1 || rain.indexOf("yuksek") > -1) return "Yagisli.png";
    return "az_yagisli.png";
  }

  if (sky.indexOf("güneşli") > -1 || sky.indexOf("gunesli") > -1 || sky.indexOf("açık") > -1 || sky.indexOf("acik") > -1) return "Gunesli.png";
  if (sky.indexOf("az bulut") > -1 || sky.indexOf("parçalı") > -1 || sky.indexOf("parcali") > -1) return "az_bulutlu.png";
  if (sky.indexOf("bulut") > -1 || sky.indexOf("kapalı") > -1 || sky.indexOf("kapali") > -1) return "bulutlu.png";

  return "bulutlu.png";
}

function applyWallpaper(filename){
  if (!bgEl) return;
  wallpaperLoadToken += 1;
  var token = wallpaperLoadToken;
  if (!filename){
    bgEl.style.backgroundImage = "none";
    return;
  }
  var src = "./weather/" + filename;
  var img = new Image();
  img.onload = function(){
    if (token !== wallpaperLoadToken) return;
    bgEl.style.backgroundImage = "url('" + src + "')";
  };
  img.onerror = function(){
    if (token !== wallpaperLoadToken) return;
    bgEl.style.backgroundImage = "none";
  };
  img.src = src;
}

function setWeatherUI(normalized, hintText){
  if (!normalized){
    if (wSky) wSky.textContent = "—";
    if (wRain) wRain.textContent = "—";
    if (wTemp) wTemp.textContent = "—";
    if (wWind) wWind.textContent = "—";
    if (wTips) wTips.innerHTML = '<li class="muted">Hava verisi yok.</li>';
    if (wHint) wHint.textContent = hintText || "";
    if (wIcon) wIcon.innerHTML = weatherIconSvg("cloudy");
    applyWallpaper(null);
    return;
  }

  if (wSky) wSky.textContent = normalized.skyLabel || "—";
  if (wRain) wRain.textContent = normalized.rainLabel || "—";
  if (wTemp){
    if (normalized.minTemp != null && normalized.maxTemp != null){
      wTemp.textContent = String(Math.round(normalized.minTemp)) + "–" + String(Math.round(normalized.maxTemp)) + "°C";
    } else {
      wTemp.textContent = "—";
    }
  }
  if (wWind) wWind.textContent = normalized.windLabel || "—";

  if (wTips){
    wTips.innerHTML = "";
    var tips = normalized.tips && Object.prototype.toString.call(normalized.tips) === "[object Array]" ? normalized.tips : [];
    var i;
    if (!tips.length){
      wTips.innerHTML = '<li class="muted">—</li>';
    } else {
      for (i = 0; i < Math.min(3, tips.length); i++){
        var li = document.createElement("li");
        li.textContent = String(tips[i]);
        wTips.appendChild(li);
      }
    }
  }

  if (wHint) wHint.textContent = hintText || "";

  var iconType = "cloudy";
  var sky = String(normalized.skyLabel || "").toLowerCase();
  var rain = String(normalized.rainLabel || "").toLowerCase();
  if (sky.indexOf("gök") > -1 || sky.indexOf("fırt") > -1 || sky.indexOf("firt") > -1) iconType = "storm";
  else if (rain.indexOf("var") > -1) iconType = "rain";
  else if (sky.indexOf("az bulut") > -1 || sky.indexOf("parçalı") > -1 || sky.indexOf("parcali") > -1) iconType = "partly";
  else if (sky.indexOf("güneş") > -1 || sky.indexOf("gunes") > -1) iconType = "sunny";

  if (wIcon) wIcon.innerHTML = weatherIconSvg(iconType);
  applyWallpaper(pickWallpaper(normalized));
}

function numOrNull(v){
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function skyFromCode(code){
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

function windLabelFromSpeed(kmh){
  if (kmh == null) return "—";
  if (kmh < 18) return "Hafif";
  if (kmh < 35) return "Orta";
  return "Kuvvetli";
}

function rainFromPop(pop, code){
  var p = pop;
  if (p == null){
    if (code != null && ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95)) p = 60;
    else p = 10;
  }
  var level = (p >= 65) ? "yüksek" : (p >= 35 ? "orta" : "düşük");
  var has = (p >= 20) || (code != null && ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95));
  return {
    hasRain: has,
    rainLevel: level,
    rainLabel: has ? ("Var (ihtimal: " + level + ")") : ("Yok (ihtimal: " + level + ")")
  };
}

function buildTips(norm, extra){
  var tips = [];
  var rainText = String(norm.rainLabel || "").toLowerCase();
  var hasRain = rainText.indexOf("var") > -1;
  var rainLevel = (extra && extra.rainLevel) ? extra.rainLevel : (rainText.indexOf("yüksek") > -1 ? "yüksek" : (rainText.indexOf("orta") > -1 ? "orta" : "düşük"));

  if (hasRain){
    if (rainLevel === "yüksek") tips.push("Kapüşonlu mont tercih et, suya dayanıklı ayakkabı seç.");
    else tips.push("Kapüşonlu ince mont tercih etmek rahat olur.");
  } else {
    tips.push("Yağış beklenmiyor: hızlı çıkış için ideal.");
  }

  if (norm.minTemp != null && norm.minTemp <= 8) tips.push("Sabah serin: mont/kalın üst iyi olur.");
  else if (norm.maxTemp != null && norm.maxTemp >= 27) tips.push("Sıcak: su + açık renk kıyafet önerilir.");
  else if (norm.minTemp != null && norm.maxTemp != null && (norm.maxTemp - norm.minTemp) >= 10) tips.push("Gün içi fark yüksek: katmanlı giyin.");

  var sky = String(norm.skyLabel || "").toLowerCase();
  if (sky.indexOf("güneş") > -1 || sky.indexOf("gunes") > -1 || sky.indexOf("az bulut") > -1) tips.push("Güneş gözlüğü işe yarar.");

  var wind = String(norm.windLabel || "").toLowerCase();
  if (wind.indexOf("kuvvet") > -1) tips.push("Rüzgar kuvvetli: hafif eşyaları sabitle.");

  var uniq = [];
  var i;
  for (i = 0; i < tips.length; i++) if (uniq.indexOf(tips[i]) === -1) uniq.push(tips[i]);
  return uniq.slice(0, 3);
}

function normalizeWeather(payload){
  if (!payload || typeof payload !== "object") return null;

  if (typeof payload.skyLabel === "string" && typeof payload.rainLabel === "string"){
    var outReady = {
      skyLabel: payload.skyLabel,
      rainLabel: payload.rainLabel,
      minTemp: payload.minTemp != null ? Number(payload.minTemp) : null,
      maxTemp: payload.maxTemp != null ? Number(payload.maxTemp) : null,
      windLabel: payload.windLabel || "—",
      tips: (payload.tips && Object.prototype.toString.call(payload.tips) === "[object Array]") ? payload.tips : []
    };
    if (!outReady.tips.length) outReady.tips = buildTips(outReady, {});
    return outReady;
  }

  if (!payload.daily) return null;
  var daily = payload.daily;
  var minTemp = numOrNull(daily.temperature_2m_min && daily.temperature_2m_min[0]);
  var maxTemp = numOrNull(daily.temperature_2m_max && daily.temperature_2m_max[0]);
  var pop = numOrNull(daily.precipitation_probability_max && daily.precipitation_probability_max[0]);
  var wind = numOrNull(daily.windspeed_10m_max && daily.windspeed_10m_max[0]);
  var code = numOrNull(daily.weathercode && daily.weathercode[0]);

  var rf = rainFromPop(pop, code);
  var out = {
    skyLabel: skyFromCode(code),
    rainLabel: rf.rainLabel,
    minTemp: minTemp,
    maxTemp: maxTemp,
    windLabel: windLabelFromSpeed(wind),
    tips: []
  };
  out.tips = buildTips(out, { rainLevel: rf.rainLevel });
  return out;
}

function fetchJsonWithTimeout(url, timeoutMs){
  timeoutMs = timeoutMs || FETCH_TIMEOUT_MS;
  if (typeof AbortController === "undefined"){
    return fetch(url, { cache: "no-store" }).then(function(res){
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  var ctrl = new AbortController();
  var timer = setTimeout(function(){
    try { ctrl.abort(); } catch(e) {}
  }, timeoutMs);

  return fetch(url, { cache: "no-store", signal: ctrl.signal }).then(function(res){
    clearTimeout(timer);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }, function(err){
    clearTimeout(timer);
    throw err;
  });
}

function openMeteoUrl(){
  var qs = "latitude=" + encodeURIComponent(String(IZMIR.lat)) +
    "&longitude=" + encodeURIComponent(String(IZMIR.lon)) +
    "&daily=" + encodeURIComponent("weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max") +
    "&timezone=" + encodeURIComponent(IZMIR.tz);
  return "https://api.open-meteo.com/v1/forecast?" + qs;
}

function fetchWeather(){
  renderNet();
  if (state.screenSaverMode){
    var cachedWhileSaver = state.weatherCache ? state.weatherCache.payload : null;
    setWeatherUI(cachedWhileSaver, "Screen Saver: son kayıt");
    updateLastWeatherLine();
    return Promise.resolve();
  }

  if (!isOnline()){
    var cached = state.weatherCache ? state.weatherCache.payload : null;
    setWeatherUI(cached, "Offline: son kayıt gösteriliyor.");
    updateLastWeatherLine();
    return Promise.resolve();
  }

  var endpoint = String(state.settings.weatherEndpoint || WEATHER_ENDPOINT_FALLBACK || "").trim();
  var normalized = null;
  var fetchedAt = 0;
  var hint = "";

  var p = Promise.resolve();

  if (endpoint && endpoint.indexOf("http") === 0){
    p = p.then(function(){
      return fetchJsonWithTimeout(endpoint, FETCH_TIMEOUT_MS).then(function(data){
        normalized = normalizeWeather(data);
        if (!normalized) throw new Error("Normalize failed endpoint");
        fetchedAt = Date.now();
        hint = "Hava: endpoint";
      }, function(err){
        hint = "Endpoint başarısız. Fallback deneniyor…";
        return Promise.resolve(err);
      });
    });
  }

  return p.then(function(){
    if (normalized) return null;
    return fetchJsonWithTimeout(openMeteoUrl(), FETCH_TIMEOUT_MS).then(function(data){
      normalized = normalizeWeather(data);
      if (!normalized) throw new Error("Normalize failed open-meteo");
      fetchedAt = Date.now();
      hint = "Hava: Open-Meteo";
    }, function(){
      var cached = state.weatherCache ? state.weatherCache.payload : null;
      if (cached){
        setWeatherUI(cached, "Hava güncellenemedi, son veri gösteriliyor.");
        updateLastWeatherLine();
      } else {
        setWeatherUI(null, "Hava alınamadı.");
      }
      return null;
    });
  }).then(function(){
    if (!normalized) return;
    state.weatherCache = { fetchedAt: fetchedAt, payload: normalized };
    saveState(state);
    setWeatherUI(normalized, hint);
    updateLastWeatherLine();
  });
}

function applyPixelShiftEnabled(enabled){
  var canShift = enabled && !isModalOpen;
  if (pixelShiftTimer){
    clearInterval(pixelShiftTimer);
    pixelShiftTimer = null;
  }
  if (!pixelShiftWrap) return;
  if (!canShift){
    pixelShiftWrap.style.transform = "translate(0px,0px)";
    return;
  }
  pixelShiftTimer = setInterval(function(){
    pixelShiftPhase = (pixelShiftPhase + 1) % 4;
    var dx = (pixelShiftPhase % 2 === 0) ? 1 : -1;
    var dy = (pixelShiftPhase < 2) ? 1 : -1;
    pixelShiftWrap.style.transform = "translate(" + dx + "px," + dy + "px)";
  }, PIXEL_SHIFT_MS);
}

function ensureModalTopLayer(){
  if (modalBackdrop && modalBackdrop.parentElement !== document.body){
    document.body.appendChild(modalBackdrop);
  }
}

function setModalOpen(nextOpen){
  isModalOpen = !!nextOpen;
  document.body.classList.toggle("modal-open", isModalOpen);
  applyPixelShiftEnabled(!!state.settings.pixelShift);
}

function makeEditRow(item, kind){
  var li = document.createElement("li");
  li.className = "editItem";

  var text = document.createElement("input");
  text.type = "text";
  text.placeholder = "Öğe";
  text.value = item.text || "";
  on(text, "input", function(){ item.text = String(text.value || ""); });

  var del = document.createElement("button");
  del.type = "button";
  del.className = "delBtn";
  del.textContent = "Sil";
  on(del, "click", function(){
    var ex = state.exitChecklist;
    ex.items = ex.items.filter(function(x){ return x.id !== item.id; });
    if (ex.bulutDone && ex.bulutDone.hasOwnProperty(item.id)) delete ex.bulutDone[item.id];
    if (ex.ruzgarDone && ex.ruzgarDone.hasOwnProperty(item.id)) delete ex.ruzgarDone[item.id];
    if (!ex.items.length){
      ex.items = buildDefaultExitItems();
      ex.bulutDone = createDoneMapFromItems(ex.items);
      ex.ruzgarDone = createDoneMapFromItems(ex.items);
    }
    saveState(state);
    renderEditLists();
    renderAll();
  });

  li.appendChild(text);
  li.appendChild(del);
  return li;
}

function makeNoteEditRow(item){
  var li = document.createElement("li");
  li.className = "editItem";

  var text = document.createElement("input");
  text.type = "text";
  text.placeholder = "Not";
  text.value = item.text || "";
  on(text, "input", function(){ item.text = String(text.value || ""); });

  var del = document.createElement("button");
  del.type = "button";
  del.className = "delBtn";
  del.textContent = "Sil";
  on(del, "click", function(){
    var items = state.notes && state.notes.items ? state.notes.items : [];
    state.notes.items = items.filter(function(x){ return x.id !== item.id; });
    saveState(state);
    renderEditLists();
    renderAll();
  });

  li.appendChild(text);
  li.appendChild(del);
  return li;
}

function renderEditLists(){
  if (!editExitItemsList || !editNotesList) return;
  editNotesList.innerHTML = "";
  editExitItemsList.innerHTML = "";
  var i;
  for (i = 0; i < Math.min(40, state.notes.items.length); i++){
    editNotesList.appendChild(makeNoteEditRow(state.notes.items[i]));
  }
  for (i = 0; i < Math.min(40, state.exitChecklist.items.length); i++){
    editExitItemsList.appendChild(makeEditRow(state.exitChecklist.items[i], "exit"));
  }
}

function openModal(){
  if (!modalBackdrop) return;
  registerInteraction();
  if (state.screenSaverMode) setScreenSaverMode(false);
  normalizeState(state);
  if (endpointInput) endpointInput.value = state.settings.weatherEndpoint || "";
  if (soundEnabledToggle) soundEnabledToggle.checked = !!state.settings.soundEnabled;
  if (departureTimeInput) departureTimeInput.value = state.leaveTimeSettings.leaveTime || DEFAULT_LEAVE_TIME;
  if (beforeMinutesInput) beforeMinutesInput.value = String(state.leaveTimeSettings.beforeMinutes || DEFAULT_BEFORE_MIN);
  if (afterMinutesInput) afterMinutesInput.value = String(state.leaveTimeSettings.afterMinutes || DEFAULT_AFTER_MIN);
  if (enableLateModeToggle) enableLateModeToggle.checked = !!state.leaveTimeSettings.enableLateMode;
  if (screenSaverEnabledToggle) screenSaverEnabledToggle.checked = !!state.settings.screenSaverEnabled;
  if (screenSaverTimeoutInput) screenSaverTimeoutInput.value = String(state.settings.screenSaverTimeoutMinutes || 10);
  if (pixelShiftToggle) pixelShiftToggle.checked = !!state.settings.pixelShift;

  renderEditLists();
  modalBackdrop.hidden = false;
  setModalOpen(true);
  setTimeout(function(){ if (endpointInput) endpointInput.focus(); }, 50);
}

function closeModal(){
  if (!modalBackdrop) return;
  modalBackdrop.hidden = true;
  setModalOpen(false);
  if (importActions) importActions.hidden = true;
  if (importHint) importHint.textContent = "";
  importStaged = null;
}

function addExitItem(){
  var input = newExitItemInput;
  var text = String(input && input.value || "").trim();
  if (!text) return;
  var newId = uid();
  state.exitChecklist.items.push({ id: newId, text: text });
  state.exitChecklist.bulutDone[newId] = false;
  state.exitChecklist.ruzgarDone[newId] = false;
  if (input) input.value = "";
  saveState(state);
  renderEditLists();
  renderAll();
}

function addNoteItem(){
  var text = String(newNoteItemInput && newNoteItemInput.value || "").replace(/^\s+|\s+$/g, "");
  if (!text) return;
  state.notes.items.push({ id: uid(), text: text, done: false });
  if (newNoteItemInput) newNoteItemInput.value = "";
  saveState(state);
  renderEditLists();
  renderAll();
}

function saveFromModal(){
  normalizeState(state);
  state.settings.weatherEndpoint = String(endpointInput && endpointInput.value || "").trim();
  writeStorage(ENDPOINT_STORAGE_KEY, state.settings.weatherEndpoint);
  state.settings.pixelShift = !!(pixelShiftToggle && pixelShiftToggle.checked);
  state.settings.soundEnabled = !!(soundEnabledToggle && soundEnabledToggle.checked);

  state.leaveTimeSettings.leaveTime = normalizeLeaveTime(departureTimeInput && departureTimeInput.value || DEFAULT_LEAVE_TIME);
  state.leaveTimeSettings.beforeMinutes = clamp(Number(beforeMinutesInput && beforeMinutesInput.value) || DEFAULT_BEFORE_MIN, 0, 240);
  state.leaveTimeSettings.afterMinutes = clamp(Number(afterMinutesInput && afterMinutesInput.value) || DEFAULT_AFTER_MIN, 0, 240);
  state.leaveTimeSettings.enableLateMode = !!(enableLateModeToggle && enableLateModeToggle.checked);
  state.settings.screenSaverEnabled = !!(screenSaverEnabledToggle && screenSaverEnabledToggle.checked);
  state.settings.screenSaverTimeoutMinutes = clamp(Number(screenSaverTimeoutInput && screenSaverTimeoutInput.value) || 10, 1, 240);

  var ex = state.exitChecklist || {};
  ex.items = normalizeExitItems(ex.items);
  if (!ex.items.length) ex.items = buildDefaultExitItems();
  ex.bulutDone = normalizeDoneMap(ex.bulutDone, ex.items);
  ex.ruzgarDone = normalizeDoneMap(ex.ruzgarDone, ex.items);
  state.exitChecklist = ex;
  state.notes.items = normalizeNotesItems(state.notes.items);
  if (state.settings.soundEnabled) unlockAudioContext();

  saveState(state);
  renderAll();
  applyPixelShiftEnabled(state.settings.pixelShift);
  fetchWeather();
  closeModal();
}

function downloadJson(filename, obj){
  var blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportData(){
  downloadJson("doorboard-backup.json", state);
}

function validateImported(obj){
  if (!obj || typeof obj !== "object") return { ok: false, msg: "JSON nesnesi değil." };
  if (!obj.settings && !obj.exitChecklist && !obj.notes && !obj.persistentNotes && !obj.today) return { ok: false, msg: "Desteklenen veri alanı bulunamadı." };
  return { ok: true, msg: "OK" };
}

function stageImport(file){
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(){
    var text = String(reader.result || "");
    var obj = safeJsonParse(text);
    var v = validateImported(obj);
    if (!v.ok){
      if (importHint) importHint.textContent = "İçe aktarma hatası: " + v.msg;
      if (importActions) importActions.hidden = true;
      importStaged = null;
      return;
    }
    importStaged = obj;
    if (importHint) importHint.textContent = "Dosya doğrulandı.";
    if (importActions) importActions.hidden = false;
  };
  reader.onerror = function(){
    if (importHint) importHint.textContent = "Dosya okunamadı.";
    if (importActions) importActions.hidden = true;
    importStaged = null;
  };
  reader.readAsText(file);
}

function doImport(mode){
  if (!importStaged) return;

  if (mode === "overwrite"){
    state = importStaged;
    migrateStateSchema(state, importStaged);
  } else {
    var base = defaultState();
    var cur = loadState();
    state = mergeDeep(mergeDeep(base, cur), importStaged);
    migrateStateSchema(state, importStaged);
  }

  normalizeState(state);
  saveState(state);
  writeStorage(ENDPOINT_STORAGE_KEY, state.settings.weatherEndpoint || "");

  renderAll();
  applyPixelShiftEnabled(state.settings.pixelShift);
  fetchWeather();

  if (importHint) importHint.textContent = "İçe aktarma tamamlandı.";
  if (importActions) importActions.hidden = true;
  importStaged = null;
}

function tryRegisterSW(){
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").catch(function(){});
}

function renderAll(){
  normalizeState(state);
  maybeRollover();
  if (!state.settings.screenSaverEnabled && state.screenSaverMode){
    state.screenSaverMode = false;
  }
  applyTheme();
  renderClock();
  renderNet();
  updateLastWeatherLine();

  renderNotes();
  renderExitMatrix();
  renderKidWishes();

  if (pixelShiftToggle) pixelShiftToggle.checked = !!state.settings.pixelShift;
  if (modeChip) modeChip.textContent = state.settings.theme === "light" ? "Aydınlık" : "Karanlık";
  renderSoundToggle();
  setScreenSaverMode(!!state.screenSaverMode);
}

function bindEvents(){
  on(soundToggleBtn, "click", function(){
    registerInteraction();
    state.settings.soundEnabled = !state.settings.soundEnabled;
    if (state.settings.soundEnabled){
      unlockAudioContext();
      if (!audioUnlocked) showSoundHintIfNeeded();
    } else {
      setSoundHintVisible(false);
    }
    saveState(state);
    renderSoundToggle();
  });
  on(editBtn, "click", openModal);
  on(closeModalBtn, "click", closeModal);
  on(cancelBtn, "click", closeModal);
  on(saveBtn, "click", saveFromModal);
  on(modalBackdrop, "click", function(e){ if (e.target === modalBackdrop) closeModal(); });

  on(addNoteItemBtn, "click", addNoteItem);
  on(newNoteItemInput, "keydown", function(e){ if (e.key === "Enter") addNoteItem(); });
  on(addExitItemBtn, "click", addExitItem);
  on(newExitItemInput, "keydown", function(e){ if (e.key === "Enter") addExitItem(); });

  on(exportBtn, "click", exportData);
  on(importFile, "change", function(e){
    var f = e.target && e.target.files ? e.target.files[0] : null;
    stageImport(f);
  });
  on(importOverwriteBtn, "click", function(){ doImport("overwrite"); });
  on(importMergeBtn, "click", function(){ doImport("merge"); });
  on(importCancelBtn, "click", function(){
    if (importActions) importActions.hidden = true;
    if (importHint) importHint.textContent = "İçe aktarma iptal edildi.";
    importStaged = null;
  });

  on(resetChecklistBtn, "click", function(){
    resetExitDoneStates();
    saveState(state);
    renderAll();
  });
  on(themeToggleBtn, "click", toggleTheme);

  on(document, "keydown", function(e){
    if (e.key === "Escape" && modalBackdrop && !modalBackdrop.hidden) closeModal();
  });

  on(window, "online", function(){ renderNet(); fetchWeather(); });
  on(window, "offline", function(){ renderNet(); fetchWeather(); });

  on(window, "touchstart", function(){ registerInteraction(); }, { passive: true });
  on(window, "mousedown", function(){ registerInteraction(); });
  on(window, "keydown", function(){ registerInteraction(); });
  on(window, "scroll", function(){ registerInteraction(); }, { passive: true });
  on(screenSaverLayerEl, "touchstart", function(){ registerInteraction(); }, { passive: true });
  on(screenSaverLayerEl, "mousedown", function(){ registerInteraction(); });
}

function init(){
  if (!isPersistentStorageAvailable() && runtimeWarningEl){
    runtimeWarningEl.hidden = false;
    runtimeWarningEl.textContent = "Uyarı: localStorage kapalı. Veriler sadece bu oturumda tutulur.";
  }

  ensureModalTopLayer();
  normalizeState(state);
  lastInteractionTimestamp = Date.now();
  maybeRollover();
  renderAll();
  if (state.settings.soundEnabled) unlockAudioContext();
  if (state.settings.soundEnabled && !audioUnlocked){
    showSoundHintIfNeeded();
  }

  if (state.weatherCache && state.weatherCache.payload){
    setWeatherUI(state.weatherCache.payload, isOnline() ? "Son kayıt (yenileniyor…)" : "Offline: son kayıt");
  } else {
    setWeatherUI(null, isOnline() ? "Hava alınıyor…" : "Offline");
  }
  updateLastWeatherLine();

  setInterval(function(){
    renderClock();
    renderNet();
    var d = new Date();
    if (d.getMinutes() % 5 === 0 && d.getSeconds() === 0) maybeRollover();
  }, CLOCK_TICK_MS);

  fetchWeather();
  setInterval(function(){
    if (isOnline()) fetchWeather();
  }, WEATHER_REFRESH_MS);

  applyPixelShiftEnabled(state.settings.pixelShift);
  bindEvents();
  tryRegisterSW();
}

init();
