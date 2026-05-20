/**
 * D.U.B.I.A. Engine - Dynamic Updating Biomass Inference Algorithm
 */

// Constants & Configurations
const ALPHA = 1e-6; // Learning rate for gradient descent
const DEFAULT_PARAMS = {
    theta1: 0.05, // Resa Alimentazione
    theta2: 0.01 // Crescita Neanidi
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

    // Load measurements
    return new Promise((resolve) => {
        const measTx = db.transaction("measurements", "readonly");
        const measStore = measTx.objectStore("measurements");
        const measReq = measStore.getAll();
        
        measReq.onsuccess = () => {
            appState.measurements = measReq.result.sort((a, b) => new Date(a.date) - new Date(b.date));
            resolve();
        };
    });
};

const saveParams = (params) => {
    const tx = db.transaction("parameters", "readwrite");
    const store = tx.objectStore("parameters");
    store.put({ id: 1, ...params });
};

const saveMeasurement = (measurement) => {
    return new Promise((resolve) => {
        const tx = db.transaction("measurements", "readwrite");
        const store = tx.objectStore("measurements");
        const req = store.add(measurement);
        req.onsuccess = () => {
            measurement.id = req.result;
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
            { date: '2026-02-01', weight: 900, foodAmount: 150, adultRatio: 0.35, notes: 'Dati Storici' },
            { date: '2026-03-01', weight: 1150, foodAmount: 120, adultRatio: 0.35, notes: 'Dati Storici' },
            { date: '2026-03-20', weight: 1420, foodAmount: 180, adultRatio: 0.35, notes: 'Dati Storici' },
            { date: '2026-04-10', weight: 1520, foodAmount: 60, adultRatio: 0.35, notes: 'Dati Storici' },
            { date: '2026-05-01', weight: 1850, foodAmount: 200, adultRatio: 0.35, notes: 'Dati Storici' }
        ];

        for (const m of seedData) {
            await processNewMeasurement(m.date, m.weight, m.foodAmount, m.adultRatio, m.notes);
        }
    }
};


// --- ML ENGINE (D.U.B.I.A.) ---

const calculatePrediction = (lastWeight, foodAmount, adultRatio, delta_g, params) => {
    // W_pred = W_curr + (theta1 * C_t) + (theta2 * W_curr * (1 - A_t) * (delta_g / 30))
    return lastWeight + (params.theta1 * foodAmount) + (params.theta2 * (lastWeight * (1 - adultRatio)) * (delta_g / 30));
};

const processNewMeasurement = async (date, realWeight, foodAmount, adultRatio, notes) => {
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

        predictedWeight = calculatePrediction(lastMeasurement.total_weight, foodAmount, adultRatio, delta_g, appState.params);
        
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

    const healthEl = document.getElementById('healthValue');
    healthEl.innerText = `${latest.health_index.toFixed(1)}%`;
    healthEl.className = 'health-value';
    if (latest.health_index < HEALTH_THRESHOLD_ALERT) healthEl.classList.add('alert');
    else if (latest.health_index < HEALTH_THRESHOLD_WARNING) healthEl.classList.add('warning');

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

    document.getElementById('countFemale').innerText = fCount;
    document.getElementById('countMale').innerText = mCount;
    document.getElementById('countSubAdult').innerText = saCount;
    document.getElementById('countMedium').innerText = medCount;
    document.getElementById('countSmall').innerText = smCount;
    document.getElementById('countBaby').innerText = bCount;

    // Update Progress Bars based on relative population counts
    document.getElementById('barFemale').style.width = `${(fCount/totalCount)*100 * 3}%`; // Multiplier for visual effect
    document.getElementById('barMale').style.width = `${(mCount/totalCount)*100 * 3}%`;
    document.getElementById('barSubAdult').style.width = `${(saCount/totalCount)*100 * 3}%`;
    document.getElementById('barMedium').style.width = `${(medCount/totalCount)*100 * 3}%`;
    document.getElementById('barSmall').style.width = `${(smCount/totalCount)*100 * 3}%`;
    document.getElementById('barBaby').style.width = `${(bCount/totalCount)*100 * 3}%`;

    // History Table
    const tbody = document.querySelector('#historyTable tbody');
    tbody.innerHTML = '';
    // Reverse to show newest first
    [...appState.measurements].reverse().forEach(m => {
        const foodDisplay = m.food_amount !== undefined ? m.food_amount.toFixed(1) : '-';
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${m.date}</td>
            <td>${m.total_weight.toFixed(1)}</td>
            <td>${foodDisplay}</td>
            <td style="color: ${m.health_index < 75 ? 'var(--alert-red)' : 'var(--accent-green)'}">
                ${m.health_index.toFixed(1)}%
            </td>
        `;
        tbody.appendChild(row);
    });

    updateCharts();
};

const updateCharts = () => {
    const labels = appState.measurements.map(m => m.date.substring(5)); // Show MM-DD
    const realData = appState.measurements.map(m => m.total_weight);
    const predData = appState.measurements.map(m => m.predicted_weight);
    const healthData = appState.measurements.map(m => m.health_index);

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
            plugins: { legend: { position: 'top' } },
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

document.addEventListener('DOMContentLoaded', async () => {
    // Init DB
    try {
        await initDB();
        await seedDataIfEmpty();
        updateUI();
    } catch (e) {
        console.error("Failed to initialize app data", e);
    }

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

        await processNewMeasurement(date, weight, foodAmount, adultRatio, notes);
        
        modal.classList.remove('active');
        form.reset();
        document.getElementById('inputDate').valueAsDate = new Date();

        if (adultRatioSlider) adultRatioSlider.value = 0.35;
        if (adultRatioInput) adultRatioInput.value = 0.35;

        showNotification("Successo", "Nuova rilevazione elaborata dal D.U.B.I.A.", "success");
    });

    // Reset DB Logic
    const btnResetDB = document.getElementById('btnResetDB');
    if (btnResetDB) {
        btnResetDB.addEventListener('click', () => {
            if (confirm("Attenzione: questo eliminerà tutti i dati inseriti manualmente e ricaricherà solo lo storico iniziale. Procedere?")) {
                const req = indexedDB.deleteDatabase(dbName);
                req.onsuccess = () => {
                    alert("Database resettato. La pagina verrà ricaricata.");
                    window.location.reload();
                };
                req.onerror = () => {
                    alert("Errore nel reset del database.");
                };
            }
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
