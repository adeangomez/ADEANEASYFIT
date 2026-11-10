// Si alguien intenta mostrar esta página dentro de otra web (para engañar
// con clics falsos), no se pinta nada.
if (window.top !== window.self) {
  document.documentElement.style.display = "none";
  throw new Error("Esta página no se puede mostrar dentro de otra.");
}

const $ = id => document.getElementById(id);

// recordar clave/URL localmente (solo en este navegador, para comodidad)
window.addEventListener("load", () => {
  const savedUrl = localStorage.getItem("adeanfit_admin_url");
  const savedKey = localStorage.getItem("adeanfit_admin_key");
  if(savedUrl) $("workerUrl").value = savedUrl;
  if(savedKey){ $("adminKey").value = savedKey; $("rememberKey").checked = true; }
});

function persistIfNeeded(){
  if($("rememberKey").checked){
    localStorage.setItem("adeanfit_admin_url", $("workerUrl").value.trim());
    localStorage.setItem("adeanfit_admin_key", $("adminKey").value);
  } else {
    localStorage.removeItem("adeanfit_admin_url");
    localStorage.removeItem("adeanfit_admin_key");
  }
}

function showMsg(el, text, ok){
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
}

async function apiCall(path, options={}){
  const base = $("workerUrl").value.trim().replace(/\/+$/,"");
  // La clave de administrador solo se envía por conexión cifrada.
  if(!/^https:\/\//i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base)){
    throw new Error("La URL del servidor debe empezar por https://");
  }
  const adminKey = $("adminKey").value;
  const { raw, ...fetchOptions } = options;
  const res = await fetch(base + path, {
    ...fetchOptions,
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": adminKey,
      ...(options.headers||{})
    }
  });
  const received = await res.json().catch(()=>({}));
  const data = raw ? received : neutralize(received);
  if(!res.ok) throw new Error(data.error || ("Error HTTP " + res.status));
  return data;
}

// -------------------- ACCESO --------------------
$("btnConnect").addEventListener("click", async () => {
  const msg = $("connMsg");
  if(!$("workerUrl").value.trim() || !$("adminKey").value){
    showMsg(msg, "Rellena la URL y la clave de administrador.", false);
    return;
  }
  const btn = $("btnConnect");
  btn.disabled = true; btn.textContent = "Comprobando…";
  try{
    await apiCall("/admin/users", { method: "GET" });
    persistIfNeeded();
    $("connView").style.display = "none";
    $("mainView").style.display = "block";
    loadUsers();
    loadSuggestions();
  }catch(e){
    showMsg(msg, "No se pudo conectar: " + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = "Entrar";
  }
});

$("btnDisconnect").addEventListener("click", () => {
  $("mainView").style.display = "none";
  $("connView").style.display = "block";
});

// -------------------- PESTAÑAS --------------------
document.querySelectorAll(".admin-tabs button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".admin-tabs button").forEach(b => b.classList.remove("tab-active"));
    btn.classList.add("tab-active");
    document.querySelectorAll(".admin-section").forEach(s => s.style.display = "none");
    $("section-" + btn.dataset.section).style.display = "block";
  });
});

document.querySelectorAll("[data-usv]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-usv]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    $("usersSubPlaceholder").style.display = "none";
    $("usersSubCrear").style.display = btn.dataset.usv === "crear" ? "block" : "none";
    $("usersSubExistentes").style.display = btn.dataset.usv === "existentes" ? "block" : "none";
    $("usersSubCopia").style.display = btn.dataset.usv === "copia" ? "block" : "none";
    if(btn.dataset.usv === "existentes" && $("userList").children.length === 0){
      $("btnList").click();
    }
  });
});

// -------------------- LIBRERÍA DE EJERCICIOS (igual que en la app, con fotos) --------------------
const ASSETS_BASE = "assets/ejercicios/";
const EXERCISE_LIBRARY = [
  { id: "aperturas-pecho-maquina",     name: "Aperturas de pecho en máquina", muscle: "Pecho" },
  { id: "aperturas-pecho-poleas",      name: "Aperturas de pecho en poleas",  muscle: "Pecho" },
  { id: "flexiones",                   name: "Flexiones",                    muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { id: "fondos-maquina",              name: "Fondos en máquina",            muscle: "Pecho", secondary: ["Tríceps"] },
  { id: "fondos-paralelas",            name: "Fondos en paralelas",          muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { id: "press-declinado-barra",       name: "Press declinado con barra",    muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { id: "press-pecho-maquina",         name: "Press de pecho en máquina",    muscle: "Pecho", secondary: ["Tríceps"] },
  { id: "press-inclinado-maquina",     name: "Press inclinado en máquina",   muscle: "Pecho", secondary: ["Tríceps"] },
  { id: "press-inclinado-mancuernas",  name: "Press inclinado con mancuernas", muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { id: "press-inclinado-smith",       name: "Press inclinado en Smith",     muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { id: "press-plano-mancuernas",      name: "Press plano con mancuernas",   muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { id: "press-plano-smith",           name: "Press plano en Smith",         muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { id: "pullover-mancuerna",          name: "Pull-over con mancuerna",      muscle: "Pecho", secondary: ["Espalda"] },
  { id: "press-banca",                 name: "Press banca",                  muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { id: "dominadas",                   name: "Dominadas",                    muscle: "Espalda", secondary: ["Bíceps"] },
  { id: "encogimientos-mancuernas",    name: "Encogimientos con mancuernas", muscle: "Espalda" },
  { id: "jalon-al-pecho",              name: "Jalón al pecho",               muscle: "Espalda", secondary: ["Bíceps"] },
  { id: "jalon-maquina",               name: "Jalón en máquina",             muscle: "Espalda", secondary: ["Bíceps"] },
  { id: "peso-muerto",                 name: "Peso muerto",                  muscle: "Espalda", secondary: ["Glúteo", "Femoral"] },
  { id: "remo-mancuernas",             name: "Remo con mancuernas",          muscle: "Espalda", secondary: ["Bíceps"] },
  { id: "remo-barra",                  name: "Remo con barra",               muscle: "Espalda", secondary: ["Bíceps"] },
  { id: "remo-maquina",                name: "Remo en máquina",              muscle: "Espalda", secondary: ["Bíceps"] },
  { id: "remo-t",                      name: "Remo en T",                    muscle: "Espalda", secondary: ["Bíceps"] },
  { id: "face-pull",                   name: "Face pull",                    muscle: "Espalda", secondary: ["Hombro"] },
  { id: "extension-lumbar",            name: "Extensión lumbar",             muscle: "Espalda", secondary: ["Glúteo", "Femoral"] },
  { id: "jalon-agarre-cerrado-supino", name: "Jalón con agarre cerrado supino", muscle: "Espalda", secondary: ["Bíceps"] },
  { id: "elevaciones-frontales-mancuernas", name: "Elevaciones frontales con mancuernas", muscle: "Hombro" },
  { id: "pajaritos",                   name: "Pajaritos",                    muscle: "Hombro", secondary: ["Espalda"] },
  { id: "pec-deck-posterior-invertido", name: "Pec deck posterior invertido", muscle: "Hombro", secondary: ["Espalda"] },
  { id: "press-militar-mancuernas",    name: "Press militar con mancuernas", muscle: "Hombro", secondary: ["Tríceps"] },
  { id: "aperturas-hombro-poleas",     name: "Aperturas de hombro en poleas", muscle: "Hombro" },
  { id: "aperturas-hombro",            name: "Aperturas de hombro",          muscle: "Hombro" },
  { id: "press-militar-barra",         name: "Press militar con barra",      muscle: "Hombro", secondary: ["Tríceps"] },
  { id: "remo-vertical",               name: "Remo vertical",                muscle: "Hombro", secondary: ["Espalda"] },
  { id: "press-militar-maquina",       name: "Press militar en máquina",     muscle: "Hombro", secondary: ["Tríceps"] },
  { id: "aperturas-hombro-maquina",    name: "Apertura de hombro en máquina", muscle: "Hombro" },
  { id: "press-arnold",                name: "Press Arnold",                 muscle: "Hombro", secondary: ["Tríceps"] },
  { id: "curl-barra-recta",            name: "Curl con barra recta",         muscle: "Bíceps" },
  { id: "curl-barra-z",                name: "Curl con barra Z",             muscle: "Bíceps" },
  { id: "curl-polea",                  name: "Curl en polea",                muscle: "Bíceps" },
  { id: "curl-concentrado",            name: "Curl concentrado",             muscle: "Bíceps" },
  { id: "curl-martillo",               name: "Curl martillo",                muscle: "Bíceps" },
  { id: "curl-predicador-barra",       name: "Curl predicador con barra",    muscle: "Bíceps" },
  { id: "curl-predicador-mancuernas",  name: "Curl predicador con mancuernas", muscle: "Bíceps" },
  { id: "curl-predicador-maquina",     name: "Curl predicador en máquina",   muscle: "Bíceps" },
  { id: "curl-mancuernas-alterno",     name: "Curl con mancuernas alterno",  muscle: "Bíceps" },
  { id: "curl-bayesiano-polea",        name: "Curl bayesiano en polea",      muscle: "Bíceps" },
  { id: "patada-triceps-polea",        name: "Patada de tríceps en polea",   muscle: "Tríceps" },
  { id: "extension-triceps-trasnuca",  name: "Extensión de tríceps trasnuca", muscle: "Tríceps" },
  { id: "patada-triceps-mancuerna",    name: "Patada de tríceps con mancuerna", muscle: "Tríceps" },
  { id: "press-frances-barra-z",       name: "Press francés con barra Z",    muscle: "Tríceps" },
  { id: "press-triceps-maquina",       name: "Press de tríceps en máquina",  muscle: "Tríceps" },
  { id: "flexion-diamante-triceps",    name: "Flexión diamante de tríceps",  muscle: "Tríceps", secondary: ["Pecho", "Hombro"] },
  { id: "fondos-maquina-triceps",      name: "Fondos en máquina de tríceps", muscle: "Tríceps" },
  { id: "fondos-libres-triceps",       name: "Fondos libres de tríceps",     muscle: "Tríceps", secondary: ["Pecho", "Hombro"] },
  { id: "press-cerrado-barra",         name: "Press cerrado con barra",      muscle: "Tríceps", secondary: ["Pecho"] },
  { id: "press-frances-mancuernas",    name: "Press francés con mancuernas", muscle: "Tríceps" },
  { id: "press-frances-polea",         name: "Press francés en polea",       muscle: "Tríceps" },
  { id: "extension-triceps-polea-alta", name: "Extensión de tríceps en polea alta", muscle: "Tríceps" },
  { id: "press-triceps-unilateral-polea", name: "Press de tríceps unilateral en polea", muscle: "Tríceps" },
  { id: "elevacion-piernas-90",        name: "Abdominales con levantamiento de piernas en 90°", muscle: "Abdomen" },
  { id: "crunch-abdomen-polea",        name: "Crunch de abdomen en polea",   muscle: "Abdomen" },
  { id: "crunch-abdomen",              name: "Crunch de abdomen",            muscle: "Abdomen" },
  { id: "dragon-flag-abdomen",         name: "Dragon flags de abdomen",      muscle: "Abdomen" },
  { id: "plancha-abdominal",           name: "Planchas abdominales",         muscle: "Abdomen", secondary: ["Hombro"] },
  { id: "rodillas-pecho",              name: "Rodillas al pecho",            muscle: "Abdomen" },
  { id: "rotacion-oblicuos-poleas",    name: "Rotación de oblicuos en poleas", muscle: "Abdomen" },
  { id: "rueda-abdominal",             name: "Rueda abdominal",              muscle: "Abdomen", secondary: ["Hombro", "Espalda"] },
  { id: "crunch-abdomen-maquina",      name: "Crunch de abdomen en máquina", muscle: "Abdomen" },
  { id: "curl-femoral-tumbado",        name: "Curl femoral tumbado",         muscle: "Pierna", sub: "Femoral" },
  { id: "curl-femoral-sentado",        name: "Curl femoral sentado",         muscle: "Pierna", sub: "Femoral" },
  { id: "hip-thrust",                  name: "Hip thrust",                   muscle: "Pierna", sub: "Glúteo", secondary: ["Femoral"] },
  { id: "patada-gluteo-polea",         name: "Patada de glúteo en polea",    muscle: "Pierna", sub: "Glúteo", secondary: ["Femoral"] },
  { id: "peso-muerto-rumano-barra",    name: "Peso muerto rumano con barra", muscle: "Pierna", sub: "Glúteo", secondary: ["Femoral"] },
  { id: "peso-muerto-rumano-mancuernas", name: "Peso muerto rumano con mancuernas", muscle: "Pierna", sub: "Glúteo", secondary: ["Femoral"] },
  { id: "aductor-externo-maquina",     name: "Aductor externo en máquina",    muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo"] },
  { id: "aductor-interno-maquina",     name: "Aductor interno en máquina",    muscle: "Pierna", sub: "Cuádriceps" },
  { id: "hack-squat",                  name: "Hack squat",                   muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo"] },
  { id: "prensa-piernas",              name: "Prensa de piernas",            muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo"] },
  { id: "sentadilla-barra",            name: "Sentadilla con barra",         muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo", "Abdomen"] },
  { id: "sentadilla-pendular",         name: "Sentadilla pendular",          muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo"] },
  { id: "zancadas-mancuernas",         name: "Zancadas con mancuernas",      muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo"] },
  { id: "zancadas-bulgaras",           name: "Zancadas búlgaras",            muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo"] },
  { id: "extension-cuadriceps",        name: "Extensión de cuádriceps",      muscle: "Pierna", sub: "Cuádriceps" },
  { id: "gemelo-sentado",              name: "Extensión de gemelo sentado",  muscle: "Pierna", sub: "Gemelo" },
  { id: "gemelo-de-pie",               name: "Extensión de gemelo de pie",   muscle: "Pierna", sub: "Gemelo" },
];
function exerciseImgUrl(id){ return ASSETS_BASE + id + ".png"; }
function findExerciseByName(name){ return EXERCISE_LIBRARY.find(e => e.name === name); }
const EXERCISE_LIBRARY_NAMES = EXERCISE_LIBRARY.map(e => e.name);
const MUSCLE_ORDER = ["Pecho","Espalda","Hombro","Bíceps","Tríceps","Abdomen","Pierna"];
function exerciseOptionsGroupedHtml(selectedName){
  return MUSCLE_ORDER.map(m => {
    const items = EXERCISE_LIBRARY.filter(e => e.muscle === m);
    if(items.length === 0) return "";
    const opts = items.map(e => `<option value="${escapeAttrAdmin(e.name)}" ${e.name===selectedName?"selected":""}>${e.sub ? `${e.name} (${e.sub})` : e.name}</option>`).join("");
    return `<optgroup label="${m}">${opts}</optgroup>`;
  }).join("");
}
// Todo texto que venga de los datos de un usuario (nombres de rutinas, de
// ejercicios, sugerencias, etc.) pasa por aquí antes de pintarse, para que
// nadie pueda colar código en este panel escribiendo HTML en un nombre.
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escapeAttrAdmin(s){ return esc(s); }
// La foto de perfil solo se pinta si es de verdad una imagen incrustada.
function safeAvatarUrl(s){
  return (typeof s === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/]+=*$/.test(s)) ? s : "";
}
// Segunda barrera: a todo lo que llega del servidor se le cambian los
// símbolos < y > por otros parecidos que el navegador nunca interpreta
// como código (no se aplica a la copia de seguridad, que se guarda tal cual).
function neutralize(v, key){
  if(typeof v === "string"){
    if(key === "avatarBase64") return safeAvatarUrl(v) || null;
    return v.replace(/</g, "‹").replace(/>/g, "›");
  }
  if(Array.isArray(v)) return v.map(x => neutralize(x));
  if(v && typeof v === "object"){
    const out = {};
    Object.keys(v).forEach(k => { out[k.replace(/</g, "‹").replace(/>/g, "›")] = neutralize(v[k], k); });
    return out;
  }
  return v;
}

const MUSCLE_SYNONYMS = {
  "Pecho": ["pecho", "pectoral", "pectorales", "pecs", "chest"],
  "Espalda": ["espalda", "dorsal", "dorsales", "dorso", "back", "lat", "lats"],
  "Hombro": ["hombro", "hombros", "deltoide", "deltoides", "delt", "delts", "shoulder"],
  "Bíceps": ["biceps", "bíceps", "brazo", "brazos", "curl", "arm", "arms", "bicep"],
  "Tríceps": ["triceps", "tríceps", "tricep"],
  "Abdomen": ["abdomen", "abdominales", "abs", "core", "oblicuos", "oblicuo", "sixpack", "six pack"],
  "Pierna": ["pierna", "piernas", "leg", "legs"],
};
const SUB_SYNONYMS = {
  "Femoral": ["femoral", "femorales", "isquios", "isquiotibiales", "hamstring", "hamstrings"],
  "Cuádriceps": ["cuadriceps", "cuádriceps", "quad", "quads", "quadriceps"],
  "Glúteo": ["gluteo", "glúteo", "gluteos", "glúteos", "gluteus", "glutes", "culo"],
  "Gemelo": ["gemelo", "gemelos", "pantorrilla", "pantorrillas", "calf", "calves"],
};
function normalizeText(s){
  return String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const TIME_BRACKET_LABELS_STD = { "0-3":"0-3 meses", "3-6":"3-6 meses", "6-12":"6-12 meses", "1-2a":"1-2 años", "+2a":"+2 años" };
const STRENGTH_STANDARDS = {
  "Press banca":             { "0-3":0.50, "3-6":0.70, "6-12":0.90, "1-2a":1.15, "+2a":1.40 },
  "Peso muerto":             { "0-3":0.75, "3-6":1.00, "6-12":1.35, "1-2a":1.75, "+2a":2.10 },
  "Press militar con barra": { "0-3":0.35, "3-6":0.45, "6-12":0.55, "1-2a":0.70, "+2a":0.85 },
  "Remo con barra":          { "0-3":0.45, "3-6":0.60, "6-12":0.75, "1-2a":0.95, "+2a":1.15 },
};
// Cada ejercicio de la biblioteca se asocia al básico de STRENGTH_STANDARDS
// biomecánicamente más parecido, con un coeficiente de ajuste (estimación
// orientativa, no un estándar certificado por ejercicio). Idéntico al mapa
// de index.html, para que admin y cliente muestren la misma expectativa.
const EXERCISE_EXPECTED_MAP = {
  "Aperturas de pecho en máquina": { table:"Press banca", coef:0.30 },
  "Aperturas de pecho en poleas": { table:"Press banca", coef:0.30 },
  "Flexiones": { table:"Press banca", coef:0.50 },
  "Fondos en máquina": { table:"Press banca", coef:0.90 },
  "Fondos en paralelas": { table:"Press banca", coef:0.60 },
  "Press declinado con barra": { table:"Press banca", coef:0.95 },
  "Press de pecho en máquina": { table:"Press banca", coef:0.90 },
  "Press inclinado en máquina": { table:"Press banca", coef:0.85 },
  "Press inclinado con mancuernas": { table:"Press banca", coef:0.80 },
  "Press inclinado en Smith": { table:"Press banca", coef:0.85 },
  "Press plano con mancuernas": { table:"Press banca", coef:0.85 },
  "Press plano en Smith": { table:"Press banca", coef:0.95 },
  "Pull-over con mancuerna": { table:"Press banca", coef:0.40 },
  "Press banca": { table:"Press banca", coef:1.00 },
  "Dominadas": { table:"Remo con barra", coef:0.50 },
  "Encogimientos con mancuernas": { table:"Remo con barra", coef:1.30 },
  "Jalón al pecho": { table:"Remo con barra", coef:0.90 },
  "Jalón en máquina": { table:"Remo con barra", coef:0.90 },
  "Peso muerto": { table:"Peso muerto", coef:1.00 },
  "Remo con mancuernas": { table:"Remo con barra", coef:0.85 },
  "Remo con barra": { table:"Remo con barra", coef:1.00 },
  "Remo en máquina": { table:"Remo con barra", coef:0.95 },
  "Remo en T": { table:"Remo con barra", coef:1.00 },
  "Face pull": { table:"Remo con barra", coef:0.25 },
  "Extensión lumbar": { table:"Remo con barra", coef:0.30 },
  "Jalón con agarre cerrado supino": { table:"Remo con barra", coef:0.90 },
  "Elevaciones frontales con mancuernas": { table:"Press militar con barra", coef:0.25 },
  "Pajaritos": { table:"Press militar con barra", coef:0.20 },
  "Pec deck posterior invertido": { table:"Press militar con barra", coef:0.30 },
  "Press militar con mancuernas": { table:"Press militar con barra", coef:0.80 },
  "Aperturas de hombro en poleas": { table:"Press militar con barra", coef:0.20 },
  "Aperturas de hombro": { table:"Press militar con barra", coef:0.20 },
  "Press militar con barra": { table:"Press militar con barra", coef:1.00 },
  "Remo vertical": { table:"Press militar con barra", coef:0.60 },
  "Press militar en máquina": { table:"Press militar con barra", coef:0.90 },
  "Apertura de hombro en máquina": { table:"Press militar con barra", coef:0.30 },
  "Press Arnold": { table:"Press militar con barra", coef:0.75 },
  "Curl con barra recta": { table:"Remo con barra", coef:0.35 },
  "Curl con barra Z": { table:"Remo con barra", coef:0.35 },
  "Curl en polea": { table:"Remo con barra", coef:0.32 },
  "Curl concentrado": { table:"Remo con barra", coef:0.18 },
  "Curl martillo": { table:"Remo con barra", coef:0.32 },
  "Curl predicador con barra": { table:"Remo con barra", coef:0.28 },
  "Curl predicador con mancuernas": { table:"Remo con barra", coef:0.26 },
  "Curl predicador en máquina": { table:"Remo con barra", coef:0.30 },
  "Curl con mancuernas alterno": { table:"Remo con barra", coef:0.28 },
  "Curl bayesiano en polea": { table:"Remo con barra", coef:0.20 },
  "Patada de tríceps en polea": { table:"Press banca", coef:0.15 },
  "Extensión de tríceps trasnuca": { table:"Press banca", coef:0.30 },
  "Patada de tríceps con mancuerna": { table:"Press banca", coef:0.15 },
  "Press francés con barra Z": { table:"Press banca", coef:0.30 },
  "Press de tríceps en máquina": { table:"Press banca", coef:0.35 },
  "Flexión diamante de tríceps": { table:"Press banca", coef:0.40 },
  "Fondos en máquina de tríceps": { table:"Press banca", coef:0.35 },
  "Fondos libres de tríceps": { table:"Press banca", coef:0.40 },
  "Press cerrado con barra": { table:"Press banca", coef:0.85 },
  "Press francés con mancuernas": { table:"Press banca", coef:0.28 },
  "Press francés en polea": { table:"Press banca", coef:0.28 },
  "Extensión de tríceps en polea alta": { table:"Press banca", coef:0.30 },
  "Press de tríceps unilateral en polea": { table:"Press banca", coef:0.15 },
  "Curl femoral tumbado": { table:"Peso muerto", coef:0.35 },
  "Curl femoral sentado": { table:"Peso muerto", coef:0.35 },
  "Hip thrust": { table:"Peso muerto", coef:1.30 },
  "Patada de glúteo en polea": { table:"Peso muerto", coef:0.15 },
  "Peso muerto rumano con barra": { table:"Peso muerto", coef:0.80 },
  "Peso muerto rumano con mancuernas": { table:"Peso muerto", coef:0.70 },
  "Aductor externo en máquina": { table:"Peso muerto", coef:0.40 },
  "Aductor interno en máquina": { table:"Peso muerto", coef:0.40 },
  "Hack squat": { table:"Peso muerto", coef:1.10 },
  "Prensa de piernas": { table:"Peso muerto", coef:2.00 },
  "Sentadilla con barra": { table:"Peso muerto", coef:0.90 },
  "Sentadilla pendular": { table:"Peso muerto", coef:1.10 },
  "Zancadas con mancuernas": { table:"Peso muerto", coef:0.40 },
  "Zancadas búlgaras": { table:"Peso muerto", coef:0.35 },
  "Extensión de cuádriceps": { table:"Peso muerto", coef:0.50 },
  "Extensión de gemelo sentado": { table:"Peso muerto", coef:0.70 },
  "Extensión de gemelo de pie": { table:"Peso muerto", coef:0.70 },
};
function computeExpectedMax(profile, exerciseName){
  if(!profile || !profile.weightKg || !profile.timeTraining) return null;
  const map = EXERCISE_EXPECTED_MAP[exerciseName];
  if(!map) return null;
  const table = STRENGTH_STANDARDS[map.table];
  if(!table) return null;
  const mult = table[profile.timeTraining];
  if(!mult) return null;
  return Math.round(profile.weightKg * mult * map.coef * 2) / 2;
}

function exerciseMaxWeight(sets){
  return (sets || []).reduce((m, s) => (s.kg || 0) > m ? s.kg : m, 0);
}

// misma gráfica de evolución que en la app principal, con la línea de expectativa
// cssClass: "mini-chart" (por defecto, tarjetas pequeñas) o "big-chart" (Panel de clientes)
function buildLineChartSvg(values, expected, emptyMsg, cssClass){
  cssClass = cssClass || "mini-chart";
  if(!values || values.length < 2){
    return `<div class="chart-empty">${emptyMsg || "Necesitas al menos 2 sesiones registradas de este ejercicio para ver la gráfica."}</div>`;
  }
  const W = 100, H = 34, padY = 4;
  let max = Math.max(...values);
  let min = Math.min(...values);
  if(expected != null){ max = Math.max(max, expected); min = Math.min(min, expected); }
  const range = (max - min) || 1;
  const stepX = W / (values.length - 1);
  const pts = values.map((v,i) => {
    const x = i * stepX;
    const y = H - padY - ((v - min) / range) * (H - padY * 2);
    return [x, y];
  });
  const pathD = pts.map((p,i) => (i===0?"M":"L") + p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
  const areaD = pathD + ` L${pts[pts.length-1][0].toFixed(2)},${H} L0,${H} Z`;
  const trendUp = values[values.length-1] >= values[0];
  const lineColor = trendUp ? "#34c579" : "#ff5a2e";
  const dotsLast = `<circle cx="${pts[pts.length-1][0].toFixed(2)}" cy="${pts[pts.length-1][1].toFixed(2)}" r="2.2" fill="${lineColor}"/>`;

  let expectedLine = "";
  if(expected != null){
    const ey = H - padY - ((expected - min) / range) * (H - padY * 2);
    expectedLine = `<line x1="0" y1="${ey.toFixed(2)}" x2="${W}" y2="${ey.toFixed(2)}" stroke="#d9a441" stroke-width="1" stroke-dasharray="3,2" vector-effect="non-scaling-stroke"/>`;
  }

  const svg = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="${cssClass}">
      <path d="${areaD}" fill="${lineColor}" opacity="0.12" stroke="none"/>
      ${expectedLine}
      <path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
      ${dotsLast}
    </svg>`;

  const caption = `
    <div class="chart-caption">
      <span>${esc(min)}kg</span>
      <span class="${trendUp?'up':'down'}">${trendUp?'▲':'▼'} ${esc(values[0])}kg → ${esc(values[values.length-1])}kg</span>
      <span>${esc(max)}kg</span>
    </div>`;

  let gapHtml = "";
  if(expected != null){
    const current = values[values.length-1];
    const diff = current - expected;
    const pct = (diff/expected)*100;
    const cls = diff >= 0 ? "up" : "down";
    const arrow = diff >= 0 ? "▲" : "▼";
    gapHtml = `<div class="gap-badge ${cls}">${arrow} ${diff>=0?"+":""}${diff.toFixed(1)}kg vs. esperado (${esc(expected)}kg) · ${pct>=0?"+":""}${pct.toFixed(0)}%</div>`;
  }

  return svg + caption + gapHtml;
}

// Construye la serie de TODAS las series/sets registrados de un ejercicio
// (no solo el máximo por sesión), en orden cronológico. opts permite acotar
// por día de rutina y/o por una ventana de días hacia atrás (rangeDays).
function buildExerciseSetPointsAdmin(sessions, exerciseName, opts){
  opts = opts || {};
  const points = [];
  const cutoff = opts.rangeDays ? (Date.now() - opts.rangeDays*24*60*60*1000) : null;
  sessions.forEach(sess=>{
    if(cutoff != null && new Date(sess.date).getTime() < cutoff) return;
    if(opts.dayName && sess.dayName !== opts.dayName) return;
    const ex = sess.exercises.find(e => e.name === exerciseName);
    if(ex){
      (ex.sets || []).forEach(s=>{
        if((s.kg||0) > 0){ points.push({ date: sess.date, kg: s.kg, reps: s.reps || 0 }); }
      });
    }
  });
  points.sort((a,b)=> new Date(a.date) - new Date(b.date));
  return points;
}

// Igual que buildExerciseSetPointsAdmin pero agregado por mes (máximo kg del mes).
function buildExerciseMonthlyPointsAdmin(sessions, exerciseName, opts){
  opts = opts || {};
  const byMonth = {};
  sessions.forEach(sess=>{
    if(opts.dayName && sess.dayName !== opts.dayName) return;
    const ex = sess.exercises.find(e => e.name === exerciseName);
    if(!ex) return;
    const mx = exerciseMaxWeight(ex.sets);
    if(mx <= 0) return;
    const d = new Date(sess.date);
    const mk = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0");
    if(!byMonth[mk] || mx > byMonth[mk].kg){ byMonth[mk] = { kg: mx, reps: (ex.sets.find(s=>s.kg===mx)||{}).reps || 0, date: sess.date }; }
  });
  return Object.keys(byMonth).sort().map(mk => ({ monthKey: mk, kg: byMonth[mk].kg, reps: byMonth[mk].reps, date: byMonth[mk].date }));
}

// Gráfica de línea en SVG marcando cada serie registrada (kg en el eje Y,
// repeticiones como etiqueta sobre cada punto), con línea de peso esperado.
// cssClass: "mini-chart" (por defecto) o "big-chart" (Panel de clientes).
function buildSetChartSvg(points, expected, emptyMessage, cssClass){
  cssClass = cssClass || "mini-chart";
  if(!points || points.length < 2){
    return `<div class="chart-empty">${emptyMessage || "Necesitas al menos 2 series registradas de este ejercicio para ver la gráfica."}</div>`;
  }
  const values = points.map(p=>p.kg);
  const W = 100, H = 40, padY = 4, padTop = 7;
  let max = Math.max(...values);
  let min = Math.min(...values);
  if(expected != null){ max = Math.max(max, expected); min = Math.min(min, expected); }
  const range = (max - min) || 1;
  const stepX = W / (points.length - 1);
  const yOf = (v) => (H - padY) - ((v - min) / range) * (H - padY - padTop);
  const pts = points.map((p,i) => [i*stepX, yOf(p.kg)]);
  const pathD = pts.map((p,i) => (i===0?"M":"L") + p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
  const areaD = pathD + ` L${pts[pts.length-1][0].toFixed(2)},${H} L0,${H} Z`;
  const trendUp = values[values.length-1] >= values[0];
  const lineColor = "#ff7a3d";

  const dots = points.map((p,i) => {
    const [x,y] = pts[i];
    const dateLabel = p.monthKey ? p.monthKey : new Date(p.date).toLocaleDateString("es-ES");
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="1.6" fill="${lineColor}"><title>${esc(p.kg)}kg × ${esc(p.reps)} reps — ${esc(dateLabel)}</title></circle>`;
  }).join("");

  let expectedLine = "";
  if(expected != null){
    const ey = yOf(expected);
    expectedLine = `<line x1="0" y1="${ey.toFixed(2)}" x2="${W}" y2="${ey.toFixed(2)}" stroke="#d9a441" stroke-width="1" stroke-dasharray="3,2" vector-effect="non-scaling-stroke"/>`;
  }

  const svg = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="${cssClass}">
      <path d="${areaD}" fill="${lineColor}" opacity="0.12" stroke="none"/>
      ${expectedLine}
      <path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="1.2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
    </svg>`;

  const caption = `
    <div class="chart-caption">
      <span>${esc(min)}kg</span>
      <span class="${trendUp?'up':'down'}">${trendUp?'▲':'▼'} ${esc(values[0])}kg (${esc(points[0].reps)}r) → ${esc(values[values.length-1])}kg (${esc(points[points.length-1].reps)}r)</span>
      <span>${esc(max)}kg</span>
    </div>`;

  let gapHtml = "";
  if(expected != null){
    const current = values[values.length-1];
    const diff = current - expected;
    const pct = (diff/expected)*100;
    const cls = diff >= 0 ? "up" : "down";
    const arrow = diff >= 0 ? "▲" : "▼";
    gapHtml = `<div class="gap-badge ${cls}">${arrow} ${diff>=0?"+":""}${diff.toFixed(1)}kg vs. esperado (${esc(expected)}kg) · ${pct>=0?"+":""}${pct.toFixed(0)}%</div>`;
  }

  return svg + caption + gapHtml;
}

$("btnCreate").addEventListener("click", async () => {
  persistIfNeeded();
  const msg = $("createMsg");
  const username = $("newUsername").value.trim();
  const password = $("newPassword").value;
  if(!username || !password){
    showMsg(msg, "Rellena usuario y contraseña.", false);
    return;
  }
  try{
    await apiCall("/admin/create-user", { method:"POST", body: JSON.stringify({ username, password }) });
    showMsg(msg, `Usuario "${username}" creado correctamente.`, true);
    $("newUsername").value = ""; $("newPassword").value = "";
    loadUsers();
  }catch(e){
    showMsg(msg, "Error: " + e.message, false);
  }
});

$("btnList").addEventListener("click", () => { persistIfNeeded(); loadUsers(); });

let allUsernamesCache = [];

async function loadUsers(){
  const msg = $("listMsg");
  const listEl = $("userList");
  const selectEl = $("progressUserSelect");
  const testEmailSelectEl = $("testEmailUserSelect");
  const routinesSelectEl = $("routinesUserSelect");
  const clientPanelSelectEl = $("clientPanelUserSelect");
  try{
    const data = await apiCall("/admin/users", { method:"GET" });
    listEl.innerHTML = "";

    const prevSelected = selectEl.value;
    const prevRoutinesSelected = routinesSelectEl ? routinesSelectEl.value : "";
    const prevClientPanelSelected = clientPanelSelectEl ? clientPanelSelectEl.value : "";
    selectEl.innerHTML = '<option value="">— Elige un usuario —</option>';
    if(testEmailSelectEl) testEmailSelectEl.innerHTML = '<option value="">— Elige un usuario —</option>';
    if(routinesSelectEl) routinesSelectEl.innerHTML = '<option value="">— Elige un usuario —</option>';
    if(clientPanelSelectEl) clientPanelSelectEl.innerHTML = '<option value="">— Elige un usuario —</option>';

    allUsernamesCache = (data.users || []).map(u => typeof u === "string" ? u : u.username);

    if(!data.users || data.users.length === 0){
      listEl.innerHTML = '<li style="color:var(--faint);">Todavía no hay usuarios creados.</li>';
    } else {
      data.users.forEach(u => {
        const username = typeof u === "string" ? u : u.username;
        const suspended = typeof u === "object" && u.suspended;

        const opt = document.createElement("option");
        opt.value = username;
        opt.textContent = suspended ? `${username} (suspendido)` : username;
        selectEl.appendChild(opt);

        if(testEmailSelectEl){
          const opt3 = document.createElement("option");
          opt3.value = username;
          opt3.textContent = suspended ? `${username} (suspendido)` : username;
          testEmailSelectEl.appendChild(opt3);
        }

        if(routinesSelectEl){
          const opt4 = document.createElement("option");
          opt4.value = username;
          opt4.textContent = suspended ? `${username} (suspendido)` : username;
          routinesSelectEl.appendChild(opt4);
        }

        if(clientPanelSelectEl){
          const opt5 = document.createElement("option");
          opt5.value = username;
          opt5.textContent = suspended ? `${username} (suspendido)` : username;
          clientPanelSelectEl.appendChild(opt5);
        }

        const li = document.createElement("li");
        li.style.flexWrap = "wrap";
        li.style.gap = "8px";

        const nameSpan = document.createElement("span");
        nameSpan.innerHTML = suspended
          ? `${esc(username)} <span style="color:var(--down);font-size:10.5px;font-weight:800;text-transform:uppercase;margin-left:6px;">Suspendido</span>`
          : esc(username);
        li.appendChild(nameSpan);

        const btnGroup = document.createElement("div");
        btnGroup.style.display = "flex";
        btnGroup.style.gap = "6px";

        const toggleBtn = document.createElement("button");
        if(suspended){
          toggleBtn.className = "secondary";
          toggleBtn.textContent = "Reactivar";
          toggleBtn.addEventListener("click", () => reactivateUser(username));
        } else {
          toggleBtn.className = "danger";
          toggleBtn.textContent = "Suspender";
          toggleBtn.addEventListener("click", () => suspendUser(username));
        }
        btnGroup.appendChild(toggleBtn);

        const resetBtn = document.createElement("button");
        resetBtn.className = "secondary";
        resetBtn.textContent = "Restablecer contraseña";
        resetBtn.addEventListener("click", () => resetPasswordUser(username));
        btnGroup.appendChild(resetBtn);

        const excelBtn = document.createElement("button");
        excelBtn.className = "secondary";
        excelBtn.textContent = "Enviar Excel";
        excelBtn.title = "Envía a tu correo un Excel con las marcas de este cliente";
        excelBtn.addEventListener("click", () => toggleExcelPanel(li, username));
        btnGroup.appendChild(excelBtn);

        const delBtn = document.createElement("button");
        delBtn.className = "danger";
        delBtn.textContent = "Eliminar";
        delBtn.addEventListener("click", () => deleteUser(username));
        btnGroup.appendChild(delBtn);

        li.appendChild(btnGroup);
        listEl.appendChild(li);
      });
      if(prevSelected){ selectEl.value = prevSelected; }
      if(routinesSelectEl && prevRoutinesSelected){ routinesSelectEl.value = prevRoutinesSelected; }
      if(clientPanelSelectEl && prevClientPanelSelected){ clientPanelSelectEl.value = prevClientPanelSelected; }
    }
    msg.className = "msg";
  }catch(e){
    showMsg(msg, "Error: " + e.message, false);
  }
}

// Panel desplegable bajo cada usuario: elige periodo y correo, y el servidor
// envía un Excel (una hoja por día con ejercicios, series, reps, pesos y gráficos).
function toggleExcelPanel(li, username){
  const existing = li.querySelector(".excel-panel");
  if(existing){ existing.remove(); return; }
  const savedEmail = localStorage.getItem("adeanfit_admin_notify_email") || "";
  // Día base por defecto: hace un mes (fecha local, formato AAAA-MM-DD)
  const d0 = new Date(); d0.setMonth(d0.getMonth() - 1);
  const defaultStart = d0.getFullYear() + "-" + String(d0.getMonth()+1).padStart(2,"0") + "-" + String(d0.getDate()).padStart(2,"0");
  const panel = document.createElement("div");
  panel.className = "excel-panel";
  panel.style.cssText = "flex-basis:100%;width:100%;margin-top:6px;";
  panel.innerHTML = `
    <label>Día base (se envía un mes desde esa fecha)</label>
    <input type="date" class="excel-start" value="${defaultStart}" style="margin-bottom:4px;">
    <div class="excel-hint" style="font-size:11.5px;color:var(--faint);margin-bottom:8px;"></div>
    <div class="copy-row" style="margin-top:4px;">
      <input type="email" class="excel-to" placeholder="tu-email@ejemplo.com" value="${escapeAttrAdmin(savedEmail)}" style="margin-bottom:0;">
      <button type="button" class="excel-send">Enviar Excel</button>
    </div>
    <div class="msg excel-msg"></div>`;
  li.appendChild(panel);
  const startInput = panel.querySelector(".excel-start");
  const hint = panel.querySelector(".excel-hint");
  const fmt = (d) => String(d.getDate()).padStart(2,"0") + "/" + String(d.getMonth()+1).padStart(2,"0") + "/" + d.getFullYear();
  // Mismo día del mes siguiente (el último del mes si no existe) menos un día = último día incluido
  function updateHint(){
    const v = startInput.value;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(v)){ hint.textContent = ""; return; }
    const [y, m, d] = v.split("-").map(Number);
    const lastDayNext = new Date(y, m + 1, 0).getDate();
    const end = new Date(y, m, Math.min(d, lastDayNext) - 1);
    hint.textContent = "Se incluirán las sesiones del " + fmt(new Date(y, m - 1, d)) + " al " + fmt(end) + ".";
  }
  startInput.addEventListener("input", updateHint);
  updateHint();
  const sendBtn = panel.querySelector(".excel-send");
  const msg = panel.querySelector(".excel-msg");
  sendBtn.addEventListener("click", async () => {
    const to = panel.querySelector(".excel-to").value.trim();
    const startDate = startInput.value;
    if(!startDate){ showMsg(msg, "Elige el día base.", false); return; }
    if(!to){ showMsg(msg, "Escribe a qué email quieres enviarlo.", false); return; }
    localStorage.setItem("adeanfit_admin_notify_email", to);
    sendBtn.disabled = true; sendBtn.textContent = "Generando…";
    showMsg(msg, "Generando el Excel y sus gráficos; puede tardar unos segundos…", true);
    try{
      const r = await apiCall("/admin/send-client-excel", { method:"POST", body: JSON.stringify({ username, to, startDate }) });
      showMsg(msg, `Enviado a ${to}: ${r.sheets} día${r.sheets===1?"":"s"} con ${r.charts} gráfico${r.charts===1?"":"s"} (del ${r.from} al ${r.until}).`, true);
    }catch(e){
      showMsg(msg, "No se pudo enviar: " + e.message, false);
    } finally {
      sendBtn.disabled = false; sendBtn.textContent = "Enviar Excel";
    }
  });
}

async function suspendUser(username){
  if(!confirm(`¿Suspender a "${username}"? No podrá entrar hasta que lo reactives, pero conservará todo su progreso.`)) return;
  try{
    await apiCall("/admin/suspend-user", { method:"POST", body: JSON.stringify({ username }) });
    loadUsers();
  }catch(e){
    alert("Error al suspender: " + e.message);
  }
}

async function reactivateUser(username){
  try{
    await apiCall("/admin/reactivate-user", { method:"POST", body: JSON.stringify({ username }) });
    loadUsers();
  }catch(e){
    alert("Error al reactivar: " + e.message);
  }
}

async function resetPasswordUser(username){
  const newPassword = prompt(`Nueva contraseña para "${username}" (mínimo 8 caracteres):`);
  if(newPassword === null) return; // cancelado
  if(!newPassword || newPassword.length < 8){
    alert("La contraseña debe tener al menos 8 caracteres.");
    return;
  }
  try{
    await apiCall("/admin/reset-password", { method:"POST", body: JSON.stringify({ username, newPassword }) });
    alert(`Contraseña de "${username}" restablecida correctamente. Comunícasela a la persona.`);
  }catch(e){
    alert("Error al restablecer la contraseña: " + e.message);
  }
}

async function deleteUser(username){
  if(!confirm(`¿Eliminar al usuario "${username}"? Perderá el acceso y sus datos guardados, sin posibilidad de recuperarlos.`)) return;
  try{
    await apiCall("/admin/delete-user", { method:"POST", body: JSON.stringify({ username }) });
    loadUsers();
  }catch(e){
    alert("Error al eliminar: " + e.message);
  }
}

// -------------------- PROGRESO DE USUARIOS --------------------
let adminExpandedIds = new Set();

function exerciseVolume(sets){
  return (sets || []).reduce((sum, s) => sum + (s.kg || 0) * (s.reps || 0), 0);
}
function fmtWorkoutDuration(sec){
  if(typeof sec !== "number" || !isFinite(sec) || sec < 0) return "";
  const totalMin = Math.round(sec / 60);
  if(totalMin < 1) return "< 1 min";
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h === 0 ? `${m} min` : `${h} h ${String(m).padStart(2,"0")} min`;
}
function fmtDateFull(iso){
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}


const TIME_BRACKET_LABELS = { "0-3":"0-3 meses", "3-6":"3-6 meses", "6-12":"6-12 meses", "1-2a":"1-2 años", "+2a":"+2 años" };

let adminProgressSearchQuery = "";

function getExerciseDayNames(sessions, exerciseName){
  const days = new Set();
  sessions.forEach(sess => {
    if(sess.exercises.some(e => e.name === exerciseName)) days.add(sess.dayName);
  });
  return Array.from(days);
}

function statMatchesQueryAdmin(name, dayNames, q){
  if(!q) return true;
  const nq = normalizeText(q);
  if(normalizeText(name).includes(nq)) return true;
  if(dayNames.some(d => normalizeText(d).includes(nq))) return true;
  const libEx = findExerciseByName(name);
  if(libEx){
    if(libEx.sub){
      const subSyns = SUB_SYNONYMS[libEx.sub] || [normalizeText(libEx.sub)];
      if(subSyns.some(s => normalizeText(s).includes(nq) || nq.includes(normalizeText(s)))) return true;
    }
    const secondaryList = libEx.secondary || [];
    if(secondaryList.some(sec => {
      const subSyns = SUB_SYNONYMS[sec];
      return subSyns ? subSyns.some(s => normalizeText(s).includes(nq) || nq.includes(normalizeText(s))) : false;
    })) return true;
    const allMuscles = [libEx.muscle, ...secondaryList];
    if(allMuscles.some(m => {
      const syns = MUSCLE_SYNONYMS[m] || [];
      return syns.some(s => normalizeText(s).includes(nq) || nq.includes(normalizeText(s)));
    })) return true;
  }
  return false;
}

let adminProgressView = "peso"; // "peso" | "cargas"

function renderUserProgress(username, data){
  const container = $("userProgressResult");
  container.innerHTML = `
    <div class="filter-row" style="margin-bottom:14px;">
      <button data-apv="peso" class="${adminProgressView==='peso'?'active':''}">Peso corporal</button>
      <button data-apv="cargas" class="${adminProgressView==='cargas'?'active':''}">Progreso de cargas</button>
    </div>
    <div id="adminProgressBody"></div>
  `;
  container.querySelectorAll("[data-apv]").forEach(btn=>{
    btn.addEventListener("click", () => {
      adminProgressView = btn.dataset.apv;
      renderUserProgress(username, data);
    });
  });
  if(adminProgressView === "cargas") renderAdminStrengthView(username, data);
  else renderAdminWeightView(username, data);
}

// -------------------- Sub-pestaña: peso corporal --------------------
function renderAdminWeightView(username, data){
  const body = $("adminProgressBody");

  let profileHtml = "";
  if(data.profile){
    const p = data.profile;
    const fecha = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString("es-ES") : "";
    const avatarThumbHtml = safeAvatarUrl(p.avatarBase64)
      ? `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
           <div style="width:44px;height:44px;border-radius:50%;background-image:url('${safeAvatarUrl(p.avatarBase64)}');background-size:cover;background-position:center;flex-shrink:0;border:1px solid var(--line);"></div>
           <button class="danger" id="btnRemoveAvatar" style="width:auto;">Quitar foto (moderación)</button>
         </div>`
      : "";
    profileHtml = `<div style="background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:12px 14px;">
      <div style="font-size:11px;color:var(--faint);font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">Datos aportados por el usuario ${fecha ? `(${fecha})` : ""}</div>
      ${avatarThumbHtml}
      <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:13.5px;">
        <div><b>${esc(p.weightKg)}</b> kg</div>
        <div><b>${esc(p.heightCm)}</b> cm</div>
        <div><b>${esc(TIME_BRACKET_LABELS[p.timeTraining] || p.timeTraining)}</b> entrenando</div>
      </div>
    </div>`;
  } else {
    profileHtml = `<div style="color:var(--faint);font-size:12.5px;font-style:italic;">Este usuario todavía no ha completado el formulario de peso/altura/tiempo entrenando.</div>`;
  }

  let weightSectionHtml = "";
  const weightHistory = ((data.profile && Array.isArray(data.profile.weightHistory)) ? data.profile.weightHistory : [])
    .filter(e => e && typeof e.weightKg === "number" && e.date)
    .sort((a,b) => new Date(a.date) - new Date(b.date));
  if(weightHistory.length > 0){
    const filteredWeight = filterWeightHistoryAdmin(weightHistory, adminWeightChartRange);
    const currentWeight = weightHistory[weightHistory.length - 1].weightKg;
    const rangeLabelsAdmin = { month: "el último mes", quarter: "el último trimestre", semester: "el último semestre", year: "el último año", absolute: "todo el historial" };
    weightSectionHtml = `<div class="stat-card" style="margin-top:16px;">
      <div class="stat-head"><h3>Evolución del peso corporal</h3></div>
      <div class="filter-row" style="margin:8px 0 10px;">
        <button data-wr="month" class="${adminWeightChartRange==='month'?'active':''}">Mensual</button>
        <button data-wr="quarter" class="${adminWeightChartRange==='quarter'?'active':''}">Trimestral</button>
        <button data-wr="semester" class="${adminWeightChartRange==='semester'?'active':''}">Semestral</button>
        <button data-wr="year" class="${adminWeightChartRange==='year'?'active':''}">Anual</button>
        <button data-wr="absolute" class="${adminWeightChartRange==='absolute'?'active':''}">Absoluto</button>
      </div>
      <div style="font-size:13.5px;margin-bottom:8px;">Peso actual: <b>${esc(currentWeight)} kg</b> · ${filteredWeight.length} pesaje${filteredWeight.length===1?'':'s'} en ${rangeLabelsAdmin[adminWeightChartRange]}</div>
      ${buildLineChartSvg(filteredWeight.map(e=>e.weightKg), null, "Necesitas al menos dos pesajes registrados en este periodo para ver la gráfica.")}
    </div>`;
  } else {
    weightSectionHtml = `<div style="color:var(--faint);font-size:12.5px;margin-top:16px;">Este usuario todavía no ha registrado ningún peso.</div>`;
  }

  body.innerHTML = profileHtml + weightSectionHtml;
  bindWeightRangeButtons(username, data);
}

// -------------------- Sub-pestaña: progreso de cargas --------------------
function renderAdminStrengthView(username, data){
  const body = $("adminProgressBody");
  const sessions = (data.state && data.state.sessions) || [];

  if(sessions.length === 0){
    body.innerHTML = '<div style="color:var(--faint);font-size:13px;">Este usuario todavía no tiene sesiones guardadas.</div>';
    return;
  }

  const exerciseNames = [...new Set(sessions.flatMap(s => s.exercises.map(e => e.name)))];
  const allStats = exerciseNames.map(name => {
    const dayNames = getExerciseDayNames(sessions, name);
    const points = buildExerciseSetPointsAdmin(sessions, name);
    const expected = computeExpectedMax(data.profile, name);
    return { name, dayNames, points, expected };
  });
  const filtered = allStats.filter(st => statMatchesQueryAdmin(st.name, st.dayNames, adminProgressSearchQuery));

  let html = `<input type="text" class="prog-search" id="adminProgSearch" placeholder="Buscar por ejercicio, día ('Torso A') o grupo ('pecho')…" value="${esc(adminProgressSearchQuery)}">`;

  if(filtered.length === 0){
    html += `<div style="color:var(--faint);font-size:12.5px;padding:8px 0 4px;">Ningún ejercicio ni día coincide con la búsqueda.</div>`;
  } else {
    filtered.forEach(st => {
      html += `<div class="stat-card">
        <h3>${esc(st.name)}</h3>
        ${st.dayNames.length ? `<div class="stat-day-tags">${st.dayNames.map(d=>`<span class="stat-day-tag">${esc(d)}</span>`).join("")}</div>` : ``}
        ${buildSetChartSvg(st.points, st.expected)}
      </div>`;
    });
  }

  html += `<div style="margin-top:20px;font-size:11px;color:var(--faint);font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;">Historial (${sessions.length} sesión${sessions.length===1?'':'es'})</div>`;

  [...sessions].reverse().forEach(sess => {
    const isOpen = adminExpandedIds.has(sess.id);
    html += `<div class="hist-card">
      <div class="hist-card-top" data-toggle="${esc(sess.id)}">
        <div>
          <div class="hist-card-date">${fmtDateFull(sess.date)}${sess.durationSec ? ` · ⏱ ${fmtWorkoutDuration(sess.durationSec)}` : ""}</div>
          <div class="hist-card-day">${esc(sess.dayName)}${sess.planName ? ` · ${esc(sess.planName)}` : ""}</div>
        </div>
        <span class="chev ${isOpen ? "open" : ""}">›</span>
      </div>`;
    if(isOpen){
      html += `<div class="hist-card-detail">`;
      sess.exercises.forEach(ex => {
        html += `<div style="margin-bottom:9px;">
          <div style="font-size:12px;font-weight:700;color:var(--dim);margin-bottom:5px;">${esc(ex.name)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${ex.sets.map((s,i)=>`<span class="set-chip">S${i+1}: ${(s.kg>0||s.reps>0) ? `${esc(s.kg)}kg × ${esc(s.reps)}` : "—"}</span>`).join("")}
          </div>
        </div>`;
      });
      html += `</div>`;
    }
    html += `</div>`;
  });

  body.innerHTML = html;

  const searchInput = document.getElementById("adminProgSearch");
  if(searchInput){
    searchInput.addEventListener("input", (e) => {
      adminProgressSearchQuery = e.target.value;
      renderAdminStrengthView(username, data);
      const el = document.getElementById("adminProgSearch");
      if(el){ el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  }

  body.querySelectorAll("[data-toggle]").forEach(el => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.toggle);
      if(adminExpandedIds.has(id)) adminExpandedIds.delete(id);
      else adminExpandedIds.add(id);
      renderAdminStrengthView(username, data);
    });
  });
}

// -------------------- Peso corporal (rango) en Progreso admin --------------------
let adminWeightChartRange = "absolute";
function filterWeightHistoryAdmin(history, range){
  const RANGE_DAYS = { month: 30, quarter: 90, semester: 182, year: 365 };
  if(range === "absolute" || !RANGE_DAYS[range]) return history;
  const cutoff = Date.now() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000;
  return history.filter(e => new Date(e.date).getTime() >= cutoff);
}
function bindWeightRangeButtons(username, data){
  document.querySelectorAll("#adminProgressBody [data-wr]").forEach(btn=>{
    btn.addEventListener("click", () => {
      adminWeightChartRange = btn.dataset.wr;
      renderAdminWeightView(username, data);
    });
  });
  const removeAvatarBtn = document.getElementById("btnRemoveAvatar");
  if(removeAvatarBtn){
    removeAvatarBtn.addEventListener("click", async () => {
      if(!confirm(`¿Quitar la foto de perfil de "${username}"? No podrá deshacerse desde aquí; el usuario podrá subir otra cuando quiera.`)) return;
      removeAvatarBtn.disabled = true;
      removeAvatarBtn.textContent = "Quitando…";
      try{
        await apiCall("/admin/remove-avatar", { method: "POST", body: JSON.stringify({ username }) });
        if(data.profile) data.profile.avatarBase64 = null;
        renderUserProgress(username, data);
      }catch(e){
        alert("No se pudo quitar la foto: " + e.message);
        removeAvatarBtn.disabled = false;
        removeAvatarBtn.textContent = "Quitar foto (moderación)";
      }
    });
  }
}

async function loadUserProgressFor(username){
  const msg = $("progressMsg");
  const container = $("userProgressResult");
  if(!username){
    container.innerHTML = "";
    msg.className = "msg";
    return;
  }
  msg.className = "msg";
  container.innerHTML = '<div style="color:var(--faint);font-size:13px;margin-top:14px;">Cargando…</div>';
  try{
    const data = await apiCall("/admin/user-data", { method:"POST", body: JSON.stringify({ username }) });
    // Se reinician al cambiar de usuario para que no se arrastren cosas del
    // usuario anterior (una búsqueda escrita, sesiones expandidas, un rango
    // de fechas) que podían hacer que la pantalla pareciera "atascada" al
    // mostrar datos que no encajaban con el usuario nuevo.
    adminExpandedIds = new Set();
    adminProgressSearchQuery = "";
    adminWeightChartRange = "absolute";
    renderUserProgress(username, data);
  }catch(e){
    showMsg(msg, "Error: " + e.message, false);
    container.innerHTML = "";
  }
}

$("progressUserSelect").addEventListener("change", () => {
  persistIfNeeded();
  loadUserProgressFor($("progressUserSelect").value);
});

$("btnSendTestEmail").addEventListener("click", async () => {
  persistIfNeeded();
  const msg = $("testEmailMsg");
  const username = $("testEmailUserSelect").value;
  const to = $("testEmailTo").value.trim();
  if(!username){
    showMsg(msg, "Elige un usuario primero.", false);
    return;
  }
  const btn = $("btnSendTestEmail");
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = "Enviando…";
  try{
    const body = { username };
    if(to) body.to = to;
    const res = await apiCall("/admin/send-progress-email-test", { method:"POST", body: JSON.stringify(body) });
    showMsg(msg, `Enviado correctamente a ${res.to}.`, true);
  }catch(e){
    showMsg(msg, "No se pudo enviar: " + e.message, false);
  }finally{
    btn.disabled = false;
    btn.textContent = prevText;
  }
});

// -------------------- COPIA DE SEGURIDAD --------------------
$("btnBackup").addEventListener("click", async () => {
  const msg = $("backupMsg");
  try{
    const data = await apiCall("/admin/backup", { raw: true });
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "adeaneasyfit-copia-" + new Date().toISOString().slice(0,10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    showMsg(msg, `Copia descargada: ${Object.keys(data.users).length} usuarios.`, true);
  }catch(e){
    showMsg(msg, "No se pudo crear la copia: " + e.message, false);
  }
});
$("btnRestore").addEventListener("click", async () => {
  const msg = $("backupMsg");
  const file = $("restoreFile").files[0];
  if(!file){ showMsg(msg, "Elige primero un archivo de copia.", false); return; }
  if(!confirm("Esto sobrescribe los datos de los usuarios que estén en la copia. ¿Seguro que quieres restaurar?")) return;
  try{
    const backup = JSON.parse(await file.text());
    const res = await apiCall("/admin/restore", { method:"POST", body: JSON.stringify({ backup, confirm: true }) });
    showMsg(msg, `Restaurado: ${res.users} cuentas y ${res.data} conjuntos de datos.`, true);
  }catch(e){
    showMsg(msg, "No se pudo restaurar: " + e.message, false);
  }
});

// -------------------- RUTINA CLIENTES --------------------
let routinesCurrentUser = null;
let routinesCurrentData = null;
let routineBuilderDraft = null;

$("routinesUserSelect").addEventListener("change", () => {
  persistIfNeeded();
  loadRoutinesForUser($("routinesUserSelect").value);
});

async function loadRoutinesForUser(username){
  const msg = $("routinesMsg");
  const body = $("routinesUserBody");
  $("routineBuilderCard").style.display = "none";
  routinesCurrentUser = username;
  routinesCurrentData = null;
  if(!username){
    body.innerHTML = "";
    msg.className = "msg";
    return;
  }
  msg.className = "msg";
  body.innerHTML = '<div style="color:var(--faint);font-size:13px;margin-top:14px;">Cargando…</div>';
  try{
    const data = await apiCall("/admin/user-data", { method:"POST", body: JSON.stringify({ username }) });
    routinesCurrentData = data;
    renderRoutinesUserBody();
  }catch(e){
    showMsg(msg, "Error: " + e.message, false);
    body.innerHTML = "";
  }
}

function renderRoutinesUserBody(){
  const body = $("routinesUserBody");
  const data = routinesCurrentData;
  const plans = data.plans || [];

  let html = `<div class="icon-btn-row" style="margin-top:14px;">
    <button class="secondary" id="btnNewRoutine">+ Crear rutina nueva</button>
    <button id="btnAiRoutine">Generar con IA</button>
  </div>
  <div id="aiRoutineForm" style="display:none;margin-top:10px;">
    <label>Describe la rutina que quieres generar</label>
    <input type="text" id="aiRoutineBrief" placeholder="p. ej. 3 días, fuerza, enfocado en pecho y espalda">
    <button id="btnAiRoutineGenerate">Generar</button>
    <div class="msg" id="aiRoutineMsg"></div>
  </div>`;

  if(plans.length === 0){
    html += `<div style="color:var(--faint);font-size:12.5px;margin-top:16px;">Este cliente todavía no tiene ninguna rutina.</div>`;
  } else {
    html += `<div style="margin-top:16px;">`;
    plans.forEach(p => {
      const isActive = p.id === data.activePlanId;
      const exCount = (p.days || []).reduce((s,d)=>s+(d.exercises?d.exercises.length:0),0);
      html += `<div class="plan-card">
        <div class="plan-card-top">
          <div>
            <div class="plan-card-name">${esc(p.name)}</div>
            <div class="plan-card-meta">${p.days.length} día${p.days.length===1?"":"s"} · ${exCount} ejercicio${exCount===1?"":"s"}</div>
          </div>
          ${isActive ? `<span class="plan-active-badge">Activa</span>` : ``}
        </div>
        <div class="plan-card-actions">
          <button class="secondary edit-plan-btn" data-plan="${esc(p.id)}">Editar</button>
          ${isActive ? `` : `<button class="secondary activate-plan-btn" data-plan="${esc(p.id)}">Activar</button>`}
          <button class="secondary copy-plan-btn" data-plan="${esc(p.id)}">Copiar a cliente…</button>
          <button class="danger delete-plan-btn" data-plan="${esc(p.id)}">Eliminar</button>
        </div>
        <div class="copy-row" id="copyRow-${esc(p.id)}" style="display:none;">
          <select id="copyTarget-${esc(p.id)}"></select>
          <button id="copyConfirm-${esc(p.id)}">Copiar</button>
        </div>
      </div>`;
    });
    html += `</div>`;
  }

  body.innerHTML = html;

  $("btnNewRoutine").addEventListener("click", () => openRoutineBuilder(null));
  $("btnAiRoutine").addEventListener("click", () => {
    const f = $("aiRoutineForm");
    f.style.display = f.style.display === "none" ? "block" : "none";
  });
  $("btnAiRoutineGenerate").addEventListener("click", async () => {
    const msg = $("aiRoutineMsg");
    const brief = $("aiRoutineBrief").value.trim();
    if(!brief){ showMsg(msg, "Describe qué tipo de rutina quieres.", false); return; }
    const btn = $("btnAiRoutineGenerate");
    btn.disabled = true; btn.textContent = "Generando…";
    try{
      const res = await apiCall("/admin/generate-plan-for-user", { method:"POST", body: JSON.stringify({ username: routinesCurrentUser, brief }) });
      msg.className = "msg";
      $("aiRoutineForm").style.display = "none";
      $("aiRoutineBrief").value = "";
      openRoutineBuilder(null, res.plan);
    }catch(e){
      showMsg(msg, "Error: " + e.message, false);
    } finally {
      btn.disabled = false; btn.textContent = "Generar";
    }
  });

  document.querySelectorAll(".edit-plan-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const plan = plans.find(p => p.id === btn.dataset.plan);
      if(plan) openRoutineBuilder(plan);
    });
  });
  document.querySelectorAll(".activate-plan-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try{
        await apiCall("/admin/set-day", { method:"POST", body: JSON.stringify({ username: routinesCurrentUser, dayIndex: 0, planId: btn.dataset.plan }) });
        await loadRoutinesForUser(routinesCurrentUser);
      }catch(e){
        alert("Error al activar: " + e.message);
        btn.disabled = false;
      }
    });
  });
  document.querySelectorAll(".delete-plan-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const plan = plans.find(p => p.id === btn.dataset.plan);
      if(!confirm(`¿Eliminar la rutina "${plan ? plan.name : ""}"? No se puede deshacer.`)) return;
      try{
        await apiCall("/admin/delete-plan", { method:"POST", body: JSON.stringify({ username: routinesCurrentUser, planId: btn.dataset.plan }) });
        await loadRoutinesForUser(routinesCurrentUser);
      }catch(e){ alert("Error al eliminar: " + e.message); }
    });
  });
  document.querySelectorAll(".copy-plan-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const row = document.getElementById("copyRow-" + btn.dataset.plan);
      const sel = document.getElementById("copyTarget-" + btn.dataset.plan);
      if(sel && sel.children.length === 0){
        sel.innerHTML = '<option value="">— Elige un cliente —</option>' +
          allUsernamesCache.filter(u => u !== routinesCurrentUser).map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join("");
      }
      row.style.display = row.style.display === "none" ? "flex" : "none";
    });
  });
  document.querySelectorAll('[id^="copyConfirm-"]').forEach(btn => {
    const planId = btn.id.replace("copyConfirm-", "");
    btn.addEventListener("click", async () => {
      const sel = document.getElementById("copyTarget-" + planId);
      const toUsername = sel.value;
      if(!toUsername){ alert("Elige un cliente de destino."); return; }
      btn.disabled = true; btn.textContent = "Copiando…";
      try{
        await apiCall("/admin/copy-plan", { method:"POST", body: JSON.stringify({ fromUsername: routinesCurrentUser, toUsername, planId }) });
        alert("Rutina copiada correctamente a " + toUsername + ".");
        document.getElementById("copyRow-" + planId).style.display = "none";
      }catch(e){
        alert("Error al copiar: " + e.message);
      } finally {
        btn.disabled = false; btn.textContent = "Copiar";
      }
    });
  });
}

function openRoutineBuilder(existingPlan, prefillPlan){
  if(existingPlan){
    routineBuilderDraft = {
      id: existingPlan.id,
      name: existingPlan.name,
      days: existingPlan.days.map(day => ({ name: day.name, sub: day.sub || "", exercises: day.exercises.map(e => ({ name: e.name, sets: e.sets })) })),
      activate: existingPlan.id === routinesCurrentData.activePlanId
    };
    $("routineBuilderTitleText").textContent = "Editar rutina";
  } else if(prefillPlan){
    routineBuilderDraft = {
      id: null,
      name: prefillPlan.name,
      days: prefillPlan.days.map(day => ({ name: day.name, sub: day.sub || "", exercises: day.exercises.map(e => ({ name: e.name, sets: e.sets })) })),
      activate: false
    };
    $("routineBuilderTitleText").textContent = "Rutina generada con IA — revísala antes de guardar";
  } else {
    routineBuilderDraft = { id: null, name: "Nueva rutina", days: [{ name: "Día 1", sub: "", exercises: [] }], activate: false };
    $("routineBuilderTitleText").textContent = "Nueva rutina";
  }
  $("routineBuilderCard").style.display = "block";
  renderRoutineBuilder();
  if(typeof $("routineBuilderCard").scrollIntoView === "function"){
    $("routineBuilderCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function syncBuilderFromDom(){
  const nameInput = $("routineNameInput");
  if(nameInput) routineBuilderDraft.name = nameInput.value;
  document.querySelectorAll("#routineBuilderBody .day-card").forEach(dayEl => {
    const dIdx = Number(dayEl.dataset.day);
    const day = routineBuilderDraft.days[dIdx];
    if(!day) return;
    const nameInput2 = dayEl.querySelector(".day-name-input");
    if(nameInput2) day.name = nameInput2.value;
    dayEl.querySelectorAll(".ex-row").forEach(exEl => {
      const eIdx = Number(exEl.dataset.ex);
      const ex = day.exercises[eIdx];
      if(!ex) return;
      const sel = exEl.querySelector("select");
      const setsInput = exEl.querySelector("input");
      if(sel) ex.name = sel.value;
      if(setsInput) ex.sets = Math.max(1, Math.min(12, parseInt(setsInput.value, 10) || 3));
    });
  });
  const activateCheck = $("routineActivateCheck");
  if(activateCheck) routineBuilderDraft.activate = activateCheck.checked;
}

function renderRoutineBuilder(){
  const body = $("routineBuilderBody");
  const d = routineBuilderDraft;

  let html = `<label>Nombre de la rutina</label>
    <input type="text" id="routineNameInput" value="${escapeAttrAdmin(d.name)}">`;

  d.days.forEach((day, dIdx) => {
    html += `<div class="day-card" data-day="${dIdx}">
      <div class="day-card-head">
        <input type="text" class="day-name-input" value="${escapeAttrAdmin(day.name)}" placeholder="Nombre del día">
        <button class="danger remove-day-btn" data-day="${dIdx}" style="width:auto;padding:8px 10px;">✕</button>
      </div>`;
    day.exercises.forEach((ex, eIdx) => {
      html += `<div class="ex-row" data-day="${dIdx}" data-ex="${eIdx}">
        <select>${exerciseOptionsGroupedHtml(ex.name)}</select>
        <input type="number" min="1" max="12" value="${esc(ex.sets)}">
        <button class="danger remove-ex-btn" data-day="${dIdx}" data-ex="${eIdx}">✕</button>
      </div>`;
    });
    html += `<button class="secondary add-ex-btn" data-day="${dIdx}" style="margin-top:2px;">+ Añadir ejercicio</button>
    </div>`;
  });

  html += `<button class="secondary" id="btnAddDay" style="margin-bottom:14px;">+ Añadir día</button>
    <div class="remember"><input type="checkbox" id="routineActivateCheck" ${d.activate ? "checked" : ""}> Activar esta rutina para el cliente ahora</div>
    <div class="icon-btn-row">
      <button class="secondary" id="btnCancelRoutine">Cancelar</button>
      <button id="btnSaveRoutine">Guardar rutina</button>
    </div>
    <div class="msg" id="routineBuilderMsg"></div>`;

  body.innerHTML = html;

  document.querySelectorAll(".remove-day-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      syncBuilderFromDom();
      d.days.splice(Number(btn.dataset.day), 1);
      renderRoutineBuilder();
    });
  });
  document.querySelectorAll(".add-ex-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      syncBuilderFromDom();
      d.days[Number(btn.dataset.day)].exercises.push({ name: EXERCISE_LIBRARY[0].name, sets: 3 });
      renderRoutineBuilder();
    });
  });
  document.querySelectorAll(".remove-ex-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      syncBuilderFromDom();
      d.days[Number(btn.dataset.day)].exercises.splice(Number(btn.dataset.ex), 1);
      renderRoutineBuilder();
    });
  });
  $("btnAddDay").addEventListener("click", () => {
    syncBuilderFromDom();
    d.days.push({ name: "Día " + (d.days.length + 1), sub: "", exercises: [] });
    renderRoutineBuilder();
  });
  $("btnCancelRoutine").addEventListener("click", () => {
    $("routineBuilderCard").style.display = "none";
  });
  $("btnSaveRoutine").addEventListener("click", saveRoutineBuilder);
}

async function saveRoutineBuilder(){
  syncBuilderFromDom();
  const msg = $("routineBuilderMsg");
  const d = routineBuilderDraft;
  if(!d.name.trim()){ showMsg(msg, "Ponle un nombre a la rutina.", false); return; }
  if(d.days.length === 0 || d.days.every(day => day.exercises.length === 0)){
    showMsg(msg, "Añade al menos un ejercicio.", false);
    return;
  }
  const btn = $("btnSaveRoutine");
  btn.disabled = true; btn.textContent = "Guardando…";
  try{
    const plan = { name: d.name.trim(), days: d.days };
    if(d.id) plan.id = d.id;
    await apiCall("/admin/save-plan", { method:"POST", body: JSON.stringify({ username: routinesCurrentUser, plan, activate: !!d.activate }) });
    showMsg(msg, "Rutina guardada correctamente.", true);
    $("routineBuilderCard").style.display = "none";
    await loadRoutinesForUser(routinesCurrentUser);
  }catch(e){
    showMsg(msg, "Error: " + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = "Guardar rutina";
  }
}

// -------------------- PANEL DE CLIENTES --------------------
let clientPanelData = null;
let clientPanelExercise = null;
let clientPanelCurrentUser = null;
let clientPanelMode = "dia";       // "dia" | "mensual" | "individual"
let clientPanelDayIndex = 0;
let clientPanelSessionDate = null; // (modo "dia") fecha concreta elegida de entre las sesiones registradas para ese día; null = la más reciente
let clientPanelScope = "dia";      // (modo individual) "dia" | "semana"
let clientPanelRangeDays = null;   // (modo individual) null=todo, o 7/30/90

$("clientPanelUserSelect").addEventListener("change", () => {
  persistIfNeeded();
  loadClientPanelFor($("clientPanelUserSelect").value);
});

async function loadClientPanelFor(username){
  const msg = $("clientPanelMsg");
  const body = $("clientPanelBody");
  clientPanelCurrentUser = username;
  if(!username){
    body.innerHTML = "";
    msg.className = "msg";
    return;
  }
  msg.className = "msg";
  body.innerHTML = '<div style="color:var(--faint);font-size:13px;margin-top:14px;">Cargando…</div>';
  try{
    const data = await apiCall("/admin/user-data", { method:"POST", body: JSON.stringify({ username }) });
    clientPanelData = data;
    clientPanelExercise = null;
    clientPanelDayIndex = 0;
    clientPanelSessionDate = null;
    renderClientPanel();
  }catch(e){
    showMsg(msg, "Error: " + e.message, false);
    body.innerHTML = "";
  }
}

function clientPanelActivePlan(){
  const data = clientPanelData;
  const plans = ((data && data.plans) || []).filter(p => Array.isArray(p.days) && p.days.length > 0);
  if(plans.length === 0) return null;
  return plans.find(p => p.id === data.activePlanId) || plans[0];
}

function renderClientPanel(){
  const body = $("clientPanelBody");
  const data = clientPanelData;
  const sessions = (data.state && data.state.sessions) || [];
  const plan = clientPanelActivePlan();

  let html = `<div class="filter-row" style="margin-top:14px;">
    <button data-cpm="dia" class="${clientPanelMode==='dia'?'active':''}">Por día</button>
    <button data-cpm="mensual" class="${clientPanelMode==='mensual'?'active':''}">Mensual</button>
    <button data-cpm="individual" class="${clientPanelMode==='individual'?'active':''}">Individual por ejercicio</button>
  </div>`;

  if((clientPanelMode === "dia" || clientPanelMode === "mensual")){
    if(!plan){
      html += `<div style="color:var(--faint);font-size:12.5px;margin-top:10px;">Este cliente todavía no tiene una rutina asignada. Ve a "Rutinas" para crearle una.</div>`;
      body.innerHTML = html;
      wireClientPanelModeTabs();
      return;
    }
    if(clientPanelDayIndex >= plan.days.length) clientPanelDayIndex = 0;
    html += `<div class="filter-row" style="margin-top:10px;flex-wrap:wrap;">
      ${plan.days.map((d,i) => `<button data-cpd="${i}" class="${i===clientPanelDayIndex?'active':''}">${i+1}. ${esc(d.name)}</button>`).join("")}
    </div>`;
    const day = plan.days[clientPanelDayIndex];
    const exList = day.exercises || [];
    if(!clientPanelExercise || !exList.some(e => e.name === clientPanelExercise)){
      clientPanelExercise = exList.length ? exList[0].name : null;
    }
    html += `<div class="day-card" style="margin-top:10px;">
      <div class="day-card-head"><h4 style="margin:0;">${esc(day.name)}</h4></div>`;
    exList.forEach(ex => {
      const lib = findExerciseByName(ex.name);
      const imgUrl = lib ? exerciseImgUrl(lib.id) : "";
      const isSel = ex.name === clientPanelExercise;
      html += `<div class="ex-row" data-cpex="${escapeAttrAdmin(ex.name)}" style="cursor:pointer;${isSel?'outline:2px solid var(--accent,#ff5a2e);border-radius:10px;':''}">
        <div class="ex-thumb" ${imgUrl ? `style="background-image:url('${imgUrl}')"` : ""}></div>
        <div>${esc(ex.name)}</div>
      </div>`;
    });
    html += `</div>`;

    // Modo "día": además de elegir el día de rutina, se puede elegir CUÁL de
    // las fechas registradas para ese día usar (en vez de asumir siempre la
    // más reciente) — tanto para el informe por email como para el
    // desglose que se muestra debajo.
    let daySessionsForPicker = [];
    if(clientPanelMode === "dia"){
      daySessionsForPicker = sessions.filter(s => s.dayName === day.name).sort((a,b)=> new Date(b.date) - new Date(a.date));
      if(daySessionsForPicker.length){
        if(!clientPanelSessionDate || !daySessionsForPicker.some(s=>s.date===clientPanelSessionDate)){
          clientPanelSessionDate = daySessionsForPicker[0].date;
        }
        html += `<label style="margin-top:12px;">Fecha registrada a usar</label>
        <div class="filter-row" style="margin-top:4px;flex-wrap:wrap;">
          ${daySessionsForPicker.map(s => `<button data-cpsd="${escapeAttrAdmin(s.date)}" class="${s.date===clientPanelSessionDate?'active':''}">${new Date(s.date).toLocaleDateString("es-ES")}</button>`).join("")}
        </div>`;
      } else {
        clientPanelSessionDate = null;
      }
    }

    const savedEmail = localStorage.getItem("adeanfit_admin_notify_email") || "";
    html += `<label style="margin-top:12px;">Comentario del entrenador (opcional, se incluye en el informe)</label>
    <textarea id="clientPanelDayComment" rows="2" placeholder="Ej: buen ajuste en la primera serie, para la próxima semana subimos la sombra esperada…"></textarea>
    <div class="copy-row" style="margin-top:10px;">
      <input type="email" id="clientPanelDayEmailTo" placeholder="tu-email@ejemplo.com" value="${escapeAttrAdmin(savedEmail)}" style="margin-bottom:0;">
      <button id="btnSendDayEmail">Enviar informe del día completo</button>
    </div>
    <div class="msg" id="clientPanelDayEmailMsg"></div>`;
    html += `<div id="clientPanelExerciseBody"></div>`;
  } else {
    // Modo individual: cualquier ejercicio registrado alguna vez, con control
    // de intervalo y de alcance (solo ese día vs semana completa).
    const exerciseNames = [...new Set(sessions.flatMap(s => s.exercises.map(e => e.name)))];
    if(exerciseNames.length === 0){
      html += `<div style="color:var(--faint);font-size:12.5px;margin-top:10px;">Este cliente todavía no tiene ejercicios registrados.</div>`;
      body.innerHTML = html;
      wireClientPanelModeTabs();
      return;
    }
    if(!clientPanelExercise || !exerciseNames.includes(clientPanelExercise)){
      clientPanelExercise = exerciseNames[0];
    }
    html += `<label style="margin-top:12px;">Ejercicio</label>
      <select id="clientPanelExerciseSelect">${exerciseNames.map(n => `<option value="${escapeAttrAdmin(n)}" ${n===clientPanelExercise?"selected":""}>${esc(n)}</option>`).join("")}</select>`;
    html += `<div class="filter-row" style="margin-top:10px;">
      <button data-cps="dia" class="${clientPanelScope==='dia'?'active':''}">Rutina diaria (solo un día)</button>
      <button data-cps="semana" class="${clientPanelScope==='semana'?'active':''}">Rutina semanal completa</button>
    </div>`;
    if(clientPanelScope === "dia"){
      const dayNames = getExerciseDayNames(sessions, clientPanelExercise);
      html += `<div class="filter-row" style="margin-top:6px;flex-wrap:wrap;">
        ${dayNames.map(d => `<button data-cpdn="${escapeAttrAdmin(d)}" class="${d===clientPanelDayName?'active':''}">${esc(d)}</button>`).join("")}
      </div>`;
    }
    html += `<div class="filter-row" style="margin-top:6px;">
      <button data-cpr="7" class="${clientPanelRangeDays===7?'active':''}">7 días</button>
      <button data-cpr="30" class="${clientPanelRangeDays===30?'active':''}">30 días</button>
      <button data-cpr="90" class="${clientPanelRangeDays===90?'active':''}">90 días</button>
      <button data-cpr="all" class="${clientPanelRangeDays==null?'active':''}">Todo</button>
    </div>`;
    html += `<div id="clientPanelExerciseBody"></div>`;
  }

  body.innerHTML = html;
  wireClientPanelModeTabs();

  if(clientPanelMode === "dia" || clientPanelMode === "mensual"){
    body.querySelectorAll("[data-cpd]").forEach(btn=>{
      btn.addEventListener("click", ()=>{ clientPanelDayIndex = parseInt(btn.dataset.cpd,10); clientPanelExercise = null; clientPanelSessionDate = null; renderClientPanel(); });
    });
    body.querySelectorAll("[data-cpex]").forEach(row=>{
      row.addEventListener("click", ()=>{ clientPanelExercise = row.dataset.cpex; renderClientPanel(); });
    });
    body.querySelectorAll("[data-cpsd]").forEach(btn=>{
      btn.addEventListener("click", ()=>{ clientPanelSessionDate = btn.dataset.cpsd; renderClientPanel(); });
    });
    const dayEmailBtn = $("btnSendDayEmail");
    if(dayEmailBtn){
      dayEmailBtn.addEventListener("click", async () => {
        const msg = $("clientPanelDayEmailMsg");
        const to = $("clientPanelDayEmailTo").value.trim();
        if(!to){ showMsg(msg, "Escribe a qué email quieres enviarlo.", false); return; }
        localStorage.setItem("adeanfit_admin_notify_email", to);
        dayEmailBtn.disabled = true; dayEmailBtn.textContent = "Enviando…";
        const comment = ($("clientPanelDayComment") && $("clientPanelDayComment").value.trim()) || "";
        try{
          await apiCall("/admin/send-report-email", { method:"POST", body: JSON.stringify({ kind:"day", username: clientPanelCurrentUser, dayName: plan.days[clientPanelDayIndex].name, to, comment, sessionDate: clientPanelMode === "dia" ? clientPanelSessionDate : null }) });
          showMsg(msg, "Enviado correctamente a " + to + ".", true);
        }catch(e){
          showMsg(msg, "No se pudo enviar: " + e.message, false);
        } finally {
          dayEmailBtn.disabled = false; dayEmailBtn.textContent = "Enviar informe del día completo";
        }
      });
    }
    if(clientPanelExercise) renderClientPanelExercise();
  } else {
    $("clientPanelExerciseSelect").addEventListener("change", (e) => {
      clientPanelExercise = e.target.value;
      clientPanelDayName = null;
      renderClientPanel();
    });
    body.querySelectorAll("[data-cps]").forEach(btn=>{
      btn.addEventListener("click", ()=>{ clientPanelScope = btn.dataset.cps; clientPanelDayName = null; renderClientPanel(); });
    });
    body.querySelectorAll("[data-cpdn]").forEach(btn=>{
      btn.addEventListener("click", ()=>{ clientPanelDayName = btn.dataset.cpdn; renderClientPanel(); });
    });
    body.querySelectorAll("[data-cpr]").forEach(btn=>{
      btn.addEventListener("click", ()=>{ clientPanelRangeDays = btn.dataset.cpr === "all" ? null : parseInt(btn.dataset.cpr,10); renderClientPanel(); });
    });
    renderClientPanelExercise();
  }
}

function wireClientPanelModeTabs(){
  document.querySelectorAll("[data-cpm]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      clientPanelMode = btn.dataset.cpm;
      clientPanelExercise = null;
      clientPanelDayName = null;
      clientPanelSessionDate = null;
      renderClientPanel();
    });
  });
}

let clientPanelDayName = null; // (modo individual, alcance "dia") día elegido para filtrar

function renderClientPanelExercise(){
  const exBody = $("clientPanelExerciseBody");
  if(!exBody) return;
  const data = clientPanelData;
  const sessions = (data.state && data.state.sessions) || [];
  const name = clientPanelExercise;
  const lib = findExerciseByName(name);
  const expected = computeExpectedMax(data.profile, name);
  const muscleLabel = lib ? (lib.sub ? `${lib.muscle} — ${lib.sub}` : lib.muscle) : "";
  const imgUrl = lib ? exerciseImgUrl(lib.id) : "";

  let chartHtml, chartLabel;
  if(clientPanelMode === "mensual"){
    const plan = clientPanelActivePlan();
    const dayName = plan ? plan.days[clientPanelDayIndex].name : null;
    const monthlyPoints = buildExerciseMonthlyPointsAdmin(sessions, name, { dayName });
    chartHtml = buildSetChartSvg(monthlyPoints, expected, "Necesitas al menos 2 meses con datos de este ejercicio para ver la gráfica mensual.", "big-chart");
    chartLabel = "Evolución mensual (máximo por mes)";
  } else if(clientPanelMode === "dia"){
    const plan = clientPanelActivePlan();
    const dayName = plan ? plan.days[clientPanelDayIndex].name : null;
    const points = buildExerciseSetPointsAdmin(sessions, name, { dayName });
    chartHtml = buildSetChartSvg(points, expected, "Necesitas al menos 2 series registradas de este ejercicio en este día para ver la gráfica.", "big-chart");
    chartLabel = "Evolución por serie en este día (kg y repeticiones)";
  } else {
    const dayName = (clientPanelScope === "dia") ? clientPanelDayName : null;
    const points = buildExerciseSetPointsAdmin(sessions, name, { dayName, rangeDays: clientPanelRangeDays });
    chartHtml = buildSetChartSvg(points, expected, "Necesitas al menos 2 series registradas con estos filtros para ver la gráfica.", "big-chart");
    chartLabel = "Evolución por serie (kg y repeticiones)";
  }

  let html = `<div class="exercise-big-card">
    <div class="ex-thumb lg" ${imgUrl ? `style="background-image:url('${imgUrl}')"` : ""}></div>
    <div>
      <h3>${esc(name)}</h3>
      ${muscleLabel ? `<span class="muscle-tag">${muscleLabel}</span>` : ""}
    </div>
  </div>`;
  html += `<div class="m-label" style="margin:8px 0 6px;">${chartLabel}${expected!=null ? ' · con expectativa para tu experiencia' : ''}</div>`;
  html += chartHtml;

  // El envío por email de este ejercicio suelto solo tiene sentido en modo
  // "Individual por ejercicio": en "Por día"/"Mensual" ya existe el botón de
  // "Enviar informe del día completo" justo encima (sería un duplicado).
  const showExerciseEmailBox = clientPanelMode === "individual";
  if(showExerciseEmailBox){
    const savedEmail = localStorage.getItem("adeanfit_admin_notify_email") || "";
    html += `<div class="copy-row" style="margin-top:14px;">
      <input type="email" id="clientPanelEmailTo" placeholder="tu-email@ejemplo.com" value="${escapeAttrAdmin(savedEmail)}" style="margin-bottom:0;">
      <button id="btnSendChartEmail">Enviar por email</button>
    </div>
    <div class="msg" id="clientPanelEmailMsg"></div>`;
  }

  exBody.innerHTML = html;

  if(showExerciseEmailBox){
    $("btnSendChartEmail").addEventListener("click", async () => {
      const msg = $("clientPanelEmailMsg");
      const to = $("clientPanelEmailTo").value.trim();
      if(!to){ showMsg(msg, "Escribe a qué email quieres enviarlo.", false); return; }
      localStorage.setItem("adeanfit_admin_notify_email", to);
      const btn = $("btnSendChartEmail");
      btn.disabled = true; btn.textContent = "Enviando…";
      try{
        await apiCall("/admin/send-report-email", { method:"POST", body: JSON.stringify({ kind:"exercise", username: clientPanelCurrentUser, exerciseName: name, to }) });
        showMsg(msg, "Enviado correctamente a " + to + ".", true);
      }catch(e){
        showMsg(msg, "No se pudo enviar: " + e.message, false);
      } finally {
        btn.disabled = false; btn.textContent = "Enviar por email";
      }
    });
  }
}

// -------------------- SUGERENCIAS DE EJERCICIOS --------------------
async function loadSuggestions(){
  const msg = $("suggestionsMsg");
  const listEl = $("suggestionsList");
  try{
    const data = await apiCall("/admin/exercise-suggestions", { method: "GET" });
    listEl.innerHTML = "";
    if(!data.suggestions || data.suggestions.length === 0){
      listEl.innerHTML = '<li style="color:var(--faint);">No hay sugerencias pendientes.</li>';
    } else {
      data.suggestions.forEach(s => {
        const li = document.createElement("li");
        li.style.flexWrap = "wrap";
        li.style.alignItems = "flex-start";
        const d = new Date(s.date);
        const fecha = String(d.getDate()).padStart(2,"0") + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + d.getFullYear();
        const info = document.createElement("div");
        info.innerHTML = `<b>${esc(s.name)}</b>${s.muscle ? ` <span style="color:var(--faint);font-size:11px;">(${esc(s.muscle)})</span>` : ""}<br>
          <span style="color:var(--faint);font-size:11px;">sugerido por ${esc(s.suggestedBy)} · ${esc(fecha)}</span>`;
        li.appendChild(info);
        const delBtn = document.createElement("button");
        delBtn.className = "danger";
        delBtn.textContent = "Descartar";
        delBtn.addEventListener("click", async () => {
          try{
            await apiCall("/admin/dismiss-suggestion", { method:"POST", body: JSON.stringify({ id: s.id }) });
            loadSuggestions();
          }catch(e){ alert("Error: " + e.message); }
        });
        li.appendChild(delBtn);
        listEl.appendChild(li);
      });
    }
    msg.className = "msg";
  }catch(e){
    showMsg(msg, "Error: " + e.message, false);
  }
}
$("btnLoadSuggestions").addEventListener("click", () => { persistIfNeeded(); loadSuggestions(); });

// cargar lista al abrir si ya hay clave guardada
if($("adminKey") && $("adminKey").value){ loadUsers(); loadSuggestions(); }
