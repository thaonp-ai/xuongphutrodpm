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
// KV binding NHANSU (Wrangler tự tạo khi triển khai): current, prev, account, sess:<token>, fail:<ip>, kq:b:<thời điểm> (phiếu kết quả phân tích).

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

function cookieOf(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

async function sessionUser(req, env) {
  const t = cookieOf(req, COOKIE);
  if (!t || !env.NHANSU || !/^[A-Za-z0-9_-]{30,}$/.test(t)) return null;
  const s = await env.NHANSU.get("sess:" + t, "json");
  if (!s || s.exp <= Date.now()) return null;
  const a = await getAccount(env); // đổi tên đăng nhập → phiên của tên cũ hết hiệu lực
  return a && a.user === s.user ? s.user : null;
}

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
    return json({ user: await sessionUser(req, env), ready: !!env.NHANSU });
  }
  if (p === "/api/auth/login" && m === "POST") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    const ip = req.headers.get("cf-connecting-ip") || "x";
    const fails = +(await env.NHANSU.get("fail:" + ip)) || 0;
    if (fails >= 10) return json({ error: "Sai quá nhiều lần. Thử lại sau 15 phút." }, 429);
    const { username, password } = await body();
    const user = String(username || "").trim().toLowerCase();
    if (!(await checkPassword(env, user, String(password || "")))) {
      await env.NHANSU.put("fail:" + ip, String(fails + 1), { expirationTtl: 900 });
      return json({ error: "Sai tên đăng nhập hoặc mật khẩu" }, 401);
    }
    const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await env.NHANSU.put("sess:" + token, JSON.stringify({ user, exp: Date.now() + SESSION_TTL * 1000 }), { expirationTtl: SESSION_TTL });
    return json({ user }, 200, {
      "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`,
    });
  }
  if (p === "/api/auth/logout" && m === "POST") {
    const t = cookieOf(req, COOKIE);
    if (t && env.NHANSU && /^[A-Za-z0-9_-]{30,}$/.test(t)) await env.NHANSU.delete("sess:" + t);
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }
  if (p === "/api/auth/password" && m === "POST") {
    const user = await sessionUser(req, env);
    if (!user) return json(NEED_LOGIN, 401);
    const { current: cur, next, username } = await body();
    if (!(await checkPassword(env, user, String(cur || "")))) return json({ error: "Mật khẩu hiện tại không đúng" }, 400);
    const newUser = String(username || user).trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(newUser)) return json({ error: "Tên đăng nhập 3–32 ký tự: chữ không dấu, số, . _ -" }, 400);
    if (String(next || "").length < 8) return json({ error: "Mật khẩu mới cần ít nhất 8 ký tự" }, 400);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await pbkdf2(String(next), salt, 100000);
    await env.NHANSU.put("account", JSON.stringify({ user: newUser, salt: b64(salt), hash: b64(hash), iter: 100000 }));
    if (newUser === user) return json({ ok: true, user });
    // đổi tên: cấp phiên mới cho tên mới (phiên tên cũ tự hết hiệu lực)
    const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await env.NHANSU.put("sess:" + token, JSON.stringify({ user: newUser, exp: Date.now() + SESSION_TTL * 1000 }), { expirationTtl: SESSION_TTL });
    return json({ ok: true, user: newUser }, 200, {
      "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`,
    });
  }

  // ---------- nhân sự ----------
  if (p === "/api/nhansu" && m === "GET") {
    const d = await current(env, req);
    return json({ ...d, canEdit: !!env.NHANSU });
  }
  if (p === "/api/nhansu" && m === "PUT") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    if (!(await sessionUser(req, env))) return json(NEED_LOGIN, 401);
    const b = await body();
    let rows;
    try { rows = cleanRows(b.rows); } catch (e) { return json({ error: e.message }, 400); }
    const cur = await current(env, req);
    if (b.base && cur.updatedAt && b.base !== cur.updatedAt)
      return json({ error: "Dữ liệu vừa được người khác cập nhật. Trang sẽ tải lại.", conflict: true }, 409);
    const doc = { rows, updatedAt: new Date().toISOString(), note: String(b.note || "").slice(0, 200) };
    if (cur.source === "web") await env.NHANSU.put("prev", JSON.stringify(cur)); // giữ 1 bản trước để cứu
    await env.NHANSU.put("current", JSON.stringify(doc));
    return json({ ok: true, updatedAt: doc.updatedAt });
  }
  if (p === "/api/nhansu/restore" && m === "POST") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    if (!(await sessionUser(req, env))) return json(NEED_LOGIN, 401);
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
    return new Response('{"batches":[' + vals.filter(Boolean).join(",") + '],"paths":' + paths + "}", {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (p === "/api/ketqua" && m === "PUT") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    const user = await sessionUser(req, env);
    if (!user) return json(NEED_LOGIN, 401);
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
    return json({ ok: true, key, n: ids.length, at });
  }
  // Đường dẫn tương đối của từng phiếu trong thư mục "Kết quả phân tích" (để mở file PDF trên OneDrive)
  if (p === "/api/ketqua/paths" && m === "PUT") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    if (!(await sessionUser(req, env))) return json(NEED_LOGIN, 401);
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
  if (p === "/api/ketqua/reset" && m === "POST") {
    if (!env.NHANSU) return json(NEED_KV, 503);
    if (!(await sessionUser(req, env))) return json(NEED_LOGIN, 401);
    let cursor, n = 0;
    do {
      const l = await env.NHANSU.list({ prefix: "kq:b:", cursor });
      for (const k of l.keys) { await env.NHANSU.delete(k.name); n++; }
      cursor = l.list_complete ? null : l.cursor;
    } while (cursor);
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
