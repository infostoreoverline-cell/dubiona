/**
 * D.U.B.I.A. Engine - Dynamic Updating Biomass Inference Algorithm
 */

// Constants & Configurations
const ALPHA = 0.0001; // Learning rate for gradient descent
const DEFAULT_PARAMS = {
    theta_pastura: 0.05,
    theta_verdure: 0.02,
    theta_lattuga: 0.005,
    theta2: 0.01 // natural growth
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
            { date: '2026-01-01', weight: 600, foodType: 'verdure', notes: 'Dati Storici' },
            { date: '2026-02-01', weight: 900, foodType: 'pastura', notes: 'Dati Storici' },
            { date: '2026-03-01', weight: 1150, foodType: 'verdure', notes: 'Dati Storici' },
            { date: '2026-03-20', weight: 1420, foodType: 'pastura', notes: 'Dati Storici' },
            { date: '2026-04-10', weight: 1520, foodType: 'lattuga', notes: 'Dati Storici' },
            { date: '2026-05-01', weight: 1850, foodType: 'pastura', notes: 'Dati Storici' }
        ];

        for (const m of seedData) {
            await processNewMeasurement(m.date, m.weight, m.foodType, m.notes);
        }
    }
};


// --- ML ENGINE (D.U.B.I.A.) ---

const calculatePrediction = (lastWeight, foodType, params) => {
    // W_pred = W_curr + (theta_food * W_curr) + (theta2 * W_curr)
    const theta_food = params[`theta_${foodType}`] || 0;
    return lastWeight + (theta_food * lastWeight) + (params.theta2 * lastWeight);
};

const processNewMeasurement = async (date, realWeight, foodType, notes) => {
    const lastMeasurement = appState.measurements.length > 0 
        ? appState.measurements[appState.measurements.length - 1] 
        : null;

    let predictedWeight = realWeight; // Default if first time
    let healthIndex = 100;

    if (lastMeasurement) {
        predictedWeight = calculatePrediction(lastMeasurement.total_weight, foodType, appState.params);
        
        // Calculate Error
        const error = realWeight - predictedWeight;
        
        // Gradient Descent Update
        const thetaKey = `theta_${foodType}`;
        const newThetaFood = appState.params[thetaKey] + (ALPHA * error * lastMeasurement.total_weight);
        const newTheta2 = appState.params.theta2 + (ALPHA * error * lastMeasurement.total_weight);
        
        appState.params[thetaKey] = Math.max(0, newThetaFood); // Prevent negative efficiencies
        appState.params.theta2 = Math.max(0, newTheta2);
        saveParams(appState.params);

        // Health Index: (Real / Pred) * 100
        healthIndex = (realWeight / predictedWeight) * 100;
        
        checkHealthThresholds(healthIndex);
    }

    const measurement = {
        date,
        total_weight: realWeight,
        food_type: foodType,
        notes,
        predicted_weight: predictedWeight,
        health_index: healthIndex
    };

    await saveMeasurement(measurement);
    updateUI();
};

const checkHealthThresholds = (healthIndex) => {
    if (healthIndex < HEALTH_THRESHOLD_ALERT) {
        showNotification("ALLARME CRITICO", `L'Indice di Salute è sceso al ${healthIndex.toFixed(1)}%. Controllare immediatamente umidità, temperature o qualità del cibo.`, "alert");
    } else if (healthIndex < HEALTH_THRESHOLD_WARNING) {
        showNotification("Attenzione", `L'Indice di Salute è al ${healthIndex.toFixed(1)}%. Monitorare la colonia.`, "warning");
    }
};

// --- UI UPDATES ---

const updateUI = () => {
    if (appState.measurements.length === 0) return;

    const latest = appState.measurements[appState.measurements.length - 1];

    // Dashboard
    document.getElementById('realWeightValue').innerText = `${latest.total_weight.toFixed(1)} g`;
    document.getElementById('predWeightValue').innerText = `${latest.predicted_weight.toFixed(1)} g`;
    const lastFoodType = latest.food_type || 'pastura';
    document.getElementById('theta1Value').innerText = (appState.params[`theta_${lastFoodType}`] || 0).toFixed(4);
    document.getElementById('theta2Value').innerText = appState.params.theta2.toFixed(4);

    const healthEl = document.getElementById('healthValue');
    healthEl.innerText = `${latest.health_index.toFixed(1)}%`;
    healthEl.className = 'health-value';
    if (latest.health_index < HEALTH_THRESHOLD_ALERT) healthEl.classList.add('alert');
    else if (latest.health_index < HEALTH_THRESHOLD_WARNING) healthEl.classList.add('warning');

    // Census calculation (based on mass distribution approximation)
    const w = latest.total_weight;
    
    // Approximated mass distribution
    const fCount = Math.round((w * 0.35) / MASS.FEMALE);
    const mCount = Math.round((w * 0.10) / MASS.MALE);
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
        const foodDisplay = m.food_type ? m.food_type.charAt(0).toUpperCase() + m.food_type.slice(1) : '-';
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

    // Set today's date as default
    document.getElementById('inputDate').valueAsDate = new Date();

    fab.addEventListener('click', () => modal.classList.add('active'));
    btnCancel.addEventListener('click', () => modal.classList.remove('active'));

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const date = document.getElementById('inputDate').value;
        const weight = parseFloat(document.getElementById('inputWeight').value);
        const foodType = document.getElementById('inputFoodType').value;
        const notes = document.getElementById('inputNotes').value;

        await processNewMeasurement(date, weight, foodType, notes);
        
        modal.classList.remove('active');
        form.reset();
        document.getElementById('inputDate').valueAsDate = new Date();
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
