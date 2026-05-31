/* global Chart, QRCode, Html5QrcodeScanner, DUBIA */
/**
 * D.U.B.I.A. Engine - Dynamic Updating Biomass Inference Algorithm
 * 
 * NOTA: Le formule matematiche core (Feed-Forward, Back-Propagation,
 * Indice H, Diagnostica, Censimento) sono definite nel modulo separato
 * dubia_module.js e accessibili tramite window.DUBIA.
 * Questo file gestisce lo stato applicativo, il DB e la UI.
 */

// Constants & Configurations
const GAS_URL = "https://script.google.com/macros/s/AKfycbzdNCct1bZF4uUJgbt2vkTF5RWr_IxtYuArDyea3yeCTT2Fjw92g8GuIzY72egOscKm4g/exec";

// Tasso di apprendimento α per la discesa del gradiente
const ALPHA = 1e-6;

// Parametri di default (coincidono con le costanti del Teorema D.U.B.I.A.)
const DEFAULT_PARAMS = {
    theta1: 0.30,          // θ₁ iniziale: Resa Alimentazione
    theta2: 1.05,          // θ₂ iniziale: Crescita Naturale Neanidi
    mortalityRate: 1.5     // Mortalità Mensile (%)
};

// Soglie per l'Indice di Salute H = (θ₁ / θ₁*) × 100
const HEALTH_THRESHOLD_WARNING = 90;  // H >= 90% → Ottimale
const HEALTH_THRESHOLD_ALERT   = 75;  // H >= 75% e < 90% → Warning; H < 75% → Critico

// Proxy al modulo matematico (window.DUBIA da dubia_module.js)
// Fornisce un fallback sicuro se il modulo non è ancora caricato.
const D = () => (typeof DUBIA !== 'undefined' ? DUBIA : null);

// Demographic Mass Constants (in grams)
const MASS = {
    FEMALE: 2.5,
    MALE: 1.5,
    SUBADULT: 1.6,
    MEDIUM: 0.8,
    SMALL: 0.3,
    BABY: 0.1
};

// Prezzi di default per tipologia (modificabili dall'utente)
const DEFAULT_PRICES = {
    FEMALE: 0.50,
    MALE: 0.40,
    SUBADULT: 0.30,
    MEDIUM: 0.20,
    SMALL: 0.10,
    BABY: 0.05
};

// State
let appState = {
    measurements: [],
    params: { ...DEFAULT_PARAMS },
    charts: {},
    clients: [],
    cessioni: [],
    customPrices: { ...DEFAULT_PRICES },
    colonies: []
};

// --- DATABASE (IndexedDB) ---
const dbName = "DubiaDB";
// Versione 4: aggiunto store colonies
const dbVersion = 4;
let db;

const initDB = () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, dbVersion);

        request.onupgradeneeded = (event) => {
            db = event.target.result;
            const oldVersion = event.oldVersion;

            // Crea store misure se non esiste (v1+)
            if (!db.objectStoreNames.contains("measurements")) {
                db.createObjectStore("measurements", { keyPath: "id", autoIncrement: true });
            }
            // Crea store parametri se non esiste (v1+)
            if (!db.objectStoreNames.contains("parameters")) {
                db.createObjectStore("parameters", { keyPath: "id" });
            }
            // Crea store clienti se non esiste (v3+)
            if (!db.objectStoreNames.contains("clients")) {
                db.createObjectStore("clients", { keyPath: "id", autoIncrement: true });
            }
            // Crea store cessioni se non esiste (v3+)
            if (!db.objectStoreNames.contains("cessioni")) {
                db.createObjectStore("cessioni", { keyPath: "id", autoIncrement: true });
            }
            // Crea store colonie se non esiste (v4+)
            if (!db.objectStoreNames.contains("colonies")) {
                db.createObjectStore("colonies", { keyPath: "id", autoIncrement: true });
            }
            // Migration v1→v2: invalida i parametri salvati in modo che vengano
            // rivalidati al prossimo caricamento (reset a DEFAULT_PARAMS se fuori range)
            if (oldVersion === 1) {
                console.info('[D.U.B.I.A.] Migration v1→v2: params will be revalidated on next load.');
            }
            if (oldVersion < 3) {
                console.info('[D.U.B.I.A.] Migration v3: aggiunto store clients e cessioni.');
            }
            if (oldVersion < 4) {
                console.info('[D.U.B.I.A.] Migration v4: aggiunto store colonies.');
            }
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            loadInitialData().then(resolve);
        };

        request.onerror = (event) => {
            console.error("IndexedDB error:", event.target.error);
            reject(event.target.error);
        };
    });
};

/**
 * validateAndMigrateParams — Valida i parametri caricati da IndexedDB.
 *
 * Garantisce che theta1 e theta2 siano nei range fisici del Teorema D.U.B.I.A.
 * Se i valori sono fuori range (es. vecchi default 0.05 / 0.01), li resetta.
 *
 * @param {object} stored - Oggetto params caricato da IndexedDB
 * @returns {object} Params validati e pronti all'uso
 */
const validateAndMigrateParams = (stored) => {
    if (!stored || typeof stored !== 'object') return { ...DEFAULT_PARAMS };

    const THETA1_MIN = 0.01;  const THETA1_MAX = 2.0;
    const THETA2_MIN = 0.01;  const THETA2_MAX = 5.0;

    const theta1 = parseFloat(stored.theta1);
    const theta2 = parseFloat(stored.theta2);

    const theta1Valid = isFinite(theta1) && theta1 >= THETA1_MIN && theta1 <= THETA1_MAX;
    const theta2Valid = isFinite(theta2) && theta2 >= THETA2_MIN && theta2 <= THETA2_MAX;

    if (!theta1Valid || !theta2Valid) {
        console.warn(
            `[D.U.B.I.A.] Params fuori range: θ₁=${theta1}, θ₂=${theta2}. ` +
            `Reset a DEFAULT_PARAMS (θ₁=${DEFAULT_PARAMS.theta1}, θ₂=${DEFAULT_PARAMS.theta2}).`
        );
        return { ...DEFAULT_PARAMS };
    }

    return {
        ...DEFAULT_PARAMS,  // base con campi non-theta
        ...stored,          // sovrascrive con tutto il resto
        theta1,             // usa i valori validati
        theta2
    };
};

/**
 * rebuildParamsFromMeasurements — Ricostruisce theta1/theta2 riapplicando
 * tutte le backpropagation in sequenza sulle misure cloud.
 *
 * Questo garantisce che mobile e desktop abbiano SEMPRE lo stesso stato appreso,
 * indipendentemente da cosa c'è nel loro IndexedDB locale.
 *
 * @param {Array} measurements - Lista ordinata per data
 * @returns {{ theta1: number, theta2: number }}
 */
const rebuildParamsFromMeasurements = (measurements) => {
    const dubiaModule = D();
    let theta1 = DEFAULT_PARAMS.theta1;
    let theta2 = DEFAULT_PARAMS.theta2;

    for (let i = 1; i < measurements.length; i++) {
        const prev = measurements[i - 1];
        const curr = measurements[i];

        const d1 = new Date(prev.date);
        const d2 = new Date(curr.date);
        const delta_g = Math.max(1, (d2 - d1) / (1000 * 60 * 60 * 24));

        const adultRatio = curr.adult_ratio || 0.35;
        const foodAmount = curr.food_amount || 0;

        const W_pred = dubiaModule
            ? dubiaModule.feedForward(prev.total_weight, foodAmount, adultRatio, delta_g, theta1, theta2)
            : prev.total_weight + (theta1 * foodAmount) + (theta2 * prev.total_weight * (1 - adultRatio) * (delta_g / 30));

        const bp = dubiaModule
            ? dubiaModule.backpropagate(theta1, theta2, W_pred, curr.total_weight, prev.total_weight, foodAmount, adultRatio, delta_g, ALPHA)
            : { theta1: theta1 - ALPHA * (W_pred - curr.total_weight) * foodAmount,
                theta2: theta2 - ALPHA * (W_pred - curr.total_weight) * prev.total_weight * (1 - adultRatio) * (delta_g / 30) };

        // Clamp per stabilità numerica
        theta1 = Math.max(0.001, Math.min(2.0, bp.theta1));
        theta2 = Math.max(0.001, Math.min(5.0, bp.theta2));
    }

    return { theta1, theta2 };
};

const loadInitialData = async () => {
    // ── STEP 1: Carica parametri da IndexedDB in modo SINCRONO (awaited) ──────
    // BUG FIX: il vecchio codice usava un callback non-awaited, causando race
    // condition con il fetch cloud che sovrascriveva i params a caso.
    const storedParams = await new Promise((resolve) => {
        const tx = db.transaction("parameters", "readonly");
        const store = tx.objectStore("parameters");
        const req = store.get(1);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror  = () => resolve(null);
    });

    // Valida i parametri: reset se fuori range D.U.B.I.A. (es. vecchi 0.05/0.01)
    appState.params = validateAndMigrateParams(storedParams);
    if (!storedParams) {
        saveParams(appState.params); // Prima volta: salva i default
    }

    console.info(`[D.U.B.I.A.] Params caricati: θ₁=${appState.params.theta1.toFixed(4)}, θ₂=${appState.params.theta2.toFixed(4)}`);

    // ── Carica prezzi personalizzati da IndexedDB ─────────────────────────
    const storedPrices = await new Promise((resolve) => {
        const tx = db.transaction("parameters", "readonly");
        const store = tx.objectStore("parameters");
        const req = store.get(2); // id=2 riservato ai prezzi
        req.onsuccess = () => resolve(req.result || null);
        req.onerror  = () => resolve(null);
    });
    if (storedPrices && storedPrices.prices) {
        appState.customPrices = { ...DEFAULT_PRICES, ...storedPrices.prices };
    }

    // ── Carica Clienti e Cessioni da IndexedDB ────────────────────────────
    await loadClientsAndCessioni();

    // ── Carica Colonie da IndexedDB e sincronizza dal Cloud ───────────────
    await loadColonies();
    await syncColoniesFromCloud();

    // ── STEP 2: Prova a caricare le misure dal Cloud ─────────────────────────
    try {
        showNotification("Sincronizzazione", "Download dati dal cloud...", "success");
        const response = await fetch(GAS_URL, { redirect: "follow" });

        if (!response.ok) {
            console.warn(`Cloud fetch returned HTTP ${response.status}.`);
            if (response.status === 401 || response.status === 403) {
                showNotification("Errore Cloud", "Accesso negato al Cloud. Verifica permessi o URL di Google Apps Script.", "error");
            } else if (response.status === 404) {
                showNotification("Errore Cloud", "URL Cloud non trovato.", "error");
            } else {
                showNotification("Offline", "Caricamento dati locali (errore server cloud).", "warning");
            }
        } else {
            const jsonResponse = await response.json();

            // ── DEBUG: stampa il JSON grezzo completo in transito ───────────────
            console.debug('[D.U.B.I.A. DEBUG] Risposta grezza GAS:', JSON.stringify(jsonResponse));

            if (jsonResponse && jsonResponse.status === "error") {
                showNotification("Errore Database Cloud", `Il server ha risposto: ${jsonResponse.message}.`, "alert");
                throw new Error("Cloud database error: " + jsonResponse.message);
            }

            const data = jsonResponse.data || jsonResponse;
            if (Array.isArray(data) && data.length > 0) {
                console.info(`[D.U.B.I.A.] Ricevuti ${data.length} record dal cloud. Avvio mapping...`);

                appState.measurements = data.map((m, idx) => {
                    // ── DEBUG: mostra ogni oggetto grezzo in transito ───────
                    console.debug(`[D.U.B.I.A. DEBUG] Record[${idx}] grezzo:`, JSON.stringify(m));

                    // Normalizza la data — accetta vari nomi di colonna
                    const rawDate = m.date || m['Data Reale'] || m['Date'] || null;

                    // Null-safe parseFloat: null dal GAS nuovo arriva come null,
                    // non come stringa vuota; parseFloat(null) === NaN quindi il
                    // fallback con || 0 funziona correttamente.
                    const totalWeight     = parseFloat(m.total_weight)     || parseFloat(m.Biomassa) || 0;
                    const foodAmount      = parseFloat(m.food_amount)      || 0;
                    const harvestAmount   = parseFloat(m.harvest_amount)   || 0;
                    const adultRatio      = (m.adult_ratio !== null && m.adult_ratio !== undefined)
                                              ? (parseFloat(m.adult_ratio) || 0) : 0;
                    const predictedWeight = parseFloat(m.predicted_weight) || 0;
                    // health_index=0 è valido, quindi usiamo 100 solo se il campo manca del tutto
                    const healthIndex     = (m.health_index !== null && m.health_index !== undefined)
                                              ? (parseFloat(m.health_index) || 0) : 100;
                    const isNewBlood      = m.is_new_blood === 'true' || m.is_new_blood === true;

                    const mapped = {
                        ...m,
                        date:             rawDate,
                        total_weight:     totalWeight,
                        food_amount:      foodAmount,
                        harvest_amount:   harvestAmount,
                        adult_ratio:      adultRatio,
                        predicted_weight: predictedWeight,
                        health_index:     healthIndex,
                        is_new_blood:     isNewBlood
                    };

                    // ── DEBUG: mostra l'oggetto dopo il mapping ─────────────
                    console.debug(`[D.U.B.I.A. DEBUG] Record[${idx}] mappato:`, JSON.stringify(mapped));
                    return mapped;
                })
                // Filtra record senza data valida per non rompere il sort
                .filter((m, idx) => {
                    if (!m.date) {
                        console.warn(`[D.U.B.I.A.] Record[${idx}] senza data scartato:`, JSON.stringify(m));
                        return false;
                    }
                    return true;
                })
                .sort((a, b) => new Date(a.date) - new Date(b.date));

                console.info(`[D.U.B.I.A.] ${appState.measurements.length} misure valide caricate dal cloud.`);
                if (appState.measurements.length > 0) {
                    console.debug('[D.U.B.I.A. DEBUG] Prima misura finale:', JSON.stringify(appState.measurements[0]));
                    console.debug('[D.U.B.I.A. DEBUG] Ultima misura finale:', JSON.stringify(appState.measurements[appState.measurements.length - 1]));
                }

                // ── STEP 3: Ricostruisce theta1/theta2 dalle misure cloud ─────
                // Questo è il fix principale della divergenza mobile/desktop:
                // i parametri appresi vengono ricalcolati deterministicamente
                // dal log delle misure, che è lo stesso su tutti i device.
                if (appState.measurements.length > 1) {
                    const rebuilt = rebuildParamsFromMeasurements(appState.measurements);
                    appState.params.theta1 = rebuilt.theta1;
                    appState.params.theta2 = rebuilt.theta2;
                    saveParams(appState.params); // Persistiamo localmente
                    console.info(
                        `[D.U.B.I.A.] Params ricostruiti da ${appState.measurements.length} misure cloud: ` +
                        `θ₁=${rebuilt.theta1.toFixed(6)}, θ₂=${rebuilt.theta2.toFixed(6)}`
                    );
                }

                showNotification("Sincronizzazione", "Dati cloud caricati con successo.", "success");
                return;
            } else {
                console.info('[D.U.B.I.A.] Il cloud ha restituito 0 record (foglio vuoto o solo header).');
            }
        }
    } catch (e) {
        console.warn("Could not fetch from GAS, falling back to local DB.", e);
        if (!navigator.onLine) {
            showNotification("Offline", "Nessuna connessione a Internet. Caricamento dati locali.", "warning");
        } else if (!e.message || !e.message.includes("Cloud database error")) {
            showNotification("Errore di Rete", "Impossibile contattare il server cloud. Caricamento dati locali.", "warning");
        }
    }

    // ── STEP 4 (fallback): Carica misure da IndexedDB locale ─────────────────
    return new Promise((resolve) => {
        const measTx = db.transaction("measurements", "readonly");
        const measStore = measTx.objectStore("measurements");
        const measReq = measStore.getAll();

        measReq.onsuccess = () => {
            if (appState.measurements.length === 0) {
                appState.measurements = measReq.result.sort((a, b) => new Date(a.date) - new Date(b.date));
            }

            if (appState.measurements.length === 0) {
                showNotification("Nessun Dato Trovato", "Sia il Cloud che il Database locale sono vuoti. Clicca sul '+' per inserire la tua prima Rilevazione.", "warning");
            }

            resolve();
        };
    });
};


const saveParams = (params) => {
    const tx = db.transaction("parameters", "readwrite");
    const store = tx.objectStore("parameters");
    store.put({ id: 1, ...params });
};

// ═══════════════════════════════════════════════════
// CLIENTI & CESSIONI — CRUD
// ═══════════════════════════════════════════════════

/**
 * Carica tutti i clienti e le cessioni da IndexedDB.
 */
const loadClientsAndCessioni = () => {
    return new Promise((resolve) => {
        const tx = db.transaction(["clients", "cessioni"], "readonly");
        const clientsStore = tx.objectStore("clients");
        const cessioniStore = tx.objectStore("cessioni");

        const clientsReq = clientsStore.getAll();
        const cessioniReq = cessioniStore.getAll();

        let clientsDone = false;
        let cessioniDone = false;

        clientsReq.onsuccess = () => {
            appState.clients = clientsReq.result || [];
            clientsDone = true;
            if (clientsDone && cessioniDone) resolve();
        };
        cessioniReq.onsuccess = () => {
            appState.cessioni = (cessioniReq.result || []).sort((a, b) => new Date(b.data) - new Date(a.data));
            cessioniDone = true;
            if (clientsDone && cessioniDone) resolve();
        };
        clientsReq.onerror = () => { clientsDone = true; if (clientsDone && cessioniDone) resolve(); };
        cessioniReq.onerror = () => { cessioniDone = true; if (clientsDone && cessioniDone) resolve(); };
    });
};

/**
 * Salva un nuovo cliente o aggiorna uno esistente in IndexedDB.
 * Se client.id è undefined, viene creato (autoIncrement).
 */
const saveClient = (client) => {
    return new Promise((resolve) => {
        const tx = db.transaction("clients", "readwrite");
        const store = tx.objectStore("clients");
        const req = store.put(client);
        req.onsuccess = (e) => {
            if (!client.id) client.id = e.target.result;
            // Aggiorna array in memoria
            const idx = appState.clients.findIndex(c => c.id === client.id);
            if (idx >= 0) appState.clients[idx] = client;
            else appState.clients.push(client);
            resolve(client);
        };
        req.onerror = () => resolve(null);
    });
};

/**
 * Elimina un cliente e tutte le sue cessioni.
 */
const deleteClient = (id) => {
    return new Promise((resolve) => {
        const tx = db.transaction(["clients", "cessioni"], "readwrite");
        const clientsStore = tx.objectStore("clients");
        const cessioniStore = tx.objectStore("cessioni");

        clientsStore.delete(Number(id));
        appState.clients = appState.clients.filter(c => c.id !== Number(id));

        // Rimuovi anche le cessioni associate
        const cessioniReq = cessioniStore.getAll();
        cessioniReq.onsuccess = () => {
            const toDelete = (cessioniReq.result || []).filter(c => c.cliente_id === Number(id));
            toDelete.forEach(c => cessioniStore.delete(c.id));
            appState.cessioni = appState.cessioni.filter(c => c.cliente_id !== Number(id));
            resolve();
        };
    });
};

/**
 * Salva una nuova cessione in IndexedDB.
 */
const saveCessione = (cessione) => {
    return new Promise((resolve) => {
        const tx = db.transaction("cessioni", "readwrite");
        const store = tx.objectStore("cessioni");
        const req = store.add(cessione);
        req.onsuccess = (e) => {
            cessione.id = e.target.result;
            appState.cessioni.unshift(cessione); // più recente in cima
            resolve(cessione);
        };
        req.onerror = () => resolve(null);
    });
};

/**
 * Elimina una cessione per id.
 */
const deleteCessione = (id) => {
    return new Promise((resolve) => {
        const tx = db.transaction("cessioni", "readwrite");
        const store = tx.objectStore("cessioni");
        store.delete(Number(id));
        appState.cessioni = appState.cessioni.filter(c => c.id !== Number(id));
        resolve();
    });
};

/**
 * Salva i prezzi personalizzati in IndexedDB (store parameters, id=2).
 */
const savePrices = (prices) => {
    appState.customPrices = { ...prices };
    const tx = db.transaction("parameters", "readwrite");
    const store = tx.objectStore("parameters");
    store.put({ id: 2, prices });
};

// ═══════════════════════════════════════════════════
// UI CLIENTI
// ═══════════════════════════════════════════════════

/**
 * Etichette e colori per tipo animale allevato.
 */
const ANIMAL_BADGES = {
    rettile:   { label: '🦎 Rettile',   color: '#27AE60' },
    anfibio:   { label: '🐸 Anfibio',   color: '#3498db' },
    uccello:   { label: '🦜 Uccello',   color: '#F2C94C' },
    mammifero: { label: '🐾 Mammifero', color: '#e67e22' },
    pesce:     { label: '🐟 Pesce',     color: '#1abc9c' },
    altro:     { label: '🐾 Altro',     color: '#95a5a6' }
};

/**
 * Etichette per tipo blatta nel form cessioni.
 */
const BLATTA_TYPES = [
    { value: 'FEMALE',   label: '🔴 Femmine Adulte (2.5g)',    mass: 2.5 },
    { value: 'MALE',     label: '🔵 Maschi Adulti (1.5g)',     mass: 1.5 },
    { value: 'SUBADULT', label: '🟡 Sub-Adulte (1.6g)',        mass: 1.6 },
    { value: 'MEDIUM',   label: '🟢 Neanidi Medie (0.8g)',     mass: 0.8 },
    { value: 'SMALL',    label: '⚪ Neanidi Piccole (0.3g)',   mass: 0.3 },
    { value: 'BABY',     label: '🟡 Micro-Neanidi (0.1g)',     mass: 0.1 }
];

/**
 * Aggiorna tutta la UI della sezione Clienti.
 * Chiamata dopo ogni modifica a clients/cessioni.
 */
const updateClientiUI = (filterClientId = null) => {
    const clients = appState.clients;
    const cessioni = appState.cessioni;

    // ── Stat Cards ───────────────────────────────────────────────────────────
    const totalGrammi = cessioni.reduce((sum, c) => sum + (parseFloat(c.quantita_g) || 0), 0);
    const totalEuro = cessioni.reduce((sum, c) => sum + (parseFloat(c.totale_euro) || 0), 0);

    const elClientiTot = document.getElementById('clientiTotali');
    const elCessioniTot = document.getElementById('cessioniTotali');
    const elGrammiTot = document.getElementById('grammiCeduti');
    const elEuroTot = document.getElementById('euroTotale');

    if (elClientiTot) elClientiTot.textContent = clients.length;
    if (elCessioniTot) elCessioniTot.textContent = cessioni.length;
    if (elGrammiTot) elGrammiTot.textContent = totalGrammi.toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' g';
    if (elEuroTot) elEuroTot.textContent = '€ ' + totalEuro.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // ── Lista Clienti ────────────────────────────────────────────────────────
    const listEl = document.getElementById('clientiList');
    if (!listEl) return;

    const searchVal = (document.getElementById('clientiSearch')?.value || '').toLowerCase();
    const filtered = clients.filter(c =>
        !searchVal ||
        (c.nome + ' ' + c.cognome).toLowerCase().includes(searchVal) ||
        (c.citta || '').toLowerCase().includes(searchVal) ||
        (c.animale || '').toLowerCase().includes(searchVal)
    );

    if (filtered.length === 0) {
        listEl.innerHTML = `
            <div class="clienti-empty">
                <span class="clienti-empty-icon">👥</span>
                <p>Nessun cliente trovato.</p>
                <p class="subtitle-text">Clicca su <strong>+ Nuovo Cliente</strong> per aggiungerne uno.</p>
            </div>`;
    } else {
        listEl.innerHTML = filtered.map(c => {
            const badge = ANIMAL_BADGES[c.animale] || ANIMAL_BADGES.altro;
            const cessioniCliente = cessioni.filter(ce => ce.cliente_id === c.id);
            const grammiCliente = cessioniCliente.reduce((s, ce) => s + (parseFloat(ce.quantita_g) || 0), 0);
            const ultimaCessione = cessioniCliente[0];
            return `
            <div class="client-card" data-id="${c.id}">
                <div class="client-card-header">
                    <div class="client-avatar">${(c.nome || '?')[0]}${(c.cognome || '')[0] || ''}</div>
                    <div class="client-info">
                        <div class="client-name">${c.nome} ${c.cognome}</div>
                        ${c.citta ? `<div class="client-location">📍 ${c.citta}</div>` : ''}
                    </div>
                    <span class="animal-badge" style="background: ${badge.color}22; color: ${badge.color}; border-color: ${badge.color}44;">${badge.label}</span>
                </div>
                <div class="client-contacts">
                    ${c.telefono ? `<a href="tel:${c.telefono}" class="client-contact-chip">📞 ${c.telefono}</a>` : ''}
                    ${c.email ? `<a href="mailto:${c.email}" class="client-contact-chip">✉️ ${c.email}</a>` : ''}
                </div>
                ${c.note ? `<div class="client-note">"${c.note}"</div>` : ''}
                <div class="client-card-footer">
                    <div class="client-stats">
                        <span class="client-stat"><strong>${cessioniCliente.length}</strong> cessioni · <strong>${grammiCliente.toFixed(0)} g</strong> ceduti</span>
                        ${ultimaCessione ? `<span class="client-stat-date">Ultima: ${ultimaCessione.data}</span>` : ''}
                    </div>
                    <div class="client-actions">
                        <button class="btn-standard btn-client-cessione" data-id="${c.id}" title="Registra cessione">📦 Cessione</button>
                        <button class="btn-standard btn-client-edit" data-id="${c.id}" title="Modifica cliente">✏️</button>
                        <button class="btn-standard btn-client-delete" data-id="${c.id}" title="Elimina cliente">🗑️</button>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    // ── Tabella Storico Cessioni ──────────────────────────────────────────────
    const tbody = document.querySelector('#cessioniTable tbody');
    if (!tbody) return;

    const cessioniToShow = filterClientId
        ? cessioni.filter(c => c.cliente_id === Number(filterClientId))
        : cessioni;

    // Aggiorna filtro dropdown
    const filterSelect = document.getElementById('cessioniFilterCliente');
    if (filterSelect) {
        const currentVal = filterSelect.value;
        filterSelect.innerHTML = '<option value="">Tutti i clienti</option>' +
            clients.map(c => `<option value="${c.id}" ${c.id == currentVal ? 'selected' : ''}>${c.nome} ${c.cognome}</option>`).join('');
    }

    if (cessioniToShow.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="table-empty">Nessuna cessione registrata.</td></tr>`;
        return;
    }

    tbody.innerHTML = cessioniToShow.map(c => {
        const cliente = clients.find(cl => cl.id === c.cliente_id);
        const nomeCliente = cliente ? `${cliente.nome} ${cliente.cognome}` : '—';
        const blattaType = BLATTA_TYPES.find(b => b.value === c.tipo_blatta);
        const blattaLabel = blattaType ? blattaType.label : c.tipo_blatta || '—';
        const nIndividui = blattaType && c.quantita_g ? Math.round(c.quantita_g / blattaType.mass) : '—';
        return `
        <tr>
            <td>${c.data}</td>
            <td><strong>${nomeCliente}</strong></td>
            <td>${blattaLabel}</td>
            <td>${parseFloat(c.quantita_g || 0).toFixed(1)} g
                ${nIndividui !== '—' ? `<br><small style="color:var(--text-muted)">≈ ${nIndividui} ind.</small>` : ''}
            </td>
            <td style="color: var(--accent-green);">€ ${parseFloat(c.totale_euro || 0).toFixed(2)}</td>
            <td style="max-width:150px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${c.note || ''}">${c.note || '—'}</td>
            <td>
                <button class="btn-standard btn-danger btn-delete-cessione" data-id="${c.id}" style="padding:0.2rem 0.5rem;font-size:0.8rem;">🗑️</button>
            </td>
        </tr>`;
    }).join('');
};

/**
 * Apre il modale cliente (in modalità aggiunta o modifica).
 * @param {object|null} client - null per nuova aggiunta, oggetto cliente per modifica
 */
const openClientModal = (client = null) => {
    const modal = document.getElementById('clientModal');
    if (!modal) return;
    const form = document.getElementById('clientForm');
    form.reset();
    document.getElementById('clientModalTitle').textContent = client ? 'Modifica Cliente' : 'Nuovo Cliente';
    document.getElementById('clientId').value = client?.id || '';
    if (client) {
        document.getElementById('clientNome').value = client.nome || '';
        document.getElementById('clientCognome').value = client.cognome || '';
        document.getElementById('clientCitta').value = client.citta || '';
        document.getElementById('clientTelefono').value = client.telefono || '';
        document.getElementById('clientEmail').value = client.email || '';
        document.getElementById('clientAnimale').value = client.animale || 'rettile';
        document.getElementById('clientNote').value = client.note || '';
    }
    modal.classList.add('active');
};

/**
 * Apre il modale cessione, pre-selezionando un cliente se fornito.
 */
const openCessioneModal = (clienteId = null) => {
    const modal = document.getElementById('cessioneModal');
    if (!modal) return;
    const form = document.getElementById('cessioneForm');
    form.reset();

    // Popola il select clienti
    const selectCliente = document.getElementById('cessioneCliente');
    selectCliente.innerHTML = '<option value="">— Seleziona cliente —</option>' +
        appState.clients.map(c =>
            `<option value="${c.id}" ${c.id == clienteId ? 'selected' : ''}>${c.nome} ${c.cognome}</option>`
        ).join('');

    // Data di oggi
    document.getElementById('cessioneData').valueAsDate = new Date();

    // Popola select tipo blatta
    const selectTipo = document.getElementById('cessioneTipo');
    selectTipo.innerHTML = BLATTA_TYPES.map(b =>
        `<option value="${b.value}">${b.label}</option>`
    ).join('');

    // Aggiorna prezzo unitario default al cambio tipo
    const updatePrezzoUnitario = () => {
        const tipo = selectTipo.value;
        const prezzo = appState.customPrices[tipo] || DEFAULT_PRICES[tipo] || 0;
        document.getElementById('cessionePrezzoUnit').value = prezzo.toFixed(2);
        updateCessioneTotale();
    };
    const updateCessioneTotale = () => {
        const q = parseFloat(document.getElementById('cessioneQuantita').value) || 0;
        const p = parseFloat(document.getElementById('cessionePrezzoUnit').value) || 0;
        const tipo = selectTipo.value;
        const blattaType = BLATTA_TYPES.find(b => b.value === tipo);
        const nInd = blattaType ? Math.round(q / blattaType.mass) : 0;
        const totale = q * p;
        document.getElementById('cessioneTotalePreview').textContent =
            `Totale: € ${totale.toFixed(2)} · ≈ ${nInd} individui`;
        document.getElementById('cessioneTotale').value = totale.toFixed(2);
    };

    selectTipo.onchange = updatePrezzoUnitario;
    document.getElementById('cessioneQuantita').oninput = updateCessioneTotale;
    document.getElementById('cessionePrezzoUnit').oninput = updateCessioneTotale;
    updatePrezzoUnitario();

    modal.classList.add('active');
};

/**
 * Apre il modale prezzi e popola i campi con i prezzi correnti.
 */
const openPrezziModal = () => {
    const modal = document.getElementById('prezziModal');
    if (!modal) return;
    BLATTA_TYPES.forEach(b => {
        const input = document.getElementById(`price_${b.value}`);
        if (input) input.value = (appState.customPrices[b.value] || DEFAULT_PRICES[b.value] || 0).toFixed(2);
    });
    updatePrezziPreview();
    modal.classList.add('active');
};

/**
 * Aggiorna il riquadro anteprima valore colonia nel modale prezzi.
 */
const updatePrezziPreview = () => {
    if (appState.measurements.length === 0) return;
    const latest = appState.measurements[appState.measurements.length - 1];
    const lastAdultRatio = latest.adult_ratio || 0.35;
    const tempPrices = {};
    BLATTA_TYPES.forEach(b => {
        const input = document.getElementById(`price_${b.value}`);
        tempPrices[b.value] = parseFloat(input?.value) || 0;
    });
    const metrics = calculateColonyMetrics(latest.total_weight, lastAdultRatio, { ...appState.params, _tempPrices: tempPrices });
    // Calcola con i prezzi temporanei
    const { fCount, mCount, saCount, medCount, smCount, bCount } = metrics;
    const val = (fCount * tempPrices.FEMALE) + (mCount * tempPrices.MALE)
        + (saCount * tempPrices.SUBADULT) + (medCount * tempPrices.MEDIUM)
        + (smCount * tempPrices.SMALL) + (bCount * tempPrices.BABY);
    const previewEl = document.getElementById('prezziValoreColoniaPreview');
    if (previewEl) previewEl.textContent = `Valore Colonia stimato: € ${val.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const saveMeasurement = async (measurement) => {
    // Save to Google Sheets
    try {
        const response = await fetch(GAS_URL, {
            method: 'POST',
            redirect: 'follow',
            headers: {
                "Content-Type": "text/plain;charset=utf-8"
            },
            body: JSON.stringify(measurement)
        });

        if (!response.ok) {
            console.error(`Cloud save returned HTTP ${response.status}. Check GAS_URL and permissions.`);
            if (response.status === 401 || response.status === 403) {
                 showNotification("Errore Salvataggio Cloud", "Accesso negato. Dati salvati solo in locale.", "error");
            }
        } else {
            const result = await response.json();
            if (result && result.id) {
                measurement.id = result.id;
            }
        }
    } catch (e) {
        console.error("Failed to save to Cloud:", e);
        if (!navigator.onLine) {
            showNotification("Offline", "Nessuna connessione a Internet. Dati salvati in locale.", "warning");
        } else {
            showNotification("Errore di Rete", "Impossibile contattare il server Cloud (errore di rete). Dati salvati in locale.", "warning");
        }
    }

    // Still save locally
    return new Promise((resolve) => {
        const tx = db.transaction("measurements", "readwrite");
        const store = tx.objectStore("measurements");

        if (!measurement.id) measurement.id = new Date().getTime();

        const req = store.put(measurement);
        req.onsuccess = () => {
            appState.measurements.push(measurement);
            resolve(measurement);
        };
    });
};



// --- ML ENGINE (D.U.B.I.A.) ---

/**
 * FEED-FORWARD INFERENCE — delega al modulo dubia_module.js
 * 
 * Formula (da specifica):
 *   Ŵ_{t+1} = W_t + (θ₁ · C_t) + [θ₂ · (W_t · (1 − A_t)) · (Δg / 30)] − harvest
 * 
 * NOTA: usa A_t dinamico (NON il 65% fisso della vecchia implementazione).
 */
const calculatePrediction = (lastWeight, foodAmount, adultRatio, delta_g, params, harvestAmount = 0) => {
    const dubiaModule = D();
    if (dubiaModule) {
        // Usa la formula certificata dal modulo matematico
        return dubiaModule.feedForward(
            lastWeight, foodAmount, adultRatio,
            delta_g, params.theta1, params.theta2, harvestAmount
        );
    }
    // Fallback di sicurezza (non dovrebbe mai essere raggiunto)
    const W_neanidi = lastWeight * (1 - adultRatio);
    const w_pred = lastWeight
        + (params.theta1 * foodAmount)
        + (params.theta2 * W_neanidi * (delta_g / 30))
        - harvestAmount;
    return Math.max(0, w_pred);
};

/**
 * Calcola l'Indice di Salute H(t) = (θ₁ / θ₁*) × 100
 * 
 * Delegato al modulo matematico. Θ₁* = 0.30 (valore storico ottimale).
 */
const computeHealthIndex = (theta1) => {
    const dubiaModule = D();
    if (dubiaModule) return dubiaModule.healthIndex(theta1);
    return (theta1 / 0.30) * 100; // fallback
};

const processNewMeasurement = async (date, realWeight, foodAmount, adultRatio, notes, harvestAmount = 0, isNewBlood = false, isManualSubmit = false, eventType = 'pesata') => {
    const lastMeasurement = appState.measurements.length > 0 
        ? appState.measurements[appState.measurements.length - 1] 
        : null;

    let predictedWeight = realWeight; // Default if first time
    let healthIndex = 100;
    let delta_g = 30; // default for the first measurement if needed

    if (lastMeasurement) {
        const dataUltimaPesata = new Date(lastMeasurement.date);
        const dataTargetFutura = new Date(date);
        delta_g = Math.max(0, (dataTargetFutura - dataUltimaPesata) / (1000 * 60 * 60 * 24));

        predictedWeight = calculatePrediction(lastMeasurement.total_weight, foodAmount, adultRatio, delta_g, appState.params, harvestAmount);
        
        if (eventType === 'pesata' || eventType === 'calibrazione' || eventType === 'nuovo_sangue') {
            // ── RETROPROPAGAZIONE DELL'ERRORE ──────────────────────────────────
            // E = Ŵ_{t+1} − W_{reale}  (errore di predizione)

            if (isManualSubmit) {
                const dubiaModule = D();
                if (dubiaModule) {
                    // Usa le derivate parziali certificate dal modulo matematico:
                    //   θ₁_new = θ₁_old − α · E · C_t
                    //   θ₂_new = θ₂_old − α · E · [W_t · (1 − A_t) · (Δg / 30)]
                    const bp = dubiaModule.backpropagate(
                        appState.params.theta1,
                        appState.params.theta2,
                        predictedWeight,
                        realWeight,
                        lastMeasurement.total_weight,
                        foodAmount,
                        adultRatio,
                        delta_g,
                        ALPHA
                    );
                    appState.params.theta1 = bp.theta1;
                    appState.params.theta2 = bp.theta2;
                } else {
                    // Fallback: calcolo diretto con derivate parziali corrette
                    const E = predictedWeight - realWeight;
                    const W_t_prev = lastMeasurement.total_weight;
                    const At_prev  = adultRatio;
                    // ∂E/∂θ₁ = C_t
                    const newTheta1 = appState.params.theta1 - (ALPHA * E * foodAmount);
                    // ∂E/∂θ₂ = W_t · (1 − A_t) · (Δg / 30)
                    const grad2 = W_t_prev * (1 - At_prev) * (delta_g / 30);
                    const newTheta2 = appState.params.theta2 - (ALPHA * E * grad2);
                    appState.params.theta1 = Math.max(0.001, newTheta1);
                    appState.params.theta2 = Math.max(0.001, newTheta2);
                }
                saveParams(appState.params);
            }

            // ── INDICE DI SALUTE H(t) = (θ₁ / θ₁*) × 100 ─────────────────────
            // θ₁* = 0.30 (valore storico ottimale — NON il rapporto reale/predetto)
            healthIndex = computeHealthIndex(appState.params.theta1);

            checkHealthThresholds(healthIndex);
        } else {
            // For purely informational events (cibo, prelievo), we check if real weight was provided
            // (like when a prelievo is dynamically subtracting from the total).
            // se l'evento è un prelievo, il realWeight passato sarà già stato sottratto.
            // altrimenti per cibo teniamo il predicted.
            if (eventType === 'prelievo') {
                // Keep the realWeight passed into the function (which already had the harvest subtracted)
            } else {
                realWeight = predictedWeight;
            }
            healthIndex = lastMeasurement.health_index; // Maintain last health index
        }
    }

    const measurement = {
        date,
        total_weight: realWeight,
        food_amount: foodAmount,
        harvest_amount: harvestAmount,
        is_new_blood: isNewBlood,
        adult_ratio: adultRatio,
        notes,
        predicted_weight: predictedWeight,
        health_index: healthIndex,
        event_type: eventType
    };

    await saveMeasurement(measurement);
    updateUI();
};

const checkHealthThresholds = (healthIndex) => {
    if (healthIndex < HEALTH_THRESHOLD_ALERT) {
        showNotification("ALLARME CRITICO 🚨", `Indice H = ${healthIndex.toFixed(1)}% (< 75%). θ₁ è crollato. Rilevare causa: inbreeding, stress o carenza nutrizionale. Aprire la tab Diagnostica.`, "alert");
    } else if (healthIndex < HEALTH_THRESHOLD_WARNING) {
        showNotification("⚠️ Attenzione", `Indice H = ${healthIndex.toFixed(1)}% (< 90%). Monitorare θ₁ e θ₂. Aprire la tab Diagnostica.`, "warning");
    }
};

/**
 * Aggiorna il pannello di Diagnostica Differenziale nell'UI.
 * Viene chiamato dopo ogni aggiornamento dei parametri.
 */
const updateDiagnosticsPanel = () => {
    const dubiaModule = D();
    if (!dubiaModule) return;

    const { theta1, theta2 } = appState.params;
    const H = computeHealthIndex(theta1);
    const diagnostics = dubiaModule.differentialDiagnostics(theta1, theta2, H);

    const panel = document.getElementById('differentialDiagnosticsPanel');
    if (!panel) return;

    if (diagnostics.length === 0) {
        panel.innerHTML = `
            <div class="diag-ok">
                <span class="diag-icon">✅</span>
                <div>
                    <strong>Sistema Ottimale</strong>
                    <p>Tutti i parametri sono nei range nominali. Nessun intervento richiesto.</p>
                </div>
            </div>
        `;
        return;
    }

    panel.innerHTML = diagnostics.map(d => `
        <div class="diag-alert diag-${d.severity}">
            <h4>${d.title}</h4>
            <p class="diag-message">${d.message}</p>
            <p class="diag-suggestion">${d.suggestion}</p>
        </div>
    `).join('');
};

/**
 * calculateColonyMetrics — Funzione pura di calcolo (layout-agnostic).
 * 
 * Unico punto di verità per TUTTI i dati demografici, economici e di salute.
 * Non legge mai il DOM, non dipende dalla larghezza dello schermo.
 * Può essere chiamata da qualsiasi contesto (UI, grafico, tabella, mobile/desktop).
 * 
 * @param {number} W_t    - Biomassa totale reale (grammi)
 * @param {number} A_t    - Rapporto adulti [0..1]
 * @param {object} params - { theta1, theta2, manualCalibrations }
 * @returns {ColonyMetrics} Oggetto immutabile con tutti i valori calcolati
 */
const calculateColonyMetrics = (W_t, A_t, params) => {
    const dubiaModule = D();

    // ── Dati demografici dal Modulo 4 D.U.B.I.A. ────────────────────────────
    let censusData;
    if (dubiaModule) {
        censusData = dubiaModule.census(W_t, A_t);
    } else {
        // Fallback: stesse formule del modulo
        const W_adulti  = W_t * A_t;
        const W_neanidi = W_t * (1 - A_t);
        censusData = {
            W_adulti, W_neanidi,
            W_femmine:       W_adulti * 0.77,
            W_maschi:        W_adulti * 0.23,
            W_neanidi_medie: W_neanidi * 0.70,
            W_neanidi_baby:  W_neanidi * 0.30,
            N_femmine: Math.round(W_adulti * 0.77 / 2.5),
            N_maschi:  Math.round(W_adulti * 0.23 / 1.5),
            N_medie:   Math.round(W_neanidi * 0.70 / 0.8),
            N_baby:    Math.round(W_neanidi * 0.30 / 0.1),
            N_totale_adulti:  0, N_totale_neanidi: 0, N_totale: 0, sex_ratio: 0
        };
        censusData.N_totale_adulti  = censusData.N_femmine + censusData.N_maschi;
        censusData.N_totale_neanidi = censusData.N_medie + censusData.N_baby;
        censusData.N_totale         = censusData.N_totale_adulti + censusData.N_totale_neanidi;
        censusData.sex_ratio        = censusData.N_femmine > 0 ? censusData.N_maschi / censusData.N_femmine : 0;
    }

    // Applica calibrazioni manuali se presenti (sovrascrivono il Modulo 4)
    const calibs = (params && params.manualCalibrations) || {};
    const fCount   = calibs['FEMALE']   !== undefined ? calibs['FEMALE']   : censusData.N_femmine;
    const mCount   = calibs['MALE']     !== undefined ? calibs['MALE']     : censusData.N_maschi;
    const saCount  = calibs['SUBADULT'] !== undefined ? calibs['SUBADULT'] : 0;
    const medCount = calibs['MEDIUM']   !== undefined ? calibs['MEDIUM']   : censusData.N_medie;
    const smCount  = calibs['SMALL']    !== undefined ? calibs['SMALL']    : 0;
    const bCount   = calibs['BABY']     !== undefined ? calibs['BABY']     : censusData.N_baby;
    const totalCount = fCount + mCount + saCount + medCount + smCount + bCount;

    // ── Valore economico (usa prezzi personalizzati da appState) ───────────
    const prices = appState.customPrices || DEFAULT_PRICES;
    const economicValue = (fCount * prices.FEMALE) + (mCount * prices.MALE)
        + (saCount * prices.SUBADULT) + (medCount * prices.MEDIUM)
        + (smCount * prices.SMALL)   + (bCount   * prices.BABY);

    // ── Fabbisogno idrico ───────────────────────────────────────────────────
    const waterNeed = W_t * 0.035; // 3.5% del peso vivo al giorno

    // ── Indice H live ───────────────────────────────────────────────────────
    const H_live = (params && params.theta1)
        ? computeHealthIndex(params.theta1)
        : 100;

    // ── Timer maturazione (usa θ₂ come moltiplicatore di velocità) ──────────
    // θ₂ default = 1.05 → speed = 1.0; θ₂ = 2.10 → speed = 2.0 (crescita doppia)
    // Scaling: growthSpeed = θ₂ / θ₂_default = θ₂ / 1.05
    const theta2 = (params && params.theta2) || 1.05;
    const THETA2_DEFAULT = 1.05;
    const growthSpeed = Math.max(0.5, Math.min(3.0, theta2 / THETA2_DEFAULT));

    const maturStages = [
        { name: 'Micro-Neanidi',   count: bCount,   next: 'Neanidi Medie',  baseDays: 30 },
        { name: 'Neanidi Medie',   count: medCount,  next: 'Sub-Adulte',    baseDays: 40 },
        { name: 'Sub-Adulte',      count: saCount,   next: 'Adulte',        baseDays: 30 },
        { name: 'Neanidi Piccole', count: smCount,   next: 'Neanidi Medie', baseDays: 30 }
    ];
    maturStages.sort((a, b) => b.count - a.count);
    const peakStage = maturStages[0];
    const maturDays = Math.round(peakStage.baseDays / growthSpeed);
    const maturMessage = (peakStage.count > totalCount * 0.2)
        ? `Il picco attuale (${peakStage.name}) impiegherà circa ${maturDays} giorni per mutare in ${peakStage.next}. [θ₂=${theta2.toFixed(3)}]`
        : 'Distribuzione stabile. Nessun picco imminente rilevato.';

    return Object.freeze({
        // Censimento (da DUBIA.census)
        census: censusData,
        // Conteggi (con eventuale override calibrazioni manuali)
        fCount, mCount, saCount, medCount, smCount, bCount, totalCount,
        // Metriche derivate
        economicValue,
        waterNeed,
        H_live,
        // Timer maturazione
        maturMessage,
        maturDays,
        growthSpeed
    });
};

/**
 * Aggiorna la Tabella di Censimento Demografico nell'UI.
 * Riceve metrics pre-calcolate da calculateColonyMetrics().
 */
const updateCensusTable = (W_t, A_t, metricsOverride) => {
    const dubiaModule = D();
    const tbody = document.querySelector('#censusTable tbody');
    if (!tbody) return;

    let rows;
    if (dubiaModule) {
        const censusData = metricsOverride ? metricsOverride.census : dubiaModule.census(W_t, A_t);
        rows = dubiaModule.censusTable(censusData);
    } else {
        // Fallback: calcolo diretto
        const W_adulti  = W_t * A_t;
        const W_neanidi = W_t * (1 - A_t);
        rows = [
            { stage: 'Femmine Adulte',       mass_avg: '2.5g', proportion: 'A_t × S_f (77%)', N: Math.round(W_adulti * 0.77 / 2.5), biomassa_g: (W_adulti * 0.77).toFixed(1),  destinazione: 'Riproduttrici — mantenere' },
            { stage: 'Maschi Adulti',        mass_avg: '1.5g', proportion: 'A_t × S_m (23%)', N: Math.round(W_adulti * 0.23 / 1.5), biomassa_g: (W_adulti * 0.23).toFixed(1),  destinazione: 'Riproduttori — verificare sex ratio' },
            { stage: 'Neanidi Medie',        mass_avg: '0.8g', proportion: '(1−A_t) × 70%',   N: Math.round(W_neanidi * 0.70 / 0.8), biomassa_g: (W_neanidi * 0.70).toFixed(1), destinazione: 'Crescita — prelievo futuro' },
            { stage: 'Micro-Neanidi (Baby)', mass_avg: '0.1g', proportion: '(1−A_t) × 30%',   N: Math.round(W_neanidi * 0.30 / 0.1), biomassa_g: (W_neanidi * 0.30).toFixed(1), destinazione: 'Riserva — non prelevare' }
        ];
    }

    tbody.innerHTML = rows.map(r => {
        let destColor = 'var(--text-muted)';
        let destIcon  = '📊';
        if (r.destinazione.includes('Riproduttr')) { destColor = 'var(--accent-purple)'; destIcon = '🔴'; }
        if (r.destinazione.includes('prelievo'))   { destColor = 'var(--accent-green)';  destIcon = '✂️'; }
        if (r.destinazione.includes('Riserva'))    { destColor = '#f1c40f';              destIcon = '🛡️'; }
        if (r.destinazione.includes('sex ratio'))  { destColor = '#3498db';             destIcon = '⚖️'; }
        return `
            <tr>
                <td><strong>${r.stage}</strong>${r.mass_avg ? `<br><small style="color:var(--text-muted)">${r.mass_avg} media · ${r.proportion || ''}</small>` : ''}</td>
                <td class="census-n">${r.N.toLocaleString('it-IT')}</td>
                <td>${parseFloat(r.biomassa_g).toFixed(1)} g</td>
                <td style="color:${destColor}">${destIcon} ${r.destinazione}</td>
            </tr>
        `;
    }).join('');
};



const updateDoubleScenarioChart = (harvestAmount, simulatedFuture, days) => {
    if (!appState.charts.weight || !appState.measurements || appState.measurements.length === 0) return;

    const chart = appState.charts.weight;
    const latest = appState.measurements[appState.measurements.length - 1];

    // Normal Prediction
    const normalFuture = calculatePrediction(latest.total_weight, 0, latest.adult_ratio, days, appState.params);

    // Check if datasets exist for predictions
    let normalDataset = chart.data.datasets.find(d => d.label === 'Predizione Naturale (g)');
    let harvestDataset = chart.data.datasets.find(d => d.label === 'Simulazione Prelievo (g)');

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);
    const futureLabel = futureDate.toISOString().split('T')[0];

    // Remove existing future points from original datasets
    const baseLabels = appState.measurements.map(m => m.date);

    chart.data.labels = [...baseLabels, futureLabel];

    const baseRealData = appState.measurements.map(m => m.total_weight);
    const basePredData = appState.measurements.map(m => m.predicted_weight);

    chart.data.datasets[0].data = [...baseRealData, null];
    chart.data.datasets[1].data = [...basePredData, null];

    if (!normalDataset) {
        normalDataset = {
            label: 'Predizione Naturale (g)',
            data: [],
            borderColor: '#3498db',
            borderDash: [5, 5], // Tratteggiato
            borderWidth: 2,
            tension: 0
        };
        chart.data.datasets.push(normalDataset);
    } else {
        normalDataset.borderDash = [5, 5];
    }

    if (!harvestDataset) {
        harvestDataset = {
            label: 'Simulazione Prelievo (g)',
            data: [],
            borderColor: '#e74c3c',
            borderDash: [5, 5], // Tratteggiato
            borderWidth: 2,
            tension: 0
        };
        chart.data.datasets.push(harvestDataset);
    } else {
        harvestDataset.borderDash = [5, 5];
    }

    // Pad with nulls so line starts from latest point
    const padLength = baseLabels.length - 1;
    const nullArray = Array(padLength).fill(null);

    normalDataset.data = [...nullArray, latest.total_weight, normalFuture];

    // The harvest drops immediately, then grows
    const postHarvestWeight = Math.max(0, latest.total_weight - harvestAmount);
    harvestDataset.data = [...nullArray, postHarvestWeight, simulatedFuture];

    chart.update();
};

// --- UI UPDATES ---

const updateUI = () => {
    if (appState.measurements.length === 0) return;

    const latest = appState.measurements[appState.measurements.length - 1];

    // Future Prediction based on current slider
    const deltaGValue = parseInt(document.getElementById('deltaGSlider').value) || 30;
    // For future projection, use the latest real weight and average recent food amount (or assume 0 if not provided), and recent adult ratio. We'll just use a proxy of 0 food for natural growth prediction, or maybe assume linear food consumption. Let's assume natural growth for future projection (C_t = 0), or same as last.
    // The prompt says: riproporzionando il numero stimato di individui in base alla crescita volumetrica attesa.
    // We will use the last adult ratio.
    const lastAdultRatio = latest.adult_ratio || 0.35;
    // Assuming C_t = 0 for future pure growth, or last C_t? "riproporzionando il numero stimato... in base alla crescita volumetrica attesa alla fine dei giorni selezionati."
    // We'll use the deltaG to calculate the future pred.
    // W_t+1 = W_t + (theta1 * 0) + (theta2 * W_t * (1 - A_t) * (delta_g / 30))
    // To match the prompt: "Questo input deve sovrascrivere dinamicamente la variabile \Delta g nell'equazione di stato del Modulo 1"
    const futurePred = calculatePrediction(latest.total_weight, 0, lastAdultRatio, deltaGValue, appState.params);

    // Dashboard
    document.getElementById('realWeightValue').innerText = `${latest.total_weight.toFixed(1)} g`;
    document.getElementById('predWeightValue').innerText = `${futurePred.toFixed(1)} g`; // Show future pred instead of past? Or past predicted? The prompt says "La card del Peso Teorico Predetto". Let's show future pred.

    document.getElementById('theta1Value').innerText = appState.params.theta1.toFixed(4);
    document.getElementById('theta2Value').innerText = appState.params.theta2.toFixed(4);
    if (appState.params.mortalityRate !== undefined) {
        const mortInput = document.getElementById('inputMortality');
        if (mortInput && document.activeElement !== mortInput) {
            mortInput.value = appState.params.mortalityRate.toFixed(1);
        }
    }

    // Indice H corrente (ricalcolato sempre dai parametri live)
    const H_live = computeHealthIndex(appState.params.theta1);
    const healthEl = document.getElementById('healthValue');
    healthEl.innerText = `${H_live.toFixed(1)}%`;
    healthEl.className = 'health-value';
    if (H_live < HEALTH_THRESHOLD_ALERT) healthEl.classList.add('alert');
    else if (H_live < HEALTH_THRESHOLD_WARNING) healthEl.classList.add('warning');

    // Aggiorna anche la barra/label di stato H nell'header
    const healthIndicator = document.getElementById('healthIndicator');
    if (healthIndicator) {
        healthIndicator.className = 'health-indicator';
        if (H_live >= HEALTH_THRESHOLD_WARNING) {
            if (H_live >= HEALTH_THRESHOLD_WARNING && H_live < HEALTH_THRESHOLD_WARNING) {
                healthIndicator.classList.add('warning');
            }
        }
    }

    // FCR Calculation
    if (appState.measurements.length > 1) {
        let totalFood = 0;
        let totalWeightGain = 0;
        for (let i = 1; i < appState.measurements.length; i++) {
            const m = appState.measurements[i];
            const prev = appState.measurements[i-1];
            if (m.food_amount && m.total_weight > prev.total_weight) {
                totalFood += m.food_amount;
                totalWeightGain += (m.total_weight - prev.total_weight);
            }
        }
        if (totalWeightGain > 0) {
            const fcr = totalFood / totalWeightGain;
            document.getElementById('fcrValue').innerText = fcr.toFixed(2);
        } else {
            document.getElementById('fcrValue').innerText = "--";
        }
    } else {
        document.getElementById('fcrValue').innerText = "--";
    }

    // ── CALCOLO CENTRALIZZATO — un'unica chiamata pura, identica su ogni device ──
    // calculateColonyMetrics() NON legge il DOM, NON usa window.innerWidth.
    // I dati derivati (fCount, mCount, ecc.) vengono SEMPRE da questa funzione.
    const metrics = calculateColonyMetrics(
        latest.total_weight,
        lastAdultRatio,
        appState.params
    );

    const { fCount, mCount, saCount, medCount, smCount, bCount, totalCount } = metrics;

    // ── Valore economico e fabbisogno idrico ─────────────────────────────────
    const economicValueEl = document.getElementById('economicValueValue');
    if (economicValueEl) economicValueEl.innerText = `${metrics.economicValue.toFixed(2)} €`;

    const waterNeedEl = document.getElementById('waterNeedValue');
    if (waterNeedEl) waterNeedEl.innerText = `${metrics.waterNeed.toFixed(1)} g/giorno`;

    // ── Sex Ratio ─────────────────────────────────────────────────────────────
    if (fCount > 0) {
        const ratio = mCount / fCount;
        document.getElementById('sexRatioValue').innerText = `1 : ${(1/ratio).toFixed(1)}`;
        const statusEl = document.getElementById('sexRatioStatus');
        const cardEl = document.getElementById('sexRatioCard');

        if (ratio >= 0.2 && ratio <= 0.35) {
            statusEl.innerText = "Ottimale per la riproduzione (1:3 - 1:5).";
            statusEl.style.color = "var(--accent-green)";
            cardEl.style.borderColor = "var(--accent-green)";
            cardEl.style.backgroundColor = "rgba(39, 174, 96, 0.1)";
        } else if (ratio > 0.35) {
            statusEl.innerText = "Eccesso di maschi. Valutare la rimozione per evitare competizione/stress.";
            statusEl.style.color = "var(--alert-red)";
            cardEl.style.borderColor = "var(--alert-red)";
            cardEl.style.backgroundColor = "rgba(255, 71, 87, 0.1)";
        } else {
            statusEl.innerText = "Scarsità di maschi. Potrebbe ridurre la frequenza di accoppiamento.";
            statusEl.style.color = "#F2C94C";
            cardEl.style.borderColor = "#F2C94C";
            cardEl.style.backgroundColor = "rgba(242, 201, 76, 0.1)";
        }
    } else {
        document.getElementById('sexRatioValue').innerText = "--";
        document.getElementById('sexRatioStatus').innerText = "Dati insufficienti.";
    }



    // Harvest Simulator
    const harvestAmountInput = document.getElementById('harvestAmount');
    const harvestCategorySelect = document.getElementById('harvestCategory');
    const harvestCyclicCheckbox = document.getElementById('harvestCyclic');
    const msyWarning = document.getElementById('msyWarning');
    const harvestCountLabel = document.getElementById('harvestCountLabel');
    const harvestCountVal = document.getElementById('harvestCountVal');

    if (harvestAmountInput) {
        const updateHarvest = () => {



            let amount = parseFloat(harvestAmountInput.value) || 0;
            const category = harvestCategorySelect ? harvestCategorySelect.value : 'ALL';
            const isCyclic = harvestCyclicCheckbox ? harvestCyclicCheckbox.checked : false;
            const currentWeight = latest.total_weight;

            // Optional: calculate count based on category
            if (category !== 'ALL' && MASS[category]) {
                const count = Math.round(amount / MASS[category]);
                if (harvestCountLabel) {
                    harvestCountLabel.style.display = 'inline';
                    harvestCountVal.innerText = count;
                }
            } else {
                if (harvestCountLabel) harvestCountLabel.style.display = 'none';
            }

            // MSY & Simulation Logic
            const days = parseInt(document.getElementById('deltaGSlider').value) || 30;
            document.getElementById('harvestDaysLabel').innerText = days;

            // Calcolo impatto demografico se prelievo selettivo
            let simulatedAdultRatio = lastAdultRatio;
            if (category === 'FEMALE') {
                const newFemaleWeight = Math.max(0, currentWeight * lastAdultRatio * (fCount / (fCount + mCount + 0.1)) - amount);
                simulatedAdultRatio = Math.max(0.01, newFemaleWeight / (currentWeight - amount));
            } else if (category === 'MALE') {
                const oldMaleWeight = currentWeight * lastAdultRatio * (mCount / (fCount + mCount + 0.1));
                const newMaleWeight = Math.max(0, oldMaleWeight - amount);
                const femaleWeight = currentWeight * lastAdultRatio * (fCount / (fCount + mCount + 0.1));
                simulatedAdultRatio = Math.max(0.01, (femaleWeight + newMaleWeight) / (currentWeight - amount));
            } else if (category === 'SUBADULT' || category === 'MEDIUM' || category === 'SMALL' || category === 'BABY') {
                // Approximate ratio change if we pull out non-adults
                // Removing non-adults increases adult ratio slightly
                const remainingWeight = Math.max(1, currentWeight - amount);
                const adultWeight = currentWeight * lastAdultRatio;
                simulatedAdultRatio = Math.min(0.99, adultWeight / remainingWeight);
            }

            // Se prelievo ciclico, moltiplica l'amount per le settimane nel deltaG
            let totalSimulatedHarvest = amount;
            if (isCyclic) {
                const weeks = days / 7;
                totalSimulatedHarvest = amount * weeks;
            }

            const remainingWeight = Math.max(0, currentWeight - totalSimulatedHarvest);
            const simulatedFuture = calculatePrediction(remainingWeight, 0, simulatedAdultRatio, days, appState.params);

            document.getElementById('harvestFutureWeight').innerText = `${simulatedFuture.toFixed(1)} g`;

            // MSY Warning: Se il peso futuro è inferiore al peso corrente prima del prelievo, la colonia è in declino
            if (simulatedFuture < currentWeight && totalSimulatedHarvest > 0) {
                if (msyWarning) msyWarning.style.display = 'block';
            } else {
                if (msyWarning) msyWarning.style.display = 'none';
            }

            // Aggiorna Grafico Doppio Scenario
            updateDoubleScenarioChart(totalSimulatedHarvest, simulatedFuture, days);
        };

        if (!harvestAmountInput.dataset.listenerAttached) {
            harvestAmountInput.addEventListener('input', updateHarvest);
            if (harvestCategorySelect) harvestCategorySelect.addEventListener('change', updateHarvest);
            if (harvestCyclicCheckbox) harvestCyclicCheckbox.addEventListener('change', updateHarvest);
            document.getElementById('deltaGSlider').addEventListener('input', updateHarvest);
            document.getElementById('deltaGInput').addEventListener('input', updateHarvest);
            harvestAmountInput.dataset.listenerAttached = 'true';
        }

        // Suggeritore Ottimale
        const suggesterText = document.getElementById('optimalSuggesterText');
        if (suggesterText) {

            // Calcolo MSY (Maximum Sustainable Yield) a 30 gg
            // MSY = W_pred_naturale(30gg) - W_attuale
            const naturalGrowth30 = calculatePrediction(latest.total_weight, 0, lastAdultRatio, 30, appState.params);
            const msy30 = Math.max(0, naturalGrowth30 - latest.total_weight);
            const msyEl = document.getElementById('msyValueText');
            if (msyEl) {
                msyEl.innerText = `${msy30.toFixed(1)} g`;
            }

            let amount = parseFloat(harvestAmountInput.value) || 0;
            if (fCount === 0) fCount = 1;
            const ratio = mCount / fCount;
            if (ratio > 0.4) {
                let suggestedMales = amount > 0 ? Math.round(amount / MASS.MALE) : Math.round(mCount - (fCount * 0.3));
                if (suggestedMales > 0) {
                    suggesterText.innerText = `Rapporto maschi/femmine troppo alto (${ratio.toFixed(2)}). Per il tuo prelievo, ti conviene raccogliere circa ${suggestedMales} Maschi Adulti. Questo aiuterà a bilanciare il Rapporto Sessuale portandolo verso 1:3.`;
                } else {
                    suggesterText.innerText = `Rapporto maschi/femmine troppo alto (${ratio.toFixed(2)}). Si consiglia di prelevare Maschi Adulti per riequilibrare la colonia verso 1:3.`;
                }
            } else if (medCount + smCount > (saCount + fCount + mCount) * 2) {
                let suggestedNymphs = amount > 0 ? Math.round(amount / MASS.MEDIUM) : Math.round(medCount * 0.2);
                suggesterText.innerText = `Eccesso di Neanidi. Si consiglia un prelievo di circa ${suggestedNymphs} Neanidi Medie per evitare futuri colli di bottiglia spaziali (sovraffollamento).`;
            } else {
                suggesterText.innerText = `Colonia ben bilanciata. Prelievo generico raccomandato per mantenere stabile la piramide demografica.`;
            }
        }

        setTimeout(() => updateHarvest(), 0);
    }

    document.getElementById('countFemale').innerText = fCount;
    document.getElementById('countMale').innerText = mCount;
    document.getElementById('countSubAdult').innerText = saCount;
    document.getElementById('countMedium').innerText = medCount;
    document.getElementById('countSmall').innerText = smCount;
    document.getElementById('countBaby').innerText = bCount;

    // Bottleneck detection
    const alarmCard = document.getElementById('demographicAlarmCard');
    const alarmText = document.getElementById('demographicAlarmText');
    if (alarmCard && alarmText) {
        if (bCount < smCount * 0.5 && latest.total_weight > 50) {
            alarmCard.style.display = 'block';
            alarmText.innerText = "Allarme: Carenza drastica di Micro-Neanidi. Previsto vuoto demografico tra 2-3 mesi. Si avrà una carenza drastica di sub-adulti disponibili al prelievo.";
        } else if (saCount < fCount * 0.2 && fCount > 10) {
            alarmCard.style.display = 'block';
            alarmText.innerText = "Allarme: Pochissime Sub-Adulte. Rischio di calo riproduttivo imminente (mancato rimpiazzo adulte).";
        } else {
            alarmCard.style.display = 'none';
        }
    }

    // ── Timer di Maturazione (Δg dinamico, θ₂-driven) ───────────────────────
    const maturationCard = document.getElementById('maturationTimerCard');
    const maturationText = document.getElementById('maturationTimerText');
    if (maturationCard && maturationText) {
        maturationCard.style.display = 'block';
        maturationText.innerText = metrics.maturMessage;
    }

    // ── Barre di avanzamento piramide ────────────────────────────────────────
    document.getElementById('barFemale').style.width = `${(fCount/totalCount)*100 * 3}%`; // Multiplier for visual effect
    document.getElementById('barMale').style.width = `${(mCount/totalCount)*100 * 3}%`;
    document.getElementById('barSubAdult').style.width = `${(saCount/totalCount)*100 * 3}%`;
    document.getElementById('barMedium').style.width = `${(medCount/totalCount)*100 * 3}%`;
    document.getElementById('barSmall').style.width = `${(smCount/totalCount)*100 * 3}%`;
    document.getElementById('barBaby').style.width = `${(bCount/totalCount)*100 * 3}%`;

    // Update Census Chart (Modulo 4 — 4 stadi D.U.B.I.A., dati da metrics centralizzate)
    const ctxCensus = document.getElementById('censusChart');
    if (ctxCensus) {
        if (appState.charts.census) {
            appState.charts.census.destroy();
        }

        // I dati vengono da calculateColonyMetrics() già eseguita — nessun ricalcolo
        const cd = metrics.census;
        const chartLabels = [
            `Femmine (${metrics.fCount})`,
            `Maschi (${metrics.mCount})`,
            `Neanidi Medie (${metrics.medCount})`,
            `Baby (${metrics.bCount})`
        ];
        const chartData   = [metrics.fCount, metrics.mCount, metrics.medCount, metrics.bCount];
        const chartColors = ['#9b59b6', '#3498db', '#2ecc71', '#f1c40f'];

        appState.charts.census = new Chart(ctxCensus.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: chartLabels,
                datasets: [{
                    data: chartData,
                    backgroundColor: chartColors,
                    borderWidth: 0,
                    hoverOffset: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { top: 8, bottom: 8 } },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            color: 'white',
                            font: { size: 12 },
                            padding: 16,
                            usePointStyle: true,
                            pointStyleWidth: 10
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = total > 0 ? Math.round((context.raw / total) * 100) : 0;
                                return ` ${context.label}: ${pct}%`;
                            }
                        }
                    }
                }
            }
        });
    }

    // History Table
    const tbody = document.querySelector('#historyTable tbody');
    tbody.innerHTML = '';
    // Reverse to show newest first
    const reversedMeasurements = [...appState.measurements].reverse();
    reversedMeasurements.forEach((m, index) => {
        const foodDisplay = m.food_amount !== undefined ? m.food_amount.toFixed(1) : '-';

        let fcrDisplay = '-';
        // Previous measurement is at index + 1 in the reversed array
        if (index + 1 < reversedMeasurements.length) {
            const prev = reversedMeasurements[index + 1];
            if (m.food_amount !== undefined && m.total_weight > prev.total_weight) {
                const fcr = m.food_amount / (m.total_weight - prev.total_weight);
                fcrDisplay = fcr.toFixed(2);
            }
        }

        const row = document.createElement('tr');
        const isNewBlood = m.is_new_blood ? '🩸 ' : '';
        row.innerHTML = `
            <td>${isNewBlood}${m.date}</td>
            <td>${m.total_weight.toFixed(1)}</td>
            <td>${foodDisplay}</td>
            <td style="color: var(--alert-red);">${m.harvest_amount ? '-' + m.harvest_amount.toFixed(1) : '0.0'}</td>
            <td>${fcrDisplay}</td>
            <td style="color: ${m.health_index < 75 ? 'var(--alert-red)' : 'var(--accent-green)'}">
                ${m.health_index.toFixed(1)}%
            </td>
            <td style="max-width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${m.notes || ''}">
                ${m.notes || '-'}
            </td>
            <td>
                <button class="btn-standard btn-danger btn-delete-row" data-id="${m.id}" style="padding: 0.2rem 0.5rem; font-size: 0.8rem; background-color: var(--alert-red);">X</button>
            </td>
        `;
        if (m.is_new_blood) row.style.backgroundColor = 'rgba(155, 89, 182, 0.1)';

        tbody.appendChild(row);
    });


    // Harvest History Table
    const harvestTbody = document.querySelector('#harvestHistoryTable tbody');
    if (harvestTbody) {
        harvestTbody.innerHTML = '';
        reversedMeasurements.forEach((m) => {
            if (m.harvest_amount > 0) {
                const hRow = document.createElement('tr');
                hRow.innerHTML = `
                    <td>${m.date}</td>
                    <td style="color: var(--alert-red);">${m.harvest_amount.toFixed(1)}</td>
                    <td style="max-width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${m.notes || ''}">${m.notes || '-'}</td>
                    <td>
                        <button class="btn-standard btn-danger btn-delete-row" data-id="${m.id}" style="padding: 0.2rem 0.5rem; font-size: 0.8rem; background-color: var(--alert-red);">X</button>
                    </td>
                `;
                harvestTbody.appendChild(hRow);
            }
        });
    }

    // Aggiorna Diagnostica Differenziale
    updateDiagnosticsPanel();

    // Aggiorna Tabella Censimento Demografico (Modulo 4)
    const latestForCensus = appState.measurements[appState.measurements.length - 1];
    if (latestForCensus) {
        // ── Tabella Censimento (usa metrics già calcolate — zero ricalcoli) ──────
    updateCensusTable(
        latestForCensus.total_weight,
        latestForCensus.adult_ratio || 0.35,
        metrics
    );

    }

    // Aggiorna il Pregnant Ratio — usa metrics.census già calcolate (zero ricalcoli)
    if (appState.measurements.length > 1) {
        const curr = appState.measurements[appState.measurements.length - 1];
        const census = metrics.census;
        if (census && census.N_femmine > 0) {
            const deltaOverPred = curr.total_weight - (curr.predicted_weight || curr.total_weight);
            const maxExtra = census.N_femmine * 0.4;
            const pregnantPct = maxExtra > 0 ? Math.min(100, Math.max(0, (deltaOverPred / maxExtra) * 100)) : 0;
            const pregnantEl = document.getElementById('pregnantRatioValue');
            if (pregnantEl) pregnantEl.innerText = `${pregnantPct.toFixed(1)} %`;
        }
    }

    updateCharts();
};

const updateCharts = () => {
    const labels = appState.measurements.map(m => m.date.substring(5)); // Show MM-DD
    const realData = appState.measurements.map(m => m.total_weight);
    const predData = appState.measurements.map(m => m.predicted_weight);
    const healthData = appState.measurements.map(m => m.health_index);
    const notesData = appState.measurements.map(m => m.notes || '');

    if (appState.measurements.length > 0) {
        const latest = appState.measurements[appState.measurements.length - 1];
        const deltaGValue = parseInt(document.getElementById('deltaGSlider').value) || 30;
        const lastAdultRatio = latest.adult_ratio || 0.35;
        const futurePred = calculatePrediction(latest.total_weight, 0, lastAdultRatio, deltaGValue, appState.params);

        // Add future projected point
        const futureDate = new Date(latest.date);
        futureDate.setDate(futureDate.getDate() + deltaGValue);
        const futureDateStr = futureDate.toISOString().split('T')[0].substring(5);

        labels.push(futureDateStr + ' (Proj)');
        realData.push(null); // No real data for future
        predData.push(futurePred);
        notesData.push('Proiezione Futura');
    }

    // Chart.js global defaults
    Chart.defaults.color = '#94A3B8';
    Chart.defaults.font.family = 'Inter';

    // Weight Chart
    const ctxWeight = document.getElementById('weightChart').getContext('2d');
    if (appState.charts.weight) appState.charts.weight.destroy();
    
    appState.charts.weight = new Chart(ctxWeight, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Peso Reale (g)',
                    data: realData,
                    borderColor: '#27AE60',
                    backgroundColor: 'rgba(39, 174, 96, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true
                },
                {
                    label: 'Peso Teorico (g)',
                    data: predData,
                    borderColor: '#8E44AD',
                    borderDash: [5, 5],
                    borderWidth: 2,
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            if (context.parsed.y !== null) {
                                label += context.parsed.y.toFixed(1) + ' g';
                            }
                            return label;
                        },
                        afterBody: function(tooltipItems) {
                            const dataIndex = tooltipItems[0].dataIndex;
                            let text = '';
                            if (notesData[dataIndex]) {
                                text += '\nNote: ' + notesData[dataIndex];
                            }
                            // Add extra information if available
                            return text;
                        }
                    }
                }
            },
            scales: {
                y: { grid: { color: 'rgba(255,255,255,0.05)' } },
                x: { grid: { display: false } }
            }
        }
    });

    // Health Chart
    // healthData usa l'H ricalcolato come (θ₁/θ₁*)×100 per ogni snapshot.
    // Per record storici che avevano H calcolato con la vecchia formula (reale/pred),
    // usiamo l'H live corrente per l'ultimo punto e i valori storici per i precedenti.
    const healthDataCorrected = appState.measurements.map((m, i) => {
        // Se è l'ultimo record, usa l'H live calcolato dai parametri aggiornati
        if (i === appState.measurements.length - 1) {
            return computeHealthIndex(appState.params.theta1);
        }
        // Per record storici, l'H salvato potrebbe essere la vecchia formula;
        // normalizziamo: se H > 200 o < 0 è chiaramente sbagliato, usa 100.
        const h = m.health_index;
        return (h >= 0 && h <= 200) ? h : 100;
    });
    healthDataCorrected.push(null); // punto futuro senza health

    const hMin = Math.max(40, Math.min(...healthDataCorrected.filter(v => v !== null)) - 10);
    const hMax = Math.min(130, Math.max(...healthDataCorrected.filter(v => v !== null)) + 10);

    const ctxHealth = document.getElementById('healthChart').getContext('2d');
    if (appState.charts.health) appState.charts.health.destroy();

    appState.charts.health = new Chart(ctxHealth, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Indice Salute H (%)',
                    data: healthDataCorrected,
                    borderColor: '#3498db',
                    backgroundColor: 'rgba(52, 152, 219, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true,
                    spanGaps: false
                },
                // Linea soglia Warning (90%)
                {
                    label: 'Soglia Warning (90%)',
                    data: Array(labels.length).fill(90),
                    borderColor: '#F2C94C',
                    borderDash: [4, 4],
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false
                },
                // Linea soglia Critica (75%)
                {
                    label: 'Soglia Critica (75%)',
                    data: Array(labels.length).fill(75),
                    borderColor: '#C0292B',
                    borderDash: [4, 4],
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,   // ← obbligatorio per mobile-first
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: {
                        color: '#94A3B8',
                        font: { size: 11 },
                        filter: (item) => !item.text.includes('Soglia') || true
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            if (context.parsed.y === null) return null;
                            return `${context.dataset.label}: ${context.parsed.y.toFixed(1)}%`;
                        },
                        afterBody: function(tooltipItems) {
                            const dataIndex = tooltipItems[0].dataIndex;
                            if (notesData[dataIndex]) {
                                return '\nNote: ' + notesData[dataIndex];
                            }
                            return '';
                        }
                    }
                }
            },
            scales: {
                y: {
                    min: hMin,
                    max: hMax,
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { callback: v => v + '%' }
                },
                x: { grid: { display: false } }
            }
        }
    });
};


// --- EVENT LISTENERS & DOM LOGIC ---


const deleteMeasurement = async (id) => {
    return new Promise((resolve) => {
        const tx = db.transaction("measurements", "readwrite");
        const store = tx.objectStore("measurements");
        const req = store.delete(Number(id)); // ID is usually a number

        req.onsuccess = () => {
            appState.measurements = appState.measurements.filter(m => m.id !== Number(id));
            updateUI();
            showNotification("Eliminato", "La rilevazione è stata rimossa con successo.", "success");
            resolve();
        };

        req.onerror = () => {
            showNotification("Errore", "Impossibile eliminare il dato.", "alert");
            resolve();
        };
    });
};

document.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.btn-delete-row');
    if (deleteBtn) {
        const id = deleteBtn.getAttribute('data-id');

        // First Confirmation modal
        const confirmModal = document.createElement('div');
        confirmModal.className = 'modal-overlay active';
        confirmModal.innerHTML = `
            <div class="modal">
                <h2 style="color: var(--alert-red);">Conferma Eliminazione</h2>
                <p>Sei sicuro di voler eliminare questa singola rilevazione?</p>
                <div class="modal-actions">
                    <button type="button" class="btn-standard btn-cancel btnCancelDelRow">Annulla</button>
                    <button type="button" class="btn-standard btn-danger btnConfirmDelRow">Procedi</button>
                </div>
            </div>
        `;
        document.body.appendChild(confirmModal);

        confirmModal.querySelectorAll('.btn-cancel')[0].addEventListener('click', () => {
            document.body.removeChild(confirmModal);
        });

        confirmModal.querySelectorAll('.btn-danger')[0].addEventListener('click', () => {
            document.body.removeChild(confirmModal);

            // Double Confirmation modal
            const doubleConfirmModal = document.createElement('div');
            doubleConfirmModal.className = 'modal-overlay active';
            doubleConfirmModal.innerHTML = `
                <div class="modal">
                    <h2 style="color: var(--alert-red);">Ultimo Avviso</h2>
                    <p>Attenzione: l'eliminazione del dato è irreversibile e influenzerà le rilevazioni successive. Procedere comunque?</p>
                    <div class="modal-actions">
                        <button type="button" class="btn-standard btn-cancel">Non Eliminare</button>
                        <button type="button" class="btn-standard btn-danger">Si, Elimina Dato</button>
                    </div>
                </div>
            `;
            document.body.appendChild(doubleConfirmModal);

            doubleConfirmModal.querySelectorAll('.btn-cancel')[0].addEventListener('click', () => {
                document.body.removeChild(doubleConfirmModal);
            });

            doubleConfirmModal.querySelectorAll('.btn-danger')[0].addEventListener('click', async () => {
                document.body.removeChild(doubleConfirmModal);
                await deleteMeasurement(id);
            });
        });
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    const inputMortality = document.getElementById('inputMortality');
    if (inputMortality) {
        inputMortality.addEventListener('change', (e) => {
            appState.params.mortalityRate = parseFloat(e.target.value) || 1.5;
            saveParams(appState.params);
            updateUI();
        });
    }

    // Init DB
    try {
        await initDB();
        updateUI();
    } catch (e) {
        console.error("Failed to initialize app data", e);
    }

    // Load Maintenance Task State
    const tasks = ['taskCleaning', 'taskCartons', 'taskTreatments'];
    tasks.forEach(taskId => {
        const el = document.getElementById(taskId);
        if (el) {
            const savedState = localStorage.getItem(taskId);
            if (savedState === 'true') {
                el.checked = true;
            }
            el.addEventListener('change', (e) => {
                localStorage.setItem(taskId, e.target.checked);
            });
        }
    });

    // Tabs logic
    const tabs = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));
            
            tab.classList.add('active');
            document.getElementById(tab.dataset.target).classList.add('active');
        });
    });

    // Modal logic
    const modal = document.getElementById('entryModal');
    const fab = document.getElementById('fabAdd');
    const btnCancel = document.getElementById('btnCancelEntry');
    const form = document.getElementById('entryForm');

    const deltaGSlider = document.getElementById('deltaGSlider');
    const deltaGInput = document.getElementById('deltaGInput');

    // Sync slider and input for deltaG
    deltaGSlider.addEventListener('input', (e) => {
        deltaGInput.value = e.target.value;
        updateUI(); // Real-time recalculation
    });

    deltaGInput.addEventListener('input', (e) => {
        deltaGSlider.value = e.target.value;
        updateUI(); // Real-time recalculation
    });

    const presetBtns = document.querySelectorAll('.btn-preset');
    presetBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const val = e.target.dataset.val;
            deltaGSlider.value = val;
            deltaGInput.value = val;
            updateUI();
        });
    });

    // Calibration logic
    const calibModal = document.getElementById('calibrationModal');
    const btnCalibrate = document.getElementById('btnCalibrate');
    const btnCancelCalib = document.getElementById('btnCancelCalib');
    const calibForm = document.getElementById('calibrationForm');

    if (btnCalibrate) {
        btnCalibrate.addEventListener('click', () => {
            if (appState.measurements.length === 0) {
                showNotification("Errore", "Nessun dato presente. Inserisci prima una pesata.", "alert");
                return;
            }
            calibModal.classList.add('active');
        });
    }

    if (btnCancelCalib) {
        btnCancelCalib.addEventListener('click', () => calibModal.classList.remove('active'));
    }

    if (calibForm) {
        calibForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const category = document.getElementById('calibCategory').value;
            const count = parseInt(document.getElementById('calibCount').value);

            const latest = appState.measurements[appState.measurements.length - 1];
            const currentWeight = latest.total_weight;

            // Calculate theoretical weight of the category
            const categoryWeight = count * MASS[category];

            // Re-calculate Adult Ratio if female or male
            let newAdultRatio = latest.adult_ratio;
            if (category === 'FEMALE' || category === 'MALE') {
                // If we know exactly how many females, we can force the ratio
                if (category === 'FEMALE') {
                    newAdultRatio = categoryWeight / currentWeight;
                }
                // Cap it to sane bounds
                newAdultRatio = Math.min(0.9, Math.max(0.1, newAdultRatio));
            }

            // Apply a slight bump to theta2 to simulate learning from manual intervention
            appState.params.theta2 = appState.params.theta2 * 1.05;

            if (!appState.params.manualCalibrations) {
                appState.params.manualCalibrations = {};
            }
            appState.params.manualCalibrations[category] = count;
            saveParams(appState.params);

            // Record a calibration event
            const todayDate = new Date().toISOString().split('T')[0];
            const catLabels = { FEMALE: 'Femmine Adulte', MALE: 'Maschi Adulti', SUBADULT: 'Sub-Adulte', MEDIUM: 'Neanidi Medie', SMALL: 'Neanidi Piccole', BABY: 'Micro-Neanidi' };
            await processNewMeasurement(
                todayDate,
                currentWeight,
                0, // 0 food for calibration event
                newAdultRatio,
                `[Calibrazione] Conteggio reale: ${count} ${catLabels[category] || category}`,
                0,
                false,
                false,
                'calibrazione'
            );

            calibModal.classList.remove('active');
            calibForm.reset();
            showNotification("Calibrazione Applicata", "I parametri demografici sono stati aggiornati.", "success");
        });
    }

    const adultRatioSlider = document.getElementById('inputAdultRatioSlider');
    const adultRatioInput = document.getElementById('inputAdultRatio');

    if (adultRatioSlider && adultRatioInput) {
        adultRatioSlider.addEventListener('input', (e) => {
            adultRatioInput.value = e.target.value;
        });
        adultRatioInput.addEventListener('input', (e) => {
            adultRatioSlider.value = e.target.value;
        });
    }

    // Set today's date as default
    document.getElementById('inputDate').valueAsDate = new Date();

    const inputType = document.getElementById('inputType');
    const groupWeight = document.getElementById('groupWeight');
    const groupFoodAmount = document.getElementById('groupFoodAmount');
    const groupHarvestAmount = document.getElementById('groupHarvestAmount');

    const updateFormVisibility = () => {
        const type = inputType.value;
        if (type === 'pesata') {
            groupWeight.style.display = 'block';
            groupFoodAmount.style.display = 'block';
            groupHarvestAmount.style.display = 'block';
            document.getElementById('inputWeight').required = true;
            document.getElementById('inputFoodAmount').required = false;
        } else if (type === 'cibo') {
            groupWeight.style.display = 'none';
            groupFoodAmount.style.display = 'block';
            groupHarvestAmount.style.display = 'none';
            document.getElementById('inputWeight').required = false;
            document.getElementById('inputFoodAmount').required = true;
        } else if (type === 'prelievo') {
            groupWeight.style.display = 'none';
            groupFoodAmount.style.display = 'none';
            groupHarvestAmount.style.display = 'block';
            document.getElementById('inputWeight').required = false;
            document.getElementById('inputFoodAmount').required = false;
        }
    };

    if (inputType) {
        inputType.addEventListener('change', updateFormVisibility);
        updateFormVisibility(); // Initialize
    }

    fab.addEventListener('click', () => {
        modal.classList.add('active');
        if (inputType) updateFormVisibility();
    });
    btnCancel.addEventListener('click', () => modal.classList.remove('active'));

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const eventType = inputType ? inputType.value : 'pesata';
        const date = document.getElementById('inputDate').value;
        const adultRatio = parseFloat(document.getElementById('inputAdultRatio').value);
        const notes = document.getElementById('inputNotes').value;

        const colonyIdVal = document.getElementById('inputColonyId')?.value;
        const colonyId = colonyIdVal ? Number(colonyIdVal) : null;

        let weight = 0;
        let foodAmount = 0;
        let harvestAmount = 0;

        if (eventType === 'pesata') {
            weight = parseFloat(document.getElementById('inputWeight').value);
            foodAmount = parseFloat(document.getElementById('inputFoodAmount').value) || 0;
            harvestAmount = parseFloat(document.getElementById('inputHarvestAmount')?.value) || 0;
        } else if (eventType === 'cibo') {
            foodAmount = parseFloat(document.getElementById('inputFoodAmount').value);
        } else if (eventType === 'prelievo') {
            harvestAmount = parseFloat(document.getElementById('inputHarvestAmount')?.value) || 0;
        }

        if (colonyId) {
            const colony = appState.colonies.find(c => c.id === colonyId);
            if (colony) {
                let oldWeight = colony.current_weight || 0;
                let deltaWeight = 0;
                
                if (eventType === 'pesata') {
                    deltaWeight = weight - oldWeight;
                    colony.current_weight = weight;
                } else if (eventType === 'prelievo') {
                    colony.current_weight = Math.max(0, oldWeight - harvestAmount);
                } else if (eventType === 'cibo') {
                    colony.current_weight = calculatePrediction(oldWeight, foodAmount, adultRatio, 0, appState.params, harvestAmount);
                }
                
                await saveColony(colony);
                
                // INVECE della somma, applichiamo il DELTA (differenza) al peso globale per non sovrascrivere le blatte non assegnate.
                let globalOldWeight = appState.measurements.length > 0 ? appState.measurements[appState.measurements.length - 1].total_weight : 0;
                let newGlobalWeight = globalOldWeight;
                
                if (eventType === 'pesata') {
                    newGlobalWeight = Math.max(0, globalOldWeight + deltaWeight);
                } else if (eventType === 'prelievo') {
                    newGlobalWeight = Math.max(0, globalOldWeight - harvestAmount);
                } // Per il cibo ci pensa già processNewMeasurement
                
                const globalNotes = `[${colony.name}] ${notes}`;
                // Registra l'evento a livello globale con il nuovo peso calcolato
                await processNewMeasurement(date, newGlobalWeight, foodAmount, adultRatio, globalNotes, harvestAmount, false, true, eventType);
            }
        } else {
            // Globale standard
            await processNewMeasurement(date, weight, foodAmount, adultRatio, notes, harvestAmount, false, true, eventType);
        }
        
        modal.classList.remove('active');
        form.reset();
        document.getElementById('inputDate').valueAsDate = new Date();

        if (colonyId) {
            updateColoniesUI();
            // Aggiorna anche i dati nel modal dettagli colonia se è aperto
            const detailCard = document.getElementById('colonyDetailCard');
            if (detailCard && detailCard.style.display !== 'none') {
                showColonyDetails(colonyId);
            }
        }

        if (inputType) {
            inputType.value = 'pesata';
            updateFormVisibility();
        }

        if (adultRatioSlider) adultRatioSlider.value = 0.35;
        if (adultRatioInput) adultRatioInput.value = 0.35;

        showNotification("Successo", "Nuova rilevazione elaborata dal D.U.B.I.A.", "success");
    });

    // Reset DB Logic
    // CSV Export Logic
    const btnExportCSV = document.getElementById('btnExportCSV');
    if (btnExportCSV) {
        btnExportCSV.addEventListener('click', () => {
            if (appState.measurements.length === 0) {
                showNotification("Attenzione", "Nessun dato da esportare.", "warning");
                return;
            }

            // CSV Header
            let csvContent = "data:text/csv;charset=utf-8,";
            csvContent += "Data,Peso Reale (g),Peso Teorico (g),Cibo (g),Ratio Adulti,Indice Salute (%),Note\n";

            appState.measurements.forEach(m => {
                // Escape quotes in notes
                const safeNotes = m.notes ? `"${m.notes.replace(/"/g, '""')}"` : "";
                const row = [
                    m.date,
                    m.total_weight.toFixed(2),
                    (m.predicted_weight || m.total_weight).toFixed(2),
                    (m.food_amount || 0).toFixed(2),
                    (m.adult_ratio || 0).toFixed(2),
                    m.health_index.toFixed(2),
                    safeNotes
                ];
                csvContent += row.join(",") + "\n";
            });

            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", "dubia_storico_dati.csv");
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            showNotification("Esportazione Completata", "Il file CSV è stato scaricato.", "success");
        });
    }


    const btnNewBlood = document.getElementById('btnNewBlood');
    if (btnNewBlood) {
        btnNewBlood.addEventListener('click', async () => {
            if (appState.measurements.length === 0) {
                showNotification("Errore", "Nessun dato presente.", "alert");
                return;
            }
            const latest = appState.measurements[appState.measurements.length - 1];
            const today = new Date().toISOString().split('T')[0];

            // Inserisci un evento di tracciamento consanguineità senza peso (o copiando l'ultimo peso)
            await processNewMeasurement(
                today,
                latest.total_weight,
                0,
                latest.adult_ratio,
                "[Nuovo Sangue] Inseriti nuovi riproduttori per migliorare la genetica.",
                0,
                true,
                false,
                'nuovo_sangue'
            );

            showNotification("Successo", "Nuova linea genetica registrata con successo.", "success");
        });
    }

    const btnConfirmHarvestSim = document.getElementById('btnConfirmHarvestSim');
    if (btnConfirmHarvestSim) {
        btnConfirmHarvestSim.addEventListener('click', async () => {
            const amount = parseFloat(document.getElementById('harvestAmount').value);
            if (isNaN(amount) || amount <= 0) {
                showNotification("Errore", "Inserisci una quantità valida da prelevare.", "error");
                return;
            }

            const isCyclic = document.getElementById('harvestCyclic').checked;
            const categoryElement = document.getElementById('harvestCategory');
            const categoryText = categoryElement.options[categoryElement.selectedIndex].text;

            let noteStr = `Prelievo: ${categoryText}`;
            if (isCyclic) {
                noteStr += " (Ciclico settimanale)";
            }

            // Using custom modal for confirmation instead of alert/confirm
            const confirmModal = document.createElement('div');
            confirmModal.className = 'modal-overlay active';
            confirmModal.innerHTML = `
                <div class="modal">
                    <h2>Conferma Prelievo</h2>
                    <p>Sei sicuro di voler registrare un prelievo reale di <strong>${amount} g</strong>?</p>
                    <div style="display: flex; gap: 1rem; margin-top: 1.5rem; justify-content: flex-end;">
                        <button id="btnCancelSimHarvest" class="btn-standard" style="background-color: var(--card-bg);">Annulla</button>
                        <button id="btnConfirmSimHarvestAction" class="btn-standard btn-danger">Sì, Registra</button>
                    </div>
                </div>
            `;
            document.body.appendChild(confirmModal);

            document.getElementById('btnCancelSimHarvest').addEventListener('click', () => {
                document.body.removeChild(confirmModal);
            });

            document.getElementById('btnConfirmSimHarvestAction').addEventListener('click', async () => {
                document.body.removeChild(confirmModal);

                const today = new Date().toISOString().split('T')[0];
                let lastWeight = appState.measurements.length > 0 ?
                    appState.measurements[appState.measurements.length - 1].total_weight : 0;

                // Subtract the harvest amount immediately from the current weight
                // so it reflects as an actual deduction, not a future projection.
                const newCurrentWeight = Math.max(0, lastWeight - amount);

                const btn = document.getElementById('btnConfirmHarvestSim');
                const originalText = btn.innerText;
                btn.innerText = "Salvataggio...";
                btn.disabled = true;

                await processNewMeasurement(
                    today,
                    newCurrentWeight,
                    0,
                    appState.params.manualCalibrations ? null : 0.35,
                    noteStr,
                    amount,
                    false,
                    true,
                    'prelievo'
                );

                btn.innerText = originalText;
                btn.disabled = false;

                // Reset amount in simulator
                document.getElementById('harvestAmount').value = 0;

                showNotification("Successo", `Prelievo di ${amount}g registrato.`, "success");
            });
        });
    }

    // ══════════════════════════════════════════════════════
    // EVENT LISTENERS — SEZIONE CLIENTI
    // ══════════════════════════════════════════════════════

    // Aggiorna UI clienti al caricamento (dopo loadInitialData)
    updateClientiUI();

    // ── Nuovo Cliente ─────────────────────────────────────────
    const btnNuovoCliente = document.getElementById('btnNuovoCliente');
    if (btnNuovoCliente) {
        btnNuovoCliente.addEventListener('click', () => openClientModal(null));
    }
    const btnCancelClient = document.getElementById('btnCancelClient');
    if (btnCancelClient) {
        btnCancelClient.addEventListener('click', () => document.getElementById('clientModal').classList.remove('active'));
    }

    const clientForm = document.getElementById('clientForm');
    if (clientForm) {
        clientForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const idVal = document.getElementById('clientId').value;
            const client = {
                nome:     document.getElementById('clientNome').value.trim(),
                cognome:  document.getElementById('clientCognome').value.trim(),
                citta:    document.getElementById('clientCitta').value.trim(),
                telefono: document.getElementById('clientTelefono').value.trim(),
                email:    document.getElementById('clientEmail').value.trim(),
                animale:  document.getElementById('clientAnimale').value,
                note:     document.getElementById('clientNote').value.trim(),
                data_aggiunta: new Date().toISOString().split('T')[0]
            };
            if (idVal) client.id = Number(idVal);

            await saveClient(client);
            document.getElementById('clientModal').classList.remove('active');
            updateClientiUI();
            showNotification('Cliente Salvato', `${client.nome} ${client.cognome} aggiunto al database.`, 'success');
        });
    }

    // ── Delegazione click su lista clienti ───────────────────
    document.addEventListener('click', async (e) => {
        // Bottone Modifica cliente
        const editBtn = e.target.closest('.btn-client-edit');
        if (editBtn) {
            const id = Number(editBtn.dataset.id);
            const client = appState.clients.find(c => c.id === id);
            if (client) openClientModal(client);
            return;
        }

        // Bottone Elimina cliente
        const deleteClientBtn = e.target.closest('.btn-client-delete');
        if (deleteClientBtn) {
            const id = Number(deleteClientBtn.dataset.id);
            const client = appState.clients.find(c => c.id === id);
            const name = client ? `${client.nome} ${client.cognome}` : 'questo cliente';

            const confirmModal = document.createElement('div');
            confirmModal.className = 'modal-overlay active';
            confirmModal.innerHTML = `
                <div class="modal">
                    <h2 style="color: var(--alert-red);">Elimina Cliente</h2>
                    <p>Eliminare <strong>${name}</strong> e tutto il suo storico cessioni?</p>
                    <div class="modal-actions">
                        <button class="btn-standard btn-cancel" id="btnCancelDelClient">Annulla</button>
                        <button class="btn-standard btn-danger" id="btnConfirmDelClient">Sì, Elimina</button>
                    </div>
                </div>`;
            document.body.appendChild(confirmModal);
            document.getElementById('btnCancelDelClient').addEventListener('click', () => document.body.removeChild(confirmModal));
            document.getElementById('btnConfirmDelClient').addEventListener('click', async () => {
                document.body.removeChild(confirmModal);
                await deleteClient(id);
                updateClientiUI();
                showNotification('Cliente Eliminato', `${name} rimosso dal database.`, 'success');
            });
            return;
        }

        // Bottone Nuova Cessione dalla card cliente
        const cessioneBtn = e.target.closest('.btn-client-cessione');
        if (cessioneBtn) {
            openCessioneModal(Number(cessioneBtn.dataset.id));
            return;
        }

        // Bottone Elimina cessione
        const deleteCessioneBtn = e.target.closest('.btn-delete-cessione');
        if (deleteCessioneBtn) {
            const id = Number(deleteCessioneBtn.dataset.id);
            const confirmModal = document.createElement('div');
            confirmModal.className = 'modal-overlay active';
            confirmModal.innerHTML = `
                <div class="modal">
                    <h2 style="color: var(--alert-red);">Elimina Cessione</h2>
                    <p>Rimuovere questa cessione dallo storico?</p>
                    <div class="modal-actions">
                        <button class="btn-standard btn-cancel" id="btnCancelDelCessione">Annulla</button>
                        <button class="btn-standard btn-danger" id="btnConfirmDelCessione">Sì, Elimina</button>
                    </div>
                </div>`;
            document.body.appendChild(confirmModal);
            document.getElementById('btnCancelDelCessione').addEventListener('click', () => document.body.removeChild(confirmModal));
            document.getElementById('btnConfirmDelCessione').addEventListener('click', async () => {
                document.body.removeChild(confirmModal);
                await deleteCessione(id);
                updateClientiUI();
                showNotification('Cessione Eliminata', 'Registro rimosso dallo storico.', 'success');
            });
            return;
        }
    });

    // ── Nuova Cessione (bottone nella tabella) ────────────────
    const btnNuovaCessione = document.getElementById('btnNuovaCessione');
    if (btnNuovaCessione) {
        btnNuovaCessione.addEventListener('click', () => openCessioneModal(null));
    }
    const btnCancelCessione = document.getElementById('btnCancelCessione');
    if (btnCancelCessione) {
        btnCancelCessione.addEventListener('click', () => document.getElementById('cessioneModal').classList.remove('active'));
    }

    const cessioneForm = document.getElementById('cessioneForm');
    if (cessioneForm) {
        cessioneForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const clienteId = Number(document.getElementById('cessioneCliente').value);
            if (!clienteId) {
                showNotification('Errore', 'Seleziona un cliente prima di registrare la cessione.', 'alert');
                return;
            }
            const cessione = {
                cliente_id:     clienteId,
                data:           document.getElementById('cessioneData').value,
                tipo_blatta:    document.getElementById('cessioneTipo').value,
                quantita_g:     parseFloat(document.getElementById('cessioneQuantita').value) || 0,
                prezzo_unit:    parseFloat(document.getElementById('cessionePrezzoUnit').value) || 0,
                totale_euro:    parseFloat(document.getElementById('cessioneTotale').value) || 0,
                note:           document.getElementById('cessioneNote').value.trim()
            };
            await saveCessione(cessione);
            document.getElementById('cessioneModal').classList.remove('active');
            updateClientiUI();
            const cliente = appState.clients.find(c => c.id === clienteId);
            const nomeCl = cliente ? `${cliente.nome} ${cliente.cognome}` : 'cliente';
            showNotification('Cessione Registrata', `${cessione.quantita_g} g ceduti a ${nomeCl} — € ${cessione.totale_euro.toFixed(2)}`, 'success');
        });
    }

    // ── Filtro storico cessioni per cliente ───────────────────
    const cessioniFilterCliente = document.getElementById('cessioniFilterCliente');
    if (cessioniFilterCliente) {
        cessioniFilterCliente.addEventListener('change', (e) => {
            updateClientiUI(e.target.value || null);
        });
    }

    // ── Search bar clienti (debounced) ─────────────────────────
    const clientiSearch = document.getElementById('clientiSearch');
    if (clientiSearch) {
        let searchTimeout;
        clientiSearch.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => updateClientiUI(), 250);
        });
    }

    // ── Bottone Prezzi ─────────────────────────────────────────
    const btnOpenPrezzi = document.getElementById('btnOpenPrezzi');
    if (btnOpenPrezzi) {
        btnOpenPrezzi.addEventListener('click', openPrezziModal);
    }
    const btnCancelPrezzi = document.getElementById('btnCancelPrezzi');
    if (btnCancelPrezzi) {
        btnCancelPrezzi.addEventListener('click', () => document.getElementById('prezziModal').classList.remove('active'));
    }

    const prezziForm = document.getElementById('prezziForm');
    if (prezziForm) {
        // Aggiorna preview live ad ogni modifica di un prezzo
        prezziForm.querySelectorAll('input[type="number"]').forEach(input => {
            input.addEventListener('input', updatePrezziPreview);
        });

        prezziForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const newPrices = {};
            ['FEMALE','MALE','SUBADULT','MEDIUM','SMALL','BABY'].forEach(key => {
                const input = document.getElementById(`price_${key}`);
                newPrices[key] = parseFloat(input?.value) || 0;
            });
            savePrices(newPrices);
            document.getElementById('prezziModal').classList.remove('active');
            updateUI(); // Aggiorna il valore economico in Home
            showNotification('Prezzi Salvati', 'Il Valore Economico in Home è stato aggiornato.', 'success');
        });
    }

    const btnResetDB = document.getElementById('btnResetDB');
    if (btnResetDB) {
        btnResetDB.addEventListener('click', () => {
            // Using custom modal for confirmation
            const confirmModal = document.createElement('div');
            confirmModal.className = 'modal-overlay active';
            confirmModal.innerHTML = `
                <div class="modal">
                    <h2 style="color: var(--alert-red);">Conferma Reset</h2>
                    <p>Attenzione: questo eliminerà tutti i dati inseriti manualmente e ricaricherà solo lo storico iniziale. Procedere?</p>
                    <div class="modal-actions">
                        <button type="button" class="btn-standard btn-cancel" id="btnCancelReset">Annulla</button>
                        <button type="button" class="btn-standard btn-danger" id="btnConfirmReset">Procedi</button>
                    </div>
                </div>
            `;
            document.body.appendChild(confirmModal);

            document.getElementById('btnCancelReset').addEventListener('click', () => {
                document.body.removeChild(confirmModal);
            });

            document.getElementById('btnConfirmReset').addEventListener('click', () => {
                document.body.removeChild(confirmModal);
                // Double confirmation modal
                const doubleConfirmModal = document.createElement('div');
                doubleConfirmModal.className = 'modal-overlay active';
                doubleConfirmModal.innerHTML = `
                    <div class="modal">
                        <h2 style="color: var(--alert-red);">Ultimo Avviso</h2>
                        <p>Sei ASSOLUTAMENTE sicuro? L'operazione è irreversibile e i dati andranno persi per sempre.</p>
                        <div class="modal-actions">
                            <button type="button" class="btn-standard btn-cancel" id="btnCancelDoubleReset">Non Resettare</button>
                            <button type="button" class="btn-standard btn-danger" id="btnDoubleConfirmReset">Si, Elimina Tutto</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(doubleConfirmModal);

                document.getElementById('btnCancelDoubleReset').addEventListener('click', () => {
                    document.body.removeChild(doubleConfirmModal);
                });

                document.getElementById('btnDoubleConfirmReset').addEventListener('click', () => {
                    document.body.removeChild(doubleConfirmModal);
                    const req = indexedDB.deleteDatabase(dbName);
                    req.onsuccess = () => {
                        showNotification("Reset completato", "Database resettato. Ricaricamento in corso...", "success");
                        setTimeout(() => window.location.reload(), 1500);
                    };
                    req.onerror = () => {
                        showNotification("Errore", "Errore nel reset del database.", "alert");
                    };
                });
            });
        });
    }
});

const showNotification = (title, message, type = "success") => {
    const area = document.getElementById('notificationArea');
    const notif = document.createElement('div');
    notif.className = `notification ${type}`;
    notif.innerHTML = `
        <div class="notification-content">
            <strong>${title}</strong>
            <p>${message}</p>
        </div>
        <button class="notification-close">&times;</button>
    `;
    
    area.appendChild(notif);
    
    notif.querySelector('.notification-close').addEventListener('click', () => notif.remove());
    
    setTimeout(() => {
        if(notif.parentElement) notif.remove();
    }, 5000);
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        calculatePrediction,
        appState,
        DEFAULT_PARAMS
    };
}

// ══════════════════════════════════════════════════════
// COLONIE & QR CODE LOGIC
// ══════════════════════════════════════════════════════

/**
 * Carica tutte le colonie da IndexedDB.
 */
const loadColonies = () => {
    return new Promise((resolve) => {
        const tx = db.transaction("colonies", "readonly");
        const store = tx.objectStore("colonies");
        const req = store.getAll();
        req.onsuccess = () => {
            appState.colonies = req.result || [];
            resolve();
        };
        req.onerror = () => {
            resolve();
        };
    });
};

/**
 * Salva una nuova colonia o aggiorna una esistente in IndexedDB.
 */
const saveColony = (colony) => {
    return new Promise((resolve) => {
        const tx = db.transaction("colonies", "readwrite");
        const store = tx.objectStore("colonies");
        const req = store.put(colony);
        req.onsuccess = (e) => {
            if (!colony.id) colony.id = e.target.result;
            const idx = appState.colonies.findIndex(c => c.id === colony.id);
            if (idx >= 0) appState.colonies[idx] = colony;
            else appState.colonies.push(colony);
            
            // Backup on Google Sheets
            saveColonyToCloud(colony);

            resolve(colony);
        };
        req.onerror = () => resolve(null);
    });
};

/**
 * Sync colonia base data to Google Sheets 
 */
const saveColonyToCloud = async (colony) => {
    try {
        const payload = {
            event_type: 'colonia_sync',
            date: colony.creation_date,
            id: colony.id,
            name: colony.name,
            type: colony.type,
            notes: colony.notes,
            current_weight: colony.current_weight || 0,
            males_count: colony.males_count || 0,
            females_count: colony.females_count || 0,
            subadults_count: colony.subadults_count || 0,
            medium_count: colony.medium_count || 0,
            small_count: colony.small_count || 0,
            baby_count: colony.baby_count || 0
        };
        fetch(GAS_URL, {
            method: 'POST',
            redirect: 'follow',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.warn("Colony backup to cloud failed.", e);
    }
};

/**
 * Sync colonie dal Cloud (Scarica il foglio Colonie e unisce i dati in IndexedDB)
 */
const syncColoniesFromCloud = async () => {
    try {
        if (!navigator.onLine) return;
        
        console.info("[D.U.B.I.A.] Sincronizzazione Colonie dal cloud...");
        const response = await fetch(GAS_URL + "?sheet=Colonie", { redirect: "follow" });
        if (!response.ok) return;
        
        const jsonResponse = await response.json();
        const data = jsonResponse.data || jsonResponse;
        
        if (Array.isArray(data) && data.length > 0) {
            // Poiché GAS fa solo appendRow, deduplichiamo per ID prendendo l'ultimo inserito
            const coloniesMap = new Map();
            data.forEach(c => {
                if (c.id) coloniesMap.set(Number(c.id), c);
            });
            
            const tx = db.transaction("colonies", "readwrite");
            const store = tx.objectStore("colonies");
            
            coloniesMap.forEach((cloudColony, id) => {
                // Costruisci oggetto colonia normalizzato
                const mappedColony = {
                    id: id,
                    creation_date: cloudColony.date || cloudColony.creation_date || new Date().toISOString().split('T')[0],
                    name: cloudColony.name || `Colonia ${id}`,
                    type: cloudColony.type || 'Pasto',
                    notes: cloudColony.notes || '',
                    current_weight: parseFloat(cloudColony.current_weight) || parseFloat(cloudColony.total_weight) || 0,
                    males_count: parseInt(cloudColony.males_count) || 0,
                    females_count: parseInt(cloudColony.females_count) || 0,
                    subadults_count: parseInt(cloudColony.subadults_count) || 0,
                    medium_count: parseInt(cloudColony.medium_count) || 0,
                    small_count: parseInt(cloudColony.small_count) || 0,
                    baby_count: parseInt(cloudColony.baby_count) || 0
                };
                
                // Salva o aggiorna in IndexedDB silenziosamente
                store.put(mappedColony);
                
                // Aggiorna array in memoria (appState)
                const idx = appState.colonies.findIndex(c => c.id === id);
                if (idx >= 0) {
                    appState.colonies[idx] = mappedColony;
                } else {
                    appState.colonies.push(mappedColony);
                }
            });
            
            console.info(`[D.U.B.I.A.] Sincronizzate ${coloniesMap.size} colonie dal cloud.`);
            updateColoniesUI();
        }
    } catch (e) {
        console.warn("Errore durante il download delle colonie dal cloud:", e);
    }
};

/**
 * Elimina una colonia (locale + cloud)
 */
const deleteColony = (id) => {
    return new Promise((resolve) => {
        const tx = db.transaction("colonies", "readwrite");
        const store = tx.objectStore("colonies");
        store.delete(Number(id));
        appState.colonies = appState.colonies.filter(c => c.id !== Number(id));
        
        // Elimina anche dal cloud
        deleteColonyFromCloud(id);
        
        resolve();
    });
};

/**
 * Invia evento di eliminazione colonia a Google Sheets
 */
const deleteColonyFromCloud = async (id) => {
    try {
        const payload = {
            event_type: 'colonia_delete',
            id: Number(id)
        };
        fetch(GAS_URL, {
            method: 'POST',
            redirect: 'follow',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.warn("Colony cloud delete failed.", e);
    }
};

/**
 * Aggiorna la UI della lista colonie
 */
const updateColoniesUI = () => {
    const listEl = document.getElementById('coloniesList');
    if (!listEl) return;

    if (appState.colonies.length === 0) {
        listEl.innerHTML = `
            <div class="clienti-empty">
                <span class="clienti-empty-icon">📦</span>
                <p>Nessun contenitore registrato.</p>
                <p class="subtitle-text">Clicca su <strong>+ Nuova Colonia</strong> per iniziare.</p>
            </div>`;
    } else {
        listEl.innerHTML = appState.colonies.map(c => {
            const isBaby = c.type === 'Baby';
            const isPasto = c.type === 'Pasto';
            const color = isBaby ? '#f1c40f' : (isPasto ? '#3498db' : 'var(--accent-purple)');
            
            return `
            <div class="colony-card" data-id="${c.id}">
                <div class="colony-card-header">
                    <div>
                        <div class="colony-name">${c.name}</div>
                        <span class="animal-badge" style="background: ${color}22; color: ${color}; border-color: ${color}44;">${c.type}</span>
                    </div>
                    <button class="btn-standard" onclick="showColonyDetails(${c.id})" style="padding: 0.3rem 0.6rem;">Apri</button>
                </div>
                <div class="colony-stats">
                    <span>⚖️ ${c.current_weight ? c.current_weight.toFixed(1) + ' g' : '-- g'}</span>
                    <span>♂️ ${c.males_count || '--'}</span>
                    <span>♀️ ${c.females_count || '--'}</span>
                </div>
                ${c.notes ? `<div class="subtitle-text" style="font-size: 0.8rem; margin-top: 0.5rem;">${c.notes}</div>` : ''}
            </div>`;
        }).join('');
    }

    // Populate dropdown in the entry modal
    const colonySelect = document.getElementById('inputColonyId');
    if (colonySelect) {
        const currentVal = colonySelect.value;
        colonySelect.innerHTML = '<option value="">-- Massa Globale (Tutte le colonie) --</option>' +
            appState.colonies.map(c => `<option value="${c.id}" ${c.id == currentVal ? 'selected' : ''}>${c.name} (${c.type})</option>`).join('');
    }
};

/**
 * Mostra i dettagli di una colonia specifica (chiamata dal bottone Apri o dal QR Code)
 */
window.showColonyDetails = (id) => {
    const colony = appState.colonies.find(c => c.id === id);
    if (!colony) {
        showNotification("Errore", "Colonia non trovata", "alert");
        return;
    }

    // Passa al tab colonie se non ci siamo
    document.querySelector('.tab-btn[data-target="colonies"]').click();

    document.getElementById('detailColonyName').innerText = colony.name;
    document.getElementById('detailColonyType').innerText = colony.type;
    document.getElementById('detailColonyWeight').innerText = colony.current_weight ? `${colony.current_weight.toFixed(1)} g` : '-- g';
    document.getElementById('detailColonyMales').innerText = colony.males_count || '--';
    document.getElementById('detailColonyFemales').innerText = colony.females_count || '--';
    document.getElementById('detailColonySubadults').innerText = colony.subadults_count || '--';
    document.getElementById('detailColonyMedium').innerText = colony.medium_count || '--';
    document.getElementById('detailColonySmall').innerText = colony.small_count || '--';
    document.getElementById('detailColonyBaby').innerText = colony.baby_count || '--';
    document.getElementById('detailColonyNotes').innerText = colony.notes || 'Nessuna nota.';

    const detailCard = document.getElementById('colonyDetailCard');
    detailCard.style.display = 'block';
    
    // Smooth scroll
    detailCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Buttons bindings
    document.getElementById('btnDetailClose').onclick = () => detailCard.style.display = 'none';
    
    document.getElementById('btnDetailAddMeasure').onclick = () => {
        document.getElementById('inputColonyId').value = colony.id;
        document.getElementById('inputColonyId').dispatchEvent(new Event('change'));
        document.getElementById('entryModal').classList.add('active');
    };

    document.getElementById('btnDetailShowQR').onclick = () => {
        generateQRCode(colony);
    };

    document.getElementById('btnDetailDelete').onclick = () => {
        if(confirm(`Vuoi eliminare la colonia ${colony.name}? (I dati storici globali rimarranno intatti)`)) {
            deleteColony(colony.id).then(() => {
                detailCard.style.display = 'none';
                updateColoniesUI();
                showNotification("Eliminata", "Colonia eliminata con successo.", "success");
            });
        }
    };

    // Render initial chart
    const slider = document.getElementById('colonyPredictionSlider');
    const label = document.getElementById('colonyPredictionDaysLabel');
    if (slider && label) {
        let currentDays = parseInt(slider.value) || 180;
        label.innerText = currentDays + ' gg';
        renderColonyPredictionChart(colony, currentDays);
        
        // Remove old listeners to prevent memory leaks or duplicate calls when switching colonies
        const newSlider = slider.cloneNode(true);
        slider.parentNode.replaceChild(newSlider, slider);
        newSlider.addEventListener('input', (e) => {
            const val = e.target.value;
            document.getElementById('colonyPredictionDaysLabel').innerText = val + ' gg';
            renderColonyPredictionChart(colony, parseInt(val));
        });
    }
};

let colonyPredictionChartInstance = null;

const renderColonyPredictionChart = (colony, days) => {
    const canvas = document.getElementById('colonyPredictionChart');
    if (!canvas) return;
    
    if (colonyPredictionChartInstance) {
        colonyPredictionChartInstance.destroy();
    }
    
    // Calculation of W_t and A_t purely based on specific colony's known data
    let W_t = colony.current_weight || 10;
    
    // Adult biomass
    let mCount = colony.males_count || 0;
    let fCount = colony.females_count || 0;
    let W_adulti = (mCount * MASS.MALE) + (fCount * MASS.FEMALE);
    
    // Nymph biomass
    let subCount = colony.subadults_count || 0;
    let medCount = colony.medium_count || 0;
    let smCount = colony.small_count || 0;
    let bCount = colony.baby_count || 0;
    let W_ninfe = (subCount * MASS.SUBADULT) + (medCount * MASS.MEDIUM) + (smCount * MASS.SMALL) + (bCount * MASS.BABY);
    
    let W_totale_calcolato = W_adulti + W_ninfe;
    
    let A_t = appState.params.adultRatio || 0.35;
    if (W_totale_calcolato > 0) {
        A_t = W_adulti / W_totale_calcolato;
        // Aggiorniamo W_t con il calcolato se non era stato forzato un peso maggiore
        if (!colony.current_weight || Math.abs(colony.current_weight - W_totale_calcolato) < W_totale_calcolato * 0.2) {
            W_t = W_totale_calcolato;
        }
    }
    
    const theta2 = appState.params.theta2 || 1.05;

    const labels = [];
    const dataBiomass = [];
    const dataPop = [];

    // Initialize buckets
    let simM = mCount;
    let simF = fCount;
    let simSub = subCount;
    let simMed = medCount;
    let simSmall = smCount;
    let simBaby = bCount;
    
    // If we only have weight and no counts, fallback to census
    if (simM + simF + simSub + simMed + simSmall + simBaby === 0 && W_t > 0) {
        const dubiaModule = D();
        if (dubiaModule) {
            let initialCensus = dubiaModule.census(W_t, A_t);
            simM = initialCensus.N_maschi;
            simF = initialCensus.N_femmine;
            simSub = initialCensus.N_medie * 0.2; // Approssimazione dal modello piramidale
            simMed = initialCensus.N_medie * 0.8;
            simSmall = initialCensus.N_baby * 0.3;
            simBaby = initialCensus.N_baby * 0.7;
        }
    }

    // Parametri biologici
    const baseTheta2 = 1.05;
    const envFactor = Math.max(0.1, theta2 / baseTheta2); // Scaliamo metabolismo in base a theta2

    const RATE_BABY_SMALL = 1 / 30;
    const RATE_SMALL_MED = 1 / 45;
    const RATE_MED_SUB = 1 / 45;
    const RATE_SUB_ADULT = 1 / 30;
    const BIRTH_RATE_PER_FEMALE = 25 / 45; 
    const MORTALITY_ADULT = 1 / 400;

    // Simulate
    const stepSize = Math.max(1, Math.floor(days / 15));
    for (let day = 0; day <= days; day += stepSize) {
        labels.push(day);
        
        let current_W = (simM * MASS.MALE) + (simF * MASS.FEMALE) + (simSub * MASS.SUBADULT) + (simMed * MASS.MEDIUM) + (simSmall * MASS.SMALL) + (simBaby * MASS.BABY);
        let current_N = simM + simF + simSub + simMed + simSmall + simBaby;
        
        dataBiomass.push(current_W);
        dataPop.push(current_N);
        
        // Simula lo step successivo
        let effDays = stepSize * envFactor; // Effetto di theta2 sulla biologia
        
        // Nascite
        let newBabies = simF * BIRTH_RATE_PER_FEMALE * effDays;
        
        // Transizioni (con formula continua per stabilità su step grandi)
        let b_to_s = simBaby * (1 - Math.pow(1 - RATE_BABY_SMALL, effDays));
        let s_to_m = simSmall * (1 - Math.pow(1 - RATE_SMALL_MED, effDays));
        let m_to_sub = simMed * (1 - Math.pow(1 - RATE_MED_SUB, effDays));
        let sub_to_a = simSub * (1 - Math.pow(1 - RATE_SUB_ADULT, effDays));
        
        let m_deaths = simM * (1 - Math.pow(1 - MORTALITY_ADULT, effDays));
        let f_deaths = simF * (1 - Math.pow(1 - MORTALITY_ADULT, effDays));
        
        // Aggiorna buckets
        simBaby = Math.max(0, simBaby + newBabies - b_to_s);
        simSmall = Math.max(0, simSmall + b_to_s - s_to_m);
        simMed = Math.max(0, simMed + s_to_m - m_to_sub);
        simSub = Math.max(0, simSub + m_to_sub - sub_to_a);
        
        simM = Math.max(0, simM + (sub_to_a * 0.5) - m_deaths);
        simF = Math.max(0, simF + (sub_to_a * 0.5) - f_deaths);
    }

    colonyPredictionChartInstance = new Chart(canvas, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Biomassa (g)',
                    data: dataBiomass,
                    borderColor: '#2ecc71',
                    backgroundColor: 'rgba(46, 204, 113, 0.1)',
                    yAxisID: 'y',
                    tension: 0.3,
                    fill: true
                },
                {
                    label: 'Popolazione (N)',
                    data: dataPop,
                    borderColor: '#8e44ad',
                    backgroundColor: 'transparent',
                    yAxisID: 'y1',
                    borderDash: [5, 5],
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { title: { display: true, text: 'Giorni Futuri' } },
                y: { type: 'linear', display: true, position: 'left', title: { display: true, text: 'Grammi (g)' } },
                y1: { type: 'linear', display: true, position: 'right', title: { display: true, text: 'Individui (N)' }, grid: { drawOnChartArea: false } }
            }
        }
    });
};

/**
 * Genera il QR Code visuale per una colonia
 */
const generateQRCode = (colony) => {
    const container = document.getElementById('qrCanvasContainer');
    if (!container) return;
    container.innerHTML = '';
    const qrData = JSON.stringify({ dubia_colony_id: colony.id });
    
    new QRCode(container, {
        text: qrData,
        width: 250,
        height: 250,
        colorDark : "#182B49",
        colorLight : "#ffffff",
        correctLevel : QRCode.CorrectLevel.H
    });

    document.getElementById('qrColonyName').innerText = colony.name;
    document.getElementById('qrDisplayModal').classList.add('active');
};

/**
 * Gestione scanner QR
 */
let html5QrcodeScanner = null;

const startQRScanner = () => {
    document.getElementById('qrScanError').style.display = 'none';
    document.getElementById('qrScannerModal').classList.add('active');
    
    if (!html5QrcodeScanner) {
        html5QrcodeScanner = new Html5QrcodeScanner(
            "qr-reader", 
            { fps: 10, qrbox: {width: 250, height: 250} }, 
            /* verbose= */ false
        );
    }
    
    html5QrcodeScanner.render((decodedText, decodedResult) => {
        // success
        try {
            const data = JSON.parse(decodedText);
            if (data && data.dubia_colony_id) {
                html5QrcodeScanner.clear();
                document.getElementById('qrScannerModal').classList.remove('active');
                showColonyDetails(data.dubia_colony_id);
            } else {
                document.getElementById('qrScanError').style.display = 'block';
            }
        } catch(e) {
            document.getElementById('qrScanError').style.display = 'block';
        }
    }, (error) => {
        // failure - just ignore to keep scanning
    });
};

const stopQRScanner = () => {
    if (html5QrcodeScanner) {
        html5QrcodeScanner.clear();
    }
    document.getElementById('qrScannerModal').classList.remove('active');
};

// ── Inizializzazione Event Listener Colonie ─────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    
    // Aggiorna UI colonie
    setTimeout(() => updateColoniesUI(), 500);

    // Modal Nuova Colonia
    const btnNuovaColonia = document.getElementById('btnNuovaColonia');
    if (btnNuovaColonia) {
        btnNuovaColonia.addEventListener('click', () => {
            document.getElementById('colonyForm').reset();
            document.getElementById('colonyId').value = '';
            document.getElementById('colonyMales').value = '';
            document.getElementById('colonyFemales').value = '';
            document.getElementById('colonySubadults').value = '';
            document.getElementById('colonyMedium').value = '';
            document.getElementById('colonySmall').value = '';
            document.getElementById('colonyBaby').value = '';
            document.getElementById('colonyModalTitle').innerText = 'Nuova Colonia';
            document.getElementById('colonyModal').classList.add('active');
        });
    }

    const btnCancelColony = document.getElementById('btnCancelColony');
    if (btnCancelColony) {
        btnCancelColony.addEventListener('click', () => document.getElementById('colonyModal').classList.remove('active'));
    }

    const colonyForm = document.getElementById('colonyForm');
    if (colonyForm) {
        colonyForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const idVal = document.getElementById('colonyId').value;
            const mCount = parseInt(document.getElementById('colonyMales')?.value) || 0;
            const fCount = parseInt(document.getElementById('colonyFemales')?.value) || 0;
            const subCount = parseInt(document.getElementById('colonySubadults')?.value) || 0;
            const medCount = parseInt(document.getElementById('colonyMedium')?.value) || 0;
            const smCount = parseInt(document.getElementById('colonySmall')?.value) || 0;
            const bCount = parseInt(document.getElementById('colonyBaby')?.value) || 0;
            
            const totalIndividuals = mCount + fCount + subCount + medCount + smCount + bCount;
            const estimatedWeight = totalIndividuals > 0 ? 
                (mCount * MASS.MALE) + (fCount * MASS.FEMALE) + (subCount * MASS.SUBADULT) + 
                (medCount * MASS.MEDIUM) + (smCount * MASS.SMALL) + (bCount * MASS.BABY) : null;

            const colony = {
                name:  document.getElementById('colonyName').value.trim(),
                type:  document.getElementById('colonyType').value,
                notes: document.getElementById('colonyNotes').value.trim()
            };

            let isNewWithWeight = false;

            if (idVal) {
                colony.id = Number(idVal);
                // Preserve existing metrics
                const existing = appState.colonies.find(c => c.id === colony.id);
                if (existing) {
                    colony.current_weight = existing.current_weight;
                    colony.males_count = existing.males_count;
                    colony.females_count = existing.females_count;
                    colony.subadults_count = existing.subadults_count;
                    colony.medium_count = existing.medium_count;
                    colony.small_count = existing.small_count;
                    colony.baby_count = existing.baby_count;
                    colony.creation_date = existing.creation_date;
                }
            } else {
                colony.creation_date = new Date().toISOString().split('T')[0];
                if (estimatedWeight) {
                    colony.current_weight = estimatedWeight;
                    colony.males_count = mCount;
                    colony.females_count = fCount;
                    colony.subadults_count = subCount;
                    colony.medium_count = medCount;
                    colony.small_count = smCount;
                    colony.baby_count = bCount;
                    isNewWithWeight = true;
                }
            }

            await saveColony(colony);
            document.getElementById('colonyModal').classList.remove('active');
            updateColoniesUI();

            showNotification(idVal ? 'Aggiornata' : 'Creata', `Colonia ${colony.name} salvata con successo.`, 'success');
        });
    }

    // Modal Display QR
    document.getElementById('btnCloseQrDisplay')?.addEventListener('click', () => {
        document.getElementById('qrDisplayModal').classList.remove('active');
    });

    document.getElementById('btnPrintQR')?.addEventListener('click', () => {
        const container = document.getElementById('qrCanvasContainer');
        if (!container) return;
        const canvas = container.querySelector('canvas');
        if (!canvas) return;
        const colonyName = document.getElementById('qrColonyName').innerText;
        const imgData = canvas.toDataURL("image/png");
        
        const printWindow = window.open('', '', 'height=600,width=800');
        if (!printWindow) {
            showNotification("Errore Popup", "Abilita i popup per stampare il QR.", "alert");
            return;
        }
        printWindow.document.write('<html><head><title>Stampa QR Code</title>');
        printWindow.document.write('<style>');
        printWindow.document.write('body { font-family: "Inter", sans-serif; text-align: center; padding: 2rem; color: #333; }');
        printWindow.document.write('h1 { margin-bottom: 0.5rem; font-size: 2rem; }');
        printWindow.document.write('p { margin-bottom: 2rem; color: #666; }');
        printWindow.document.write('img { max-width: 300px; height: auto; border: 2px solid #ccc; padding: 10px; border-radius: 8px; }');
        printWindow.document.write('</style>');
        printWindow.document.write('</head><body>');
        printWindow.document.write('<h1>' + colonyName + '</h1>');
        printWindow.document.write('<p>Codice per scanner D.U.B.I.A.</p>');
        printWindow.document.write('<img src="' + imgData + '" />');
        printWindow.document.write('</body></html>');
        
        printWindow.document.close();
        
        setTimeout(() => {
            printWindow.focus();
            printWindow.print();
            printWindow.close();
        }, 500);
    });

    // Modal Scanner QR
    document.getElementById('btnScanQR')?.addEventListener('click', startQRScanner);
    document.getElementById('btnCloseQrScanner')?.addEventListener('click', stopQRScanner);

    // Gestione input maschi/femmine nel form pesata quando si seleziona una colonia
    const inputColonyId = document.getElementById('inputColonyId');
    const groupColonyCounts = document.getElementById('groupColonyCounts');
    const groupAdultRatio = document.getElementById('groupAdultRatio');
    
    if (inputColonyId) {
        inputColonyId.addEventListener('change', () => {
            if (inputColonyId.value !== "") {
                // Una colonia specifica è selezionata
                groupColonyCounts.style.display = 'grid';
                // Nascondiamo il cursore Ratio, che viene calcolato indirettamente o lasciato globale
                groupAdultRatio.style.display = 'none';
            } else {
                // Massa globale
                groupColonyCounts.style.display = 'none';
                groupAdultRatio.style.display = 'block';
            }
        });
    }
});

// ── Override o Patch per processNewMeasurement ───────────────────────
// Dobbiamo assicurarci che i dati della singola colonia vengano aggiornati quando si salva un evento
const originalProcessNewMeasurement = processNewMeasurement;
processNewMeasurement = async (date, realWeight, foodAmount, adultRatio, notes, harvestAmount, isNewBlood, isManualSubmit, eventType) => {
    
    let colony_id = null;
    let males_count = 0;
    let females_count = 0;

    const colonySelect = document.getElementById('inputColonyId');
    if (colonySelect && colonySelect.value !== "") {
        colony_id = Number(colonySelect.value);
        males_count = Number(document.getElementById('inputColonyMales').value) || 0;
        females_count = Number(document.getElementById('inputColonyFemales').value) || 0;
        
        // Se l'evento è una pesata o un nuovo sangue per una colonia, aggiorniamo il suo stato interno
        if (eventType === 'pesata' || eventType === 'calibrazione' || eventType === 'nuovo_sangue') {
            const colony = appState.colonies.find(c => c.id === colony_id);
            if (colony) {
                colony.current_weight = realWeight;
                if (males_count > 0 || females_count > 0) {
                    colony.males_count = males_count;
                    colony.females_count = females_count;
                }
                await saveColony(colony);
                updateColoniesUI();
                
                // Opzionale: aggiorna la UI di dettaglio se è aperta
                const detailCard = document.getElementById('colonyDetailCard');
                if (detailCard && detailCard.style.display === 'block' && document.getElementById('detailColonyName').innerText === colony.name) {
                    showColonyDetails(colony.id);
                }
            }
        }
    }

    await originalProcessNewMeasurement(date, realWeight, foodAmount, adultRatio, notes, harvestAmount, isNewBlood, isManualSubmit, eventType);
};

// Patch saveMeasurement per iniettare colony_id, males_count, females_count
const originalSaveMeasurement = saveMeasurement;
saveMeasurement = async (measurement) => {
    const colonySelect = document.getElementById('inputColonyId');
    if (colonySelect && colonySelect.value !== "") {
        measurement.colony_id = Number(colonySelect.value);
        measurement.males_count = Number(document.getElementById('inputColonyMales').value) || 0;
        measurement.females_count = Number(document.getElementById('inputColonyFemales').value) || 0;
    }
    return originalSaveMeasurement(measurement);
};
