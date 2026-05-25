/**
 * D.U.B.I.A. Engine - Dynamic Updating Biomass Inference Algorithm
 * 
 * NOTA: Le formule matematiche core (Feed-Forward, Back-Propagation,
 * Indice H, Diagnostica, Censimento) sono definite nel modulo separato
 * dubia_module.js e accessibili tramite window.DUBIA.
 * Questo file gestisce lo stato applicativo, il DB e la UI.
 */

// Constants & Configurations
const GAS_URL = "https://script.google.com/macros/s/AKfycbzW12kzUhqKywlxLkXbV22ef9MwP9jp3t77yCg3t5YxBVRqIy3iYwX1UjgaCX0VLAJ8jA/exec";

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

// State
let appState = {
    measurements: [],
    params: { ...DEFAULT_PARAMS },
    charts: {}
};

// --- DATABASE (IndexedDB) ---
const dbName = "DubiaDB";
const dbVersion = 1;
let db;

const initDB = () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, dbVersion);

        request.onupgradeneeded = (event) => {
            db = event.target.result;
            if (!db.objectStoreNames.contains("measurements")) {
                db.createObjectStore("measurements", { keyPath: "id", autoIncrement: true });
            }
            if (!db.objectStoreNames.contains("parameters")) {
                db.createObjectStore("parameters", { keyPath: "id" });
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

const loadInitialData = async () => {
    // Load parameters
    const paramTx = db.transaction("parameters", "readonly");
    const paramStore = paramTx.objectStore("parameters");
    const paramReq = paramStore.get(1);
    
    paramReq.onsuccess = () => {
        if (paramReq.result) {
            appState.params = paramReq.result;
        } else {
            // Save defaults
            saveParams(appState.params);
        }
    };

    // Try to load from Google Sheets first
    try {
        showNotification("Sincronizzazione", "Download dati dal cloud...", "success");
        const response = await fetch(GAS_URL, { redirect: "follow" });

        if (!response.ok) {
            console.warn(`Cloud fetch returned HTTP ${response.status}. URL might be invalid or permissions missing.`);
            if (response.status === 401 || response.status === 403) {
                showNotification("Errore Cloud", "Accesso negato al Cloud. Verifica permessi o URL di Google Apps Script.", "error");
            } else if (response.status === 404) {
                showNotification("Errore Cloud", "URL Cloud non trovato. Verifica il link Google Apps Script.", "error");
            } else {
                showNotification("Offline", "Caricamento dati locali (errore server cloud).", "warning");
            }
        } else {
            const jsonResponse = await response.json();

            if (jsonResponse && jsonResponse.status === "error") {
                showNotification("Errore Database Cloud", `Il server ha risposto: ${jsonResponse.message}. Assicurati che il foglio "Timeline" esista su Google Sheets.`, "alert");
                throw new Error("Cloud database error: " + jsonResponse.message);
            }

            const data = jsonResponse.data || jsonResponse; // Handle both {data: [...]} and [...]
            if (Array.isArray(data) && data.length > 0) {
                appState.measurements = data.map(m => ({
                    ...m,
                    total_weight: parseFloat(m.total_weight) || parseFloat(m.Biomassa) || 0, // Fallback to sheet headers if needed
                    food_amount: parseFloat(m.food_amount) || 0,
                    harvest_amount: parseFloat(m.harvest_amount) || 0,
                    adult_ratio: parseFloat(m.adult_ratio) || 0,
                    predicted_weight: parseFloat(m.predicted_weight) || 0,
                    health_index: parseFloat(m.health_index) || 0,
                    is_new_blood: m.is_new_blood === 'true' || m.is_new_blood === true
                })).sort((a, b) => new Date(a.date || a['Data Reale']) - new Date(b.date || b['Data Reale']));

                // Map Data Reale to date if needed
                appState.measurements.forEach(m => {
                    if(!m.date && m['Data Reale']) m.date = m['Data Reale'];
                });

                showNotification("Sincronizzazione", "Dati cloud caricati con successo.", "success");
                return;
            }
        }
    } catch (e) {
        console.warn("Could not fetch from GAS, falling back to local DB.", e);
        // Only show offline if it's a real network error (fetch threw an exception) and not a logical error we just threw
        if (!navigator.onLine) {
            showNotification("Offline", "Nessuna connessione a Internet. Caricamento dati locali.", "warning");
        } else if (!e.message || !e.message.includes("Cloud database error")) {
            showNotification("Errore di Rete", "Impossibile contattare il server cloud, ma sei online. Potrebbe essere un problema del server o di CORS. Caricamento dati locali.", "warning");
        }
    }

    // Load measurements from local fallback
    return new Promise((resolve) => {
        const measTx = db.transaction("measurements", "readonly");
        const measStore = measTx.objectStore("measurements");
        const measReq = measStore.getAll();
        
        measReq.onsuccess = () => {
            if (appState.measurements.length === 0) {
                appState.measurements = measReq.result.sort((a, b) => new Date(a.date) - new Date(b.date));
            }

            if (appState.measurements.length === 0) {
                showNotification("Nessun Dato Trovato", "Sia il Cloud che il Database locale sono vuoti. Clicca sul pulsante '+' in basso a destra per inserire la tua prima Rilevazione.", "warning");
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
 * Aggiorna la Tabella di Censimento Demografico nell'UI.
 * Implementa il Modulo 4 con tutte le colonne richieste dalla specifica.
 */
const updateCensusTable = (W_t, A_t) => {
    const dubiaModule = D();
    const tbody = document.querySelector('#censusTable tbody');
    if (!tbody) return;

    let rows;
    if (dubiaModule) {
        const censusData = dubiaModule.census(W_t, A_t);
        rows = dubiaModule.censusTable(censusData);
    } else {
        // Fallback: calcolo diretto
        const W_adulti  = W_t * A_t;
        const W_neanidi = W_t * (1 - A_t);
        rows = [
            { stage: 'Femmine Adulte',    N: Math.round(W_adulti * 0.77 / 2.5), biomassa_g: (W_adulti * 0.77).toFixed(1),  destinazione: 'Riproduttrici — mantenere' },
            { stage: 'Maschi Adulti',     N: Math.round(W_adulti * 0.23 / 1.5), biomassa_g: (W_adulti * 0.23).toFixed(1),  destinazione: 'Riproduttori — verificare sex ratio' },
            { stage: 'Neanidi Medie',     N: Math.round(W_neanidi * 0.70 / 0.8), biomassa_g: (W_neanidi * 0.70).toFixed(1), destinazione: 'Crescita — prelievo futuro' },
            { stage: 'Micro-Neanidi (Baby)', N: Math.round(W_neanidi * 0.30 / 0.1), biomassa_g: (W_neanidi * 0.30).toFixed(1), destinazione: 'Riserva — non prelevare' }
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

    // Census calculation (based on mass distribution approximation) using LATEST REAL weight
    const w = latest.total_weight;
    
    // Implement Dynamic Census Logic with Manual Calibrations
    const calibs = appState.params.manualCalibrations || {};
    let calibratedMass = 0;

    // First isolate the mass of manually calibrated categories
    for (const [cat, count] of Object.entries(calibs)) {
        calibratedMass += count * MASS[cat];
    }

    // Calculate original proportions of mass for uncalibrated categories
    const defaultRatios = {
        FEMALE: 0.35 * 0.77, // Adult ratio * Female ratio
        MALE: 0.35 * 0.23,
        SUBADULT: 0,
        MEDIUM: 0.65 * 0.70, // Nymph ratio * Medium ratio
        SMALL: 0,
        BABY: 0.65 * 0.30
    };

    let uncalibratedRatioSum = 0;
    for (const cat in defaultRatios) {
        if (calibs[cat] === undefined) {
            uncalibratedRatioSum += defaultRatios[cat];
        }
    }

    // Remaining biomass to distribute
    const remainingW = Math.max(0, w - calibratedMass);

    // Distribute remaining biomass
    let fCount = calibs['FEMALE'] !== undefined ? calibs['FEMALE'] : Math.round((remainingW * (defaultRatios.FEMALE / uncalibratedRatioSum)) / MASS.FEMALE);
    let mCount = calibs['MALE'] !== undefined ? calibs['MALE'] : Math.round((remainingW * (defaultRatios.MALE / uncalibratedRatioSum)) / MASS.MALE);
    let saCount = calibs['SUBADULT'] !== undefined ? calibs['SUBADULT'] : 0;
    let medCount = calibs['MEDIUM'] !== undefined ? calibs['MEDIUM'] : Math.round((remainingW * (defaultRatios.MEDIUM / uncalibratedRatioSum)) / MASS.MEDIUM);
    let smCount = calibs['SMALL'] !== undefined ? calibs['SMALL'] : 0;
    let bCount = calibs['BABY'] !== undefined ? calibs['BABY'] : Math.round((remainingW * (defaultRatios.BABY / uncalibratedRatioSum)) / MASS.BABY);

    let totalCount = fCount + mCount + saCount + medCount + smCount + bCount;

    // Economic Value Calculator
    // Prices per individual (approximate example prices in EUR)
    const prices = {
        FEMALE: 0.50,
        MALE: 0.40,
        SUBADULT: 0.30,
        MEDIUM: 0.20,
        SMALL: 0.10,
        BABY: 0.05
    };
    const economicValue = (fCount * prices.FEMALE) + (mCount * prices.MALE) + (saCount * prices.SUBADULT) + (medCount * prices.MEDIUM) + (smCount * prices.SMALL) + (bCount * prices.BABY);
    const economicValueEl = document.getElementById('economicValueValue');
    if (economicValueEl) economicValueEl.innerText = `${economicValue.toFixed(2)} €`;

    // Water/Wet Food Need Calculator
    // Recommendation: approx 20-30% of their body weight in wet food/water per week, roughly 3-4% per day.
    const waterNeed = latest.total_weight * 0.035;
    const waterNeedEl = document.getElementById('waterNeedValue');
    if (waterNeedEl) waterNeedEl.innerText = `${waterNeed.toFixed(1)} g/giorno`;

    // Sex Ratio calculation
    if (fCount > 0) {
        const ratio = mCount / fCount;
        document.getElementById('sexRatioValue').innerText = `1 : ${(1/ratio).toFixed(1)}`;
        const statusEl = document.getElementById('sexRatioStatus');
        const cardEl = document.getElementById('sexRatioCard');

        // Optimal ratio is often considered 1:3 to 1:5 (males to females) -> 0.2 to 0.33
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
            statusEl.style.color = "#F2C94C"; // Warning yellow
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

    // Maturation Timer
    const maturationCard = document.getElementById('maturationTimerCard');
    const maturationText = document.getElementById('maturationTimerText');
    if (maturationCard && maturationText) {
        maturationCard.style.display = 'block';
        // Base growth rates could be derived from theta2, but simplified for now based on average Dubia lifecycle
        // Baby -> Small (30 days) -> Medium (30 days) -> Sub-Adult (40 days) -> Adult

        let daysToNext = 30; // default
        let baseMsg = "";

        // Find the current peak
        const pops = [
            { name: "Micro-Neanidi", count: bCount, next: "Neanidi Piccole", days: 30 },
            { name: "Neanidi Piccole", count: smCount, next: "Neanidi Medie", days: 30 },
            { name: "Neanidi Medie", count: medCount, next: "Sub-Adulte", days: 40 },
            { name: "Sub-Adulte", count: saCount, next: "Adulte", days: 30 }
        ];

        pops.sort((a, b) => b.count - a.count);
        const peak = pops[0];

        // Calcola i giorni in base a theta2 e temperatura/condizioni.
        // Use an inverse relation to health index / theta2.
        // Higher theta2 = faster growth.
        // Let's create a "growth multiplier" based on theta2 (default 0.01)
        const growthSpeed = Math.max(0.5, Math.min(2.0, appState.params.theta2 / 0.01));
        const estimatedDays = Math.round(peak.days / growthSpeed);

        if (peak.count > (totalCount * 0.2)) { // if peak is significant
            maturationText.innerText = `Il picco attuale (${peak.name}) impiegherà circa ${estimatedDays} giorni per mutare in ${peak.next}.`;
        } else {
            maturationText.innerText = "Distribuzione stabile. Nessun picco imminente rilevato.";
        }
    }

    // Update Progress Bars based on relative population counts
    document.getElementById('barFemale').style.width = `${(fCount/totalCount)*100 * 3}%`; // Multiplier for visual effect
    document.getElementById('barMale').style.width = `${(mCount/totalCount)*100 * 3}%`;
    document.getElementById('barSubAdult').style.width = `${(saCount/totalCount)*100 * 3}%`;
    document.getElementById('barMedium').style.width = `${(medCount/totalCount)*100 * 3}%`;
    document.getElementById('barSmall').style.width = `${(smCount/totalCount)*100 * 3}%`;
    document.getElementById('barBaby').style.width = `${(bCount/totalCount)*100 * 3}%`;

    // Update Census Chart (Modulo 4 — 4 stadi D.U.B.I.A.)
    const ctxCensus = document.getElementById('censusChart');
    if (ctxCensus) {
        if (appState.charts.census) {
            appState.charts.census.destroy();
        }

        // Usa i 4 stadi ufficiali del Modulo 4
        const censusModuleRef = D();
        let chartLabels, chartData, chartColors;
        if (censusModuleRef && appState.measurements.length > 0) {
            const lm = appState.measurements[appState.measurements.length - 1];
            const cd = censusModuleRef.census(lm.total_weight, lm.adult_ratio || 0.35);
            chartLabels = [
                `Femmine (${cd.N_femmine})`,
                `Maschi (${cd.N_maschi})`,
                `Neanidi Medie (${cd.N_medie})`,
                `Baby (${cd.N_baby})`
            ];
            chartData   = [cd.N_femmine, cd.N_maschi, cd.N_medie, cd.N_baby];
            chartColors = ['#9b59b6', '#3498db', '#2ecc71', '#f1c40f'];
        } else {
            chartLabels = ['Femmine', 'Maschi', 'Neanidi Medie', 'Baby'];
            chartData   = [fCount, mCount, medCount, bCount];
            chartColors = ['#9b59b6', '#3498db', '#2ecc71', '#f1c40f'];
        }

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
        updateCensusTable(
            latestForCensus.total_weight,
            latestForCensus.adult_ratio || 0.35
        );
    }

    // Aggiorna il Pregnant Ratio basandosi sull'errore reale/predetto
    if (appState.measurements.length > 1) {
        const prev = appState.measurements[appState.measurements.length - 2];
        const curr = appState.measurements[appState.measurements.length - 1];
        const census = D() ? D().census(curr.total_weight, curr.adult_ratio || 0.35) : null;
        if (census) {
            // Stima femmine gravide: delta peso rispetto predetto / (0.4g * N_femmine)
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
    const ctxHealth = document.getElementById('healthChart').getContext('2d');
    if (appState.charts.health) appState.charts.health.destroy();

    appState.charts.health = new Chart(ctxHealth, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Indice Salute H (%)',
                data: healthData,
                borderColor: '#3498db',
                backgroundColor: 'rgba(52, 152, 219, 0.1)',
                borderWidth: 2,
                tension: 0.3,
                fill: true
            }]
        },
        options: {
            responsive: true,
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return 'Indice Salute: ' + context.parsed.y.toFixed(1) + '%';
                        },
                        afterBody: function(tooltipItems) {
                            const dataIndex = tooltipItems[0].dataIndex;
                            if (notesData[dataIndex]) {
                                return '\nNote: ' + notesData[dataIndex] + '\n(Clicca sul punto per i dettagli)';
                            }
                            return '';
                        }
                    }
                },
                annotation: { // Conceptual, requires chartjs-plugin-annotation for actual line drawing
                    annotations: {
                        line1: { type: 'line', yMin: 75, yMax: 75, borderColor: '#C0292B', borderWidth: 1, borderDash: [2,2] }
                    }
                }
            },
            scales: {
                y: { min: 50, max: 120, grid: { color: 'rgba(255,255,255,0.05)' } }
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
            document.getElementById('inputFoodAmount').required = true;
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

        await processNewMeasurement(date, weight, foodAmount, adultRatio, notes, harvestAmount, false, true, eventType);
        
        modal.classList.remove('active');
        form.reset();
        document.getElementById('inputDate').valueAsDate = new Date();

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
