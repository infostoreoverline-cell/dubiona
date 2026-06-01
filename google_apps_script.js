// ╔══════════════════════════════════════════════════════════════════╗
// ║  D.U.B.I.A. — Google Apps Script Backend V3                     ║
// ║  Dynamic Updating Biomass Inference Algorithm                    ║
// ║                                                                  ║
// ║  Architettura:                                                   ║
// ║    • Schema Rigido: SCHEMAS whitelist per ogni foglio             ║
// ║    • LockService: serializza tutte le scritture simultanee       ║
// ║    • CacheService con chunking 90KB per doGet performante        ║
// ║    • Idempotenza L1 (Cache 2h) + L2 (scan foglio)               ║
// ║    • Routing pulito con validazione event_type                   ║
// ║    • Zero side-effects: funzioni pure e isolate                  ║
// ╚══════════════════════════════════════════════════════════════════╝

// ══════════════════════════════════════════════════════════════
// CONFIGURAZIONE GLOBALE
// ══════════════════════════════════════════════════════════════

/**
 * ID del tuo Google Spreadsheet.
 * Ricavalo dall'URL: https://docs.google.com/spreadsheets/d/QUESTO_VALORE/edit
 */
var SPREADSHEET_ID = '135VLAsiFTJtOHVJS1vglgX09XJbR7IQyR6HMixD8hQM';

// ── Nomi dei fogli ─────────────────────────────────────────────
var SHEET_NAMES = {
  TIMELINE:   'Timeline',
  COLONIE:    'Colonie',
  CLIENTI:    'Clienti',
  CESSIONI:   'Cessioni'
};

// ── Schema Rigido ──────────────────────────────────────────────
// Ogni foglio ha una lista ORDINATA di colonne.
// Solo queste colonne verranno scritte. Qualsiasi campo extra
// nel payload JSON viene IGNORATO silenziosamente.
// L'ORDINE qui è l'ordine delle colonne nel foglio (Riga 1).
var SCHEMAS = {
  Timeline: [
    'event_id',
    'event_type',
    'date',
    'total_weight',
    'food_amount',
    'harvest_amount',
    'adult_ratio',
    'predicted_weight',
    'health_index',
    'is_new_blood',
    'notes',
    'colony_id',
    'colony_weight_after'
  ],
  Colonie: [
    'id',
    'date',
    'name',
    'type',
    'current_weight',
    'males_count',
    'females_count',
    'subadults_count',
    'medium_count',
    'small_count',
    'baby_count',
    'notes',
    'is_deleted'
  ],
  Clienti: [
    'id',
    'nome',
    'cognome',
    'citta',
    'telefono',
    'email',
    'animale',
    'note',
    'data_aggiunta',
    'is_deleted'
  ],
  Cessioni: [
    'id',
    'cliente_id',
    'data',
    'tipo_blatta',
    'quantita_g',
    'prezzo_unit',
    'totale_euro',
    'note',
    'is_deleted'
  ]
};

// ── Routing valido per doPost ──────────────────────────────────
// Mappa event_type → azione. Se non è in questa lista → errore.
var VALID_EVENT_TYPES = {
  'pesata':          'timeline',
  'cibo':            'timeline',
  'prelievo':        'timeline',
  'calibrazione':    'timeline',
  'nuovo_sangue':    'timeline',
  'transfer':        'timeline',   // Trasferimento biomassa tra colonie (tracciabilità)
  'colonia_sync':    'entity_upsert',
  'colonia_delete':  'entity_delete',
  'cliente_sync':    'entity_upsert',
  'cliente_delete':  'entity_delete',
  'cessione_sync':   'entity_upsert',
  'cessione_delete': 'entity_delete'
};

// ── Cache Config ───────────────────────────────────────────────
var CACHE_CHUNK_SIZE = 90000;  // 90KB per chunk (limite GAS = 100KB)
var CACHE_TTL        = 300;    // 5 minuti
var IDEM_CACHE_TTL   = 7200;   // 2 ore per idempotenza L1

// ── Alerting ───────────────────────────────────────────────────
var ALERT_EMAIL = '';  // Inserisci la tua email per ricevere crash report (es. 'tuo@gmail.com')


// ══════════════════════════════════════════════════════════════
// UTILITY: JSON Response Builder
// ══════════════════════════════════════════════════════════════

function buildJsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ══════════════════════════════════════════════════════════════
// UTILITY: Logging
// ══════════════════════════════════════════════════════════════

function debugLog(context, detail) {
  Logger.log('[D.U.B.I.A.] ' + context + ': ' + JSON.stringify(detail));
}


// ══════════════════════════════════════════════════════════════
// UTILITY: Sanitizzazione Anti Formula Injection
// ══════════════════════════════════════════════════════════════
// Se un valore stringa inizia con =, +, -, @ (caratteri che Google
// Sheets interpreta come formula), viene neutralizzato con un
// apostrofo iniziale per forzare la lettura come puro testo.

/**
 * Sanitizza un valore prima di scriverlo in Google Sheets.
 * Previene CSV/Formula Injection.
 * @param {*} val
 * @returns {*}
 */
function sanitizeValue(val) {
  if (typeof val === 'string' && val.length > 0 && /^[=+\-@]/.test(val)) {
    return "'" + val;
  }
  return val;
}


// ══════════════════════════════════════════════════════════════
// CACHE: Lettura/Scrittura con Chunking Automatico
// ══════════════════════════════════════════════════════════════
// Google CacheService ha un limite di 100KB per valore.
// Per dataset grandi, spezziamo il JSON in chunk < 90KB
// e li salviamo come chiavi separate (key__0, key__1, ...).
// Un contatore key__meta tiene traccia del numero di chunk.

/**
 * Salva un oggetto in cache, spezzandolo in chunk se necessario.
 * @param {Cache} cache - CacheService.getScriptCache()
 * @param {string} key - Chiave base
 * @param {*} value - Oggetto da serializzare
 */
function cacheSet(cache, key, value) {
  try {
    var json = JSON.stringify(value);
    
    if (json.length <= CACHE_CHUNK_SIZE) {
      // Caso semplice: entra in un solo chunk
      cache.put(key + '__meta', '1', CACHE_TTL);
      cache.put(key + '__0', json, CACHE_TTL);
    } else {
      // Spezza in chunk
      var chunks = [];
      for (var i = 0; i < json.length; i += CACHE_CHUNK_SIZE) {
        chunks.push(json.substring(i, i + CACHE_CHUNK_SIZE));
      }
      cache.put(key + '__meta', String(chunks.length), CACHE_TTL);
      for (var c = 0; c < chunks.length; c++) {
        cache.put(key + '__' + c, chunks[c], CACHE_TTL);
      }
    }
  } catch (e) {
    debugLog('cacheSet error', e.toString());
  }
}

/**
 * Legge un oggetto dalla cache, ricomponendo i chunk.
 * @param {Cache} cache
 * @param {string} key
 * @returns {*|null} Oggetto deserializzato o null se non in cache
 */
function cacheGet(cache, key) {
  try {
    var metaStr = cache.get(key + '__meta');
    if (!metaStr) return null;
    
    var numChunks = parseInt(metaStr, 10);
    if (isNaN(numChunks) || numChunks <= 0) return null;
    
    var json = '';
    for (var c = 0; c < numChunks; c++) {
      var chunk = cache.get(key + '__' + c);
      if (chunk === null) return null; // Chunk scaduto → cache miss
      json += chunk;
    }
    
    return JSON.parse(json);
  } catch (e) {
    debugLog('cacheGet error', e.toString());
    return null;
  }
}

/**
 * Invalida una chiave cache (rimuove meta + tutti i chunk).
 * @param {Cache} cache
 * @param {string} key
 */
function cacheInvalidate(cache, key) {
  try {
    var metaStr = cache.get(key + '__meta');
    if (metaStr) {
      var numChunks = parseInt(metaStr, 10) || 0;
      var keysToRemove = [key + '__meta'];
      for (var c = 0; c < numChunks; c++) {
        keysToRemove.push(key + '__' + c);
      }
      cache.removeAll(keysToRemove);
    }
  } catch (e) {
    debugLog('cacheInvalidate error', e.toString());
  }
}


// ══════════════════════════════════════════════════════════════
// IDEMPOTENZA: L1 (Cache) + L2 (Foglio)
// ══════════════════════════════════════════════════════════════
// L1: Controlla in CacheService (2ms, TTL 2h).
// L2: Se L1 miss, scansiona la colonna event_id di Timeline.
// Se l'UUID esiste già → duplicato → rifiuta silenziosamente.

/**
 * Verifica se un event_id è già stato processato.
 * @param {Cache} cache
 * @param {Sheet} timelineSheet - Foglio Timeline
 * @param {string} eventId - UUID da verificare
 * @returns {boolean} true se duplicato
 */
function isEventDuplicate(cache, timelineSheet, eventId) {
  if (!eventId) return false;
  
  // L1: Cache check (velocissimo, ~2ms)
  var cacheKey = 'idem_' + eventId;
  if (cache.get(cacheKey)) {
    debugLog('Idempotenza L1 HIT', eventId);
    return true;
  }
  
  // L2: TextFinder (nativo GAS, ordini di grandezza più veloce di getValues)
  // Cerca l'event_id nella colonna A (event_id) con match esatto sulla cella intera
  var lastRow = timelineSheet.getLastRow();
  if (lastRow <= 1) return false; // Solo header
  
  var finder = timelineSheet.getRange('A:A')
    .createTextFinder(String(eventId))
    .matchEntireCell(true)
    .matchCase(true);
  var found = finder.findNext();
  
  if (found) {
    // Trovato nel foglio ma non in cache → ripopola cache L1
    cache.put(cacheKey, '1', IDEM_CACHE_TTL);
    debugLog('Idempotenza L2 HIT (TextFinder)', eventId);
    return true;
  }
  
  return false;
}

/**
 * Registra un event_id come processato nella cache L1.
 * @param {Cache} cache
 * @param {string} eventId
 */
function markEventProcessed(cache, eventId) {
  if (eventId) {
    cache.put('idem_' + eventId, '1', IDEM_CACHE_TTL);
  }
}


// ══════════════════════════════════════════════════════════════
// FOGLIO: Lettura righe come array di oggetti
// ══════════════════════════════════════════════════════════════

/**
 * Legge tutte le righe di un foglio e le restituisce come
 * array di oggetti { header1: val1, header2: val2, ... }.
 * @param {Sheet} sheet
 * @returns {Object[]}
 */
function readSheetAsObjects(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow <= 1 || lastCol === 0) return [];
  
  var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  
  var result = [];
  for (var r = 0; r < data.length; r++) {
    var row = data[r];
    // Salta righe completamente vuote
    var isEmpty = true;
    for (var c = 0; c < row.length; c++) {
      if (row[c] !== '' && row[c] !== null && row[c] !== undefined) {
        isEmpty = false;
        break;
      }
    }
    if (isEmpty) continue;
    
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var h = String(headers[c]).trim();
      if (h) obj[h] = row[c];
    }
    result.push(obj);
  }
  return result;
}


// ══════════════════════════════════════════════════════════════
// FOGLIO: Scrittura con Schema Rigido (Whitelist)
// ══════════════════════════════════════════════════════════════

/**
 * Scrive una riga nel foglio usando SOLO le colonne definite
 * nello schema. I campi extra nel payload vengono IGNORATI.
 * I campi mancanti vengono scritti come stringa vuota.
 * 
 * NON crea MAI nuove colonne.
 * 
 * @param {Sheet} sheet - Il foglio di destinazione
 * @param {string} sheetName - Nome del foglio (per lookup in SCHEMAS)
 * @param {Object} data - Payload con i dati da scrivere
 */
function writeRowStrict(sheet, sheetName, data) {
  var schema = SCHEMAS[sheetName];
  if (!schema) throw new Error('Schema non trovato per foglio: ' + sheetName);
  
  var row = [];
  for (var i = 0; i < schema.length; i++) {
    var key = schema[i];
    var val = data.hasOwnProperty(key) ? data[key] : '';
    if (val === undefined || val === null) val = '';
    row.push(sanitizeValue(val));
  }
  
  sheet.appendRow(row);
}


// ══════════════════════════════════════════════════════════════
// FOGLIO: UPSERT per Entità (Colonie, Clienti, Cessioni)
// ══════════════════════════════════════════════════════════════
// Cerca la riga con lo stesso `id`. Se la trova, la aggiorna
// in-place. Se non la trova, inserisce una nuova riga.

/**
 * Aggiorna o inserisce un'entità nel foglio.
 * @param {Sheet} sheet
 * @param {string} sheetName - Nome foglio per lookup schema
 * @param {Object} data - Payload con i dati
 * @param {string} matchField - Campo da usare come chiave (default: 'id')
 */
function upsertRow(sheet, sheetName, data, matchField) {
  matchField = matchField || 'id';
  var schema = SCHEMAS[sheetName];
  if (!schema) throw new Error('Schema non trovato per foglio: ' + sheetName);
  
  var matchValue = data[matchField];
  if (matchValue === null || matchValue === undefined || matchValue === '') {
    throw new Error('upsertRow: campo "' + matchField + '" mancante nel payload.');
  }
  
  // Costruisci la riga secondo lo schema (con sanitizzazione)
  var newRow = [];
  for (var i = 0; i < schema.length; i++) {
    var key = schema[i];
    var val = data.hasOwnProperty(key) ? data[key] : '';
    if (val === undefined || val === null) val = '';
    newRow.push(sanitizeValue(val));
  }
  
  // Cerca riga esistente
  var matchCol = schema.indexOf(matchField) + 1; // 1-indexed per Sheets
  if (matchCol === 0) throw new Error('Campo "' + matchField + '" non trovato nello schema di ' + sheetName);
  
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var ids = sheet.getRange(2, matchCol, lastRow - 1, 1).getValues();
    for (var r = 0; r < ids.length; r++) {
      if (String(ids[r][0]) === String(matchValue)) {
        // Trovato → aggiorna in-place
        sheet.getRange(r + 2, 1, 1, newRow.length).setValues([newRow]);
        return 'updated';
      }
    }
  }
  
  // Non trovato → inserisci nuova riga
  sheet.appendRow(newRow);
  return 'inserted';
}


// ══════════════════════════════════════════════════════════════
// FOGLIO: SOFT DELETE per Entità (per id)
// ══════════════════════════════════════════════════════════════
// NON elimina fisicamente la riga. Imposta is_deleted = TRUE.
// I dati restano nel foglio per audit/ripristino manuale.
// Il doGet filtra automaticamente le righe con is_deleted.

/**
 * Soft-delete: imposta is_deleted = TRUE per tutte le righe con un determinato id.
 * @param {Sheet} sheet
 * @param {string} sheetName - Nome foglio per lookup schema
 * @param {*} id - Valore dell'id da cercare
 * @returns {number} Numero di righe "eliminate" (soft)
 */
function softDeleteById(sheet, sheetName, id) {
  var schema = SCHEMAS[sheetName];
  if (!schema) throw new Error('Schema non trovato per foglio: ' + sheetName);
  
  var idCol = schema.indexOf('id') + 1;
  if (idCol === 0) throw new Error('Il foglio ' + sheetName + ' non ha una colonna "id".');
  
  var deletedCol = schema.indexOf('is_deleted') + 1;
  if (deletedCol === 0) throw new Error('Il foglio ' + sheetName + ' non ha una colonna "is_deleted".');
  
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;
  
  var ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  var deletedCount = 0;
  
  for (var r = 0; r < ids.length; r++) {
    if (String(ids[r][0]) === String(id)) {
      sheet.getRange(r + 2, deletedCol).setValue('TRUE');
      deletedCount++;
    }
  }
  
  return deletedCount;
}


// ══════════════════════════════════════════════════════════════
// UTILITY: Init Header di un foglio
// ══════════════════════════════════════════════════════════════

/**
 * Se un foglio è vuoto, scrive gli header dalla whitelist SCHEMAS.
 * Se ha già header, non li tocca.
 * @param {Spreadsheet} ss
 * @param {string} sheetName
 */
function ensureHeaders(ss, sheetName) {
  var schema = SCHEMAS[sheetName];
  if (!schema) return;
  
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    // Crea il foglio se non esiste
    sheet = ss.insertSheet(sheetName);
  }
  
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(schema);
    // Formatta header
    var headerRange = sheet.getRange(1, 1, 1, schema.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#1a1a2e');
    headerRange.setFontColor('#e0e0e0');
    sheet.setFrozenRows(1);
  }
}


// ══════════════════════════════════════════════════════════════
// UTILITY: Inizializza tutti i fogli (eseguire una volta)
// ══════════════════════════════════════════════════════════════

/**
 * Funzione da eseguire manualmente UNA VOLTA per creare
 * tutti i fogli con i loro header corretti.
 */
function initAllSheets() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var names = Object.keys(SHEET_NAMES);
  for (var i = 0; i < names.length; i++) {
    ensureHeaders(ss, SHEET_NAMES[names[i]]);
  }
  debugLog('initAllSheets', 'Tutti i fogli inizializzati.');
}


// ══════════════════════════════════════════════════════════════
// BACKUP NOTTURNO
// ══════════════════════════════════════════════════════════════
// Eseguire con trigger giornaliero (03:00-04:00).
// Crea una copia del foglio in una cartella Drive dedicata.
// Mantiene al massimo 30 backup, eliminando i più vecchi.

function createNightlyBackup() {
  try {
    var file = DriveApp.getFileById(SPREADSHEET_ID);
    var folderName = 'DUBIA_Backups';
    var folders = DriveApp.getFoldersByName(folderName);
    var folder;
    
    if (folders.hasNext()) {
      folder = folders.next();
    } else {
      folder = DriveApp.createFolder(folderName);
    }
    
    var backupName = 'DUBIA_Backup_' + Utilities.formatDate(new Date(), 'Europe/Rome', 'yyyy-MM-dd_HH-mm');
    file.makeCopy(backupName, folder);
    
    // Rotazione: mantieni solo gli ultimi 30 backup
    var files = folder.getFiles();
    var allFiles = [];
    while (files.hasNext()) {
      var f = files.next();
      allFiles.push({ file: f, date: f.getDateCreated() });
    }
    
    if (allFiles.length > 30) {
      allFiles.sort(function(a, b) { return a.date - b.date; });
      var toDelete = allFiles.length - 30;
      for (var i = 0; i < toDelete; i++) {
        allFiles[i].file.setTrashed(true);
      }
    }
    
    debugLog('createNightlyBackup', 'Backup creato: ' + backupName);
  } catch (e) {
    debugLog('createNightlyBackup ERROR', e.toString());
  }
}


// ══════════════════════════════════════════════════════════════
// ENDPOINT: doGet
// ══════════════════════════════════════════════════════════════
// Parametro: ?sheet=NomeFoglio
// Restituisce tutti i dati del foglio come array di oggetti.
// Usa CacheService con chunking per performance.
//
// Risposta: { status: 'success', sheet: '...', count: N, data: [...] }

function doGet(e) {
  try {
    var sheetName = (e && e.parameter && e.parameter.sheet)
      ? String(e.parameter.sheet).trim()
      : 'Timeline';
    
    // Parametro opzionale: ?last_sync=<timestamp_ms>
    // Se presente, restituisce solo i record con 'date' >= last_sync
    var lastSync = (e && e.parameter && e.parameter.last_sync)
      ? parseInt(e.parameter.last_sync, 10)
      : 0;
    
    // Validazione: il foglio deve esistere nello schema
    if (!SCHEMAS[sheetName]) {
      return buildJsonResponse({
        status: 'error',
        message: 'Foglio "' + sheetName + '" non previsto nello schema.'
      });
    }
    
    // Controlla cache (solo se non c'è last_sync, altrimenti serve il dato fresco)
    var cache = CacheService.getScriptCache();
    var cacheKey = 'sheet_' + sheetName;
    if (!lastSync) {
      var cached = cacheGet(cache, cacheKey);
      if (cached) {
        debugLog('doGet CACHE HIT', sheetName);
        return buildJsonResponse(cached);
      }
    }
    
    // Cache miss o sync incrementale → leggi dal foglio
    debugLog('doGet CACHE MISS', { sheet: sheetName, lastSync: lastSync });
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(sheetName);
    
    if (!sheet) {
      return buildJsonResponse({
        status: 'success',
        sheet: sheetName,
        count: 0,
        data: []
      });
    }
    
    var data = readSheetAsObjects(sheet);
    
    // ── Filtro Soft Delete: nascondi righe con is_deleted = TRUE ──
    var schema = SCHEMAS[sheetName];
    if (schema.indexOf('is_deleted') >= 0) {
      data = data.filter(function(row) {
        return String(row.is_deleted).toUpperCase() !== 'TRUE';
      });
    }
    
    // ── Filtro Sync Incrementale: solo record dopo last_sync ──
    if (lastSync > 0) {
      var syncDate = new Date(lastSync);
      data = data.filter(function(row) {
        var rowDate = row.date ? new Date(row.date) : null;
        return rowDate && rowDate >= syncDate;
      });
    }
    
    var response = {
      status: 'success',
      sheet: sheetName,
      count: data.length,
      data: data,
      server_time: Date.now()  // Il frontend può salvarlo come prossimo last_sync
    };
    
    // Salva in cache solo il dataset completo (non quello incrementale)
    if (!lastSync) {
      cacheSet(cache, cacheKey, response);
    }
    
    return buildJsonResponse(response);
    
  } catch (err) {
    debugLog('doGet ERROR', err.toString());
    return buildJsonResponse({ status: 'error', message: err.toString() });
  }
}


// ══════════════════════════════════════════════════════════════
// ENDPOINT: doPost
// ══════════════════════════════════════════════════════════════
//
// Routing per event_type:
//
//   EVENTI TIMELINE (scritti nel foglio Timeline):
//   ├── pesata         → Timeline
//   ├── cibo           → Timeline
//   ├── prelievo       → Timeline + aggiorna Colonie.current_weight
//   ├── calibrazione   → Timeline
//   └── nuovo_sangue   → Timeline
//
//   ENTITÀ CRUD:
//   ├── colonia_sync   → UPSERT Colonie
//   ├── colonia_delete → DELETE Colonie
//   ├── cliente_sync   → UPSERT Clienti
//   ├── cliente_delete → DELETE Clienti
//   ├── cessione_sync  → UPSERT Cessioni
//   └── cessione_delete→ DELETE Cessioni
//

function doPost(e) {
  var risposta = { status: 'error', message: 'Richiesta non valida.' };
  
  // ── LockService: serializza scritture simultanee ─────────────
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // max 30s in coda (margine per picchi di latenza GAS)
  } catch (lockErr) {
    return buildJsonResponse({
      status: 'error',
      message: 'Server temporaneamente occupato. Riprova tra qualche secondo.'
    });
  }
  
  try {
    // ── Parsing payload ─────────────────────────────────────────
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Nessun dato ricevuto nel body della richiesta POST.');
    }
    
    var dati;
    try {
      dati = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      throw new Error('JSON non valido: ' + parseErr.toString());
    }
    
    // ── Validazione event_type ──────────────────────────────────
    var eventType = String(dati.event_type || '').trim();
    if (!eventType || !VALID_EVENT_TYPES[eventType]) {
      throw new Error('event_type non riconosciuto: "' + eventType + '"');
    }
    
    var action = VALID_EVENT_TYPES[eventType];
    var eventId = dati.event_id || null;
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var cache = CacheService.getScriptCache();
    
    debugLog('doPost', { eventType: eventType, eventId: eventId, action: action });
    
    // ════════════════════════════════════════════════════════════
    // ROUTE: entity_delete (colonia_delete, cliente_delete, cessione_delete)
    // ════════════════════════════════════════════════════════════
    if (action === 'entity_delete') {
      var delId = dati.id;
      if (delId === null || delId === undefined) {
        throw new Error(eventType + ' richiede il campo "id".');
      }
      
      var targetSheetName;
      if (eventType === 'colonia_delete')  targetSheetName = SHEET_NAMES.COLONIE;
      if (eventType === 'cliente_delete')  targetSheetName = SHEET_NAMES.CLIENTI;
      if (eventType === 'cessione_delete') targetSheetName = SHEET_NAMES.CESSIONI;
      
      var sheet = ss.getSheetByName(targetSheetName);
      var n = 0;
      if (sheet) {
        n = softDeleteById(sheet, targetSheetName, delId);
      }
      
      // Invalida cache del foglio
      cacheInvalidate(cache, 'sheet_' + targetSheetName);
      
      risposta = {
        status: 'success',
        message: eventType + ': id=' + delId + ' eliminato (' + n + ' righe).'
      };
      return buildJsonResponse(risposta);
    }
    
    // ════════════════════════════════════════════════════════════
    // ROUTE: entity_upsert (colonia_sync, cliente_sync, cessione_sync)
    // ════════════════════════════════════════════════════════════
    if (action === 'entity_upsert') {
      var targetSheetName;
      if (eventType === 'colonia_sync')  targetSheetName = SHEET_NAMES.COLONIE;
      if (eventType === 'cliente_sync')  targetSheetName = SHEET_NAMES.CLIENTI;
      if (eventType === 'cessione_sync') targetSheetName = SHEET_NAMES.CESSIONI;
      
      var sheet = ss.getSheetByName(targetSheetName);
      if (!sheet) {
        // Auto-crea il foglio con header se non esiste
        ensureHeaders(ss, targetSheetName);
        sheet = ss.getSheetByName(targetSheetName);
      }
      
      var result = upsertRow(sheet, targetSheetName, dati, 'id');
      
      // Invalida cache del foglio
      cacheInvalidate(cache, 'sheet_' + targetSheetName);
      
      risposta = {
        status: 'success',
        message: eventType + ': id=' + dati.id + ' ' + result + '.'
      };
      return buildJsonResponse(risposta);
    }
    
    // ════════════════════════════════════════════════════════════
    // ROUTE: timeline (pesata, cibo, prelievo, calibrazione, nuovo_sangue)
    // ════════════════════════════════════════════════════════════
    if (action === 'timeline') {
      var timelineSheet = ss.getSheetByName(SHEET_NAMES.TIMELINE);
      if (!timelineSheet) {
        ensureHeaders(ss, SHEET_NAMES.TIMELINE);
        timelineSheet = ss.getSheetByName(SHEET_NAMES.TIMELINE);
      }
      
      // ── Idempotenza L1+L2 ───────────────────────────────────
      if (eventId && isEventDuplicate(cache, timelineSheet, eventId)) {
        debugLog('doPost — duplicato ignorato', eventId);
        risposta = {
          status: 'success',
          message: 'Evento già registrato (duplicato ignorato).',
          duplicate: true
        };
        return buildJsonResponse(risposta);
      }
      
      // ── Scrivi nella Timeline con schema rigido ─────────────
      writeRowStrict(timelineSheet, SHEET_NAMES.TIMELINE, dati);
      var insertedRow = timelineSheet.getLastRow(); // Riga appena inserita (per rollback)
      
      // ── Registra event_id come processato (L1) ─────────────
      markEventProcessed(cache, eventId);
      
      // ── Invalida SOLO la cache Timeline ─────────────────────
      cacheInvalidate(cache, 'sheet_' + SHEET_NAMES.TIMELINE);
      
      // ── Pseudo-Transazione: prelievo → aggiorna Colonie ────
      // Se è un prelievo con colony_id, aggiorna il current_weight
      // della colonia corrispondente. Se FALLISCE → ROLLBACK:
      // cancella la riga Timeline appena inserita e restituisce errore.
      if (eventType === 'prelievo' && dati.colony_id && dati.colony_weight_after !== undefined) {
        try {
          var colonieSheet = ss.getSheetByName(SHEET_NAMES.COLONIE);
          if (!colonieSheet) throw new Error('Foglio Colonie non trovato.');
          
          // Usa TextFinder per trovare la colonia velocemente
          var schema = SCHEMAS[SHEET_NAMES.COLONIE];
          var idCol = schema.indexOf('id') + 1;
          var weightCol = schema.indexOf('current_weight') + 1;
          
          if (idCol <= 0 || weightCol <= 0) throw new Error('Schema Colonie corrotto.');
          
          var finder = colonieSheet.getRange(2, idCol, Math.max(1, colonieSheet.getLastRow() - 1), 1)
            .createTextFinder(String(dati.colony_id))
            .matchEntireCell(true);
          var found = finder.findNext();
          
          if (!found) {
            debugLog('prelievo WARNING', 'colony_id=' + dati.colony_id + ' non trovata nel foglio Colonie. Evento Timeline registrato senza aggiornamento peso colonia.');
            // NON rollback: la pesata globale è valida, semplicemente la colonia non esiste nel cloud
          } else {
            colonieSheet.getRange(found.getRow(), weightCol).setValue(dati.colony_weight_after);
            // Invalida SOLO la cache Colonie (non Timeline, già invalidata sopra)
            cacheInvalidate(cache, 'sheet_' + SHEET_NAMES.COLONIE);
          }
        } catch (txErr) {
          // ── ROLLBACK: cancella la riga Timeline appena inserita ──
          debugLog('ROLLBACK prelievo', txErr.toString());
          try {
            timelineSheet.deleteRow(insertedRow);
            // Invalida di nuovo la cache Timeline (stato rollback)
            cacheInvalidate(cache, 'sheet_' + SHEET_NAMES.TIMELINE);
          } catch (rollbackErr) {
            debugLog('ROLLBACK FAILED', rollbackErr.toString());
          }
          throw new Error('Prelievo fallito (rollback eseguito): ' + txErr.toString());
        }
      }
      
      risposta = {
        status: 'success',
        message: 'Evento "' + eventType + '" registrato in Timeline.',
        event_id: eventId
      };
      return buildJsonResponse(risposta);
    }
    
    // Fallthrough (non dovrebbe mai arrivarci grazie alla validazione)
    throw new Error('Routing non gestito per event_type: ' + eventType);
    
  } catch (err) {
    debugLog('doPost ERROR', err.toString());
    
    // ── Alerting Attivo: invia crash report via email ────────
    if (ALERT_EMAIL) {
      try {
        var payloadPreview = '';
        try { payloadPreview = e && e.postData ? e.postData.contents.substring(0, 500) : 'N/A'; } catch(x) {}
        MailApp.sendEmail({
          to: ALERT_EMAIL,
          subject: '🚨 DUBIA CRASH REPORT - Errore Backend',
          body: 'Errore durante doPost:\n\n'
            + err.toString() + '\n\n'
            + 'Stack: ' + (err.stack || 'N/A') + '\n\n'
            + 'Payload (primi 500 char):\n' + payloadPreview + '\n\n'
            + 'Timestamp: ' + new Date().toISOString()
        });
      } catch (mailErr) {
        debugLog('ALERT EMAIL FAILED', mailErr.toString());
      }
    }
    
    risposta = { status: 'error', message: err.toString() };
    return buildJsonResponse(risposta);
    
  } finally {
    // Rilascia il lock SEMPRE, anche in caso di errore
    try { lock.releaseLock(); } catch (e) { /* silenzioso */ }
  }
}


// ══════════════════════════════════════════════════════════════
// MIGRAZIONE: Da DUBIOZZA (V2) a DUBIA_V3
// ══════════════════════════════════════════════════════════════
// Eseguire UNA SOLA VOLTA dall'editor GAS (▶️ Esegui).
// Legge i dati dal vecchio foglio, li filtra attraverso lo
// schema rigido V3, e li scrive nel nuovo foglio puliti.
//
// ⚠️ IMPORTANTE: aggiornare OLD_SPREADSHEET_ID prima di eseguire!

/**
 * ID del VECCHIO foglio DUBIOZZA.
 * Ricavalo dall'URL del vecchio Google Sheet.
 */
var OLD_SPREADSHEET_ID = '1mE5bpZaIhdFrjwhiJS_wsCfTEJ3PnAJuXm2RH80dSYg';

/**
 * Mappa i nomi dei fogli del vecchio spreadsheet ai nomi V3.
 * Se il vecchio foglio ha un nome diverso, aggiornalo qui.
 */
var MIGRATION_MAP = {
  'Timeline':   'Timeline',
  'Colonie':    'Colonie',
  'Clienti':    'Clienti',
  'Cessioni':   'Cessioni'
};

/**
 * Migra tutti i dati dal vecchio spreadsheet al nuovo.
 * Ogni riga viene passata attraverso lo schema rigido V3:
 * - I campi previsti vengono copiati
 * - I campi extra vengono ignorati
 * - I campi mancanti vengono riempiti con stringa vuota
 */
function migrateFromV2() {
  var oldSS, newSS;
  
  try {
    oldSS = SpreadsheetApp.openById(OLD_SPREADSHEET_ID);
  } catch (e) {
    Logger.log('❌ Impossibile aprire il vecchio foglio: ' + e.toString());
    Logger.log('   Controlla OLD_SPREADSHEET_ID: ' + OLD_SPREADSHEET_ID);
    return;
  }
  
  try {
    newSS = SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (e) {
    Logger.log('❌ Impossibile aprire il nuovo foglio: ' + e.toString());
    Logger.log('   Controlla SPREADSHEET_ID: ' + SPREADSHEET_ID);
    return;
  }
  
  var migrationKeys = Object.keys(MIGRATION_MAP);
  var totalMigrated = 0;
  var report = [];
  
  for (var m = 0; m < migrationKeys.length; m++) {
    var oldName = migrationKeys[m];
    var newName = MIGRATION_MAP[oldName];
    var schema = SCHEMAS[newName];
    
    if (!schema) {
      report.push('⚠️ Schema non trovato per: ' + newName + ' — saltato.');
      continue;
    }
    
    var oldSheet = oldSS.getSheetByName(oldName);
    if (!oldSheet) {
      report.push('⚠️ Foglio "' + oldName + '" non trovato nel vecchio spreadsheet — saltato.');
      continue;
    }
    
    // Assicurati che il foglio di destinazione esista con header
    ensureHeaders(newSS, newName);
    var newSheet = newSS.getSheetByName(newName);
    
    // Leggi dati dal vecchio foglio
    var oldData = readSheetAsObjects(oldSheet);
    if (oldData.length === 0) {
      report.push('ℹ️ ' + oldName + ': 0 righe — niente da migrare.');
      continue;
    }
    
    // Costruisci le righe secondo lo schema rigido V3
    var newRows = [];
    for (var r = 0; r < oldData.length; r++) {
      var oldRow = oldData[r];
      var newRow = [];
      
      // ── REGOLE DI TRASFORMAZIONE SPECIALI PER IL VECCHIO FOGLIO ──
      // Nel vecchio DUBIOZZA, l'evento si chiamava "id" anziché "event_id"
      if (newName === 'Timeline' && !oldRow.hasOwnProperty('event_id') && oldRow.hasOwnProperty('id')) {
        oldRow['event_id'] = oldRow['id'];
      }
      // Nel vecchio DUBIOZZA non c'era "event_type", assumiamo siano tutte pesate
      if (newName === 'Timeline' && !oldRow.hasOwnProperty('event_type') && oldRow.hasOwnProperty('total_weight')) {
        oldRow['event_type'] = 'pesata';
      }
      // I vecchi dati non hanno "is_deleted"
      if (!oldRow.hasOwnProperty('is_deleted')) {
        oldRow['is_deleted'] = 'FALSE';
      }
      
      for (var c = 0; c < schema.length; c++) {
        var key = schema[c];
        var val = oldRow.hasOwnProperty(key) ? oldRow[key] : '';
        if (val === undefined || val === null) val = '';
        newRow.push(sanitizeValue(val));
      }
      
      newRows.push(newRow);
    }
    
    // Scrivi in blocco nel nuovo foglio (molto più veloce di appendRow singolo)
    if (newRows.length > 0) {
      var startRow = newSheet.getLastRow() + 1;
      newSheet.getRange(startRow, 1, newRows.length, schema.length).setValues(newRows);
    }
    
    totalMigrated += newRows.length;
    report.push('✅ ' + newName + ': ' + newRows.length + ' righe migrate.');
  }
  
  // Report finale
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log('  D.U.B.I.A. MIGRAZIONE V2 → V3 COMPLETATA');
  Logger.log('══════════════════════════════════════════');
  for (var i = 0; i < report.length; i++) {
    Logger.log('  ' + report[i]);
  }
  Logger.log('──────────────────────────────────────────');
  Logger.log('  Totale righe migrate: ' + totalMigrated);
  Logger.log('══════════════════════════════════════════');
  
  // Invalida tutta la cache (i nuovi dati devono essere letti freschi)
  var cache = CacheService.getScriptCache();
  var sheetNames = Object.keys(SCHEMAS);
  for (var s = 0; s < sheetNames.length; s++) {
    cacheInvalidate(cache, 'sheet_' + sheetNames[s]);
  }
}
