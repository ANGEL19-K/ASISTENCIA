/* =========================================================
   CONFIGURACIÓN SUPABASE
========================================================= */
const SUPABASE_URL = 'https://bxrhjuayvyltygxfwfqj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Uez5cTomAgpd4tlee0wyXA_ZOA8kME4';
const dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let STORE = { lat: -4.928689, lng: -80.658650, radiusMeters: 500000000};
const DEFAULT_NAME = "Personal no identificado";

let map, markerSelf, circleStore;
let myPosition = null;
let insideRadius = false;
let stream = null;
let detecting = false;
let labeledDescriptors = []; 
let recognized = null;
let modoActual = 'entrada'; // 'entrada' o 'salida'

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const cameraStatus = $("cameraStatus");
const locStatus = $("locStatus");
const empName = $("empName");
const empTime = $("empTime");
const empStatus = $("empStatus");
const empDistance = $("empDistance");
const empDate = $("empDate");
const historyList = $("historyList");

/* =========================================================
   UTILIDADES Y NAVEGACIÓN
========================================================= */
function haversine(a, b) {
  const R = 6371000;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function formatTime(d = new Date()) {
  return d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function formatDate(d = new Date()) {
  return d.toLocaleDateString("es-PE", { day: "2-digit", month: "long", year: "numeric" });
}

setInterval(() => {
  const el = $("currentTime");
  if (el) el.textContent = formatTime();
}, 1000);

// Navegación entre pantallas
window.seleccionarModo = (modo) => {
  modoActual = modo;
  $("pantallaInicio").style.display = 'none';
  $("mainHeader").style.display = 'flex';
  $("sistemaReloj").style.display = 'flex';
  $("textoModoActual").textContent = modo.toUpperCase();
  
  // Iniciar cámara automáticamente al entrar
  startDetection();
};

window.volverInicio = () => {
  detecting = false;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $("mainHeader").style.display = 'none';
  $("sistemaReloj").style.display = 'none';
  $("pantallaInicio").style.display = 'block';
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  cameraStatus.textContent = "Cámara detenida";
  $("btnStart").disabled = false;
  $("btnStop").disabled = true;
};

/* =========================================================
   SUPABASE: CARGAR CONFIGURACIÓN Y PERSONAL
========================================================= */
async function cargarConfiguracion() {
  try {
    const { data } = await dbClient.from('configuracion').select('*').eq('id', 1).single();
    if (data) {
      STORE.lat = data.lat;
      STORE.lng = data.lng;
      STORE.radiusMeters = data.radio; 
    }
  } catch (e) { console.warn("Usando configuración por defecto."); }
}

async function cargarPersonalDesdeSupabase() {
  cameraStatus.textContent = "Sincronizando base de datos...";
  try {
    const { data, error } = await dbClient.from('personal').select('nombre, face_descriptor');
    if (error) throw error;

    labeledDescriptors = data.filter(p => p.face_descriptor).map(p => ({
      label: p.nombre,
      descriptors: [new Float32Array(p.face_descriptor)]
    }));

    cameraStatus.textContent = labeledDescriptors.length > 0 
      ? `Sistema listo (${labeledDescriptors.length} registros)` 
      : "Sin registros en base de datos";
  } catch (error) {
    console.error("Error cargando personal:", error);
    cameraStatus.textContent = "Error de conexión";
  }
}

const tempCanvas = document.createElement('canvas');

async function procesarAsistencia(nombre) {
  const hoy = new Date();
  const fechaStr = hoy.toISOString().split('T')[0];
  const horaStr = hoy.toTimeString().split(' ')[0];

  // ==========================================
  // LÓGICA DE SALIDA
  // ==========================================
  if (modoActual === 'salida') {
    const { data } = await dbClient.from('asistencias').select('id, hora, hora_salida').eq('nombre', nombre).eq('fecha', fechaStr);
    
    if (!data || data.length === 0) {
      empStatus.textContent = "No registró entrada hoy";
      empStatus.style.color = "#ef4444";
      cameraStatus.textContent = "Error: No hay entrada registrada hoy.";
      return;
    }

    const registro = data[0];
    if (registro.hora_salida) {
      empStatus.textContent = "Salida ya registrada";
      empStatus.style.color = "#f59e0b";
      cameraStatus.textContent = "Ya marcaste tu salida hoy.";
      return;
    }

    cameraStatus.textContent = "Subiendo evidencia de salida...";
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Captura de imagen para la salida
    tempCanvas.width = video.videoWidth || 640;
    tempCanvas.height = video.videoHeight || 480;
    tempCanvas.getContext('2d').drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
    const blob = await new Promise(resolve => tempCanvas.toBlob(resolve, 'image/jpeg', 0.85));
    const fileName = `salida_${Date.now()}_${nombre.replace(/\s+/g, '_')}.jpg`;

    // Subir imagen de salida
    const { error: uploadError } = await dbClient.storage.from('evidencias_asistencia').upload(fileName, blob, { contentType: 'image/jpeg' });
    let fotoSalidaUrl = null;
    
    if (!uploadError) {
      const { data: urlData } = dbClient.storage.from('evidencias_asistencia').getPublicUrl(fileName);
      fotoSalidaUrl = urlData.publicUrl;
    } else {
      console.error("Error subiendo foto de salida:", uploadError);
    }

    // Actualizar la base de datos con la hora Y la foto de salida
    const { error: updateError } = await dbClient.from('asistencias').update({ 
      hora_salida: horaStr,
      foto_salida: fotoSalidaUrl 
    }).eq('id', registro.id);

    if (!updateError) {
      empStatus.textContent = "Salida registrada";
      empStatus.style.color = "#10b981";
      cameraStatus.textContent = `Salida exitosa: ${nombre}`;
      
      if (historyList.querySelector('.empty-state')) historyList.innerHTML = '';
      historyList.insertAdjacentHTML('afterbegin', `
        <li><span class="h-name">${nombre} (Salida)</span><span class="h-time">${formatTime()}</span></li>
      `);
    } else {
      alert("Error al guardar salida: " + updateError.message);
    }
    return;
  }

  // ==========================================
  // LÓGICA DE ENTRADA (Se mantiene igual)
  // ==========================================
  const { data } = await dbClient.from('asistencias').select('id').eq('nombre', nombre).eq('fecha', fechaStr);

  if (data && data.length > 0) {
    empStatus.textContent = "Entrada ya registrada hoy";
    empStatus.style.color = "#f59e0b";
    cameraStatus.textContent = "Asistencia ya registrada hoy";
    return;
  }

  cameraStatus.textContent = "Subiendo evidencia...";
  await new Promise(resolve => setTimeout(resolve, 300));
  
  tempCanvas.width = video.videoWidth || 640;
  tempCanvas.height = video.videoHeight || 480;
  tempCanvas.getContext('2d').drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
  const blob = await new Promise(resolve => tempCanvas.toBlob(resolve, 'image/jpeg', 0.85));
  const fileName = `entrada_${Date.now()}_${nombre.replace(/\s+/g, '_')}.jpg`;

  const { error: uploadError } = await dbClient.storage.from('evidencias_asistencia').upload(fileName, blob, { contentType: 'image/jpeg' });
  let fotoUrl = null;
  if (!uploadError) {
    const { data: urlData } = dbClient.storage.from('evidencias_asistencia').getPublicUrl(fileName);
    fotoUrl = urlData.publicUrl;
  }

  const { error: dbError } = await dbClient.from('asistencias').insert([{
    nombre: nombre, fecha: fechaStr, hora: horaStr, distancia: empDistance.textContent, foto_evidencia: fotoUrl
  }]);

  if (!dbError) {
    empStatus.textContent = "Entrada registrada";
    empStatus.style.color = "#10b981";
    cameraStatus.textContent = `Entrada exitosa: ${nombre}`;
    
    if (historyList.querySelector('.empty-state')) historyList.innerHTML = '';
    historyList.insertAdjacentHTML('afterbegin', `
      <li><span class="h-name">${nombre} (Entrada)</span><span class="h-time">${formatTime()}</span></li>
    `);
  } else {
    alert("Error en base de datos: " + dbError.message);
  }
}

/* =========================================================
   MAPA Y GEOLOCALIZACIÓN
========================================================= */
function initMap() {
  map = L.map("map", { zoomControl: false }).setView([STORE.lat, STORE.lng], 17);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  circleStore = L.circle([STORE.lat, STORE.lng], { radius: STORE.radiusMeters, color: "#0284c7", fillColor: "#0284c7", fillOpacity: 0.15, weight: 2 }).addTo(map);
  L.marker([STORE.lat, STORE.lng]).addTo(map).bindPopup(`<b>Almacén Central</b>`);
  markerSelf = L.circleMarker([STORE.lat, STORE.lng], { radius: 8, color: "#10b981", fillColor: "#10b981", fillOpacity: 1 }).addTo(map);
}

function initGeolocation() {
  navigator.geolocation.watchPosition((pos) => {
    myPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const dist = haversine(myPosition, STORE);
    if (markerSelf) markerSelf.setLatLng([myPosition.lat, myPosition.lng]);
    map.setView([myPosition.lat, myPosition.lng], 17);
    const distText = dist < 1000 ? `${dist.toFixed(0)} m` : `${(dist / 1000).toFixed(2)} km`;
    empDistance.textContent = distText;
    if (dist <= STORE.radiusMeters) {
      insideRadius = true;
      locStatus.textContent = "Dentro del área";
      locStatus.className = "status-badge ok";
    } else {
      insideRadius = false;
      locStatus.textContent = "Fuera del área";
      locStatus.className = "status-badge bad";
    }
  }, (err) => { locStatus.textContent = "Error de GPS"; }, { enableHighAccuracy: true, timeout: 15000 });
}

/* =========================================================
   CÁMARA Y RECONOCIMIENTO
========================================================= */
async function loadModels() {
  const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";
  await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
  await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
    video.srcObject = stream;
    await video.play();
  } catch (e) { cameraStatus.textContent = "Error de cámara"; }
}

function buildFaceMatcher() {
  const labeled = labeledDescriptors.map(l => new faceapi.LabeledFaceDescriptors(l.label, l.descriptors));
  return labeled.length ? new faceapi.FaceMatcher(labeled, 0.55) : null;
}

async function startDetection() {
  $("btnStart").disabled = true;
  if (!stream) await startCamera();
  if (!stream) return;
  detecting = true;
  $("btnStop").disabled = false;
  cameraStatus.textContent = "Escaneando rostro...";
  const faceMatcher = buildFaceMatcher();

  const loop = async () => {
    if (!detecting) return;
    if (video.paused || video.ended) { requestAnimationFrame(loop); return; }
    const det = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
    const canvasSize = faceapi.matchDimensions(overlay, video, true);
    if (det) {
      const resized = faceapi.resizeResults(det, canvasSize);
      const box = resized.detection.box;
      const ctx = overlay.getContext("2d");
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      ctx.strokeStyle = "#10b981"; 
      ctx.lineWidth = 3;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      let name = DEFAULT_NAME;
      let matched = false;
      if (faceMatcher) {
        const match = faceMatcher.findBestMatch(resized.descriptor);
        if (match.label !== "unknown") { name = match.label; matched = true; }
      }
      handleRecognition(name, matched);
    }
    requestAnimationFrame(loop);
  };
  loop();
}

let procesando = false;

async function handleRecognition(name, matched) {
  if (!matched) {
    empName.textContent = name;
    empStatus.textContent = "No Registrado";
    empStatus.style.color = "#f59e0b";
    return;
  }
  if (procesando) return;
  if (recognized && recognized.name === name && Date.now() - recognized.at < 10000) return;
  
  recognized = { name, at: Date.now(), matched };
  procesando = true;

  empName.textContent = name;
  empTime.textContent = formatTime();
  empDate.textContent = formatDate();
  empStatus.textContent = "Procesando...";
  empStatus.style.color = "var(--muted)";

  if (!insideRadius) {
    empStatus.textContent = "Fuera de Ubicación";
    empStatus.style.color = "#ef4444";
    procesando = false;
    return;
  }

  await procesarAsistencia(name);
  procesando = false;
}

/* =========================================================
   INICIALIZACIÓN
========================================================= */
window.addEventListener("load", async () => {
  await cargarConfiguracion();
  initMap();
  initGeolocation();

  await loadModels();
  await cargarPersonalDesdeSupabase(); 

  $("btnStop").addEventListener("click", () => {
    detecting = false;
    $("btnStart").disabled = false;
    $("btnStop").disabled = true;
    cameraStatus.textContent = "Escaneo detenido";
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  });
});
