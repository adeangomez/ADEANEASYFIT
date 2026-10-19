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

// ---------- Excel del cliente ----------

// Lector mínimo de ZIP (solo entradas sin comprimir, como las que genera el worker).
function leerZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, "falta el final del zip");
  const n = dv.getUint16(eocd + 10, true);
  let pos = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let i = 0; i < n; i++) {
    assert.equal(dv.getUint32(pos, true), 0x02014b50);
    const crc = dv.getUint32(pos + 16, true), size = dv.getUint32(pos + 24, true);
    const nameLen = dv.getUint16(pos + 28, true), off = dv.getUint32(pos + 42, true);
    const name = Buffer.from(bytes.subarray(pos + 46, pos + 46 + nameLen)).toString("utf8");
    const dataStart = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const data = bytes.subarray(dataStart, dataStart + size);
    assert.equal(w.crc32(data), crc, "CRC incorrecto en " + name);
    out[name] = data;
    pos += 46 + nameLen;
  }
  return out;
}

const PNG_FALSO = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
function datosExcel() {
  const hoy = Date.now();
  const sesion = (dias, dia, ejercicios, extra = {}) => ({ id: String(dias) + dia, date: new Date(hoy - dias * 86400000).toISOString(), dayName: dia, planName: "Fuerza", exercises: ejercicios, ...extra });
  return {
    profile: { weightKg: 80, timeTraining: "1-2a" },
    state: { sessions: [
      sesion(20, "Pecho/Tríceps", [{ name: "Press banca", sets: [{ kg: 60, reps: 8 }, { kg: 62, reps: 6 }] }]),
      sesion(10, "Pecho/Tríceps", [{ name: "Press banca", sets: [{ kg: 65, reps: 8 }, { kg: 0, reps: 0 }] }], { durationSec: 3725 }),
      sesion(5, "Vacío", [{ name: "Press banca", sets: [{ kg: 0, reps: 0 }] }]),
      sesion(400, "Antiguo", [{ name: "Press banca", sets: [{ kg: 40, reps: 10 }] }]),
    ] },
  };
}

test("zip: las entradas se pueden leer de vuelta con su CRC correcto", () => {
  const zip = w.zipStore([{ name: "a.txt", data: "hola ñ" }, { name: "dir/b.bin", data: Uint8Array.from([1, 2, 3, 250]) }]);
  const f = leerZip(zip);
  assert.equal(Buffer.from(f["a.txt"]).toString("utf8"), "hola ñ");
  assert.deepEqual([...f["dir/b.bin"]], [1, 2, 3, 250]);
  assert.equal(w.crc32(new TextEncoder().encode("123456789")), 0xCBF43926); // valor estándar de CRC-32
});

function ymdHace(dias) { return new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10); }

test("excel: manda un mes desde el día base, salta sesiones en blanco y pide un gráfico por hoja", () => {
  const plan = w.planClientExcel("ana", datosExcel(), ymdHace(25)); // sesiones de hace 20 y 10 días; la de hace 5 está en blanco
  assert.equal(plan.daySheets.length, 2);
  assert.equal(plan.daySheets[0].session.durationSec, 3725); // la más reciente primero
  assert.ok(plan.daySheets.every(sh => sh.setRows.every(r => r.kg > 0 || r.reps > 0)));
  assert.ok(plan.daySheets.every(sh => sh.images.length === 1 && sh.images[0].url.startsWith("https://quickchart.io/"))); // solo el gráfico general
  // Con el día base a 15 días, solo entra la de hace 10 días (la de hace 20 queda antes del inicio)
  assert.equal(w.planClientExcel("ana", datosExcel(), ymdHace(15)).daySheets.length, 1);
});

test("excel: el periodo es un mes natural desde el día base (inicio incluido, mismo día del mes siguiente excluido)", () => {
  const datos = { profile: {}, state: { sessions: ["2026-10-14", "2026-10-15", "2026-11-14", "2026-11-15"].map((f, i) => ({ id: String(i), date: f + "T10:00:00Z", dayName: "D" + i, exercises: [{ name: "X", sets: [{ kg: 1, reps: 1 }] }] })) } };
  const plan = w.planClientExcel("ana", datos, "2026-10-15");
  assert.deepEqual(plan.daySheets.map(s => s.session.dayName).sort(), ["D1", "D2"]); // 15-oct y 14-nov
  assert.equal(plan.fromDMY, "15/10/2026");
  assert.equal(plan.toDMY, "14/11/2026");
  assert.equal(w.planClientExcel("ana", datos, "2026-01-31").toDMY, "27/02/2026"); // fin de mes: 31-ene -> 28-feb excluido
  assert.equal(w.planClientExcel("ana", datos, "2026-12-15").toDMY, "14/01/2027"); // cambio de año
});

test("excel: las fechas se interpretan en hora de España (una sesión de madrugada cuenta en su día)", () => {
  // 23:30 UTC del 14-oct son las 01:30 del 15-oct en España
  const datos = { profile: {}, state: { sessions: [{ id: "1", date: "2026-10-14T23:30:00Z", dayName: "Noche", exercises: [{ name: "X", sets: [{ kg: 1, reps: 1 }] }] }] } };
  assert.equal(w.planClientExcel("ana", datos, "2026-10-15").daySheets.length, 1);
  assert.equal(w.planClientExcel("ana", datos, "2026-10-16").daySheets.length, 0);
});

test("excel: se genera un .xlsx con resumen, una hoja por día, datos y gráficos", async () => {
  const { bytes, plan, charts } = await w.buildClientExcel("ana", datosExcel(), ymdHace(25), async () => PNG_FALSO);
  const f = leerZip(bytes);
  assert.ok(f["[Content_Types].xml"] && f["xl/workbook.xml"] && f["xl/styles.xml"]);
  const libro = Buffer.from(f["xl/workbook.xml"]).toString("utf8");
  assert.ok(libro.includes('name="Resumen"'));
  assert.equal((libro.match(/<sheet /g) || []).length, 1 + plan.daySheets.length);
  const hoja = Buffer.from(f["xl/worksheets/sheet2.xml"]).toString("utf8");
  assert.ok(hoja.includes("Press banca") && hoja.includes("Repeticiones") && hoja.includes("Peso (kg)"));
  assert.ok(hoja.includes("1 h 02 min")); // duración del entrenamiento
  assert.equal(charts, plan.daySheets.length); // un gráfico por hoja
  assert.ok(Object.keys(f).some(n => n.startsWith("xl/media/")));
  assert.ok(f["xl/drawings/drawing1.xml"] && f["xl/worksheets/_rels/sheet2.xml.rels"]);
});

test("excel: si un gráfico no se puede descargar, el Excel sale igual avisándolo", async () => {
  const { bytes, charts } = await w.buildClientExcel("ana", datosExcel(), ymdHace(25), async () => null);
  assert.equal(charts, 0);
  const f = leerZip(bytes);
  assert.ok(Buffer.from(f["xl/worksheets/sheet2.xml"]).toString("utf8").includes("gráfico no disponible"));
});

test("excel: nombres de hoja válidos y sin repetir, y texto con caracteres especiales escapado", async () => {
  const datos = datosExcel();
  datos.state.sessions = [
    { id: "1", date: "2026-10-01T10:00:00Z", dayName: "A/B:C*D?[x]", exercises: [{ name: "<b>&Press</b>", sets: [{ kg: 1, reps: 1 }] }] },
    { id: "2", date: "2026-10-01T11:00:00Z", dayName: "A/B:C*D?[x]", exercises: [{ name: "Otro", sets: [{ kg: 1, reps: 1 }] }] },
  ];
  const { bytes, plan } = await w.buildClientExcel("ana", datos, "2026-10-01", async () => PNG_FALSO);
  const nombres = plan.daySheets.map(s => s.sheetName);
  assert.equal(new Set(nombres.map(n => n.toLowerCase())).size, nombres.length);
  assert.ok(nombres.every(n => n.length <= 31 && !/[\[\]:*?\/\\]/.test(n)));
  const hoja = Buffer.from(leerZip(bytes)["xl/worksheets/sheet3.xml"]).toString("utf8"); // la más antigua va después
  assert.equal(hoja.includes("<b>&Press"), false);
  assert.ok(hoja.includes("&lt;b&gt;&amp;Press"));
});

test("excel por email: solo el admin, valida el email y adjunta el .xlsx", async () => {
  const env = entorno();
  await crearUsuario(env, "ana");
  const t = (await entrar(env, "ana")).data.token;
  await llamar(w, env, "/data", { metodo: "PUT", token: t, cuerpo: { plans: [], profile: datosExcel().profile, state: datosExcel().state, _rev: 0 } });
  const cuerpo = { username: "ana", to: "admin@correo.test", startDate: ymdHace(25) };

  assert.equal((await llamar(w, env, "/admin/send-client-excel", { metodo: "POST", cuerpo })).status, 401);
  assert.equal((await llamar(w, env, "/admin/send-client-excel", { metodo: "POST", token: t, cuerpo })).status, 401); // un cliente no puede
  assert.equal((await llamar(w, env, "/admin/send-client-excel", { metodo: "POST", admin: ADMIN, cuerpo: { ...cuerpo, to: "no-es-email" } })).status, 400);
  assert.equal((await llamar(w, env, "/admin/send-client-excel", { metodo: "POST", admin: ADMIN, cuerpo: { ...cuerpo, startDate: "31-02-2026" } })).status, 400);
  assert.equal((await llamar(w, env, "/admin/send-client-excel", { metodo: "POST", admin: ADMIN, cuerpo: { username: "ana", to: "admin@correo.test" } })).status, 400); // falta el día base
  assert.equal((await llamar(w, env, "/admin/send-client-excel", { metodo: "POST", admin: ADMIN, cuerpo: { ...cuerpo, username: "nadie" } })).status, 404);

  const original = globalThis.fetch;
  let enviado = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://quickchart.io/")) return new Response(PNG_FALSO, { status: 200 });
    enviado = { url: String(url), body: JSON.parse(init.body) };
    return new Response("{}", { status: 200 });
  };
  try {
    const r = await llamar(w, env, "/admin/send-client-excel", { metodo: "POST", admin: ADMIN, cuerpo });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.sheets, 2);
    assert.equal(enviado.url, "https://api.resend.com/emails");
    assert.deepEqual(enviado.body.to, ["admin@correo.test"]);
    assert.equal(enviado.body.attachments.length, 1);
    assert.ok(/^marcas-ana-\d{4}-\d{2}-\d{2}\.xlsx$/.test(enviado.body.attachments[0].filename));
    const zip = Uint8Array.from(Buffer.from(enviado.body.attachments[0].content, "base64"));
    assert.ok(leerZip(zip)["xl/workbook.xml"]);
  } finally { globalThis.fetch = original; }
});

// ---------- Cronómetro de duración del entrenamiento (vive en index.html) ----------
test("cronómetro: arranca una sola vez con la primera marca, se limpia y da formato", () => {
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.html"), "utf8");
  const a = html.indexOf("const WORKOUT_START_MAX_AGE_MS"), b = html.indexOf("function startWorkoutClockDisplay");
  assert.ok(a > 0 && b > a, "no se encuentra el cronómetro en index.html");
  const almacen = {};
  const localStorage = { getItem: k => (k in almacen ? almacen[k] : null), setItem: (k, v) => { almacen[k] = v; }, removeItem: k => { delete almacen[k]; } };
  const api = new Function("localStorage", "currentUser", "activePlanId", "state",
    html.slice(a, b) + ";return { startWorkoutClockIfNeeded, readWorkoutStart, clearWorkoutStart, fmtWorkoutDuration, fmtClock };")(localStorage, "ana", "p1", { currentDayIndex: 2 });
  assert.equal(api.readWorkoutStart(), null);
  api.startWorkoutClockIfNeeded();
  const inicio = api.readWorkoutStart().startedAt;
  api.startWorkoutClockIfNeeded(); // una segunda marca no lo reinicia
  assert.equal(api.readWorkoutStart().startedAt, inicio);
  api.clearWorkoutStart();
  assert.equal(api.readWorkoutStart(), null);
  assert.equal(api.fmtWorkoutDuration(20), "< 1 min");
  assert.equal(api.fmtWorkoutDuration(52 * 60), "52 min");
  assert.equal(api.fmtWorkoutDuration(3725), "1 h 02 min");
  assert.equal(api.fmtClock(65000), "01:05");
  assert.equal(api.fmtClock(3725000), "1:02:05");
});

test("base64 propio: igual que el estándar para cualquier longitud", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 6, 100, 101, 102, 1000]) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
    assert.equal(w.bytesToBase64(b), Buffer.from(b).toString("base64"), "longitud " + n);
  }
});

test("excel: cada ejercicio tiene su propio color (naranjas y grises alternados) y el estilo existe", async () => {
  const ej = (n) => ({ name: n, sets: [{ kg: 10, reps: 5 }, { kg: 12, reps: 4 }] });
  const datos = { profile: {}, state: { sessions: [{ id: "1", date: "2026-10-01T10:00:00Z", dayName: "Día", exercises: [ej("A"), ej("B"), ej("C")] }] } };
  const { bytes } = await w.buildClientExcel("ana", datos, "2026-10-01", async () => PNG_FALSO);
  const f = leerZip(bytes);
  const hoja = Buffer.from(f["xl/worksheets/sheet2.xml"]).toString("utf8");
  const estilo = (ref) => Number((hoja.match(new RegExp(`<c r="${ref}" s="(\\d+)"`)) || [])[1]);
  const [a, b, c] = [estilo("A6"), estilo("A8"), estilo("A10")]; // 2 series por ejercicio
  assert.ok(a && b && c && new Set([a, b, c]).size === 3, "cada ejercicio debe tener un estilo distinto");
  assert.equal(estilo("A7"), a); // todas las series del mismo ejercicio comparten color
  const estilos = Buffer.from(f["xl/styles.xml"]).toString("utf8");
  const total = Number(estilos.match(/<cellXfs count="(\d+)"/)[1]);
  assert.ok(Math.max(a, b, c) < total && (estilos.match(/<xf /g) || []).length === total + 1); // +1 por cellStyleXfs
});

test("excel: un ejercicio sin ninguna marca y las series vacías no aparecen (ni en la hoja, ni en el resumen, ni en el gráfico)", async () => {
  const datos = { profile: {}, state: { sessions: [{ id: "1", date: "2026-10-10T10:00:00Z", dayName: "Día", exercises: [
    { name: "Con marcas", sets: [{ kg: 20, reps: 10 }, { kg: 0, reps: 0 }, { kg: 25, reps: 8 }] },
    { name: "EJERCICIO-VACIO", sets: [{ kg: 0, reps: 0 }, { kg: 0, reps: 0 }] },
  ] }] } };
  const plan = w.planClientExcel("ana", datos, "2026-10-01");
  assert.equal(plan.daySheets.length, 1);
  const filas = plan.daySheets[0].setRows;
  assert.deepEqual(filas.map(r => [r.exerciseName, r.setNum]), [["Con marcas", 1], ["Con marcas", 3]]); // la serie 2 vacía no sale
  const { bytes, plan: p2 } = await w.buildClientExcel("ana", datos, "2026-10-01", async () => PNG_FALSO);
  const f = leerZip(bytes);
  const todo = Object.keys(f).filter(n => n.endsWith(".xml")).map(n => Buffer.from(f[n]).toString("utf8")).join("\n");
  assert.equal(todo.includes("EJERCICIO-VACIO"), false);
  assert.equal(p2.daySheets[0].images[0].url.includes("EJERCICIO-VACIO"), false); // tampoco en el gráfico
});
