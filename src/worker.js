// Worker cho web Xưởng Phụ Trợ (xuongphutrodpm).
// Mọi đường dẫn khác /api/* do file tĩnh trong web/ phục vụ (env.ASSETS).
//
// Đăng nhập quản trị dùng chung cho cả web (người dùng yêu cầu 17/11/2026):
//   POST /api/auth/login {username,password} → cookie phiên (HttpOnly) 7 ngày
//   GET  /api/auth/me → {user} hoặc {user:null}
//   POST /api/auth/logout
//   POST /api/auth/password {current,next,username?} → đổi mật khẩu / tên đăng nhập (lưu KV "account", thay tài khoản ban đầu)
// Tài khoản ban đầu: env.ADMIN_INIT = "user:saltB64:hashB64:iter" (PBKDF2-SHA256) trong wrangler.jsonc.
//
// /api/nhansu: dữ liệu tab Nhân sự. Xem công khai; sửa cần đăng nhập.
//   Nguồn = bản mới hơn (updatedAt) giữa KV "current" và file web/data/nhansu.json.
// KV binding NHANSU (Wrangler tự tạo khi triển khai): current, prev, account, sess:<token>, fail:<ip>, kq:b:<thời điểm> (phiếu kết quả phân tích),
//   users (tài khoản phụ do quản trị viên tạo), log:<thời điểm đảo> (lịch sử tải lên/chỉnh sửa).
//
// Phân quyền (người dùng yêu cầu 25/11/2026):
//   admin = tài khoản KV "account" (thaonp): làm được mọi việc, quản lý tài khoản, xem toàn bộ lịch sử.
//   kq    = tài khoản phụ trong KV "users": chỉ nạp phiếu tab Kết quả phân tích, xem lịch sử của chính mình.
//   GET/POST /api/users, /api/users/update, /api/users/delete (chỉ admin)
//   GET /api/log, GET /api/log/item?k=… (lịch sử; mỗi sự kiện 1 khóa KV, tóm tắt nằm trong metadata)

const FILE = "/data/nhansu.json";
const TRAIN = ["TC", "DCS", "NH", "GT", "RIVER", "DEMI", "NITO", "RAW", "NH3", "XLNT", "NHR"];
const COOKIE = "xpt_sess";
const SESSION_TTL = 7 * 24 * 3600;

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
}

function sameBytes(a, b) {
  a = new Uint8Array(a); b = new Uint8Array(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a[i] || 0) ^ (b[i] || 0);
  return d === 0;
}

// Một tài khoản quản trị. Ưu tiên KV "account" (đặt trên web, không nằm trong repo);
// chưa có thì dùng KV "auth:<user ban đầu>" (bản cũ) rồi tới ADMIN_INIT trong wrangler.jsonc.
async function getAccount(env) {
  const [u, salt, hash, iter] = String(env.ADMIN_INIT || "").split(":");
  if (env.NHANSU) {
    const a = (await env.NHANSU.get("account", "json")) || (u && (await env.NHANSU.get("auth:" + u, "json")));
    if (a) return a;
  }
  return u ? { user: u, salt, hash, iter: +iter || 100000 } : null;
}

async function checkPassword(env, user, password) {
  const a = await getAccount(env);
  if (!a || a.user !== user || !password) return false;
  const h = await pbkdf2(password, unb64(a.salt), a.iter);
  return sameBytes(h, unb64(a.hash));
}

const ROLES = { kq: "Nạp phiếu Kết quả phân tích" };
async function getUsers(env) { return (env.NHANSU && (await env.NHANSU.get("users", "json"))) || {}; }
async function hashPw(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), hash: b64(await pbkdf2(String(pw), salt, 100000)), iter: 100000 };
}
// Kiểm tra đăng nhập cho cả quản trị viên và tài khoản phụ → {user, role, name} hoặc null
async function verifyLogin(env, user, password) {
  if (!password) return null;
  if (await checkPassword(env, user, password)) return { user, role: "admin", name: "Quản trị viên" };
  const u = (await getUsers(env))[user];
  if (!u || u.disabled) return null;
  const h = await pbkdf2(password, unb64(u.salt), u.iter || 100000);
  return sameBytes(h, unb64(u.hash)) ? { user, role: u.role || "kq", name: u.name || user } : null;
}

// Ghi lịch sử: mỗi sự kiện 1 khóa "log:<thời điểm đảo>" để liệt kê mới nhất trước, không phải đọc-sửa-ghi.
// metadata (≤1KB) chứa tóm tắt; value chứa chi tiết (danh sách file).
async function addLog(env, who, act, info = {}, detail = null) {
  if (!env.NHANSU || !who) return;
  const at = new Date().toISOString();
  const key = "log:" + (1e13 - Date.now()).toString(36).padStart(9, "0") + "-" + Math.random().toString(36).slice(2, 6);
  const meta = { at, user: who.user, name: String(who.name || "").slice(0, 60), role: who.role, act,
    n: info.n || 0, up: String(info.up || "").slice(0, 40), note: String(info.note || "").slice(0, 200) };
  await env.NHANSU.put(key, JSON.stringify({ ...meta, ...(detail || {}) }), { metadata: meta });
}

function cookieOf(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

// Phiên đăng nhập hiện tại → {user, role, name} hoặc null.
// Đổi tên quản trị / khóa / xóa tài khoản phụ → phiên cũ hết hiệu lực ngay.
async function sessionInfo(req, env) {
  const t = cookieOf(req, COOKIE);
  if (!t || !env.NHANSU || !/^[A-Za-z0-9_-]{30,}$/.test(t)) return null;
  const s = await env.NHANSU.get("sess:" + t, "json");
  if (!s || s.exp <= Date.now()) return null;
  if (s.role && s.role !== "admin") {
    const u = (await getUsers(env))[s.user];
    return u && !u.disabled ? { user: s.user, role: u.role || "kq", name: u.name || s.user } : null;
  }
  const a = await getAccount(env);
  return a && a.user === s.user ? { user: s.user, role: "admin", name: "Quản trị viên" } : null;
}
// Chỉ quản trị viên (tab Nhân sự, quản lý tài khoản…) → tên đăng nhập hoặc null
async function sessionUser(req, env) {
  const i = await sessionInfo(req, env);
  return i && i.role === "admin" ? i.user : null;
}
const canKq = (i) => !!i && (i.role === "admin" || i.role === "kq");
const newToken = () => b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Chặn ghi từ trang web khác (CSRF): yêu cầu thay đổi phải đến từ chính web này.
function sameOrigin(req, url) {
  const o = req.headers.get("origin");
  return !o || o === url.origin;
}

async function readFile(env, req) {
  const r = await env.ASSETS.fetch(new Request(new URL(FILE, req.url)));
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

async function current(env, req) {
  const file = await readFile(env, req);
  const kv = env.NHANSU ? await env.NHANSU.get("current", "json") : null;
  if (kv && (!file || String(kv.updatedAt) > String(file.updatedAt || ""))) return { ...kv, source: "web" };
  return { ...(file || { rows: [] }), source: "file" };
}

function cleanRows(rows) {
  if (!Array.isArray(rows) || rows.length > 3000) throw new Error("Dữ liệu không hợp lệ");
  const ids = new Set();
  return rows.map((r) => {
    if (!r || !r.id || !r.name || !r.birth || !r.join) throw new Error("Thiếu Mã NV / Họ tên / Năm sinh / Năm vào");
    const id = String(r.id).trim().slice(0, 20);
    if (ids.has(id)) throw new Error("Trùng Mã NV " + id);
    ids.add(id);
    const s = (v, n = 60) => String(v ?? "").trim().slice(0, n);
    return {
      id, name: s(r.name, 80), birth: +r.birth | 0, gender: r.gender === "Nữ" ? "Nữ" : "Nam",
      retireAge: +r.retireAge || (r.gender === "Nữ" ? 60 : 62), join: +r.join | 0, pos: s(r.pos) || "—",
      grade: s(r.grade, 20), step: s(r.step, 10), coef: +r.coef || 0, raise: +r.raise || +r.join | 0,
      allow: s(r.allow, 60).replace(/[^0-9+]/g, "") || "0",
      trained: Array.isArray(r.trained) ? r.trained.filter((k) => TRAIN.includes(k)) : [],
    };
  });
}

const NEED_KV = { error: "Chưa có kho lưu dữ liệu (KV) trên Cloudflare." };
const NEED_LOGIN = { error: "Cần đăng nhập quản trị", login: true };

async function api(req, env, url) {
  const p = url.pathname.replace(/\/+$/, "");
  const m = req.method;
  if (m !== "GET" && !sameOrigin(req, url)) return json({ error: "Không hợp lệ" }, 403);
  const body = async () => { try { return await req.json(); } catch { return {}; } };

  // ---------- đăng nhập ----------
  if (p === "/api/auth/me" && m === "GET") {
    const i = await sessionInfo(req, env);
    return json({ user: i ? i.user : null, role: i ? i.role : null, name: i ? i.name : null, ready: !!env.NHANSU });
  }
  if (p === "/api/auth/login" && m === "POST") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    const ip = req.headers.get("cf-connecting-ip") || "x";
    const fails = +(await env.NHANSU.get("fail:" + ip)) || 0;
    if (fails >= 10) return json({ error: "Sai quá nhiều lần. Thử lại sau 15 phút." }, 429);
    const { username, password } = await body();
    const user = String(username || "").trim().toLowerCase();
    const who = await verifyLogin(env, user, String(password || ""));
    if (!who) {
      await env.NHANSU.put("fail:" + ip, String(fails + 1), { expirationTtl: 900 });
      return json({ error: "Sai tên đăng nhập hoặc mật khẩu (hoặc tài khoản đã bị khóa)" }, 401);
    }
    const token = newToken();
    await env.NHANSU.put("sess:" + token, JSON.stringify({ user, role: who.role, exp: Date.now() + SESSION_TTL * 1000 }), { expirationTtl: SESSION_TTL });
    if (who.role !== "admin") {
      const us = await getUsers(env);
      if (us[user]) { us[user].lastLogin = new Date().toISOString(); await env.NHANSU.put("users", JSON.stringify(us)); }
    }
    return json(who, 200, {
      "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`,
    });
  }
  if (p === "/api/auth/logout" && m === "POST") {
    const t = cookieOf(req, COOKIE);
    if (t && env.NHANSU && /^[A-Za-z0-9_-]{30,}$/.test(t)) await env.NHANSU.delete("sess:" + t);
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }
  if (p === "/api/auth/password" && m === "POST") {
    const me = await sessionInfo(req, env);
    if (!me) return json(NEED_LOGIN, 401);
    const { current: cur, next, username } = await body();
    if (me.role !== "admin") { // tài khoản phụ: chỉ đổi mật khẩu của chính mình
      if (!(await verifyLogin(env, me.user, String(cur || "")))) return json({ error: "Mật khẩu hiện tại không đúng" }, 400);
      if (String(next || "").length < 8) return json({ error: "Mật khẩu mới cần ít nhất 8 ký tự" }, 400);
      const us = await getUsers(env);
      Object.assign(us[me.user], await hashPw(next));
      await env.NHANSU.put("users", JSON.stringify(us));
      return json({ ok: true, ...me });
    }
    const user = me.user;
    if (!(await checkPassword(env, user, String(cur || "")))) return json({ error: "Mật khẩu hiện tại không đúng" }, 400);
    const newUser = String(username || user).trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(newUser)) return json({ error: "Tên đăng nhập 3–32 ký tự: chữ không dấu, số, . _ -" }, 400);
    if (newUser !== user && (await getUsers(env))[newUser]) return json({ error: "Tên này đang là một tài khoản phụ" }, 400);
    if (String(next || "").length < 8) return json({ error: "Mật khẩu mới cần ít nhất 8 ký tự" }, 400);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await pbkdf2(String(next), salt, 100000);
    await env.NHANSU.put("account", JSON.stringify({ user: newUser, salt: b64(salt), hash: b64(hash), iter: 100000 }));
    if (newUser === user) return json({ ok: true, ...me });
    // đổi tên: cấp phiên mới cho tên mới (phiên tên cũ tự hết hiệu lực)
    const token = newToken();
    await env.NHANSU.put("sess:" + token, JSON.stringify({ user: newUser, role: "admin", exp: Date.now() + SESSION_TTL * 1000 }), { expirationTtl: SESSION_TTL });
    return json({ ok: true, user: newUser, role: "admin", name: "Quản trị viên" }, 200, {
      "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`,
    });
  }

  // ---------- tài khoản phụ (chỉ quản trị viên) ----------
  if (p.startsWith("/api/users")) {
    if (!env.NHANSU) return json(NEED_KV, 503);
    const me = await sessionInfo(req, env);
    if (!me) return json(NEED_LOGIN, 401);
    if (me.role !== "admin") return json({ error: "Chỉ quản trị viên được quản lý tài khoản" }, 403);
    const us = await getUsers(env);
    const pub = () => Object.keys(us).sort().map((k) => ({ username: k, name: us[k].name || "", role: us[k].role || "kq",
      roleName: ROLES[us[k].role || "kq"], disabled: !!us[k].disabled, createdAt: us[k].createdAt || null, lastLogin: us[k].lastLogin || null }));
    if (p === "/api/users" && m === "GET") return json({ users: pub(), roles: ROLES });
    const b = await body();
    const username = String(b.username || "").trim().toLowerCase();
    const name = String(b.name ?? "").trim().slice(0, 60);
    if (p === "/api/users" && m === "POST") {
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) return json({ error: "Tên đăng nhập 3–32 ký tự: chữ không dấu, số, . _ -" }, 400);
      const a = await getAccount(env);
      if (us[username] || (a && a.user === username)) return json({ error: "Tên đăng nhập đã tồn tại" }, 400);
      if (String(b.password || "").length < 8) return json({ error: "Mật khẩu cần ít nhất 8 ký tự" }, 400);
      if (Object.keys(us).length >= 50) return json({ error: "Tối đa 50 tài khoản" }, 400);
      const role = ROLES[b.role] ? b.role : "kq";
      us[username] = { name: name || username, role, ...(await hashPw(b.password)), createdAt: new Date().toISOString(), createdBy: me.user };
      await env.NHANSU.put("users", JSON.stringify(us));
      await addLog(env, me, "user.create", { note: username + (name ? " (" + name + ")" : "") });
      return json({ ok: true, users: pub() });
    }
    // Nhập từ file Excel mẫu (mau-tai-khoan.xlsx): tạo mới / cập nhật / khóa / xóa nhiều tài khoản.
    // Trình duyệt gửi từng nhóm nhỏ (≤5 dòng) vì mỗi mật khẩu cần băm PBKDF2.
    if (p === "/api/users/import" && m === "POST") {
      const rows = Array.isArray(b.rows) ? b.rows.slice(0, 5) : [];
      const a = await getAccount(env);
      const res = [];
      for (const r of rows) {
        const un = String(r.username || "").trim().toLowerCase();
        const nm = String(r.name || "").trim().slice(0, 60);
        const pw = String(r.password || "");
        const out = { username: un, row: r.row };
        if (!/^[a-z0-9._-]{3,32}$/.test(un)) { res.push({ ...out, error: "Tên đăng nhập không hợp lệ (3–32 ký tự, không dấu)" }); continue; }
        if (a && a.user === un) { res.push({ ...out, error: "Trùng tên quản trị viên" }); continue; }
        if (pw && pw.length < 8) { res.push({ ...out, error: "Mật khẩu cần ít nhất 8 ký tự" }); continue; }
        if (r.remove) {
          if (us[un]) { delete us[un]; res.push({ ...out, act: "delete" }); } else res.push({ ...out, act: "skip" });
          continue;
        }
        if (!us[un]) {
          if (!pw) { res.push({ ...out, error: "Tài khoản mới cần mật khẩu" }); continue; }
          if (Object.keys(us).length >= 50) { res.push({ ...out, error: "Tối đa 50 tài khoản" }); continue; }
          us[un] = { name: nm || un, role: "kq", ...(await hashPw(pw)), disabled: r.disabled === true,
            createdAt: new Date().toISOString(), createdBy: me.user };
          res.push({ ...out, act: "create" });
          continue;
        }
        const ch = [];
        if (nm && nm !== us[un].name) { us[un].name = nm; ch.push("tên"); }
        if (pw) { Object.assign(us[un], await hashPw(pw)); ch.push("mật khẩu"); }
        if (typeof r.disabled === "boolean" && r.disabled !== !!us[un].disabled) { us[un].disabled = r.disabled; ch.push(r.disabled ? "khóa" : "mở khóa"); }
        res.push({ ...out, act: ch.length ? "update" : "same", changes: ch });
      }
      await env.NHANSU.put("users", JSON.stringify(us));
      const done = res.filter((x) => ["create", "update", "delete"].includes(x.act));
      if (done.length) await addLog(env, me, "user.import", { n: done.length,
        note: done.map((x) => x.username + " (" + ({ create: "tạo", update: x.changes && x.changes.join("+"), delete: "xóa" })[x.act] + ")").join(", ").slice(0, 200) });
      return json({ ok: true, results: res, users: pub() });
    }
    if (!us[username]) return json({ error: "Không tìm thấy tài khoản" }, 404);
    if (p === "/api/users/update" && m === "POST") {
      const ch = [];
      if (b.name !== undefined && name && name !== us[username].name) { us[username].name = name; ch.push("đổi tên hiển thị"); }
      if (b.password) {
        if (String(b.password).length < 8) return json({ error: "Mật khẩu cần ít nhất 8 ký tự" }, 400);
        Object.assign(us[username], await hashPw(b.password)); ch.push("đặt lại mật khẩu");
      }
      if (b.disabled !== undefined && !!b.disabled !== !!us[username].disabled) { us[username].disabled = !!b.disabled; ch.push(b.disabled ? "khóa" : "mở khóa"); }
      await env.NHANSU.put("users", JSON.stringify(us));
      if (ch.length) await addLog(env, me, "user.update", { note: username + ": " + ch.join(", ") });
      return json({ ok: true, users: pub() });
    }
    if (p === "/api/users/delete" && m === "POST") {
      delete us[username];
      await env.NHANSU.put("users", JSON.stringify(us));
      await addLog(env, me, "user.delete", { note: username });
      return json({ ok: true, users: pub() });
    }
    return json({ error: "Không tìm thấy" }, 404);
  }

  // ---------- lịch sử ----------
  if (p === "/api/log" && m === "GET") {
    if (!env.NHANSU) return json({ items: [] });
    const me = await sessionInfo(req, env);
    if (!me) return json(NEED_LOGIN, 401);
    const items = [];
    let cursor, pages = 0;
    do {
      const l = await env.NHANSU.list({ prefix: "log:", cursor, limit: 1000 });
      l.keys.forEach((k) => { if (k.metadata && (me.role === "admin" || k.metadata.user === me.user)) items.push({ k: k.name, ...k.metadata }); });
      cursor = l.list_complete ? null : l.cursor;
    } while (cursor && ++pages < 3);
    return json({ items, all: me.role === "admin" });
  }
  if (p === "/api/log/item" && m === "GET") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    const me = await sessionInfo(req, env);
    if (!me) return json(NEED_LOGIN, 401);
    const k = url.searchParams.get("k") || "";
    if (!/^log:[a-z0-9-]{8,30}$/.test(k)) return json({ error: "Không hợp lệ" }, 400);
    const v = await env.NHANSU.get(k, "json");
    if (!v || (me.role !== "admin" && v.user !== me.user)) return json({ error: "Không tìm thấy" }, 404);
    return json(v);
  }

  // ---------- nhân sự ----------
  if (p === "/api/nhansu" && m === "GET") {
    const d = await current(env, req);
    return json({ ...d, canEdit: !!env.NHANSU });
  }
  if (p === "/api/nhansu" && m === "PUT") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    const me = await sessionInfo(req, env);
    if (!me || me.role !== "admin") return json(NEED_LOGIN, 401);
    const b = await body();
    let rows;
    try { rows = cleanRows(b.rows); } catch (e) { return json({ error: e.message }, 400); }
    const cur = await current(env, req);
    if (b.base && cur.updatedAt && b.base !== cur.updatedAt)
      return json({ error: "Dữ liệu vừa được người khác cập nhật. Trang sẽ tải lại.", conflict: true }, 409);
    const doc = { rows, updatedAt: new Date().toISOString(), note: String(b.note || "").slice(0, 200) };
    if (cur.source === "web") await env.NHANSU.put("prev", JSON.stringify(cur)); // giữ 1 bản trước để cứu
    await env.NHANSU.put("current", JSON.stringify(doc));
    await addLog(env, me, "nhansu.save", { n: rows.length, note: doc.note });
    return json({ ok: true, updatedAt: doc.updatedAt });
  }
  if (p === "/api/nhansu/restore" && m === "POST") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    const me = await sessionInfo(req, env);
    if (!me || me.role !== "admin") return json(NEED_LOGIN, 401);
    await addLog(env, me, "nhansu.restore");
    const cur = await env.NHANSU.get("current");
    if (cur) await env.NHANSU.put("prev", cur);
    await env.NHANSU.delete("current");
    return json({ ok: true });
  }
  // ---------- kết quả phân tích ----------
  // Mỗi lần nạp phiếu (trên web) lưu 1 khóa KV "kq:b:<thời điểm>" = {at, by, reports:{id: phiếu đã đọc}}.
  // GET ghép các khóa thành {"batches":[...]} mà không parse (tiết kiệm CPU); trang tự gộp, khóa sau đè khóa trước.
  if (p === "/api/ketqua" && m === "GET") {
    if (!env.NHANSU) return json({ batches: [] });
    const keys = [];
    let cursor;
    do {
      const l = await env.NHANSU.list({ prefix: "kq:b:", cursor });
      l.keys.forEach((k) => keys.push(k.name));
      cursor = l.list_complete ? null : l.cursor;
    } while (cursor);
    keys.sort();
    const vals = await Promise.all(keys.map((k) => env.NHANSU.get(k)));
    const paths = (await env.NHANSU.get("kq:paths")) || "{}";
    const del = (await env.NHANSU.get("kq:del")) || "{}";
    return new Response('{"batches":[' + vals.filter(Boolean).join(",") + '],"paths":' + paths + ',"deleted":' + del + "}", {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (p === "/api/ketqua" && m === "PUT") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    const me = await sessionInfo(req, env);
    if (!canKq(me)) return json(NEED_LOGIN, 401);
    const user = me.user;
    const text = await req.text();
    if (text.length > 1.5e6) return json({ error: "Gói dữ liệu quá lớn" }, 413);
    let b;
    try { b = JSON.parse(text); } catch { return json({ error: "Dữ liệu không hợp lệ" }, 400); }
    const reps = b && b.reports;
    if (!reps || typeof reps !== "object" || Array.isArray(reps)) return json({ error: "Thiếu danh sách phiếu" }, 400);
    const ids = Object.keys(reps);
    if (!ids.length || ids.length > 500 || ids.some((id) => !/^[A-Za-z0-9_-]{1,40}$/.test(id) || !reps[id] || !Array.isArray(reps[id].rows)))
      return json({ error: "Danh sách phiếu không hợp lệ" }, 400);
    const at = new Date().toISOString();
    const key = "kq:b:" + Date.now().toString(36).padStart(10, "0") + "-" + Math.random().toString(36).slice(2, 8);
    await env.NHANSU.put(key, JSON.stringify({ at, by: user, reports: reps }));
    // nạp lại phiếu đã xóa → bỏ dấu xóa
    const del = await env.NHANSU.get("kq:del", "json");
    if (del && ids.some((id) => del[id])) { ids.forEach((id) => delete del[id]); await env.NHANSU.put("kq:del", JSON.stringify(del)); }
    const files = ids.map((id) => String(reps[id].file || id).slice(0, 120));
    await addLog(env, me, "kq.upload", { n: ids.length, up: b.up }, { files, batch: key });
    return json({ ok: true, key, n: ids.length, at });
  }
  // Đường dẫn tương đối của từng phiếu trong thư mục "Kết quả phân tích" (để mở file PDF trên OneDrive)
  if (p === "/api/ketqua/paths" && m === "PUT") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    if (!canKq(await sessionInfo(req, env))) return json(NEED_LOGIN, 401);
    const text = await req.text();
    if (text.length > 1.5e6) return json({ error: "Gói dữ liệu quá lớn" }, 413);
    let b; try { b = JSON.parse(text); } catch { return json({ error: "Dữ liệu không hợp lệ" }, 400); }
    const np = b && b.paths;
    if (!np || typeof np !== "object") return json({ error: "Thiếu đường dẫn" }, 400);
    const cur = (await env.NHANSU.get("kq:paths", "json")) || {};
    let n = 0;
    for (const id of Object.keys(np)) {
      const v = String(np[id] || "");
      if (/^[A-Za-z0-9_-]{1,40}$/.test(id) && v.length < 300 && !v.includes("..") && cur[id] !== v) { cur[id] = v; n++; }
    }
    if (n) await env.NHANSU.put("kq:paths", JSON.stringify(cur));
    return json({ ok: true, changed: n });
  }
  // Xóa từng phiếu (chỉ quản trị viên): ghi dấu xóa vào KV "kq:del" {mã: {at, by, file}} — không phải sửa các gói kq:b:
  // (tiết kiệm CPU); trang bỏ các phiếu có dấu xóa mới hơn lần nạp. Nạp lại phiếu đó → dấu xóa bị gỡ.
  if (p === "/api/ketqua/delete" && m === "POST") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    const me = await sessionInfo(req, env);
    if (!me || me.role !== "admin") return json({ error: "Chỉ quản trị viên được xóa phiếu" }, 403);
    const b = await body();
    const items = b && b.items && typeof b.items === "object" ? b.items : {};
    const ids = Object.keys(items).filter((id) => /^[A-Za-z0-9_-]{1,40}$/.test(id)).slice(0, 3000);
    if (!ids.length) return json({ error: "Chưa chọn phiếu" }, 400);
    const del = (await env.NHANSU.get("kq:del", "json")) || {};
    const at = new Date().toISOString();
    const files = ids.map((id) => String(items[id] || id).slice(0, 120));
    ids.forEach((id, i) => { del[id] = { at, by: me.user, file: files[i] }; });
    await env.NHANSU.put("kq:del", JSON.stringify(del));
    await addLog(env, me, "kq.delete", { n: ids.length, note: String(b.reason || "").slice(0, 200) }, { files });
    return json({ ok: true, n: ids.length, at });
  }
  if (p === "/api/ketqua/reset" && m === "POST") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    const me = await sessionInfo(req, env);
    if (!me || me.role !== "admin") return json(NEED_LOGIN, 401);
    let cursor, n = 0;
    do {
      const l = await env.NHANSU.list({ prefix: "kq:b:", cursor });
      for (const k of l.keys) { await env.NHANSU.delete(k.name); n++; }
      cursor = l.list_complete ? null : l.cursor;
    } while (cursor);
    await env.NHANSU.delete("kq:del");
    await addLog(env, me, "kq.reset", { n });
    return json({ ok: true, deleted: n });
  }
  return json({ error: "Không tìm thấy" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(req, env, url); }
      catch (e) { return json({ error: "Lỗi máy chủ: " + (e && e.message) }, 500); }
    }
    return env.ASSETS.fetch(req);
  },
};
