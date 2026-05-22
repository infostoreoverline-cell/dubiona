var MASTER_SHEET = 'Timeline';

function doGet(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MASTER_SHEET);
    if (!sheet) {
        throw new Error("Foglio 'Timeline' non trovato");
    }
    var data = sheet.getDataRange().getValues();

    if (data.length <= 1) {
      return ContentService.createTextOutput(JSON.stringify({ status: "success", data: [] }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var headers = data[0];
    var result = [];

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var rowData = {};
      for (var j = 0; j < headers.length; j++) {
        rowData[headers[j]] = row[j];
      }
      result.push(rowData);
    }

    var risposta = { status: "success", message: "Dati recuperati con successo", data: result };

    return ContentService.createTextOutput(JSON.stringify(risposta))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    var errore = { status: "error", message: err.toString() };
    return ContentService.createTextOutput(JSON.stringify(errore))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  var risposta = { status: "error", message: "Richiesta non valida" };

  try {
    if (e.postData && e.postData.contents) {
      var datiRicevuti = JSON.parse(e.postData.contents);
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var masterSheet = ss.getSheetByName(MASTER_SHEET);

      if (!masterSheet) {
          throw new Error("Foglio 'Timeline' non trovato");
      }

      var headers = masterSheet.getRange(1, 1, 1, masterSheet.getLastColumn()).getValues()[0];
      var newRow = [];

      for (var i = 0; i < headers.length; i++) {
        var header = headers[i];
        newRow.push(datiRicevuti[header] !== undefined ? datiRicevuti[header] : "");
      }

      var eventType = datiRicevuti['event_type'] || 'pesata'; // Default to pesata for retrocompatibility

      // Save to Timeline (MASTER_SHEET), except for 'calibrazione'
      if (eventType !== 'calibrazione') {
        masterSheet.appendRow(newRow);
      }

      // Secondary Sheets Routing
      var targetSheetName = null;

      if (eventType === 'cibo') {
          targetSheetName = 'Cibo';
      } else if (eventType === 'prelievo') {
          targetSheetName = 'Prelievi';
      } else if (eventType === 'calibrazione') {
          targetSheetName = 'Censimento';
      } else if (eventType === 'pesata' || eventType === 'nuovo_sangue') {
          targetSheetName = 'Pesate';
      }

      if (targetSheetName) {
          var targetSheet = ss.getSheetByName(targetSheetName);
          if (targetSheet) {
              // Get headers for the target sheet
              var targetHeaders = targetSheet.getRange(1, 1, 1, Math.max(1, targetSheet.getLastColumn())).getValues()[0];

              // If target sheet is completely empty, initialize it with master headers
              if (targetHeaders.length === 0 || (targetHeaders.length === 1 && targetHeaders[0] === "")) {
                  targetSheet.appendRow(headers);
                  targetHeaders = headers;
              }

              var targetNewRow = [];
              for (var k = 0; k < targetHeaders.length; k++) {
                  var th = targetHeaders[k];
                  targetNewRow.push(datiRicevuti[th] !== undefined ? datiRicevuti[th] : "");
              }
              targetSheet.appendRow(targetNewRow);
          }
      }

      risposta = { status: "success", message: "Dati salvati con successo" };
    }
  } catch (err) {
    risposta = { status: "error", message: err.toString() };
  }

  return ContentService.createTextOutput(JSON.stringify(risposta))
    .setMimeType(ContentService.MimeType.JSON);
}

function doOptions(e) {
  return ContentService.createTextOutput("")
    .setMimeType(ContentService.MimeType.TEXT);
}
