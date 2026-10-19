/**
 * ADEANFIT — Worker API
 * Sistema de usuarios cerrado:
 *  - Solo el admin (con ADMIN_KEY) puede crear usuarios.
 *  - Un usuario ya creado puede iniciar sesión y cambiar su propia contraseña.
 *  - Cada usuario tiene su propio espacio de datos (rutinas, sesiones, progreso).
 *
 * Requiere:
 *  - KV Namespace enlazado como ADEANFIT_KV (Settings -> Variables -> KV Namespace Bindings)
 *  - Variable de entorno secreta ADMIN_KEY (Settings -> Variables -> Environment Variables, marcada "Encrypt")
 */

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 días de sesión

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  return sha256Hex(salt + ":" + password);
}

// ---- Protección contra adivinar contraseñas ----
// Cuenta fallos en KV con caducidad. Al llegar al máximo se bloquea durante la ventana.
const MAX_LOGIN_FAILS_USER = 5;      // por usuario
const MAX_LOGIN_FAILS_IP = 30;       // por dirección IP (cubre varios usuarios)
const MAX_ADMIN_FAILS_IP = 10;       // intentos fallidos con la clave de administrador
const FAIL_WINDOW_SECONDS = 15 * 60; // 15 minutos
const MIN_PASSWORD_LENGTH = 8;

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "desconocida";
}

async function failCount(env, key) {
  const v = await env.ADEANFIT_KV.get(key);
  return v ? parseInt(v, 10) || 0 : 0;
}

async function addFail(env, key) {
  const n = (await failCount(env, key)) + 1;
  await env.ADEANFIT_KV.put(key, String(n), { expirationTtl: FAIL_WINDOW_SECONDS });
  return n;
}

function tooMany() {
  return err("Demasiados intentos fallidos. Espera 15 minutos y vuelve a probar.", 429);
}

// Comparación que no revela por el tiempo cuántos caracteres acertaste.
function safeEqual(a, b) {
  const x = String(a || ""), y = String(b || "");
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

// Devuelve null si la clave de administrador es correcta, o la respuesta de error si no.
async function checkAdmin(env, request) {
  const ipKey = "fail:admin:" + clientIp(request);
  if ((await failCount(env, ipKey)) >= MAX_ADMIN_FAILS_IP) return tooMany();
  const key = request.headers.get("X-Admin-Key") || "";
  if (!env.ADMIN_KEY || !safeEqual(key, env.ADMIN_KEY)) {
    await addFail(env, ipKey);
    return err("No autorizado.", 401);
  }
  return null;
}

function passwordProblem(pw) {
  if (!pw || pw.length < MIN_PASSWORD_LENGTH) return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (pw.length > 200) return "La contraseña es demasiado larga.";
  return null;
}

function normalizeUsername(u) {
  return String(u || "").trim().toLowerCase();
}

function newPlanId() {
  return "plan_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
}

// -------------------- helpers de progreso (para el analisis de IA) --------------------
function exerciseVolume(sets) {
  return (sets || []).reduce((sum, s) => sum + (s.kg || 0) * (s.reps || 0), 0);
}
function exerciseMaxWeight(sets) {
  return (sets || []).reduce((m, s) => ((s.kg || 0) > m ? s.kg : m), 0);
}

// Construye un resumen de texto compacto del progreso reciente, para dárselo a la IA
function buildProgressSummary(state) {
  const sessions = (state && state.sessions) || [];
  if (sessions.length === 0) return null;

  const byExercise = {};
  sessions.forEach(sess => {
    sess.exercises.forEach(ex => {
      if (!byExercise[ex.name]) byExercise[ex.name] = [];
      byExercise[ex.name].push({
        date: sess.date,
        volume: exerciseVolume(ex.sets),
        maxKg: exerciseMaxWeight(ex.sets),
      });
    });
  });

  const lines = [];
  lines.push(`Total de sesiones registradas: ${sessions.length}`);
  const lastDate = sessions[sessions.length - 1].date;
  lines.push(`Última sesión: ${new Date(lastDate).toLocaleDateString("es-ES")}`);
  lines.push("");
  lines.push("Progreso por ejercicio (de más antiguo a más reciente, peso máximo por sesión):");

  Object.entries(byExercise).forEach(([name, entries]) => {
    const ordered = entries.filter(e => e.maxKg > 0);
    if (ordered.length === 0) return;
    const series = ordered.map(e => e.maxKg).join(" -> ");
    lines.push(`- ${name}: ${series} kg (${ordered.length} registros)`);
  });

  return lines.join("\n");
}

// Extrae el primer bloque JSON válido de un texto (por si el modelo añade texto de más)
function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Lista cerrada de ejercicios — debe coincidir con EXERCISE_LIBRARY de la app.
// "secondary" marca cuando un ejercicio también sirve para otro grupo muscular
// (p. ej. Face pull es de Espalda pero también vale como ejercicio de Hombro),
// para que la IA pueda usarlo con flexibilidad al generar rutinas.
const EXERCISE_LIBRARY = [
  { name: "Aperturas de pecho en máquina", muscle: "Pecho" },
  { name: "Aperturas de pecho en poleas", muscle: "Pecho" },
  { name: "Flexiones", muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { name: "Fondos en máquina", muscle: "Pecho", secondary: ["Tríceps"] },
  { name: "Fondos en paralelas", muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { name: "Press declinado con barra", muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { name: "Press de pecho en máquina", muscle: "Pecho", secondary: ["Tríceps"] },
  { name: "Press inclinado en máquina", muscle: "Pecho", secondary: ["Tríceps"] },
  { name: "Press inclinado con mancuernas", muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { name: "Press inclinado en Smith", muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { name: "Press plano con mancuernas", muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { name: "Press plano en Smith", muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { name: "Pull-over con mancuerna", muscle: "Pecho", secondary: ["Espalda"] },
  { name: "Press banca", muscle: "Pecho", secondary: ["Tríceps", "Hombro"] },
  { name: "Dominadas", muscle: "Espalda", secondary: ["Bíceps"] },
  { name: "Encogimientos con mancuernas", muscle: "Espalda" },
  { name: "Jalón al pecho", muscle: "Espalda", secondary: ["Bíceps"] },
  { name: "Jalón en máquina", muscle: "Espalda", secondary: ["Bíceps"] },
  { name: "Peso muerto", muscle: "Espalda", secondary: ["Glúteo", "Femoral"] },
  { name: "Remo con mancuernas", muscle: "Espalda", secondary: ["Bíceps"] },
  { name: "Remo con barra", muscle: "Espalda", secondary: ["Bíceps"] },
  { name: "Remo en máquina", muscle: "Espalda", secondary: ["Bíceps"] },
  { name: "Remo en T", muscle: "Espalda", secondary: ["Bíceps"] },
  { name: "Face pull", muscle: "Espalda", secondary: ["Hombro"] },
  { name: "Extensión lumbar", muscle: "Espalda", secondary: ["Glúteo", "Femoral"] },
  { name: "Jalón con agarre cerrado supino", muscle: "Espalda", secondary: ["Bíceps"] },
  { name: "Elevaciones frontales con mancuernas", muscle: "Hombro" },
  { name: "Pajaritos", muscle: "Hombro", secondary: ["Espalda"] },
  { name: "Pec deck posterior invertido", muscle: "Hombro", secondary: ["Espalda"] },
  { name: "Press militar con mancuernas", muscle: "Hombro", secondary: ["Tríceps"] },
  { name: "Aperturas de hombro en poleas", muscle: "Hombro" },
  { name: "Aperturas de hombro", muscle: "Hombro" },
  { name: "Press militar con barra", muscle: "Hombro", secondary: ["Tríceps"] },
  { name: "Remo vertical", muscle: "Hombro", secondary: ["Espalda"] },
  { name: "Press militar en máquina", muscle: "Hombro", secondary: ["Tríceps"] },
  { name: "Apertura de hombro en máquina", muscle: "Hombro" },
  { name: "Press Arnold", muscle: "Hombro", secondary: ["Tríceps"] },
  { name: "Curl con barra recta", muscle: "Bíceps" },
  { name: "Curl con barra Z", muscle: "Bíceps" },
  { name: "Curl en polea", muscle: "Bíceps" },
  { name: "Curl concentrado", muscle: "Bíceps" },
  { name: "Curl martillo", muscle: "Bíceps" },
  { name: "Curl predicador con barra", muscle: "Bíceps" },
  { name: "Curl predicador con mancuernas", muscle: "Bíceps" },
  { name: "Curl predicador en máquina", muscle: "Bíceps" },
  { name: "Curl con mancuernas alterno", muscle: "Bíceps" },
  { name: "Curl bayesiano en polea", muscle: "Bíceps" },
  { name: "Patada de tríceps en polea", muscle: "Tríceps" },
  { name: "Extensión de tríceps trasnuca", muscle: "Tríceps" },
  { name: "Patada de tríceps con mancuerna", muscle: "Tríceps" },
  { name: "Press francés con barra Z", muscle: "Tríceps" },
  { name: "Press de tríceps en máquina", muscle: "Tríceps" },
  { name: "Flexión diamante de tríceps", muscle: "Tríceps", secondary: ["Pecho", "Hombro"] },
  { name: "Fondos en máquina de tríceps", muscle: "Tríceps" },
  { name: "Fondos libres de tríceps", muscle: "Tríceps", secondary: ["Pecho", "Hombro"] },
  { name: "Press cerrado con barra", muscle: "Tríceps", secondary: ["Pecho"] },
  { name: "Press francés con mancuernas", muscle: "Tríceps" },
  { name: "Press francés en polea", muscle: "Tríceps" },
  { name: "Extensión de tríceps en polea alta", muscle: "Tríceps" },
  { name: "Press de tríceps unilateral en polea", muscle: "Tríceps" },
  { name: "Abdominales con levantamiento de piernas en 90°", muscle: "Abdomen" },
  { name: "Crunch de abdomen en polea", muscle: "Abdomen" },
  { name: "Crunch de abdomen", muscle: "Abdomen" },
  { name: "Dragon flags de abdomen", muscle: "Abdomen" },
  { name: "Planchas abdominales", muscle: "Abdomen", secondary: ["Hombro"] },
  { name: "Rodillas al pecho", muscle: "Abdomen" },
  { name: "Rotación de oblicuos en poleas", muscle: "Abdomen" },
  { name: "Rueda abdominal", muscle: "Abdomen", secondary: ["Hombro", "Espalda"] },
  { name: "Crunch de abdomen en máquina", muscle: "Abdomen" },
  { name: "Curl femoral tumbado", muscle: "Pierna", sub: "Femoral" },
  { name: "Curl femoral sentado", muscle: "Pierna", sub: "Femoral" },
  { name: "Hip thrust", muscle: "Pierna", sub: "Glúteo", secondary: ["Femoral"] },
  { name: "Patada de glúteo en polea", muscle: "Pierna", sub: "Glúteo", secondary: ["Femoral"] },
  { name: "Peso muerto rumano con barra", muscle: "Pierna", sub: "Glúteo", secondary: ["Femoral"] },
  { name: "Peso muerto rumano con mancuernas", muscle: "Pierna", sub: "Glúteo", secondary: ["Femoral"] },
  { name: "Aductor externo en máquina", muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo"] },
  { name: "Aductor interno en máquina", muscle: "Pierna", sub: "Cuádriceps" },
  { name: "Hack squat", muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo"] },
  { name: "Prensa de piernas", muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo"] },
  { name: "Sentadilla con barra", muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo", "Abdomen"] },
  { name: "Sentadilla pendular", muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo"] },
  { name: "Zancadas con mancuernas", muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo"] },
  { name: "Zancadas búlgaras", muscle: "Pierna", sub: "Cuádriceps", secondary: ["Glúteo"] },
  { name: "Extensión de cuádriceps", muscle: "Pierna", sub: "Cuádriceps" },
  { name: "Extensión de gemelo sentado", muscle: "Pierna", sub: "Gemelo" },
  { name: "Extensión de gemelo de pie", muscle: "Pierna", sub: "Gemelo" },
];
const EXERCISE_LIBRARY_NAMES = EXERCISE_LIBRARY.map(e => e.name);

// Distintos modelos de Workers AI devuelven el texto en campos ligeramente distintos.
// Esta función prueba las formas más habituales antes de rendirse.
function extractModelText(aiRes) {
  if (!aiRes) return "";
  if (typeof aiRes === "string") return aiRes;
  if (typeof aiRes.response === "string" && aiRes.response.trim()) return aiRes.response;
  if (aiRes.result && typeof aiRes.result.response === "string") return aiRes.result.response;
  if (Array.isArray(aiRes.choices) && aiRes.choices[0] && aiRes.choices[0].message) {
    return aiRes.choices[0].message.content || "";
  }
  if (typeof aiRes.output_text === "string") return aiRes.output_text;
  if (typeof aiRes.text === "string") return aiRes.text;
  return "";
}

async function getUserFromToken(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const username = await env.ADEANFIT_KV.get("session:" + token);
  if (!username) return null;
  // Si el usuario ha sido suspendido, se corta el acceso aunque tenga sesión activa
  const raw = await env.ADEANFIT_KV.get("user:" + username);
  if (!raw) return null;
  const user = JSON.parse(raw);
  if (user.suspended) return null;
  return username;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // ---------------------------------------------------------------
    // ADMIN: crear usuario  (POST /admin/create-user)
    // Header: X-Admin-Key: <tu clave admin>
    // Body: { "username": "...", "password": "..." }
    // ---------------------------------------------------------------
    if (path === "/admin/create-user" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");

      if (!username || username.length < 2) return err("Usuario inválido.");
      const pwProblem = passwordProblem(password);
      if (pwProblem) return err(pwProblem);

      const existing = await env.ADEANFIT_KV.get("user:" + username);
      if (existing) return err("Ese usuario ya existe.", 409);

      const salt = randomHex(16);
      const hash = await hashPassword(password, salt);
      await env.ADEANFIT_KV.put("user:" + username, JSON.stringify({
        username, salt, hash, createdAt: new Date().toISOString()
      }));
      // espacio de datos vacío inicial
      await env.ADEANFIT_KV.put("data:" + username, JSON.stringify({ plans: [], activePlanId: null, state: null }));

      return json({ ok: true, username });
    }

    // ---------------------------------------------------------------
    // ADMIN: listar usuarios  (GET /admin/users)
    // Header: X-Admin-Key
    // ---------------------------------------------------------------
    if (path === "/admin/users" && request.method === "GET") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const list = await env.ADEANFIT_KV.list({ prefix: "user:" });
      const users = [];
      for (const k of list.keys) {
        const raw = await env.ADEANFIT_KV.get(k.name);
        if (!raw) continue;
        const u = JSON.parse(raw);
        users.push({ username: u.username, suspended: !!u.suspended, createdAt: u.createdAt });
      }
      return json({ users });
    }

    // ---------------------------------------------------------------
    // ADMIN: suspender usuario  (POST /admin/suspend-user)
    // Header: X-Admin-Key   Body: { "username": "..." }
    // Mantiene todos sus datos, pero le corta el acceso (login y sesiones activas).
    // ---------------------------------------------------------------
    if (path === "/admin/suspend-user" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      const raw = await env.ADEANFIT_KV.get("user:" + username);
      if (!raw) return err("Usuario no encontrado.", 404);
      const user = JSON.parse(raw);
      user.suspended = true;
      await env.ADEANFIT_KV.put("user:" + username, JSON.stringify(user));

      return json({ ok: true, username, suspended: true });
    }

    // ---------------------------------------------------------------
    // ADMIN: reactivar usuario  (POST /admin/reactivate-user)
    // Header: X-Admin-Key   Body: { "username": "..." }
    // ---------------------------------------------------------------
    if (path === "/admin/reactivate-user" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      const raw = await env.ADEANFIT_KV.get("user:" + username);
      if (!raw) return err("Usuario no encontrado.", 404);
      const user = JSON.parse(raw);
      user.suspended = false;
      await env.ADEANFIT_KV.put("user:" + username, JSON.stringify(user));

      return json({ ok: true, username, suspended: false });
    }

    // ---------------------------------------------------------------
    // ADMIN: restablecer contraseña de un usuario  (POST /admin/reset-password)
    // Header: X-Admin-Key   Body: { "username": "...", "newPassword": "..." }
    // Para cuando alguien olvida su contraseña — la fija tú directamente,
    // sin necesitar la contraseña anterior.
    // ---------------------------------------------------------------
    if (path === "/admin/reset-password" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      const newPassword = String(body.newPassword || "");
      if (!username) return err("Usuario inválido.");
      const pwProblem = passwordProblem(newPassword);
      if (pwProblem) return err(pwProblem);

      const raw = await env.ADEANFIT_KV.get("user:" + username);
      if (!raw) return err("Usuario no encontrado.", 404);
      const user = JSON.parse(raw);

      const salt = randomHex(16);
      const hash = await hashPassword(newPassword, salt);
      user.salt = salt;
      user.hash = hash;
      await env.ADEANFIT_KV.put("user:" + username, JSON.stringify(user));

      return json({ ok: true });
    }

    // ---------------------------------------------------------------
    // ADMIN: eliminar usuario  (POST /admin/delete-user)
    // Header: X-Admin-Key   Body: { "username": "..." }
    // ---------------------------------------------------------------
    if (path === "/admin/delete-user" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      if (!username) return err("Usuario inválido.");

      await env.ADEANFIT_KV.delete("user:" + username);
      await env.ADEANFIT_KV.delete("data:" + username);
      return json({ ok: true });
    }

    // ---------------------------------------------------------------
    // ADMIN: ver los datos (rutinas/sesiones) de un usuario  (POST /admin/user-data)
    // Header: X-Admin-Key   Body: { "username": "..." }
    // ---------------------------------------------------------------
    if (path === "/admin/user-data" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      if (!username) return err("Usuario inválido.");

      const userRaw = await env.ADEANFIT_KV.get("user:" + username);
      if (!userRaw) return err("Usuario no encontrado.", 404);

      const dataRaw = await env.ADEANFIT_KV.get("data:" + username);
      const data = dataRaw ? JSON.parse(dataRaw) : { plans: [], activePlanId: null, state: null };

      return json({ username, ...data });
    }

    // ---------------------------------------------------------------
    // ADMIN: corregir directamente el día actual del circuito de un usuario
    // (herramienta de emergencia si el avance automático se desincroniza)
    // (POST /admin/set-day)  Header: X-Admin-Key
    // Body: { "username": "...", "dayIndex": 0, "planId": "opcional" }
    // Si se envía "planId" y es distinto de la rutina activa del usuario,
    // esa rutina pasa a ser la activa (además de fijar el día).
    // ---------------------------------------------------------------
    if (path === "/admin/set-day" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      const dayIndex = Number(body.dayIndex);
      const planId = body.planId ? String(body.planId) : null;
      if (!username) return err("Usuario inválido.");
      if (!Number.isInteger(dayIndex) || dayIndex < 0) return err("Día inválido.");

      const userRaw = await env.ADEANFIT_KV.get("user:" + username);
      if (!userRaw) return err("Usuario no encontrado.", 404);

      const dataRaw = await env.ADEANFIT_KV.get("data:" + username);
      const data = dataRaw ? JSON.parse(dataRaw) : { plans: [], activePlanId: null, state: { currentDayIndex: 0, sessions: [] } };
      if (!data.state) data.state = { currentDayIndex: 0, sessions: [] };

      if (planId) {
        const planExists = Array.isArray(data.plans) && data.plans.some(p => p.id === planId);
        if (!planExists) return err("Esa rutina no existe para este usuario.", 400);
        data.activePlanId = planId;
      }

      data.state.currentDayIndex = dayIndex;
      // Cada guardado (venga de la app o del admin) suma uno a esta cuenta
      // interna. Sirve para que la app detecte si alguien más ha tocado los
      // datos mientras tanto y no los pise sin darse cuenta (ver PUT /data).
      data._rev = (typeof data._rev === "number" ? data._rev : 0) + 1;

      await env.ADEANFIT_KV.put("data:" + username, JSON.stringify(data));
      return json({ ok: true, currentDayIndex: dayIndex, activePlanId: data.activePlanId });
    }

    // ---------------------------------------------------------------
    // ADMIN: quitar la foto de perfil de un usuario (moderación)
    // (POST /admin/remove-avatar)  Header: X-Admin-Key   Body: { "username": "..." }
    // ---------------------------------------------------------------
    if (path === "/admin/remove-avatar" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      if (!username) return err("Usuario inválido.");

      const userRaw = await env.ADEANFIT_KV.get("user:" + username);
      if (!userRaw) return err("Usuario no encontrado.", 404);

      const dataRaw = await env.ADEANFIT_KV.get("data:" + username);
      const data = dataRaw ? JSON.parse(dataRaw) : { plans: [], activePlanId: null, state: null, profile: null };
      if (data.profile) data.profile.avatarBase64 = null;
      data._rev = (typeof data._rev === "number" ? data._rev : 0) + 1;

      await env.ADEANFIT_KV.put("data:" + username, JSON.stringify(data));
      return json({ ok: true });
    }

    // ---------------------------------------------------------------
    // ADMIN: crear o modificar una rutina de un usuario  (POST /admin/save-plan)
    // Header: X-Admin-Key
    // Body: { "username": "...", "plan": { id?, name, days }, "activate": true|false }
    // Si "plan.id" ya existe entre las rutinas del usuario, se SUSTITUYE esa
    // rutina entera (edición). Si no trae "id" o no existe, se crea como
    // rutina nueva. "activate" (opcional) además la pone como rutina activa
    // del usuario y reinicia el día actual a 0.
    // ---------------------------------------------------------------
    if (path === "/admin/save-plan" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      const planIn = body.plan;
      if (!username) return err("Usuario inválido.");
      if (!planIn || typeof planIn !== "object" || !planIn.name || !Array.isArray(planIn.days)) {
        return err("Rutina inválida.");
      }

      const userRaw = await env.ADEANFIT_KV.get("user:" + username);
      if (!userRaw) return err("Usuario no encontrado.", 404);

      const dataRaw = await env.ADEANFIT_KV.get("data:" + username);
      const data = dataRaw ? JSON.parse(dataRaw) : { plans: [], activePlanId: null, state: { currentDayIndex: 0, sessions: [] } };
      if (!Array.isArray(data.plans)) data.plans = [];
      if (!data.state) data.state = { currentDayIndex: 0, sessions: [] };

      // saneado: solo ejercicios de la lista cerrada, mismas reglas que la IA
      const cleanDays = planIn.days.slice(0, 7).map(d => ({
        name: String(d.name || "Día").slice(0, 60),
        sub: String(d.sub || "").slice(0, 60),
        exercises: (Array.isArray(d.exercises) ? d.exercises : [])
          .filter(e => e && EXERCISE_LIBRARY_NAMES.includes(e.name))
          .slice(0, 12)
          .map(e => ({ name: e.name, sets: Math.max(1, Math.min(12, parseInt(e.sets, 10) || 3)) }))
      })).filter(d => d.exercises.length > 0);

      if (cleanDays.length === 0) return err("La rutina no tiene ningún ejercicio válido.");

      let planOut;
      const existingIdx = planIn.id ? data.plans.findIndex(p => p.id === planIn.id) : -1;
      if (existingIdx >= 0) {
        planOut = { ...data.plans[existingIdx], name: String(planIn.name).slice(0, 60), days: cleanDays };
        data.plans[existingIdx] = planOut;
      } else {
        planOut = { id: newPlanId(), name: String(planIn.name).slice(0, 60), createdAt: new Date().toISOString(), days: cleanDays };
        data.plans.push(planOut);
      }

      if (body.activate) {
        data.activePlanId = planOut.id;
        data.state.currentDayIndex = 0;
      }

      data._rev = (typeof data._rev === "number" ? data._rev : 0) + 1;
      await env.ADEANFIT_KV.put("data:" + username, JSON.stringify(data));
      return json({ ok: true, plan: planOut, activePlanId: data.activePlanId });
    }

    // ---------------------------------------------------------------
    // ADMIN: eliminar una rutina de un usuario  (POST /admin/delete-plan)
    // Header: X-Admin-Key   Body: { "username": "...", "planId": "..." }
    // ---------------------------------------------------------------
    if (path === "/admin/delete-plan" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      const planId = String(body.planId || "");
      if (!username || !planId) return err("Datos inválidos.");

      const userRaw = await env.ADEANFIT_KV.get("user:" + username);
      if (!userRaw) return err("Usuario no encontrado.", 404);

      const dataRaw = await env.ADEANFIT_KV.get("data:" + username);
      const data = dataRaw ? JSON.parse(dataRaw) : { plans: [], activePlanId: null, state: { currentDayIndex: 0, sessions: [] } };
      if (!Array.isArray(data.plans)) data.plans = [];

      data.plans = data.plans.filter(p => p.id !== planId);
      if (data.activePlanId === planId) {
        data.activePlanId = data.plans.length > 0 ? data.plans[0].id : null;
        if (!data.state) data.state = { currentDayIndex: 0, sessions: [] };
        data.state.currentDayIndex = 0;
      }

      data._rev = (typeof data._rev === "number" ? data._rev : 0) + 1;
      await env.ADEANFIT_KV.put("data:" + username, JSON.stringify(data));
      return json({ ok: true, activePlanId: data.activePlanId });
    }

    // ---------------------------------------------------------------
    // ADMIN: copiar una rutina de un usuario a otro  (POST /admin/copy-plan)
    // Header: X-Admin-Key
    // Body: { "fromUsername": "...", "toUsername": "...", "planId": "...", "activate": true|false }
    // La rutina se copia con un id nuevo; el usuario destino puede ya tener
    // otras rutinas, esta se añade a la lista (no sustituye nada).
    // ---------------------------------------------------------------
    if (path === "/admin/copy-plan" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const fromUsername = normalizeUsername(body.fromUsername);
      const toUsername = normalizeUsername(body.toUsername);
      const planId = String(body.planId || "");
      if (!fromUsername || !toUsername || !planId) return err("Datos inválidos.");
      if (fromUsername === toUsername) return err("Elige dos usuarios distintos.");

      const fromUserRaw = await env.ADEANFIT_KV.get("user:" + fromUsername);
      if (!fromUserRaw) return err("Usuario de origen no encontrado.", 404);
      const toUserRaw = await env.ADEANFIT_KV.get("user:" + toUsername);
      if (!toUserRaw) return err("Usuario de destino no encontrado.", 404);

      const fromDataRaw = await env.ADEANFIT_KV.get("data:" + fromUsername);
      const fromData = fromDataRaw ? JSON.parse(fromDataRaw) : { plans: [] };
      const sourcePlan = (fromData.plans || []).find(p => p.id === planId);
      if (!sourcePlan) return err("Esa rutina no existe en el usuario de origen.", 404);

      const toDataRaw = await env.ADEANFIT_KV.get("data:" + toUsername);
      const toData = toDataRaw ? JSON.parse(toDataRaw) : { plans: [], activePlanId: null, state: { currentDayIndex: 0, sessions: [] } };
      if (!Array.isArray(toData.plans)) toData.plans = [];
      if (!toData.state) toData.state = { currentDayIndex: 0, sessions: [] };

      const copiedPlan = {
        id: newPlanId(),
        name: sourcePlan.name,
        createdAt: new Date().toISOString(),
        days: sourcePlan.days
      };
      toData.plans.push(copiedPlan);

      if (body.activate) {
        toData.activePlanId = copiedPlan.id;
        toData.state.currentDayIndex = 0;
      }

      toData._rev = (typeof toData._rev === "number" ? toData._rev : 0) + 1;
      await env.ADEANFIT_KV.put("data:" + toUsername, JSON.stringify(toData));
      return json({ ok: true, plan: copiedPlan, activePlanId: toData.activePlanId });
    }

    // ---------------------------------------------------------------
    // ADMIN: generar una rutina base con IA para un cliente concreto
    // (POST /admin/generate-plan-for-user)  Header: X-Admin-Key
    // Body: { "username": "...", "brief": "descripción" }
    // Igual que /ai/generate-plan pero autenticado como admin (no requiere
    // el token de sesión del propio cliente) y recibe a quién va dirigida la
    // rutina solo para poder, si se quiere, personalizar el prompt en el
    // futuro. NO la guarda: el admin la revisa en el panel y decide si la
    // guarda con /admin/save-plan.
    // ---------------------------------------------------------------
    if (path === "/admin/generate-plan-for-user" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      const userBrief = String(body.brief || "").trim();
      if (!username) return err("Usuario inválido.");
      if (!userBrief) return err("Describe qué tipo de rutina quieres generar.");

      const userRaw = await env.ADEANFIT_KV.get("user:" + username);
      if (!userRaw) return err("Usuario no encontrado.", 404);

      const result = await generatePlanWithAI(env, userBrief);
      if (result.errorMessage) return err(result.errorMessage, result.status);
      return json({ plan: result.plan });
    }

    // ---------------------------------------------------------------
    // LOGIN  (POST /login)
    // Body: { "username": "...", "password": "..." }
    // ---------------------------------------------------------------
    if (path === "/login" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");

      const userFailKey = "fail:user:" + username;
      const ipFailKey = "fail:ip:" + clientIp(request);
      if ((await failCount(env, userFailKey)) >= MAX_LOGIN_FAILS_USER) return tooMany();
      if ((await failCount(env, ipFailKey)) >= MAX_LOGIN_FAILS_IP) return tooMany();

      const raw = await env.ADEANFIT_KV.get("user:" + username);
      if (!raw) {
        await addFail(env, ipFailKey);
        return err("Usuario o contraseña incorrectos.", 401);
      }
      const user = JSON.parse(raw);

      const hash = await hashPassword(password, user.salt);
      if (!safeEqual(hash, user.hash)) {
        await addFail(env, userFailKey);
        await addFail(env, ipFailKey);
        return err("Usuario o contraseña incorrectos.", 401);
      }
      await env.ADEANFIT_KV.delete(userFailKey);

      if (user.suspended) return err("Tu cuenta está suspendida. Contacta con el administrador.", 403);

      const token = randomHex(24);
      await env.ADEANFIT_KV.put("session:" + token, username, { expirationTtl: TOKEN_TTL_SECONDS });

      return json({ ok: true, token, username });
    }

    // ---------------------------------------------------------------
    // CAMBIAR CONTRASEÑA  (POST /change-password)
    // Header: Authorization: Bearer <token>
    // Body: { "oldPassword": "...", "newPassword": "..." }
    // ---------------------------------------------------------------
    if (path === "/change-password" && request.method === "POST") {
      const username = await getUserFromToken(env, request);
      if (!username) return err("No autenticado.", 401);

      const body = await request.json().catch(() => ({}));
      const oldPassword = String(body.oldPassword || "");
      const newPassword = String(body.newPassword || "");
      const pwProblem = passwordProblem(newPassword);
      if (pwProblem) return err(pwProblem);

      const raw = await env.ADEANFIT_KV.get("user:" + username);
      if (!raw) return err("Usuario no encontrado.", 404);
      const user = JSON.parse(raw);

      const oldHash = await hashPassword(oldPassword, user.salt);
      if (oldHash !== user.hash) return err("La contraseña actual no es correcta.", 401);

      const newSalt = randomHex(16);
      const newHash = await hashPassword(newPassword, newSalt);
      user.salt = newSalt;
      user.hash = newHash;
      await env.ADEANFIT_KV.put("user:" + username, JSON.stringify(user));

      return json({ ok: true });
    }

    // ---------------------------------------------------------------
    // CERRAR SESIÓN  (POST /logout)
    // ---------------------------------------------------------------
    if (path === "/logout" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (token) await env.ADEANFIT_KV.delete("session:" + token);
      return json({ ok: true });
    }

    // ---------------------------------------------------------------
    // DATOS: leer  (GET /data)
    // ---------------------------------------------------------------
    if (path === "/data" && request.method === "GET") {
      const username = await getUserFromToken(env, request);
      if (!username) return err("No autenticado.", 401);

      const raw = await env.ADEANFIT_KV.get("data:" + username);
      const data = raw ? JSON.parse(raw) : { plans: [], activePlanId: null, state: null };
      // "_rev" es un contador que sube en cada guardado. La app se lo guarda
      // al leer y lo vuelve a mandar al guardar (ver PUT /data) para que el
      // servidor pueda detectar guardados desfasados.
      if (typeof data._rev !== "number") data._rev = 0;
      return json(data);
    }

    // ---------------------------------------------------------------
    // DATOS: guardar  (PUT /data)
    // Body: objeto JSON completo { plans, activePlanId, state, _rev }
    //
    // "_rev" es la pieza clave para que dos guardados que se crucen en el
    // tiempo no se pisen entre sí sin darse cuenta (por ejemplo: una pestaña
    // del móvil que llevaba rato en segundo plano, con el día antiguo en
    // memoria, e intenta guardar después de que ya se guardara un
    // entrenamiento más reciente desde otro sitio). El teléfono manda el
    // "_rev" que tenía cuando leyó los datos por última vez; si ya no
    // coincide con el que hay guardado ahora mismo, es que alguien más ha
    // guardado algo entre medias, así que el servidor RECHAZA el guardado
    // (en vez de sobrescribir) y le devuelve los datos más recientes para
    // que la app se ponga al día antes de que el usuario repita la acción.
    // ---------------------------------------------------------------
    if (path === "/data" && request.method === "PUT") {
      const username = await getUserFromToken(env, request);
      if (!username) return err("No autenticado.", 401);

      const body = await request.json().catch(() => null);
      if (!body) return err("Datos inválidos.");

      // Límite defensivo: la foto de perfil se manda en base64 dentro de
      // "profile.avatarBase64". El cliente ya la recorta y comprime antes de
      // mandarla, pero comprobamos aquí también por si acaso, para no dejar
      // que alguien intente guardar una imagen enorme en la base de datos.
      const AVATAR_MAX_BASE64_LENGTH = 400000; // ~300KB decodificado, de sobra para una foto de perfil pequeña
      if (body.profile && typeof body.profile.avatarBase64 === "string" && body.profile.avatarBase64.length > AVATAR_MAX_BASE64_LENGTH) {
        return err("La foto de perfil es demasiado grande. Prueba con otra imagen.", 413);
      }

      const currentRaw = await env.ADEANFIT_KV.get("data:" + username);
      const current = currentRaw ? JSON.parse(currentRaw) : null;
      const currentRev = current && typeof current._rev === "number" ? current._rev : 0;
      const clientRev = typeof body._rev === "number" ? body._rev : 0;

      if (current && clientRev !== currentRev) {
        // Conflicto: hay datos más nuevos que los que este dispositivo conocía.
        return json({ error: "conflict", ...current }, 409);
      }

      const toSave = { ...body, _rev: currentRev + 1 };
      await env.ADEANFIT_KV.put("data:" + username, JSON.stringify(toSave));
      return json({ ok: true, _rev: toSave._rev });
    }

    // ---------------------------------------------------------------
    // IA: analizar progreso  (POST /ai/analyze)
    // Header: Authorization: Bearer <token>
    // Usa los datos guardados del propio usuario — nadie ve datos de otro.
    // ---------------------------------------------------------------
    if (path === "/ai/analyze" && request.method === "POST") {
      const username = await getUserFromToken(env, request);
      if (!username) return err("No autenticado.", 401);

      const raw = await env.ADEANFIT_KV.get("data:" + username);
      const data = raw ? JSON.parse(raw) : null;
      const summary = data ? buildProgressSummary(data.state) : null;

      if (!summary) {
        return json({ analysis: "Todavía no hay sesiones guardadas para poder analizar el progreso. Completa al menos un par de entrenamientos y vuelve a intentarlo." });
      }

      if (!env.AI) {
        return err("La IA no está conectada en el servidor: falta el binding 'AI' (Workers AI) en la configuración del Worker de Cloudflare.", 500);
      }

      const prompt = `Eres un entrenador personal experto y directo. A continuación tienes el registro de progreso de gimnasio de un usuario. Analiza cómo de bueno es su progreso reciente (¿mejora, se estanca, empeora?) y dale 3 recomendaciones concretas y accionables para mejorar. Responde en español, en un tono cercano pero profesional, en un máximo de 180 palabras, sin usar markdown ni asteriscos.

Datos de progreso:
${summary}`;

      try {
        const aiRes = await env.AI.run(AI_MODEL, {
          messages: [
            { role: "system", content: "Eres un entrenador personal experto, honesto y conciso." },
            { role: "user", content: prompt }
          ],
          max_tokens: 500
        });
        const text = extractModelText(aiRes).trim();
        if (!text) {
          const debugDump = JSON.stringify(aiRes || {}).slice(0, 300);
          return err("La IA no devolvió texto. Forma de la respuesta: " + debugDump, 502);
        }
        return json({ analysis: text });
      } catch (e) {
        return err("No se pudo generar el análisis ahora mismo: " + (e.message || "error desconocido del modelo") + ".", 502);
      }
    }

// Reordena los días de una rutina generada por IA para que, en la medida
// de lo posible, no haya dos días seguidos centrados en el mismo grupo
// muscular dominante — así cada grupo descansa al menos un día antes de
// repetirse. No siempre es posible del todo (p. ej. si 3 de 4 días son de
// pierna), en ese caso se hace lo mejor posible sin descartar ningún día.
function dominantMuscleOfDay(day) {
  const counts = {};
  (day.exercises || []).forEach(e => {
    const lib = EXERCISE_LIBRARY.find(x => x.name === e.name);
    const m = lib ? lib.muscle : "Otro";
    counts[m] = (counts[m] || 0) + 1;
  });
  let best = "Otro", bestCount = -1;
  Object.entries(counts).forEach(([m, c]) => { if (c > bestCount) { best = m; bestCount = c; } });
  return best;
}
function avoidConsecutiveSameMuscle(days) {
  if (days.length <= 2) return days; // con 1-2 días no hay nada que intercalar
  const groups = {};
  days.forEach(d => {
    const m = dominantMuscleOfDay(d);
    (groups[m] = groups[m] || []).push(d);
  });
  const result = [];
  let lastMuscle = null;
  while (result.length < days.length) {
    const available = Object.keys(groups).filter(m => groups[m].length > 0);
    const candidates = available.filter(m => m !== lastMuscle);
    const pool = candidates.length > 0 ? candidates : available; // si no queda otra, se repite
    const pickMuscle = pool.sort((a, b) => groups[b].length - groups[a].length)[0];
    result.push(groups[pickMuscle].shift());
    lastMuscle = pickMuscle;
  }
  return result;
}

// Lógica compartida de generación de rutina por IA: la usan tanto
// /ai/generate-plan (el propio usuario, desde la app) como
// /admin/generate-plan-for-user (el admin, generando una base para un
// cliente concreto desde el panel). Devuelve { plan } o { errorMessage, status }.
async function generatePlanWithAI(env, userBrief) {
  const FIXED_PREFIX = "Quiero una rutina de ejercicios enfocada en la eficiencia en crecimiento muscular, por lo que quiero que me hagas una rutina de: ";
  const brief = FIXED_PREFIX + userBrief;

  if (!env.AI) {
    return { errorMessage: "La IA no está conectada en el servidor: falta el binding 'AI' (Workers AI) en la configuración del Worker de Cloudflare.", status: 500 };
  }

  const exerciseListText = EXERCISE_LIBRARY.map(e => {
    let muscleLabel = e.sub ? `${e.muscle} — ${e.sub}` : e.muscle;
    const tags = e.secondary && e.secondary.length
      ? `${muscleLabel} — también válido como ejercicio de ${e.secondary.join(" y ")}`
      : muscleLabel;
    return `- ${e.name} (${tags})`;
  }).join("\n");
  const prompt = `Eres un entrenador personal experto en diseño de rutinas de gimnasio. Crea una rutina de entrenamiento según lo que pide el usuario.

Petición del usuario: "${brief}"

IMPORTANTE: solo puedes usar ejercicios de esta lista cerrada (por ahora solo cubre pecho, espalda, hombro, bíceps, tríceps, abdomen y pierna — no inventes ni escribas ningún ejercicio que no esté aquí, ni de otros grupos musculares), copiando el nombre exactamente tal cual aparece. Entre paréntesis tienes el grupo muscular de cada uno; algunos sirven para más de un grupo — puedes usarlos para cualquiera de los grupos indicados si encaja con lo que pide el usuario:
${exerciseListText}

Responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin markdown, con esta forma exacta:
{
  "name": "Nombre corto de la rutina",
  "days": [
    { "name": "Nombre del día", "exercises": [ { "name": "Nombre del ejercicio (de la lista de arriba, exacto)", "sets": 3 } ] }
  ]
}
Reglas: entre 1 y 4 días. Entre 3 y ${EXERCISE_LIBRARY_NAMES.length} ejercicios por día, sin repetir el mismo ejercicio dos veces en el mismo día. "sets" es un número entero entre 2 y 5. Por defecto, salvo que el usuario pida explícitamente lo contrario, NO pongas dos días seguidos centrados en el mismo grupo muscular (p. ej. dos días de espalda seguidos) — deja que cada grupo muscular descanse al menos un día antes de repetirlo, intercalando días de otros grupos entre medio.`;

  try {
    const aiRes = await env.AI.run(AI_MODEL, {
      messages: [
        { role: "system", content: "Respondes siempre con JSON válido y nada más, usando solo ejercicios de la lista cerrada que te dan." },
        { role: "user", content: prompt }
      ],
      max_tokens: 1500
    });
    const rawText = extractModelText(aiRes);
    const parsed = extractJson(rawText);
    if (!parsed || !parsed.name || !Array.isArray(parsed.days) || parsed.days.length === 0) {
      const preview = rawText ? rawText.slice(0, 160) : "(vacía) — forma de la respuesta: " + JSON.stringify(aiRes || {}).slice(0, 250);
      return { errorMessage: "La IA no devolvió una rutina en el formato esperado. Respuesta recibida: " + preview, status: 502 };
    }
    // saneado + filtrado: solo se aceptan ejercicios de la lista cerrada
    const cleanDays = parsed.days.slice(0, 7).map(d => ({
      name: String(d.name || "Día").slice(0, 60),
      sub: "",
      exercises: (Array.isArray(d.exercises) ? d.exercises : [])
        .filter(e => EXERCISE_LIBRARY_NAMES.includes(e.name))
        .slice(0, 12)
        .map(e => ({
          name: e.name,
          sets: Math.max(1, Math.min(12, parseInt(e.sets, 10) || 3))
        }))
    })).filter(d => d.exercises.length > 0);

    if (cleanDays.length === 0) {
      return { errorMessage: "La IA no devolvió ejercicios válidos de la lista cerrada. Prueba a describirlo de otra forma o inténtalo de nuevo.", status: 502 };
    }

    const orderedDays = avoidConsecutiveSameMuscle(cleanDays);
    return { plan: { name: String(parsed.name).slice(0, 60), days: orderedDays } };
  } catch (e) {
    return { errorMessage: "No se pudo generar la rutina ahora mismo: " + (e.message || "error desconocido del modelo") + ".", status: 502 };
  }
}

    // Header: Authorization: Bearer <token>
    // Body: { "brief": "descripción de lo que quiere el usuario" }
    // Devuelve un plan en el mismo formato que usa la app, SIN guardarlo todavía
    // (el usuario lo revisa y decide si guardarlo).
    // ---------------------------------------------------------------
    if (path === "/ai/generate-plan" && request.method === "POST") {
      const username = await getUserFromToken(env, request);
      if (!username) return err("No autenticado.", 401);

      const body = await request.json().catch(() => ({}));
      const userBrief = String(body.brief || "").trim();
      if (!userBrief) return err("Describe qué tipo de rutina quieres.");

      const result = await generatePlanWithAI(env, userBrief);
      if (result.errorMessage) return err(result.errorMessage, result.status);
      return json({ plan: result.plan });
    }

    // ---------------------------------------------------------------
    // SUGERIR EJERCICIO  (POST /suggest-exercise)
    // Header: Authorization: Bearer <token>
    // Body: { "name": "...", "muscle": "..." }
    // ---------------------------------------------------------------
    if (path === "/suggest-exercise" && request.method === "POST") {
      const username = await getUserFromToken(env, request);
      if (!username) return err("No autenticado.", 401);

      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "").trim().slice(0, 80);
      const muscle = String(body.muscle || "").trim().slice(0, 40);
      if (!name) return err("Escribe el nombre del ejercicio.");

      const id = "suggestion:" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      await env.ADEANFIT_KV.put(id, JSON.stringify({
        name, muscle, suggestedBy: username, date: new Date().toISOString()
      }));

      return json({ ok: true });
    }

    // ---------------------------------------------------------------
    // ADMIN: ver sugerencias de ejercicios  (GET /admin/exercise-suggestions)
    // Header: X-Admin-Key
    // ---------------------------------------------------------------
    if (path === "/admin/exercise-suggestions" && request.method === "GET") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const list = await env.ADEANFIT_KV.list({ prefix: "suggestion:" });
      const suggestions = [];
      for (const k of list.keys) {
        const raw = await env.ADEANFIT_KV.get(k.name);
        if (!raw) continue;
        suggestions.push({ id: k.name, ...JSON.parse(raw) });
      }
      suggestions.sort((a, b) => new Date(b.date) - new Date(a.date));
      return json({ suggestions });
    }

    // ---------------------------------------------------------------
    // ADMIN: descartar sugerencia  (POST /admin/dismiss-suggestion)
    // Header: X-Admin-Key   Body: { "id": "suggestion:..." }
    // ---------------------------------------------------------------
    if (path === "/admin/dismiss-suggestion" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const id = String(body.id || "");
      if (!id.startsWith("suggestion:")) return err("Id inválido.");
      await env.ADEANFIT_KV.delete(id);
      return json({ ok: true });
    }

    // ---------------------------------------------------------------
    // ADMIN: enviar un email de progreso de prueba ahora mismo
    // (ignora la frecuencia/fecha) (POST /admin/send-progress-email-test)
    // Header: X-Admin-Key   Body: { "username": "...", "to": "..." (opcional) }
    // ---------------------------------------------------------------
    if (path === "/admin/send-progress-email-test" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;

      const body = await request.json().catch(() => ({}));
      const username = String(body.username || "").trim();
      if (!username) return err("Falta el nombre de usuario.");

      const dataRaw = await env.ADEANFIT_KV.get("data:" + username);
      if (!dataRaw) return err("Ese usuario no existe o no tiene datos.", 404);
      const data = JSON.parse(dataRaw);

      const overrideTo = String(body.to || "").trim();
      const frequency = (data.profile && data.profile.progressEmail && data.profile.progressEmail.frequency) || "monthly";
      const to = overrideTo || (data.profile && data.profile.progressEmail && data.profile.progressEmail.email);
      if (!to) return err("Ese usuario no tiene un email configurado y no se indicó uno alternativo.");

      try {
        const html = buildProgressEmailHtml(username, data, frequency === "never" ? "monthly" : frequency);
        await sendEmailViaResend(env, to, "Tu progreso en ADEANEASYFIT (prueba)", html);
        return json({ ok: true, to });
      } catch (e) {
        return err("No se pudo enviar: " + e.message, 502);
      }
    }

    // ---------------------------------------------------------------
    // ENVIAR UN INFORME POR EMAIL (un único handler para cliente y admin)
    //   POST /send-report-email         (cliente: Authorization: Bearer <token>)
    //   POST /admin/send-report-email   (admin: X-Admin-Key, requiere "username")
    // Body: { kind: "day"|"exercise", to, dayName?, sessionDate?, exerciseName?, comment? }
    // "comment" solo lo admite la vía admin. Las rutas antiguas
    // (/send-day-chart-email, etc.) siguen funcionando como alias.
    // ---------------------------------------------------------------
    const REPORT_ROUTES = {
      "/send-report-email": [false, null],
      "/admin/send-report-email": [true, null],
      "/send-day-chart-email": [false, "day"],
      "/send-exercise-chart-email": [false, "exercise"],
      "/admin/send-day-chart-email": [true, "day"],
      "/admin/send-exercise-chart-email": [true, "exercise"],
    };
    if (REPORT_ROUTES[path] && request.method === "POST") {
      const [isAdmin, fixedKind] = REPORT_ROUTES[path];
      let username;
      if (isAdmin) {
        { const denied = await checkAdmin(env, request); if (denied) return denied; }
      } else {
        username = await getUserFromToken(env, request);
        if (!username) return err("No autenticado.", 401);
      }

      const body = await request.json().catch(() => ({}));
      if (isAdmin) {
        username = normalizeUsername(body.username);
        if (!username) return err("Usuario inválido.");
      }
      const kind = fixedKind || String(body.kind || "");
      const to = String(body.to || "").trim();
      if (!to) return err("Indica a qué email quieres enviarlo.");

      const dataRaw = await env.ADEANFIT_KV.get("data:" + username);
      if (!dataRaw) return err("Ese usuario no existe o no tiene datos.", 404);
      const data = JSON.parse(dataRaw);

      try {
        let html, subject;
        if (kind === "day") {
          const dayName = String(body.dayName || "").trim();
          if (!dayName) return err("Falta el día de rutina.");
          const sessionDate = body.sessionDate ? String(body.sessionDate).trim() : null;
          const comment = isAdmin ? String(body.comment || "").trim() : "";
          html = buildDayReportEmailHtml(username, data, dayName, comment, sessionDate);
          subject = isAdmin ? `Informe de entrenamiento — ${dayName} (${username})` : `Tu informe de entrenamiento — ${dayName}`;
        } else if (kind === "exercise") {
          const exerciseName = String(body.exerciseName || "").trim();
          if (!exerciseName) return err("Falta el ejercicio.");
          html = buildExerciseChartEmailHtml(username, data, exerciseName);
          subject = isAdmin ? `Progreso de ${username} — ${exerciseName}` : `Tu progreso — ${exerciseName}`;
        } else {
          return err("Tipo de informe no válido.");
        }
        await sendEmailViaResend(env, to, subject, html);
        return json({ ok: true, to });
      } catch (e) {
        return err("No se pudo enviar: " + e.message, 502);
      }
    }

    // ---------------------------------------------------------------
    // ADMIN: enviar por email un Excel con las marcas de un cliente
    //   POST /admin/send-client-excel
    //   Body: { username, to, rangeDays? (0 = todo, 30, 90, 180, 365) }
    // ---------------------------------------------------------------
    if (path === "/admin/send-client-excel" && request.method === "POST") {
      { const denied = await checkAdmin(env, request); if (denied) return denied; }
      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      if (!username) return err("Usuario inválido.");
      const to = String(body.to || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return err("Indica un email válido.");
      const rangeDays = body.rangeDays === undefined ? 30 : Number(body.rangeDays);
      if (!EXCEL_RANGES.includes(rangeDays)) return err("Periodo no válido.");

      const dataRaw = await env.ADEANFIT_KV.get("data:" + username);
      if (!dataRaw) return err("Ese usuario no existe o no tiene datos.", 404);
      const data = JSON.parse(dataRaw);

      try {
        const { bytes, plan, charts } = await buildClientExcel(username, data, rangeDays);
        if (plan.daySheets.length === 0) return err("Este cliente no tiene marcas registradas en ese periodo.", 404);
        const rangoTxt = rangeDays > 0 ? `últimos ${rangeDays} días` : "todo el historial";
        const html = emailShell(
          `Marcas de <b>${escapeHtmlEmail(username)}</b> en Excel`,
          `<p style="margin:0 0 8px;font-size:14px;">Adjunto el Excel con las marcas registradas (${rangoTxt}).</p>
           <p style="margin:0;font-size:13px;color:#bbb;">${plan.daySheets.length} día${plan.daySheets.length === 1 ? "" : "s"} de entrenamiento, una hoja por día con ejercicios, series, repeticiones, pesos y el gráfico general de la sesión. La primera hoja es un resumen.</p>`,
          "Enviado desde el panel de administración de ADEANEASYFIT.");
        const stamp = new Date().toISOString().slice(0, 10);
        await sendEmailViaResend(env, to, `Excel de marcas — ${username}`, html, [{
          filename: `marcas-${username}-${stamp}.xlsx`,
          content: bytesToBase64(bytes),
        }]);
        return json({ ok: true, to, sheets: plan.daySheets.length, charts, truncated: plan.truncated });
      } catch (e) {
        return err("No se pudo enviar: " + e.message, 502);
      }
    }

    // ---------------------------------------------------------------
    // ADMIN: copia de seguridad de todos los usuarios y sus datos
    //   GET  /admin/backup   -> JSON descargable
    //   POST /admin/restore  -> { "backup": {...}, "confirm": true }
    // Header: X-Admin-Key. La copia incluye las cuentas (con la contraseña
    // ya cifrada) y todos sus datos; no incluye sesiones abiertas.
    // ---------------------------------------------------------------
    if (path === "/admin/backup" && request.method === "GET") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;
      const out = { version: 1, createdAt: new Date().toISOString(), users: {}, data: {} };
      for (const [prefix, bucket] of [["user:", out.users], ["data:", out.data]]) {
        let cursor;
        do {
          const page = await env.ADEANFIT_KV.list({ prefix, cursor });
          for (const k of page.keys) {
            const raw = await env.ADEANFIT_KV.get(k.name);
            if (raw) bucket[k.name.slice(prefix.length)] = JSON.parse(raw);
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
      }
      return json(out);
    }

    if (path === "/admin/restore" && request.method === "POST") {
      const denied = await checkAdmin(env, request);
      if (denied) return denied;
      const body = await request.json().catch(() => ({}));
      const b = body.backup;
      if (body.confirm !== true) return err("Falta la confirmación.");
      if (!b || b.version !== 1 || typeof b.users !== "object" || typeof b.data !== "object") return err("La copia no tiene un formato válido.");
      let users = 0, datos = 0;
      for (const [name, u] of Object.entries(b.users)) {
        if (normalizeUsername(name) !== name || !u || typeof u.hash !== "string" || typeof u.salt !== "string") continue;
        await env.ADEANFIT_KV.put("user:" + name, JSON.stringify(u));
        users++;
      }
      for (const [name, d] of Object.entries(b.data)) {
        if (normalizeUsername(name) !== name || !d || typeof d !== "object") continue;
        await env.ADEANFIT_KV.put("data:" + name, JSON.stringify(d));
        datos++;
      }
      return json({ ok: true, users, data: datos });
    }

    return err("Ruta no encontrada.", 404);
  },

  // =====================================================================
  // ENVÍO PERIÓDICO DE PROGRESO POR EMAIL (Cron Trigger)
  // =====================================================================
  // Requiere:
  //  - Variable de entorno secreta RESEND_API_KEY (cuenta gratuita en resend.com)
  //  - Un Cron Trigger configurado en Cloudflare (Settings -> Triggers -> Cron Triggers),
  //    por ejemplo "0 8 * * *" para que se compruebe cada día a las 8:00 UTC.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runProgressEmailSweep(env));
  },
};

const FREQUENCY_DAYS = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 90 };

async function runProgressEmailSweep(env) {
  const list = await env.ADEANFIT_KV.list({ prefix: "user:" });
  for (const k of list.keys) {
    const username = k.name.slice("user:".length);
    try {
      await maybeSendProgressEmail(env, username, false);
    } catch (e) {
      console.error("Fallo enviando email de progreso a " + username, e.message);
    }
  }
}

// force=true ignora la frecuencia/fecha y manda igual (para probar).
async function maybeSendProgressEmail(env, username, force) {
  const dataRaw = await env.ADEANFIT_KV.get("data:" + username);
  if (!dataRaw) return { sent: false, reason: "sin datos" };
  const data = JSON.parse(dataRaw);
  const settings = (data.profile && data.profile.progressEmail) || null;
  if (!settings || !settings.email || settings.frequency === "never") {
    return { sent: false, reason: "sin preferencia activa" };
  }
  if (!force) {
    const intervalDays = FREQUENCY_DAYS[settings.frequency];
    if (!intervalDays) return { sent: false, reason: "frecuencia desconocida" };
    if (settings.lastSentAt) {
      const elapsedDays = (Date.now() - new Date(settings.lastSentAt).getTime()) / 86400000;
      if (elapsedDays < intervalDays) return { sent: false, reason: "todavía no toca" };
    }
  }

  const html = buildProgressEmailHtml(username, data, settings.frequency);
  await sendEmailViaResend(env, settings.email, "Tu progreso en ADEANEASYFIT", html);

  data.profile.progressEmail.lastSentAt = new Date().toISOString();
  await env.ADEANFIT_KV.put("data:" + username, JSON.stringify(data));
  return { sent: true };
}

async function sendEmailViaResend(env, to, subject, html, attachments) {
  if (!env.RESEND_API_KEY) throw new Error("Falta RESEND_API_KEY en las variables de entorno del Worker.");
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "ADEANEASYFIT <onboarding@resend.dev>",
      to: [to],
      subject,
      html,
      ...(attachments && attachments.length ? { attachments } : {}),
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("Resend respondió " + resp.status + ": " + t.slice(0, 300));
  }
}

const FREQUENCY_LABEL_ES = {
  weekly: "la última semana",
  biweekly: "las 2 últimas semanas",
  monthly: "el último mes",
  quarterly: "el último trimestre",
};

// Misma tabla de estándares orientativos que usa la app (peso corporal ×
// multiplicador según tiempo entrenando) — solo cubre los grandes básicos
// donde existen estándares de fuerza conocidos.
const STRENGTH_STANDARDS = {
  "Press banca":             { "0-3":0.50, "3-6":0.70, "6-12":0.90, "1-2a":1.15, "+2a":1.40 },
  "Peso muerto":             { "0-3":0.75, "3-6":1.00, "6-12":1.35, "1-2a":1.75, "+2a":2.10 },
  "Press militar con barra": { "0-3":0.35, "3-6":0.45, "6-12":0.55, "1-2a":0.70, "+2a":0.85 },
  "Remo con barra":          { "0-3":0.45, "3-6":0.60, "6-12":0.75, "1-2a":0.95, "+2a":1.15 },
};
// Cada ejercicio de la biblioteca se asocia al básico de STRENGTH_STANDARDS
// biomecánicamente más parecido, con un coeficiente de ajuste (estimación
// orientativa, no un estándar certificado por ejercicio). Idéntico al mapa
// de index.html / admin.html, para que la expectativa sea igual en toda la app.
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
function computeExpectedMaxEmail(profile, exerciseName) {
  if (!profile || !profile.weightKg || !profile.timeTraining) return null;
  const map = EXERCISE_EXPECTED_MAP[exerciseName];
  if (!map) return null;
  const table = STRENGTH_STANDARDS[map.table];
  if (!table) return null;
  const mult = table[profile.timeTraining];
  if (!mult) return null;
  return Math.round(profile.weightKg * mult * map.coef * 2) / 2;
}

function arrowFor(diff) {
  if (diff > 0) return "▲";
  if (diff < 0) return "▼";
  return "→";
}

function shortDateEmail(iso) {
  const d = new Date(iso);
  return d.getDate() + " " + ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"][d.getMonth()];
}

// Genera la URL de una imagen de gráfico real (vía quickchart.io) para
// incrustar directamente en el email con un <img> — no requiere ninguna
// clave ni JavaScript en el cliente de correo, es una imagen normal.
function quickChartUrl(chartConfig, width, height, pixelRatio = 2) {
  const encoded = encodeURIComponent(JSON.stringify(chartConfig));
  return `https://quickchart.io/chart?width=${width}&height=${height}&devicePixelRatio=${pixelRatio}&backgroundColor=%230f0f10&c=${encoded}`;
}

function weightChartImgTag(weightHistory) {
  const sorted = weightHistory.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  if (sorted.length === 0) return "";
  const config = {
    type: "line",
    data: {
      labels: sorted.map(w => shortDateEmail(w.date)),
      datasets: [{
        label: "Peso (kg)",
        data: sorted.map(w => w.weightKg),
        borderColor: "#ff7a3d",
        backgroundColor: "rgba(255,122,61,0.15)",
        fill: true,
        tension: 0.3,
        pointRadius: 3,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#ccc" }, grid: { color: "#2a2a2c" } },
        y: { ticks: { color: "#ccc" }, grid: { color: "#2a2a2c" } },
      },
    },
  };
  const url = quickChartUrl(config, 500, 220);
  return `<img src="${url}" width="500" height="220" alt="Gráfica de peso corporal" style="width:100%;max-width:500px;border-radius:8px;margin:10px 0 16px;">`;
}

// Configuración del gráfico de evolución de un ejercicio (la comparten el
// email y el Excel, para que se vean exactamente igual).
function exerciseLineChartConfig(name, points, expected) {
  const datasets = [{
    label: name,
    data: points.map(p => p.kg),
    borderColor: "#ff7a3d",
    backgroundColor: "rgba(255,122,61,0.15)",
    fill: true,
    tension: 0.3,
    pointRadius: 3,
  }];
  if (expected != null) {
    datasets.push({
      label: "Esperado para tu experiencia",
      data: points.map(() => expected),
      borderColor: "#999999",
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false,
    });
  }
  return {
    type: "line",
    data: { labels: points.map(p => shortDateEmail(p.date)), datasets },
    options: {
      plugins: { legend: { display: expected != null, labels: { color: "#ccc" } } },
      scales: {
        x: { ticks: { color: "#ccc" }, grid: { color: "#2a2a2c" } },
        y: { ticks: { color: "#ccc" }, grid: { color: "#2a2a2c" } },
      },
    },
  };
}

function exerciseChartImgTag(name, points, expected) {
  if (points.length < 2) return "";
  const url = quickChartUrl(exerciseLineChartConfig(name, points, expected), 500, 220);
  return `<img src="${url}" width="500" height="220" alt="Gráfica de ${escapeHtmlEmail(name)}" style="width:100%;max-width:500px;border-radius:8px;margin:10px 0 4px;">`;
}

function shortDMYEmail(iso) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Cada ejercicio recibe su propio tono de naranja (todas sus series comparten
// ese mismo tono), y el tono cambia de un ejercicio a otro para distinguirlos
// a simple vista sin salirse de la paleta naranja de la app.
function orangeShadeForIndex(idx) {
  const lightness = 46 + (idx % 6) * 7; // 46%-81%, recorre varios tonos de naranja
  return `hsl(22, 92%, ${lightness}%)`;
}
function exerciseColorMapFromPalette(setRows, palette) {
  const names = [];
  setRows.forEach(r => { if (!names.includes(r.exerciseName)) names.push(r.exerciseName); });
  const map = {};
  names.forEach((n, i) => { map[n] = palette[i % palette.length]; });
  return map;
}
function dayExerciseColorMap(setRows) {
  const names = [];
  setRows.forEach(r => { if (!names.includes(r.exerciseName)) names.push(r.exerciseName); });
  const map = {};
  names.forEach((n, i) => { map[n] = orangeShadeForIndex(i); });
  return map;
}

// Gráfico de barras pareadas (Sombra esperada en naranja translúcido, Carga
// real en el tono de naranja de cada ejercicio) — una pareja de barras por
// serie. El ancho de la imagen crece con el número de series para que
// ninguna barra quede aplastada o invisible cuando hay muchos
// ejercicios/series en la sesión.
function dayBarChartConfig(setRows, palette) {
  const hasExpected = setRows.some(r => r.expected != null);
  const labels = setRows.map(r => `${r.shortName} S${r.setNum}`);
  const width = Math.min(1400, Math.max(600, setRows.length * 55));
  // Por defecto, tonos de naranja (email). El Excel pasa su propia paleta naranja/gris.
  const colorMap = palette ? exerciseColorMapFromPalette(setRows, palette) : dayExerciseColorMap(setRows);
  const realColors = setRows.map(r => colorMap[r.exerciseName]);
  const datasets = [];
  if (hasExpected) datasets.push({ label: "Sombra esperada", data: setRows.map(r => r.expected), backgroundColor: "rgba(255,122,61,0.30)" });
  datasets.push({ label: "Carga real", data: setRows.map(r => r.kg), backgroundColor: realColors });
  const config = {
    type: "bar",
    data: { labels, datasets },
    options: {
      plugins: { legend: { display: true, labels: { color: "#ccc" } } },
      scales: {
        x: { ticks: { color: "#ccc", font: { size: 9 }, autoSkip: false, maxRotation: 60, minRotation: 0 }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: "#ccc" }, grid: { color: "#2a2a2c" } },
      },
    },
  };
  return { config, width };
}

function dayBarChartImgTag(setRows) {
  if (!setRows.some(r => r.expected != null)) return "";
  const { config, width } = dayBarChartConfig(setRows);
  const url = quickChartUrl(config, width, 280);
  return `<img src="${url}" width="${width}" height="280" alt="Comparativa de carga real vs. esperada" style="width:100%;max-width:${width}px;border-radius:8px;margin:10px 0 16px;">`;
}

// Informe completo de UNA sesión (un día de rutina) — misma estructura que el
// informe de referencia: KPIs, gráfico de barras esperado vs. real por serie,
// tabla de desglose completo, y comentario opcional del entrenador. Si se
// indica sessionDate, usa esa fecha concreta registrada para ese día de
// rutina; si no, usa la sesión más reciente.
function buildDayReportEmailHtml(username, data, dayName, comment, sessionDate) {
  const profile = data.profile || {};
  const sessions = (data.state && data.state.sessions) || [];
  const daySessions = sessions.filter(s => s.dayName === dayName).sort((a, b) => new Date(b.date) - new Date(a.date));
  if (daySessions.length === 0) {
    return `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;background:#0f0f10;padding:28px 24px;border-radius:14px;color:#f2f2f2;">
      <h1 style="font-size:20px;margin:0 0 4px;color:#ff7a3d;">ADEANEASYFIT</h1>
      <p style="margin:0 0 20px;font-size:13px;color:#999;">Informe de ${escapeHtmlEmail(dayName)} — ${escapeHtmlEmail(username)}</p>
      <p style="font-size:14px;color:#bbb;">Todavía no hay ninguna sesión registrada para "${escapeHtmlEmail(dayName)}".</p>
    </div>`;
  }
  const session = (sessionDate && daySessions.find(s => s.date === sessionDate)) || daySessions[0];

  const setRows = [];
  (session.exercises || []).forEach(ex => {
    const expected = computeExpectedMaxEmail(profile, ex.name);
    const shortName = ex.name.length > 22 ? ex.name.slice(0, 20) + "…" : ex.name;
    (ex.sets || []).forEach((st, i) => {
      if ((st.kg || 0) <= 0 && (st.reps || 0) <= 0) return;
      setRows.push({ exerciseName: ex.name, shortName, setNum: i + 1, reps: st.reps || 0, kg: st.kg || 0, expected });
    });
  });

  const totalKg = setRows.reduce((sum, r) => sum + r.kg, 0);
  const withExpected = setRows.filter(r => r.expected != null);
  const sumReal = withExpected.reduce((s, r) => s + r.kg, 0);
  const sumExpected = withExpected.reduce((s, r) => s + r.expected, 0);
  const rendimientoPct = sumExpected > 0 ? Math.round((sumReal / sumExpected) * 1000) / 10 : null;
  const exerciseCount = new Set(setRows.map(r => r.exerciseName)).size;

  const kpiCards = `
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin:14px 0;">
      <div style="flex:1;min-width:130px;background:#1f1f22;border-radius:10px;padding:12px 14px;">
        <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.03em;">Carga total</div>
        <div style="font-size:19px;font-weight:700;margin-top:2px;">${Math.round(totalKg).toLocaleString("es-ES")} kg</div>
        <div style="font-size:11px;color:#777;">Suma del peso marcado por serie</div>
      </div>
      ${rendimientoPct != null ? `
      <div style="flex:1;min-width:130px;background:#1f1f22;border-radius:10px;padding:12px 14px;">
        <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.03em;">Rendimiento</div>
        <div style="font-size:19px;font-weight:700;margin-top:2px;color:${rendimientoPct >= 100 ? '#34c579' : '#ff7a3d'};">${rendimientoPct}%</div>
        <div style="font-size:11px;color:#777;">vs. sombra esperada</div>
      </div>` : ``}
      <div style="flex:1;min-width:130px;background:#1f1f22;border-radius:10px;padding:12px 14px;">
        <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.03em;">Series totales</div>
        <div style="font-size:19px;font-weight:700;margin-top:2px;">${setRows.length}</div>
        <div style="font-size:11px;color:#777;">${exerciseCount} ejercicio${exerciseCount === 1 ? "" : "s"}</div>
      </div>
    </div>`;

  const tableRows = setRows.map(r => {
    let estado, estadoColor;
    if (r.expected == null) { estado = "—"; estadoColor = "#999"; }
    else {
      const diff = Math.round((r.kg - r.expected) * 10) / 10;
      if (diff === 0) { estado = "Objetivo"; estadoColor = "#5b8def"; }
      else if (diff > 0) { estado = `+${diff} kg (Superado)`; estadoColor = "#34c579"; }
      else { estado = `${diff} kg`; estadoColor = "#ff5a2e"; }
    }
    return `<tr>
      <td style="padding:7px 9px;border-bottom:1px solid #2a2a2c;font-weight:600;">${escapeHtmlEmail(r.exerciseName)}</td>
      <td style="padding:7px 9px;border-bottom:1px solid #2a2a2c;text-align:center;">S${r.setNum}</td>
      <td style="padding:7px 9px;border-bottom:1px solid #2a2a2c;text-align:center;">${r.reps} reps</td>
      <td style="padding:7px 9px;border-bottom:1px solid #2a2a2c;text-align:center;"><b>${r.kg} kg</b></td>
      <td style="padding:7px 9px;border-bottom:1px solid #2a2a2c;text-align:center;color:#999;">${r.expected != null ? r.expected + " kg" : "—"}</td>
      <td style="padding:7px 9px;border-bottom:1px solid #2a2a2c;text-align:center;color:${estadoColor};font-weight:600;">${estado}</td>
    </tr>`;
  }).join("");

  const commentHtml = comment ? `
    <div style="margin-top:16px;background:#2a2410;border-left:3px solid #d9a441;border-radius:6px;padding:10px 14px;">
      <b style="font-size:13px;">Comentario del entrenador:</b>
      <div style="font-size:13px;color:#e8e8e8;margin-top:3px;">${escapeHtmlEmail(comment)}</div>
    </div>` : "";

  return `
  <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#0f0f10;padding:28px 24px;border-radius:14px;color:#f2f2f2;">
    <h1 style="font-size:20px;margin:0 0 4px;color:#ff7a3d;">RESUMEN DE ENTRENAMIENTO</h1>
    <p style="margin:0 0 4px;font-size:13px;color:#ccc;">Sesión: <b>${escapeHtmlEmail(dayName)}</b> · Cliente: <b>${escapeHtmlEmail(username)}</b></p>
    <p style="margin:0 0 18px;font-size:12px;color:#999;">Fecha: ${shortDMYEmail(session.date)}</p>
    <div style="background:#1a1a1c;border-radius:10px;padding:18px;color:#e8e8e8;">
      ${kpiCards}
      ${dayBarChartImgTag(setRows)}
      <table style="width:100%;border-collapse:collapse;margin-top:6px;font-size:13px;">
        <thead><tr>
          <th style="text-align:left;padding:6px 9px;border-bottom:2px solid #ff5a2e;font-size:11px;color:#999;">Ejercicio</th>
          <th style="text-align:center;padding:6px 9px;border-bottom:2px solid #ff5a2e;font-size:11px;color:#999;">Serie</th>
          <th style="text-align:center;padding:6px 9px;border-bottom:2px solid #ff5a2e;font-size:11px;color:#999;">Reps</th>
          <th style="text-align:center;padding:6px 9px;border-bottom:2px solid #ff5a2e;font-size:11px;color:#999;">Carga real</th>
          <th style="text-align:center;padding:6px 9px;border-bottom:2px solid #ff5a2e;font-size:11px;color:#999;">Sombra esperada</th>
          <th style="text-align:center;padding:6px 9px;border-bottom:2px solid #ff5a2e;font-size:11px;color:#999;">Estado</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
      ${commentHtml}
    </div>
    <p style="margin:20px 0 0;font-size:12px;color:#777;">Informe de seguimiento • ADEANEASYFIT</p>
  </div>`;
}

function buildProgressEmailHtml(username, data, frequency) {
  const profile = data.profile || {};
  const sessions = (data.state && data.state.sessions) || [];
  const weightHistory = profile.weightHistory || [];
  const intervalDays = FREQUENCY_DAYS[frequency] || 30;
  const cutoff = Date.now() - intervalDays * 86400000;
  const periodLabel = FREQUENCY_LABEL_ES[frequency] || "el periodo";
  const recentSessions = sessions.filter(s => new Date(s.date).getTime() >= cutoff)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // --- Peso corporal: SIEMPRE se muestra, con o sin datos en el periodo ---
  const weightInPeriod = weightHistory.slice().sort((a, b) => new Date(a.date) - new Date(b.date))
    .filter(w => new Date(w.date).getTime() >= cutoff);
  let weightLine;
  if (weightInPeriod.length >= 2) {
    const first = weightInPeriod[0].weightKg;
    const last = weightInPeriod[weightInPeriod.length - 1].weightKg;
    const diff = Math.round((last - first) * 10) / 10;
    weightLine = `<b>${last} kg</b> (${arrowFor(diff)} ${diff > 0 ? "+" : ""}${diff} kg en ${periodLabel})`;
  } else if (weightHistory.length > 0) {
    const all = weightHistory.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const last = all[all.length - 1];
    const daysSince = Math.round((Date.now() - new Date(last.date).getTime()) / 86400000);
    weightLine = `<b>${last.weightKg} kg</b> (última pesada registrada hace ${daysSince} día${daysSince === 1 ? "" : "s"} — sin nueva pesada en ${periodLabel})`;
  } else {
    weightLine = `sin ningún peso registrado todavía`;
  }

  // --- Todos los ejercicios entrenados en el periodo, con mejora o declive ---
  const byExercise = {};
  recentSessions.forEach(s => {
    (s.exercises || []).forEach(ex => {
      const sessionMax = (ex.sets || []).reduce((m, st) => Math.max(m, st.kg || 0), 0);
      const sessionReps = (ex.sets || []).reduce((best, st) => (st.kg || 0) >= sessionMax && sessionMax > 0 ? (st.reps || 0) : best, 0);
      if (!byExercise[ex.name]) byExercise[ex.name] = [];
      byExercise[ex.name].push({ date: s.date, kg: sessionMax, reps: sessionReps });
    });
  });

  const exerciseRows = Object.entries(byExercise).map(([name, points]) => {
    points.sort((a, b) => new Date(a.date) - new Date(b.date));
    const first = points[0];
    const last = points[points.length - 1];
    const diff = Math.round((last.kg - first.kg) * 10) / 10;
    const trendTxt = points.length > 1
      ? `${arrowFor(diff)} ${diff > 0 ? "+" : ""}${diff} kg en ${periodLabel}`
      : `única marca de ${periodLabel}`;
    const expected = computeExpectedMaxEmail(profile, name);
    let expectedTxt = "";
    if (expected != null && last.kg > 0) {
      expectedTxt = expectedGapHtml(last.kg, expected, "tu");
    }
    return {
      name,
      expected,
      points,
      rowHtml: `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #2a2a2c;">${escapeHtmlEmail(name)}${expectedTxt}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #2a2a2c;text-align:right;"><b>${last.kg} kg</b> × ${last.reps}<br><span style="font-size:12px;color:#999;">${trendTxt}</span></td>
      </tr>`,
    };
  });

  const exerciseChartsHtml = exerciseRows.map(e => exerciseChartImgTag(e.name, e.points, e.expected)).join("");

  const bodyContent = `
    <p style="margin:0 0 6px;font-size:15px;">Entrenamientos completados: <b>${recentSessions.length}</b> en ${periodLabel}.</p>
    <p style="margin:0 0 8px;font-size:15px;">Peso corporal: ${weightLine}</p>
    ${weightChartImgTag(weightHistory)}
    ${exerciseRows.length > 0 ? `
      <table style="width:100%;border-collapse:collapse;margin-top:8px;">
        <thead><tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ff5a2e;font-size:13px;color:#999;">Ejercicio</th><th style="text-align:right;padding:6px 10px;border-bottom:2px solid #ff5a2e;font-size:13px;color:#999;">Última marca</th></tr></thead>
        <tbody>${exerciseRows.map(e => e.rowHtml).join("")}</tbody>
      </table>
      ${exerciseChartsHtml}
    ` : `<p style="font-size:14px;color:#bbb;">No se ha registrado ningún ejercicio en ${periodLabel}.</p>`}
  `;

  return emailShell(`Resumen de progreso de <b>${escapeHtmlEmail(username)}</b>`, bodyContent,
    "Puedes cambiar la frecuencia de estos emails, o desactivarlos, desde la pestaña Progreso de la app.");
}

// Email con la gráfica de UN solo ejercicio de UN cliente — lo que usa el
// botón "Enviar por email" del Panel de clientes en admin.html. Usa todo el
// historial de sesiones de ese ejercicio (no está acotado a un periodo, a
// diferencia del resumen periódico del propio cliente).
function buildExerciseChartEmailHtml(username, data, exerciseName) {
  const profile = data.profile || {};
  const sessions = (data.state && data.state.sessions) || [];
  const points = [];
  sessions.forEach(s => {
    const ex = (s.exercises || []).find(e => e.name === exerciseName);
    if (ex) {
      const mx = (ex.sets || []).reduce((m, st) => Math.max(m, st.kg || 0), 0);
      if (mx > 0) points.push({ date: s.date, kg: mx });
    }
  });
  points.sort((a, b) => new Date(a.date) - new Date(b.date));
  const expected = computeExpectedMaxEmail(profile, exerciseName);

  let bodyContent;
  if (points.length < 2) {
    bodyContent = `<p style="font-size:14px;color:#bbb;">Todavía no hay suficientes sesiones registradas de "${escapeHtmlEmail(exerciseName)}" para dibujar una gráfica (se necesitan al menos 2).</p>`;
  } else {
    const first = points[0];
    const last = points[points.length - 1];
    const diff = Math.round((last.kg - first.kg) * 10) / 10;
    let expectedTxt = "";
    if (expected != null) {
      expectedTxt = expectedGapHtml(last.kg, expected, "su");
    }
    bodyContent = `
      <p style="margin:0 0 6px;font-size:15px;">Última marca: <b>${last.kg} kg</b> (${arrowFor(diff)} ${diff > 0 ? "+" : ""}${diff} kg desde el primer registro)${expectedTxt}</p>
      ${exerciseChartImgTag(exerciseName, points, expected)}
    `;
  }

  return emailShell(`Progreso de <b>${escapeHtmlEmail(username)}</b> en «${escapeHtmlEmail(exerciseName)}»`, bodyContent,
    "Informe enviado desde ADEANEASYFIT.");
}

// Marco común de los emails de progreso (cabecera, tarjeta y pie).
function emailShell(subtitleHtml, bodyContent, footer, maxWidth) {
  return `
  <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:${maxWidth || 520}px;margin:0 auto;background:#0f0f10;padding:28px 24px;border-radius:14px;color:#f2f2f2;">
    <h1 style="font-size:20px;margin:0 0 4px;color:#ff7a3d;">ADEANEASYFIT</h1>
    <p style="margin:0 0 20px;font-size:13px;color:#999;">${subtitleHtml}</p>
    <div style="background:#1a1a1c;border-radius:10px;padding:18px;color:#e8e8e8;">
      ${bodyContent}
    </div>
    <p style="margin:20px 0 0;font-size:12px;color:#777;">${footer}</p>
  </div>`;
}

// Línea "± X kg frente a lo esperado" (compartida por resumen periódico e informe de ejercicio).
function expectedGapHtml(lastKg, expected, who) {
  const gap = Math.round((lastKg - expected) * 10) / 10;
  return `<br><span style="font-size:12px;color:#999;">${arrowFor(gap)} ${gap >= 0 ? "+" : ""}${gap} kg frente a lo esperado para ${who} experiencia (${expected} kg)</span>`;
}

// =====================================================================
// EXCEL DEL CLIENTE (.xlsx)
// Se genera aquí mismo, sin librerías externas: un .xlsx es un ZIP con
// varios XML. Una hoja "Resumen" y una hoja por día entrenado, con la tabla
// de ejercicios/series/reps/kg y los gráficos de ese día.
// =====================================================================
const EXCEL_MAX_SESSIONS = 60;  // hojas máximas (las más recientes)
const EXCEL_MAX_IMAGES = 40;    // gráficos máximos (límite de peticiones externas y de CPU)
const EXCEL_RANGES = [0, 30, 90, 180, 365]; // días hacia atrás; 0 = todo

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ZIP sin compresión ("stored"): válido para Excel y muy barato de generar.
function zipStore(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1);
  const dosDate = (((now.getUTCFullYear() - 1980) & 0x7F) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate();
  const entries = files.map(f => ({
    nameBytes: enc.encode(f.name),
    data: typeof f.data === "string" ? enc.encode(f.data) : f.data,
  }));
  entries.forEach(e => { e.crc = crc32(e.data); });

  let size = 22;
  entries.forEach(e => { size += 30 + e.nameBytes.length + e.data.length + 46 + e.nameBytes.length; });
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let pos = 0;
  const u16 = v => { dv.setUint16(pos, v, true); pos += 2; };
  const u32 = v => { dv.setUint32(pos, v, true); pos += 4; };

  entries.forEach(e => {
    e.offset = pos;
    u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(dosTime); u16(dosDate);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.nameBytes.length); u16(0);
    out.set(e.nameBytes, pos); pos += e.nameBytes.length;
    out.set(e.data, pos); pos += e.data.length;
  });
  const cdStart = pos;
  entries.forEach(e => {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(dosTime); u16(dosDate);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.nameBytes.length);
    u16(0); u16(0); u16(0); u16(0); u32(0); u32(e.offset);
    out.set(e.nameBytes, pos); pos += e.nameBytes.length;
  });
  const cdSize = pos - cdStart;
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length); u32(cdSize); u32(cdStart); u16(0);
  return out;
}

// Base64 de bytes. Escrito a mano (con la función nativa si el motor la tiene)
// porque es lo que más CPU gasta al generar el Excel y el plan gratuito de
// Cloudflare tiene un límite de CPU por petición muy ajustado.
const B64_ALPHABET = new Uint8Array(Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", c => c.charCodeAt(0)));
function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  const n = bytes.length, full = n - (n % 3), out = new Uint8Array(Math.ceil(n / 3) * 4);
  const T = B64_ALPHABET;
  let o = 0, i = 0;
  for (; i < full; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = T[v >> 18]; out[o++] = T[(v >> 12) & 63]; out[o++] = T[(v >> 6) & 63]; out[o++] = T[v & 63];
  }
  const rest = n - full;
  if (rest === 1) {
    const v = bytes[i] << 16;
    out[o++] = T[v >> 18]; out[o++] = T[(v >> 12) & 63]; out[o++] = 61; out[o++] = 61;
  } else if (rest === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out[o++] = T[v >> 18]; out[o++] = T[(v >> 12) & 63]; out[o++] = T[(v >> 6) & 63]; out[o++] = 61;
  }
  return new TextDecoder("latin1").decode(out);
}

function xmlEsc(s) {
  return String(s == null ? "" : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colLetter(i) { // 0 -> A
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Fecha dd/mm/aaaa en hora de España (para que una sesión de madrugada no caiga en el día anterior).
function madridDMY(iso) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(new Date(iso));
  const get = t => (parts.find(p => p.type === t) || {}).value || "";
  return `${get("day")}/${get("month")}/${get("year")}`;
}

function durationEs(sec) {
  if (typeof sec !== "number" || !isFinite(sec) || sec < 0) return "";
  const m = Math.round(sec / 60);
  if (m < 1) return "< 1 min";
  const h = Math.floor(m / 60);
  return h === 0 ? `${m} min` : `${h} h ${String(m % 60).padStart(2, "0")} min`;
}

function uniqueSheetName(wanted, used) {
  let base = String(wanted).replace(/[\[\]:*?\/\\]/g, "-").replace(/^'+|'+$/g, "").trim().slice(0, 31) || "Hoja";
  let name = base, n = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${n++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

// Convierte los datos del cliente en un "plano" de libro: hojas con celdas e imágenes pedidas.
// No hace ninguna petición externa, así se puede probar sin red.
function planClientExcel(username, data, rangeDays) {
  const profile = data.profile || {};
  const allSessions = ((data.state && data.state.sessions) || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  let sessions = allSessions;
  if (rangeDays > 0) {
    const cutoff = Date.now() - rangeDays * 86400000;
    sessions = sessions.filter(s => new Date(s.date).getTime() >= cutoff);
  }
  const truncated = sessions.length > EXCEL_MAX_SESSIONS;
  sessions = sessions.slice(0, EXCEL_MAX_SESSIONS);

  const used = new Set(["resumen"]);
  const daySheets = [];
  sessions.forEach(session => {
    const setRows = [];
    (session.exercises || []).forEach(ex => {
      const expected = computeExpectedMaxEmail(profile, ex.name);
      const shortName = ex.name.length > 22 ? ex.name.slice(0, 20) + "…" : ex.name;
      (ex.sets || []).forEach((st, i) => {
        if ((st.kg || 0) <= 0 && (st.reps || 0) <= 0) return;
        setRows.push({ exerciseName: ex.name, shortName, setNum: i + 1, reps: st.reps || 0, kg: st.kg || 0, expected });
      });
    });
    if (setRows.length === 0) return; // sesión guardada en blanco: no aporta marcas
    const fecha = madridDMY(session.date);
    const sheetName = uniqueSheetName(`${fecha.replace(/\//g, "-")} ${session.dayName || "Entreno"}`, used);
    daySheets.push({ sheetName, session, fecha, setRows, images: [] });
  });

  // Gráfico: solo el general de cada sesión (carga real frente a la sombra esperada, por serie).
  let budget = EXCEL_MAX_IMAGES;
  daySheets.forEach(sh => {
    if (budget <= 0) return;
    const { config, width } = dayBarChartConfig(sh.setRows, EXCEL_PALETTE.map(c => "#" + c));
    sh.images.push({ label: "Gráfico general de la sesión: carga real frente a la sombra esperada, por serie", url: quickChartUrl(config, width, 280, 1), w: width, h: 280 });
    budget--;
  });
  return { username, rangeDays, truncated, totalSessionsInRange: sessions.length, daySheets };
}

function textCell(ref, text, style) {
  return `<c r="${ref}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`;
}
function numCell(ref, n, style) {
  return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${n}</v></c>`;
}
function sheetXml(rows, colWidths, hasDrawing) {
  const cols = colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const body = rows.map(r => `<row r="${r.n}">${r.cells.join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${body}</sheetData>${hasDrawing ? '<drawing r:id="rId1"/>' : ""}</worksheet>`;
}

// Colores por ejercicio en el Excel: alternan naranjas y grises (de claro a más intenso)
// para distinguir de un vistazo dónde acaba un ejercicio y empieza otro.
const EXCEL_PALETTE = ["FFD2B0", "E6E6E6", "FFB27F", "C4C4C4", "FF9A5C", "A6A6A6"];

function buildXlsxStyles() {
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFF7A3D"/><bgColor indexed="64"/></patternFill></fill>']
    .concat(EXCEL_PALETTE.map(c => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`));
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    '<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf>',
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center"/></xf>',
  ];
  EXCEL_PALETTE.forEach((c, i) => {
    xfs.push(`<xf numFmtId="0" fontId="0" fillId="${3 + i}" borderId="0" xfId="0" applyFill="1"/>`); // izquierda
    xfs.push(`<xf numFmtId="0" fontId="0" fillId="${3 + i}" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf>`); // centrado
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FFFF5A2E"/><name val="Calibri"/></font></fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}
// Índices de estilo: 1 negrita · 2 cabecera naranja · 3 título · 4 centrado · 5 negrita centrado
// · 6+2c fondo de color c alineado a la izquierda · 7+2c fondo de color c centrado

// Monta el .xlsx. images: array paralelo a plan.daySheets[i].images con { bytes } o null si falló.
function renderClientXlsx(plan, imageBytes) {
  const { daySheets, username } = plan;
  const files = [];
  const sheetParts = []; // { name, xml, drawing? }

  // ---- Hoja Resumen ----
  const sumRows = [];
  sumRows.push({ n: 1, cells: [textCell("A1", `ADEANEASYFIT · Marcas de ${username}`, 3)] });
  const rangoTxt = plan.rangeDays > 0 ? `últimos ${plan.rangeDays} días` : "todo el historial";
  sumRows.push({ n: 2, cells: [textCell("A2", `Periodo: ${rangoTxt} · ${daySheets.length} día${daySheets.length === 1 ? "" : "s"} con marcas · generado el ${madridDMY(new Date().toISOString())}`)] });
  const head = ["Fecha", "Día", "Rutina", "Duración", "Ejercicios", "Series", "Carga total (kg)"];
  sumRows.push({ n: 4, cells: head.map((h, i) => textCell(colLetter(i) + "4", h, 2)) });
  let r = 5;
  daySheets.forEach(sh => {
    const exCount = new Set(sh.setRows.map(x => x.exerciseName)).size;
    const total = Math.round(sh.setRows.reduce((s, x) => s + x.kg, 0) * 10) / 10;
    sumRows.push({ n: r, cells: [
      textCell("A" + r, sh.fecha), textCell("B" + r, sh.session.dayName || ""), textCell("C" + r, sh.session.planName || ""),
      textCell("D" + r, durationEs(sh.session.durationSec) || "—", 4), numCell("E" + r, exCount, 4), numCell("F" + r, sh.setRows.length, 4), numCell("G" + r, total, 4),
    ] });
    r++;
  });
  const notes = [];
  if (plan.truncated) notes.push(`Solo se incluyen los ${EXCEL_MAX_SESSIONS} días más recientes del periodo.`);
  const sinGrafico = daySheets.filter(sh => sh.images.length === 0).length;
  if (sinGrafico > 0) notes.push(`${sinGrafico} día(s) sin gráficos para no superar el límite de ${EXCEL_MAX_IMAGES} imágenes por Excel. Pide un periodo más corto para verlos todos.`);
  r++;
  notes.forEach(t => { sumRows.push({ n: r, cells: [textCell("A" + r, t)] }); r++; });
  sheetParts.push({ name: "Resumen", xml: sheetXml(sumRows, [14, 28, 24, 14, 12, 10, 18], false) });

  // ---- Una hoja por día ----
  let imgCounter = 0;
  const drawings = [];
  daySheets.forEach((sh, idx) => {
    const rows = [];
    rows.push({ n: 1, cells: [textCell("A1", `${sh.session.dayName || "Entrenamiento"} · ${username}`, 3)] });
    rows.push({ n: 2, cells: [textCell("A2", "Fecha:", 1), textCell("B2", sh.fecha), textCell("C2", "Duración:", 1), textCell("D2", durationEs(sh.session.durationSec) || "—")] });
    if (sh.session.planName) rows.push({ n: 3, cells: [textCell("A3", "Rutina:", 1), textCell("B3", sh.session.planName)] });
    const header = ["Ejercicio", "Serie", "Repeticiones", "Peso (kg)", "Sombra esperada (kg)", "Diferencia (kg)"];
    rows.push({ n: 5, cells: header.map((h, i) => textCell(colLetter(i) + "5", h, 2)) });
    let row = 6;
    const exOrder = [];
    sh.setRows.forEach(x => {
      let ci = exOrder.indexOf(x.exerciseName);
      if (ci < 0) { exOrder.push(x.exerciseName); ci = exOrder.length - 1; }
      const left = 6 + 2 * (ci % EXCEL_PALETTE.length), center = left + 1; // color propio de cada ejercicio
      const cells = [textCell("A" + row, x.exerciseName, left), numCell("B" + row, x.setNum, center), numCell("C" + row, x.reps, center), numCell("D" + row, x.kg, center)];
      if (x.expected != null) {
        cells.push(numCell("E" + row, x.expected, center));
        cells.push(numCell("F" + row, Math.round((x.kg - x.expected) * 10) / 10, center));
      } else {
        cells.push(`<c r="E${row}" s="${center}"/>`, `<c r="F${row}" s="${center}"/>`);
      }
      rows.push({ n: row, cells });
      row++;
    });
    const first = 6, last = row - 1;
    const totalKg = Math.round(sh.setRows.reduce((s, x) => s + x.kg, 0) * 10) / 10;
    const totalReps = sh.setRows.reduce((s, x) => s + x.reps, 0);
    rows.push({ n: row, cells: [
      textCell("A" + row, "Totales", 1), numCell("B" + row, sh.setRows.length, 5),
      `<c r="C${row}" s="5"><f>SUM(C${first}:C${last})</f><v>${totalReps}</v></c>`,
      `<c r="D${row}" s="5"><f>SUM(D${first}:D${last})</f><v>${totalKg}</v></c>`,
    ] });
    let cursor = row + 2;

    // Gráficos de esa hoja que se pudieron descargar
    const anchors = [];
    sh.images.forEach((img, k) => {
      const bytes = imageBytes[idx] && imageBytes[idx][k];
      if (!bytes) {
        rows.push({ n: cursor, cells: [textCell("A" + cursor, `${img.label}: gráfico no disponible en este envío.`)] });
        cursor += 2;
        return;
      }
      rows.push({ n: cursor, cells: [textCell("A" + cursor, img.label, 1)] });
      imgCounter++;
      files.push({ name: `xl/media/image${imgCounter}.png`, data: bytes });
      anchors.push({ rowIndex: cursor, w: img.w, h: img.h, media: `image${imgCounter}.png` });
      cursor += Math.ceil(img.h / 20) + 2;
    });

    const part = { name: sh.sheetName, xml: null, drawing: null };
    if (anchors.length) {
      const dn = drawings.length + 1;
      drawings.push({ n: dn, anchors });
      part.drawing = dn;
    }
    part.xml = sheetXml(rows, [34, 10, 16, 14, 22, 18], anchors.length > 0);
    sheetParts.push(part);
  });

  // ---- Piezas del paquete ----
  const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const sheetsXml = sheetParts.map((p, i) => `<sheet name="${xmlEsc(p.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  files.push({ name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetParts.map((p, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}${drawings.map(d => `<Override PartName="/xl/drawings/drawing${d.n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join("")}</Types>` });
  files.push({ name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
  files.push({ name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_R}"><sheets>${sheetsXml}</sheets></workbook>` });
  files.push({ name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetParts.map((p, i) => `<Relationship Id="rId${i + 1}" Type="${NS_R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheetParts.length + 1}" Type="${NS_R}/styles" Target="styles.xml"/></Relationships>` });
  files.push({ name: "xl/styles.xml", data: buildXlsxStyles() });
  sheetParts.forEach((p, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: p.xml });
    if (p.drawing) {
      files.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_R}/drawing" Target="../drawings/drawing${p.drawing}.xml"/></Relationships>` });
    }
  });
  drawings.forEach(d => {
    const anchorsXml = d.anchors.map((a, k) => {
      const cx = a.w * 9525, cy = a.h * 9525;
      return `<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.rowIndex}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${cx}" cy="${cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${k + 2}" name="Gráfico ${k + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${k + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
    }).join("");
    files.push({ name: `xl/drawings/drawing${d.n}.xml`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_R}">${anchorsXml}</xdr:wsDr>` });
    files.push({ name: `xl/drawings/_rels/drawing${d.n}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${d.anchors.map((a, k) => `<Relationship Id="rId${k + 1}" Type="${NS_R}/image" Target="../media/${a.media}"/>`).join("")}</Relationships>` });
  });
  return zipStore(files);
}

// Descarga un gráfico PNG de quickchart.io; null si falla (el Excel sale igual, sin ese gráfico).
async function fetchChartPng(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!resp.ok) return null;
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
    return isPng ? bytes : null;
  } catch (e) {
    return null;
  }
}

async function buildClientExcel(username, data, rangeDays, imageFetcher) {
  const plan = planClientExcel(username, data, rangeDays);
  const fetcher = imageFetcher || fetchChartPng;
  const imageBytes = await Promise.all(plan.daySheets.map(sh => Promise.all(sh.images.map(img => fetcher(img.url)))));
  const bytes = renderClientXlsx(plan, imageBytes);
  const charts = imageBytes.reduce((n, arr) => n + arr.filter(Boolean).length, 0);
  return { bytes, plan, charts };
}

function escapeHtmlEmail(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
