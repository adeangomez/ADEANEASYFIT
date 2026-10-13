// Utilidades para probar worker.js sin Cloudflare: carga el código y simula la base de datos (KV).
const fs = require("fs");
const path = require("path");

function cargarWorker() {
  let src = fs.readFileSync(path.join(__dirname, "..", "worker.js"), "utf8");
  src = src.replace("export default {", "const __worker = {");
  src += "\nreturn { worker: __worker, buildDayReportEmailHtml, buildExerciseChartEmailHtml, buildProgressEmailHtml, computeExpectedMaxEmail, passwordProblem, safeEqual };";
  return new Function(src)();
}

class KVFalso {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = "" } = {}) {
    const keys = [...this.m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
    return { keys, list_complete: true };
  }
}

function entorno() {
  return { ADEANFIT_KV: new KVFalso(), ADMIN_KEY: "clave-admin-de-prueba", RESEND_API_KEY: "re_test" };
}

function peticion(ruta, { metodo = "GET", cuerpo, token, admin, ip = "1.1.1.1" } = {}) {
  const headers = { "CF-Connecting-IP": ip };
  if (cuerpo !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = "Bearer " + token;
  if (admin) headers["X-Admin-Key"] = admin;
  return new Request("https://api.test" + ruta, { method: metodo, headers, body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined });
}

async function llamar(w, env, ruta, opts) {
  const res = await w.worker.fetch(peticion(ruta, opts), env, { waitUntil() {} });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

module.exports = { cargarWorker, entorno, llamar };
