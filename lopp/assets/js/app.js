
// ===== Admin User Management: Live DB users (student_profiles) =====
async function refreshAdminUsersFromDb(){
  try{
    const admin = loadState()?.sessions?.admin;
    if (!admin) return [];
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from("student_profiles")
      .select("name,department,part,reg_number,regnum,registration_number,username,auth_user_id,created_at,is_blocked")
      .order("created_at", { ascending: false })
      .limit(500);

    if (error){
      console.warn("[admin-users] DB load failed:", error.message);
      return [];
    }

    const users = (data||[]).map((p)=>({
      name: p.name || "Student",
      department: p.department || "",
      part: p.part || "-",
      regNumber: p.reg_number || p.regnum || p.registration_number || "",
      username: p.username || "",
      authUserId: p.auth_user_id || "",
      isBlockedDb: !!p.is_blocked
    }));

    window.__edupath_admin_db_users = users;
    return users;
  }catch(e){
    console.warn("[admin-users] DB load exception:", e);
    return [];
  }
}

function getAdminUserList(state){
  const dbUsers = Array.isArray(window.__edupath_admin_db_users) ? window.__edupath_admin_db_users : null;
  if (dbUsers && dbUsers.length) return dbUsers;
  return state.users || [];
}
// ===== End Admin User Management: Live DB users =====


// ===== DB-backed Admin Notices + DM Unread =====
async function dbTableExists(name){
  try{
    const supabase = await getSupabase();
    // PostgREST typically does NOT expose information_schema; instead, probe the table directly.
    const { error } = await supabase.from(name).select("*", { head: true, count: "exact" }).limit(1);
    if (!error) return true;

    const msg = String(error.message || "").toLowerCase();
    // Missing table / relation
    if (msg.includes("does not exist") || msg.includes("relation") || msg.includes("schema cache")){
      return false;
    }
    // Permission/RLS issues mean the table exists but is restricted.
    return true;
  }catch(e){
    return false;
  }
}

async function resolveStudentUidByIdentity(identity){
  const supabase = await getSupabase();
  const key = normalizeIdentityKey(identity);

  // Try multiple common column names safely
  const columnsToTry = ["reg_number","regnum","registration_number","username","auth_user_id"];
  
  for (const col of columnsToTry){
    try{
      const { data, error } = await supabase
        .from("student_profiles")
        .select("auth_user_id")
        .eq(col, key)
        .maybeSingle();

      if (!error && data && data.auth_user_id){
        return data.auth_user_id;
      }
    }catch(e){}
  }

  // If it already looks like a UUID, assume it's the UID
  if (isUuidLike(key)) return key;

  return null;
}

async function sendAdminNoticeToUser(identity, fromLabel, message){
  const supabase = await getSupabase();
  if (!(await dbTableExists("admin_private_notices"))) { /* will attempt insert anyway; table probe can fail on schema cache */ }
  const toUid = await resolveStudentUidByIdentity(identity);
  if (!toUid) return { ok:false, reason:"user_not_found" };
  const payload = { to_user_id: toUid, to_identity: normalizeIdentityKey(identity), from_admin: fromLabel || "Admin", message: String(message||"").trim() };
  const { error } = await supabase.from("admin_private_notices").insert(payload);
  if (error) return { ok:false, reason:error.message };
  return { ok:true };
}

async function loadAdminNoticesForUser(uid){
  const supabase = await getSupabase();
  if (!(await dbTableExists("admin_private_notices"))){
    return { ok:false, reason:"missing_table", data:[] };
  }
  const { data, error } = await supabase.from("admin_private_notices")
    .select("*")
    .eq("to_user_id", uid)
    .order("created_at", { ascending:false })
    .limit(50);
  if (error) return { ok:false, reason:error.message, data:[] };
  return { ok:true, data: data||[] };
}

async function markAdminNoticeRead(noticeId){
  const supabase = await getSupabase();
  try{
    await supabase.from("admin_private_notices").update({ read_at: new Date().toISOString() }).eq("id", noticeId);
  }catch(e){}
}

async function getUnreadAdminNoticeCountDb(uid){
  const supabase = await getSupabase();
  if (!(await dbTableExists("admin_private_notices"))){
    return 0;
  }
  const { count } = await supabase.from("admin_private_notices")
    .select("id", { count:"exact", head:true })
    .eq("to_user_id", uid)
    .is("read_at", null);
  return count || 0;
}

// DM unread using dm_reads table (no dm_messages schema change)
async function ensureDmReadsTable(){
  if (await dbTableExists("dm_reads")) return true;
  return false;
}

async function upsertDmRead(me, peer){
  const supabase = await getSupabase();
  if (!(await ensureDmReadsTable())) return;
  const payload = { me, peer, last_read_at: new Date().toISOString() };
  // upsert needs unique constraint (me,peer) in SQL; if missing, fallback to insert
  try{
    const { error } = await supabase.from("dm_reads").upsert(payload, { onConflict:"me,peer" });
    if (!error) return;
  }catch(e){}
  try{ await supabase.from("dm_reads").insert(payload); }catch(e){}
}

async function getUnreadDmCountDb(uid){
  const supabase = await getSupabase();
  if (!(await dbTableExists("dm_messages")) || !(await ensureDmReadsTable())) return 0;
  // get last_read for each peer
  const { data: reads } = await supabase.from("dm_reads").select("peer,last_read_at").eq("me", uid).limit(500);
  const map = new Map((reads||[]).map(r=>[r.peer, r.last_read_at]));
  // count unread messages: receiver is uid, created_at > last_read_at OR no read record
  // Supabase can't do dynamic per-peer easily client-side, so approximate: count where receiver_id=uid AND created_at > minLastRead OR no reads
  // Better: fetch latest 200 received, filter client-side against map.
  const { data: msgs, error } = await supabase.from("dm_messages")
    .select("sender_id,created_at")
    .eq("receiver_id", uid)
    .order("created_at", { ascending:false })
    .limit(300);
  if (error) return 0;
  let c=0;
  for (const m of (msgs||[])){
    const lr = map.get(m.sender_id);
    if (!lr) { c++; continue; }
    if (new Date(m.created_at).getTime() > new Date(lr).getTime()) c++;
  }
  return c;
}
// ===== End DB-backed Admin Notices + DM Unread =====


// ===== Inbox Unread (Admin Notices) + Badge =====
function getRecipientKeyForReads(session){
  return String(session?.authUserId || session?.userId || session?.regNumber || session?.username || "").trim();
}
function getUnreadAdminNoticeCount(state, studentSession){
  try{
    const st = state || loadState();
    const sess = studentSession || st.sessions?.student;
    if (!sess) return 0;
    const { uid } = { uid: sess.authUserId || sess.userId || "" };
    const myIds = [sess.regNumber, sess.username, uid].filter(Boolean).map(x=>String(x));
    const notices = Array.isArray(st.admin_private_notices) ? st.admin_private_notices : [];
    const recipientKey = getRecipientKeyForReads(sess) || (uid || sess.regNumber || sess.username || "");
    const reads = (st.admin_notice_reads && st.admin_notice_reads[recipientKey]) ? st.admin_notice_reads[recipientKey] : [];
    const readSet = new Set((reads||[]).map(String));
    let c = 0;
    for (const n of notices){
      if (!n) continue;
      if (myIds.includes(String(n.to))){
        const nid = String(n.id || "");
        if (nid && !readSet.has(nid)) c++;
      }
    }
    return c;
  }catch(e){ return 0; }
}
async function updateInboxBadge(){
  try{
    const st = loadState();
    const sess = st.sessions?.student;
    const el = document.getElementById("inbox-badge");
    if (!el || !sess) return;
    // Prefer DB-backed counts (cross-device)
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id || sess.authUserId || sess.userId || "";
    let adminUnread = 0;
    let dmUnread = 0;

    // Admin notices (DB)
    adminUnread = uid ? await getUnreadAdminNoticeCountDb(uid) : 0;
    // DM unread (DB)
    dmUnread = uid ? await getUnreadDmCountDb(uid) : 0;

    const total = (adminUnread||0) + (dmUnread||0);
    const dot = document.getElementById("inbox-dot");
    const link = document.getElementById("nav-inbox-link");
    if (total > 0){
      el.textContent = String(total);
      el.style.display = "inline-flex";
      if (dot) dot.style.display = "inline-block";
      if (link) link.classList.add("has-unread");
    }else{
      el.textContent = "";
      el.style.display = "none";
      if (dot) dot.style.display = "none";
      if (link) link.classList.remove("has-unread");
    }
  }catch(e){}
}
// ===== End Inbox Unread + Badge =====



function ensureInteractions(state){
  if (!state.interactions) state.interactions = {};
  return state.interactions;
}
function itemKey(type, id){ return `${type}:${id}`; }

function getInteraction(state, type, id){
  const map = ensureInteractions(state);
  const k = itemKey(type, id);
  if (!map[k]) map[k] = { likes: [], dislikes: [], comments: [] };
  return map[k];
}

function toggleLike(state, type, id, userKey){
  const inter = getInteraction(state, type, id);
  const li = inter.likes.indexOf(userKey);
  const di = inter.dislikes.indexOf(userKey);
  if (di >= 0) inter.dislikes.splice(di,1);
  if (li >= 0) inter.likes.splice(li,1);
  else inter.likes.push(userKey);
}

function toggleDislike(state, type, id, userKey){
  const inter = getInteraction(state, type, id);
  const di = inter.dislikes.indexOf(userKey);
  const li = inter.likes.indexOf(userKey);
  if (li >= 0) inter.likes.splice(li,1);
  if (di >= 0) inter.dislikes.splice(di,1);
  else inter.dislikes.push(userKey);
}

function addComment(state, type, id, userKey, text){
  const inter = getInteraction(state, type, id);
  inter.comments.push({ id: crypto.randomUUID(), userKey, text: text.trim(), ts: new Date().toISOString() });
}

function renderLikeBar(type, id, userKey, override){
  const state = loadState();
  const inter = override || getInteraction(state, type, id);
  const liked = !!inter.liked || (inter.likes ? inter.likes.includes(userKey) : false);
  const disliked = !!inter.disliked || (inter.dislikes ? inter.dislikes.includes(userKey) : false);
  const likeCount = inter.likeCount ?? (inter.likes ? inter.likes.length : 0);
  const dislikeCount = inter.dislikeCount ?? (inter.dislikes ? inter.dislikes.length : 0);
  const cCount = inter.commentCount ?? (inter.comments ? inter.comments.length : 0);

  return `
    <div class="likebar" data-likebar="${escapeHtml(type)}:${escapeHtml(id)}">
      <button class="chip ${liked?'on':''}" data-act="like" type="button">👍 <span>${likeCount}</span></button>
      <button class="chip ${disliked?'on':''}" data-act="dislike" type="button">👎 <span>${dislikeCount}</span></button>
      <button class="chip" data-act="toggleComments" type="button">💬 <span>${cCount}</span> Comments</button>
    </div>
    <div class="comments" data-comments="${escapeHtml(type)}:${escapeHtml(id)}" hidden>
      <div class="comment-list">
        ${(inter.commentsList || inter.comments || []).slice(-50).map(c=>`
          <div class="comment">
            <div class="comment-head">
              <strong>${escapeHtml(c.userKey)}</strong>
              <span class="muted small">${escapeHtml(new Date(c.ts).toLocaleString())}</span>
            </div>
            <div class="comment-body">${escapeHtml(c.text)}</div>
          </div>
        `).join("") || `<div class="empty small muted">No comments yet.</div>`}
      </div>
      <div class="comment-compose">
        <input class="input" data-comment-input placeholder="Write a comment…" />
        <button class="btn btn-primary" data-act="sendComment" type="button">Post</button>
      </div>
    </div>
  `;
}

function wireLikeBars(rootEl, type, userKey, opts){
  rootEl.querySelectorAll(".likebar").forEach((bar)=>{
    bar.addEventListener("click", (e)=>{
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const key = bar.getAttribute("data-likebar") || "";
      const [t, id] = key.split(":");
      if (!id) return;
      const act = btn.getAttribute("data-act");

      if (act === "toggleComments"){
        const block = rootEl.querySelector(`.comments[data-comments="${CSS.escape(key)}"]`);
        if (block) block.hidden = !block.hidden;
        return;
      }

      if (act === "like" || act === "dislike"){
        if (opts?.dbModeQA && t === "qa"){
          (async ()=>{
            try{
              const qid = Number(id);
              const value = (act === "like") ? 1 : -1;
              await setQAReactionDb(qid, value);
              // refresh counts for this question
              const supabase = await getSupabase();
              const { data: stat } = await supabase.from("qa_question_stats").select("*").eq("id", qid).single();
              const myVal = await fetchMyQAReaction(qid);
              const fresh = renderLikeBar("qa", String(qid), userKey, {
                liked: myVal === 1,
                disliked: myVal === -1,
                likeCount: stat?.like_count ?? 0,
                dislikeCount: stat?.dislike_count ?? 0,
                commentCount: stat?.comment_count ?? 0,
                commentsList: []
              });
              const wrapper = bar.parentElement;
              if (wrapper) wrapper.innerHTML = fresh;
              wireLikeBars(wrapper, "qa", userKey, opts);
    }catch(e){ alert(e.message || "Could not react"); }
          })();
          return;
        }

        updateState((s)=>{
          if (act === "like") toggleLike(s, t, id, userKey);
          else toggleDislike(s, t, id, userKey);
        }, "reaction updated");
        const fresh = renderLikeBar(t, id, userKey);
        const wrapper = bar.parentElement;
        if (wrapper) wrapper.innerHTML = fresh;
        wireLikeBars(wrapper, t, userKey, opts);
        return;
      }
    });
  });

  rootEl.querySelectorAll(".comments").forEach((block)=>{
    block.addEventListener("click", (e)=>{
      const btn = e.target.closest("button[data-act='sendComment']");
      if (!btn) return;
      const key = block.getAttribute("data-comments") || "";
      const [t, id] = key.split(":");
      const input = block.querySelector("input[data-comment-input]");
      const text = (input?.value || "").trim();
      if (!text) return;
      if (opts?.dbModeQA && t === "qa"){
        (async ()=>{
          try{
            const qid = Number(id);
            await addQACommentDb(qid, text);
            if (input) input.value = "";
            const comments = await fetchQACommentsDb(qid);
            const supabase = await getSupabase();
            const { data: stat } = await supabase.from("qa_question_stats").select("*").eq("id", qid).single();
            const myVal = await fetchMyQAReaction(qid);
            const fresh = renderLikeBar("qa", String(qid), userKey, {
              liked: myVal === 1,
              disliked: myVal === -1,
              likeCount: stat?.like_count ?? 0,
              dislikeCount: stat?.dislike_count ?? 0,
              commentCount: stat?.comment_count ?? comments.length,
              commentsList: comments.map(c=>({ author: "Student", text: c.body, createdAt: c.created_at }))
            });
            const wrapper = block.parentElement;
            if (wrapper) wrapper.innerHTML = fresh;
            wireLikeBars(wrapper, "qa", userKey, opts);
    }catch(e){ alert(e.message || "Could not comment"); }
        })();
        return;
      }

      updateState((s)=> addComment(s, t, id, userKey, text), "comment added");
      if (input) input.value = "";
      // Re-render comment block
      const wrapper = block.parentElement;
      if (wrapper){
        wrapper.querySelector(`.comments[data-comments="${CSS.escape(key)}"]`)?.remove();
        wrapper.insertAdjacentHTML("beforeend", renderLikeBar(t, id, userKey).split("</div>")[1]); // not reliable
      }
    });
  });
}


function escapeHtml(str){
  return (str ?? "").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function byId(id) { return document.getElementById(id); }


// ===== Resource Upload Progress UI =====
function ensureUploadOverlay(){
  let ov = document.getElementById("edupath-upload-overlay");
  if (ov) return ov;
  ov = document.createElement("div");
  ov.id = "edupath-upload-overlay";
  ov.style.cssText = "position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:9999;background:rgba(0,0,0,.45)";
  ov.innerHTML = `
    <div style="width:min(520px,92vw);background:#111827;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:18px 18px 16px;box-shadow:0 12px 40px rgba(0,0,0,.45);">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <div style="width:10px;height:10px;border-radius:999px;background:#7c3aed;box-shadow:0 0 18px rgba(124,58,237,.65)"></div>
        <div style="font-weight:700;color:#f9fafb;">EDUPATH+ is uploading your resource…</div>
      </div>
      <div id="edupath-upload-sub" style="color:rgba(255,255,255,.75);font-size:13px;margin-bottom:12px;">
        Sending to database, then routing to Admin Approval.
      </div>
      <div style="height:10px;border-radius:999px;background:rgba(255,255,255,.10);overflow:hidden;">
        <div id="edupath-upload-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#ef4444);border-radius:999px;transition:width .18s ease;"></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;">
        <div id="edupath-upload-pct" style="color:rgba(255,255,255,.75);font-size:12px;">0%</div>
        <div id="edupath-upload-done" style="color:#34d399;font-size:12px;display:none;">✓ Sent</div>
      </div>
    </div>
  `;
  document.body.appendChild(ov);
  return ov;
}

function showUploadProgress(){
  const ov = ensureUploadOverlay();
  ov.style.display = "flex";
  setUploadProgress(0);
}
function hideUploadProgress(){
  const ov = ensureUploadOverlay();
  ov.style.display = "none";
}
function setUploadProgress(pct, subText){
  const bar = document.getElementById("edupath-upload-bar");
  const pctEl = document.getElementById("edupath-upload-pct");
  const sub = document.getElementById("edupath-upload-sub");
  const done = document.getElementById("edupath-upload-done");
  const v = Math.max(0, Math.min(100, Number(pct)||0));
  if (bar) bar.style.width = v + "%";
  if (pctEl) pctEl.textContent = v.toFixed(0) + "%";
  if (subText && sub) sub.textContent = subText;
  if (done) done.style.display = v >= 100 ? "block" : "none";
}
// ===== End Resource Upload Progress UI =====


// Fill a <select> with department options (source of truth: public.departments)
function applyDepartmentsToSelect(selectEl, departments, opts = {}) {
  if (!selectEl) return;
  const includeAll = opts.includeAll ?? true;
  const allLabel = opts.allLabel ?? "All Departments";
  const placeholder = opts.placeholder ?? "Select department";
  const current = selectEl.value;

  const options = [];
  options.push(`<option value="">${escapeHtml(placeholder)}</option>`);
  if (includeAll) options.push(`<option value="__all__">${escapeHtml(allLabel)}</option>`);
  (departments || []).forEach((d) => {
    const name = (d ?? "").toString().trim();
    if (!name) return;
    options.push(`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
  });

  selectEl.innerHTML = options.join("");

  // restore selection if still present
  if (current && Array.from(selectEl.options).some(o => o.value === current)) {
    selectEl.value = current;
  }
}



// ===== WhatsApp-style Avatars (Supabase Storage + DB pointer) =====
const __avatarCache = new Map();          // key -> url
const __avatarPending = new Map();        // key -> Promise<url|null>

function avatarSlotHtml(key, size=40, extraClass="") {
  const k = escapeHtml(String(key || ""));
  const cls = `wa-avatar ${size <= 32 ? "wa-avatar-sm" : size <= 40 ? "wa-avatar-md" : "wa-avatar-lg"} ${extraClass}`.trim();
  return `<span class="${cls}" data-avatar-key="${k}" aria-label="profile picture">👤</span>`;
}

async function resolveAvatarUrlByKey(key) {
  // Keys can be:
  // - Supabase auth UID (uuid)
  // - reg_number / username
  // - a compound key like 'H240555c:1' (we normalize)
  const raw = String(key || "").trim();
  if (!raw) return null;

  // Normalize noisy keys coming from local/chat payloads
  const base = raw.split(":")[0].split("|")[0].split("#")[0].trim();
  const candidates = Array.from(new Set([raw, base].filter(Boolean)));

  for (const k of candidates) {
    if (__avatarCache.has(k)) return __avatarCache.get(k);
  }
  if (__avatarPending.has(raw)) return __avatarPending.get(raw);

  const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

  const p = (async ()=>{
    try {
      const supabase = await getSupabase();
      let url = null;

      // 1) auth_user_id == uuid (guarded to avoid 400 invalid uuid)
      if (isUuid(base)) {
        try {
          const r1 = await supabase
            .from("student_profiles")
            .select("avatar_url")
            .eq("auth_user_id", base)
            .maybeSingle();
          if (!r1.error && r1.data?.avatar_url) url = r1.data.avatar_url;
        } catch(e){}
      }

      // 2) reg_number == base
      if (!url) {
        try {
          const r2 = await supabase
            .from("student_profiles")
            .select("avatar_url")
            .eq("reg_number", base)
            .maybeSingle();
          if (!r2.error && r2.data?.avatar_url) url = r2.data.avatar_url;
        } catch(e){}
      }

      // 3) username == base (fallback)
      if (!url) {
        try {
          const r3 = await supabase
            .from("student_profiles")
            .select("avatar_url")
            .eq("username", base.toLowerCase())
            .maybeSingle();
          if (!r3.error && r3.data?.avatar_url) url = r3.data.avatar_url;
        } catch(e){}
      }

      if (url) {
        for (const k of candidates) __avatarCache.set(k, url);
      }
      return url || null;
    } catch (e) {
      return null;
    } finally {
      __avatarPending.delete(raw);
    }
  })();

  __avatarPending.set(raw, p);
  return p;
}

function hydrateAvatars(root=document) {
  const nodes = Array.from(root.querySelectorAll("[data-avatar-key]"));
  if (!nodes.length) return;
  nodes.forEach(async (node)=>{
    const key = node.getAttribute("data-avatar-key") || "";
    if (!key) return;
    // already hydrated?
    if (node.querySelector("img")) return;

    // Prefer any local cached mapping
    const url = await resolveAvatarUrlByKey(key);
    if (!url) return;

    node.innerHTML = `<img src="${escapeHtml(url)}" alt="avatar" loading="lazy" />`;
  });
}




// ===== Avatar Cropper (WhatsApp-style circle selection) =====
// Lightweight, no external libs. User drags + zooms to select what shows in the circle.
let __avatarCropState = null;

function ensureAvatarCropperModal() {
  if (document.getElementById('avatar-crop-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'avatar-crop-modal';
  modal.className = 'modal-overlay hidden';
  modal.innerHTML = `
    <div class="modal wa-crop-modal" role="dialog" aria-modal="true" aria-label="Crop profile photo">
      <div class="modal-header">
        <strong>Crop your profile photo</strong>
        <button class="icon-btn" type="button" id="avatar-crop-close" aria-label="Close">✕</button>
      </div>
      <div class="wa-crop-body">
        <canvas id="avatar-crop-canvas" width="360" height="360"></canvas>
        <div class="wa-crop-controls">
          <label class="small muted">Zoom</label>
          <input id="avatar-crop-zoom" type="range" min="1" max="3" step="0.01" value="1" />
          <div class="wa-crop-actions">
            <button id="avatar-crop-cancel" class="btn secondary" type="button">Cancel</button>
            <button id="avatar-crop-save" class="btn btn-primary" type="button">Use photo</button>
          </div>
        </div>
      </div>
      <p class="small muted" style="margin:10px 0 0;">Drag to position. Use zoom to fit. The circle is what will show next to your name.</p>
    </div>`;
  document.body.appendChild(modal);

  const close = () => {
    modal.classList.add('hidden');
    __avatarCropState = null;
  };
  document.getElementById('avatar-crop-close')?.addEventListener('click', close);
  document.getElementById('avatar-crop-cancel')?.addEventListener('click', close);

  // Prevent background scroll while modal open
  modal.addEventListener('click', (e)=>{
    if (e.target === modal) close();
  });
}

function drawAvatarCropCanvas() {
  const canvas = document.getElementById('avatar-crop-canvas');
  if (!canvas || !__avatarCropState?.img) return;
  const ctx = canvas.getContext('2d');
  const { img, scale, ox, oy } = __avatarCropState;
  const W = canvas.width, H = canvas.height;

  ctx.clearRect(0,0,W,H);

  // Fit image to canvas at scale=1
  const fit = Math.max(W / img.width, H / img.height);
  const s = fit * scale;
  const dw = img.width * s;
  const dh = img.height * s;
  const dx = (W - dw)/2 + ox;
  const dy = (H - dh)/2 + oy;

  ctx.drawImage(img, dx, dy, dw, dh);

  // Darken outside circle
  const r = Math.min(W,H) * 0.38;
  const cx = W/2, cy = H/2;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.rect(0,0,W,H);
  ctx.arc(cx, cy, r, 0, Math.PI*2, true);
  ctx.fill('evenodd');
  ctx.restore();

  // Circle border
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI*2);
  ctx.stroke();
  ctx.restore();
}

function avatarCropToBlob(outSize=256) {
  return new Promise((resolve)=>{
    const canvas = document.getElementById('avatar-crop-canvas');
    if (!canvas || !__avatarCropState?.img) return resolve(null);
    const { img, scale, ox, oy } = __avatarCropState;

    const W = canvas.width, H = canvas.height;
    const fit = Math.max(W / img.width, H / img.height);
    const s = fit * scale;
    const dw = img.width * s;
    const dh = img.height * s;
    const dx = (W - dw)/2 + ox;
    const dy = (H - dh)/2 + oy;

    // We export a square (WhatsApp shows circle via CSS).
    // Take the centered square crop from the canvas.
    const cropSide = Math.min(W, H) * 0.76; // matches circle diameter (2r)
    const sx = (W - cropSide)/2;
    const sy = (H - cropSide)/2;

    // Render the image again to an offscreen canvas, then crop.
    const off = document.createElement('canvas');
    off.width = outSize;
    off.height = outSize;
    const octx = off.getContext('2d');

    // Draw full onto temp canvas
    const temp = document.createElement('canvas');
    temp.width = W;
    temp.height = H;
    const tctx = temp.getContext('2d');
    tctx.drawImage(img, dx, dy, dw, dh);

    octx.drawImage(temp, sx, sy, cropSide, cropSide, 0, 0, outSize, outSize);
    off.toBlob((blob)=> resolve(blob), 'image/png', 0.92);
  });
}

async function openAvatarCropper(file) {
  ensureAvatarCropperModal();
  const modal = document.getElementById('avatar-crop-modal');
  const zoom = document.getElementById('avatar-crop-zoom');
  const saveBtn = document.getElementById('avatar-crop-save');

  const dataUrl = await new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result);
    reader.onerror = ()=> reject(new Error('Could not read image file'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve,reject)=>{
    const i = new Image();
    i.onload = ()=> resolve(i);
    i.onerror = ()=> reject(new Error('Invalid image'));
    i.src = dataUrl;
  });

  __avatarCropState = { img, scale: 1, ox: 0, oy: 0, dragging: false, lx: 0, ly: 0 };

  modal.classList.remove('hidden');
  drawAvatarCropCanvas();

  // Zoom control
  zoom.value = '1';
  zoom.oninput = ()=>{
    if (!__avatarCropState) return;
    __avatarCropState.scale = parseFloat(zoom.value || '1');
    drawAvatarCropCanvas();
  };

  // Drag interaction
  const canvas = document.getElementById('avatar-crop-canvas');
  const onDown = (e)=>{
    if (!__avatarCropState) return;
    __avatarCropState.dragging = true;
    __avatarCropState.lx = e.clientX;
    __avatarCropState.ly = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e)=>{
    if (!__avatarCropState?.dragging) return;
    const dx = e.clientX - __avatarCropState.lx;
    const dy = e.clientY - __avatarCropState.ly;
    __avatarCropState.lx = e.clientX;
    __avatarCropState.ly = e.clientY;
    __avatarCropState.ox += dx;
    __avatarCropState.oy += dy;
    drawAvatarCropCanvas();
  };
  const onUp = ()=>{ if (__avatarCropState) __avatarCropState.dragging = false; };

  canvas.onpointerdown = onDown;
  canvas.onpointermove = onMove;
  canvas.onpointerup = onUp;
  canvas.onpointercancel = onUp;

  // Resolve when user saves
  return await new Promise((resolve)=>{
    const cleanup = ()=>{
      saveBtn.onclick = null;
      modal.classList.add('hidden');
    };
    saveBtn.onclick = async ()=>{
      const blob = await avatarCropToBlob(256);
      cleanup();
      __avatarCropState = null;
      resolve(blob);
    };
  });
}


// Wire WhatsApp-style avatar upload + cropper on any page that provides #avatar-file and #btn-upload-avatar
async function wireAvatarUploadUI(opts = {}) {
  const input = document.getElementById(opts.inputId || "avatar-file");
  const btn = document.getElementById(opts.buttonId || "btn-upload-avatar");
  if (!input || !btn) return;

  // Ensure we don't double-bind
  if (input.__avatarBound) return;
  input.__avatarBound = true;

  input.addEventListener("change", async () => {
    try {
      const file = input.files?.[0];
      if (!file) return;
      console.log("[avatar] file selected", { name: file.name, type: file.type, size: file.size });
      const blob = await openAvatarCropper(file);
      if (!blob) return;
      input.__croppedBlob = blob;
      console.log("[avatar] crop ready");
    } catch (e) {
      console.warn("[avatar] crop error", e);
      alert(e?.message || "Could not open cropper");
    }
  });

  btn.addEventListener("click", async () => {
    try {
      const supabase = await getSupabase();
      const { data: authRes, error: authErr } = await supabase.auth.getUser();
      if (authErr) throw authErr;
      const uid = authRes?.user?.id;
      if (!uid) return alert("Not authenticated.");

      const file = input.files?.[0];
      if (!file) return alert("Choose an image first.");
      const blob = input.__croppedBlob || file;

      const path = `${uid}/avatar.png`;
      console.log("[avatar] uploading to storage", path);

      const { error: upErr } = await supabase.storage
        .from("avatars")
        .upload(path, blob, { upsert: true, contentType: "image/png" });

      if (upErr) throw upErr;

      const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
      const url = pub?.publicUrl;
      if (!url) throw new Error("Could not build public URL for uploaded avatar.");

      console.log("[avatar] uploaded ok, saving url to profile", url);

      // Try several keys depending on schema
      const st = loadState();
      const reg = st?.sessions?.student?.regNumber || st?.sessions?.student?.reg_number || "";
      const username = (st?.sessions?.student?.username || "").toLowerCase();

      const attempts = [
        { col: "auth_user_id", val: uid },
        { col: "reg_number", val: reg },
        { col: "regnum", val: reg },
        { col: "username", val: username },
      ].filter(a => a.val);

      let saved = false;
      let lastErr = null;

      for (const a of attempts) {
        try {
          const { data, error } = await supabase
            .from("student_profiles")
            .update({ avatar_url: url })
            .eq(a.col, a.val)
            .select("avatar_url");
          if (error) { lastErr = error; continue; }
          if (Array.isArray(data) ? data.length > 0 : Boolean(data)) { saved = true; break; }
        } catch (e) {
          lastErr = e;
        }
      }

      if (!saved) {
        console.warn("[avatar] save failed", lastErr);
        return alert("Upload succeeded but profile save failed. Check RLS / student_profiles keys.");
      }

      // Cache for multiple key formats
      __avatarCache.set(uid, url);
      if (reg) __avatarCache.set(String(reg), url);
      if (username) __avatarCache.set(String(username), url);

      hydrateAvatars(document);

      input.__croppedBlob = null;
      console.log("[avatar] done");
      alert("Profile photo updated.");
    } catch (e) {
      console.warn("[avatar] upload error", e);
      alert("Avatar update failed: " + (e?.message || e?.toString?.() || "Unknown error"));
    }
  });
}


function renderPublicNav() {
  const node = document.querySelector("[data-public-nav]");
  if (!node) return;
  node.innerHTML = `<a href="index.html">Home</a> <a href="course-catalog.html">Course Catalog</a> <a href="help-support.html">Help & Support</a> <a href="admin-login.html">Admin Login</a>`;
}

function initPublicPage() {
  // noop placeholder for public pages
}

function setLoginFeedback(message, isError = false) {
  const node = document.getElementById("login-feedback");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = isError ? "var(--danger)" : "var(--muted)";
}

async function ensureSupabaseReady() {
  const supabase = await getSupabase();
  if (!supabase) throw new Error("Supabase is not available. Check your network or SUPABASE_URL / ANON key.");
  return supabase;
}

function authFriendlyError(error) {
  const msg = (error && (error.message || error.error_description || error.toString())) || "Unknown error";
  if (msg.toLowerCase().includes("invalid login")) return "Invalid credentials. Check your email/registration number and password.";
  if (msg.toLowerCase().includes("user already registered")) return "That account already exists. Switch to Existing account and sign in.";
  if (msg.toLowerCase().includes("password")) return "Password rejected. Use at least 6 characters (Supabase default).";
  return msg;
}


function renderSidebar(type = "student") {
  const target = document.querySelector("[data-sidebar]");
  if (!target) return;

  const state = loadState();
  const isAdminSession = !!state?.sessions?.admin;
  const effectiveType = (type === "admin" && isAdminSession) ? "admin" : "student";

  target.innerHTML = effectiveType === "admin"
    ? `<nav>
        <a class="nav-link" data-page="admin-panel" href="admin-panel.html">Admin Control Panel</a>
        <a class="nav-link" data-page="admin-courses" href="admin-courses.html">Manage Courses</a>
        <a class="nav-link" data-page="chatrooms" href="chatrooms.html">Chatrooms (Admin View)</a>
        <a class="nav-link" data-page="catalog" href="course-catalog.html">Course Catalog</a>
        <a class="nav-link" data-page="profile" href="profile.html">My Profile</a>
        <a class="nav-link" href="#" id="logout-admin">Log out</a>
      </nav>`
    : `<nav>
        <a class="nav-link" data-page="dashboard" href="dashboard.html">Student Dashboard</a>
        <a class="nav-link" data-page="profile" href="profile.html">My Profile</a>
        <a class="nav-link" data-page="search" href="search.html">Search</a>
        <a class="nav-link" data-page="mycourses" href="my-courses.html">My Courses</a>
        <a class="nav-link" data-page="copilot" href="copilot.html">Copilot</a>
        <a class="nav-link" data-page="chatrooms" href="chatrooms.html">Chatrooms</a>
        <a class="nav-link" data-page="inbox" href="inbox.html" id="nav-inbox-link">Inbox <span class="nav-dot" id="inbox-dot" style="display:none"></span><span class="nav-badge" id="inbox-badge" style="display:none">0</span></a>
        <a class="nav-link" data-page="resources" href="resource-hub.html">Resource Hub</a>
        <a class="nav-link" data-page="qa" href="qa-platform.html">Q&A Platform</a>
        <a class="nav-link" data-page="tasks" href="task-tracker.html">Task Tracker</a>
        <a class="nav-link" data-page="catalog" href="course-catalog.html">Course Catalog</a>
        <a class="nav-link" data-page="support" href="help-support.html">Help & Support</a>
        <a class="nav-link" data-page="tutors" href="tutors-lecturers.html">Tutors / Lecturers</a>
        <a class="nav-link" href="#" id="logout-student">Log out</a>
      </nav>`;
  if (effectiveType === "student") { updateInboxBadge(); }
}

function attachLogout() {
  byId("logout-student")?.addEventListener("click", (e) => { e.preventDefault(); confirmLogout("student"); });
  byId("logout-admin")?.addEventListener("click", (e) => { e.preventDefault(); confirmLogout("admin"); });
}

function addWelcomeMessage(name) { if (name) alert(`Welcome (${name})`); }
function roomOptions(rooms) { return rooms.map((r) => `<option value="${r.id}">${r.name} (${r.code})</option>`).join(""); }
function myRooms(state, user, isAdmin = false) { return state.chatrooms.filter((room) => userCanAccessRoom(state, room, user, isAdmin)); }

async function protectPrivatePage(page) {
  const publicPages = new Set(["index", "adminLogin", "support", "catalog"]);
  if (publicPages.has(page)) return true;

  const supabase = await getSupabase();
  const local = loadState();
  const hasLocal = Boolean(local.sessions?.student || local.sessions?.admin);

  let session = null;
  try {
    const res = await supabase?.auth?.getSession?.();
    session = res?.data?.session || null;
  } catch {}

  if (page === "adminPanel") {
    if (!local.sessions?.admin) {
      window.location.href = "admin-login.html";
      return false;
    }
    return true;
  }

  if (!session && !hasLocal) {
    window.location.href = "index.html";
    return false;
  }
  return true;
}


function initLanding() {
  if (localStorage.getItem("cookieConsent")==="rejected") { alert("You must accept cookies to use EDUPATH+."); return; }

  // Allow a custom home background (if configured)
  try{ applyThemeAndNav("index"); }catch(e){}

  const state = loadState();

  // Departments shown in registration MUST come ONLY from public.departments (NEW depts)
  const deptSelect = byId("student-department");
  if (deptSelect) deptSelect.innerHTML = `<option value="" disabled selected>Loading departments…</option>`;
  (async () => {
    const departments = await loadDepartmentsDb();
    if (deptSelect) {
      deptSelect.innerHTML = (departments||[])
        .map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`)
        .join("");
    }
  })();

  byId("student-part").innerHTML = STUDY_PARTS.map((p) => `<option>${p}</option>`).join("");

  byId("student-mode")?.addEventListener("change", () => {
    const existing = byId("student-mode").value === "existing";
    byId("student-name").disabled = existing;
    byId("student-department").disabled = existing;
    byId("student-part").disabled = existing;
    byId("registration-fields")?.classList.toggle("hidden", existing);
    byId("student-reg").disabled = false;
    byId("student-reg").required = true;
  });
  // Toggle required fields for register vs login
  const toggleReq = () => {
    const existing = byId("student-mode")?.value === "existing";
    const u = byId("student-username");
    if (u) { u.required = existing; u.placeholder = existing ? "Username or email" : "Optional: email"; }
  };
  toggleReq();
  byId("student-mode")?.addEventListener("change", toggleReq);


  byId("student-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formMode = byId("student-mode").value;
    const identityInput = byId("student-username").value.trim().toLowerCase();
    const regNumber = normalizeRegNumber(byId("student-reg").value);
    const password = byId("student-password").value.trim();
    if (!regNumber || !password) return alert("Registration number and password are required.");
    const isExisting = formMode === "existing";
    if (isExisting && !identityInput) return alert("Enter your username (or email) for existing login.");

    if (formMode === "new") {
      if (!isValidRegNumber(regNumber)) return alert("Please enter a valid HIT registration number (e.g. H240125B).");
      const canonicalEmail = regToHitEmail(regNumber);
      if (!isHitEmail(canonicalEmail)) return alert("Invalid HIT email identity generated from registration number.");

      let supabase;
      try { supabase = await ensureSupabaseReady(); }
      catch (e) { setLoginFeedback(authFriendlyError(e), true); return alert(authFriendlyError(e)); }

      try {
        // Create Auth account (may return null session if email confirmations are ON)
const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({ email: canonicalEmail, password });
if (signUpErr) { setLoginFeedback(authFriendlyError(signUpErr), true); return alert(authFriendlyError(signUpErr)); }

// Ensure we have an authenticated session before writing to RLS-protected tables.
// If email confirmations are ON, sign-in will fail until the email is confirmed.
const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email: canonicalEmail, password });
if (signInErr || !signInData?.user) {
  setLoginFeedback("Account created, but you are not signed in yet. Disable email confirmations in Supabase Auth settings (for testing), or confirm the email, then sign in.", true);
  return alert("Account created, but profile could not be saved because you are not authenticated yet. Disable email confirmations (for testing) or confirm email, then sign in.");
}

const authUserId = signInData.user.id;


        const profileRow = {
          auth_user_id: authUserId,
          reg_number: normalizeRegNumber(regNumber),
          full_name: (byId("student-name").value.trim() || regNumber),
          username: canonicalEmail,
          department: byId("student-department").value,
          part: byId("student-part").value,
          last_login_at: new Date().toISOString()
        };

        const { error: upErr } = await supabase.from("student_profiles").upsert(profileRow, { onConflict: "reg_number" });
        if (upErr) {
          setLoginFeedback("Account created, but profile save failed: " + authFriendlyError(upErr), true);
          return alert("Account created, but profile save failed. Check Supabase table/policies.");
        }

        setCurrentSession("student", {
          id: authUserId || crypto.randomUUID(),
          name: profileRow.full_name,
          department: profileRow.department,
          regNumber: profileRow.reg_number,
          canonicalEmail,
          username: canonicalEmail,
          part: profileRow.part,
          password: "",
          role: "student"
        });

        setLoginFeedback("Account created. Redirecting…", false);
        addWelcomeMessage(profileRow.full_name);
        setAuthMode("student");
        setAuthFlag();
    window.location.href = "dashboard.html";
        return;
      } catch (e) {
        setLoginFeedback(authFriendlyError(e), true);
        return alert(authFriendlyError(e));
      }
    }

    const identityEmail = identityInput.includes("@") ? identityInput : regToHitEmail(regNumber);

let supabase;
try { supabase = await ensureSupabaseReady(); }
catch (e) { setLoginFeedback(authFriendlyError(e), true); return alert(authFriendlyError(e)); }

try {
  const { data, error } = await supabase.auth.signInWithPassword({ email: identityEmail, password });
  if (error || !data?.user) {
    trackFailedAttempt(`student:${identityEmail}`, "student-login");
    setLoginFeedback("No account found — create one (switching you to Register).", true);
    byId("student-mode").value = "new";
    byId("student-mode").dispatchEvent(new Event("change"));
    return alert("No account found — please create an account first.");
  }

  const { data: prof, error: pErr } = await supabase.from("student_profiles").select("*").eq("auth_user_id", data.user.id).maybeSingle();
// Best-effort: update last_login_at
try {
  await supabase.from("student_profiles").update({ last_login_at: new Date().toISOString() }).eq("auth_user_id", data.user.id);
  await logActivity("login", null, null, {});
} catch (e) {}

  if (pErr) setLoginFeedback("Signed in, but profile fetch failed: " + authFriendlyError(pErr), true);

  const profile = prof || {};

  setCurrentSession("student", {
    id: data.user.id,
    name: profile.full_name || regNumber,
    department: profile.department || "",
    regNumber: profile.reg_number || regNumber,
    canonicalEmail: identityEmail,
    username: profile.username || identityEmail,
    part: profile.part || "",
    password: "",
    role: "student"
  });

  setLoginFeedback("Signed in. Redirecting…", false);
  addWelcomeMessage(profile.full_name || regNumber);
  setAuthMode("student");
  setAuthFlag();
    window.location.href = "dashboard.html";
  return;
} catch (e) {
  setLoginFeedback(authFriendlyError(e), true);
  return alert(authFriendlyError(e));
}});

  byId("admin-shortcut")?.addEventListener("click", () => { window.location.href = "admin-login.html"; });
}

function initDashboard() {
  const user = requireSession("student"); if (!user) return;
  renderSidebar(); renderTopbar(`${user.name} • ${user.department} • Part ${user.part || "-"}`); applyThemeAndNav("dashboard"); attachLogout();
  const state = loadState();
  byId("welcome-text").textContent = state.settings.welcomeText;
  byId("dashboard-banner").textContent = state.settings.dashboardBanner;
  byId("current-users").textContent = `${[state.sessions.student, state.sessions.admin].filter(Boolean).length}`;

  const features = [
    ["chat", "Department & Cross-Department Chat", "chatrooms.html"],
    ["resources", "Academic Resource Hub", "resource-hub.html"],
    ["qa", "Department Q&A", "qa-platform.html"],
    ["tasks", "Task Tracker", "task-tracker.html"]
  ];
  byId("feature-cards").innerHTML = features
    .filter(([key]) => state.settings.featureVisibility[key])
    .map(([, title, href]) => `<article class="card feature-card"><h3>${title}</h3><p class="small">Open this module from your student workflow.</p><a class="btn" href="${href}">Open Module</a></article>`)
    .join("");
}

function initChatrooms() {
  const state0 = loadState();
  const student = state0.sessions.student; const admin = state0.sessions.admin;
  if (!student && !admin) return (window.location.href = "index.html");
  const isAdminView = Boolean(admin && !student); const actor = student || admin;
  renderSidebar(isAdminView ? "admin" : "student"); renderTopbar(`${actor.name} • ${isAdminView ? "admin" : actor.department}`); applyThemeAndNav("chatrooms"); attachLogout();
  byId("btn-chat-minimize")?.addEventListener("click", ()=>{ document.body.classList.toggle("chat-minimized"); });
  byId("btn-chat-fullscreen")?.addEventListener("click", ()=>{ document.body.classList.toggle("chat-fullscreen"); });

  let replyTo = null;
  let editingId = "";
  let audioData = "";

  function refreshRoomSelectors() {
    const state = loadState();
    const rooms = isAdminView ? state.chatrooms : myRooms(state, actor);
    byId("chat-room").innerHTML = roomOptions(rooms);
    byId("task-room").innerHTML = roomOptions(rooms);
    if (isAdminView) {
      byId("create-room-card")?.remove(); byId("join-room-card")?.remove();
    }
  }
  refreshRoomSelectors();

  // Deep-link: auto-select room from URL ?room=CODE
  try {
    const params = new URLSearchParams(window.location.search);
    const roomCode = (params.get('room') || '').trim().toUpperCase();
    if (roomCode) {
      const sel = byId('chat-room');
      if (sel) {
        // Try match by code option text/value
        const opts = Array.from(sel.options);
        const found = opts.find((o)=>(o.value||'').toUpperCase()===roomCode || (o.textContent||'').toUpperCase().includes(roomCode));
        if (found) sel.value = found.value;
      }
    }
  } catch (e) {}


  byId("join-room-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = byId("join-room-code").value.trim().toUpperCase();
    if (!code) return alert("Enter room code.");
    const userKey = userKeyFromProfile(actor);
    const room = loadState().chatrooms.find((r) => r.code === code);
    if (!room) return alert("Invalid room code.");
    updateState((s) => {
      const target = s.chatrooms.find((r) => r.id === room.id);
      if (!target.members.includes(userKey)) target.members.push(userKey);
      s.chats.unshift({ id: crypto.randomUUID(), roomId: target.id, sender: "System", senderKey: "system", type: "system", message: `${actor.name} joined the room.`, replyTo: null, attachmentName: "", attachmentData: "", audioData: "", createdAt: new Date().toISOString() });
    }, "chatroom joined by code");
    alert(`Joined ${room.name}`);
    byId("join-room-form").reset();
    refreshRoomSelectors();

  // Deep-link: auto-select room from URL ?room=CODE
  try {
    const params = new URLSearchParams(window.location.search);
    const roomCode = (params.get('room') || '').trim().toUpperCase();
    if (roomCode) {
      const sel = byId('chat-room');
      if (sel) {
        // Try match by code option text/value
        const opts = Array.from(sel.options);
        const found = opts.find((o)=>(o.value||'').toUpperCase()===roomCode || (o.textContent||'').toUpperCase().includes(roomCode));
        if (found) sel.value = found.value;
      }
    }
  } catch (e) {}

    byId("chat-room").value = room.id;
    renderChats();
  });

  byId("create-room-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const roomName = byId("new-room-name").value.trim();
    if (!roomName) return;
    const code = generateRoomCode(); const userKey = userKeyFromProfile(actor); const roomId = crypto.randomUUID();
    updateState((s) => {
      s.chatrooms.push({ id: roomId, name: roomName, code, ownerKey: userKey, members: [userKey], isDefault: false, createdAt: new Date().toISOString() });
      s.chats.unshift({ id: crypto.randomUUID(), roomId, sender: "System", senderKey: "system", type: "system", message: `Room ${roomName} created by ${actor.name}.`, replyTo: null, attachmentName: "", attachmentData: "", audioData: "", createdAt: new Date().toISOString() });
    }, "chatroom created");
    alert(`Room created. Share code: ${code}`);
    event.target.reset(); refreshRoomSelectors();

  // Deep-link: auto-select room from URL ?room=CODE
  try {
    const params = new URLSearchParams(window.location.search);
    const roomCode = (params.get('room') || '').trim().toUpperCase();
    if (roomCode) {
      const sel = byId('chat-room');
      if (sel) {
        // Try match by code option text/value
        const opts = Array.from(sel.options);
        const found = opts.find((o)=>(o.value||'').toUpperCase()===roomCode || (o.textContent||'').toUpperCase().includes(roomCode));
        if (found) sel.value = found.value;
      }
    }
  } catch (e) {}
 byId("chat-room").value = roomId; renderChats();
  });

  byId("chat-audio")?.addEventListener("change", async (e) => { const [file] = e.target.files; audioData = file ? await fileToDataUrl(file) : ""; });
  byId("chat-room")?.addEventListener("change", renderChats);

  byId("chat-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = byId("chat-file").files[0];
    const attachmentData = file ? await fileToDataUrl(file) : "";
    const roomId = byId("chat-room").value;
    const text = byId("chat-message").value.trim();
    if (!text && !attachmentData && !audioData) return alert("Type a message or add media.");
    updateState((s) => {
      if (editingId) {
        const msg = s.chats.find((m) => m.id === editingId);
        if (msg) { msg.message = text; msg.editedAt = new Date().toISOString(); }
      } else {
        s.chats.unshift({ id: crypto.randomUUID(), roomId, sender: actor.name, senderKey: userKeyFromProfile(actor), type: "user", message: text, replyTo, attachmentName: file?.name || "", attachmentData, audioData, createdAt: new Date().toISOString() });
      }
    }, editingId ? "chat message edited" : "chat message posted");
    event.target.reset(); replyTo = null; editingId = ""; audioData = ""; byId("reply-indicator").textContent = ""; byId("chat-submit").textContent = "Send Message";
    renderChats();
  });

  byId("task-inline-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    updateState((s) => { s.tasks.unshift({ id: crypto.randomUUID(), roomId: byId("task-room").value, title: byId("task-title").value.trim(), deadline: byId("task-deadline").value, status: "pending", creator: actor.name }); }, "task created from chat");
    const keepRoom = roomId;
    event.target.reset();
    byId("chat-room").value = keepRoom;
    renderChats();
  });

  function renderChats() {
    const roomId = byId("chat-room").value; const state = loadState(); const room = state.chatrooms.find((r) => r.id === roomId); const me = userKeyFromProfile(actor);
    const messages = state.chats.filter((m) => m.roomId === roomId).sort((a, b) => (a.type === "system" ? -1 : 1) - (b.type === "system" ? -1 : 1) || new Date(a.createdAt) - new Date(b.createdAt));
    byId("chat-list").innerHTML = messages.map((m) => {
      const canManage = isAdminView || m.senderKey === me || room?.ownerKey === me;
      const bubble = m.senderKey === me ? "bubble mine" : m.type === "system" ? "bubble system" : "bubble";
      const replyMsg = m.replyTo ? state.chats.find((x) => x.id === m.replyTo)?.message : "";
      return `<article class="${bubble}">
        <div class="item-header wa-row wa-chat-header">${avatarSlotHtml(m.senderKey || "", 32, "wa-avatar-chat")}<div class="wa-col"><div class="wa-title"><strong>${escapeHtml(m.sender)}${m.type === "system" ? " (system)" : ""}</strong></div><div class="small muted">${formatDate(m.createdAt)}${m.editedAt ? " • edited" : ""}</div></div></div>
        ${replyMsg ? `<p class='small'><em>↪ ${replyMsg.slice(0, 90)}</em></p>` : ""}
        <p>${m.message || ""}</p>
        ${m.attachmentName ? `<p class='small'>${m.attachmentName} <a href='${m.attachmentData}' download='${m.attachmentName}'>Download</a> | <a href='${m.attachmentData}' target='_blank'>View</a></p>` : ""}
        ${m.audioData ? `<audio controls src='${m.audioData}'></audio>` : ""}
        <div class="actions"><button type="button" class="btn secondary" data-reply="${m.id}">Reply</button>${canManage ? `<button type='button' class='btn secondary' data-edit='${m.id}'>Edit</button><button type='button' class='btn warn' data-delete='${m.id}'>Delete</button>` : ""}</div>
      </article>`;
    }).join("") || "<p class='small'>No messages yet.</p>";

    hydrateAvatars(byId("chat-list"));

    document.querySelectorAll("[data-reply]").forEach((b) => b.addEventListener("click", () => { replyTo = b.dataset.reply; byId("reply-indicator").textContent = "Reply mode enabled"; }));
    document.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
      const msg = loadState().chats.find((m) => m.id === b.dataset.edit); if (!msg) return;
      editingId = msg.id; byId("chat-message").value = msg.message; byId("chat-submit").textContent = "Save Edit"; byId("reply-indicator").textContent = "Editing message";
    }));
    document.querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", () => {
      updateState((s) => { s.chats = s.chats.filter((m) => m.id !== b.dataset.delete); }, "chat message deleted"); renderChats();
    }));
  }

  renderChats();
}

function initResources() {
  // Ensure NEW departments are loaded from DB and cached (no old depts)
  try{
    loadDepartmentsDb().then(()=>{
      const deps = getDepartmentsCached();
      const sel = byId("resource-department");
      const fsel = byId("resource-filter-department");
      if (sel) sel.innerHTML = deps.map((d)=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
      if (fsel) fsel.innerHTML = `<option value=''>All Departments</option>` + deps.map((d)=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
    });
  }catch(e){}
  let dbModeResources = false;

  const user = requireSession("student"); if (!user) return;
  renderSidebar(); renderTopbar(`${user.name} • ${user.department}`); applyThemeAndNav("resources"); attachLogout();  const state = loadState();
  let resourcesDb = [];
  (async ()=>{
    dbModeResources = await dbTableExists('resources');
    if (dbModeResources){
      const dept = await getMyDepartment();
      try{ resourcesDb = await fetchResourcesCommunity({ department: dept }); }catch(e){ resourcesDb = []; }
      renderResources();

async function renderSavedResources(){
  try{
    if (!(await dbTableExists("saved_resources"))) return;
    const saved = await fetchSavedResourcesDb();
    const box = document.getElementById("saved-resource-list");
    if (!box) return;
    if (!saved.length){ box.innerHTML = '<div class="muted small">No saved docs yet.</div>'; return; }
    box.innerHTML = saved.map(r => `
      <div class="list-row">
        <div class="meta">
          <div><strong>${escapeHtml(r.title || "Resource")}</strong></div>
          <div class="small muted">${escapeHtml(r.course_code || "")} ${r.department ? "• " + escapeHtml(r.department) : ""}</div>
        </div>
        <div class="actions">
          ${r.url ? `<a class="btn btn-ghost" href="${r.url}" target="_blank" rel="noreferrer">👁️ View</a>` : ""}
          ${r.url ? `<a class="btn btn-ghost" href="${r.url}" download>📥 Download</a>` : ""}
          <button class="btn btn-danger" type="button" data-unsave="${r.id}">Remove</button>
        </div>
      </div>
    `).join("");

    box.querySelectorAll("[data-unsave]").forEach(b=>b.addEventListener("click", async ()=>{
      try{ await unsaveResourceDb(Number(b.dataset.unsave)); await renderSavedResources(); }catch(e){ alert(e.message||"Could not unsave"); }
    }));
  }catch(e){}
}


    }
  })();

  byId("resource-department").innerHTML = (getDepartmentsCached()).map((d)=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  byId("resource-course").innerHTML = state.courses.map((c) => `<option value='${c.code}'>${c.code} - ${c.name}</option>`).join("");
  const __deps = getDepartmentsCached();
  byId("resource-filter-department").innerHTML = `<option value=''>All Departments</option>${__deps.map((d)=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("")}`;
  byId("resource-filter-course").innerHTML = `<option value=''>All Courses</option>${state.courses.map((c) => `<option value='${c.code}'>${c.code}</option>`).join("")}`;

  byId("resource-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = byId("resource-file").files[0];
    if (!file) return;

    const title = (byId("resource-title").value || "").trim();
    const department = byId("resource-department").value;
    const course_code = byId("resource-course").value;

    // DB-backed flow (preferred)
    if (dbModeResources) {
      try{
        showUploadProgress();
        setUploadProgress(6, "Preparing upload…");

        // Simulated progress while we convert and send (Supabase fetch upload has no native progress)
        let pct = 6;
        const tick = setInterval(()=>{ pct = Math.min(88, pct + (pct < 45 ? 6 : 3)); setUploadProgress(pct); }, 220);

        setUploadProgress(14, "Encoding resource for upload…");
        const fileData = await fileToDataUrl(file);

        setUploadProgress(62, "Uploading to database…");
        const supabase = await getSupabase();
        const { data: auth } = await supabase.auth.getUser();
        const uid = auth?.user?.id;
        if (!uid) throw new Error("Not authenticated");

        // Try multiple schema variants safely (some projects use auth_user_id/url, others uploader_id/file_url)
        const payloadA = { auth_user_id: uid, title, description: "", url: fileData, department, course_code, status: "pending" };
        const payloadB = { uploader_id: uid, title, file_url: fileData, file_name: file.name, department, course_code, status: "pending_approval" };

        let insErr = null;
        let row = null;

        // Attempt A
        {
          const { data, error } = await supabase.from("resources").insert(payloadA).select("*").limit(1);
          if (!error) { row = (data||[])[0] || null; insErr = null; }
          else insErr = error;
        }

        // Attempt B if A failed (schema mismatch)
        if (insErr){
          const { data, error } = await supabase.from("resources").insert(payloadB).select("*").limit(1);
          if (error) throw error;
          row = (data||[])[0] || null;
        }

        clearInterval(tick);
        setUploadProgress(100, "Resource has been sent to Admin successfully for approval.");
        setTimeout(()=>hideUploadProgress(), 650);

        // Reset UI + refresh list (approved list unaffected; upload goes to admin queue)
        e.target.reset();

        // Friendly confirmation toast
        try{ toast("Resource has been sent to Admin successfully for approval."); }catch(_){}

        return;
      }catch(err){
        console.warn("[resources] upload failed:", err);
        try{ toast("Upload failed. Please check connection / policies and try again."); }catch(_){}
        setUploadProgress(0);
        hideUploadProgress();
        return;
      }
    }

    // Local/offline fallback (existing behavior)
    const fileData = await fileToDataUrl(file);
    updateState((s) => {
      s.resources.unshift({
        id: crypto.randomUUID(),
        roomId: "",
        title,
        department,
        course: course_code,
        author: user.name,
        authorKey: userKeyFromProfile(user),
        fileName: file.name,
        attachmentData: fileData,
        uploadedAt: new Date().toISOString(),
        status: "pending",
        downloads: 0
      });
    }, "resource uploaded awaiting approval");

    e.target.reset();
    renderResources();
  });

  ["resource-search", "resource-filter-department", "resource-filter-course"].forEach((id) => { if (byId(id)) { byId(id).addEventListener("input", renderResources); byId(id).addEventListener("change", renderResources); } });

  function renderResources() {
    const s = loadState(); const allowed = new Set(myRooms(s, user).map((r) => r.id));
    const q = byId("resource-search").value.trim().toLowerCase(); const d = byId("resource-filter-department").value; const c = byId("resource-filter-course").value; const room = "";
    const listNode = byId("resource-list");
    if (!listNode) return;

    if (dbModeResources) {
      const rows = (resourcesDb || [])
        .filter((r)=> !q || `${r.title||""} ${r.description||""} ${r.course_code||""}`.toLowerCase().includes(q))
        .filter((r)=> !d || (r.department||"") === d)
        .filter((r)=> !c || (r.course_code||"") === c);

      listNode.innerHTML = rows.map((r)=>`
        <article class='item'>
          <div class='item-header wa-row'>
            ${avatarSlotHtml(r.auth_user_id || "", 40)}
            <div class="wa-col">
              <div class="wa-title"><strong>${escapeHtml(r.title || "Resource")}</strong> <span class='pill approved'>approved</span></div>
              <div class='small muted'>${escapeHtml(r.department || "")} • ${escapeHtml(r.course_code || "")} • ${formatDate(r.created_at || r.createdAt || new Date().toISOString())}</div>
            </div>
          </div>
          ${r.description ? `<p class="small">${escapeHtml(r.description)}</p>` : ""}
          <div class='actions'>
            ${r.url ? `<a class='btn secondary' href='${r.url}' target='_blank' rel='noreferrer'>View</a>` : ""}
            ${r.url ? `<a class='btn' href='${r.url}' download>Download</a>` : ""}
            <button class='btn secondary' type='button' data-save-resource='${escapeHtml(r.id)}'>Save</button>
          </div>
        </article>
      `).join("") || "<p class='small'>No resources match your search.</p>";

      hydrateAvatars(listNode);

      // Save action (DB-backed if resource_saves/saved_resources exists)
      listNode.querySelectorAll("[data-save-resource]").forEach((b)=>b.addEventListener("click", async ()=>{
        const rid = b.dataset.saveResource;
        try{
          const supabase = await getSupabase();
          const { data: auth } = await supabase.auth.getUser();
          const uid = auth?.user?.id;
          if (!uid) throw new Error("Not authenticated");

          if (await dbTableExists("resource_saves")){
            const { error } = await supabase.from("resource_saves").insert({ resource_id: rid, user_id: uid });
            if (error && !String(error.message||"").toLowerCase().includes("duplicate")) throw error;
            toast?.("Saved.");
            return;
          }
          if (await dbTableExists("saved_resources")){
            const { error } = await supabase.from("saved_resources").insert({ resource_id: rid, user_id: uid });
            if (error && !String(error.message||"").toLowerCase().includes("duplicate")) throw error;
            toast?.("Saved.");
            return;
          }
          toast?.("Save feature not installed in DB.");
        }catch(e){
          console.warn("[resources] save failed:", e);
          try{ toast(e?.message || "Could not save"); }catch(_){}
        }
      }));

      return;
    }

    listNode.innerHTML = s.resources.filter((r) => r.status === "approved" && allowed.has(r.roomId))
      .filter((r) => !q || `${r.title} ${r.fileName} ${r.author}`.toLowerCase().includes(q))
      .filter((r) => !d || r.department === d).filter((r) => !c || r.course === c).filter((r) => !room || r.roomId === room)
      .map((r) => `<article class='item'>
          <div class='item-header wa-row'>
            ${avatarSlotHtml(r.authorKey || r.author || "", 40)}
            <div class="wa-col">
              <div class="wa-title"><strong>${escapeHtml(r.title)}</strong> <span class='pill approved'>approved</span></div>
              <div class='small muted'>${escapeHtml(r.author || "Student")} • ${roomNameById(s, r.roomId)} • ${escapeHtml(r.department)} • ${escapeHtml(r.course)} • ${formatDate(r.uploadedAt)}</div>
            </div>
          </div>
          <p class='small'>Downloads: ${r.downloads || 0}</p>
          <div class='actions'><a class='btn secondary' href='${r.attachmentData}' target='_blank' rel='noreferrer'>View</a><button type='button' class='btn' data-download-resource='${r.id}'>Download</button></div>
        </article>`).join("") || "<p class='small'>No resources match your search.</p>";

    hydrateAvatars(listNode);

    document.querySelectorAll('[data-download-resource]').forEach((button) => button.addEventListener('click', () => {
      const resourceId = button.dataset.downloadResource;
      const current = loadState().resources.find((r) => r.id === resourceId);
      if (!current) return;
      updateState((s2) => {
        const resource = s2.resources.find((r) => r.id === resourceId);
        if (!resource) return;
        resource.downloads = (resource.downloads || 0) + 1;
        const uploader = s2.users.find((u) => u.regNumber === resource.authorKey || u.regNumber === resource.author);
        if (uploader) uploader.downloadsReceived = (uploader.downloadsReceived || 0) + 1;
      }, 'resource downloaded');
      const link = document.createElement('a');
      link.href = current.attachmentData;
      link.download = current.fileName;
      link.click();
      renderResources();
    }));
  }
  renderResources();
}

function countReaction(answer, type) { return Object.values(answer.reactions || {}).filter((v) => v === type).length; }
function credibility(answer) { return countReaction(answer, "like") - countReaction(answer, "dislike"); }

async function initQA() {
  // Ensure NEW departments are loaded from DB and cached (no old depts)
  try { await loadDepartmentsDb(); } catch(e) {}

  const user = requireSession("student"); if (!user) return;
  renderSidebar("student");
  renderTopbar(`${user.name} • ${user.department}`);
  applyThemeAndNav("qa");
  attachLogout();

  let dbModeQA = false;
  try { dbModeQA = await dbTableExists("qa_questions"); } catch(e) { dbModeQA = false; }

  const qaFilterDept = byId("qa-filter-department");
  const qaDept = byId("qa-department");
  const qaForm = byId("qa-question-form");
  const qaList = byId("qa-list");
  const qaText = byId("qa-question");

  if (!qaDept || !qaForm || !qaList || !qaText) return;

  const departments = getDepartmentsCached ? getDepartmentsCached() : (getCachedDepartments ? getCachedDepartments() : []);
  applyDepartmentsToSelect(qaDept, departments, "Select department");
  if (qaFilterDept) {
    qaFilterDept.innerHTML =
      `<option value=''>All Departments</option>` +
      departments.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  }

  const answersCache = {};
  const answerReactionsCache = {}; // answerId(string) -> {likeCount, dislikeCount, my}
  const answerCommentsCache = {};  // answerId(string) -> [comments]
  let qaDb = [];

  async function reloadQaFeed(preferredDepartment = "") {
    const activeDept =
      preferredDepartment ||
      (qaFilterDept?.value || "") ||
      (qaDept.value || "") ||
      (await getMyDepartment() || "");

    try {
      qaDb = await fetchQACommunity({ department: activeDept || null });
    } catch (e) {
      qaDb = [];
      toast?.("error", e?.message || "Could not load Q&A feed");
    }
    renderQA();
  }

  function renderQA() {
    const selectedDept = qaFilterDept?.value || "";
    const localList = (loadState()?.qa) || [];

    const visible = dbModeQA
      ? qaDb.filter(q => !selectedDept || (q.department || "") === selectedDept)
      : localList
          .filter(q => q.status === "visible")
          .filter(q => !selectedDept || (q.department || "") === selectedDept)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (dbModeQA) {
      const top = visible.slice(0, 10);
      Promise.all(top.map(async (q) => {
        try {
          const ans = await fetchAnswers(q.id);
          const mapped = (ans || []).map(a => ({
            id: String(a.id),
            dbId: a.id,
            text: a.body,
            author: a.author_name || "Student",
            authorKey: a.auth_user_id || a.author_id || "",
            reactions: {},
            comments: []
          }));
          answersCache[q.id] = mapped;

          // Load reaction + comments bundles if tables exist
          try {
            const answerIds = mapped.map(x => x.dbId);
            const rb = await fetchAnswerReactionBundle(answerIds);
            const cb = await fetchAnswerCommentsBundle(answerIds);
            Object.assign(answerReactionsCache, rb || {});
            Object.assign(answerCommentsCache, cb || {});
          } catch(e) {}
        } catch(e) {}
      }));
    }

    qaList.innerHTML = visible.map((q) => {
      const answers = dbModeQA
        ? (answersCache[q.id] || [])
        : [...(q.answers || [])].sort((a, b) => credibility(b) - credibility(a));

      const authorKey = dbModeQA ? (q.author_id || q.auth_user_id || q.author_key || q.authorKey || "") : (q.authorKey || "");
      const title = dbModeQA ? (q.title || q.question || "") : (q.question || "");
      const authorName = dbModeQA ? (q.author_name || q.author || "Student") : (q.author || "Student");
      const deptText = dbModeQA ? (q.department || user.department || "") : (q.department || user.department || "");
      const created = dbModeQA ? q.created_at : q.createdAt;

      return `<article class='item'>
        <div class='item-header wa-row'>
          ${avatarSlotHtml(authorKey, 40)}
          <div class="wa-col">
            <div class="wa-title"><strong>${escapeHtml(title)}</strong></div>
            <div class='small muted'>
              ${escapeHtml(authorName)} • ${escapeHtml(deptText)} • ${formatDate(created)}
            </div>
          </div>
        </div>
        <form data-answer='${q.id}'><textarea name='answer' required></textarea><button class='btn' type='submit'>Submit Answer</button></form>
        ${answers.map((a) => {
          const like = a.reactions?.[userKeyFromProfile(user)] === "like";
          const dislike = a.reactions?.[userKeyFromProfile(user)] === "dislike";
          const commentsId = `comments-${q.id}-${a.id}`;
          const rb = dbModeQA ? (answerReactionsCache[String(a.id)] || { likeCount: 0, dislikeCount: 0, my: "" }) : null;
          const myReact = dbModeQA ? rb.my : (like ? "like" : dislike ? "dislike" : "");
          const likeCount = dbModeQA ? rb.likeCount : countReaction(a, "like");
          const dislikeCount = dbModeQA ? rb.dislikeCount : countReaction(a, "dislike");
          const commentsArr = dbModeQA
            ? ((answerCommentsCache[String(a.id)] || []).map(c => c.body || "").filter(Boolean))
            : (a.comments || []);
          return `<div class='item'>
            <div class="wa-row wa-answer">
              ${avatarSlotHtml(a.authorKey || "", 32, "wa-avatar-answer")}
              <div class="wa-col">
                <p>${escapeHtml(a.text)}</p>
                <p class='small muted'>${escapeHtml(a.author || "Student")} • Credibility ${credibility(a)}</p>
                <div class='actions'>
                  <button class='btn secondary' type='button' data-like='${q.id}:${a.id}'>👍 ${likeCount}${myReact === "like" ? " (you)" : ""}</button>
                  <button class='btn secondary' type='button' data-dislike='${q.id}:${a.id}'>👎 ${dislikeCount}${myReact === "dislike" ? " (you)" : ""}</button>
                  <button class='btn secondary' type='button' data-comment='${q.id}:${a.id}'>Comment</button>
                  <button class='btn secondary' type='button' data-toggle-comments='${commentsId}'>Hide/Show comments</button>
                </div>
                <div id='${commentsId}' class='small'>${commentsArr.join(" | ") || "No comments"}</div>
              </div>
            </div>
          </div>`;
        }).join("") || "<p class='small'>No answers yet.</p>"}
      </article>`;
    }).join("") || "<p class='small'>No questions asked.</p>";

    hydrateAvatars(qaList);

    // Answer posting
    document.querySelectorAll("[data-answer]").forEach((f) => f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = new FormData(f).get("answer").toString().trim();
      if (!text) return;

      if (dbModeQA) {
        try{
          await submitAnswerDb({ question_id: f.dataset.answer, body: text });
          try { answersCache[f.dataset.answer] = (await fetchAnswers(f.dataset.answer)).map(a=>({
            id: String(a.id),
            text: a.body,
            author: a.author_name || "Student",
            authorKey: a.auth_user_id || a.author_id || "",
            reactions: {},
            comments: []
          })); } catch(e){}
          toast?.("success", "Answer posted");
        }catch(err){
          toast?.("error", err?.message || "Failed to post answer");
        }
      } else {
        updateState((s2) => {
          const target = s2.qa.find((x) => x.id === f.dataset.answer);
          if (target) target.answers.push({ id: crypto.randomUUID(), text, author: user.name, authorKey: userKeyFromProfile(user), reactions: {}, comments: [] });
        }, "qa answer posted");
      }
      renderQA();
    }));

    // Like/Dislike/Comments
    document.querySelectorAll("[data-like],[data-dislike],[data-comment]").forEach((b) => b.addEventListener("click", async () => {
      const [qid, aid] = (b.dataset.like || b.dataset.dislike || b.dataset.comment).split(":");
      const me = userKeyFromProfile(user);

      // DB-backed path
      if (dbModeQA) {
        try {
          if (b.dataset.comment) {
            const comment = prompt("Enter comment:");
            if (!comment) return;
            await addAnswerComment({ answer_id: aid, body: comment });
          } else {
            const value = b.dataset.like ? 1 : -1;
            await setAnswerReaction({ answer_id: aid, value });
          }

          // Refresh bundles for just this question's answers
          try {
            const fresh = await fetchAnswers(qid);
            const mapped = (fresh || []).map(a => ({ id: String(a.id), dbId: a.id, text: a.body, author: a.author_name || "Student", authorKey: a.auth_user_id || a.author_id || "", reactions: {}, comments: [] }));
            answersCache[qid] = mapped;
            const answerIds = mapped.map(x => x.dbId);
            const rb = await fetchAnswerReactionBundle(answerIds);
            const cb = await fetchAnswerCommentsBundle(answerIds);
            Object.assign(answerReactionsCache, rb || {});
            Object.assign(answerCommentsCache, cb || {});
          } catch(e) {}

          renderQA();
          return;
        } catch (err) {
          toast?.("error", err?.message || "Failed");
          return;
        }
      }

      // Local fallback path
      if (b.dataset.comment) {
        const comment = prompt("Enter comment:");
        if (!comment) return;
        updateState((s2) => {
          const q = s2.qa.find((x) => x.id === qid);
          const a = q?.answers?.find((x) => x.id === aid);
          if (a) a.comments.push(comment);
        }, "qa comment added");
      } else {
        const newR = b.dataset.like ? "like" : "dislike";
        updateState((s2) => {
          const ans = s2.qa.find((q) => q.id === qid)?.answers?.find((a) => a.id === aid);
          if (!ans) return;
          ans.reactions = ans.reactions || {};
          ans.reactions[me] = ans.reactions[me] === newR ? "" : newR;
        }, "qa reaction updated");
      }
      renderQA();
    }));

    document.querySelectorAll("[data-toggle-comments]").forEach((b) => b.addEventListener("click", () => {
      const node = byId(b.dataset.toggleComments);
      if (node) node.hidden = !node.hidden;
    }));
  }

  // Ask question handler
  qaForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const question = (qaText.value || "").trim();
    const deptSel = (qaDept.value || qaFilterDept?.value || user.department || "").trim();
    if (!question) return;
    if (!deptSel) { toast?.("warning", "Select a department"); return; }

    if (dbModeQA) {
      try{
        await submitQuestionDb({ title: question.slice(0, 120), body: question, department: deptSel });
        if (qaFilterDept && qaFilterDept.value !== deptSel) qaFilterDept.value = deptSel;
        if (qaDept.value !== deptSel) qaDept.value = deptSel;
        await reloadQaFeed(deptSel);
        qaForm.reset();
        toast?.("success", "Question posted");
      }catch(err){
        toast?.("error", err?.message || "Failed to post question");
      }
      return;
    }

    updateState((s) => {
      s.qa.unshift({
        id: crypto.randomUUID(),
        question,
        department: deptSel,
        author: user.name,
        authorKey: userKeyFromProfile(user),
        createdAt: new Date().toISOString(),
        answers: [],
        status: "visible"
      });
    }, "qa question submitted");
    qaForm.reset();
    renderQA();
  });

  qaFilterDept?.addEventListener("change", () => reloadQaFeed(qaFilterDept.value || ""));
  await reloadQaFeed(qaFilterDept?.value || qaDept.value || user.department || "");

  // Keep any existing like-bars wiring safe
  try { wireLikeBars(qaList, "qa", userKeyFromProfile(user), { dbModeQA }); } catch(e){}
}


function initTasks() {
  const user = requireSession("student"); if (!user) return;
  renderSidebar(); renderTopbar(`${user.name} • ${user.department}`); applyThemeAndNav("tasks"); attachLogout();
  const s = loadState(); const allowed = new Set(myRooms(s, user).map((r) => r.id));
  byId("task-list").innerHTML = s.tasks.filter((t) => allowed.has(t.roomId)).map((t) => `<article class='item'><div class='item-header'><strong>${t.title}</strong><span class='pill ${t.status}'>${t.status}</span></div><p class='small'>${roomNameById(s, t.roomId)} • ${formatDate(t.deadline)}</p><button class='btn secondary' data-task='${t.id}'>Toggle Status</button></article>`).join("");
  document.querySelectorAll("[data-task]").forEach((b) => b.addEventListener("click", () => { updateState((s2) => { const t = s2.tasks.find((x) => x.id === b.dataset.task); t.status = t.status === "pending" ? "completed" : "pending"; }, "task status updated"); initTasks(); }));
}

function initCatalog() {
  const loggedIn = hasAuthFlag();

  if (!loggedIn) {
    // Public view: always ignore any leftover cached sessions
    try { document.querySelector("[data-sidebar]")?.remove(); } catch(e){}
    try { document.querySelector("[data-topbar]")?.remove(); } catch(e){}
    try { document.body.classList.add("public-page"); } catch(e){}
    // Do NOT render any internal navigation in public pages
    applyThemeAndNav("catalog");
    renderPublicHitCatalog();
    return;
  }

  const st = loadState();
  // Logged-in view: still safe, but never show admin controls here
  renderSidebar("student");
  renderTopbar(`${escapeHtml((st.sessions?.student?.name || st.sessions?.admin?.name || "User"))} • catalog`);
  applyThemeAndNav("catalog");
  // IMPORTANT: logged-in users must also see the public catalogue (previously empty)
  renderPublicHitCatalog();
  attachLogout();
}

function initProfile() {
  const state = loadState();
  const student = state.sessions.student;
  const admin = state.sessions.admin;
  if (!student && !admin) return (window.location.href = "index.html");

  const isAdmin = Boolean(admin);
  const actor = admin || student;
  renderSidebar(isAdmin ? "admin" : "student");
  renderTopbar(`${actor.name} • ${isAdmin ? actor.role : actor.department}`);
  applyThemeAndNav("profile");
  attachLogout();

  const target = byId("profile-content");
  if (!target) return;

  if (!isAdmin) {
    const meKey = userKeyFromProfile(student);
    const myRoomsCount = state.chatrooms.filter((room) => room.members.includes("*") || room.members.includes(meKey)).length;
    const myQuestions = state.qa.filter((q) => q.authorKey === meKey);
    const myReplies = myQuestions.reduce((sum, q) => sum + q.answers.length, 0);
    const myResources = state.resources.filter((r) => r.authorKey === meKey || r.author === student.name);
    const totalDownloads = myResources.reduce((sum, r) => sum + (r.downloads || 0), 0);
    const profile = state.users.find((u) => u.regNumber === student.regNumber) || student;

    target.innerHTML = `<section class="card">
      <div class="profile-header">
        ${avatarSlotHtml(profile.regNumber || profile.id || profile.name, 56, "wa-avatar-profile")}
        <div class="profile-meta">
          <div class="profile-name-row">
            <strong class="profile-name">${escapeHtml(profile.name)}</strong>
            <span class="small muted">@${escapeHtml(profile.username || "")}</span>
          </div>
          <div class="small muted">${escapeHtml(profile.regNumber)} • ${escapeHtml(profile.department || "")} • Part ${escapeHtml(profile.part || "-")}</div>
        </div>
      </div>

      <div class="profile-actions">
        <label class="btn btn-ghost" for="avatar-file">Choose photo</label>
        <input id="avatar-file" type="file" accept="image/*" class="hidden-file" />
        <button id="btn-upload-avatar" class="btn btn-primary" type="button">Update photo</button>
</div>

      <div class="grid two">
        <div>
          <h3 style="margin-top:0;">My Details</h3>
          <p><strong>Name:</strong> ${escapeHtml(profile.name)}</p>
          <p><strong>Reg Number:</strong> ${escapeHtml(profile.regNumber)}</p>
          <p><strong>Department:</strong> ${escapeHtml(profile.department)}</p>
        </div>
        <div>
          <h3 style="margin-top:0;">Account</h3>
          <p><strong>Username:</strong> ${escapeHtml(profile.username || "-")}</p>
          <p><strong>Last Login:</strong> ${profile.lastLoginAt ? formatDate(profile.lastLoginAt) : "-"}</p>
        </div>
      </div>
    </section>
    <section class='grid cards'>
      <article class='card'><h3>Groups</h3><p>${myRoomsCount}</p></article>
      <article class='card'><h3>Questions Asked</h3><p>${myQuestions.length}</p></article>
      <article class='card'><h3>Replies Received</h3><p>${myReplies}</p></article>
      <article class='card'><h3>Documents Uploaded</h3><p>${myResources.length}</p></article>
      <article class='card'><h3>Total Downloads</h3><p>${totalDownloads}</p></article>
    </section>`;
    hydrateAvatars(target);
    // Bind avatar upload on profile page
    wireAvatarUploadUI({ inputId: 'avatar-file', buttonId: 'btn-upload-avatar' });
    return;
  }

  target.innerHTML = `<section class='card'><h3>Active User Profiles</h3><div id='admin-profile-list' class='grid cards'></div></section><section class='card' id='admin-profile-editor'><h3>Edit User Profile</h3><form id='admin-edit-user-form'><input type='hidden' id='edit-user-reg'><label>Name</label><input id='edit-user-name' required><label>Department</label><input id='edit-user-department' required><label>Part</label><select id='edit-user-part'>${STUDY_PARTS.map((p) => `<option>${p}</option>`).join('')}</select><label>Username</label><input id='edit-user-username' required><button class='btn' type='submit'>Save User Profile</button></form></section>`;

  function renderAdminProfiles() {
    const fresh = loadState();
    const activeRegs = new Set([fresh.sessions.student?.regNumber].filter(Boolean));
    const users = fresh.users.filter((u) => activeRegs.size === 0 || activeRegs.has(u.regNumber));
    byId('admin-profile-list').innerHTML = users.map((u) => `<article class='card'><h4>${u.name}</h4><p class='small'>${u.regNumber} • ${u.department} • ${u.part || '-'}</p><p class='small'>Last login: ${u.lastLoginAt ? formatDate(u.lastLoginAt) : '-'}</p><button class='btn secondary' type='button' data-edit-profile='${u.regNumber}'>Edit</button></article>`).join('') || "<p class='small'>No active student profiles.</p>";

    document.querySelectorAll('[data-edit-profile]').forEach((button) => button.addEventListener('click', () => {
      const user = loadState().users.find((u) => u.regNumber === button.dataset.editProfile);
      if (!user) return;
      byId('edit-user-reg').value = user.regNumber;
      byId('edit-user-name').value = user.name;
      byId('edit-user-department').value = user.department;
      byId('edit-user-part').value = user.part || STUDY_PARTS[0];
      byId('edit-user-username').value = user.username || '';
    }));
  }

  byId('admin-edit-user-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const reg = byId('edit-user-reg').value;
    const username = byId('edit-user-username').value.trim().toLowerCase();
    if (!reg) return alert('Choose a user profile to edit.');
    const conflict = loadState().users.some((u) => u.regNumber !== reg && u.username?.toLowerCase() === username);
    if (conflict) return alert('Username already exists.');

    updateState((s2) => {
      const user = s2.users.find((u) => u.regNumber === reg);
      if (!user) return;
      user.name = byId('edit-user-name').value.trim();
      user.department = byId('edit-user-department').value.trim();
      user.part = byId('edit-user-part').value;
      user.username = username;
    }, 'admin edited user profile');
    renderAdminProfiles();
    alert('User profile updated.');
  });

  renderAdminProfiles();
// Avatar upload (with WhatsApp-style circle crop)
const __avatarFileInput = byId("avatar-file");
__avatarFileInput?.addEventListener("change", async ()=>{
  try {
    const file = __avatarFileInput.files?.[0];
    if (!file) return;
    // Open cropper immediately so user selects the circle area
    const blob = await openAvatarCropper(file);
    if (!blob) return;
    // Store cropped blob for the upload button
    __avatarFileInput.__croppedBlob = blob;
  } catch(e) {
    console.warn(e);
    alert(e.message || "Could not open cropper");
  }
});

byId("btn-upload-avatar")?.addEventListener("click", async ()=>{
  try{
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return alert("Not authenticated.");

    const file = __avatarFileInput?.files?.[0];
    if (!file) return alert("Choose an image first.");

    // Use cropped blob if available; otherwise fall back to original
    const blob = __avatarFileInput.__croppedBlob || file;

    // Upload to Supabase Storage bucket: avatars
    const path = `${uid}/avatar.png`;
    const { error: upErr } = await supabase.storage
      .from("avatars")
      .upload(path, blob, { upsert: true, contentType: "image/png" });
    if (upErr) return alert("Upload failed: " + upErr.message);

    const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
    const url = pub?.publicUrl;

    // Save URL pointer in DB (best practice)
    const { error: saveErr } = await supabase
      .from("student_profiles")
      .update({ avatar_url: url })
      .eq("auth_user_id", uid);

    if (saveErr) return alert("Could not save to profile: " + saveErr.message);

    // Cache + refresh UI
    __avatarCache.set(uid, url);
    try {
      const st = loadState();
      const rk = st?.sessions?.student?.regNumber;
      if (rk) __avatarCache.set(String(rk), url);
    } catch(e){}
    hydrateAvatars(document);

    // Clear cropped blob so next pick re-crops
    try{ __avatarFileInput.__croppedBlob = null; }catch(e){}

    alert("Profile photo updated.");
  }catch(e){
    alert(e.message || "Could not upload");
  }
});

}

function initSupport() {
  const loggedIn = hasAuthFlag();

  if (!loggedIn) {
    // Public view: always ignore any leftover cached sessions
    try { document.querySelector("[data-sidebar]")?.remove(); } catch(e){}
    try { document.querySelector("[data-topbar]")?.remove(); } catch(e){}
    try { document.body.classList.add("public-page"); } catch(e){}
    // Do NOT render any internal navigation in public pages
    return;
  }

  const st = loadState();
  // Logged-in view: still safe, but never show admin controls here
  renderSidebar("student");
  renderTopbar(`${escapeHtml((st.sessions?.student?.name || st.sessions?.admin?.name || "User"))} • help`);
  applyThemeAndNav("support");
  attachLogout();
}

function initAdminLogin() {
  try{ applyThemeAndNav("adminLogin"); }catch(e){}
  byId("admin-login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const name = byId("admin-name").value.trim();
    const code = byId("admin-code").value.trim();
    const selectedRole = (byId("admin-role")?.value || "").trim();

    if (!name) return alert("Admin name is required.");
    if (!code) return alert("Admin code is required.");

    const identity = `admin:${name}`;
    if (isBlocked(identity)) return alert("Admin identity is blocked.");

    const supabase = await getSupabase();
    if (!supabase) return alert("Database connection not available.");

    // Validate against admin_users table (username + code must match)
    // NOTE: keep the selectedRole as UI hint only; DB role is the source of truth.
    const { data, error } = await supabase
      .from("admin_users")
      .select("*")
      .eq("username", name)
      .maybeSingle();

    if (error) {
      trackFailedAttempt(identity, "admin-login");
      return alert("Admin login failed. Check database policies/table columns.");
    }

    if (!data || data.is_active === false) {
      trackFailedAttempt(identity, "admin-login");
      return alert("Invalid code or admin.");
    }

    // Support multiple possible code column names
    const dbCode = (data.code || data.admin_code || data.passcode || data.pass_code || data.secure_code || "").toString().trim();

    if (!dbCode || dbCode !== code) {
      trackFailedAttempt(identity, "admin-login");
      return alert("Invalid code or admin.");
    }



// HARD FIX: ensure no leftover student session/cached profile remains when admin signs in
try { await supabase.auth.signOut(); } catch (e) {}
try {
  updateState((s) => {
    s.sessions.student = null;
    s.currentUserId = null;
    s.lastStudent = null;
    s.profileCache = null;
    s.userCache = null;
  }, "hard-clear student session before admin login");
} catch (e) {}
    const admin = {
      id: data.auth_user_id || data.id || crypto.randomUUID(),
      name: data.username || name,
      role: (data.role || selectedRole || "admin"),
      code: code,
      codeHash: "verified"
    };

    setCurrentSession("admin", admin);
    addWelcomeMessage(admin.name);
    setAuthMode("admin");
    setAuthFlag();
    window.location.href = "admin-panel.html";
  });
}

function initAdminPanel() {
  const admin = requireSession("admin"); if (!admin) return;
  renderSidebar("admin"); renderTopbar(`${admin.name} • ${admin.role}`); applyThemeAndNav("admin-panel"); attachLogout();
  const state = loadState();
  byId("admin-announcement").value = state.settings.announcement; byId("admin-welcome").value = state.settings.welcomeText; byId("admin-banner").value = state.settings.dashboardBanner;
  byId("chat-toggle").checked = state.settings.featureVisibility.chat; byId("resources-toggle").checked = state.settings.featureVisibility.resources; byId("qa-toggle").checked = state.settings.featureVisibility.qa; byId("tasks-toggle").checked = state.settings.featureVisibility.tasks;
  byId("active-users-count").textContent = `${[state.sessions.student, state.sessions.admin].filter(Boolean).length}`;
  byId("known-users-count").textContent = `${state.users.length}`;

  // Ensure backgroundImages structure exists (backwards compatible)
  updateState((s)=>{
    if (!s.settings.backgroundImages) s.settings.backgroundImages = { default: s.settings.backgroundImage || "", pages: {} };
    if (!s.settings.backgroundImages.pages) s.settings.backgroundImages.pages = {};
    if (!s.settings.backgroundImages.default) s.settings.backgroundImages.default = s.settings.backgroundImage || "";
  }, "ensure backgroundImages structure");

  // Helper: read selected background targets from the admin panel UI
  function getSelectedBgTargets(){
    return Array.from(document.querySelectorAll(".bg-target:checked")).map((n)=> n.value);
  }

  // Some pages historically used different keys (e.g., adminPanel vs admin-panel).
  // When saving backgrounds, write to both forms so it always shows up.
  function expandBgTargets(targets){
    const out = new Set();
    (targets || []).forEach((t)=>{
      out.add(t);
      if (t === "admin-panel") out.add("adminPanel");
      if (t === "adminPanel") out.add("admin-panel");
    });
    return Array.from(out);
  }

  byId("clear-selected-bgs")?.addEventListener("click", (e)=>{
    e.preventDefault();
    const targets = getSelectedBgTargets();
    updateState((s)=>{
      if (!s.settings.backgroundImages) s.settings.backgroundImages = { default: s.settings.backgroundImage || "", pages: {} };
      if (!s.settings.backgroundImages.pages) s.settings.backgroundImages.pages = {};
      if (!targets.length){
        // If nothing selected, clear the default background
        s.settings.backgroundImages.default = "";
        s.settings.backgroundImage = "";
      } else {
        targets.forEach((t)=>{ delete s.settings.backgroundImages.pages[t]; });
      }
    }, "background(s) cleared");
    const note = byId("bg-status");
    if (note) note.textContent = targets.length ? `Cleared: ${targets.join(", ")}` : "Cleared default background";
    applyThemeAndNav("admin-panel");
  });

  byId("customization-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = byId("admin-bg").files[0];
    const targets = getSelectedBgTargets();
    let bg = null;
    if (file){
      try{
        // Preferred: upload to Supabase Storage (bucket: backgrounds) and store the public URL
        bg = await uploadBackgroundToSupabaseStorage(file);
      }catch(err){
        console.warn("Background upload to storage failed, falling back to local data URL:", err);
        // Fallback: store a data URL locally so the feature still works even without Storage policies
        bg = await fileToDataUrl(file);
        const note = byId("bg-status");
        if (note) note.textContent = "Storage upload failed (check bucket/policies). Saved locally for this device instead.";
      }
    }

    updateState((s) => {
      s.settings.announcement = byId("admin-announcement").value.trim();
      s.settings.welcomeText = byId("admin-welcome").value.trim();
      s.settings.dashboardBanner = byId("admin-banner").value.trim();
      s.settings.featureVisibility = {
        chat: byId("chat-toggle").checked,
        resources: byId("resources-toggle").checked,
        qa: byId("qa-toggle").checked,
        tasks: byId("tasks-toggle").checked
      };

      if (!s.settings.backgroundImages) s.settings.backgroundImages = { default: s.settings.backgroundImage || "", pages: {} };
      if (!s.settings.backgroundImages.pages) s.settings.backgroundImages.pages = {};

      // Background behavior:
      // - If an image is chosen and targets are selected => set per-target backgrounds
      // - If an image is chosen and no targets are selected => set default background
      if (bg){
        if (targets.length){
          expandBgTargets(targets).forEach((t)=>{ s.settings.backgroundImages.pages[t] = bg; });
        } else {
          s.settings.backgroundImages.default = bg;
          // keep legacy key in sync
          s.settings.backgroundImage = bg;
        }
      }
    }, "admin customization updated");

    const note = byId("bg-status");
    if (note){
      const alreadyWarned = (note.textContent || "").toLowerCase().includes("storage upload failed");
      if (!alreadyWarned){
        if (!bg) note.textContent = "Saved text/toggles (no new background selected)";
        else if (targets.length) note.textContent = `Background saved for: ${targets.join(", ")}`;
        else note.textContent = "Default background saved";
      }
    }
    applyThemeAndNav("admin-panel");
    renderModerationTables();
  // Live DB users for User Management
  refreshAdminUsersFromDb().then(()=>{ try{ renderModerationTables(); }catch(e){} });
  });

  byId("department-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const dep = byId("new-department").value.trim();
    const code = byId("new-course-code")?.value.trim();
    const name = byId("new-course-name")?.value.trim();
    if (!dep) return alert("Department is required.");

    updateState((s) => {
      if (!s.departments.includes(dep)) s.departments.push(dep);
      if (code && name) {
        const existing = s.courses.find((course) => course.code === code);
        if (existing) {
          existing.name = name;
          existing.department = dep;
        } else {
          s.courses.push({ id: crypto.randomUUID(), code, name, department: dep });
        }
      }
    }, "department/course managed");
    e.target.reset(); renderModerationTables();
  });

  byId("rename-dept-form").addEventListener("submit", (e) => {
    e.preventDefault(); const oldName = byId("rename-source").value; const newName = byId("rename-target").value.trim(); if (!oldName || !newName) return;
    updateState((s) => {
      s.departments = s.departments.map((d) => d === oldName ? newName : d);
      s.courses.forEach((c) => { if (c.department === oldName) c.department = newName; });
      s.users.forEach((u) => { if (u.department === oldName) u.department = newName; });
    }, "department renamed");
    e.target.reset(); renderModerationTables();
  });

  byId("delete-dept-form").addEventListener("submit", (e) => {
    e.preventDefault(); const dep = byId("delete-department").value; if (!dep) return;
    updateState((s) => { s.departments = s.departments.filter((d) => d !== dep); s.courses = s.courses.filter((c) => c.department !== dep); }, "department deleted");
    renderModerationTables();
  });

  renderModerationTables();
  initPublicHitCatalogAdmin();
}


// ===== Admin Security Actions (block / view / notice) =====
function normalizeIdentityKey(v){
  const s = String(v||"").trim();
  // strip common UI suffixes like ":1"
  return s.replace(/:\d+$/,"");

  // Ensure admin moderation tables render on initial load (DB pending resources override runs inside)
  try { renderModerationTables(); } catch (e) { console.warn("[admin] renderModerationTables failed:", e); }
  // Refresh live DB users (User Management) and rerender once loaded
  try { refreshAdminUsersFromDb().then(()=>{ try { renderModerationTables(); } catch(_){} }); } catch(_){}
}
function isUuidLike(v){
  const s = String(v||"").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}
function findUserByIdentity(state, identity){
  const key = normalizeIdentityKey(identity);
  const list = getAdminUserList(state);
  return (list||[]).find(u => u.regNumber === key || u.username === key || u.authUserId === key) || null;
}
async function tryBlockUserInDb(identity){
  try{
    const supabase = await getSupabase();
    const key = normalizeIdentityKey(identity);
    // Try UUID auth_user_id first if it looks like one
    if (isUuidLike(key)){
      const { error } = await supabase.from("student_profiles").update({ is_blocked: true }).eq("auth_user_id", key);
      if (!error) return { ok:true, via:"auth_user_id" };
    }
    // Try reg_number then username (common schemas)
    let r1 = await supabase.from("student_profiles").update({ is_blocked: true }).eq("reg_number", key);
    if (!r1.error) return { ok:true, via:"reg_number" };
    let r2 = await supabase.from("student_profiles").update({ is_blocked: true }).eq("username", key);
    if (!r2.error) return { ok:true, via:"username" };

    // Some projects use auth_user_id but store non-uuid (rare) — attempt anyway
    let r3 = await supabase.from("student_profiles").update({ is_blocked: true }).eq("auth_user_id", key);
    if (!r3.error) return { ok:true, via:"auth_user_id_fallback" };

    return { ok:false, error: r2.error || r1.error || r3.error };
  }catch(e){
    return { ok:false, error: e };
  }
}
function pushPrivateNotice(toIdentity, fromLabel, message){
  const to = normalizeIdentityKey(toIdentity);
  const msg = String(message||"").trim();
  if (!to || !msg) return false;
  const notice = { id: `n_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, to, from: fromLabel || "Admin", message: msg, at: new Date().toISOString() };
  try{
    updateState((s)=>{
      if (!Array.isArray(s.admin_private_notices)) s.admin_private_notices = [];
      s.admin_private_notices.unshift(notice);
      // keep sane cap
      if (s.admin_private_notices.length > 300) s.admin_private_notices = s.admin_private_notices.slice(0,300);
    }, "Admin private notice");
    return true;
  }catch(e){
    return false;
  }
}
function showUserQuickView(state, identity){
  const key = normalizeIdentityKey(identity);
  const u = findUserByIdentity(state, key);
  if (!u){
    alert(`User not found for identity: ${key}`);
    return;
  }
  const lines = [
    `Name: ${u.name||"-"}`,
    `Reg: ${u.regNumber||"-"}`,
    `Username: ${u.username||"-"}`,
    `Department: ${u.department||"-"}`,
    `Part: ${u.part||"-"}`
  ];
  alert(lines.join("\\n"));
}
// ===== End Admin Security Actions =====

function renderModerationTables() {
  // User Management live search term (persist in-memory)
  if (typeof window.__edupath_admin_user_search !== 'string') window.__edupath_admin_user_search = '';

  const state = loadState();
  byId("rename-source").innerHTML = (getDepartmentsCached()).map((d)=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  byId("delete-department").innerHTML = (getDepartmentsCached()).map((d)=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");

    // Resource Approval (LIVE DB) — rebuilt minimal table
  renderAdminPendingResourcesTable().catch(()=>{});

  byId("qa-moderation").innerHTML = state.qa.map((q) => `<tr><td>${q.question}</td><td>${roomNameById(state, q.roomId)}</td><td>${q.department}</td><td>${q.status}</td><td><button class='btn secondary' data-toggle-qa='${q.id}'>${q.status === "visible" ? "Hide" : "Show"}</button></td></tr>`).join("");
  byId("chat-moderation").innerHTML = state.chats.slice(0, 20).map((m) => `<tr><td>${m.sender}</td><td>${roomNameById(state, m.roomId)}</td><td>${(m.message || "").slice(0, 60)}</td><td><button class='btn warn' data-delete-chat='${m.id}'>Remove</button></td></tr>`).join("");
  byId("room-management").innerHTML = state.chatrooms.map((r) => `<tr><td>${r.name}</td><td>${r.code}</td><td>${r.members.length}</td><td>${r.isDefault ? "System" : r.ownerKey}</td><td>${r.isDefault ? "-" : `<button class='btn warn' data-remove-room='${r.id}'>Delete Room</button>`}</td></tr>`).join("");
  byId("security-table").innerHTML = state.security.failedAttempts.map((f) => `<tr><td>${f.identity}</td><td>${f.area}</td><td>${f.count}</td><td>${formatDate(f.lastAttemptAt)}</td><td>${state.security.blockedUsers.includes(f.identity) ? `<button class=\'btn secondary\' data-unblock=\'${f.identity}\'>Unblock</button>` : `<button class=\'btn warn\' data-block=\'${f.identity}\'>Block</button>`}</td></tr>`).join("") || "<tr><td colspan='5'>No suspicious attempts recorded.</td></tr>";
  byId("activity-logs").innerHTML = state.logs.slice(0, 50).map((l) => {
    const a = l.actor || {};
    const actorLabel = a.type === "student"
      ? `${escapeHtml(a.name || "Student")} <span class="small muted">@${escapeHtml(a.username || "")}</span><div class="small muted">${escapeHtml(a.regNumber || "")}</div>`
      : (a.type === "admin"
          ? `${escapeHtml(a.name || "Admin")} <span class="pill small">admin</span>`
          : `<span class="muted small">unknown</span>`);

    const identity = a.regNumber || a.username || a.userId || "";
    const actions = (a.type === "student" && identity)
      ? `<button class="btn" data-viewprofile="${escapeHtml(identity)}">View profile</button>
         <button class="btn warn" data-block="${escapeHtml(identity)}">Block</button>
         <button class="btn btn-primary" data-notice="${escapeHtml(identity)}">Send notice</button>`
      : `<span class="muted small">—</span>`;

    return `<tr>
      <td>${formatDate(l.at)}</td>
      <td>${actorLabel}</td>
      <td>${escapeHtml(l.action)}</td>
      <td>${actions}</td>
    </tr>`;
  }).join("") || "<tr><td colspan='4'>No logs yet.</td></tr>";
    // User Management (dedupe + live search + actions)
  const userSearchEl = document.getElementById("user-search");
  if (userSearchEl && !userSearchEl.__bound){
    userSearchEl.__bound = true;
    userSearchEl.addEventListener("input", (e)=>{
      window.__edupath_admin_user_search = String(e.target.value||"");
      renderModerationTables();
    });
  }
  const q = String(window.__edupath_admin_user_search||"").trim().toLowerCase();
  const baseUsers = getAdminUserList(state);
  const dedupedUsers = [...new Map((baseUsers||[]).map((u) => [u.regNumber || u.username || u.authUserId, u])).values()];
  const filteredUsers = q
    ? dedupedUsers.filter((u)=>{
        const hay = `${u.name||""} ${u.regNumber||""} ${u.username||""} ${u.department||""} ${u.part||""}`.toLowerCase();
        return hay.includes(q);
      })
    : dedupedUsers;

  const meta = document.getElementById("user-search-meta");
  if (meta) meta.textContent = q ? `${filteredUsers.length} match(es)` : `${dedupedUsers.length} user(s)`;

  byId("user-table").innerHTML = filteredUsers.map((u) => {
    const identity = escapeHtml(u.regNumber || u.username || u.authUserId || "");
    const blockedLocal = (state.security && Array.isArray(state.security.blockedUsers) && identity && state.security.blockedUsers.includes(identity));
    const blocked = blockedLocal || !!u.isBlockedDb;
    return `<tr>
      <td>${escapeHtml(u.name||"")}</td>
      <td>${escapeHtml(u.department||"")}</td>
      <td>${escapeHtml(u.part||"-")}</td>
      <td>${escapeHtml(u.regNumber||"")}</td>
      <td>${escapeHtml(u.username||"-")}</td>
      <td>
        <button class="btn" data-viewprofile="${identity}">View</button>
        ${blocked ? `<button class="btn secondary" data-unblock="${identity}">Unblock</button>` : `<button class="btn warn" data-block="${identity}">Block</button>`}
        <button class="btn btn-primary" data-notice="${identity}">Send notice</button>
      </td>
    </tr>`;
  }).join("") || "<tr><td colspan='6'>No users found.</td></tr>";

  
  // Delegated click handlers (prevents "dead buttons" when tables rerender)
  if (!window.__edupath_admin_action_bound){
    window.__edupath_admin_action_bound = true;
    document.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-approve],[data-reject],[data-toggle-qa],[data-delete-chat],[data-remove-room],[data-block],[data-unblock],[data-viewprofile],[data-notice]");
      if (!btn) return;

      const stBefore = loadState();

// DB-backed resource approval (faculty only). Sends a DM to uploader on approve/reject.
if (btn.dataset.approve || btn.dataset.reject){
  try{
    if (!(await dbTableExists("resources"))) throw new Error("resources table not installed");
    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const adminUid = auth?.user?.id;
    if (!adminUid) throw new Error("Not authenticated");

    // Ensure this user is faculty
    const { data: prof, error: pErr } = await supabase
      .from("student_profiles")
      .select("role,full_name,username")
      .eq("auth_user_id", adminUid)
      .maybeSingle();
    if (pErr) throw pErr;
    if ((prof?.role || "").toLowerCase() !== "faculty") return; // not faculty → ignore

    const rid = btn.dataset.approve || btn.dataset.reject;
    const isApprove = !!btn.dataset.approve;

    // Confirm action
    const ok = confirm(isApprove ? "Approve this resource? It will become visible to students." : "Reject this resource? The uploader will be notified.");
    if (!ok) return;

    // Fetch row to get uploader + metadata
    const { data: rows, error: fetchErr } = await supabase.from("resources").select("*").eq("id", rid).limit(1);
    if (fetchErr) throw fetchErr;
    const r = (rows||[])[0];
    if (!r) { try{ toast("Resource not found in DB."); }catch(_){}; return; }

    const newStatus = isApprove ? "approved" : "rejected";

    // Update (try richer schema, fallback to minimal)
    let uerr = null;
    const patchA = { status: newStatus, reviewed_at: new Date().toISOString(), reviewed_by: adminUid };
    const { error: e1 } = await supabase.from("resources").update(patchA).eq("id", rid);
    uerr = e1 || null;
    if (uerr){
      const { error: e2 } = await supabase.from("resources").update({ status: newStatus }).eq("id", rid);
      if (e2) throw e2;
    }

    // Notify uploader (DM)
    const uploaderUid = r.uploader_id || r.auth_user_id || r.user_id || r.created_by;
    const resTitle = r.title || r.file_name || r.fileName || "your resource";
    if (uploaderUid && (await dbTableExists("dm_messages"))){
      const msg = isApprove
        ? `✅ Your resource "${resTitle}" has been APPROVED and is now visible in the Resource Hub. Thank you for sharing with EDUPATH+.`
        : `❌ Your resource "${resTitle}" has been REJECTED. Contact the Admin for more details.`;
      const { error: dmErr } = await supabase.from("dm_messages").insert({ sender_id: adminUid, receiver_id: uploaderUid, body: msg });
      if (dmErr) console.warn("[admin][resources] notify DM failed:", dmErr.message);
    }

    try{ toast(isApprove ? "Approved. Uploader notified." : "Rejected. Uploader notified."); }catch(_){}
    try{ renderModerationTables(); }catch(_){}
    return; // handled in DB mode
  }catch(e){
    console.warn("[admin][resources] DB approve/reject failed:", e);
    try{ toast("Approval failed. Check RLS/policies."); }catch(_){}
    // fall through to local behavior
  }
}

      // Approvals / moderation (local state)
      if (btn.dataset.approve || btn.dataset.reject || btn.dataset.toggleQa || btn.dataset.deleteChat || btn.dataset.removeRoom){
        updateState((s) => {
          if (btn.dataset.approve) s.resources.find((r) => r.id === btn.dataset.approve).status = "approved";
          if (btn.dataset.reject) s.resources.find((r) => r.id === btn.dataset.reject).status = "rejected";
          if (btn.dataset.toggleQa) { const q = s.qa.find((x) => x.id === btn.dataset.toggleQa); q.status = q.status === "visible" ? "hidden" : "visible"; }
          if (btn.dataset.deleteChat) s.chats = s.chats.filter((m) => m.id !== btn.dataset.deleteChat);
          if (btn.dataset.removeRoom) {
            const rid = btn.dataset.removeRoom;
            s.chatrooms = s.chatrooms.filter((r) => r.id !== rid);
            s.chats = s.chats.filter((m) => m.roomId !== rid);
            s.tasks = s.tasks.filter((t) => t.roomId !== rid);
            s.resources = s.resources.filter((r) => r.roomId !== rid);
            s.qa = s.qa.filter((q) => q.roomId !== rid);
          }
        }, "admin moderation action");
        renderModerationTables();
        return;
      }

      // View profile
      if (btn.dataset.viewprofile){
        const state = loadState();
        showUserQuickView(state, btn.dataset.viewprofile);
        return;
      }

      // Send notice (private DM-style notice shown in Inbox)
      if (btn.dataset.notice){
        const admin = requireSession("admin");
        const to = normalizeIdentityKey(btn.dataset.notice);
        const msg = prompt(`Send notice to ${to}:`, "Please maintain academic integrity and platform standards.");
        if (!msg) return;

        const res = await sendAdminNoticeToUser(to, admin?.name || "Admin", msg);
        if (res.ok){
          alert("Notice sent.");
        }else if (res.reason === "missing_table"){
          alert("Notice not sent: admin_private_notices table is not installed.\n\nRun the SQL in README to enable DB notices.");
        }else if (res.reason === "user_not_found"){
          alert("Notice not sent: user not found (reg/username mismatch).");
        }else{
          alert(`Notice not sent: ${res.reason}`);
        }
        return;
      }

      // Unblock user (confirm first)
      if (btn.dataset.unblock){
        const identity = normalizeIdentityKey(btn.dataset.unblock);
        const sure = confirm(`Unblock ${identity} and restore access to the system?`);
        if (!sure) return;

        // DB-level unblock (best effort)
        try{
          const supabase = await getSupabase();
          const key = normalizeIdentityKey(identity);
          if (isUuidLike(key)){
            const { error } = await supabase.from("student_profiles").update({ is_blocked: false }).eq("auth_user_id", key);
            if (!error) {/* ok */}
          }
          // try reg/username too
          await supabase.from("student_profiles").update({ is_blocked: false }).eq("reg_number", key);
          await supabase.from("student_profiles").update({ is_blocked: false }).eq("username", key);
        }catch(e){}

        // Always remove from local blocklist
        updateState((s) => {
          if (!s.security) s.security = { failedAttempts: [], blockedUsers: [] };
          if (!Array.isArray(s.security.blockedUsers)) s.security.blockedUsers = [];
          s.security.blockedUsers = s.security.blockedUsers.filter(x => normalizeIdentityKey(x) !== identity);
        }, "Admin unblock user");

        renderModerationTables();
        alert("User unblocked.");
        return;
      }

      // Block user (confirm first)
      if (btn.dataset.block){
        const admin = requireSession("admin");
        const identity = normalizeIdentityKey(btn.dataset.block);
        const sure = confirm(`Block ${identity} from accessing the system?

This will immediately prevent future logins.`);
        if (!sure) return;

        // 1) Try DB-level block (best, survives storage clearing)
        const dbRes = await tryBlockUserInDb(identity);

        // 2) Always also record in app_state blocked list (fast local enforcement / fallback)
        updateState((s) => {
          if (!s.security) s.security = { failedAttempts: [], blockedUsers: [] };
          if (!Array.isArray(s.security.blockedUsers)) s.security.blockedUsers = [];
          if (!s.security.blockedUsers.includes(identity)) s.security.blockedUsers.push(identity);
        }, "Admin block user");

        renderModerationTables();

        if (dbRes.ok){
          alert(`User blocked. (DB updated via ${dbRes.via})`);
        }else{
          alert(`User blocked locally.

Note: DB block update failed (RLS/column). If you want server-side enforcement, add student_profiles.is_blocked boolean + allow admin update in RLS.`);
        }
        return;
      }
    });
  }

}
// ============================================
// Admin Resource Approval (REBUIlT, DB-backed)
// Minimal columns: title, department, author, status
// ============================================
async function renderAdminPendingResourcesTable(){
  try{
    const tbody = byId("pending-resources");
    if (!tbody) return;

    // Default placeholder while loading
    tbody.innerHTML = "<tr><td colspan='5'>Loading pending resources…</td></tr>";

    // Ensure DB table exists
    if (!(await dbTableExists("resources"))){
      tbody.innerHTML = "<tr><td colspan='5'>Resources table not installed.</td></tr>";
      return;
    }

    const supabase = await getSupabase();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid){
      tbody.innerHTML = "<tr><td colspan='5'>Not signed in.</td></tr>";
      return;
    }

    // Faculty check (your schema uses full_name)
    const { data: prof, error: pErr } = await supabase
      .from("student_profiles")
      .select("role,full_name,username,is_blocked")
      .eq("auth_user_id", uid)
      .maybeSingle();

    if (pErr){
      console.warn("[admin][resources] profile lookup failed:", pErr.message);
      tbody.innerHTML = "<tr><td colspan='5'>Admin profile lookup failed.</td></tr>";
      return;
    }

    const isFaculty = (prof?.role || "").toLowerCase() === "faculty";
    if (!isFaculty){
      tbody.innerHTML = "<tr><td colspan='5'>Faculty access required.</td></tr>";
      return;
    }
    if (prof?.is_blocked){
      tbody.innerHTML = "<tr><td colspan='5'>Account blocked.</td></tr>";
      return;
    }

    // Load pending resources (your DB uses status='pending')
    const { data: rows, error } = await supabase
      .from("resources")
      .select("id,title,department,course_code,status,auth_user_id,url,created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error){
      console.warn("[admin][resources] pending load failed:", error.message);
      tbody.innerHTML = "<tr><td colspan='5'>Failed to load pending resources.</td></tr>";
      return;
    }

    const res = rows || [];
    if (!res.length){
      tbody.innerHTML = "<tr><td colspan='5'>No pending resources.</td></tr>";
      return;
    }

    // Resolve author names
    const uploaderIds = Array.from(new Set(res.map(r => r.auth_user_id).filter(Boolean)));
    let profileMap = {};
    if (uploaderIds.length){
      const { data: profs, error: pe } = await supabase
        .from("student_profiles")
        .select("auth_user_id,full_name,username,reg_number")
        .in("auth_user_id", uploaderIds);
      if (pe){
        console.warn("[admin][resources] uploader profile fetch failed:", pe.message);
      }else{
        (profs||[]).forEach(p=>{
          const label = p.full_name || p.username || p.reg_number || (p.auth_user_id||"");
          profileMap[p.auth_user_id] = label;
        });
      }
    }

    tbody.innerHTML = res.map(r=>{
      const title = r.title || "Untitled";
      const dept = r.department || "-";
      const author = profileMap[r.auth_user_id] || (r.auth_user_id || "-");
      const status = r.status || "-";
      return `<tr>
        <td>${escapeHtml(title)}</td>
        <td>${escapeHtml(dept)}</td>
        <td>${escapeHtml(author)}</td>
        <td>${escapeHtml(status)}</td>
        <td>
          <button class="btn success" data-approve="${escapeHtml(r.id)}">Approve</button>
          <button class="btn warn" data-reject="${escapeHtml(r.id)}">Reject</button>
        </td>
      </tr>`;
    }).join("");
  }catch(e){
    console.warn("[admin][resources] render exception:", e);
    try{
      const tbody = byId("pending-resources");
      if (tbody) tbody.innerHTML = "<tr><td colspan='5'>Error loading pending resources.</td></tr>";
    }catch(_){}
  }
}


function initTutorsLecturers() {
  // Ensure NEW departments are loaded from DB and cached (no old depts)
  try{
    loadDepartmentsDb().then(()=>{
      const deps = getDepartmentsCached();
      const deptSelect = byId("tutors-filter-dept");
      if (deptSelect) deptSelect.innerHTML = `<option value="">All Departments</option>` + deps.map((d)=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
    });
  }catch(e){}
  const user = requireSession("student"); if (!user) return;
  renderSidebar(); renderTopbar(`${user.name} • ${user.department}`); applyThemeAndNav("tutors"); attachLogout();

  const state = loadState();

  // Populate filters
  const deptSelect = byId("tutors-filter-dept");
  const roleSelect = byId("tutors-filter-role");
  if (deptSelect) {
    const __tdeps = getDepartmentsCached();
    deptSelect.innerHTML = `<option value="">All Departments</option>` + __tdeps.map((d)=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  }
  if (roleSelect) {
    roleSelect.innerHTML = `<option value="">All</option><option value="tutor">Tutors</option><option value="lecturer">Lecturers</option>`;
  }

  const listNode = byId("tutors-list");
  const detailsNode = byId("tutors-details");

  const normalizeRole = (r) => (r || "").toString().toLowerCase();
  const badge = (role) => {
    const r = normalizeRole(role);
    if (r === "lecturer") return `<span class="badge badge-navy">Lecturer</span>`;
    if (r === "tutor") return `<span class="badge badge-sky">Tutor</span>`;
    return `<span class="badge">Member</span>`;
  };

  const groupRatings = (rows) => {
    const by = new Map();
    for (const row of (rows || [])) {
      const rid = row.resource_id;
      if (!by.has(rid)) by.set(rid, []);
      by.get(rid).push(Number(row.rating) || 0);
    }
    const avg = {};
    for (const [rid, arr] of by.entries()) {
      const valid = arr.filter((n)=>n>=1 && n<=5);
      const val = valid.length ? (valid.reduce((a,b)=>a+b,0) / valid.length) : 0;
      avg[rid] = { avg: val, count: valid.length };
    }
    return avg;
  };

  const starRow = (resourceId, avgInfo, myRating) => {
    const avg = avgInfo?.avg || 0;
    const count = avgInfo?.count || 0;
    const my = Number(myRating) || 0;

    const stars = [1,2,3,4,5].map((n)=>{
      const filled = my ? (n<=my) : (n<=Math.round(avg));
      return `<button type="button" class="star ${filled?'filled':''}" data-rate="${n}" data-resource="${resourceId}" aria-label="Rate ${n} stars">★</button>`;
    }).join("");

    document.querySelectorAll("[data-save]").forEach((btn) => btn.addEventListener("click", async ()=>{
      try{
        const id = Number(btn.dataset.save);
        if (!id) return;
        await saveResourceDb(id);
        btn.textContent = "✅ Saved";
        await renderSavedResources();
    }catch(e){ alert(e.message || "Could not save"); }
    }));

    renderSavedResources();

    return `
      <div class="rating-row">
        <div class="stars">${stars}</div>
        <div class="rating-meta">
          <span class="muted">Avg</span>
          <strong>${avg ? avg.toFixed(1) : "—"}</strong>
          <span class="muted">(${count})</span>
          ${my ? `<span class="muted">• Your rating: ${my}/5</span>` : `<span class="muted">• Click to rate</span>`}
        </div>
      </div>
    `;
  };

  async function fetchPeople() {
    const supabase = await ensureSupabaseReady();
    const { data, error } = await supabase
      .from("student_profiles")
      .select("full_name, username, reg_number, department, part, role")
      .in("role", ["tutor", "lecturer"]);

    if (error) {
      console.warn("Failed to load tutors/lecturers", error);
      return [];
    }
    return data || [];
  }

  function applyFilters(rows) {
    const q = (byId("tutors-search")?.value || "").trim().toLowerCase();
    const dept = deptSelect?.value || "";
    const role = roleSelect?.value || "";
    return (rows || [])
      .filter((p)=>!dept || p.department === dept)
      .filter((p)=>!role || normalizeRole(p.role) === role)
      .filter((p)=>!q || `${p.full_name||""} ${p.username||""} ${p.reg_number||""}`.toLowerCase().includes(q))
      .sort((a,b)=> (a.full_name||"").localeCompare(b.full_name||""));
  }

  function renderList(rows) {
    if (!listNode) return;
    if (!rows.length) {
      listNode.innerHTML = `<div class="empty">No tutors/lecturers found.</div>`;
      return;
    }
    listNode.innerHTML = rows.map((p)=>`
      <button class="person-item" data-reg="${escapeHtml(p.reg_number||"")}" type="button">
        <div class="person-name">${escapeHtml(p.full_name || p.username || p.reg_number || "Unknown")}</div>
        <div class="person-sub">${badge(p.role)} <span class="muted">•</span> ${escapeHtml(p.department || "—")}</div>
      </button>
    `).join("");
  }

  async function renderDetails(person, allPeople) {
    if (!detailsNode) return;
    if (!person) {
      detailsNode.innerHTML = `<div class="panel"><h2>Select a tutor/lecturer</h2><p class="muted">Pick someone from the list to view details, shared resources, and recent questions.</p></div>`;
      return;
    }

    const s = loadState();
    const authorKey = person.reg_number;

    const sharedResources = (s.resources || [])
      .filter((r)=> r.status === "approved" && r.authorKey === authorKey)
      .slice(0, 8);

    const recentQuestions = (s.qa || [])
      .filter((q)=> q.status !== "hidden" && q.authorKey === authorKey)
      .slice(0, 5);

    // Ratings: fetch all ratings for these resources + my ratings
    let ratingsAvg = {};
    let myRatings = {};
    try {
      const supabase = await ensureSupabaseReady();
      const ids = sharedResources.map((r)=>r.id);
      if (ids.length) {
        const { data: ratingRows } = await supabase.from("resource_ratings").select("resource_id, rating").in("resource_id", ids);
        ratingsAvg = groupRatings(ratingRows || []);

        const { data: me } = await supabase.auth.getUser();
        const uid = me?.user?.id;
        if (uid) {
          const { data: myRows } = await supabase.from("resource_ratings").select("resource_id, rating").eq("rater_user_id", uid).in("resource_id", ids);
          (myRows || []).forEach((row)=> { myRatings[row.resource_id] = row.rating; });
        }
      }
    } catch (e) { /* ignore */ }

    detailsNode.innerHTML = `
      <div class="panel">
        <div class="person-header">
          <div>
            <h2>${escapeHtml(person.full_name || person.username || person.reg_number || "Profile")}</h2>
            <div class="muted">${badge(person.role)} <span class="muted">•</span> ${escapeHtml(person.department || "—")} <span class="muted">•</span> Part ${escapeHtml(person.part || "—")}</div>
          </div>
        </div>

        <div class="grid-2">
          <section class="card">
            <h3>Shared resources</h3>
            ${sharedResources.length ? sharedResources.map((r)=>`
              <div class="resource-mini">
                <div class="resource-title">${escapeHtml(r.title || "Untitled")}</div>
                <div class="muted small">${escapeHtml(r.course || "")} • ${escapeHtml(r.fileName || "")}</div>
                ${starRow(r.id, ratingsAvg[r.id], myRatings[r.id])}
              </div>
            `).join("") : `<div class="empty">No approved resources shared yet.</div>`}
          </section>

          <section class="card">
            <h3>Recently asked questions</h3>
            ${recentQuestions.length ? recentQuestions.map((q)=>`
              <div class="qa-mini">
                <div class="qa-q">${escapeHtml(q.question || "")}</div>
                <div class="muted small">${new Date(q.createdAt).toLocaleString()}</div>
              </div>
            `).join("") : `<div class="empty">No recent questions.</div>`}
          </section>
        </div>
      </div>
    `;

    // rating click handler
    detailsNode.querySelectorAll("button.star").forEach((btn)=>{
      btn.addEventListener("click", async ()=>{
        const resourceId = btn.dataset.resource;
        const rating = Number(btn.dataset.rate);
        if (!resourceId || !(rating>=1 && rating<=5)) return;
        try{
          const supabase = await ensureSupabaseReady();
          const { data: me } = await supabase.auth.getUser();
          const uid = me?.user?.id;
          if (!uid) { alert("Please log in again."); return; }
          await supabase.from("resource_ratings").upsert({ resource_id: resourceId, rater_user_id: uid, rating }, { onConflict: "resource_id,rater_user_id" });
          // re-render details to update averages
          const refreshed = applyFilters(allPeople).find((p)=>p.reg_number===person.reg_number) || person;
          await renderDetails(refreshed, allPeople);
    }catch(e){
          console.warn("Rating failed", e);
          alert("Could not save rating. Check your connection.");
        }
      });
    });
  }

  function wireListClicks(allPeople) {
    listNode?.querySelectorAll(".person-item").forEach((btn)=>{
      btn.addEventListener("click", async ()=>{
        const reg = btn.dataset.reg;
        const person = (allPeople || []).find((p)=>p.reg_number === reg);
        await renderDetails(person, allPeople);
      });
    });
  }

  async function refresh() {
    byId("tutors-feedback") && (byId("tutors-feedback").textContent = "Loading…");
    const allPeople = await fetchPeople();
    const rows = applyFilters(allPeople);
    byId("tutors-feedback") && (byId("tutors-feedback").textContent = `${rows.length} found`);
    renderList(rows);
    wireListClicks(allPeople);
    await renderDetails(null, allPeople);
  }

  byId("tutors-search")?.addEventListener("input", refresh);
  deptSelect?.addEventListener("change", refresh);
  roleSelect?.addEventListener("change", refresh);

  refresh();
}



async function uploadBackgroundToSupabaseStorage(file){
  const supabase = await getSupabase();
  if (!supabase) throw new Error("Database connection not available.");

  const ext = (file.name.split(".").pop() || "png").toLowerCase();
  const safeExt = ext.replace(/[^a-z0-9]/g, "") || "png";
  const path = `panel-backgrounds/${Date.now()}-${crypto.randomUUID()}.${safeExt}`;

  const { error: upErr } = await supabase.storage.from("backgrounds").upload(path, file, {
    upsert: true,
    cacheControl: "3600",
    contentType: file.type || undefined
  });
  if (upErr) throw new Error(upErr.message || "Upload failed");

  // Prefer a public URL when the bucket is public
  try{
    const { data: pub } = supabase.storage.from("backgrounds").getPublicUrl(path);
    const url = pub?.publicUrl;
    if (url) return url;
  }catch(e){}

  // Fallback for private buckets: create a long-lived signed URL
  // Note: requires Storage RLS policy allowing SELECT on this bucket/path.
  const { data: signed, error: sErr } = await supabase.storage.from("backgrounds").createSignedUrl(path, 60 * 60 * 24 * 365);
  if (sErr || !signed?.signedUrl) throw new Error(sErr?.message || "Could not create signed URL from storage.");
  return signed.signedUrl;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  try{ loadDepartmentsDb(); }catch(e){}


// Cookie consent gate (required to use the app)
const consent = localStorage.getItem("cookieConsent");
const banner = document.getElementById("cookie-banner");
if (banner && !consent){
  banner.style.display = "grid";
  document.getElementById("cookie-accept")?.addEventListener("click", ()=>{
    localStorage.setItem("cookieConsent", "accepted");
    banner.style.display = "none";
  });
  document.getElementById("cookie-reject")?.addEventListener("click", ()=>{
    localStorage.setItem("cookieConsent", "rejected");
    window.location.href = "index.html";
  });
}

  try { showLoader("Loading…"); } catch {}
  await hydrateStateFromDatabase();
  const page = document.body.dataset.page;
  try {
    const titles = { index: "EDUPATH+ | Access", dashboard: "EDUPATH+ | Dashboard", profile: "EDUPATH+ | Profile", chatrooms: "EDUPATH+ | Chatrooms", resources: "EDUPATH+ | Resource Hub", qa: "EDUPATH+ | Q&A", tasks: "EDUPATH+ | Tasks", catalog: "EDUPATH+ | Course Catalog", support: "EDUPATH+ | Help & Support", search: "EDUPATH+ | Search", tutors: "EDUPATH+ | Tutors/Lecturers", adminLogin: "EDUPATH+ | Admin Login", adminPanel: "EDUPATH+ | Admin Panel" };
    if (titles[page]) document.title = titles[page];
  } catch {}

  const allowed = await protectPrivatePage(page);
  if (!allowed) return;
  const initMap = { index: initLanding, dashboard: initDashboard, profile: initProfileRoleAware, chatrooms: initChatrooms, resources: initResources, qa: initQA, tasks: initTasks, catalog: initCatalog, support: initSupport, adminLogin: initAdminLogin, adminPanel: initAdminPanel, tutors: initTutorsLecturers, search: initSearch, mycourses: initMyCourses, copilot: initCopilot, "admin-courses": initAdminCourses, "inbox": initInbox };
  initMap[page]?.();
  try{ monitorDevTools(); }catch(e){}
  try { hideLoader(); } catch {}

  // === Legal footer (HIT) ===
  try{
    if(!document.querySelector('.legal-footer')){
      const f = document.createElement('footer');
      f.className = 'legal-footer';
      const year = new Date().getFullYear();
      f.textContent = `© ${year} Harare Institute of Technology. All rights reserved.`;
      document.body.appendChild(f);
    }
  }catch(e){}

});

function applyTheme(theme){
  try{document.documentElement.setAttribute('data-theme', theme==='dark'?'dark':'light');}catch(e){}
}



function initSearch() {
  const state0 = loadState();
  const actor = state0.sessions.student || state0.sessions.admin;
  if (!actor) return (window.location.href = "index.html");

  const isAdminView = Boolean(state0.sessions.admin && !state0.sessions.student);
  renderSidebar(isAdminView ? "admin" : "student");
  renderTopbar(`${actor.name} • ${isAdminView ? "admin" : actor.department}`);
  applyThemeAndNav("search");
  attachLogout();

  const qInput = byId("search-query");
  const resultsNode = byId("search-results");
  const detailsNode = byId("search-details");
  const filterType = byId("search-type");
  const filterDept = byId("search-dept");

  // Populate department filter from local state (fallback safe)
  const depts = (loadState().departments || []);
  if (filterDept) {
    filterDept.innerHTML = `<option value="">All Departments</option>` + depts.map((d)=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  }

  function formatLastSeen(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return "—"; }
  }

  function safeProfileCard(p, actorKey) {
    const key = p.regNumber;
    const isSelf = key && actorKey && key === actorKey;

    // Sensitive info rules:
    // - Only show full details to self (reg number, username, recovery email, etc) -> here we show none anyway.
    const shared = (p.sharedResources || []).slice(0, 3).map((r)=>`<li>${escapeHtml(r.title)} <span class="muted">(${escapeHtml(r.course||"")})</span></li>`).join("");
    const sharedBlock = p.sharedResources?.length
      ? `<div class="small muted">Shared resources: <strong>${p.sharedResources.length}</strong></div><ul class="mini">${shared}</ul>`
      : `<div class="small muted">Shared resources: <strong>0</strong></div>`;

    return `
      <div class="result-card" data-kind="profile" data-key="${escapeHtml(key)}">
        <div class="result-head wa-row">
          ${avatarSlotHtml(key, 40)}
          <div class="wa-col">
            <div class="result-title">${escapeHtml(p.full_name || "Unknown")}</div>
            <div class="small muted">${escapeHtml(p.department || "")} • ${escapeHtml((p.role||"student").toString())}</div>
          </div>
          <div class="result-meta">
            <div class="small muted">Last login</div>
            <div><strong>${escapeHtml(formatLastSeen(p.last_login_at))}</strong></div>
          </div>
        </div>
        ${sharedBlock}
        <div class="actions">
          <button class="btn btn-primary" type="button" data-action="chat" data-key="${escapeHtml(key)}">Start chat</button>
          ${isSelf ? `<a class="btn" href="profile.html">View my profile</a>` : `<button class="btn" type="button" data-action="view" data-key="${escapeHtml(key)}">View</button>`}
        </div>
      </div>
    `;
  }

  function safeRoomCard(room) {
    return `
      <div class="result-card" data-kind="room" data-key="${escapeHtml(room.code)}">
        <div class="result-head">
          <div>
            <div class="result-title">${escapeHtml(room.name || "Chatroom")}</div>
            <div class="small muted">Room code: <strong>${escapeHtml(room.code || "")}</strong></div>
          </div>
          <div class="result-meta">
            <div class="small muted">Members</div>
            <div><strong>${(room.members||[]).length}</strong></div>
          </div>
        </div>
        <div class="actions">
          <a class="btn btn-primary" href="chatrooms.html?room=${encodeURIComponent(room.code||"")}">Open chatroom</a>
        </div>
      </div>
    `;
  }

  async function fetchProfiles() {
    const supabase = await ensureSupabaseReady();
    if (!supabase) return [];
    const { data, error } = await supabase
      .from("student_profiles")
      .select("full_name, reg_number, department, department_id, role, last_login_at, avatar_url");
    if (error) {
      console.warn("Search profiles failed", error);
      return [];
    }
    return (data || []).map((row)=>{ const obj = ({ ...row, regNumber: row.reg_number, department: row.department || row.department_id || "" }); if (row.avatar_url) { try{ __avatarCache.set(String(row.reg_number), row.avatar_url); }catch(e){} } return obj; });
  }

  function buildSharedResourcesIndex(state) {
    const map = new Map(); // authorKey -> resources[]
    for (const r of (state.resources || [])) {
      const k = r.authorKey || "";
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    // newest first
    for (const [k, arr] of map.entries()) {
      arr.sort((a,b)=> (b.uploadedAt||"").localeCompare(a.uploadedAt||""));
      map.set(k, arr);
    }
    return map;
  }

  function ensureDmRoom(state, actorKey, otherKey, actorName, otherName) {
    const a = actorKey, b = otherKey;
    if (!a || !b) return null;
    const sig = [a,b].sort().join("|");
    // Check existing DM rooms
    const existing = (state.chatrooms || []).find((r)=> (r.type==="dm") && (r.dmSig===sig));
    if (existing) return existing;

    const code = generateRoomCode();
    const room = {
      id: crypto.randomUUID(),
      code,
      name: `DM: ${actorName} & ${otherName}`,
      department: "Direct",
      description: "Private direct chat",
      members: [a,b],
      type: "dm",
      dmSig: sig,
      createdAt: new Date().toISOString()
    };
    updateState((s)=>{ s.chatrooms.unshift(room); }, "direct message room created");
    return room;
  }

  async function runSearch() {
    const q = (qInput?.value || "").trim().toLowerCase();
    const type = filterType?.value || "";
    const dept = filterDept?.value || "";
    const state = loadState();
    const actorKey = userKeyFromProfile(actor);
    const sharedIndex = buildSharedResourcesIndex(state);

    // Chatrooms visible to actor
    const isAdmin = isAdminView;
    const rooms = (isAdmin ? state.chatrooms : myRooms(state, actor, false)).map((r)=>({
      ...r,
      code: r.code || r.id
    }));

    // Profiles from DB
    const profiles = await fetchProfiles();
    const enriched = profiles.map((p)=>{
      const key = p.regNumber;
      const shared = sharedIndex.get(key) || [];
      return { ...p, sharedResources: shared };
    });

    const matchProfile = (p) => {
      if (dept && p.department !== dept) return false;
      if (!q) return true;
      const hay = `${p.full_name||""} ${p.department||""} ${p.role||""}`.toLowerCase();
      return hay.includes(q);
    };

    const matchRoom = (r) => {
      if (!q) return true;
      const hay = `${r.name||""} ${r.code||""} ${r.department||""}`.toLowerCase();
      return hay.includes(q);
    };

    const profMatches = enriched.filter(matchProfile);
    const roomMatches = rooms.filter(matchRoom);

    let html = "";
    if (!type || type === "profiles") {
      html += `<div class="section-title">People</div>`;
      html += profMatches.length ? profMatches.map((p)=>safeProfileCard(p, actorKey)).join("") : `<div class="empty">No matching people.</div>`;
    }
    if (!type || type === "chatrooms") {
      html += `<div class="section-title">Chatrooms</div>`;
      html += roomMatches.length ? roomMatches.map(safeRoomCard).join("") : `<div class="empty">No matching chatrooms.</div>`;
    }

    if (resultsNode) resultsNode.innerHTML = html || `<div class="empty">Type to search.</div>`;
    hydrateAvatars(resultsNode);

    // Attach actions
    resultsNode?.querySelectorAll("button[data-action]").forEach((btn)=>{
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-action");
        const key = btn.getAttribute("data-key");
        if (!key) return;
        if (action === "chat") {
          // Find profile by regNumber
          const p = enriched.find((x)=>x.regNumber === key);
          if (!p) return alert("User not found.");
          const room = ensureDmRoom(loadState(), userKeyFromProfile(actor), key, actor.name, p.full_name || "Student");
          if (!room) return alert("Could not create chat.");
          window.location.href = `chatrooms.html?room=${encodeURIComponent(room.code)}`;
        } else if (action === "view") {
          const p = enriched.find((x)=>x.regNumber === key);
          if (!p) return;
          if (detailsNode) {
            detailsNode.innerHTML = `
              <section class="card">
                <h3>${escapeHtml(p.full_name||"")}</h3>
                <div class="small muted">${escapeHtml(p.department||"")} • ${escapeHtml(p.role||"student")}</div>
                <div class="grid-2 mt">
                  <div>
                    <div class="small muted">Last login</div>
                    <div><strong>${escapeHtml(formatLastSeen(p.last_login_at))}</strong></div>
                  </div>
                  <div>
                    <div class="small muted">Shared resources</div>
                    <div><strong>${(p.sharedResources||[]).length}</strong></div>
                  </div>
                </div>
                <div class="mt">
                  <h4>Recent shared resources</h4>
                  ${(p.sharedResources||[]).slice(0,5).map((r)=>`<div class="mini-row"><strong>${escapeHtml(r.title)}</strong><div class="small muted">${escapeHtml(r.course||"")} • ${escapeHtml(r.department||"")}</div></div>`).join("") || `<div class="empty">No shared resources.</div>`}
                </div>
              </section>
            `;
          }
        }
      });
    });
  }

  qInput?.addEventListener("input", () => runSearch());
  filterType?.addEventListener("change", () => runSearch());
  filterDept?.addEventListener("change", () => runSearch());

  // Initial render
  runSearch();
}




function setGraphStatus(msg){
  const n = document.getElementById("graph-status");
  if (n) n.textContent = msg;
}

// ===== Copilot: Today plan history (last 5) =====
function harareISODateClient(d = new Date()){
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Harare",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t) => (parts.find(p => p.type === t)?.value || "");
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function renderLoadedPlanRow(row, userId){
  const planOut = document.getElementById("plan-output");
  if (planOut) planOut.textContent = String(row?.plan_text || "").trim() || "(Empty plan)";

  // Reuse existing renderer so checkbox saving continues to work
  try{
    if (typeof renderWhyAndMicro === "function"){
      renderWhyAndMicro({
        why_this_plan: row?.why_this_plan || [],
        micro_tasks: row?.micro_tasks || [],
        dashboard: null,
      }, userId);
    }
  }catch{}
}

async function loadTodayPlansList(userId){
  const listNode = document.getElementById("today-plans-list");
  if (!listNode) return;
  listNode.innerHTML = `<div class="muted small">Loading…</div>`;

  try{
    const supa = await getSupabase();
    const today = harareISODateClient();

    const { data, error } = await supa
      .from("copilot_plan_history")
      .select("id, plan_id, plan_date, computed_at, computed_at_local, coach_mode, opening_message, plan_text, why_this_plan, micro_tasks")
      .eq("user_id", userId)
      .eq("plan_date", today)
      .order("computed_at", { ascending: false })
      .limit(5);

    if (error) {
      listNode.innerHTML = `<div class="muted small">Could not load today’s plans (${escapeHtml(error.message || "error")}).</div>`;
      return;
    }

    if (!data || data.length === 0){
      listNode.innerHTML = `<div class="muted small">No plans generated today yet.</div>`;
      return;
    }

    listNode.innerHTML = data.map((row, idx) => {
      const mode = String(row?.coach_mode || "plan").toUpperCase();
      const pid = String(row?.plan_id || row?.id || "");
      const short = pid ? pid.slice(-6) : String(idx + 1);
      return `<button class="plan-pill" type="button" data-plan-id="${escapeHtml(pid)}">${idx===0?"⭐ ":""}${escapeHtml(mode)} • #${escapeHtml(short)}</button>`;
    }).join("");

    const btns = Array.from(listNode.querySelectorAll("button[data-plan-id]"));
    btns.forEach(btn => {
      btn.addEventListener("click", () => {
        btns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const pid = btn.getAttribute("data-plan-id") || "";
        const row = data.find(r => String(r.plan_id || r.id) === String(pid));
        if (row) renderLoadedPlanRow(row, userId);
      });
    });

    // Auto-load latest
    try{ renderLoadedPlanRow(data[0], userId); }catch{}
    const first = listNode.querySelector("button[data-plan-id]");
    if (first) first.classList.add("active");
  }catch(e){
    listNode.innerHTML = `<div class="muted small">Could not load today’s plans.</div>`;
  }
}

function buildFallbackMicroTasksFromCourses(courses){
  const list = Array.isArray(courses) ? courses.slice(0,3) : [];
  const tasks = [];
  if (!list.length){
    return [
      "Open your module outline and identify the first topic.",
      "Write 10 key definitions from the first topic.",
      "Summarize the topic in 5 bullet points.",
      "Create 3 practice questions and attempt them.",
      "Post 1 beginner question in Q&A.",
      "Review your notes for 10 minutes and plan tomorrow."
    ];
  }
  list.forEach(c=>{
    const code = c.code || "MODULE";
    tasks.push(`Open the outline for ${code} and list the first 3 subtopics.`);
    tasks.push(`For ${code}, write 10 key terms + 1-line meanings.`);
  });
  while(tasks.length < 6) tasks.push("Do a 10-minute recap and write 5 bullet points of what you learned.");
  return tasks.slice(0,10);
}

function renderWhyAndMicro(payload, userId){
  const whyList = document.getElementById("why-plan-list");
  const microWrap = document.getElementById("micro-task-list");
  if (!whyList || !microWrap) return;

  const whyArr = Array.isArray(payload?.why_this_plan) ? payload.why_this_plan
    : (Array.isArray(payload?.prediction?.reasons) ? payload.prediction.reasons : []);

  whyList.innerHTML = whyArr.length
    ? whyArr.slice(0,10).map(r => `<li>${escapeHtml(String(r))}</li>`).join("")
    : `<li class="muted small">No reasons yet.</li>`;

  let microArr = Array.isArray(payload?.micro_tasks) ? payload.micro_tasks : [];

  (async ()=>{
    const saved = await loadMicroChecksFromDb(userId);

    microWrap.innerHTML = microArr.slice(0,12).map((t, i) => {
      const id = `mt_${i}`;
      const checked = saved[id] ? "checked" : "";
      const doneClass = saved[id] ? "done" : "";
      return `
        <label class="microtask ${doneClass}">
          <input type="checkbox" data-mt="${id}" data-text="${escapeHtml(String(t))}" ${checked} />
          <div class="txt">${escapeHtml(String(t))}</div>
        </label>
      `;
    }).join("");

    microWrap.querySelectorAll("input[type=checkbox][data-mt]").forEach(cb => {
      cb.addEventListener("change", async (e) => {
        const el = e.currentTarget;
        const id = el.getAttribute("data-mt");
        const taskText = el.getAttribute("data-text") || "";
        const checked = !!el.checked;
        const label = el.closest(".microtask");
        if (label) label.classList.toggle("done", checked);

        // optimistic graph update (today bucket)
        try{
          const series = Array.isArray(window.__weeklySeries) ? window.__weeklySeries : null;
          if (series && series.length){
            const last = series[series.length-1];
            const before = Number(last.done||0);
            last.done = Math.max(0, before + (checked ? 1 : -1));
            renderPerformanceGraph(series);
          }
        }catch(_){}

        try{ setGraphStatus(checked ? "Saving ✓" : "Saving…"); }catch{}

        try{
          await upsertMicroCheckToDb(userId, id, taskText, checked);
          try{ setGraphStatus("Saved ✓"); }catch{}
        }catch(err){
          console.error("Microtask save failed:", err);
          try{ setGraphStatus("Save failed ✗ (check RLS)"); }catch{}
          // revert UI + optimistic graph
          el.checked = !checked;
          if (label) label.classList.toggle("done", !checked);
          try{
            const series = Array.isArray(window.__weeklySeries) ? window.__weeklySeries : null;
            if (series && series.length){
              const last = series[series.length-1];
              const before = Number(last.done||0);
              last.done = Math.max(0, before + (!checked ? 1 : -1));
              renderPerformanceGraph(series);
            }
          }catch(_){}
          return;
        }

        // refresh from DB so graph/streak is authoritative
        try{ await refreshWeeklyUI(userId); }catch{}
      });
    });
  })();
}

function getSelectedCoachMode(){
  const el = document.querySelector('input[name="coachMode"]:checked');
  const v = (el && el.value) ? String(el.value) : (localStorage.getItem("edupath_coach_mode") || "calm");
  return ["calm","intense","competitive"].includes(v) ? v : "calm";
}

function initCoachModeUI(){
  const radios = document.querySelectorAll('input[name="coachMode"]');
  if (!radios || !radios.length) return;
  const saved = localStorage.getItem("edupath_coach_mode");
  if (saved && ["calm","intense","competitive"].includes(saved)){
    radios.forEach(r => { if (r.value === saved) r.checked = true; });
  }
  radios.forEach(r => {
    r.addEventListener("change", () => {
      const v = getSelectedCoachMode();
      try{ localStorage.setItem("edupath_coach_mode", v); }catch{}
      const dashCoach = document.getElementById("dash-coach");
      if (dashCoach) dashCoach.textContent = v;
    });
  });
  const dashCoach = document.getElementById("dash-coach");
  if (dashCoach) dashCoach.textContent = getSelectedCoachMode();
}

function renderDashboard(d){
  if (!d) return;
  const streak = document.getElementById("dash-streak");
  const micro = document.getElementById("dash-micro");
  const qa = document.getElementById("dash-qa");
  const res = document.getElementById("dash-res");
  const coach = document.getElementById("dash-coach");
  const note = document.getElementById("dash-note");
  if (streak) streak.textContent = `${Number(d.streak_days || 0)} days`;
  if (micro) micro.textContent = `${Number(d.microtasks_done_7d || 0)}/${Number(d.microtasks_total_7d || 0)}`;
  if (qa) qa.textContent = String(d.qa_posts_7d ?? 0);
  if (res) res.textContent = String(d.resources_7d ?? 0);
  if (coach) coach.textContent = String(d.coach_mode || getSelectedCoachMode());
  if (note) note.textContent = "Updated just now.";
}

async function getCurrentUserId(){
  try{
    const supa = await getSupabase();
    const { data } = await supa.auth.getUser();
    return data?.user?.id || null;
  }catch{
    return null;
  }
}

async function loadMicroChecksFromDb(userId){
  if (!userId) return {};
  try{
    const supa = await getSupabase();
    const today = new Date().toISOString().slice(0,10);
    const { data, error } = await supa
      .from("copilot_microtask_checks")
      .select("task_key, done")
      .eq("user_id", userId)
      .eq("task_date", today);
    if (error) return {};
    const map = {};
    (data || []).forEach(r => { map[String(r.task_key)] = !!r.done; });
    return map;
  }catch{
    return {};
  }
}

async function upsertMicroCheckToDb(userId, taskKey, taskText, done){
  if (!userId) return;
  const supa = await getSupabase();
  const today = new Date().toISOString().slice(0,10);
  const { error } = await supa.from("copilot_microtask_checks").upsert({
    user_id: userId,
    task_date: today,
    task_key: String(taskKey),
    task_text: String(taskText),
    done: !!done,
    updated_at: new Date().toISOString()
  }, { onConflict: "user_id,task_date,task_key" });

  if (error) throw error;
}

function lastNDatesISO(n){
  const out = [];
  for(let i=n-1;i>=0;i--){
    const d = new Date(Date.now() - i*24*60*60*1000);
    out.push(d.toISOString().slice(0,10));
  }
  return out;
}

async function computeWeeklyMicroStats(userId){
  const dates = lastNDatesISO(7);
  const start = dates[0];
  const end = dates[dates.length-1];
  try{
    const supa = await getSupabase();
    const { data, error } = await supa
      .from("copilot_microtask_checks")
      .select("task_date, done")
      .eq("user_id", userId)
      .gte("task_date", start)
      .lte("task_date", end);
    if (error) throw error;

    const doneByDay = {};
    const totalByDay = {};
    let done = 0, total = 0;

    (data || []).forEach(r=>{
      const day = String(r.task_date);
      totalByDay[day] = (totalByDay[day]||0) + 1;
      total += 1;
      if (r.done){
        doneByDay[day] = (doneByDay[day]||0) + 1;
        done += 1;
      }
    });

    // streak counts consecutive days ending today with >=1 done
    let streak = 0;
    for(let i=0;i<30;i++){
      const day = new Date(Date.now() - i*24*60*60*1000).toISOString().slice(0,10);
      if ((doneByDay[day]||0) > 0) streak += 1;
      else break;
    }

    const series = dates.map(d=>({
      date: d,
      done: doneByDay[d]||0,
      total: totalByDay[d]||0
    }));

    return { streak_days: streak, microtasks_done_7d: done, microtasks_total_7d: total, series };
  }catch(e){
    return { streak_days: 0, microtasks_done_7d: 0, microtasks_total_7d: 0, series: lastNDatesISO(7).map(d=>({date:d,done:0,total:0})) };
  }
}

function renderPerformanceGraph(stats){
  // Accept direct series array, or {series}, or {labels,values}
  if (Array.isArray(stats)) stats = { series: stats };
  const canvas = document.getElementById("perf-canvas");
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 900;
  const cssH = canvas.clientHeight || 240;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);

  // Accept {labels,values} or stats.series
  let labels = [];
  let values = [];
  if (Array.isArray(stats?.series)){
    labels = stats.series.map(x => x.date);
    values = stats.series.map(x => Number(x.done)||0);
  } else {
    labels = Array.isArray(stats?.labels) ? stats.labels : [];
    values = Array.isArray(stats?.values) ? stats.values.map(v=>Number(v)||0) : [];
  }

  // Convert date -> weekday label
  const weekday = (iso) => {
    try{
      const d = new Date(String(iso));
      return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];
    }catch{ return ""; }
  };
  const xLabels = labels.length ? labels.map(weekday) : ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const wowText = typeof stats?.wowText === "string" ? stats.wowText : "0%";

  const yMax = Math.max(1, ...values, 3);
  const yTop = Math.ceil(yMax / 2) * 2;

  const padL = 44, padR = 18, padT = 18, padB = 54;
  const W = cssW, H = cssH;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // ===== Background (true black) =====
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0,0,W,H);

  // Title
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("Micro-tasks completed per day (Sun–Sat)", padL, 6);

  // Grid + y-axis labels
  const ticks = 4;
  for (let i=0; i<=ticks; i++){
    const y = padT + (plotH * i / ticks);
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W-padR, y); ctx.stroke();

    const val = Math.round(yTop * (1 - i/ticks));
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(String(val), padL - 10, y);
  }

  // X axis baseline
  ctx.strokeStyle = "rgba(255,255,255,0.24)";
  ctx.beginPath(); ctx.moveTo(padL, padT+plotH); ctx.lineTo(W-padR, padT+plotH); ctx.stroke();

  const n = Math.max(7, values.length || 7);
  const step = plotW / n;
  const barW = Math.min(34, step * 0.58);

  const palette = ["#60a5fa","#34d399","#fbbf24","#fb7185","#a78bfa","#22d3ee","#f97316"];
  const pts = [];

  // Helper: rounded rect
  function rrect(x,y,w,h,r){
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y, x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x, y+h, rr);
    ctx.arcTo(x, y+h, x, y, rr);
    ctx.arcTo(x, y, x+w, y, rr);
    ctx.closePath();
  }

  for (let i=0; i<n; i++){
    const v = values[i] ?? 0;
    const xC = padL + step*(i + 0.5);
    const barH = (v / yTop) * plotH;
    const x0 = xC - barW/2;
    const y0 = padT + plotH - barH;

    const color = palette[i % palette.length];

    // Bar
    ctx.fillStyle = color + "D0";
    rrect(x0, y0, barW, Math.max(2, barH), 10);
    ctx.fill();

    // point list for line
    pts.push({ x: xC, y: y0 });

    // value label
    if (v > 0){
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(String(v), xC, y0 - 4);
    }

    // ===== Day highlight pill under each bar =====
    const label = xLabels[i] || "";
    const pillY = padT + plotH + 12;
    const pillW = 42;
    const pillH = 22;
    const pillX = xC - pillW/2;

    // Slightly highlight the current day label background per bar
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    rrect(pillX, pillY, pillW, pillH, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.86)";
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, xC, pillY + pillH/2);

    // At Saturday (or last bar), show week-over-week change
    const isLast = (i === n-1);
    const isSat = (label === "Sat");
    if (isLast || isSat){
      const tag = wowText.startsWith("-") ? wowText : `+${wowText.replace("+","")}`;
      const up = !wowText.startsWith("-");
      const text = up ? `${tag} this week` : `${tag} this week`;

      const boxW = 110;
      const boxH = 22;
      const bx = Math.min(W - padR - boxW, xC + 12);
      const by = pillY - 2;

      ctx.fillStyle = up ? "rgba(52,211,153,0.18)" : "rgba(251,113,133,0.18)";
      ctx.strokeStyle = up ? "rgba(52,211,153,0.55)" : "rgba(251,113,133,0.55)";
      rrect(bx, by, boxW, boxH, 10);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, bx + boxW/2, by + boxH/2);
    }
  }

  // Line overlay
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, idx) => idx===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
  ctx.stroke();

  // Points
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x,p.y,3.6,0,Math.PI*2); ctx.fill(); });

  // Update status line below graph
  const status = document.getElementById("graph-status");
  if (status) {
    status.textContent = `Week-over-week: ${wowText} (compares last 7 days vs previous 7 days)`;
  }
}


async function refreshWeeklyUI(userId){
  if (!userId) return;
  try{ setGraphStatus("Updating graph…"); }catch{}
  const stats = await computeWeeklyMicroStats(userId);

  // dashboard
  try{
    const dash = {
      streak_days: stats.streak_days,
      microtasks_done_7d: stats.microtasks_done_7d,
      microtasks_total_7d: stats.microtasks_total_7d,
      coach_mode: getSelectedCoachMode()
    };
    renderDashboard(dash);
  }catch(e){}

  // graph
  try{
    window.__weeklySeries = stats.series;
    renderPerformanceGraph(stats.series);
  }catch(e){}

  try{ setGraphStatus("Updated ✓"); }catch{}
}



async function initCopilot(){
  const state0 = loadState();
  const actor = state0.sessions.student || state0.sessions.admin;
  if (!actor) return (window.location.href = "index.html");

  const isAdminView = Boolean(state0.sessions.admin && !state0.sessions.student);
  renderSidebar(isAdminView ? "admin" : "student");
  renderTopbar(`${actor.name} • ${isAdminView ? "admin" : actor.department}`);
  await applyThemeAndNav("copilot");
  initCoachModeUI();
  try{ const uid0 = await getCurrentUserId(); await refreshWeeklyUI(uid0); await loadTodayPlansList(uid0); }catch{}
  attachLogout();

  const feedback = byId("copilot-feedback");
  const planOut = byId("plan-output");
  const activityNode = byId("activity-summary");
  const riskScoreNode = byId("risk-score");
  const riskBandNode = byId("risk-band");
  const reasonsNode = byId("risk-reasons") || byId("why-plan-list");
  let currentRisk = { score: 0, band: "low", reasons: [] };
  const btnGenerate = byId("btn-generate");
  const btnRefresh = byId("btn-refresh");

  // Risk score (DB-driven)
  currentRisk = await fetchRiskScoreFromDb();
  riskScoreNode.textContent = String(currentRisk.score);
  riskBandNode.textContent = String(currentRisk.band || "low").toUpperCase();
  if (!Array.isArray(currentRisk.reasons)) currentRisk.reasons = [];
  if (currentRisk.reasons.length === 0) currentRisk.reasons = ["No activity recorded yet — a starter plan will help you begin."];
  if (reasonsNode) reasonsNode.innerHTML = (currentRisk.reasons || []).map(r=>`<li>${escapeHtml(r)}</li>`).join("") || "<li class='muted small'>No reasons.</li>";

  async function refreshSummary(){
    try{
      const summary = await buildActivitySummary(7);
      activityNode.textContent = summary;
      // refresh risk too (best-effort)
      currentRisk = await fetchRiskScoreFromDb();
      riskScoreNode.textContent = String(currentRisk.score);
      riskBandNode.textContent = String(currentRisk.band || "low").toUpperCase();
      if (!Array.isArray(currentRisk.reasons)) currentRisk.reasons = [];
  if (currentRisk.reasons.length === 0) currentRisk.reasons = ["No activity recorded yet — a starter plan will help you begin."];
  if (reasonsNode) reasonsNode.innerHTML = (currentRisk.reasons || []).map(r=>`<li>${escapeHtml(r)}</li>`).join("") || "<li class='muted small'>No reasons.</li>";
      return summary;
    }catch(e){
      activityNode.textContent = "Could not load activity.";
      return "No activity yet.";
    }
  }

  await refreshSummary();
      try{ const uid = await getCurrentUserId(); await refreshWeeklyUI(uid); await loadTodayPlansList(uid); }catch{}

  btnRefresh?.addEventListener("click", async ()=>{
    const oldText = btnRefresh.textContent || "Refresh";
    btnRefresh.textContent = "Refreshing…";
    btnRefresh.disabled = true;
    try{
      await refreshSummary();
      try{ const uid = await getCurrentUserId(); await loadTodayPlansList(uid); }catch{}
      btnRefresh.textContent = "Refreshed";
    }catch(e){
      btnRefresh.textContent = "Refresh failed";
    }finally{
      setTimeout(()=>{
        if (!btnRefresh) return;
        btnRefresh.textContent = oldText === "Generate plan" ? "Refresh" : oldText;
        btnRefresh.disabled = false;
      }, 900);
    }
  });

  btnGenerate?.addEventListener("click", async ()=>{
    const oldText = btnGenerate.textContent;
    btnGenerate.textContent = "Generating…";
    btnGenerate.disabled = true;
    try{
      feedback.textContent = "Generating…";
      showLoader("Generating your study plan…");

      const summary = await refreshSummary();
      const ctx = await buildCopilotContext();
      const packed = `${ctx.coursesLine}\n${ctx.communityLine}\n${ctx.activityLine}`;
      const result = await callCopilot(packed, currentRisk.score, getSelectedCoachMode());
      const plan = result?.plan || result || "";
      const prediction = result?.prediction;

      planOut.textContent = plan || "No plan generated.";
      try{ renderDashboard(result.dashboard); }catch{}
      try{ const uid = await getCurrentUserId(); renderWhyAndMicro(result, uid); }catch{}
      try{ const uid = await getCurrentUserId(); await loadTodayPlansList(uid); }catch{}

      if (prediction) {
        const predBox = document.getElementById("prediction-box");
        if (predBox) {
          predBox.innerHTML = `
            <div class="card mini-card mt">
              <div class="small muted">Prediction Score</div>
              <div class="stat">${prediction.score}</div>
              <div class="small">${prediction.band}</div>
              <ul class="small mt">
                ${prediction.reasons.map(r=>`<li>${r}</li>`).join("")}
              </ul>
            </div>
          `;
        }
      }

      byId("plan-note").textContent = "Saved to your study_plan (if backend tables exist).";
      await upsertPlanToDb(plan);

      feedback.textContent = "Done.";
      setTimeout(()=>feedback.textContent="", 1200);
    }catch(e){
      feedback.textContent = "Copilot failed.";
      alert((e.message || "Copilot failed") + "\n\nIf this says 'Failed to fetch', check: (1) Edge Function deployed, (2) GROQ_API_KEY secret set, (3) you are logged in, (4) CORS not blocking.");
    }finally{
      hideLoader();
      if (btnGenerate){
        btnGenerate.textContent = "Generated";
        setTimeout(()=>{ btnGenerate.textContent = oldText || "Generate plan"; btnGenerate.disabled = false; }, 900);
      }
    }
  });
}


async function initMyCourses(){
  const state0 = loadState();
  const actor = state0.sessions.student || state0.sessions.admin;
  if (!actor) return (window.location.href = "index.html");

  const isAdminView = Boolean(state0.sessions.admin && !state0.sessions.student);
  renderSidebar(isAdminView ? "admin" : "student");
  renderTopbar(`${actor.name} • ${isAdminView ? "admin" : (actor.department || "student")}`);
  await applyThemeAndNav("mycourses");
  attachLogout();

  const feedback = byId("courses-feedback");
  const list = byId("courses-list");
  const count = byId("courses-count");

  async function refresh(){
    feedback.textContent = "Loading…";
    const courses = (state0.sessions.student && actor?.department && actor?.part)
      ? await getDeptPartCourses(actor.department, actor.part)
      : await getMyCourses();
    count.textContent = courses.length ? `${courses.length} module(s)` : "No modules found for your department/part.";
    list.innerHTML = courses.length ? courses.map(c => `
      <div class="course-pill">
        <div class="meta">
          <div class="code">${escapeHtml(c.code || "")}</div>
          <div class="title">${escapeHtml(c.title || "")}</div>
          <div class="dept">${escapeHtml(c.department || "")}</div>
        </div>
        ${c.source==="enrollment" ? `<button class="btn" data-remove="${escapeHtml(c.code || "")}" type="button">Remove</button>` : `<span class="small muted">Auto</span>`}
      </div>
    `).join("") : `<div class="muted small">Add your modules so Copilot can plan around them.</div>`;
    feedback.textContent = "";
  }

  byId("btn-refresh-courses")?.addEventListener("click", refresh);

  list.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-remove]");
    if (!btn) return;
    const code = btn.getAttribute("data-remove");
    try{
      const supabase = await getSupabase();
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) throw new Error("Not signed in.");
      await supabase.from("course_enrollments").delete().eq("auth_user_id", uid).eq("course_code", code);
      await logActivity("course_removed", code, code, {});
      await refresh();
    }catch(err){
      alert(err.message || "Remove failed");
    }
  });

  byId("btn-add-course")?.addEventListener("click", async () => {
    const code = (byId("course-code")?.value || "").trim().toUpperCase();
    const title = (byId("course-title")?.value || "").trim();
        if (!code || !title){
      alert("Please enter course code and title.");
      return;
    }
    try{
      feedback.textContent = "Saving…";
      const supabase = await getSupabase();
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) throw new Error("Not signed in.");

      // Ensure course exists
      await supabase.from("courses").upsert({ code, title, department: dept, credits: 0 }, { onConflict: "code" });
      // Enroll user
      await supabase.from("course_enrollments").upsert({ auth_user_id: uid, course_code: code }, { onConflict: "auth_user_id,course_code" });

      byId("course-code").value = "";
      byId("course-title").value = "";
      byId("course-dept").value = "";

      await logActivity("course_added", code, code, { title });
      await refresh();
    }catch(err){
      alert(err.message || "Add failed");
    }finally{
      feedback.textContent = "";
    }
  });

  await refresh();
}


async function initAdminCourses(){
  const state = loadState();
  if (!state.sessions.admin) return (window.location.href = "admin-login.html");

  renderSidebar("admin");
  renderTopbar(`${state.sessions.admin.name} • admin`);
  await applyThemeAndNav("admin-courses");
  attachLogout();

  const supabase = await getSupabase();

async function populateAdminCourseDeptSelect(){
  const sel = byId("admin-course-dept");
  if (!sel || sel.tagName !== "SELECT") return;

  try{
    let options = [];

    // Try departments table
    try{
      const res = await supabase.from("departments").select("name").order("name", { ascending: true });
      if (!res.error && res.data) options = res.data.map(d=>d.name);
    }catch(_e){}

    // Fallback: distinct departments from courses table
    if (!options.length){
      try{
        const res2 = await supabase.from("courses").select("department").limit(5000);
        if (!res2.error && res2.data){
          options = Array.from(new Set(res2.data.map(x=>x.department).filter(Boolean))).sort();
        }
      }catch(_e){}
    }

    // Fallback: local state
    if (!options.length){
      try{
        options = (loadState().departments || []).slice().sort();
      }catch(_e){}
    }

    sel.innerHTML =
      '<option value="">Select department</option>' +
      options.map(n=>`<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  }catch(e){
    // last resort: keep blank select
    sel.innerHTML = '<option value="">Select department</option>';
  }
}
  const status = byId("admin-course-status");
  const list = byId("admin-course-list");

  async function load(){
        const part = byId("admin-course-part").value;
    if (!dept) { status.textContent = "Enter a department."; return; }
    status.textContent = "Loading…";
    const { data, error } = await supabase
      .from("courses")
      .select("*")
      .eq("department", dept)
      .eq("part", part)
      .order("code", { ascending: true });

    if (error){ status.textContent = error.message; return; }
    status.textContent = `${data.length} course(s)`;
    list.innerHTML = data.map(c => `
      <div class="list-row">
        <div class="meta">
          <div><strong>${escapeHtml(c.code)}</strong> — ${escapeHtml(c.title)}</div>
          <div class="small muted">${escapeHtml(c.department || "")} • Part ${escapeHtml(c.part || "")} ${c.lecturer ? " • " + escapeHtml(c.lecturer) : ""} ${c.is_manual ? " • manual" : ""}</div>
        </div>
        <div class="actions">
          <button class="btn btn-danger" data-del="${c.code}">Remove</button>
        </div>
      </div>
    `).join("");

    list.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async ()=>{
      const code = btn.dataset.del;
      if (!confirm(`Remove ${code}?`)) return;
      const { error: delErr } = await supabase.from("courses").delete().eq("code", code);
      if (delErr) alert(delErr.message);
      await load();
    }));
  }

  byId("btn-load-courses").addEventListener("click", load);

  byId("admin-add-course").addEventListener("submit", async (e)=>{
    e.preventDefault();
        const part = byId("admin-course-part").value;
    const code = byId("course-code").value.trim().toUpperCase();
    const title = byId("course-title").value.trim();
    const lecturer = byId("course-lecturer").value.trim();
    if (!dept) return alert("Enter department first.");
    status.textContent = "Saving…";
    const { error } = await supabase.from("courses").upsert({
      code, title, department: dept, part, lecturer: lecturer || null, is_manual: false
    });
    if (error) { status.textContent = error.message; return; }
    e.target.reset();
    await load();
  });
  await populateAdminCourseDeptSelect();

}


function scrubAdminUI(){
  try{
    const state = loadState();
    const isAdminSession = !!state?.sessions?.admin;
    if (isAdminSession) return;
    document.querySelectorAll('a[href="admin-panel.html"],a[href="admin-courses.html"]').forEach(a=>a.remove());
  }catch(e){}
}
document.addEventListener("DOMContentLoaded", scrubAdminUI);


async function initInbox(){
  const state0 = loadState();
  const student = state0.sessions.student;
  if (!student) return (window.location.href = "index.html");
  renderSidebar("student");
  renderTopbar(`${student.name} • ${student.department}`);
  applyThemeAndNav("inbox");
  attachLogout();

  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return (window.location.href = "index.html");

// Admin private notices (stored in app_state)
const st = loadState();
const myIds = [student.regNumber, student.username, uid].filter(Boolean);
const notices = (st.admin_private_notices || []).filter(n => myIds.includes(n.to));
const noticesBox = byId("dm-admin-notices");
if (noticesBox){
  noticesBox.innerHTML = notices.length ? notices.map(n=>{
  const st2 = loadState();
  const recipientKey = getRecipientKeyForReads(student) || String(uid||student.regNumber||student.username||"");
  const reads = (st2.admin_notice_reads && st2.admin_notice_reads[recipientKey]) ? st2.admin_notice_reads[recipientKey] : [];
  const unread = !(reads||[]).map(String).includes(String(n.id));
  return `
    <div class="list-row admin-notice ${unread ? "unread" : ""}" data-notice-open="${escapeHtml(n.id)}">
      <div class="meta">
        <div><strong>${escapeHtml(n.from || "Admin")}</strong> <span class="small muted">${formatDate(n.at)}</span></div>
        <div>${escapeHtml(n.message)}</div>
      </div>
      <div class="actions">
        ${unread ? `<span class="pill small pill-danger">NEW</span>` : `<span class="small muted">—</span>`}
      </div>
    </div>
  `;
}).join("") : '<div class="muted small">No admin notices.</div>';
}

  const threadList = byId("dm-thread-list");
  const resultsBox = byId("dm-search-results");
  const chatCard = byId("dm-chat-card");
  const msgBox = byId("dm-messages");
  const titleEl = byId("dm-title");
  let activePeer = null;

  async function loadThreads(){
    if (!(await dbTableExists("dm_messages"))) {
      threadList.innerHTML = '<div class="muted small">DM tables not installed yet. Run the SQL file.</div>';
      return;
    }
    // latest message per peer
    const { data, error } = await supabase
      .from("dm_thread_latest")
      .select("*")
      .eq("me", uid)
      .order("last_at", { ascending: false });

    if (error){
      threadList.innerHTML = `<div class="muted small">${escapeHtml(error.message)}</div>`;
      return;
    }
    if (!data?.length){
      threadList.innerHTML = '<div class="muted small">No conversations yet. Search a student and message them.</div>';
      return;
    }
    threadList.innerHTML = data.map(t=>`
      <div class="list-row" data-peer="${t.peer}">
        <div class="meta">
          <div><strong>${escapeHtml(t.peer_name || "Student")}</strong> <span class="small muted">@${escapeHtml(t.peer_username || "")}</span></div>
          <div class="small muted">${escapeHtml((t.last_text||"").slice(0,120))}</div>
        </div>
        <div class="actions"><button class="btn btn-ghost" type="button" data-open="${t.peer}">Open</button></div>
      </div>
    `).join("");

    threadList.querySelectorAll("[data-open]").forEach(b=>b.addEventListener("click", async ()=>{
      const peer = b.dataset.open;
      await openChat(peer);
    }));
  }

  async function openChat(peerUid){
    activePeer = peerUid;
    chatCard.style.display = "block";
    // Get peer profile minimal
    const { data: p } = await supabase.from("student_profiles").select("name,username").eq("auth_user_id", peerUid).maybeSingle();
    titleEl.textContent = p ? `Chat with ${p.name} (@${p.username})` : "Chat";
    await loadMessages();
    // Mark messages from this peer as read (DB)
    try{ await upsertDmRead(uid, activePeer); }catch(e){}
    try{ await updateInboxBadge(); }catch(e){}
  }

  async function loadMessages(){
    const { data, error } = await supabase
      .from("dm_messages")
      .select("*")
      .or(`and(sender_id.eq.${uid},receiver_id.eq.${activePeer}),and(sender_id.eq.${activePeer},receiver_id.eq.${uid})`)
      .order("created_at", { ascending: true })
      .limit(200);
    if (error){ msgBox.innerHTML = `<div class="muted small">${escapeHtml(error.message)}</div>`; return; }
    msgBox.innerHTML = (data||[]).map(m=>{
      const mine = m.sender_id === uid;
      return `<article class="bubble ${mine ? "mine" : ""}">
        <div class="item-header"><strong>${mine ? "Me" : "Them"}</strong><span class="small">${formatDate(m.created_at)}</span></div>
        <p>${escapeHtml(m.body || "")}</p>
      </article>`;
    }).join("");
    msgBox.scrollTop = msgBox.scrollHeight;
  }

  byId("btn-dm-close")?.addEventListener("click", ()=>{ chatCard.style.display="none"; activePeer=null; });

  byId("dm-send-form")?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const text = byId("dm-text").value.trim();
    if (!text || !activePeer) return;
    const { error } = await supabase.from("dm_messages").insert({ sender_id: uid, receiver_id: activePeer, body: text });
    if (error) return alert(error.message);
    byId("dm-text").value="";
    await loadMessages();
    // Mark messages from this peer as read (DB)
    try{ await upsertDmRead(uid, activePeer); }catch(e){}
    try{ await updateInboxBadge(); }catch(e){}
    await loadThreads();
    try{ await updateInboxBadge(); }catch(e){}
  });

  byId("btn-dm-search")?.addEventListener("click", async ()=>{
    const q = byId("dm-search").value.trim();
    if (!q) return;
    const { data, error } = await supabase
      .from("student_profiles")
      .select("auth_user_id,name,username,department,last_login_at,avatar_url")
      .ilike("name", `%${q}%`)
      .limit(10);
    if (error){ resultsBox.innerHTML = `<div class="muted small">${escapeHtml(error.message)}</div>`; return; }
    resultsBox.innerHTML = (data||[]).map(p=>`
      <div class="list-row">
        <div class="meta">
          <div class="row">
            <div class="avatar">${p.avatar_url ? `<img src="${p.avatar_url}" alt="avatar" />` : "👤"}</div>
            <div>
              <div><strong>${escapeHtml(p.name||"Student")}</strong> <span class="small muted">@${escapeHtml(p.username||"")}</span></div>
              <div class="small muted">${escapeHtml(p.department||"")} • last login: ${p.last_login_at ? formatDate(p.last_login_at) : "—"}</div>
            </div>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-primary" type="button" data-msg="${p.auth_user_id}">Message</button>
        </div>
      </div>
    `).join("");
    resultsBox.querySelectorAll("[data-msg]").forEach(b=>b.addEventListener("click", async ()=>{
      await openChat(b.dataset.msg);
    }));
  });

  await loadThreads();
    try{ await updateInboxBadge(); }catch(e){}
}

function wireFeaturesModal(){
  const btn = document.getElementById("btn-open-features");
  const modal = document.getElementById("features-modal");
  const closeBtn = document.getElementById("btn-close-features");
  const list = document.getElementById("features-list");
  if (!btn || !modal || !list) return;

  const items = [
    { label: "My Profile", href: "profile.html" },
    { label: "Course Catalog (Public)", href: "course-catalog.html" },
    { label: "Help & Support (Public)", href: "help-support.html" },
    { label: "Search", href: "search.html" },
    { label: "Chatrooms", href: "chatrooms.html" },
    { label: "Inbox (Private Messages)", href: "inbox.html" },
    { label: "Resource Hub", href: "resource-hub.html" },
    { label: "Q&A Platform", href: "qa-platform.html" },
    { label: "Task Tracker", href: "task-tracker.html" },
    { label: "Tutors / Lecturers", href: "tutors-lecturers.html" },
    { label: "System Instructions", href: "system-instructions.html" },
  ];
  list.innerHTML = items.map(i=>`
    <div class="list-row">
      <div class="meta"><strong>${escapeHtml(i.label)}</strong><div class="small muted">${escapeHtml(i.href)}</div></div>
      <div class="actions"><a class="btn btn-primary" href="${i.href}">Open</a></div>
    </div>
  `).join("");

  const open = ()=>{ modal.style.display="grid"; };
  const close = ()=>{ modal.style.display="none"; };

  btn.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  modal.addEventListener("click", (e)=>{ if (e.target === modal) close(); });
}
document.addEventListener("DOMContentLoaded", wireFeaturesModal);

function clearAllSessionsHard(){
  try{
    const st = loadState();
    if (st && st.sessions){
      st.sessions.student = null;
      st.sessions.admin = null;
    }
    // wipe common cached keys
    if (st){
      st.currentUserId = null;
      st.currentAdminId = null;
      st.lastUser = null;
      st.lastStudent = null;
      st.lastAdmin = null;
      st.profileCache = null;
      st.userCache = null;
      st.adminCache = null;
      /*saveState_removed*/(st);
    }
  }catch(e){}
  // Also remove direct localStorage keys if any were used
  try{
    ["app_state","edu_state","state","session","sessions","currentUser","currentUserId","currentAdmin","currentAdminId","lastUser","lastAdmin","lastStudent","profileCache"]
      .forEach(k=> localStorage.removeItem(k));
  }catch(e){}
}

function attachLogout(){
  const btn = document.getElementById("btn-logout") || document.getElementById("logout-student") || document.getElementById("logout-admin");
  if (!btn) return;
  btn.addEventListener("click", ()=>{
    clearAuthFlag();
    clearAllSessionsHard();
    window.location.href = "index.html";
  });
}

function renderAdminProfileCard(admin){
  const box = document.getElementById("admin-profile-card");
  const studBox = document.getElementById("student-profile-card");
  if (studBox) studBox.style.display = "none";
  if (!box) return;

  box.style.display = "block";
  box.innerHTML = `
    <div class="card">
      <h2>Admin Profile</h2>
      <p class="muted">You are signed in as an administrator. Student profiles are not shown.</p>
      <div class="kv mt">
        <div><span class="muted">Username</span><div><strong>${escapeHtml(admin.username || "Admin")}</strong></div></div>
        <div><span class="muted">Role</span><div><strong>${escapeHtml(admin.role || "admin")}</strong></div></div>
        <div><span class="muted">Status</span><div><strong>${admin.is_active === false ? "disabled" : "active"}</strong></div></div>
      </div>
      <div class="mt row">
        <a class="btn btn-primary" href="admin-panel.html">Admin Panel</a>
      </div>
    </div>
  `;
}

async function initProfileRoleAware(){
  const state = loadState();
  // prefer admin session
  if (state?.sessions?.admin){
    renderSidebar("admin");
    renderTopbar(`${state.sessions.admin.name || state.sessions.admin.username || "Admin"} • admin`);
    await applyThemeAndNav("profile");
    attachLogout();

    // fetch admin row (optional) to display accurate role
    try{
      const supabase = await getSupabase();
      const username = state.sessions.admin.username || state.sessions.admin.name;
      let adminRow = { username, role: state.sessions.admin.role || "admin", is_active: true };

      // if table exists, read it
      try{
        const { data, error } = await supabase.from("admin_users").select("username,role,is_active").eq("username", username).maybeSingle();
        if (!error && data) adminRow = data;
      }catch(_e){}
      renderAdminProfileCard(adminRow);
    }catch(e){
      renderAdminProfileCard({ username: state.sessions.admin.username || state.sessions.admin.name, role: state.sessions.admin.role || "admin", is_active: true });
    }
    return;
  }

  // student session
  if (state?.sessions?.student){
    // proceed with existing student profile init if present
    if (typeof initProfile === "function") { initProfile(); return; }
  }

  // no session
  window.location.href = "index.html";
}

/* ADMIN_RULES_AND_NOTICES */
function getAdminRules(){
  return [
    "Protect student privacy — never access or share private data unnecessarily.",
    "Do not impersonate users or test accounts without approval.",
    "Approve resources responsibly: reject harmful, spammy, or misleading content.",
    "Never share admin codes or credentials — each admin is accountable.",
    "Use least privilege: only do what your role requires.",
    "Record security threats and respond calmly (block only with evidence).",
    "Do not delete data without backup/export when possible.",
    "Keep course/module data accurate (codes, parts, departments).",
    "Respect academic integrity: no leaking exam answers or cheating material.",
    "Maintain professionalism: all notices and actions represent EDUPATH+."
  ];
}

function ensureAdminNoticeState(){
  const st = loadState();
  const existing = st.admin_notices || [];
  if (existing.length) return existing;

  const seed = [
    { id: "welcome", title: "Welcome to EDUPATH+ Admin", body: "Use this dashboard to manage courses, approvals, and student safety. Faculty can post official notices here.", created_at: new Date().toISOString(), created_by: "system" }
  ];

  if (typeof updateState === "function"){
    updateState((s)=>{ s.admin_notices = seed; }, "Seed admin notices");
    return seed;
  }

  // fallback (shouldn't happen)
  try{
    st.admin_notices = seed;
  }catch(e){}
  return seed;
}


function isFacultyRole(role){
  const r = (role || "").toLowerCase();
  return ["dean","lecturer","faculty","hod","administrator"].includes(r);
}

async function persistNoticesToAppState(notices){
  try{
    if (typeof updateState === "function"){
      updateState((s)=>{ s.admin_notices = notices; }, "Update admin notices");
      return true;
    }
  }catch(e){}
  return false;
}


function renderAdminProfileUI(adminSession){
  const studBox = document.getElementById("student-profile-card");
  if (studBox) studBox.style.display = "none";
  // Profile page renders into #profile-content
  const box = document.getElementById("admin-profile-card") || document.getElementById("profile-content");
  if (!box) return;
  // Ensure visible
  try{ box.style.display = "block"; }catch(e){}

  const name = adminSession?.name || adminSession?.username || "Admin";
  const role = adminSession?.role || "admin";

  const rules = getAdminRules();
  const notices = ensureAdminNoticeState();

  const faculty = isFacultyRole(role);

  // box is visible
  box.innerHTML = `
    <section class="card">
      <h2>ADMIN • ${escapeHtml(name)}</h2>
      <p class="muted">Welcome back. You are signed in as an administrator. Student profiles are not shown here.</p>

      <div class="kv mt">
        <div><span class="muted">Role</span><div><strong>${escapeHtml(role)}</strong></div></div>
        <div><span class="muted">Status</span><div><strong>active</strong></div></div>
      </div>

      <hr class="mt"/>

      <h3 class="mt">Admin Rules (must follow)</h3>
      <ol class="mt small">
        ${rules.map(r=>`<li>${escapeHtml(r)}</li>`).join("")}
      </ol>

      <hr class="mt"/>

      <div class="row-between mt">
        <h3>Official Notices</h3>
        <span class="pill">${faculty ? "Faculty can post" : "Read-only"}</span>
      </div>

      <div class="list mt" id="admin-notices-list">
        ${notices.map(n=>`
          <div class="list-row">
            <div class="meta">
              <strong>${escapeHtml(n.title)}</strong>
              <div class="small muted">${escapeHtml(new Date(n.created_at).toLocaleString())} • ${escapeHtml(n.created_by || "faculty")}</div>
              <div class="mt">${escapeHtml(n.body)}</div>
            </div>
          </div>
        `).join("")}
      </div>

      ${faculty ? `
      <hr class="mt"/>
      <h3 class="mt">Post a Notice</h3>
      <form id="admin-notice-form" class="mt">
        <div class="grid-2">
          <div>
            <label class="small muted">Title</label>
            <input class="input" id="notice-title" required maxlength="80" placeholder="e.g., Maintenance / New feature / Important policy" />
          </div>
          <div>
            <label class="small muted">Created by</label>
            <input class="input" id="notice-by" required maxlength="40" value="${escapeHtml(name)}" />
          </div>
        </div>
        <label class="small muted mt">Message</label>
        <textarea class="input" id="notice-body" required maxlength="600" rows="4" placeholder="Write a clear update for other admins..."></textarea>
        <div class="row mt">
          <button class="btn btn-primary" type="submit">Publish Notice</button>
        </div>
      </form>
      ` : ``}

    </section>
  `;

  if (faculty){
    const form = document.getElementById("admin-notice-form");
    form?.addEventListener("submit", async (e)=>{
      e.preventDefault();
      const title = (document.getElementById("notice-title")?.value || "").trim();
      const by = (document.getElementById("notice-by")?.value || "").trim();
      const body = (document.getElementById("notice-body")?.value || "").trim();
      if (!title || !body) return;

      const st = loadState();
      const arr = (st.admin_notices || ensureAdminNoticeState()).slice();
      arr.unshift({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), title, body, created_at: new Date().toISOString(), created_by: by || name });

      await persistNoticesToAppState(arr);
      renderAdminProfileUI(adminSession);
    });
  }
}

async function initProfileRoleAware(){
  const st = loadState();

  // Admin has priority even if an old student session exists
  if (st?.sessions?.admin){
    renderSidebar("admin");
    renderTopbar(`${st.sessions.admin.name || st.sessions.admin.username || "Admin"} • admin`);
    await applyThemeAndNav("profile");
    attachLogout();
    renderAdminProfileUI(st.sessions.admin);
    return;
  }

  if (st?.sessions?.student){
    if (typeof initProfile === "function") { initProfile(); return; }
  }

  window.location.href = "index.html";
}

function monitorDevTools(){
  let flagged = false;
  const threshold = 160; // px gap heuristic
  const check = ()=>{
    const opened = (window.outerWidth - window.innerWidth > threshold) || (window.outerHeight - window.innerHeight > threshold);
    if (opened && !flagged){
      flagged = true;
      // record as security threat (best-effort)
      updateState((s)=>{
        s.securityEvents = s.securityEvents || [];
        s.securityEvents.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), type: "devtools", detail: "Developer tools opened" });
      }, "SECURITY: DevTools opened");
    }
    if (!opened) flagged = false;
  };
  setInterval(check, 1500);

  // debugger timing trick (best effort)
  let last = performance.now();
  setInterval(()=>{
    const now = performance.now();
    if (now - last > 2500){
      updateState((s)=>{
        s.securityEvents = s.securityEvents || [];
        s.securityEvents.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), type: "debugger", detail: "Debugger pause detected" });
      }, "SECURITY: Debugger pause detected");
    }
    last = now;
  }, 2000);
}

function setAuthFlag(){
  try{ sessionStorage.setItem("edupath_authenticated", "1"); }catch(e){}
}
function clearAuthFlag(){
  try{ sessionStorage.removeItem("edupath_authenticated"); }catch(e){}
}
function hasAuthFlag(){
  try{ return sessionStorage.getItem("edupath_authenticated") === "1"; }catch(e){ return false; }
}



async function fetchPublicHitCatalogFromEdge(){
  // Best-effort: try to read a public programmes table from Supabase.
  // If it doesn't exist or RLS blocks it, return null and the UI will fall back to local/default data.
  const supabase = await getSupabase();
  if (!supabase) return null;

  const candidates = ["hit_public_catalog", "hit_programmes", "public_hit_catalog", "hit_public_programmes"];
  for (const table of candidates){
    try{
      // Don't assume a 'sort_order' column exists (schema varies).
      const { data, error } = await supabase
        .from(table)
        .select("*");
      if (error) continue;
      if (Array.isArray(data) && data.length){
        // Sort if the column exists; otherwise return as-is.
        if (data[0] && Object.prototype.hasOwnProperty.call(data[0], "sort_order")){
          data.sort((a,b)=> (Number(a.sort_order)||0) - (Number(b.sort_order)||0));
        }
        return data;
      }
    }catch(e){}
  }
  return null;
}
function getDefaultHitProgrammes(){
  return [{"code": "HICS", "name": "BTech (Hons) Computer Science", "duration": "4 years (Full-time)", "school": "Information Science & Technology"}, {"code": "HIIT", "name": "BTech (Hons) Information Technology", "duration": "4 years (Full-time)", "school": "Information Science & Technology"}, {"code": "HISA", "name": "BTech (Hons) Information Security & Assurance", "duration": "4 years (Full-time)", "school": "Information Science & Technology"}, {"code": "HISE", "name": "BTech (Hons) Software Engineering", "duration": "4 years (Full-time)", "school": "Information Science & Technology"}, {"code": "HBEC", "name": "BTech (Hons) Electronic Commerce", "duration": "4 years (Full-time)", "school": "Business & Management Sciences"}, {"code": "HBFE", "name": "BTech (Hons) Financial Engineering", "duration": "4 years (Full-time)", "school": "Business & Management Sciences"}, {"code": "HBFA", "name": "BTech (Hons) Forensic Accounting & Auditing", "duration": "4 years (Full-time)", "school": "Business & Management Sciences"}, {"code": "HECP", "name": "BTech (Hons) Chemical & Process Systems Engineering", "duration": "4 years (Full-time)", "school": "Engineering & Technology"}, {"code": "HEEE", "name": "BTech (Hons) Electronic Engineering", "duration": "4 years (Full-time)", "school": "Engineering & Technology"}, {"code": "HEIM", "name": "BTech (Hons) Industrial & Manufacturing Engineering", "duration": "4 years (Full-time)", "school": "Engineering & Technology"}, {"code": "HEPT", "name": "BTech (Hons) Polymer Technology & Engineering", "duration": "4 years (Full-time)", "school": "Engineering & Technology"}, {"code": "HEMT", "name": "BTech (Hons) Materials Technology & Engineering", "duration": "4 years (Full-time)", "school": "Engineering & Technology"}, {"code": "HEBE", "name": "BTech (Hons) Biomedical Engineering", "duration": "5 years (Full-time)", "school": "Engineering & Technology"}, {"code": "HSBT", "name": "BTech (Hons) Biotechnology", "duration": "4 years (Full-time)", "school": "Industrial Sciences & Technology"}, {"code": "HSFP", "name": "BTech (Hons) Food Processing Technology", "duration": "4 years (Full-time)", "school": "Industrial Sciences & Technology"}, {"code": "HADR", "name": "BSc (Hons) Diagnostic Radiography", "duration": "4 years (Full-time)", "school": "Allied Health Sciences"}, {"code": "HATR", "name": "BSc (Hons) Therapeutic Radiography", "duration": "4 years (Full-time)", "school": "Allied Health Sciences"}, {"code": "HSPT", "name": "Bachelor of Pharmacy (Hons)", "duration": "4 years (Full-time)", "school": "Allied Health Sciences"}];
}

function getPublicHitProgrammes(){
  // legacy fallback (local state)
  const st = loadState();
  const list = st.public_hit_programmes;
  if (Array.isArray(list) && list.length) return list;
  st.public_hit_programmes = getDefaultHitProgrammes();
  saveState(st);
  return st.public_hit_programmes;
}

function renderPublicHitCatalog(){
  const el = document.getElementById("public-hit-catalog");
  if (!el) return;

  el.innerHTML = `<div class="muted">Loading programmes...</div>`;

  (async () => {
    const edgeList = await fetchPublicHitCatalogFromEdge();
    const programmes = (edgeList && edgeList.length) ? edgeList : getPublicHitProgrammes();

    // Cache locally so the page can still show something if offline later
    try{
      const st = loadState();
      st.public_hit_programmes = programmes;
      saveState(st);
    }catch(e){}

    if (!programmes || !programmes.length){
      el.innerHTML = `<div class="muted">No programmes available yet.</div>`;
      return;
    }

    // Support many shapes (table schemas vary)
    const pick = (obj, keys) => {
      for (const k of keys){
        const v = obj?.[k];
        if (v !== undefined && v !== null && String(v).trim() !== "") return v;
      }
      return "";
    };

    const rows = programmes.map(p => {
      const code = String(pick(p, ["code","programme_code","program_code","prog_code","id","short_code"])).trim();
      const programme = String(pick(p, ["programme","program","programme_name","program_name","name","title"])).trim();
      const duration = String(pick(p, ["duration","years","length","period","study_duration"])).trim();
      const level = String(pick(p, ["level","study_level","category","school","type","award_level"])).trim();
      const sort_order = Number.isFinite(p.sort_order) ? p.sort_order : (Number(p.sort_order)||0);
      return { code, programme, duration, level, sort_order };
    }).filter(r => r.code && r.programme);

    rows.sort((a,b)=> (a.sort_order||0)-(b.sort_order||0) || a.code.localeCompare(b.code));

    el.innerHTML = `
      <div style="overflow:auto;">
        <table class="simple-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Programme</th>
              <th>Duration</th>
              <th>Level</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${escapeHtml(r.code)}</td>
                <td>${escapeHtml(r.programme)}</td>
                <td>${escapeHtml(r.duration)}</td>
                <td>${escapeHtml(r.level)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  })();
}

function initPublicHitCatalogAdmin(){
  const section = document.getElementById("public-hit-catalog-admin");
  const body = document.getElementById("hit-cat-body");
  const addBtn = document.getElementById("hit-cat-add");
  const delBtn = document.getElementById("hit-cat-delete");
  const saveBtn = document.getElementById("hit-cat-save");
  const msg = document.getElementById("hit-cat-msg");
  if (!section || !body || !addBtn || !delBtn || !saveBtn) return;

  const admin = requireSession("admin");
  if (!admin) return;

  const role = String(admin.role || "").toLowerCase();
  const facultyRoles = ["faculty","dean","hod","administrator"];
  const canEdit = facultyRoles.includes(role);

  if (!canEdit){
    // Hide the whole section for non-faculty admins
    section.hidden = true;
    return;
  }

  const normalize = (arr) => (arr || []).map((p,i)=>({
    code: String(p.code || "").trim(),
    programme: String(p.programme || p.name || "").trim(),
    duration: String(p.duration || "").trim(),
    level: String(p.level || p.school || "").trim(),
    sort_order: Number.isFinite(p.sort_order) ? p.sort_order : i,
    is_active: p.is_active !== false
  })).filter(r => r.code || r.programme || r.duration || r.level);

  const render = (rows) => {
    body.innerHTML = rows.map((r, idx) => `
      <tr data-idx="${idx}">
        <td><input type="checkbox" class="hit-cat-pick"></td>
        <td><input class="input hit-cat-code" value="${escapeHtml(r.code)}" placeholder="CODE"></td>
        <td><input class="input hit-cat-programme" value="${escapeHtml(r.programme)}" placeholder="Programme name"></td>
        <td><input class="input hit-cat-duration" value="${escapeHtml(r.duration)}" placeholder="e.g. 4 Years"></td>
        <td><input class="input hit-cat-level" value="${escapeHtml(r.level)}" placeholder="e.g. Undergraduate"></td>
      </tr>
    `).join("");
  };

  const collect = () => {
    const rows = [];
    body.querySelectorAll("tr").forEach((tr, i) => {
      const code = (tr.querySelector(".hit-cat-code")?.value || "").trim();
      const programme = (tr.querySelector(".hit-cat-programme")?.value || "").trim();
      const duration = (tr.querySelector(".hit-cat-duration")?.value || "").trim();
      const level = (tr.querySelector(".hit-cat-level")?.value || "").trim();
      // Keep partially filled rows in UI, but only send valid rows on save
      rows.push({ code, programme, duration, level, sort_order: i, is_active: true });
    });
    return rows;
  };

  const setMsg = (t) => { if (msg) msg.textContent = t || ""; };

  (async () => {
    setMsg("Loading...");
    const edgeList = await fetchPublicHitCatalogFromEdge();
    const st = loadState();
    const cached = Array.isArray(st.public_hit_programmes) ? st.public_hit_programmes : [];
    const list = (edgeList && edgeList.length) ? edgeList : (cached.length ? cached : getDefaultHitProgrammes());
    const rows = normalize(list);
    rows.sort((a,b)=> (a.sort_order||0)-(b.sort_order||0) || a.code.localeCompare(b.code));
    render(rows);
    setMsg("");
  })();

  addBtn.addEventListener("click", () => {
    const rows = collect();
    rows.push({ code:"", programme:"", duration:"", level:"", sort_order: rows.length, is_active:true });
    render(rows);
  });

  delBtn.addEventListener("click", async () => {
    const rows = collect();
    const picks = Array.from(body.querySelectorAll("tr")).filter(tr => tr.querySelector(".hit-cat-pick")?.checked);
    if (!picks.length) return alert("Select at least one row to delete.");
    const codes = picks.map(tr => (tr.querySelector(".hit-cat-code")?.value || "").trim()).filter(Boolean);

    // Remove from UI immediately
    const remaining = rows.filter(r => !codes.includes(r.code));
    render(remaining);

    // Update local cache immediately
    try{
      updateState((s)=>{
        const current = Array.isArray(s.public_hit_programmes) ? s.public_hit_programmes : [];
        s.public_hit_programmes = current.filter(r => !codes.includes(String(r.code||"")));
      }, "deleted public HIT programmes (local)");
    }catch(e){}

    // If a row has no code yet, it was never saved — no DB delete needed
    if (!codes.length) return;

    try{
      setMsg("Deleting...");
      const url = `${SUPABASE_URL}/functions/v1/hit-catalog-admin`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: admin.name,
          code: admin.code || "",
          action: "delete",
          rows: codes.map(c => ({ code: c }))
        })
      });
      const j = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(j.error || `Delete failed (${res.status})`);
      setMsg("Deleted ✅");
      setTimeout(()=>setMsg(""), 1200);
    }catch(e){
      setMsg("");
      alert(String(e.message || e));
    }
  });

  saveBtn.addEventListener("click", async () => {
    try{
      const rows = collect();
      const cleaned = rows
        .map((r,i)=>({
          code: String(r.code||"").trim(),
          programme: String(r.programme||"").trim(),
          duration: String(r.duration||"").trim(),
          level: String(r.level||"").trim(),
          sort_order: i,
          is_active: true
        }))
        .filter(r => r.code && r.programme && r.duration);

      if (!cleaned.length) return alert("Add at least one valid row (code + programme + duration).");

      // Always update local/programmes cache (so the catalog works even if the edge function/table is missing)
      try{
        updateState((s)=>{
          s.public_hit_programmes = cleaned.map(r => ({ ...r, name: r.programme, school: r.level }));
        }, "updated public HIT programmes (local)");
    }catch(e){}

      setMsg("Saving...");
      const url = `${SUPABASE_URL}/functions/v1/hit-catalog-admin`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: admin.name,
          code: admin.code || "",
          action: "upsert",
          rows: cleaned
        })
      });
      const j = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(j.error || `Save failed (${res.status})`);

      // Sync local cache
      const st = loadState();
      st.public_hit_programmes = cleaned.map(r => ({ ...r, name: r.programme, school: r.level }));
      saveState(st);

      setMsg("Saved ✅");
      setTimeout(()=>setMsg(""), 1200);
    }catch(e){
      setMsg("");
      alert(String(e.message || e));
    }
  });
}