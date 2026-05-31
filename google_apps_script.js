// ═══════════════════════════════════════════════════════════════
// D.U.B.I.A. — Google Apps Script Backend
// ═══════════════════════════════════════════════════════════════
// DEBUG: imposta su true per abilitare i log di Console (Stackdriver)
var DEBUG = true;

var SHEET_NAMES = {
  TIMELINE:    'Timeline',
  CENSIMENTO:  'Censimento',
  PESATE:      'Pesate',
  PRELIEVI:    'Prelievi',
  CIBO:        'Cibo',
  CLIENTI:     'Clienti',
  COLONIE:     'Colonie'
};

// ──────────────────────────────────────────────────────────────
// Helper: log condizionale
// ──────────────────────────────────────────────────────────────
function debugLog(label, value) {
  if (DEBUG) {
    Logger.log('[D.U.B.I.A. DEBUG] ' + label + ': ' + JSON.stringify(value));
  }
}

// ──────────────────────────────────────────────────────────────
// Helper: converte un valore di cella in un tipo JS corretto
//   - Date object  → stringa ISO  "YYYY-MM-DD"
//   - Number       → Number
//   - Boolean      → Boolean
//   - Stringa      → String (con trim)
//   - vuoto/null   → null
// ──────────────────────────────────────────────────────────────
function convertCell(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  // Google Sheets restituisce oggetti Date per le celle formattate come data
  if (value instanceof Date) {
    // Controlla che la data sia valida (non epoch 0)
    if (isNaN(value.getTime())) return null;
    // Formatta come YYYY-MM-DD (locale del foglio, ma usiamo UTC per sicurezza)
    var y = value.getFullYear();
    var m = String(value.getMonth() + 1).padStart(2, '0');
    var d = String(value.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  // Numero (intero o float)
  if (typeof value === 'number') {
    return value; // Mantieni come Number, non convertire in stringa
  }

  // Booleano
  if (typeof value === 'boolean') {
    return value;
  }

  // Stringa: ritorna il valore trimmed, o null se vuota
  if (typeof value === 'string') {
    var trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  return value;
}

// ──────────────────────────────────────────────────────────────
// Helper: controlla se una riga è completamente vuota
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
// Helper: legge un foglio e restituisce array di oggetti {chiave:valore}
// Gestisce robustamente righe parzialmente vuote e conversioni di tipo.
// ──────────────────────────────────────────────────────────────
function readSheet(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    debugLog('readSheet - foglio non trovato', sheetName);
    throw new Error("Foglio '" + sheetName + "' non trovato nel documento.");
  }

  // Usa getDataRange() che copre automaticamente tutte le celle con contenuto
  var dataRange = sheet.getDataRange();
  var data = dataRange.getValues();

  debugLog('readSheet - nome foglio', sheetName);
  debugLog('readSheet - righe totali (con header)', data.length);
  debugLog('readSheet - colonne totali', data.length > 0 ? data[0].length : 0);

  if (data.length <= 1) {
    debugLog('readSheet - foglio vuoto o solo header', sheetName);
    return [];
  }

  var headers = data[0];
  debugLog('readSheet - headers', headers);

  // Trova l'indice dell'ultima colonna header non vuota
  var lastValidHeaderIdx = -1;
  for (var h = 0; h < headers.length; h++) {
    if (headers[h] !== null && headers[h] !== undefined && String(headers[h]).trim() !== '') {
      lastValidHeaderIdx = h;
    }
  }

  if (lastValidHeaderIdx < 0) {
    debugLog('readSheet - nessun header valido trovato', sheetName);
    return [];
  }

  var result = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];

    // Salta righe completamente vuote
    if (isRowEmpty(row)) {
      debugLog('readSheet - riga vuota saltata', i + 1);
      continue;
    }

    var rowData = {};
    var hasAtLeastOneValue = false;

    for (var j = 0; j <= lastValidHeaderIdx; j++) {
      var headerKey = String(headers[j]).trim();
      if (headerKey === '') continue; // Salta colonne senza header

      var rawValue = (j < row.length) ? row[j] : null;
      var convertedValue = convertCell(rawValue);

      rowData[headerKey] = convertedValue;

      if (convertedValue !== null) {
        hasAtLeastOneValue = true;
      }
    }

    // Aggiunge la riga solo se ha almeno un campo valorizzato
    if (hasAtLeastOneValue) {
      result.push(rowData);
      debugLog('readSheet - riga ' + (i + 1) + ' processata', rowData);
    }
  }

  debugLog('readSheet - oggetti risultanti per ' + sheetName, result.length);
  return result;
}

// ──────────────────────────────────────────────────────────────
// doGet — Punto di ingresso per le richieste GET
// Parametro opzionale: ?sheet=NomeFoglio  (default: Timeline)
// Parametro opzionale: ?action=listSheets  per ottenere i nomi dei fogli
// ──────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    var action = params.action || 'getData';
    var sheetName = params.sheet || SHEET_NAMES.TIMELINE;

    debugLog('doGet - action', action);
    debugLog('doGet - sheetName', sheetName);

    // Azione speciale: restituisce la lista dei fogli disponibili
    if (action === 'listSheets') {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheets = ss.getSheets().map(function(s) { return s.getName(); });
      return buildJsonResponse({ status: 'success', sheets: sheets });
    }

    // Azione: lettura dati da un foglio specifico
    var result = readSheet(sheetName);

    var risposta = {
      status: 'success',
      sheet: sheetName,
      count: result.length,
      message: 'Dati recuperati con successo da "' + sheetName + '"',
      data: result
    };

    debugLog('doGet - risposta inviata, oggetti', result.length);
    return buildJsonResponse(risposta);

  } catch (err) {
    Logger.log('[D.U.B.I.A. ERROR] doGet: ' + err.toString());
    return buildJsonResponse({ status: 'error', message: err.toString() });
  }
}

// ──────────────────────────────────────────────────────────────
// doPost — Salva dati ricevuti dal client
// ──────────────────────────────────────────────────────────────
function doPost(e) {
  var risposta = { status: 'error', message: 'Richiesta non valida' };

  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Nessun dato ricevuto nel body della richiesta POST.');
    }

    var datiRicevuti = JSON.parse(e.postData.contents);
    debugLog('doPost - datiRicevuti', datiRicevuti);

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var eventType = datiRicevuti['event_type'] || 'pesata';
    debugLog('doPost - eventType', eventType);

    // ── Routing verso il foglio secondario appropriato ────────────────────
    var targetSheetName = null;

    if (eventType === 'cibo') {
      targetSheetName = SHEET_NAMES.CIBO;
    } else if (eventType === 'prelievo') {
      targetSheetName = SHEET_NAMES.PRELIEVI;
    } else if (eventType === 'calibrazione') {
      targetSheetName = SHEET_NAMES.CENSIMENTO;
    } else if (eventType === 'pesata' || eventType === 'nuovo_sangue') {
      targetSheetName = SHEET_NAMES.PESATE;
    } else if (eventType === 'colonia' || eventType === 'colonia_sync') {
      targetSheetName = SHEET_NAMES.COLONIE;
    } else if (eventType === 'colonia_delete') {
      // Gestione eliminazione: rimuovi tutte le righe con questo id dal foglio Colonie
      var deleteId = datiRicevuti['id'];
      if (deleteId) {
        deleteRowsById(ss, SHEET_NAMES.COLONIE, deleteId);
      }
      risposta = { status: 'success', message: 'Colonia ' + deleteId + ' eliminata dal foglio Colonie.' };
      debugLog('doPost - risposta', risposta);
      return buildJsonResponse(risposta);
    }

    // ── Salva su Timeline (per tutti tranne colonia/colonia_sync) ─────────
    if (eventType !== 'colonia' && eventType !== 'colonia_sync') {
      appendRowToSheet(ss, SHEET_NAMES.TIMELINE, datiRicevuti);
    }

    // ── Salva sul foglio secondario (se esiste) ───────────────────────────
    if (targetSheetName) {
      appendRowToSheet(ss, targetSheetName, datiRicevuti);
    }

    risposta = { status: 'success', message: 'Dati salvati con successo nel foglio "' + (targetSheetName || SHEET_NAMES.TIMELINE) + '".' };
    debugLog('doPost - risposta', risposta);

  } catch (err) {
    Logger.log('[D.U.B.I.A. ERROR] doPost: ' + err.toString());
    risposta = { status: 'error', message: err.toString() };
  }

  return buildJsonResponse(risposta);
}

// ──────────────────────────────────────────────────────────────
// Helper: aggiunge una riga a un foglio, creando gli header se necessario
// ──────────────────────────────────────────────────────────────
function appendRowToSheet(ss, sheetName, data) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    debugLog('appendRowToSheet - foglio non trovato', sheetName);
    return; // Foglio non esistente: ignora silenziosamente
  }

  var lastCol = sheet.getLastColumn();
  var headers = [];

  // Se il foglio è vuoto, crea le intestazioni dai campi del dato
  if (lastCol === 0 || sheet.getLastRow() === 0) {
    headers = Object.keys(data).filter(function(k) { return k !== 'event_type'; });
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
    debugLog('appendRowToSheet - header creati per ' + sheetName, headers);
  } else {
    headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    // Filtra header vuoti dalla fine
    while (headers.length > 0 && (headers[headers.length - 1] === null || headers[headers.length - 1] === '')) {
      headers.pop();
    }
  }

  // Costruisci la riga da aggiungere rispettando l'ordine degli header
  var newRow = headers.map(function(header) {
    var key = String(header).trim();
    if (key === '') return '';
    var val = data[key];
    return (val !== undefined && val !== null) ? val : '';
  });

  debugLog('appendRowToSheet - riga aggiunta su ' + sheetName, newRow);
  sheet.appendRow(newRow);
}
// ──────────────────────────────────────────────────────────────
// Helper: elimina tutte le righe con un determinato id da un foglio
// Scorre dal basso verso l'alto per non spostare gli indici
// ──────────────────────────────────────────────────────────────
function deleteRowsById(ss, sheetName, targetId) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return; // Solo header o vuoto

  var headers = data[0];
  var idColIndex = -1;
  for (var h = 0; h < headers.length; h++) {
    if (String(headers[h]).trim().toLowerCase() === 'id') {
      idColIndex = h;
      break;
    }
  }

  if (idColIndex < 0) {
    debugLog('deleteRowsById - colonna "id" non trovata in', sheetName);
    return;
  }

  var deletedCount = 0;
  // Scorre dal basso verso l'alto per evitare di spostare gli indici delle righe
  for (var i = data.length - 1; i >= 1; i--) {
    var rowId = data[i][idColIndex];
    // Confronto flessibile: il foglio potrebbe avere l'id come numero o stringa
    if (String(rowId) === String(targetId)) {
      sheet.deleteRow(i + 1); // deleteRow è 1-indexed
      deletedCount++;
    }
  }

  debugLog('deleteRowsById - righe eliminate da ' + sheetName + ' per id=' + targetId, deletedCount);
}

// ──────────────────────────────────────────────────────────────
// Helper: costruisce una risposta JSON con headers CORS
// ──────────────────────────────────────────────────────────────
function buildJsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ──────────────────────────────────────────────────────────────
// doOptions — Risponde alle richieste preflight CORS (OPTIONS)
// ──────────────────────────────────────────────────────────────
function doOptions(e) {
  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
}
