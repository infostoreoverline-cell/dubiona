// ═══════════════════════════════════════════════════════════════
// D.U.B.I.A. — Google Apps Script Backend  (v2.0 — Perfected)
// ═══════════════════════════════════════════════════════════════
// Questo script gestisce la lettura e scrittura dei dati di
// D.U.B.I.A. su Google Sheets. Espone doGet e doPost come
// endpoint di una Web App.
//
// DEBUG: imposta su true per abilitare i log su Stackdriver.
// In produzione impostare su false per risparmiare quota di log.
var DEBUG = true;

// ──────────────────────────────────────────────────────────────
// Nomi dei fogli — fonte di verità unica (whitelist)
// ──────────────────────────────────────────────────────────────
var SHEET_NAMES = {
  TIMELINE:    'Timeline',
  CENSIMENTO:  'Censimento',
  PESATE:      'Pesate',
  PRELIEVI:    'Prelievi',
  CIBO:        'Cibo',
  CLIENTI:     'Clienti',
  COLONIE:     'Colonie'
};

// Set di nomi validi per la validazione rapida (Fix #9)
var VALID_SHEET_NAMES = {};
(function() {
  for (var k in SHEET_NAMES) {
    if (SHEET_NAMES.hasOwnProperty(k)) {
      VALID_SHEET_NAMES[SHEET_NAMES[k]] = true;
    }
  }
})();

// Event types che NON devono finire nella Timeline (Fix #3)
var SKIP_TIMELINE_EVENTS = {
  'colonia': true,
  'colonia_sync': true,
  'colonia_delete': true
};


// ══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────
// debugLog — Log condizionale, safe contro errori di serializzazione
// (Fix #6: try/catch su JSON.stringify per evitare crash su
//  oggetti anomali o circolari)
// ──────────────────────────────────────────────────────────────
function debugLog(label, value) {
  if (!DEBUG) return;
  try {
    Logger.log('[D.U.B.I.A.] ' + label + ': ' + JSON.stringify(value));
  } catch (e) {
    Logger.log('[D.U.B.I.A.] ' + label + ': [serializzazione fallita: ' + e.message + ']');
  }
}

// ──────────────────────────────────────────────────────────────
// convertCell — Converte un valore di cella GSheets in un tipo
// JS pulito e serializzabile in JSON.
//   Date   → "YYYY-MM-DD"  (rispetta il fuso orario dello script)
//   Number → Number
//   Bool   → Boolean
//   String → String (trimmed), o null se vuota
//   vuoto  → null
// (Fix #8: usa Utilities.formatDate per rispettare il fuso orario)
// ──────────────────────────────────────────────────────────────
function convertCell(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  // Google Sheets restituisce oggetti Date per le celle formattate data
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    // Usa il fuso orario dello script (impostato nelle proprietà del progetto)
    try {
      return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    } catch (e) {
      // Fallback manuale se Session non è disponibile (es. trigger)
      var y = value.getFullYear();
      var m = String(value.getMonth() + 1).padStart(2, '0');
      var d = String(value.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    }
  }

  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    var trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  return value;
}

// ──────────────────────────────────────────────────────────────
// isRowEmpty — Controlla se una riga è completamente vuota
// ──────────────────────────────────────────────────────────────
function isRowEmpty(row) {
  for (var i = 0; i < row.length; i++) {
    if (row[i] !== null && row[i] !== undefined && row[i] !== '') {
      return false;
    }
  }
  return true;
}

// ──────────────────────────────────────────────────────────────
// safeJsonParse — Wrapper attorno a JSON.parse con messaggio
// di errore esplicito per il client  (Fix #5)
// ──────────────────────────────────────────────────────────────
function safeJsonParse(rawString) {
  if (!rawString || typeof rawString !== 'string') {
    throw new Error('Il body della richiesta è vuoto o non è una stringa.');
  }
  try {
    return JSON.parse(rawString);
  } catch (e) {
    throw new Error('Il body della richiesta non contiene JSON valido. Dettaglio: ' + e.message);
  }
}

// ──────────────────────────────────────────────────────────────
// readSheet — Legge un foglio e restituisce un array di oggetti
// {chiave: valore}. Gestisce robustamente:
//   - Righe vuote (saltate)
//   - Colonne senza header (saltate)
//   - Conversioni di tipo
// (Fix #7: accetta ss come parametro per evitare chiamate ridondanti)
// ──────────────────────────────────────────────────────────────
function readSheet(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    debugLog('readSheet — foglio non trovato', sheetName);
    throw new Error("Foglio '" + sheetName + "' non trovato nel documento.");
  }

  var dataRange = sheet.getDataRange();
  var data = dataRange.getValues();

  debugLog('readSheet — foglio', sheetName);
  debugLog('readSheet — righe (con header)', data.length);
  debugLog('readSheet — colonne', data.length > 0 ? data[0].length : 0);

  if (data.length <= 1) {
    debugLog('readSheet — vuoto o solo header', sheetName);
    return [];
  }

  var headers = data[0];
  debugLog('readSheet — headers', headers);

  // Trova l'indice dell'ultima colonna con header non vuoto
  var lastValidHeaderIdx = -1;
  for (var h = 0; h < headers.length; h++) {
    if (headers[h] !== null && headers[h] !== undefined && String(headers[h]).trim() !== '') {
      lastValidHeaderIdx = h;
    }
  }

  if (lastValidHeaderIdx < 0) {
    debugLog('readSheet — nessun header valido', sheetName);
    return [];
  }

  var result = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];

    if (isRowEmpty(row)) continue;

    var rowData = {};
    var hasAtLeastOneValue = false;

    for (var j = 0; j <= lastValidHeaderIdx; j++) {
      var headerKey = String(headers[j]).trim();
      if (headerKey === '') continue;

      var rawValue = (j < row.length) ? row[j] : null;
      var convertedValue = convertCell(rawValue);

      rowData[headerKey] = convertedValue;

      if (convertedValue !== null) {
        hasAtLeastOneValue = true;
      }
    }

    if (hasAtLeastOneValue) {
      result.push(rowData);
    }
  }

  debugLog('readSheet — risultati per ' + sheetName, result.length);
  return result;
}


// ══════════════════════════════════════════════════════════════
// WRITE HELPERS
// ══════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────
// appendRowToSheet — Aggiunge una riga a un foglio.
// (Fix #2 e #4: espansione header dinamica)
//
// Se il foglio è vuoto, crea le intestazioni dal dato ricevuto.
// Se il foglio ha già header, e il dato contiene chiavi nuove
// non presenti negli header, aggiunge le nuove colonne a destra
// automaticamente. In questo modo nessun campo viene mai perso.
// ──────────────────────────────────────────────────────────────
function appendRowToSheet(ss, sheetName, data) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    debugLog('appendRowToSheet — foglio non trovato, ignorato', sheetName);
    return;
  }

  // Ottieni le chiavi del dato, escludendo 'event_type' (campo di routing, non dati)
  var dataKeys = Object.keys(data).filter(function(k) { return k !== 'event_type'; });

  var lastCol = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();
  var headers = [];

  if (lastCol === 0 || lastRow === 0) {
    // ── Foglio completamente vuoto: crea header da zero ─────────
    headers = dataKeys.slice(); // copia

    // Metti 'id' e 'date' per primi se presenti
    var priorityKeys = ['id', 'date'];
    priorityKeys.forEach(function(pk) {
      var idx = headers.indexOf(pk);
      if (idx > 0) {
        headers.splice(idx, 1);
        headers.unshift(pk);
      }
    });

    sheet.appendRow(headers);
    debugLog('appendRowToSheet — header creati per ' + sheetName, headers);
  } else {
    // ── Foglio con header esistenti ─────────────────────────────
    headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

    // Rimuovi header vuoti dalla coda
    while (headers.length > 0 && (headers[headers.length - 1] === null || headers[headers.length - 1] === '' || headers[headers.length - 1] === undefined)) {
      headers.pop();
    }

    // Converti a stringhe trimmate per confronto
    var headersNormalized = headers.map(function(h) { return String(h).trim(); });

    // ── Fix #4: Trova chiavi nel dato che mancano negli header ──
    var newKeys = [];
    dataKeys.forEach(function(key) {
      if (headersNormalized.indexOf(key) === -1) {
        newKeys.push(key);
      }
    });

    // Se ci sono nuove chiavi, espandi gli header nel foglio
    if (newKeys.length > 0) {
      var startCol = headers.length + 1;
      for (var nk = 0; nk < newKeys.length; nk++) {
        sheet.getRange(1, startCol + nk).setValue(newKeys[nk]);
        headers.push(newKeys[nk]);
      }
      debugLog('appendRowToSheet — nuove colonne aggiunte a ' + sheetName, newKeys);
    }
  }

  // Costruisci la riga rispettando l'ordine degli header (incluse le nuove colonne)
  var newRow = headers.map(function(header) {
    var key = String(header).trim();
    if (key === '') return '';
    var val = data[key];
    return (val !== undefined && val !== null) ? val : '';
  });

  debugLog('appendRowToSheet — riga su ' + sheetName, newRow);
  sheet.appendRow(newRow);
}

// ──────────────────────────────────────────────────────────────
// deleteRowsById — Elimina tutte le righe con un determinato
// id da un foglio. Scorre dal basso verso l'alto per non
// spostare gli indici delle righe.
// (Fix #12: null-safe — se targetId è falsy, esce subito)
// ──────────────────────────────────────────────────────────────
function deleteRowsById(ss, sheetName, targetId) {
  // Fix #12: protezione contro id vuoto/null/undefined
  if (targetId === null || targetId === undefined || String(targetId).trim() === '') {
    debugLog('deleteRowsById — id vuoto, operazione annullata', targetId);
    return 0;
  }

  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    debugLog('deleteRowsById — foglio non trovato', sheetName);
    return 0;
  }

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return 0; // Solo header o vuoto

  // Trova l'indice della colonna 'id'
  var headers = data[0];
  var idColIndex = -1;
  for (var h = 0; h < headers.length; h++) {
    if (String(headers[h]).trim().toLowerCase() === 'id') {
      idColIndex = h;
      break;
    }
  }

  if (idColIndex < 0) {
    debugLog('deleteRowsById — colonna "id" non trovata in', sheetName);
    return 0;
  }

  var targetStr = String(targetId);
  var deletedCount = 0;

  // Scorre dal basso verso l'alto per evitare shift degli indici
  for (var i = data.length - 1; i >= 1; i--) {
    var rowId = data[i][idColIndex];
    if (String(rowId) === targetStr) {
      sheet.deleteRow(i + 1); // deleteRow è 1-indexed
      deletedCount++;
    }
  }

  debugLog('deleteRowsById — eliminate ' + deletedCount + ' righe da ' + sheetName + ' per id=' + targetId, null);
  return deletedCount;
}

// ──────────────────────────────────────────────────────────────
// buildJsonResponse — Costruisce la risposta JSON con MIME type
// ──────────────────────────────────────────────────────────────
function buildJsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ══════════════════════════════════════════════════════════════
// ENDPOINT: doGet
// ══════════════════════════════════════════════════════════════
// Parametri opzionali:
//   ?sheet=NomeFoglio   (default: Timeline)
//   ?action=listSheets  (restituisce la lista dei fogli)
//
// (Fix #9: valida sheetName contro la whitelist VALID_SHEET_NAMES)
// ──────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    var action = params.action || 'getData';
    var sheetName = params.sheet || SHEET_NAMES.TIMELINE;

    debugLog('doGet — action', action);
    debugLog('doGet — sheet', sheetName);

    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Azione speciale: lista dei fogli
    if (action === 'listSheets') {
      var sheets = ss.getSheets().map(function(s) { return s.getName(); });
      return buildJsonResponse({ status: 'success', sheets: sheets });
    }

    // Fix #9: Validazione nome foglio
    if (!VALID_SHEET_NAMES[sheetName]) {
      return buildJsonResponse({
        status: 'error',
        message: 'Foglio "' + sheetName + '" non è nella lista dei fogli autorizzati. Fogli validi: ' + Object.keys(VALID_SHEET_NAMES).join(', ')
      });
    }

    // Lettura dati
    var result = readSheet(ss, sheetName);

    return buildJsonResponse({
      status: 'success',
      sheet: sheetName,
      count: result.length,
      message: 'Dati recuperati con successo da "' + sheetName + '".',
      data: result
    });

  } catch (err) {
    Logger.log('[D.U.B.I.A. ERROR] doGet: ' + err.toString());
    return buildJsonResponse({ status: 'error', message: err.toString() });
  }
}


// ══════════════════════════════════════════════════════════════
// ENDPOINT: doPost
// ══════════════════════════════════════════════════════════════
// Il client invia un JSON con un campo 'event_type' che determina
// su quale foglio secondario salvare i dati.
//
// Routing:
//   pesata / nuovo_sangue  → Pesate + Timeline
//   cibo                   → Cibo + Timeline
//   prelievo               → Prelievi + Timeline
//   calibrazione           → Censimento + Timeline
//   colonia / colonia_sync → Colonie (UPSERT, NO Timeline)
//   colonia_delete         → Colonie (DELETE, NO Timeline)
// ──────────────────────────────────────────────────────────────
function doPost(e) {
  var risposta = { status: 'error', message: 'Richiesta non valida.' };

  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Nessun dato ricevuto nel body della richiesta POST.');
    }

    // Fix #5: parsing sicuro con messaggio chiaro
    var datiRicevuti = safeJsonParse(e.postData.contents);
    debugLog('doPost — datiRicevuti', datiRicevuti);

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var eventType = datiRicevuti['event_type'] || 'pesata';
    debugLog('doPost — eventType', eventType);

    // ══════════════════════════════════════════════════════════
    // ROUTING
    // ══════════════════════════════════════════════════════════

    // ── colonia_delete: elimina le righe con quell'id ─────────
    if (eventType === 'colonia_delete') {
      var deleteId = datiRicevuti['id'];
      if (!deleteId && deleteId !== 0) {
        throw new Error('colonia_delete richiede un campo "id" valido.');
      }
      var deleted = deleteRowsById(ss, SHEET_NAMES.COLONIE, deleteId);
      risposta = {
        status: 'success',
        message: 'Colonia id=' + deleteId + ' eliminata (' + deleted + ' righe rimosse dal foglio Colonie).'
      };
      debugLog('doPost — risposta delete', risposta);
      return buildJsonResponse(risposta);
    }

    // ── colonia / colonia_sync: UPSERT (Fix #1) ──────────────
    if (eventType === 'colonia' || eventType === 'colonia_sync') {
      var colonyId = datiRicevuti['id'];
      // Se l'id è presente, prima elimina le vecchie righe (= update)
      if (colonyId) {
        deleteRowsById(ss, SHEET_NAMES.COLONIE, colonyId);
        debugLog('doPost — UPSERT: vecchie righe eliminate per id=' + colonyId, null);
      }
      // Poi appende la riga aggiornata (= insert)
      appendRowToSheet(ss, SHEET_NAMES.COLONIE, datiRicevuti);
      risposta = {
        status: 'success',
        message: 'Colonia id=' + colonyId + ' salvata/aggiornata nel foglio Colonie.'
      };
      debugLog('doPost — risposta upsert', risposta);
      return buildJsonResponse(risposta);
    }

    // ── Tutti gli altri event_type ────────────────────────────
    var targetSheetName = null;

    if (eventType === 'cibo') {
      targetSheetName = SHEET_NAMES.CIBO;
    } else if (eventType === 'prelievo') {
      targetSheetName = SHEET_NAMES.PRELIEVI;
    } else if (eventType === 'calibrazione') {
      targetSheetName = SHEET_NAMES.CENSIMENTO;
    } else if (eventType === 'pesata' || eventType === 'nuovo_sangue') {
      targetSheetName = SHEET_NAMES.PESATE;
    }
    // event_type sconosciuto → va solo nella Timeline

    // Salva nella Timeline (Fix #3: skip per tutti gli event nella blacklist)
    if (!SKIP_TIMELINE_EVENTS[eventType]) {
      appendRowToSheet(ss, SHEET_NAMES.TIMELINE, datiRicevuti);
    }

    // Salva nel foglio secondario (se definito)
    if (targetSheetName) {
      appendRowToSheet(ss, targetSheetName, datiRicevuti);
    }

    risposta = {
      status: 'success',
      message: 'Dati salvati con successo nel foglio "' + (targetSheetName || SHEET_NAMES.TIMELINE) + '".'
    };
    debugLog('doPost — risposta', risposta);

  } catch (err) {
    Logger.log('[D.U.B.I.A. ERROR] doPost: ' + err.toString());
    risposta = { status: 'error', message: err.toString() };
  }

  return buildJsonResponse(risposta);
}
