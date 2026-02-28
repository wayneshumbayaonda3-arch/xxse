const STUDY_PARTS = ["1:1", "1:2", "2:1", "2:2", "3:1", "3:2", "Attachee", "4:1", "4:2", "Post-Grad"];
const SUPABASE_URL = "https://dqsyyhgwrsgzlfaiftoh.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxc3l5aGd3cnNnemxmYWlmdG9oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2NDcyNTUsImV4cCI6MjA4NzIyMzI1NX0.HzXdURCZPUEpB54NK9ElnIg5SM8u-Eokx7PRrVRVddE";
const APP_STATE_ID = "primary";

let supabaseClient = null;
let supabaseInitPromise = null;
let runtimeState = null;

// If Supabase RLS blocks app_state for this project, repeated writes/reads just spam the console.
// We'll disable DB persistence after the first clear RLS/401 failure and rely on local backup.
const DB_PERSIST_DISABLED_KEY = "edupath_db_persist_disabled";
function isDbPersistDisabled(){
  try{ return localStorage.getItem(DB_PERSIST_DISABLED_KEY) === "1"; }catch(e){ return false; }
}
function disableDbPersist(){
  try{ localStorage.setItem(DB_PERSIST_DISABLED_KEY, "1"); }catch(e){}
}

function generateRoomCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function emailFromUsername(username) { return `${(username || "").trim().toLowerCase()}@hit.ac.zw`; }
function normalizeRegNumber(reg) { return (reg || "").trim(); }
function regToHitEmail(reg) { return `${normalizeRegNumber(reg).toLowerCase()}@hit.ac.zw`; }
function isHitEmail(email) { return (email || "").trim().toLowerCase().endsWith("@hit.ac.zw"); }
function isValidRegNumber(reg) { return /^[Hh][A-Za-z0-9]+$/.test(normalizeRegNumber(reg)); }

function defaultRooms() {
  return [{ id: "global-room", name: "Global Collaboration", code: "GLOBAL", ownerKey: "system", members: ["*"], isDefault: true, createdAt: new Date().toISOString() }];
}

const defaultState = {
  settings: {
    welcomeText: "Welcome to the HIT Student Collaboration & Academic Support Portal.",
    announcement: "Mid-semester tests begin next week. Prepare your study groups early.",
    dashboardBanner: "Empowering collaboration across departments.",
    // Legacy single background (kept for backward compatibility)
    backgroundImage: "",
    // New: allow different backgrounds per page/panel
    backgroundImages: {
      default: "",
      pages: {}
    },
    featureVisibility: { chat: true, resources: true, qa: true, tasks: true }
  },
  // NOTE: departments and courses should be sourced from the database.
  // Keeping these empty prevents stale defaults from leaking into UI dropdowns.
  departments: [],
  courses: [],
  users: [],
  sessions: { student: null, admin: null },
  chatrooms: defaultRooms(),
  chats: [{ id: crypto.randomUUID(), roomId: "global-room", sender: "System", senderKey: "system", message: "Welcome to the global room. Share ideas respectfully.", type: "system", replyTo: null, attachmentName: "", attachmentData: "", audioData: "", createdAt: new Date().toISOString() }],
  tasks: [{ id: crypto.randomUUID(), roomId: "global-room", title: "Form group for Data Structures assignment", deadline: new Date(Date.now() + 86400000 * 3).toISOString(), status: "pending", creator: "System" }],
  resources: [], qa: [], security: { failedAttempts: [], blockedUsers: [] }, logs: []
};

function mergeDefaults(base, incoming = {}) {
  const state = { ...base, ...incoming };
  state.settings = { ...base.settings, ...(incoming.settings || {}) };
  state.settings.featureVisibility = { ...base.settings.featureVisibility, ...((incoming.settings && incoming.settings.featureVisibility) || {}) };

  // Migrate legacy backgroundImage -> backgroundImages.default
  if (!state.settings.backgroundImages) state.settings.backgroundImages = structuredClone(base.settings.backgroundImages);
  if (!state.settings.backgroundImages.pages) state.settings.backgroundImages.pages = {};
  if (!state.settings.backgroundImages.default) {
    state.settings.backgroundImages.default = state.settings.backgroundImage || "";
  }

  state.sessions = { ...base.sessions, ...(incoming.sessions || {}) };
  state.security = { ...base.security, ...(incoming.security || {}) };
  state.users = (incoming.users || []).map((u) => {
    const regNumber = normalizeRegNumber(u.regNumber || "");
    const canonicalEmail = (u.canonicalEmail || (regNumber ? regToHitEmail(regNumber) : (u.username || "").trim().toLowerCase()));
    return {
      ...u,
      regNumber,
      canonicalEmail,
      username: u.username || canonicalEmail,
      role: u.role || "student",
      part: u.part || "",
      password: u.password || "",
      createdAt: u.createdAt || new Date().toISOString(),
      lastLoginAt: u.lastLoginAt || "",
      downloadsReceived: Number.isFinite(u.downloadsReceived) ? u.downloadsReceived : 0
    };
  });
  state.courses = (incoming.courses || base.courses).map((c) => ({ id: c.id || crypto.randomUUID(), ...c }));
  state.resources = (incoming.resources || []).map((r) => ({ attachmentData: "", downloads: Number.isFinite(r.downloads) ? r.downloads : 0, ...r }));
  if (!state.chatrooms?.length) state.chatrooms = defaultRooms();
  return state;
}

function loadState() { return structuredClone(runtimeState || defaultState); }

async function initSupabase() {
  if (supabaseInitPromise) return supabaseInitPromise;
  supabaseInitPromise = import("https://esm.sh/@supabase/supabase-js")
    .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_ANON_KEY))
    .then((client) => { supabaseClient = client; return client; })
    .catch((error) => { console.warn("Supabase init failed.", error); return null; });
  return supabaseInitPromise;
}


// ===== Departments (DB source of truth) =====
const DEPT_CACHE_KEY = "edupath_departments_cache_v2";

function getDepartmentsCached(){
  try{
    const raw = localStorage.getItem(DEPT_CACHE_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr) && arr.length) return arr.filter(Boolean);
  }catch(e){}
  try{
    const st = loadState();
    if (st && Array.isArray(st.departments) && st.departments.length) return st.departments.filter(Boolean);
  }catch(e){}
  return [];
}

function setDepartmentsCached(list){
  const clean = (Array.isArray(list)?list:[]).map(s=>String(s||"").trim()).filter(Boolean);
  try{ localStorage.setItem(DEPT_CACHE_KEY, JSON.stringify(clean)); }catch(e){}
  try{
    if (typeof updateState === "function"){
      updateState((s)=>{ s.departments = clean; }, "sync departments");
    }else{
      const st = loadState(); st.departments = clean;
    }
  }catch(e){}
  return clean;
}

async function loadDepartmentsDb(){
  const supabase = await getSupabase();
  if (!supabase) return getDepartmentsCached();
  const { data, error } = await supabase.from("departments").select("name").order("name", {ascending:true});
  if (error) return getDepartmentsCached();
  const list = (data||[]).map(r=>String(r.name||"").trim()).filter(Boolean);
  if (list.length) setDepartmentsCached(list);
  return list.length ? list : getDepartmentsCached();
}
// ===== End Departments =====

async function getSupabase() { return supabaseClient || initSupabase(); }

async function persistStateToDatabase() {
  const supabase = await getSupabase();
  if (!runtimeState) return;

  // Always keep a local backup (works even when DB/RLS blocks writes)
  try { localStorage.setItem("edupath_state_backup", JSON.stringify(runtimeState)); } catch {}

  if (!supabase) return;
  if (isDbPersistDisabled()) return;

  // Only admins should persist app_state to DB (prevents RLS 403 for students)
  try {
    const st = loadState();
    if (!st?.sessions?.admin) return;
  } catch {}

  try {
    const { error } = await supabase
      .from("app_state")
      .upsert(
        { id: APP_STATE_ID, payload: runtimeState, updated_at: new Date().toISOString() },
        { onConflict: "id" }
      );

    if (error) {
      const msg = (error.message || "").toLowerCase();
      if (msg.includes("row level security") || msg.includes("rls") || msg.includes("unauthorized") || msg.includes("401")) {
        disableDbPersist();
      }
      console.warn("State persist failed (DB). Using local backup.", error.message || error);
    }
  } catch (error) {
    const msg = String(error?.message || error || "").toLowerCase();
    if (msg.includes("row level security") || msg.includes("rls") || msg.includes("unauthorized") || msg.includes("401")) {
      disableDbPersist();
    }
    console.warn("State persist failed (DB). Using local backup.", error?.message || error);
  }
}

async function hydrateStateFromDatabase() {
  const supabase = await getSupabase();

  // Start from defaults
  runtimeState = structuredClone(defaultState);

  // Merge local backup first (fast, works offline)
  try {
    const raw = localStorage.getItem("edupath_state_backup");
    if (raw) runtimeState = mergeDefaults(structuredClone(defaultState), JSON.parse(raw));
  } catch {}

  // Then try DB (if available) and let DB win
  if (!supabase || isDbPersistDisabled()) {
    syncSessionFromSupabaseAuth();
    return runtimeState;
  }

  try {
    const { data, error } = await supabase
      .from("app_state")
      .select("payload")
      .eq("id", APP_STATE_ID)
      .maybeSingle();

    if (error) {
      const msg = (error.message || "").toLowerCase();
      if (msg.includes("row level security") || msg.includes("rls") || msg.includes("unauthorized") || msg.includes("401")) {
        disableDbPersist();
      }
    }

    if (!error && data?.payload) {
      runtimeState = mergeDefaults(structuredClone(defaultState), data.payload);
      // refresh local backup from DB
      try { localStorage.setItem("edupath_state_backup", JSON.stringify(runtimeState)); } catch {}
    } else if (!error && !data?.payload) {
      // If DB has no row yet, attempt to seed it (best-effort)
      await persistStateToDatabase();
    }
  } catch (error) {
    console.warn("State hydrate failed (DB). Using local backup.", error?.message || error);
  }

  syncSessionFromSupabaseAuth();
  return runtimeState;
}

function updateState(mutator, logAction) {
  if (!runtimeState) runtimeState = structuredClone(defaultState);
  mutator(runtimeState);

  if (logAction) {
    const actor = runtimeState.sessions?.student
      ? {
          type: "student",
          name: runtimeState.sessions.student.name,
          username: runtimeState.sessions.student.username || null,
          regNumber: runtimeState.sessions.student.regNumber || runtimeState.sessions.student.reg || null,
          userId: runtimeState.sessions.student.userId || null
        }
      : (runtimeState.sessions?.admin
          ? {
              type: "admin",
              name: runtimeState.sessions.admin.name,
              username: runtimeState.sessions.admin.username || null,
              role: runtimeState.sessions.admin.role || null
            }
          : null);

    runtimeState.logs.unshift({
      id: crypto.randomUUID(),
      action: logAction,
      at: new Date().toISOString(),
      actor
    });
  }

  void persistStateToDatabase();
  return loadState();
}

function userKeyFromProfile(profile) { return profile ? (profile.regNumber || profile.id || profile.name) : ""; }
function isBlocked(identity) { return loadState().security.blockedUsers.includes(identity); }

function trackFailedAttempt(identity, area) {
  if (!identity) return;
  updateState((state) => {
    const existing = state.security.failedAttempts.find((entry) => entry.identity === identity && entry.area === area);
    if (existing) { existing.count += 1; existing.lastAttemptAt = new Date().toISOString(); }
    else state.security.failedAttempts.push({ identity, area, count: 1, lastAttemptAt: new Date().toISOString() });
  }, `failed sign-in attempt (${area})`);
}

function setCurrentSession(type, payload) {
  const updated = updateState((state) => {
    if (type === "student" && payload) {
      const stamp = new Date().toISOString();
      const normalizedReg = normalizeRegNumber(payload.regNumber);
      const normalizedEmail = (payload.canonicalEmail || regToHitEmail(normalizedReg)).trim().toLowerCase();
      const duplicate = state.users.find((u) => (u.regNumber === normalizedReg || (u.canonicalEmail || "").toLowerCase() === normalizedEmail) && u.regNumber !== normalizedReg);
      if (duplicate) throw new Error("Duplicate registration number or HIT email detected.");
      const ix = state.users.findIndex((u) => u.regNumber === normalizedReg);
      if (ix >= 0) {
        state.users[ix] = {
          ...state.users[ix],
          ...payload,
          regNumber: normalizedReg,
          canonicalEmail: normalizedEmail,
          username: normalizedEmail,
          lastLoginAt: stamp
        };
        payload = state.users[ix];
      } else {
        payload = {
          ...payload,
          regNumber: normalizedReg,
          canonicalEmail: normalizedEmail,
          username: normalizedEmail,
          role: payload.role || "student",
          createdAt: stamp,
          lastLoginAt: stamp,
          downloadsReceived: payload.downloadsReceived || 0
        };
        state.users.push(payload);
      }
    }
    // Prevent cross-session contamination
    if (type === "admin") {
      state.sessions.student = null;
      state.currentUserId = null;
      state.lastStudent = null;
      state.profileCache = null;
      state.userCache = null;
    }
    if (type === "student") {
      state.sessions.admin = null;
      state.currentAdminId = null;
      state.lastAdmin = null;
      state.adminCache = null;
    }
    state.sessions[type] = payload;
  }, `${type} signed in`);
  if (type === "student") void syncStudentProfileToSupabase(updated.sessions.student);
}

async function syncStudentProfileToSupabase(profile) {
  const supabase = await getSupabase();
  if (!supabase || !profile) return;
  try {
    const { data: userData } = await supabase.auth.getUser();
    await supabase.from("student_profiles").upsert({
      reg_number: profile.regNumber,
      auth_user_id: userData?.user?.id || null,
      full_name: profile.name,
      username: profile.username,
      department: profile.department,
      part: profile.part,
      last_login_at: profile.lastLoginAt || new Date().toISOString(),
      downloads_received: profile.downloadsReceived || 0
    }, { onConflict: "reg_number" });
  } catch (error) { console.warn("Profile sync warning", error); }
}

async function supabaseRegisterStudent(profile) {
  const supabase = await getSupabase();
  if (!supabase || !profile?.username || !profile?.password) return { ok: false, skipped: true };
  try {
    const email = emailFromUsername(profile.username);
    if (!email.endsWith("@hit.ac.zw")) return { ok: false, error: { message: "Only HIT emails allowed" } };
    const { data, error } = await supabase.auth.signUp({ email, password: profile.password, options: { data: { reg_number: profile.regNumber, role: "student" } } });
    if (error) return { ok: false, error };
    return { ok: true, data };
  } catch (error) { return { ok: false, error }; }
}

async function supabaseLoginStudent(username, password) {
  const supabase = await getSupabase();
  if (!supabase || !username || !password) return { ok: false, skipped: true };
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email: emailFromUsername(username), password });
    if (error) return { ok: false, error };
    return { ok: true, data };
  } catch (error) { return { ok: false, error }; }
}

async function syncSessionFromSupabaseAuthLegacy() {
  const supabase = await getSupabase();
  if (!supabase) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return;
    const email = session.user.email || "";
    const username = email.split("@")[0] || "";
    const current = loadState();
    const found = current.users.find((u) => (u.canonicalEmail || "") === email || (u.username || "") === username);
    if (found) updateState((s) => { s.sessions.student = found; }, "student session restored from supabase");
  } catch (error) { console.warn("Session sync warning", error); }
}

async function __checkBlockedAndRedirect(studentSession){
  try{
    const st = loadState();
    const key = String(studentSession?.regNumber || studentSession?.username || studentSession?.authUserId || "").trim();
    // 1) local blocklist
    const blocked = (st.security && Array.isArray(st.security.blockedUsers)) ? st.security.blockedUsers : [];
    if (key && blocked.includes(key)){
      // logout
      updateState((s)=>{ s.sessions.student = null; }, "Blocked user logout");
      alert("Your access has been blocked by an administrator.");
      window.location.href = "index.html";
      return;
    }
    // 2) DB flag (if column/policy exists)
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return;
    const { data, error } = await supabase.from("student_profiles").select("is_blocked").eq("auth_user_id", uid).maybeSingle();
    if (!error && data && data.is_blocked){
      updateState((s)=>{ s.sessions.student = null; }, "Blocked user logout (db)");
      alert("Your access has been blocked by an administrator.");
      window.location.href = "index.html";
    }
  }catch(e){}
}

function requireSession(type) {
  const state = loadState();
  if (!state.sessions[type]) { window.location.href = type === "admin" ? "admin-login.html" : "index.html"; return null; }
  const sess = state.sessions[type];
  if (type === "student" && sess) { __checkBlockedAndRedirect(sess); }
  return sess;
}



// --- Auth mode + state save helpers ---
// We keep a simple sessionStorage flag to prevent cross-session contamination
// between admin/faculty and student logins in the same browser session.
function setAuthMode(mode){
  try{ sessionStorage.setItem("edupath_auth_mode", String(mode||"")); }catch(e){}
}
function getAuthMode(){
  try{ return sessionStorage.getItem("edupath_auth_mode") || ""; }catch(e){ return ""; }
}
function clearAuthMode(){
  try{ sessionStorage.removeItem("edupath_auth_mode"); }catch(e){}
}

// Some modules still expect a saveState() helper (legacy localStorage version).
// Here we map it to the unified in-memory + Supabase app_state persistence.
function saveState(nextState){
  runtimeState = mergeDefaults(structuredClone(defaultState), nextState || {});
  void persistStateToDatabase();
  return loadState();
}



// ---- EDUPATH+ Loader ----
function ensureLoader() {
  if (document.getElementById("app-loader")) return;
  const wrap = document.createElement("div");
  wrap.id = "app-loader";
  wrap.className = "loader-overlay";
  wrap.innerHTML = `
    <div class="loader-card" role="status" aria-live="polite">
      <div class="loader-brand">
        <div class="loader-badge">EP+</div>
        <div>
          <div style="font-weight:800;letter-spacing:.02em">EDUPATH+</div>
          <div class="small muted">Loading…</div>
        </div>
      </div>
      <div class="loader-spinner" aria-hidden="true"></div>
    </div>`;
  document.body.appendChild(wrap);
}
function showLoader(message) {
  ensureLoader();
  const node = document.getElementById("app-loader");
  if (!node) return;
  node.classList.add("show");
  const msg = node.querySelector(".small.muted");
  if (msg && message) msg.textContent = message;
}
function hideLoader() {
  const node = document.getElementById("app-loader");
  if (!node) return;
  node.classList.remove("show");
}

function confirmLogout(type) {
  if (!confirm("Are you sure you want to log out?")) return;
  updateState((s) => { s.sessions.student = null; s.sessions.admin = null; }, `logout (${type})`);
    clearAuthMode();
  void getSupabase().then((s) => s?.auth?.signOut?.()).catch(()=>{});
  window.location.href = "index.html";
}

function applyThemeAndNav(pageKey) {
  const state = loadState();
  // Support small key mismatches across pages/older builds.
  const aliases = {
    adminPanel: ["admin-panel", "adminPanel"],
    "admin-panel": ["admin-panel", "adminPanel"],
    index: ["index"],
    dashboard: ["dashboard"],
    catalog: ["catalog"],
    support: ["support"],
    adminLogin: ["adminLogin"],
    chatrooms: ["chatrooms"],
    resources: ["resources"],
    qa: ["qa"],
    tasks: ["tasks"],
    tutors: ["tutors"],
    search: ["search"],
    profile: ["profile"],
    mycourses: ["mycourses"],
    copilot: ["copilot"],
    inbox: ["inbox"],
    "admin-courses": ["admin-courses"]
  };
  const keys = aliases[pageKey] || [pageKey];

  let bg = "";
  for (const k of keys) {
    bg = (state.settings.backgroundImages?.pages?.[k]) || "";
    if (bg) break;
  }
  if (!bg) {
    bg = (state.settings.backgroundImages?.default)
      || state.settings.backgroundImage
      || "";
  }
  if (bg) {
    document.body.classList.add("themed");
    document.body.style.backgroundImage = `linear-gradient(rgba(255,255,255,0.35), rgba(255,255,255,0.45)), url('${bg}')`;
    document.body.style.backgroundRepeat = 'no-repeat';
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';
  } else {
    document.body.classList.remove("themed");
    document.body.style.backgroundImage = "";
  }

  // Helps debugging + CSS hooks
  try{ document.body.setAttribute("data-bg-ready", bg ? "1" : "0"); }catch(e){}
  const announcement = document.querySelector("[data-announcement]");
  if (announcement) announcement.textContent = state.settings.announcement;
  document.querySelectorAll(".nav-link").forEach((node) => { if (node.dataset.page === pageKey) node.classList.add("active"); });
}

function renderTopbar(identityText) { const topIdentity = document.querySelector("[data-identity]"); if (topIdentity) topIdentity.textContent = identityText; }
function formatDate(iso) { return new Date(iso).toLocaleString(); }
function userCanAccessRoom(state, room, profile, isAdmin = false) { return isAdmin || room.members.includes("*") || room.members.includes(userKeyFromProfile(profile)); }
function roomNameById(state, roomId) { return state.chatrooms.find((room) => room.id === roomId)?.name || "Unknown Room"; }



// ------------------------------
// Supabase Auth + Profiles helpers
// ------------------------------
async function fetchStudentProfileByAuthUser(authUserId) {
  const supabase = await getSupabase();
  if (!supabase || !authUserId) return null;
  try {
    const { data, error } = await supabase.from("student_profiles").select("*").eq("auth_user_id", authUserId).maybeSingle();
    if (error) return null;
    return data || null;
  } catch (e) { return null; }
}

async function fetchStudentProfileByReg(regNumber) {
  const supabase = await getSupabase();
  if (!supabase || !regNumber) return null;
  try {
    const { data, error } = await supabase.from("student_profiles").select("*").eq("reg_number", regNumber).maybeSingle();
    if (error) return null;
    return data || null;
  } catch (e) { return null; }
}

// Keep session in sync with Supabase Auth so logins persist across devices.
async function syncSessionFromSupabaseAuth() {
  const supabase = await getSupabase();
  if (!supabase) return null;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return null;

    // If the browser is currently in admin/faculty mode, never overwrite it with a student restore.
    const mode = getAuthMode();
    const current = loadState();
    if (mode === "admin" || current.sessions?.admin) return session;

    const prof = await fetchStudentProfileByAuthUser(session.user.id);
    if (prof) {
      setCurrentSession("student", {
        id: session.user.id,
        name: prof.full_name || prof.username || prof.reg_number,
        department: prof.department || "",
        regNumber: prof.reg_number || "",
        canonicalEmail: session.user.email || regToHitEmail(prof.reg_number || ""),
        username: prof.username || session.user.email || "",
        part: prof.part || "",
        password: "",
        role: "student"
      });
    }
    return session;
  } catch (e) { return null; }
}


function applyTheme(theme){
  try{document.documentElement.setAttribute('data-theme', theme==='dark'?'dark':'light');}catch(e){}
}


// HTML escaping helper (used across pages)

function escapeHtml(str){
  return (str ?? "").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}



/** EDUPATH+ Copilot
 * Calls Supabase Edge Function /functions/v1/copilot (Groq-backed) to generate plan text.
 */
async function callCopilot(activitySummary, riskScore, coachMode="calm"){
  // Explicit headers to avoid 401 issues:
  // - apikey: anon key
  // - Authorization: user access token
  const supabase = await getSupabase();
  const { data: ses } = await supabase.auth.getSession();
  const token = ses?.session?.access_token;
  if (!token) throw new Error("Not authenticated. Please sign in again.");

  const url = `${SUPABASE_URL}/functions/v1/copilot`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ activitySummary, riskScore, coachMode })
  });

  const txt = await res.text();
  if (!res.ok){
    throw new Error(`Copilot failed (${res.status}): ${txt}`);
  }

  let data = {};
  try { data = JSON.parse(txt); } catch(e) {}

  // Return everything the UI needs (plan + why + micro + dashboard + coach)
  return {
    plan: data.plan || "",
    prediction: data.prediction || null,
    why_this_plan: Array.isArray(data.why_this_plan) ? data.why_this_plan : [],
    micro_tasks: Array.isArray(data.micro_tasks) ? data.micro_tasks : [],
    dashboard: data.dashboard || null,
    coach_mode: data.coach_mode || coachMode,
    used_fallback: !!data.used_fallback
  };
}
function todayISODate(){
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Best-effort: log an activity row for Copilot. */
async function logActivity(activity_type, ref_id=null, course_code=null, meta={}){
  try{
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return;
    await supabase.from("student_activity").insert({
      auth_user_id: uid,
      activity_type,
      ref_id,
      course_code,
      meta
    });
  }catch(e){
    // ignore (table may not exist yet)
  }
}

/** Read recent activity and turn it into a simple summary string. */
async function buildActivitySummary(days=7){
  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return "No activity yet.";

  const since = new Date(Date.now() - days*24*60*60*1000).toISOString();
  const { data, error } = await supabase
    .from("student_activity")
    .select("activity_type, created_at")
    .eq("auth_user_id", uid)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  if (error || !data) return "No activity yet.";

  const counts = {};
  for (const row of data){
    counts[row.activity_type] = (counts[row.activity_type]||0) + 1;
  }
  const parts = Object.entries(counts).map(([k,v])=>`${v} ${k.replaceAll("_"," ")}`);
  return parts.length ? parts.join(", ") : "No activity yet.";
}

/** Simple local risk score (free, always works). 0..100 */
function computeRiskScoreLocal(state){
  // Heuristic:
  // - more pending tasks => higher risk
  // - no activity streak => higher risk
  // - completing tasks lowers risk
  const me = state.sessions.student || state.sessions.admin;
  const key = me ? userKeyFromProfile(me) : null;

  const tasks = (state.tasks || []).filter(t => !key || t.ownerKey === key || !t.ownerKey);
  const pending = tasks.filter(t => !t.done).length;
  const done = tasks.filter(t => t.done).length;

  const lastLogin = me?.last_login_at || me?.lastLoginAt || null;
  let inactiveDays = 0;
  if (lastLogin){
    try{
      inactiveDays = Math.floor((Date.now() - new Date(lastLogin).getTime()) / (24*60*60*1000));
      if (inactiveDays < 0) inactiveDays = 0;
    }catch(e){}
  }

  let score = 10;
  score += Math.min(50, pending * 6);
  score += Math.min(25, inactiveDays * 3);
  score -= Math.min(20, done * 2);
  score = Math.max(0, Math.min(100, Math.round(score)));

  const reasons = [];
  if (pending >= 5) reasons.push("Many pending tasks");
  if (inactiveDays >= 3) reasons.push("Inactive for several days");
  if (done >= 3) reasons.push("Good progress completing tasks");

  let band = "low";
  if (score >= 70) band = "high";
  else if (score >= 40) band = "medium";

  return { score, band, reasons };
}

/** Save risk score to DB (optional). */






async function fetchRiskScoreFromDb(){
  // DB-driven risk score (safe):
  // Your current schema appears to store a summary row per user (auth_user_id, risk_score, risk_band, reasons, updated_at).
  // We read the latest row. If it doesn't exist, we fall back to local calculation.
  try{
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return computeRiskScoreLocal(loadState());

    // Try summary schema (auth_user_id)
    const r1 = await supabase
      .from("student_risk")
      .select("risk_score, risk_band, reasons, updated_at")
      .eq("auth_user_id", uid)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!r1.error && r1.data && typeof r1.data.risk_score === "number"){
      return {
        score: r1.data.risk_score,
        band: (r1.data.risk_band || bandFromRiskScore(r1.data.risk_score)),
        reasons: Array.isArray(r1.data.reasons) ? r1.data.reasons : []
      };
    }

    // Try alternative key name (user_id)
    const r2 = await supabase
      .from("student_risk")
      .select("risk_score, risk_band, reasons, updated_at")
      .eq("user_id", uid)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!r2.error && r2.data && typeof r2.data.risk_score === "number"){
      return {
        score: r2.data.risk_score,
        band: (r2.data.risk_band || bandFromRiskScore(r2.data.risk_score)),
        reasons: Array.isArray(r2.data.reasons) ? r2.data.reasons : []
      };
    }

    // If no DB row yet, use local model (or 0)
    return computeRiskScoreLocal(loadState());
  }catch(e){
    return computeRiskScoreLocal(loadState());
  }
}

function bandFromRiskScore(score){
  if (score >= 70) return "critical";
  if (score >= 40) return "high";
  if (score >= 20) return "medium";
  return "low";
}

async function upsertRiskToDb(score, band, reasons){
  try{
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return;
    await supabase.from("student_risk").upsert({
      auth_user_id: uid,
      risk_score: score,
      risk_band: band,
      reasons,
      updated_at: new Date().toISOString()
    });
  }catch(e){}
}

/** Save study plan to DB (optional). */
async function upsertPlanToDb(planText){
  try{
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return;
    await supabase.from("study_plan").upsert({
      auth_user_id: uid,
      plan_date: todayISODate(),
      plan: { text: planText },
      summary: planText
    }, { onConflict: "auth_user_id,plan_date" });
  }catch(e){}
}


/** Courses: best-effort fetch of enrolled courses from Supabase. */
async function getMyCourses(){
  try{
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return [];
    const { data, error } = await supabase
      .from("course_enrollments")
      .select("course_code, courses:course_code (code, title, department, credits)")
      .eq("auth_user_id", uid);
    if (error) return [];
    const rows = data || [];
    return rows.map(r => ({
      source: "enrollment",
      code: r.course_code,
      title: r.courses?.title || "",
      department: r.courses?.department || ""
    }));
  }catch(e){
    return [];
  }
}


async function getDeptPartCourses(department, part){
  try{
    const supabase = await getSupabase();
    if (!supabase) return [];
    const dept = (department || "").trim();
    const prt = (part || "").trim();
    if (!dept || !prt) return [];
    const { data, error } = await supabase
      .from("courses")
      .select("code,title,department,credits,part,lecturer")
      .eq("department", dept)
      .eq("part", prt)
      .order("code", { ascending: true })
      .limit(5);
    if (error) return [];
    return (data || []).map(c => ({
      code: c.code,
      title: c.title,
      department: c.department,
      part: c.part,
      credits: c.credits,
      lecturer: c.lecturer,
      source: "catalog"
    }));
  }catch(e){
    return [];
  }
}

/** Community signals: if DB tables exist, pull a few simple department stats. */
async function getCommunitySignals(department){
  const out = {
    dept: department || "",
    topResources: 0,
    recentQuestions: 0
  };
  if (!department) return out;
  try{
    const supabase = await getSupabase();

    // Try resources table
    try{
      const { count } = await supabase
        .from("resources")
        .select("id", { count: "exact", head: true })
        .eq("department", department);
      if (typeof count === "number") out.topResources = count;
    }catch(e){}

    // Try qa_questions table
    try{
      const { count } = await supabase
        .from("qa_questions")
        .select("id", { count: "exact", head: true })
        .eq("department", department);
      if (typeof count === "number") out.recentQuestions = count;
    }catch(e){}

    return out;
  }catch(e){
    return out;
  }
}

/** Builds a richer Copilot prompt context. */
async function buildCopilotContext(){
  const state = loadState();
  const actor = state.sessions.student || state.sessions.admin;
  const dept = actor?.department || actor?.dept || "";
  const myCourses = await getMyCourses();
  const activity = await buildActivitySummary(7);

  const comm = await getCommunitySignals(dept);

  const coursesLine = myCourses.length
    ? `Enrolled courses: ${myCourses.map(c=>c.code + (c.title?` (${c.title})`:"")).join(", ")}`
    : `Enrolled courses: none recorded`;

  const communityLine = dept
    ? `Department signals (${dept}): total resources=${comm.topResources}, total questions=${comm.recentQuestions}`
    : `Department signals: unknown`;

  return {
    dept,
    coursesLine,
    communityLine,
    activityLine: `Your recent activity (7d): ${activity}`
  };
}


async function dbTableExists(table){
  try{
    const supabase = await getSupabase();
    const { error } = await supabase.from(table).select("*", { count: "exact", head: true }).limit(1);
    return !error;
  }catch(e){ return false; }
}

async function getMyDepartment(){
  try{
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return null;
    const { data, error } = await supabase.from("student_profiles").select("department").eq("auth_user_id", uid).single();
    if (error) return null;
    return data?.department || null;
  }catch(e){ return null; }
}

/** Resources: read approved resources for my department (or my rooms if room_id exists). */
async function fetchResourcesCommunity({ department=null, course_code=null } = {}){
  const supabase = await getSupabase();
  let q = supabase.from("resources").select("*").eq("status","approved");
  if (useStats) q = q.order("interactions", { ascending: false }).order("created_at", { ascending: false });
  else q = q.order("created_at", { ascending: false }).limit(200);
  if (department) q = q.eq("department", department);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function submitResourceDb({ title, description, url, department, course_code }){
  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Not authenticated");
  const payload = {
    auth_user_id: uid,
    title, description, url,
    department, course_code,
    status: "pending"
  };
  const { error } = await supabase.from("resources").insert(payload);
  if (error) throw error;
  await logActivity("resource_upload", null, course_code || null, { title });
}

async function fetchQACommunity({ department=null } = {}){
  const supabase = await getSupabase();
  let useStats = await dbTableExists("qa_question_stats");
  let q = useStats ? supabase.from("qa_question_stats").select("*") : supabase.from("qa_questions").select("*").eq("status","visible");
  if (useStats) q = q.order("interactions", { ascending: false }).order("created_at", { ascending: false });
  else q = q.order("created_at", { ascending: false }).limit(200);
  if (department) q = q.eq("department", department);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function fetchAnswers(question_id){
  const supabase = await getSupabase();
  const { data, error } = await supabase.from("qa_answers").select("*").eq("question_id", question_id).order("created_at",{ascending:true});
  if (error) throw error;
  return data || [];
}

// =========================
// Q&A Answer reactions + comments (DB-backed, optional)
// Tables (recommended):
// - qa_answer_reactions(answer_id, user_id, value)
// - qa_answer_comments(id, answer_id, author_id/auth_user_id/user_id, body)
// These helpers are defensive: if tables are missing, they throw a clear error.
// =========================

async function fetchAnswerReactionBundle(answerIds = []){
  const out = {};
  if (!answerIds.length) return out;
  if (!(await dbTableExists("qa_answer_reactions"))) return out;

  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  const { data, error } = await supabase
    .from("qa_answer_reactions")
    .select("answer_id,user_id,value")
    .in("answer_id", answerIds);
  if (error) throw error;

  (data || []).forEach((r) => {
    const aid = String(r.answer_id);
    if (!out[aid]) out[aid] = { likeCount: 0, dislikeCount: 0, my: "" };
    if (r.value === 1) out[aid].likeCount += 1;
    if (r.value === -1) out[aid].dislikeCount += 1;
    if (uid && r.user_id === uid) out[aid].my = r.value === 1 ? "like" : "dislike";
  });
  return out;
}

async function setAnswerReaction({ answer_id, value }){
  if (!(await dbTableExists("qa_answer_reactions"))) throw new Error("qa_answer_reactions table missing. Run the migration.");
  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Not authenticated");

  // Toggle behavior: clicking same value clears reaction.
  const { data: existing, error: e1 } = await supabase
    .from("qa_answer_reactions")
    .select("value")
    .eq("answer_id", answer_id)
    .eq("user_id", uid)
    .maybeSingle();
  if (e1) throw e1;

  if (existing && existing.value === value){
    const { error } = await supabase
      .from("qa_answer_reactions")
      .delete()
      .eq("answer_id", answer_id)
      .eq("user_id", uid);
    if (error) throw error;
    return;
  }

  const { error } = await supabase
    .from("qa_answer_reactions")
    .upsert({ answer_id, user_id: uid, value }, { onConflict: "answer_id,user_id" });
  if (error) throw error;
}

async function fetchAnswerCommentsBundle(answerIds = []){
  const out = {};
  if (!answerIds.length) return out;
  if (!(await dbTableExists("qa_answer_comments"))) return out;

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("qa_answer_comments")
    .select("*")
    .in("answer_id", answerIds)
    .order("created_at", { ascending: true });
  if (error) throw error;

  (data || []).forEach((c) => {
    const aid = String(c.answer_id);
    if (!out[aid]) out[aid] = [];
    out[aid].push(c);
  });
  return out;
}

async function addAnswerComment({ answer_id, body }){
  if (!(await dbTableExists("qa_answer_comments"))) throw new Error("qa_answer_comments table missing. Run the migration.");
  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Not authenticated");

  // Try common author columns in order
  let res = await supabase
    .from("qa_answer_comments")
    .insert({ answer_id, author_id: uid, body })
    .select("*")
    .single();
  if (res.error){
    res = await supabase
      .from("qa_answer_comments")
      .insert({ answer_id, auth_user_id: uid, body })
      .select("*")
      .single();
  }
  if (res.error){
    res = await supabase
      .from("qa_answer_comments")
      .insert({ answer_id, user_id: uid, body })
      .select("*")
      .single();
  }
  if (res.error) throw res.error;
  return res.data;
}

async function submitQuestionDb({ title, body, department }){
  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Not authenticated");

  // Try newer schema first (author_id). If it fails, fallback to legacy auth_user_id.
  const base = { title, body, department, status: "visible" };
  let inserted = null;

  let res = await supabase.from("qa_questions").insert({ ...base, author_id: uid }).select("*").single();
  if (res.error){
    res = await supabase.from("qa_questions").insert({ ...base, auth_user_id: uid }).select("*").single();
  }
  if (res.error) throw res.error;
  inserted = res.data;

  try { await logActivity("qa_asked", inserted?.id ? String(inserted.id) : null, null, { title, department }); } catch(e){}

  return inserted;
}

async function submitAnswerDb({ question_id, body }){
  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Not authenticated");
  const { data, error } = await supabase.from("qa_answers").insert({
    auth_user_id: uid,
    question_id,
    body
  }).select("*").single();
  if (error) throw error;
  await logActivity("qa_answered", data?.id ? String(data.id) : null, null, { question_id });
  return {
      plan: data.plan || "",
      prediction: data.prediction || null
    };
}


async function fetchMyCoursesDb(){
  try{
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return [];
    const { data, error } = await supabase.from("course_enrollments").select("course_code, courses(title, department, credits)").eq("auth_user_id", uid);
    if (error || !data) return [];
    return data.map(row => ({
      code: row.course_code,
      title: row.courses?.title || row.course_code,
      department: row.courses?.department || null,
      credits: row.courses?.credits || 0
    }));
  }catch(e){ return []; }
}

async function fetchDepartmentSignals(department){
  const out = { resources: 0, questions: 0 };
  try{
    if (await dbTableExists("resources")){
      const supabase = await getSupabase();
      const { count } = await supabase.from("resources").select("*", { count: "exact", head: true }).eq("status","approved").eq("department", department);
      out.resources = count || 0;
    }
  }catch(e){}
  try{
    if (await dbTableExists("qa_questions")){
      const supabase = await getSupabase();
      const { count } = await supabase.from("qa_questions").select("*", { count: "exact", head: true }).eq("status","visible").eq("department", department);
      out.questions = count || 0;
    }
  }catch(e){}
  return out;
}


async function fetchMyProfile(){
  try{
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return null;
    const { data, error } = await supabase
      .from("student_profiles")
      .select("auth_user_id, name, username, reg_number, department, part, role, recovery_email, last_login_at")
      .eq("auth_user_id", uid)
      .single();
    if (error) return null;
    return {
      plan: data.plan || "",
      prediction: data.prediction || null
    };
  }catch(e){ return null; }
}

async function updateMyPart(newPart){
  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Not authenticated");

  const { error } = await supabase.from("student_profiles").update({ part: newPart }).eq("auth_user_id", uid);
  if (error) throw error;

  // server-side limit is enforced by trigger if installed; client also tracks UI feedback
  try{
    await supabase.from("student_part_changes").insert({ auth_user_id: uid, new_part: newPart });
  }catch(e){ /* if table not installed yet, ignore */ }
}


function initMobileSidebar(){
  const btn = document.getElementById("btn-sidebar-toggle");
  const sidebar = document.querySelector("[data-sidebar]") || document.querySelector(".sidebar");
  if (!btn || !sidebar) return;

  btn.addEventListener("click", ()=>{
    sidebar.classList.toggle("open");
  });

  // Close when clicking outside
  document.addEventListener("click", (e)=>{
    if (window.matchMedia("(max-width: 980px)").matches){
      const inside = sidebar.contains(e.target) || btn.contains(e.target);
      if (!inside) sidebar.classList.remove("open");
    }
  });
}

document.addEventListener('DOMContentLoaded', initMobileSidebar);


async function logSecurityEvent(event_type, details = {}){
  try{
    if (!(await dbTableExists("security_events"))) return;
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id || null;
    const payload = {
      auth_user_id: uid,
      event_type,
      details
    };
    await supabase.from("security_events").insert(payload);
  }catch(e){ /* ignore */ }
}


async function saveResourceDb(resource_id){
  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Not authenticated");
  const { error } = await supabase.from("saved_resources").insert({ auth_user_id: uid, resource_id });
  if (error && !String(error.message||"").toLowerCase().includes("duplicate")) throw error;
}

async function unsaveResourceDb(resource_id){
  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Not authenticated");
  const { error } = await supabase.from("saved_resources").delete().eq("auth_user_id", uid).eq("resource_id", resource_id);
  if (error) throw error;
}

async function fetchSavedResourcesDb(){
  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return [];
  const { data, error } = await supabase
    .from("saved_resources")
    .select("resource_id, created_at, resources(id,title,description,url,department,course_code,created_at)")
    .eq("auth_user_id", uid)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data||[]).map(r => ({ ...r.resources, saved_at: r.created_at }));
}


async function updateQuestionDb(question_id, { title, body }){
  const supabase = await getSupabase();
  const { error } = await supabase.from("qa_questions").update({ title, body }).eq("id", question_id);
  if (error) throw error;
}
async function deleteQuestionDb(question_id){
  const supabase = await getSupabase();
  const { error } = await supabase.from("qa_questions").delete().eq("id", question_id);
  if (error) throw error;
}


async function setQAReactionDb(question_id, value){
  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Not authenticated");
  // Toggle behavior: if same value exists -> remove; else upsert
  const { data: existing } = await supabase
    .from("qa_reactions")
    .select("value")
    .eq("auth_user_id", uid)
    .eq("question_id", question_id)
    .maybeSingle();

  if (existing?.value === value){
    const { error } = await supabase.from("qa_reactions").delete().eq("auth_user_id", uid).eq("question_id", question_id);
    if (error) throw error;
    return 0;
  }

  const { error } = await supabase.from("qa_reactions").upsert({ auth_user_id: uid, question_id, value });
  if (error) throw error;
  return value;
}

async function fetchMyQAReaction(question_id){
  try{
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return 0;
    const { data, error } = await supabase
      .from("qa_reactions")
      .select("value")
      .eq("auth_user_id", uid)
      .eq("question_id", question_id)
      .maybeSingle();
    if (error) return 0;
    return data?.value || 0;
  }catch(e){ return 0; }
}

async function addQACommentDb(question_id, text){
  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Not authenticated");
  const { error } = await supabase.from("qa_comments").insert({ auth_user_id: uid, question_id, body: text });
  if (error) throw error;
}

async function fetchQACommentsDb(question_id){
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("qa_comments")
    .select("id, body, auth_user_id, created_at")
    .eq("question_id", question_id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return data || [];
}


async function usernameAvailable(username){
  const supabase = await getSupabase();
  const u = (username || "").trim().toLowerCase();
  if (!u) return false;
  const { data, error } = await supabase.from("student_profiles").select("id").ilike("username", u).limit(1);
  if (error) return true; // don't block if table not ready
  return !data || data.length === 0;
}

/* wireMobileMenu removed */

/* ensureMobileMenuButton removed */

/* ensureFloatingMenuButton removed */

/* MENU_TOGGLE_DELEGATION removed */

function enforceBrandingEPPlus(){
  // Header logo
  document.querySelectorAll(".logo").forEach((el)=>{
    el.innerHTML = '<span class="logo-ep">EP</span><span class="plus">+</span>';
  });
  // Brand title if present
  document.querySelectorAll(".brand-title").forEach((el)=>{
    const txt = el.textContent || "";
    if (!txt.toUpperCase().includes("EDUPATH")) el.textContent = "EDUPATH+";
    // ensure plus span exists for gold plus
    if (!el.querySelector(".plus")){
      el.innerHTML = 'EDUPATH<span class="plus">+</span>';
    }
  });
}
document.addEventListener("DOMContentLoaded", enforceBrandingEPPlus);

function clearAllSessionsHard(){
  // 1) Clear in-memory + database app_state sessions (source of truth)
  try{
    updateState((st)=>{
      if (st.sessions){
        st.sessions.student = null;
        st.sessions.admin = null;
      }
      st.currentUserId = null;
      st.currentAdminId = null;
      st.lastUser = null;
      st.lastStudent = null;
      st.lastAdmin = null;
      st.profileCache = null;
      st.userCache = null;
      st.adminCache = null;
    }, { type: "logout", severity: "info", note: "Hard cleared sessions" });
  }catch(e){ /* ignore */ }

  // 2) Sign out Supabase auth session (prevents auto re-hydrate back to old user)
  try{
    getSupabase().then((sb)=>sb?.auth?.signOut?.()).catch(()=>{});
  }catch(e){}

  // 3) Clear any stray localStorage keys (older builds)
  try{
    ["app_state","edu_state","state","session","sessions","currentUser","currentUserId","currentAdmin","currentAdminId","lastUser","lastAdmin","lastStudent","profileCache"]
      .forEach(k=> localStorage.removeItem(k));
  }catch(e){}
}

function attachLogout(){
  const btn = document.getElementById("btn-logout") || document.getElementById("logout-student") || document.getElementById("logout-admin");
  if (!btn) return;
  btn.addEventListener("click", async ()=>{
    clearAllSessionsHard();
    // small delay so state persist/signOut can fire
    await new Promise(r=>setTimeout(r, 150));
    window.location.href = "index.html";
  });
}


// ===== Toast notifications (shared) =====
const DISPLAY_TIMEZONE = "Africa/Harare";
function formatHarareDateTime(isoString){
  if(!isoString) return "-";
  try{
    return new Intl.DateTimeFormat("en-ZW", {timeZone: DISPLAY_TIMEZONE, year:"numeric", month:"short", day:"2-digit", hour:"2-digit", minute:"2-digit"}).format(new Date(isoString));
  }catch(e){ return isoString; }
}
function ensureToastContainer(){
  let host = document.getElementById("toast-host");
  if(host) return host;
  host = document.createElement("div");
  host.id = "toast-host";
  host.className = "toast-host";
  document.body.appendChild(host);
  return host;
}
function toast(type, message){
  const host = ensureToastContainer();
  const node = document.createElement("div");
  node.className = `toast toast-${type || "info"}`;
  node.textContent = message || "Done";
  host.appendChild(node);
  requestAnimationFrame(()=>node.classList.add("show"));
  setTimeout(()=>{ node.classList.remove("show"); setTimeout(()=>node.remove(), 240); }, 2800);
}
// ===== End toast =====
