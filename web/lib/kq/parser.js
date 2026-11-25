// ===== Bộ đọc phiếu "BÁO CÁO KẾT QUẢ PHÂN TÍCH" (dùng chung cho trình duyệt & kiểm thử) =====
// Input: mảng trang, mỗi trang là mảng {x,y,w,s}. Output: {code,date,kip,type,lan,rows:[...]}
var KQPT = (function () {
  function norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function fold(s) {
    return norm(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd').replace(/μ|µ/g, 'u');
  }
  var HEAD = [
    ['point', /^diem lay/], ['name', /^ten mau/], ['comp', /^thanh phan/], ['method', /^phuong phap/],
    ['unit', /^don vi/], ['spec', /^gia tri/], ['result', /^ket qua/], ['time', /^thoi gian/], ['note', /^ghi chu/]
  ];

  function parsePages(pages, pageLines) {
    var out = { rows: [], code: '', date: '', kip: '', freq: '' };
    pages.forEach(function (items, pi) {
      items = items.filter(function (i) { return norm(i.s); });
      // --- meta ---
      items.forEach(function (i) {
        var s = norm(i.s);
        var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(20\d\d)$/);
        if (m && !out.date) out.date = m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
        if (/^[A-Za-z.]+ ?-\s?\d{1,2}\.\d{1,2}\.\d{2}/.test(s) && !out.code) out.code = s;
      });
      var lbl = function (re) {
        var L = items.find(function (i) { return re.test(fold(i.s)); });
        if (!L) return '';
        var v = items.filter(function (i) { return Math.abs(i.y - L.y) < 4 && i.x > L.x + L.w + 2; })
          .sort(function (a, b) { return a.x - b.x; })[0];
        return v ? norm(v.s) : '';
      };
      if (!out.kip) out.kip = lbl(/^kip/);
      if (!out.freq) out.freq = lbl(/^tan suat/);
      // --- header ---
      var cols = {};
      HEAD.forEach(function (h) {
        var it = items.find(function (i) { return h[1].test(fold(i.s)); });
        if (it) cols[h[0]] = { cx: it.x + it.w / 2, y: it.y };
      });
      if (!cols.comp || !cols.result) return;
      var headY = Math.min.apply(null, Object.keys(cols).map(function (k) { return cols[k].y; })) - 6;
      var foot = items.filter(function (i) { return /^(truong ca|lan ban hanh|kip:?$)/.test(fold(i.s)) && i.y < headY; })
        .map(function (i) { return i.y; });
      var footY = foot.length ? Math.max.apply(null, foot) + 6 : 0;
      var order = Object.keys(cols).sort(function (a, b) { return cols[a].cx - cols[b].cx; });
      function colOf(it) {
        var c = it.x + it.w / 2, best = null, bd = 1e9;
        // nếu chữ trải qua nhiều cột, ưu tiên cột theo điểm bắt đầu
        order.forEach(function (k) { var d = Math.abs(cols[k].cx - c); if (d < bd) { bd = d; best = k; } });
        return best;
      }
      var body = items.filter(function (i) { return i.y < headY && i.y > footY; });
      body.forEach(function (i) { i.col = colOf(i); });
      var by = function (k) { return body.filter(function (i) { return i.col === k; }).sort(function (a, b) { return b.y - a.y; }); };

      var lines = (pageLines && pageLines[pi]) || [];
      function cellBounds(k) {
        if (!cols[k]) return null;
        var cx = cols[k].cx;
        var hs = lines.filter(function (l) { return l.x0 <= cx && l.x1 >= cx && l.y <= headY + 8 && l.y >= footY - 4; })
          .map(function (l) { return l.y; }).sort(function (a, b) { return b - a; });
        var ys = []; hs.forEach(function (y) { if (!ys.length || ys[ys.length - 1] - y > 3) ys.push(y); });
        if (ys.length) ys.push(-1e9); // khối cuối trang (kéo sang trang sau) không có đường kẻ đáy
        return ys.length >= 2 ? ys : null;
      }
      // --- rows: gom dòng chữ trong cột "Thành phần" (ưu tiên theo đường kẻ ô) ---
      var comp = by('comp'), rows = [], bComp = cellBounds('comp');
      if (bComp) {
        for (var s0 = 0; s0 < bComp.length - 1; s0++) {
          var its = comp.filter(function (i) { return i.y + 3 <= bComp[s0] && i.y + 3 > bComp[s0 + 1]; });
          if (its.length) rows.push({ parts: its, yMax: its[0].y, yMin: its[its.length - 1].y });
        }
        var used = new Set(); rows.forEach(function (r) { r.parts.forEach(function (i) { used.add(i); }); });
        comp.filter(function (i) { return !used.has(i); }).forEach(function (i) { rows.push({ parts: [i], yMax: i.y, yMin: i.y }); });
        rows.sort(function (a, b) { return b.yMax - a.yMax; });
      } else {
        comp.forEach(function (i) {
          var last = rows[rows.length - 1];
          if (last && last.yMin - i.y < 12.5) { last.parts.push(i); last.yMin = i.y; }
          else rows.push({ parts: [i], yMax: i.y, yMin: i.y });
        });
      }
      rows.forEach(function (r) {
        r.y = (r.yMax + r.yMin) / 2;
        r.comp = norm(r.parts.map(function (p) { return p.s; }).join(' '));
      });
      function pick(k, y, tol) {
        var c = by(k).filter(function (i) { return Math.abs(i.y - y) < tol; });
        return norm(c.sort(function (a, b) { return b.y - a.y || a.x - b.x; }).map(function (i) { return i.s; }).join(' '));
      }
      rows.forEach(function (r) {
        var tol = Math.max(7, (r.yMax - r.yMin) / 2 + 6);
        r.result = pick('result', r.y, 7);
        r.spec = pick('spec', r.y, tol);
        r.unit = pick('unit', r.y, tol);
        r.note = pick('note', r.y, 7);
      });
      // --- blocks: theo cụm "Thời gian" (canh giữa khối) hoặc "Tên mẫu" ---
      function clusters(list, gap) {
        var cl = [];
        list.forEach(function (i) {
          var l = cl[cl.length - 1];
          if (l && l.yMin - i.y < gap) { l.items.push(i); l.yMin = i.y; } else cl.push({ items: [i], yMax: i.y, yMin: i.y });
        });
        cl.forEach(function (c) { c.y = (c.yMax + c.yMin) / 2; c.text = norm(c.items.map(function (i) { return i.s; }).join(' ')); });
        return cl;
      }
      var times = by('time').filter(function (i) { return /\d{1,2}[:h.]\d{2}/.test(i.s); });
      var names = clusters(by('name'), 13), points = clusters(by('point'), 13);
      var nameItems = by('name'), pointItems = by('point');
      function inRange(list, yTop, yBot) {
        var seen = {}, outT = [];
        list.filter(function (n) { return n.y + 3 <= yTop && n.y + 3 > yBot; }).forEach(function (n) {
          var s = norm(n.s); if (!seen[s]) { seen[s] = 1; outT.push(s); }
        });
        return norm(outT.join(' '));
      }
      var segs = [];
      var bName = cellBounds('name') || cellBounds('point');
      if (bName) {
        var cellOf = function (k, list) {
          var ys = cellBounds(k) || bName;
          return function (y) {
            for (var s = 0; s < ys.length - 1; s++) if (y <= ys[s] && y > ys[s + 1]) return inRange(list, ys[s], ys[s + 1]);
            return '';
          };
        };
        var nameAt = cellOf('name', nameItems), pointAt = cellOf('point', pointItems), timeAt = cellOf('time', times);
        var prevR = out._prev || null;
        rows.forEach(function (r) {
          var y = r.y + 3, name = nameAt(y), point = pointAt(y), time = timeAt(y).replace(/[h.]/, ':');
          if (!name && prevR) { name = prevR.name; point = point || prevR.point; }
          if (!time && prevR && prevR.name === name) time = prevR.time;
          r.name = name; r.point = point; r.time = time;
          prevR = { name: name, point: point, time: time };
        });
        out._prev = prevR;
      } else {
        // (2) dự phòng: suy khối theo cụm "Thời gian"/"Tên mẫu" canh giữa
        var centers = times.map(function (t) { return { y: t.y, yMax: t.y, yMin: t.y }; });
        names.forEach(function (n) {
          if (!centers.some(function (c) { return c.y <= n.yMax + 6 && c.y >= n.yMin - 6; })) centers.push(n);
        });
        centers.sort(function (a, b) { return b.y - a.y; });
        var ri = 0;
        centers.forEach(function (c, ci) {
          if (ri >= rows.length) return;
          var start = ri, y0 = rows[start].yMax, end;
          if (ci === centers.length - 1) end = rows.length - 1;
          else {
            var target = 2 * c.y - y0, bd = 1e9; end = start;
            for (var j = start; j < rows.length; j++) {
              if (j > start && rows[j].yMax < centers[ci + 1].yMin - 1) break;
              var d = Math.abs(rows[j].yMin - target);
              if (d < bd) { bd = d; end = j; }
            }
          }
          segs.push({ yTop: rows[start].yMax + 5, yBot: rows[end].yMin - 5 });
          ri = end + 1;
        });
      var prev = out._prev || null;
      segs.forEach(function (sg) {
        var rs = rows.filter(function (r) { return r.y <= sg.yTop && r.y >= sg.yBot; });
        if (!rs.length) return;
        var name = inRange(nameItems, sg.yTop, sg.yBot), point = inRange(pointItems, sg.yTop, sg.yBot);
        var tm = times.filter(function (t) { return t.y <= sg.yTop && t.y >= sg.yBot; })[0];
        var time = tm ? norm(tm.s).replace(/[h.]/, ':') : '';
        if (!name && prev) { name = prev.name; point = point || prev.point; }
        if (!time && prev && prev.name === name) time = prev.time;
        rs.forEach(function (r) { r.name = name; r.point = point; r.time = time; });
        prev = { name: name, time: time, point: point };
      });
      out._prev = prev;
      }
      rows.forEach(function (r) {
        out.rows.push({ point: r.point || '', name: r.name || '', comp: r.comp, unit: r.unit, spec: r.spec, result: r.result, time: r.time || '', note: r.note });
      });
    });
    delete out._prev;
    return out;
  }

  // ----- chuẩn hoá -----
  var SYN = [
    [/^do(diendan|dandien)(o25o?c)?$|^cond$/, 'Độ dẫn điện'],
    [/^ph(o25o?c)?$/, 'pH'],
    [/^(tongfe(\(theofe\))?|fetong|fe)$/, 'Fe tổng'],
    [/^tong(nito|nitrogen)(\(t-n\))?$/, 'Tổng Nitơ'],
    [/^(amoni(\(tinhtheon\))?|n-nh4)$/, 'Amoni (theo N)'],
    [/^(ure|urea)$/, 'Urea'],
    [/^(o-po43-|o-phosphate)$/, 'o-PO4³⁻'],
    [/^tongdocung$/, 'Tổng độ cứng'],
    [/^dokiemtong$/, 'Độ kiềm tổng'],
    [/^nh3$/, 'NH3'],
    [/^sio2$/, 'SiO2'],
  ];
  function compKey(c) {
    var f = fold(c).replace(/\s+/g, '');
    for (var i = 0; i < SYN.length; i++) if (SYN[i][0].test(f)) return SYN[i][1];
    return norm(c);
  }
  function sampleKey(point, name) { return (fold(name) || fold(point)).replace(/[\s\-]+/g, ''); }
  function num(s) { var m = String(s).replace(',', '.').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; }
  function parseResult(r) {
    var s = norm(r); if (!s) return null;
    var f = fold(s);
    if (/^(kph|nil|khong phat hien)$/.test(f)) return { v: 0, flag: 'KPH', raw: s };
    var n = num(s); if (n === null) return { v: null, flag: 'text', raw: s };
    if (/^[<≤]/.test(s)) return { v: n, flag: '<', raw: s };
    if (/^[>≥]/.test(s)) return { v: n, flag: '>', raw: s };
    return { v: n, flag: '', raw: s };
  }
  function parseSpec(s) {
    s = norm(s); if (!s) return null;
    var m = s.replace(/,/g, '.').match(/(-?\d+(?:\.\d+)?)\s*[÷\-–~]\s*(-?\d+(?:\.\d+)?)/);
    if (m) return { min: +m[1], max: +m[2], raw: s };
    var n = num(s); if (n === null || /~/.test(s)) return null;
    if (/^[≥>]/.test(s)) return { min: n, max: null, raw: s };
    return { min: null, max: n, raw: s };
  }
  function nameFromFile(fn) {
    // Uti-10.11.26-K2-DK-L2.pdf  / X.Uti -01.01.26-K2-YC-L1.pdf
    var o = {}, b = fn.replace(/\.pdf$/i, '');
    var m = b.match(/(\d{1,2})\.(\d{1,2})\.(\d{2})/);
    if (m) o.date = '20' + m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
    m = b.match(/-K(\d)/i); if (m) o.kip = m[1];
    m = b.match(/-(DK|YC)/i); if (m) o.type = m[1].toUpperCase();
    m = b.match(/-L(\d)/i); if (m) o.lan = m[1];
    return o;
  }
  // trích đường kẻ ngang mảnh từ operator list của pdf.js
  function linesFromOps(ol, OPS) {
    var L = [];
    for (var i = 0; i < ol.fnArray.length; i++) {
      if (ol.fnArray[i] !== OPS.constructPath) continue;
      var a = ol.argsArray[i], b = a && a[2];
      if (!b || b.length < 4) continue;
      var w = b[2] - b[0], h = b[3] - b[1];
      if (h < 2.5 && w > 20) L.push({ x0: b[0], x1: b[2], y: (b[1] + b[3]) / 2 });
    }
    return L;
  }

  // ----- định danh phiếu / nhóm lưu trữ (dùng chung trang web & tác vụ đồng bộ) -----
  var REPORT_RE = /\d{1,2}\.\d{1,2}\.\d{2}.*-K\d/i;
  function isReportName(fn) { return /\.pdf$/i.test(fn) && REPORT_RE.test(fn); }
  function docId(fn) {
    var s = String(fn).normalize('NFC').trim().toLowerCase(), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return 'r' + ('0000000' + h.toString(16)).slice(-8);
  }
  function idxOf(fn) { var d = nameFromFile(fn).date || '0000-00-00'; return d.slice(0, 7); }
  function chunkOf(date) { if (!date) return 'unknown'; return date.slice(0, 7) + (+date.slice(8, 10) <= 15 ? '-a' : '-b'); }
  // gói gọn kết quả để lưu: chỉ giữ dòng có kết quả
  function pack(rep, fn, mtime, size, ver) {
    var meta = nameFromFile(fn);
    return {
      file: fn, m: mtime, s: size, v: ver,
      date: rep.date || meta.date || '', kip: (String(rep.kip || '').match(/\d/) || [meta.kip || ''])[0],
      freq: rep.freq || '', type: meta.type || '',
      rows: (rep.rows || []).filter(function (r) { return norm(r.result); })
        .map(function (r) { return [r.point || '', r.name || '', r.comp || '', r.unit || '', r.spec || '', r.result || '', r.time || '', r.note || '']; })
    };
  }

  // gộp khoá mẫu bị cắt (tên mẫu tràn sang trang sau): khoá ngắn là tiền tố của khoá dài cùng điểm lấy mẫu
  function aliasMap(samples) { // samples: [{key, point}]
    var out = {};
    samples.forEach(function (a) {
      var best = null;
      samples.forEach(function (b) {
        if (b.key.length > a.key.length && b.key.indexOf(a.key) === 0 && a.key.length >= 8 &&
            fold(a.point || '').replace(/\s+/g, '') === fold(b.point || '').replace(/\s+/g, '') && (!best || b.key.length < best.key.length)) best = b;
      });
      if (best) out[a.key] = best.key;
    });
    Object.keys(out).forEach(function (k) { var t = out[k]; while (out[t]) t = out[t]; out[k] = t; });
    return out;
  }
  return { aliasMap: aliasMap, isReportName: isReportName, docId: docId, idxOf: idxOf, chunkOf: chunkOf, pack: pack, sampleKey: sampleKey, linesFromOps: linesFromOps, parsePages: parsePages, compKey: compKey, parseResult: parseResult, parseSpec: parseSpec, nameFromFile: nameFromFile, norm: norm, fold: fold };
})();
if (typeof module !== 'undefined') module.exports = KQPT;
