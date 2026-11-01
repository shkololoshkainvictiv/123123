/* common.js — общая логика для index.html (ТСД) и check.html (проверка).
   Файл problem.xlsx читается в простую модель {лист: [строки]}, правится, и пересобирается целиком.
   Запись идёт через report.php с проверкой версии (оптимистичная блокировка). */
var PM = (function () {
  var REPORT_URL = 'report.php';
  var PROBLEM_DIFF = 'Разный статус у КИТУ и КИГУ';
  var FIXED_SHEETS = ['Отгружен', 'Не наша площадка', 'Другой владелец', PROBLEM_DIFF];
  var TYPE_LABEL = { KITY: 'КИТУ', KI: 'КИ', KIGU: 'КИГУ', UNK: 'Не опознан' };
  var LABEL_TYPE = { 'КИТУ': 'KITY', 'КИ': 'KI', 'КИГУ': 'KIGU', 'Не опознан': 'UNK' };
  var TYPE_ORDER = { KITY: 0, KI: 1, KIGU: 2, UNK: 3 };
  var TYPE_COLOR = { KITY: 'FF1E40AF', KI: 'FF047857', KIGU: 'FF6B21A8', UNK: 'FFB45309' };

  /* ---------- утилиты ---------- */
  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function sanitizeSheetName(name) {
    var clean = String(name).replace(/[\\\/\?\*\[\]:]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) clean = 'Отчёт';
    return clean.substring(0, 31);
  }

  function bufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  /* Убираем служебные/управляющие символы (в т.ч. разделитель GS из GS1-кодов):
     в XML/xlsx они не сохраняются, и код после записи в файл «менялся» бы. */
  function cleanCode(c) {
    return String(c === null || c === undefined ? '' : c)
      .replace(/[\u0000-\u001F\u007F-\u009F\uFFFE\uFFFF]/g, '')
      .trim();
  }

  function cellText(cell) {
    var v = cell.value;
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') {
      if (v.richText) return v.richText.map(function (t) { return t.text; }).join('');
      if (v.result !== undefined && v.result !== null) return String(v.result);
      if (v.text !== undefined) return String(v.text);
      return '';
    }
    return String(v);
  }

  /* ---------- модель ---------- */
  function emptyModel() {
    var m = Object.create(null);
    FIXED_SHEETS.forEach(function (n) { m[n] = []; });
    return m;
  }

  function readModel(wb) {
    var m = emptyModel();
    wb.eachSheet(function (ws) {
      var name = ws.name;
      var isDiff = name === PROBLEM_DIFF;
      if (!m[name]) m[name] = [];
      var rows = m[name];
      ws.eachRow({ includeEmpty: false }, function (row, n) {
        if (n === 1) return; // заголовок
        var type = LABEL_TYPE[cellText(row.getCell(1)).trim()] || 'UNK';
        var pallet = isDiff ? cellText(row.getCell(2)).trim() : '';
        var code = cellText(row.getCell(isDiff ? 3 : 2)).trim();
        var time = cellText(row.getCell(isDiff ? 4 : 3)).trim();
        if (pallet === '—') pallet = '';
        if (!code) return;
        rows.push({ type: type, code: code, pallet: pallet, time: time });
      });
    });
    return m;
  }

  function sheetOrder(model) {
    var rest = Object.keys(model).filter(function (n) { return FIXED_SHEETS.indexOf(n) === -1; });
    rest.sort();
    return FIXED_SHEETS.concat(rest);
  }

  /* Новая версия кода выигрывает: старая строка с тем же кодом удаляется на любом листе. */
  function applyUpserts(model, items) {
    // чистим коды и убираем дубли внутри пачки (побеждает последний)
    var byCode = Object.create(null), order = [];
    items.forEach(function (it) {
      var c = cleanCode(it.code);
      if (!c) return;
      if (!byCode[c]) order.push(c);
      byCode[c] = { problem: it.problem, type: it.type, code: c, pallet: cleanCode(it.pallet), time: it.time };
    });
    Object.keys(model).forEach(function (n) {
      model[n] = model[n].filter(function (r) { return byCode[r.code] === undefined; });
    });
    order.forEach(function (c) {
      var it = byCode[c];
      if (!model[it.problem]) model[it.problem] = [];
      model[it.problem].push({ type: it.type, code: it.code, pallet: it.pallet, time: it.time });
    });
  }

  /* pairs: [{sheet, code}] — удаляем строго конкретные строки, а не листы целиком */
  function removeRows(model, pairs) {
    var set = Object.create(null);
    pairs.forEach(function (p) { set[p.sheet + '\u0000' + p.code] = true; });
    Object.keys(model).forEach(function (n) {
      model[n] = model[n].filter(function (r) { return set[n + '\u0000' + r.code] !== true; });
    });
  }

  /* пустые нестандартные листы удаляются, 4 основных остаются всегда */
  function pruneModel(model) {
    Object.keys(model).forEach(function (n) {
      if (FIXED_SHEETS.indexOf(n) === -1 && model[n].length === 0) delete model[n];
    });
  }

  function assertContains(model, items) {
    var where = Object.create(null);
    Object.keys(model).forEach(function (n) {
      model[n].forEach(function (r) { where[r.code] = n; });
    });
    items.forEach(function (it) {
      var c = cleanCode(it.code);
      if (!c) return;
      if (where[c] !== it.problem) {
        var shown = c.replace(/[^\x20-\u007E\u00A0-\uFFFF]/g, '?');
        throw new Error('Проверка файла не пройдена: код ' + shown + ' (длина ' + c.length + ') не найден на листе «' +
          it.problem + '»' + (where[c] ? ', но найден на листе «' + where[c] + '»' : ' — после записи в xlsx он изменился или пропал'));
      }
    });
  }

  function assertAbsent(model, pairs) {
    pairs.forEach(function (p) {
      var rows = model[p.sheet] || [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].code === p.code) throw new Error('Проверка файла не пройдена: код ' + p.code + ' не удалён');
      }
    });
  }

  /* DIFF: паллеты группами (КИТУ первой строкой). Остальные листы: по типу, затем по порядку. */
  function orderRows(name, rows) {
    var out = [];
    if (name !== PROBLEM_DIFF) {
      var idx = rows.map(function (r, i) { return { r: r, i: i }; });
      idx.sort(function (a, b) {
        var d = (TYPE_ORDER[a.r.type] || 0) - (TYPE_ORDER[b.r.type] || 0);
        return d || a.i - b.i;
      });
      return idx.map(function (x) { return x.r; });
    }
    var groups = Object.create(null), order = [];
    rows.forEach(function (r) {
      var k = r.pallet || '';
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(r);
    });
    var keys = order.filter(function (k) { return k !== ''; });
    if (groups['']) keys.push('');
    keys.forEach(function (k) {
      groups[k].filter(function (r) { return r.type === 'KITY'; }).forEach(function (r) { out.push(r); });
      groups[k].filter(function (r) { return r.type !== 'KITY'; }).forEach(function (r) { out.push(r); });
    });
    return out;
  }

  /* ---------- сборка xlsx ---------- */
  /* opts.withTime (по умолчанию true) — колонка «Время». Пустые листы не создаются. */
  function buildWorkbook(model, opts) {
    opts = opts || {};
    var withTime = opts.withTime !== false;
    var sheetsAdded = 0;
    var wb = new ExcelJS.Workbook();
    wb.creator = 'Okkam';
    wb.created = new Date();

    var border = {
      top: { style: 'thin', color: { argb: 'FF94A3B8' } }, left: { style: 'thin', color: { argb: 'FF94A3B8' } },
      bottom: { style: 'thin', color: { argb: 'FF94A3B8' } }, right: { style: 'thin', color: { argb: 'FF94A3B8' } }
    };
    var headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE85A1E' } };
    var kityFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };

    sheetOrder(model).forEach(function (name) {
      var isDiff = name === PROBLEM_DIFF;
      if (!model[name] || model[name].length === 0) return; // пустые вкладки не создаём
      var ws = wb.addWorksheet(name);
      sheetsAdded++;
      var headers = isDiff ? ['Тип', 'Паллет (КИТУ)', 'Код марки'] : ['Тип', 'Код марки'];
      if (withTime) headers.push('Время');
      var nCols = headers.length;

      var hr = ws.addRow(headers);
      hr.height = 28;
      hr.eachCell(function (c) {
        c.fill = headFill;
        c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        c.border = border;
        c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      });

      var maxCode = 20, maxPallet = 16;
      orderRows(name, model[name] || []).forEach(function (r) {
        var values = isDiff
          ? [TYPE_LABEL[r.type], r.pallet || '—', r.code]
          : [TYPE_LABEL[r.type], r.code];
        if (withTime) values.push(r.time);
        var row = ws.addRow(values);
        row.height = 20;
        row.eachCell({ includeEmpty: true }, function (c, col) {
          c.numFmt = '@';
          c.border = border;
          c.alignment = { vertical: 'middle', horizontal: col === 1 ? 'center' : 'left' };
          c.font = { size: 11, bold: col === 1 || (isDiff && r.type === 'KITY'), color: { argb: TYPE_COLOR[r.type] || 'FF0F172A' } };
          if (isDiff && r.type === 'KITY') c.fill = kityFill;
        });
        if (r.code.length > maxCode) maxCode = r.code.length;
        if (r.pallet && r.pallet.length > maxPallet) maxPallet = r.pallet.length;
      });

      var codeW = Math.min(maxCode + 4, 70);
      var cols = isDiff
        ? [{ width: 14 }, { width: Math.min(maxPallet + 4, 70) }, { width: codeW }]
        : [{ width: 14 }, { width: codeW }];
      if (withTime) cols.push({ width: 22 });
      ws.columns = cols;
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: nCols } };
    });
    if (sheetsAdded === 0) {
      // в xlsx должен быть хотя бы один лист; при чтении он игнорируется (нет строк)
      wb.addWorksheet('Пусто').addRow(['Нет данных']);
    }
    return wb;
  }

  /* ---------- SKU List (первая вкладка) ----------
     Столбец 1: ACTIVE / Delisting; 5: артикул; 23: наименование; 30: КИ; 31: КИГУ.
     В ячейках 30/31 ищем GTIN как часть значения (13 цифр). Если по GTIN найдено несколько строк,
     берём ACTIVE; если строка одна — статус не важен. Тип (КИ/КИГУ) определяется по тому столбцу (30/31),
     в котором GTIN найден в выбранной строке (ACTIVE, а если ACTIVE нет — по всем строкам). */
  var SKU_URL = 'SKU List_ZFG.xlsx';
  var SKU_COL_STATUS = 1, SKU_COL_ARTICLE = 5, SKU_COL_NAME = 23, SKU_COL_KI = 30, SKU_COL_KIGU = 31;

  function extractGtin(code) {
    var m = /^\d{3}(\d{13})/.exec(code);
    return m ? m[1] : null;
  }

  // все 13-значные «окна» цифровых последовательностей ячейки (подстрока), короткие числа дополняем нулями слева
  function gtinKeys(text) {
    var keys = Object.create(null);
    var runs = String(text).match(/\d+/g);
    if (!runs) return [];
    runs.forEach(function (run) {
      if (run.length >= 13) {
        for (var i = 0; i + 13 <= run.length; i++) keys[run.substr(i, 13)] = true;
      } else if (run.length >= 8) {
        keys[('0000000000000' + run).slice(-13)] = true;
      }
    });
    return Object.keys(keys);
  }

  function loadSkuIndex() {
    return fetch(encodeURI(SKU_URL) + '?ts=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      return new ExcelJS.Workbook().xlsx.load(buf);
    }).then(function (wb) {
      var ws = wb.worksheets[0];
      if (!ws) throw new Error('в файле нет листов');
      var map = Object.create(null);
      ws.eachRow({ includeEmpty: false }, function (row) {
        var isActive = cellText(row.getCell(SKU_COL_STATUS)).trim().toUpperCase() === 'ACTIVE';
        var rowInfo = null;
        function add(col, isKi) {
          gtinKeys(cellText(row.getCell(col))).forEach(function (k) {
            var e = map[k] || (map[k] = { info: null, hasActive: false, aKi: false, aKigu: false, nKi: false, nKigu: false });
            if (!rowInfo) {
              rowInfo = {
                article: cellText(row.getCell(SKU_COL_ARTICLE)).trim(),
                name: cellText(row.getCell(SKU_COL_NAME)).trim(),
                active: isActive
              };
            }
            if (isKi) e.nKi = true; else e.nKigu = true;
            if (isActive) {
              e.hasActive = true;
              if (isKi) e.aKi = true; else e.aKigu = true;
            }
            if (!e.info || (!e.info.active && isActive)) e.info = rowInfo; // первая строка; ACTIVE вытесняет не-ACTIVE
          });
        }
        add(SKU_COL_KI, true);
        add(SKU_COL_KIGU, false);
      });
      return map;
    });
  }

  /* -> {gtin, type: 'KI'|'KIGU'|null, info: {article, name, active}|null} */
  function skuLookup(index, code) {
    var g = extractGtin(code);
    if (!g) return { gtin: null, type: null, info: null };
    var e = index ? index[g] : null;
    if (!e) return { gtin: g, type: null, info: null };
    var ki = e.hasActive ? e.aKi : e.nKi;
    var kigu = e.hasActive ? e.aKigu : e.nKigu;
    return { gtin: g, type: ki ? 'KI' : (kigu ? 'KIGU' : null), info: e.info };
  }

  /* для страницы проверки: ищем и в столбце 30, и в 31, независимо от сохранённого типа */
  function skuInfo(index, type, code) {
    if (!index || type === 'KITY') return null;
    return skuLookup(index, code).info;
  }

  /* ---------- сервер ---------- */
  function parseJsonResponse(r) {
    return r.text().then(function (t) {
      var j;
      try { j = JSON.parse(t); } catch (e) { throw new Error('Некорректный ответ сервера (' + r.status + ')'); }
      return { status: r.status, ok: r.ok, json: j };
    });
  }

  function fetchReport() {
    return fetch(REPORT_URL + '?ts=' + Date.now(), { cache: 'no-store' }).then(parseJsonResponse).then(function (res) {
      if (!res.ok || !res.json.success) throw new Error(res.json.error || ('Ошибка сервера ' + res.status));
      return res.json; // {exists, version, data}
    });
  }

  function loadModel(serverInfo) {
    if (!serverInfo.exists) return Promise.resolve(emptyModel());
    var wb = new ExcelJS.Workbook();
    return wb.xlsx.load(base64ToArrayBuffer(serverInfo.data)).then(readModel).catch(function (e) {
      var err = new Error('Файл problem.xlsx на сервере не читается, запись отменена, чтобы его не затереть. ' +
        'Копия предыдущей версии: problem.prev.xlsx. (' + e.message + ')');
      err.corrupt = true;
      throw err;
    });
  }

  function saveReport(buffer, baseVersion) {
    return fetch(REPORT_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: baseVersion, data: bufferToBase64(buffer) })
    }).then(parseJsonResponse).then(function (res) {
      if (res.status === 409 || res.json.conflict) return { conflict: true };
      if (!res.ok || !res.json.success) throw new Error(res.json.error || ('Ошибка сервера ' + res.status));
      return { ok: true, version: res.json.version };
    });
  }

  /* Транзакция: свежий файл → правка → пересборка → проверка → запись с версией.
     Если за это время файл на сервере изменился (409) — всё повторяется на новой версии,
     поэтому чужие строки (с ТСД или проверки) никогда не затираются. */
  function transact(mutator, check, onAttempt) {
    var MAX = 6;
    function attempt(n) {
      if (onAttempt) onAttempt(n);
      return fetchReport().then(function (info) {
        return loadModel(info).then(function (model) {
          mutator(model);
          pruneModel(model);
          return buildWorkbook(model).xlsx.writeBuffer().then(function (buf) {
            // проверяем собранный файл, прежде чем отправлять
            return new ExcelJS.Workbook().xlsx.load(buf).then(function (wb2) {
              if (check) check(readModel(wb2));
              return saveReport(buf, info.version);
            });
          }).then(function (res) {
            if (res.conflict) {
              if (n >= MAX) throw new Error('Файл на сервере постоянно меняется, повторите позже.');
              return attempt(n + 1);
            }
            return { version: res.version, model: model, attempts: n };
          });
        });
      });
    }
    return attempt(1);
  }

  return {
    PROBLEM_DIFF: PROBLEM_DIFF, FIXED_SHEETS: FIXED_SHEETS, TYPE_LABEL: TYPE_LABEL,
    escapeHtml: escapeHtml, cleanCode: cleanCode, sanitizeSheetName: sanitizeSheetName, cellText: cellText,
    emptyModel: emptyModel, buildWorkbook: buildWorkbook, sheetOrder: sheetOrder, orderRows: orderRows,
    applyUpserts: applyUpserts, removeRows: removeRows, assertContains: assertContains, assertAbsent: assertAbsent,
    fetchReport: fetchReport, loadModel: loadModel, transact: transact,
    loadSkuIndex: loadSkuIndex, skuLookup: skuLookup, skuInfo: skuInfo, extractGtin: extractGtin
  };
})();
