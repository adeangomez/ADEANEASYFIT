const test = require("node:test");
const assert = require("node:assert/strict");
const { cargarWorker, entorno, llamar } = require("./ayudas.cjs");

const w = cargarWorker();
const ADMIN = "clave-admin-de-prueba";

async function crearUsuario(env, usuario, password = "contraseña-segura") {
  const r = await llamar(w, env, "/admin/create-user", { metodo: "POST", admin: ADMIN, cuerpo: { username: usuario, password } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
async function entrar(env, usuario, password = "contraseña-segura", ip) {
  return llamar(w, env, "/login", { metodo: "POST", cuerpo: { username: usuario, password }, ip });
}

test("contraseñas: mínimo 8 caracteres al crear usuario y al cambiarla", async () => {
  const env = entorno();
  const corta = await llamar(w, env, "/admin/create-user", { metodo: "POST", admin: ADMIN, cuerpo: { username: "ana", password: "1234" } });
  assert.equal(corta.status, 400);
  await crearUsuario(env, "ana");
  const { data } = await entrar(env, "ana");
  const cambio = await llamar(w, env, "/change-password", { metodo: "POST", token: data.token, cuerpo: { oldPassword: "contraseña-segura", newPassword: "abc" } });
  assert.equal(cambio.status, 400);
});

test("login: correcto, incorrecto y usuario inexistente", async () => {
  const env = entorno();
  await crearUsuario(env, "ana");
  assert.equal((await entrar(env, "ana")).status, 200);
  assert.equal((await entrar(env, "ana", "mala-contraseña")).status, 401);
  assert.equal((await entrar(env, "nadie")).status, 401);
});

test("login: se bloquea tras 5 fallos seguidos y no deja entrar ni con la contraseña buena", async () => {
  const env = entorno();
  await crearUsuario(env, "ana");
  for (let i = 0; i < 5; i++) assert.equal((await entrar(env, "ana", "mala-contraseña")).status, 401);
  assert.equal((await entrar(env, "ana", "mala-contraseña")).status, 429);
  assert.equal((await entrar(env, "ana")).status, 429);
});

test("login: un acceso correcto reinicia el contador de fallos", async () => {
  const env = entorno();
  await crearUsuario(env, "ana");
  for (let i = 0; i < 3; i++) await entrar(env, "ana", "mala-contraseña");
  assert.equal((await entrar(env, "ana")).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await entrar(env, "ana", "mala-contraseña")).status, 401);
});

test("login: una cuenta suspendida no entra", async () => {
  const env = entorno();
  await crearUsuario(env, "ana");
  await llamar(w, env, "/admin/suspend-user", { metodo: "POST", admin: ADMIN, cuerpo: { username: "ana" } });
  assert.equal((await entrar(env, "ana")).status, 403);
});

test("datos: sin sesión no se puede leer ni guardar", async () => {
  const env = entorno();
  assert.equal((await llamar(w, env, "/data")).status, 401);
  assert.equal((await llamar(w, env, "/data", { metodo: "PUT", cuerpo: { plans: [] } })).status, 401);
  assert.equal((await llamar(w, env, "/data", { token: "inventado" })).status, 401);
});

test("datos: cada usuario solo ve y modifica lo suyo", async () => {
  const env = entorno();
  await crearUsuario(env, "ana");
  await crearUsuario(env, "bea");
  const ana = (await entrar(env, "ana")).data.token;
  const bea = (await entrar(env, "bea")).data.token;

  const guardar = await llamar(w, env, "/data", { metodo: "PUT", token: ana, cuerpo: { plans: [], profile: { weightKg: 70 }, _rev: 0 } });
  assert.equal(guardar.status, 200, JSON.stringify(guardar.data));

  const deAna = await llamar(w, env, "/data", { token: ana });
  assert.equal(deAna.data.profile.weightKg, 70);
  const deBea = await llamar(w, env, "/data", { token: bea });
  assert.equal(deBea.data.profile, undefined);
});

test("datos: la foto de perfil demasiado grande se rechaza", async () => {
  const env = entorno();
  await crearUsuario(env, "ana");
  const t = (await entrar(env, "ana")).data.token;
  const r = await llamar(w, env, "/data", { metodo: "PUT", token: t, cuerpo: { plans: [], profile: { avatarBase64: "x".repeat(400001) }, _rev: 0 } });
  assert.equal(r.status, 413);
});

test("datos: detecta cambios hechos desde otro dispositivo (conflicto)", async () => {
  const env = entorno();
  await crearUsuario(env, "ana");
  const t = (await entrar(env, "ana")).data.token;
  const inicial = await llamar(w, env, "/data", { token: t });
  const rev = inicial.data._rev || 0;
  const a = await llamar(w, env, "/data", { metodo: "PUT", token: t, cuerpo: { plans: [], _rev: rev } });
  assert.equal(a.status, 200);
  const b = await llamar(w, env, "/data", { metodo: "PUT", token: t, cuerpo: { plans: [], _rev: rev } });
  assert.equal(b.status, 409);
});

test("admin: todas las rutas /admin rechazan sin clave o con clave falsa", async () => {
  const env = entorno();
  const rutas = [
    ["GET", "/admin/users"], ["GET", "/admin/backup"],
    ["POST", "/admin/create-user"], ["POST", "/admin/restore"], ["POST", "/admin/suspend-user"],
    ["POST", "/admin/send-report-email"], ["POST", "/admin/send-progress-email-test"],
  ];
  for (const [metodo, ruta] of rutas) {
    const sin = await llamar(w, env, ruta, { metodo, cuerpo: metodo === "POST" ? {} : undefined, ip: "9.9.9.9" });
    assert.equal(sin.status, 401, `${ruta} sin clave`);
    const mala = await llamar(w, env, ruta, { metodo, admin: "clave-falsa", cuerpo: metodo === "POST" ? {} : undefined, ip: "9.9.9.8" });
    assert.equal(mala.status, 401, `${ruta} con clave falsa`);
  }
});

test("admin: tras 10 claves falsas se bloquea esa IP, incluso con la clave buena", async () => {
  const env = entorno();
  for (let i = 0; i < 10; i++) await llamar(w, env, "/admin/users", { admin: "falsa", ip: "5.5.5.5" });
  assert.equal((await llamar(w, env, "/admin/users", { admin: "falsa", ip: "5.5.5.5" })).status, 429);
  assert.equal((await llamar(w, env, "/admin/users", { admin: ADMIN, ip: "5.5.5.5" })).status, 429);
  assert.equal((await llamar(w, env, "/admin/users", { admin: ADMIN, ip: "6.6.6.6" })).status, 200);
});

test("admin: la clave de un usuario normal no abre el panel", async () => {
  const env = entorno();
  await crearUsuario(env, "ana");
  const t = (await entrar(env, "ana")).data.token;
  const r = await llamar(w, env, "/admin/users", { token: t });
  assert.equal(r.status, 401);
});

test("copia de seguridad: se descarga y se restaura con todos los datos", async () => {
  const env = entorno();
  await crearUsuario(env, "ana");
  const t = (await entrar(env, "ana")).data.token;
  await llamar(w, env, "/data", { metodo: "PUT", token: t, cuerpo: { plans: [], profile: { weightKg: 72 }, _rev: 0 } });

  const copia = await llamar(w, env, "/admin/backup", { admin: ADMIN });
  assert.equal(copia.status, 200);
  assert.ok(copia.data.users.ana);
  assert.equal(copia.data.data.ana.profile.weightKg, 72);
  assert.equal(Object.keys(copia.data).includes("sessions"), false);

  const otro = entorno();
  const sinConfirmar = await llamar(w, otro, "/admin/restore", { metodo: "POST", admin: ADMIN, cuerpo: { backup: copia.data } });
  assert.equal(sinConfirmar.status, 400);
  const ok = await llamar(w, otro, "/admin/restore", { metodo: "POST", admin: ADMIN, cuerpo: { backup: copia.data, confirm: true } });
  assert.deepEqual([ok.data.users, ok.data.data], [1, 1]);
  assert.equal((await entrar(otro, "ana")).status, 200);
  const t2 = (await entrar(otro, "ana")).data.token;
  assert.equal((await llamar(w, otro, "/data", { token: t2 })).data.profile.weightKg, 72);
});

test("copia de seguridad: una copia con formato raro se rechaza", async () => {
  const env = entorno();
  const r = await llamar(w, env, "/admin/restore", { metodo: "POST", admin: ADMIN, cuerpo: { backup: { version: 9 }, confirm: true } });
  assert.equal(r.status, 400);
});

test("informes por email: exigen sesión y piden un destinatario", async () => {
  const env = entorno();
  assert.equal((await llamar(w, env, "/send-report-email", { metodo: "POST", cuerpo: { kind: "day", to: "a@b.c", dayName: "x" } })).status, 401);
  await crearUsuario(env, "ana");
  const t = (await entrar(env, "ana")).data.token;
  const sinDestino = await llamar(w, env, "/send-report-email", { metodo: "POST", token: t, cuerpo: { kind: "day", dayName: "x" } });
  assert.equal(sinDestino.status, 400);
  const tipoRaro = await llamar(w, env, "/send-report-email", { metodo: "POST", token: t, cuerpo: { kind: "otro", to: "a@b.c" } });
  assert.equal(tipoRaro.status, 400);
});

test("informes por email: se envía con la API de correo y sin comentario del entrenador si lo pide el cliente", async () => {
  const env = entorno();
  await crearUsuario(env, "ana");
  const t = (await entrar(env, "ana")).data.token;
  await llamar(w, env, "/data", { metodo: "PUT", token: t, cuerpo: { plans: [], profile: { weightKg: 70 }, state: { sessions: [{ id: "1", date: "2026-10-01T10:00:00Z", dayName: "Empuje", exercises: [{ name: "Press banca", sets: [{ kg: 60, reps: 8 }] }] }] }, _rev: 0 } });
  const original = globalThis.fetch;
  let enviado = null;
  globalThis.fetch = async (url, init) => { enviado = { url: String(url), body: JSON.parse(init.body) }; return new Response("{}", { status: 200 }); };
  try {
    const r = await llamar(w, env, "/send-report-email", { metodo: "POST", token: t, cuerpo: { kind: "day", dayName: "Empuje", to: "ana@correo.test", comment: "COMENTARIO-SECRETO" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(enviado.url, "https://api.resend.com/emails");
    assert.deepEqual(enviado.body.to, ["ana@correo.test"]);
    assert.ok(enviado.body.html.includes("Press banca"));
    assert.equal(enviado.body.html.includes("COMENTARIO-SECRETO"), false);
  } finally { globalThis.fetch = original; }
});

test("emails: el texto de usuario se escapa para no colar HTML", () => {
  const html = w.buildExerciseChartEmailHtml("ana", { profile: {}, state: { sessions: [] } }, "<script>alert(1)</script>");
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
});

test("comparación segura de claves", () => {
  assert.equal(w.safeEqual("abc", "abc"), true);
  assert.equal(w.safeEqual("abc", "abd"), false);
  assert.equal(w.safeEqual("abc", "abcd"), false);
  assert.equal(w.safeEqual("", ""), true);
});
