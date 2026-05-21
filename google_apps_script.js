function doGet(e) {
  // Configura la risposta iniziale (es. leggendo dai fogli Google)
  var risposta = { status: "success", message: "Dati recuperati con successo", data: [] };

  // Aggiungi qui la logica per leggere i dati dal tuo Google Sheet
  // ...

  // Ritorna l'output formattato come JSON (gestione base per Vercel/CORS)
  return ContentService.createTextOutput(JSON.stringify(risposta))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var risposta = { status: "error", message: "Richiesta non valida" };

  try {
    // Se i dati vengono inviati come JSON nel body della richiesta
    if (e.postData && e.postData.contents) {
      var datiRicevuti = JSON.parse(e.postData.contents);

      // Aggiungi qui la logica per scrivere i dati nel tuo Google Sheet
      // ...

      risposta = { status: "success", message: "Dati salvati con successo" };
    }
  } catch (err) {
    risposta = { status: "error", message: err.toString() };
  }

  // Ritorna l'output formattato come JSON
  return ContentService.createTextOutput(JSON.stringify(risposta))
    .setMimeType(ContentService.MimeType.JSON);
}

// Opzionale, ma spesso consigliato per la gestione preflight delle richieste CORS
function doOptions(e) {
  return ContentService.createTextOutput("")
    .setMimeType(ContentService.MimeType.TEXT);
}
