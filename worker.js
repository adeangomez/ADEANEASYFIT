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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");

      if (!username || username.length < 2) return err("Usuario inválido.");
      if (!password || password.length < 4) return err("Contraseña demasiado corta (mínimo 4).");

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      const newPassword = String(body.newPassword || "");
      if (!username) return err("Usuario inválido.");
      if (!newPassword || newPassword.length < 4) return err("La nueva contraseña debe tener al menos 4 caracteres.");

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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

      const raw = await env.ADEANFIT_KV.get("user:" + username);
      if (!raw) return err("Usuario o contraseña incorrectos.", 401);
      const user = JSON.parse(raw);

      const hash = await hashPassword(password, user.salt);
      if (hash !== user.hash) return err("Usuario o contraseña incorrectos.", 401);

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
      if (!newPassword || newPassword.length < 4) return err("La nueva contraseña debe tener al menos 4 caracteres.");

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

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
    // ADMIN: enviar por email la gráfica de un ejercicio concreto de un
    // cliente (desde el Panel de clientes)  (POST /admin/send-exercise-chart-email)
    // Header: X-Admin-Key   Body: { "username": "...", "exerciseName": "...", "to": "..." }
    // ---------------------------------------------------------------
    if (path === "/admin/send-exercise-chart-email" && request.method === "POST") {
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      const exerciseName = String(body.exerciseName || "").trim();
      const to = String(body.to || "").trim();
      if (!username) return err("Usuario inválido.");
      if (!exerciseName) return err("Falta el ejercicio.");
      if (!to) return err("Indica a qué email quieres enviarlo.");

      const dataRaw = await env.ADEANFIT_KV.get("data:" + username);
      if (!dataRaw) return err("Ese usuario no existe o no tiene datos.", 404);
      const data = JSON.parse(dataRaw);

      try {
        const html = buildExerciseChartEmailHtml(username, data, exerciseName);
        await sendEmailViaResend(env, to, `Progreso de ${username} — ${exerciseName}`, html);
        return json({ ok: true, to });
      } catch (e) {
        return err("No se pudo enviar: " + e.message, 502);
      }
    }

    // ---------------------------------------------------------------
    // ADMIN: enviar por email el informe completo de un día de rutina de un
    // cliente (desde el Panel de clientes)  (POST /admin/send-day-chart-email)
    // Header: X-Admin-Key   Body: { "username", "dayName", "to", "comment"? }
    // ---------------------------------------------------------------
    if (path === "/admin/send-day-chart-email" && request.method === "POST") {
      const adminKey = request.headers.get("X-Admin-Key") || "";
      if (adminKey !== env.ADMIN_KEY) return err("No autorizado.", 401);

      const body = await request.json().catch(() => ({}));
      const username = normalizeUsername(body.username);
      const dayName = String(body.dayName || "").trim();
      const to = String(body.to || "").trim();
      const comment = String(body.comment || "").trim();
      if (!username) return err("Usuario inválido.");
      if (!dayName) return err("Falta el día de rutina.");
      if (!to) return err("Indica a qué email quieres enviarlo.");

      const dataRaw = await env.ADEANFIT_KV.get("data:" + username);
      if (!dataRaw) return err("Ese usuario no existe o no tiene datos.", 404);
      const data = JSON.parse(dataRaw);

      try {
        const html = buildDayReportEmailHtml(username, data, dayName, comment);
        await sendEmailViaResend(env, to, `Informe de entrenamiento — ${dayName} (${username})`, html);
        return json({ ok: true, to });
      } catch (e) {
        return err("No se pudo enviar: " + e.message, 502);
      }
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

async function sendEmailViaResend(env, to, subject, html) {
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
function quickChartUrl(chartConfig, width, height) {
  const encoded = encodeURIComponent(JSON.stringify(chartConfig));
  return `https://quickchart.io/chart?width=${width}&height=${height}&devicePixelRatio=2&backgroundColor=%230f0f10&c=${encoded}`;
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

function exerciseChartImgTag(name, points, expected) {
  if (points.length < 2) return "";
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
  const config = {
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
  const url = quickChartUrl(config, 500, 220);
  return `<img src="${url}" width="500" height="220" alt="Gráfica de ${escapeHtmlEmail(name)}" style="width:100%;max-width:500px;border-radius:8px;margin:10px 0 4px;">`;
}

function shortDMYEmail(iso) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Gráfico de barras pareadas (Esperado en gris, Real en verde si cumple/supera
// el objetivo u naranja si se queda corto) — una pareja de barras por serie.
function dayBarChartImgTag(setRows) {
  const withExpected = setRows.filter(r => r.expected != null);
  if (withExpected.length === 0) return "";
  const labels = setRows.map(r => `${r.shortName} S${r.setNum}`);
  const realColors = setRows.map(r => r.expected == null ? "#5b8def" : (r.kg >= r.expected ? "#34c579" : "#ff5a2e"));
  const config = {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Sombra esperada", data: setRows.map(r => r.expected), backgroundColor: "rgba(170,170,170,0.35)" },
        { label: "Carga real", data: setRows.map(r => r.kg), backgroundColor: realColors },
      ],
    },
    options: {
      plugins: { legend: { display: true, labels: { color: "#ccc" } } },
      scales: {
        x: { ticks: { color: "#ccc", font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { color: "#ccc" }, grid: { color: "#2a2a2c" } },
      },
    },
  };
  const url = quickChartUrl(config, 600, 260);
  return `<img src="${url}" width="600" height="260" alt="Comparativa de carga real vs. esperada" style="width:100%;max-width:600px;border-radius:8px;margin:10px 0 16px;">`;
}

// Informe completo de UNA sesión (un día de rutina) — misma estructura que el
// informe de referencia: KPIs, gráfico de barras esperado vs. real por serie,
// tabla de desglose completo, y comentario opcional del entrenador. Usa la
// sesión más reciente registrada para ese día de rutina.
function buildDayReportEmailHtml(username, data, dayName, comment) {
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
  const session = daySessions[0];

  const setRows = [];
  (session.exercises || []).forEach(ex => {
    const expected = computeExpectedMaxEmail(profile, ex.name);
    const shortName = ex.name.length > 22 ? ex.name.slice(0, 20) + "…" : ex.name;
    (ex.sets || []).forEach((st, i) => {
      if ((st.kg || 0) <= 0 && (st.reps || 0) <= 0) return;
      setRows.push({ exerciseName: ex.name, shortName, setNum: i + 1, reps: st.reps || 0, kg: st.kg || 0, expected });
    });
  });

  const totalVolume = setRows.reduce((sum, r) => sum + r.kg * r.reps, 0);
  const withExpected = setRows.filter(r => r.expected != null);
  const sumReal = withExpected.reduce((s, r) => s + r.kg, 0);
  const sumExpected = withExpected.reduce((s, r) => s + r.expected, 0);
  const rendimientoPct = sumExpected > 0 ? Math.round((sumReal / sumExpected) * 1000) / 10 : null;
  const exerciseCount = new Set(setRows.map(r => r.exerciseName)).size;

  const kpiCards = `
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin:14px 0;">
      <div style="flex:1;min-width:130px;background:#1f1f22;border-radius:10px;padding:12px 14px;">
        <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.03em;">Carga total</div>
        <div style="font-size:19px;font-weight:700;margin-top:2px;">${Math.round(totalVolume).toLocaleString("es-ES")} kg</div>
        <div style="font-size:11px;color:#777;">Volumen de trabajo</div>
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
      const gap = Math.round((last.kg - expected) * 10) / 10;
      expectedTxt = `<br><span style="font-size:12px;color:#999;">${arrowFor(gap)} ${gap >= 0 ? "+" : ""}${gap} kg frente a lo esperado para tu experiencia (${expected} kg)</span>`;
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

  return `
  <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;background:#0f0f10;padding:28px 24px;border-radius:14px;color:#f2f2f2;">
    <h1 style="font-size:20px;margin:0 0 4px;color:#ff7a3d;">ADEANEASYFIT</h1>
    <p style="margin:0 0 20px;font-size:13px;color:#999;">Resumen de progreso de <b>${escapeHtmlEmail(username)}</b></p>
    <div style="background:#1a1a1c;border-radius:10px;padding:18px;color:#e8e8e8;">
      ${bodyContent}
    </div>
    <p style="margin:20px 0 0;font-size:12px;color:#777;">Puedes cambiar la frecuencia de estos emails, o desactivarlos, desde la pestaña Progreso de la app.</p>
  </div>`;
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
      const gap = Math.round((last.kg - expected) * 10) / 10;
      expectedTxt = `<br><span style="font-size:12px;color:#999;">${arrowFor(gap)} ${gap >= 0 ? "+" : ""}${gap} kg frente a lo esperado para su experiencia (${expected} kg)</span>`;
    }
    bodyContent = `
      <p style="margin:0 0 6px;font-size:15px;">Última marca: <b>${last.kg} kg</b> (${arrowFor(diff)} ${diff > 0 ? "+" : ""}${diff} kg desde el primer registro)${expectedTxt}</p>
      ${exerciseChartImgTag(exerciseName, points, expected)}
    `;
  }

  return `
  <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;background:#0f0f10;padding:28px 24px;border-radius:14px;color:#f2f2f2;">
    <h1 style="font-size:20px;margin:0 0 4px;color:#ff7a3d;">ADEANEASYFIT</h1>
    <p style="margin:0 0 20px;font-size:13px;color:#999;">Progreso de <b>${escapeHtmlEmail(username)}</b> en «${escapeHtmlEmail(exerciseName)}»</p>
    <div style="background:#1a1a1c;border-radius:10px;padding:18px;color:#e8e8e8;">
      ${bodyContent}
    </div>
    <p style="margin:20px 0 0;font-size:12px;color:#777;">Enviado desde el panel de administración de ADEANEASYFIT.</p>
  </div>`;
}

function escapeHtmlEmail(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
