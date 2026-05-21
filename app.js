/**
 * D.U.B.I.A. Engine - Dynamic Updating Biomass Inference Algorithm
 */

// Constants & Configurations
const GAS_URL = "https://script.google.com/macros/s/AKfycbzaGa6lBBCvmHShCMymnDm9Nd1Ht1gtZ83PpMdbvR7DeObLpzR60KySLttAC7zCV6KNVQ/exec";
const ALPHA = 1e-6; // Learning rate for gradient descent
const DEFAULT_PARAMS = {
    theta1: 0.05, // Resa Alimentazione
    theta2: 0.01, // Crescita Neanidi
    mortalityRate: 1.5 // Mortalità Mensile (%)
};
const HEALTH_THRESHOLD_WARNING = 90;
const HEALTH_THRESHOLD_ALERT = 75;

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
        // Only show offline if it's a real network error (fetch threw an exception)
        if (!navigator.onLine) {
            showNotification("Offline", "Nessuna connessione a Internet. Caricamento dati locali.", "warning");
        } else {
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

const seedDataIfEmpty = async () => {
    if (appState.measurements.length === 0) {
        console.log("Seeding database with initial data...");
                const seedData = [
            { date: '2026-01-01', weight: 600, foodAmount: 50, adultRatio: 0.35, notes: 'Dati Storici' },
            { date: '2026-02-05', weight: 950, foodAmount: 150, adultRatio: 0.35, notes: 'Dati Storici' },
            { date: '2026-03-08', weight: 1250, foodAmount: 120, adultRatio: 0.35, notes: 'Dati Storici' },
            { date: '2026-03-21', weight: 1420, foodAmount: 180, adultRatio: 0.35, notes: 'Dati Storici' },
            { date: '2026-04-11', weight: 1520, foodAmount: 60, adultRatio: 0.35, notes: 'Dati Storici' },
            { date: '2026-05-01', weight: 1850, foodAmount: 200, adultRatio: 0.35, notes: 'Dati Storici' }
        ];

        for (const m of seedData) {
            await processNewMeasurement(m.date, m.weight, m.foodAmount, m.adultRatio, m.notes);
        }
    }
};


// --- ML ENGINE (D.U.B.I.A.) ---

const calculatePrediction = (lastWeight, foodAmount, adultRatio, delta_g, params, harvestAmount = 0) => {
    // W_pred = W_curr + (theta1 * C_t) + (theta2 * W_curr * (1 - A_t) * (delta_g / 30))
    let w_pred = lastWeight + (params.theta1 * foodAmount) + (params.theta2 * (lastWeight * (1 - adultRatio)) * (delta_g / 30));
    // Applica Mortalità Fisiologica (proporzionale ai giorni delta_g rispetto a 30)
    let mortalityRate = params.mortalityRate || 1.5;
    let mortalityFactor = (mortalityRate / 100) * (delta_g / 30);
    w_pred = w_pred * (1 - mortalityFactor);
    // Sottrai prelievo
    w_pred -= harvestAmount;
    return Math.max(0, w_pred);
};

const processNewMeasurement = async (date, realWeight, foodAmount, adultRatio, notes, harvestAmount = 0, isNewBlood = false) => {
    const lastMeasurement = appState.measurements.length > 0 
        ? appState.measurements[appState.measurements.length - 1] 
        : null;

    let predictedWeight = realWeight; // Default if first time
    let healthIndex = 100;
    let delta_g = 30; // default for the first measurement if needed

    if (lastMeasurement) {
        const d1 = new Date(lastMeasurement.date);
        const d2 = new Date(date);
        const timeDiff = Math.abs(d2.getTime() - d1.getTime());
        delta_g = Math.max(1, Math.ceil(timeDiff / (1000 * 3600 * 24))); // Ensure at least 1 day to avoid 0

        predictedWeight = calculatePrediction(lastMeasurement.total_weight, foodAmount, adultRatio, delta_g, appState.params, harvestAmount);
        
        // Calculate Error (E = W_pred - W_real in text, actually text says E = W_pred - W_real. Wait: "E = W_pred - W_real". Then theta1_new = theta1_old - (alpha * E * C_t).
        const error = predictedWeight - realWeight;
        
        // Gradient Descent Update
        const newTheta1 = appState.params.theta1 - (ALPHA * error * foodAmount);
        const newTheta2 = appState.params.theta2 - (ALPHA * error * (lastMeasurement.total_weight * (1 - adultRatio) * (delta_g / 30)));
        
        appState.params.theta1 = Math.max(0, newTheta1); // Prevent negative efficiencies
        appState.params.theta2 = Math.max(0, newTheta2);
        saveParams(appState.params);

        // Health Index: (Real / Pred) * 100
        healthIndex = (realWeight / predictedWeight) * 100;
        
        checkHealthThresholds(healthIndex);
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
        health_index: healthIndex
    };

    await saveMeasurement(measurement);
    updateUI();
};

const checkHealthThresholds = (healthIndex) => {
    if (healthIndex < HEALTH_THRESHOLD_ALERT) {
        showNotification("ALLARME CRITICO", `L'Indice di Salute è sceso al ${healthIndex.toFixed(1)}%. Rilevato crollo di \u03B8\u2081: potenziale problema di qualità del cibo o disidratazione.`, "alert");
    } else if (healthIndex < HEALTH_THRESHOLD_WARNING) {
        showNotification("Attenzione", `L'Indice di Salute è al ${healthIndex.toFixed(1)}%. Monitorare la colonia.`, "warning");
    }
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

    const healthEl = document.getElementById('healthValue');
    healthEl.innerText = `${latest.health_index.toFixed(1)}%`;
    healthEl.className = 'health-value';
    if (latest.health_index < HEALTH_THRESHOLD_ALERT) healthEl.classList.add('alert');
    else if (latest.health_index < HEALTH_THRESHOLD_WARNING) healthEl.classList.add('warning');

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

    // Census calculation (based on mass distribution approximation) using FUTURE predicted weight
    const w = futurePred;
    
    // Approximated mass distribution
    const fCount = Math.round((w * lastAdultRatio) / MASS.FEMALE);
    // The rest is distributed according to previous logic, scaled by remaining ratio
    const remainingRatio = 1 - lastAdultRatio;
    const mCount = Math.round((w * 0.10) / MASS.MALE); // Let's keep fixed ratios for others, or scaled. Let's just keep original fixed proportions relative to total for simplicity, but adult female as the adult_ratio.
    const saCount = Math.round((w * 0.20) / MASS.SUBADULT);
    const medCount = Math.round((w * 0.20) / MASS.MEDIUM);
    const smCount = Math.round((w * 0.10) / MASS.SMALL);
    const bCount = Math.round((w * 0.05) / MASS.BABY);

    const totalCount = fCount + mCount + saCount + medCount + smCount + bCount;

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

    // Update Census Chart
    const ctxCensus = document.getElementById('censusChart');
    if (ctxCensus) {
        if (appState.charts.census) {
            appState.charts.census.destroy();
        }
        appState.charts.census = new Chart(ctxCensus.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: ['Femmine', 'Maschi', 'Sub-Adulte', 'Medie', 'Piccole', 'Micro'],
                datasets: [{
                    data: [fCount, mCount, saCount, medCount, smCount, bCount],
                    backgroundColor: [
                        '#9b59b6', // var(--accent-purple)
                        '#8e44ad', // darker purple
                        '#3498db', // blue
                        '#2ecc71', // var(--accent-green)
                        '#27ae60', // darker green
                        '#f1c40f'  // yellow
                    ],
                    borderWidth: 0,
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            color: 'white',
                            font: { size: 10 }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                const value = context.raw;
                                const percentage = total > 0 ? Math.round((value / total) * 100) : 0;
                                return `${context.label}: ${value} (${percentage}%)`;
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
        await seedDataIfEmpty();
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
            saveParams(appState.params);

            // Record a calibration event
            const todayDate = new Date().toISOString().split('T')[0];
            await processNewMeasurement(
                todayDate,
                currentWeight,
                0, // 0 food for calibration event
                newAdultRatio,
                `[Calibrazione] Conteggio reale: ${count} ${category}`
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

    fab.addEventListener('click', () => modal.classList.add('active'));
    btnCancel.addEventListener('click', () => modal.classList.remove('active'));

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const date = document.getElementById('inputDate').value;
        const weight = parseFloat(document.getElementById('inputWeight').value);
        const foodAmount = parseFloat(document.getElementById('inputFoodAmount').value);
        const adultRatio = parseFloat(document.getElementById('inputAdultRatio').value);
        const notes = document.getElementById('inputNotes').value;
        const harvestAmount = parseFloat(document.getElementById('inputHarvestAmount')?.value) || 0;

        await processNewMeasurement(date, weight, foodAmount, adultRatio, notes, harvestAmount, false);
        
        modal.classList.remove('active');
        form.reset();
        document.getElementById('inputDate').valueAsDate = new Date();

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
                true
            );

            showNotification("Successo", "Nuova linea genetica registrata con successo.", "success");
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
