// ═══════════════════════════════════════════════════════════════
// D.U.B.I.A. — Google Apps Script Backend  (V2 — Schema Rigido)
// ═══════════════════════════════════════════════════════════════
// Architettura:
//   • Schema rigido: ogni foglio ha colonne fisse (whitelist)
//   • LockService: serializza le scritture simultanee (anti race-condition)
//   • CacheService con chunking 90KB: letture veloci, dataset grandi ok
//   • Idempotenza L1+L2: UUID in CacheService (2ms) → fallback su sheet
//   • Routing esteso: pesata, cibo, prelievo, calibrazione, colonia_sync,
//     colonia_delete, cliente_sync, cliente_delete, cessione_sync, cessione_delete
//   • createNightlyBackup(): backup automatico su Drive (trigger manuale 03:00)
// ═══════════════════════════════════════════════════════════════

var DEBUG = true;

// ──────────────────────────────────────────────────────────────
// NOMI DEI FOGLI — fonte di verità unica
// ──────────────────────────────────────────────────────────────
var SHEET_NAMES = {
  TIMELINE:   'Timeline',
  PESATE:     'Pesate',
  PRELIEVI:   'Prelievi',
  CIBO:       'Cibo',
  CENSIMENTO: 'Censimento',
  COLONIE:    'Colonie',
  CLIENTI:    'Clienti',
  CESSIONI:   'Cessioni'
};

// Whitelist per validazione doGet
var VALID_SHEET_NAMES = (function() {
  var v = {};
  for (var k in SHEET_NAMES) {
    if (SHEET_NAMES.hasOwnProperty(k)) v[SHEET_NAMES[k]] = true;
  }
  return v;
})();

// ──────────────────────────────────────────────────────────────
// SHEET_SCHEMAS — colonne fisse per ogni foglio (IMMUTABILI)
// L'ordine qui definisce l'ordine delle colonne nel foglio.
// ──────────────────────────────────────────────────────────────
var SHEET_SCHEMAS = {
  'Timeline':   ['event_id','date','event_type','total_weight','food_amount','harvest_amount','adult_ratio','predicted_weight','health_index','is_new_blood','notes','colony_id'],
  'Pesate':     ['event_id','date','total_weight','predicted_weight','food_amount','adult_ratio','health_index','is_new_blood','notes','colony_id'],
  'Prelievi':   ['event_id','date','harvest_amount','total_weight','notes','colony_id'],
  'Cibo':       ['event_id','date','food_amount','notes','colony_id'],
  'Censimento': ['event_id','date','total_weight','adult_ratio','notes','colony_id'],
  'Colonie':    ['id','date','name','type','current_weight','males_count','females_count','subadults_count','medium_count','small_count','baby_count','notes'],
  'Clienti':    ['id','nome','cognome','citta','telefono','email','animale','note','data_aggiunta'],
  'Cessioni':   ['id','cliente_id','data','tipo_blatta','quantita_g','prezzo_unit','totale_euro','note']
};

// Event types che NON devono finire nella Timeline
var SKIP_TIMELINE_EVENTS = {
  'colonia_sync':    true,
  'colonia_delete':  true,
  'cliente_sync':    true,
  'cliente_delete':  true,
  'cessione_sync':   true,
  'cessione_delete': true
};

// ══════════════════════════════════════════════════════════════
// CACHE HELPERS — chunking automatico per superare il limite 100KB
// ══════════════════════════════════════════════════════════════
var CACHE_CHUNK_SIZE = 90000; // 90KB per chunk (margine sicurezza)
var CACHE_TTL_DATA   = 60;    // secondi — per i dati dei fogli
var CACHE_TTL_UUID   = 7200;  // 2 ore — per gli UUID idempotenza

function cacheSet(cache, key, data) {
  try {
    var str = JSON.stringify(data);
    if (str.length <= CACHE_CHUNK_SIZE) {
      cache.put(key, str, CACHE_TTL_DATA);
      cache.put(key + '__chunks', '1', CACHE_TTL_DATA);
    } else {
      var chunks = [];
      for (var i = 0; i < str.length; i += CACHE_CHUNK_SIZE) {
        chunks.push(str.slice(i, i + CACHE_CHUNK_SIZE));
      }
      for (var c = 0; c < chunks.length; c++) {
        cache.put(key + '__chunk_' + c, chunks[c], CACHE_TTL_DATA);
      }
      cache.put(key + '__chunks', String(chunks.length), CACHE_TTL_DATA);
    }
  } catch(e) {
    debugLog('cacheSet error (ignorato)', e.message);
  }
}

function cacheGet(cache, key) {
  try {
    var chunkCountStr = cache.get(key + '__chunks');
    if (!chunkCountStr) return null;
    var chunkCount = parseInt(chunkCountStr, 10);
    if (chunkCount === 1) {
      return cache.get(key);
    }
    var parts = [];
    for (var i = 0; i < chunkCount; i++) {
      var part = cache.get(key + '__chunk_' + i);
      if (!part) return null; // chunk scaduto → rileggi dal foglio
      parts.push(part);
    }
    return parts.join('');
  } catch(e) {
    debugLog('cacheGet error (ignorato)', e.message);
    return null;
  }
}

function cacheInvalidate(cache, key) {
  try {
    var chunkCountStr = cache.get(key + '__chunks');
    if (!chunkCountStr) return;
    var n = parseInt(chunkCountStr, 10);
    if (n === 1) {
      cache.remove(key);
    } else {
      for (var i = 0; i < n; i++) cache.remove(key + '__chunk_' + i);
    }
    cache.remove(key + '__chunks');
  } catch(e) {
    debugLog('cacheInvalidate error (ignorato)', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// IDEMPOTENZA — UUID check L1 (cache) → L2 (sheet)
// ══════════════════════════════════════════════════════════════

/**
 * Controlla se un event_id è già stato processato.
 * L1: CacheService (~2ms, TTL 2h)
 * L2: Fallback lettura colonna event_id su Timeline (~200ms)
 */
function isEventDuplicate(cache, ss, eventId) {
  if (!eventId || String(eventId).trim() === '') return false;

  var cacheKey = 'eid_' + eventId;

  // L1: Cache rapida
  if (cache.get(cacheKey) === '1') {
    debugLog('isEventDuplicate — L1 cache HIT', eventId);
    return true;
  }

  // L2: Fallback sul foglio Timeline
  try {
    var sheet = ss.getSheetByName(SHEET_NAMES.TIMELINE);
    if (!sheet || sheet.getLastRow() <= 1) return false;
    var col = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < col.length; i++) {
      if (String(col[i][0]).trim() === String(eventId).trim()) {
        cache.put(cacheKey, '1', CACHE_TTL_UUID); // promuovi in L1
        debugLog('isEventDuplicate — L2 sheet HIT (promosso in L1)', eventId);
        return true;
      }
    }
  } catch(e) {
    debugLog('isEventDuplicate — L2 error (ignorato)', e.message);
  }

  return false;
}

/**
 * Dopo una scrittura riuscita: registra UUID in L1 per 2h.
 */
function markEventProcessed(cache, eventId) {
  if (eventId && String(eventId).trim() !== '') {
    cache.put('eid_' + eventId, '1', CACHE_TTL_UUID);
  }
}

// ══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════

function debugLog(label, value) {
  if (!DEBUG) return;
  try {
    Logger.log('[D.U.B.I.A.] ' + label + ': ' + JSON.stringify(value));
  } catch(e) {
    Logger.log('[D.U.B.I.A.] ' + label + ': [serializzazione fallita]');
  }
}

function convertCell(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    try {
      return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    } catch(e) {
      var y = value.getFullYear();
      var m = String(value.getMonth() + 1).padStart(2, '0');
      var d = String(value.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    }
  }
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    var t = value.trim();
    return t === '' ? null : t;
  }
  return value;
}

function isRowEmpty(row) {
  for (var i = 0; i < row.length; i++) {
    if (row[i] !== null && row[i] !== undefined && row[i] !== '') return false;
  }
  return true;
}

function safeJsonParse(rawString) {
  if (!rawString || typeof rawString !== 'string') {
    throw new Error('Il body della richiesta è vuoto o non è una stringa.');
  }
  try {
    return JSON.parse(rawString);
  } catch(e) {
    throw new Error('JSON non valido: ' + e.message);
  }
}

function buildJsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════════════════════
// INIT SHEETS — garantisce che ogni foglio abbia le colonne corrette
// ══════════════════════════════════════════════════════════════

/**
 * Assicura che tutti i fogli esistano e abbiano l'header dello schema fisso.
 * Chiamata in doPost (lazy init): se il foglio è vuoto, scrive l'header.
 * Non tocca mai i fogli con dati esistenti.
 */
function ensureSheetSchema(ss, sheetName) {
  var schema = SHEET_SCHEMAS[sheetName];
  if (!schema) return;

  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    debugLog('ensureSheetSchema — creato foglio', sheetName);
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(schema);
    debugLog('ensureSheetSchema — header scritto', sheetName);
  }
}

// ══════════════════════════════════════════════════════════════
// READ — lettura foglio con schema fisso
// ══════════════════════════════════════════════════════════════

function readSheet(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error("Foglio '" + sheetName + "' non trovato.");

  var lastRow = sheet.getLastRow();
  debugLog('readSheet', { sheet: sheetName, lastRow: lastRow });

  if (lastRow <= 1) return [];

  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h).trim(); });

  var result = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (isRowEmpty(row)) continue;
    var obj = {};
    var hasValue = false;
    for (var j = 0; j < headers.length; j++) {
      if (!headers[j]) continue;
      var v = convertCell(j < row.length ? row[j] : null);
      obj[headers[j]] = v;
      if (v !== null) hasValue = true;
    }
    if (hasValue) result.push(obj);
  }

  debugLog('readSheet — risultati', result.length);
  return result;
}

// ══════════════════════════════════════════════════════════════
// WRITE — schema rigido (NO espansione colonne)
// ══════════════════════════════════════════════════════════════

/**
 * Scrive una riga su un foglio rispettando SOLO le colonne dell'header esistente.
 * Chiavi extra nel dato vengono IGNORATE silenziosamente.
 * Se il foglio è vuoto, lo inizializza con lo schema fisso.
 */
function writeToSheetStrict(ss, sheetName, data) {
  ensureSheetSchema(ss, sheetName);

  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    debugLog('writeToSheetStrict — foglio non trovato', sheetName);
    return;
  }

  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    debugLog('writeToSheetStrict — foglio senza header dopo init', sheetName);
    return;
  }

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function(h) { return String(h).trim(); });

  // Costruisce la riga: solo i campi presenti nell'header, nient'altro
  var newRow = headers.map(function(header) {
    if (!header) return '';
    var val = data[header];
    return (val !== undefined && val !== null) ? val : '';
  });

  debugLog('writeToSheetStrict — riga su ' + sheetName, newRow);
  sheet.appendRow(newRow);
}

// ══════════════════════════════════════════════════════════════
// DELETE helper — elimina righe per valore in colonna 'id'
// ══════════════════════════════════════════════════════════════

function deleteRowsById(ss, sheetName, targetId) {
  if (targetId === null || targetId === undefined || String(targetId).trim() === '') {
    debugLog('deleteRowsById — id vuoto, annullato', targetId);
    return 0;
  }

  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return 0;

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return 0;

  var headers = data[0];
  var idColIndex = -1;
  for (var h = 0; h < headers.length; h++) {
    if (String(headers[h]).trim().toLowerCase() === 'id') { idColIndex = h; break; }
  }
  if (idColIndex < 0) return 0;

  var targetStr = String(targetId);
  var deleted = 0;
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][idColIndex]) === targetStr) {
      sheet.deleteRow(i + 1);
      deleted++;
    }
  }
  debugLog('deleteRowsById — eliminate ' + deleted + ' righe da ' + sheetName, targetId);
  return deleted;
}

// ══════════════════════════════════════════════════════════════
// UPSERT helper — delete + insert (per Colonie, Clienti, Cessioni)
// ══════════════════════════════════════════════════════════════

function upsertToSheet(ss, sheetName, data, idField) {
  idField = idField || 'id';
  var id = data[idField];
  if (id !== undefined && id !== null && String(id).trim() !== '') {
    deleteRowsById(ss, sheetName, id);
  }
  writeToSheetStrict(ss, sheetName, data);
}

// ══════════════════════════════════════════════════════════════
// ENDPOINT: doGet
// ══════════════════════════════════════════════════════════════
// Parametri: ?sheet=NomeFoglio (default: Timeline)
//            ?action=listSheets
// ──────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    var action = params.action || 'getData';
    var sheetName = params.sheet || SHEET_NAMES.TIMELINE;

    debugLog('doGet', { action: action, sheet: sheetName });

    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (action === 'listSheets') {
      var sheets = ss.getSheets().map(function(s) { return s.getName(); });
      return buildJsonResponse({ status: 'success', sheets: sheets });
    }

    if (!VALID_SHEET_NAMES[sheetName]) {
      return buildJsonResponse({
        status: 'error',
        message: 'Foglio "' + sheetName + '" non autorizzato. Validi: ' + Object.keys(VALID_SHEET_NAMES).join(', ')
      });
    }

    // Prova la cache (chunking)
    var cache = CacheService.getScriptCache();
    var cacheKey = 'sheet_' + sheetName;
    var cached = cacheGet(cache, cacheKey);
    if (cached) {
      debugLog('doGet — cache HIT', sheetName);
      return ContentService
        .createTextOutput(cached)
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Cache MISS → leggi dal foglio
    debugLog('doGet — cache MISS, lettura foglio', sheetName);
    var result = readSheet(ss, sheetName);
    var response = {
      status: 'success',
      sheet: sheetName,
      count: result.length,
      data: result
    };

    // Salva in cache con chunking
    cacheSet(cache, cacheKey, response);

    return buildJsonResponse(response);

  } catch(err) {
    Logger.log('[D.U.B.I.A. ERROR] doGet: ' + err.toString());
    return buildJsonResponse({ status: 'error', message: err.toString() });
  }
}

// ══════════════════════════════════════════════════════════════
// ENDPOINT: doPost
// ══════════════════════════════════════════════════════════════
// Routing per event_type:
//   pesata / nuovo_sangue → Timeline + Pesate
//   cibo                  → Timeline + Cibo
//   prelievo              → Timeline + Prelievi + UPSERT Colonie (current_weight)
//   calibrazione          → Timeline + Censimento
//   colonia_sync          → UPSERT Colonie
//   colonia_delete        → DELETE Colonie
//   cliente_sync          → UPSERT Clienti
//   cliente_delete        → DELETE Clienti
//   cessione_sync         → UPSERT Cessioni
//   cessione_delete       → DELETE Cessioni
// ──────────────────────────────────────────────────────────────
function doPost(e) {
  var risposta = { status: 'error', message: 'Richiesta non valida.' };

  // ── LockService: serializza scritture simultanee ─────────────
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(12000); // max 12s in coda, poi errore
  } catch(lockErr) {
    return buildJsonResponse({
      status: 'error',
      message: 'Server temporaneamente occupato. Riprova tra qualche secondo.'
    });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Nessun dato ricevuto nel body della richiesta POST.');
    }

    var dati = safeJsonParse(e.postData.contents);
    debugLog('doPost — dati ricevuti', { event_type: dati.event_type, event_id: dati.event_id });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var cache = CacheService.getScriptCache();
    var eventType = dati['event_type'] || 'pesata';
    var eventId = dati['event_id'] || null;

    // ── ROUTING ───────────────────────────────────────────────

    // ── colonia_delete ────────────────────────────────────────
    if (eventType === 'colonia_delete') {
      var delId = dati['id'];
      if (delId === null || delId === undefined) throw new Error('colonia_delete richiede "id".');
      var n = deleteRowsById(ss, SHEET_NAMES.COLONIE, delId);
      cacheInvalidate(cache, 'sheet_' + SHEET_NAMES.COLONIE);
      risposta = { status: 'success', message: 'Colonia ' + delId + ' eliminata (' + n + ' righe).' };
      return buildJsonResponse(risposta);
    }

    // ── cliente_delete ────────────────────────────────────────
    if (eventType === 'cliente_delete') {
      var delId = dati['id'];
      if (delId === null || delId === undefined) throw new Error('cliente_delete richiede "id".');
      var n = deleteRowsById(ss, SHEET_NAMES.CLIENTI, delId);
      cacheInvalidate(cache, 'sheet_' + SHEET_NAMES.CLIENTI);
      risposta = { status: 'success', message: 'Cliente ' + delId + ' eliminato (' + n + ' righe).' };
      return buildJsonResponse(risposta);
    }

    // ── cessione_delete ───────────────────────────────────────
    if (eventType === 'cessione_delete') {
      var delId = dati['id'];
      if (delId === null || delId === undefined) throw new Error('cessione_delete richiede "id".');
      var n = deleteRowsById(ss, SHEET_NAMES.CESSIONI, delId);
      cacheInvalidate(cache, 'sheet_' + SHEET_NAMES.CESSIONI);
      risposta = { status: 'success', message: 'Cessione ' + delId + ' eliminata (' + n + ' righe).' };
      return buildJsonResponse(risposta);
    }

    // ── colonia_sync: UPSERT ──────────────────────────────────
    if (eventType === 'colonia_sync') {
      upsertToSheet(ss, SHEET_NAMES.COLONIE, dati, 'id');
      cacheInvalidate(cache, 'sheet_' + SHEET_NAMES.COLONIE);
      risposta = { status: 'success', message: 'Colonia id=' + dati.id + ' salvata.' };
      return buildJsonResponse(risposta);
    }

    // ── cliente_sync: UPSERT ──────────────────────────────────
    if (eventType === 'cliente_sync') {
      upsertToSheet(ss, SHEET_NAMES.CLIENTI, dati, 'id');
      cacheInvalidate(cache, 'sheet_' + SHEET_NAMES.CLIENTI);
      risposta = { status: 'success', message: 'Cliente id=' + dati.id + ' salvato.' };
      return buildJsonResponse(risposta);
    }

    // ── cessione_sync: UPSERT ─────────────────────────────────
    if (eventType === 'cessione_sync') {
      upsertToSheet(ss, SHEET_NAMES.CESSIONI, dati, 'id');
      cacheInvalidate(cache, 'sheet_' + SHEET_NAMES.CESSIONI);
      risposta = { status: 'success', message: 'Cessione id=' + dati.id + ' salvata.' };
      return buildJsonResponse(risposta);
    }

    // ── EVENTI CON event_id (pesata, cibo, prelievo, calibrazione, nuovo_sangue) ──

    // Controllo idempotenza L1+L2 (solo per eventi con event_id)
    if (eventId && isEventDuplicate(cache, ss, eventId)) {
      debugLog('doPost — duplicato ignorato', eventId);
      risposta = { status: 'success', message: 'Evento già registrato (duplicato ignorato).', duplicate: true };
      return buildJsonResponse(risposta);
    }

    // Determina foglio secondario di destinazione
    var targetSheet = null;
    if (eventType === 'pesata' || eventType === 'nuovo_sangue') {
      targetSheet = SHEET_NAMES.PESATE;
    } else if (eventType === 'cibo') {
      targetSheet = SHEET_NAMES.CIBO;
    } else if (eventType === 'prelievo') {
      targetSheet = SHEET_NAMES.PRELIEVI;
    } else if (eventType === 'calibrazione') {
      targetSheet = SHEET_NAMES.CENSIMENTO;
    }
    // event_type sconosciuto → solo Timeline

    // Scrivi Timeline
    writeToSheetStrict(ss, SHEET_NAMES.TIMELINE, dati);
    cacheInvalidate(cache, 'sheet_' + SHEET_NAMES.TIMELINE);

    // Scrivi foglio secondario
    if (targetSheet) {
      writeToSheetStrict(ss, targetSheet, dati);
      cacheInvalidate(cache, 'sheet_' + targetSheet);
    }

    // ── Prelievo: aggiorna anche Colonie (current_weight) ──────
    if (eventType === 'prelievo' && dati.colony_id !== null && dati.colony_id !== undefined) {
      var colonyWeightAfter = dati['colony_weight_after'];
      if (colonyWeightAfter !== undefined && colonyWeightAfter !== null) {
        // Leggi la colonia dal foglio Colonie
        var colonieSheet = ss.getSheetByName(SHEET_NAMES.COLONIE);
        if (colonieSheet && colonieSheet.getLastRow() > 1) {
          var colonieData = colonieSheet.getDataRange().getValues();
          var colonieHeaders = colonieData[0].map(function(h) { return String(h).trim(); });
          var idIdx = colonieHeaders.indexOf('id');
          var weightIdx = colonieHeaders.indexOf('current_weight');

          if (idIdx >= 0 && weightIdx >= 0) {
            for (var r = 1; r < colonieData.length; r++) {
              if (String(colonieData[r][idIdx]) === String(dati.colony_id)) {
                colonieSheet.getRange(r + 1, weightIdx + 1).setValue(colonyWeightAfter);
                debugLog('doPost — Colonie.current_weight aggiornato per id=' + dati.colony_id, colonyWeightAfter);
                break;
              }
            }
          }
        }
        cacheInvalidate(cache, 'sheet_' + SHEET_NAMES.COLONIE);
      }
    }

    // Segna event_id come processato in L1
    markEventProcessed(cache, eventId);

    risposta = {
      status: 'success',
      message: 'Evento "' + eventType + '" salvato' + (targetSheet ? ' in Timeline e ' + targetSheet : ' in Timeline') + '.'
    };
    debugLog('doPost — risposta', risposta);

  } catch(err) {
    Logger.log('[D.U.B.I.A. ERROR] doPost: ' + err.toString());
    risposta = { status: 'error', message: err.toString() };
  } finally {
    lock.releaseLock();
  }

  return buildJsonResponse(risposta);
}

// ══════════════════════════════════════════════════════════════
// BACKUP NOTTURNO
// Da registrare manualmente come trigger Time-driven alle 03:00.
// Crea una copia completa dello Spreadsheet in "DUBIA_Backups" su Drive.
// Mantiene solo gli ultimi 30 backup, elimina i più vecchi.
// ══════════════════════════════════════════════════════════════
function createNightlyBackup() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var today = Utilities.formatDate(new Date(), 'Europe/Rome', 'yyyy-MM-dd');
    var backupName = 'DUBIA_Backup_' + today;

    // Trova o crea cartella backup
    var folderIt = DriveApp.getFoldersByName('DUBIA_Backups');
    var folder = folderIt.hasNext() ? folderIt.next() : DriveApp.createFolder('DUBIA_Backups');

    // Copia il file
    var originalFile = DriveApp.getFileById(ss.getId());
    var copy = originalFile.makeCopy(backupName, folder);

    Logger.log('[D.U.B.I.A. BACKUP] Creato: ' + backupName + ' (id: ' + copy.getId() + ')');

    // Pulizia: mantieni solo gli ultimi 30 backup
    var filesIt = folder.getFiles();
    var allFiles = [];
    while (filesIt.hasNext()) allFiles.push(filesIt.next());

    // Ordina per data creazione (più vecchio prima)
    allFiles.sort(function(a, b) {
      return a.getDateCreated().getTime() - b.getDateCreated().getTime();
    });

    while (allFiles.length > 30) {
      var old = allFiles.shift();
      old.setTrashed(true);
      Logger.log('[D.U.B.I.A. BACKUP] Eliminato backup vecchio: ' + old.getName());
    }

    Logger.log('[D.U.B.I.A. BACKUP] Completato. Backup totali: ' + allFiles.length);

  } catch(err) {
    Logger.log('[D.U.B.I.A. BACKUP ERROR] ' + err.toString());
  }
}

// ══════════════════════════════════════════════════════════════
// UTILITY — Inizializza tutti i fogli con lo schema fisso
// Eseguire manualmente una volta dopo il deploy se i fogli sono nuovi.
// ══════════════════════════════════════════════════════════════
function initAllSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  for (var name in SHEET_SCHEMAS) {
    if (SHEET_SCHEMAS.hasOwnProperty(name)) {
      ensureSheetSchema(ss, name);
      Logger.log('[D.U.B.I.A. INIT] Foglio pronto: ' + name);
    }
  }
  Logger.log('[D.U.B.I.A. INIT] Tutti i fogli inizializzati.');
}
