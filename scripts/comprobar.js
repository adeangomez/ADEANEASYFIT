// Comprobación rápida antes de subir cambios.  Uso:  node scripts/comprobar.js
// Revisa que el código de app.js, admin.js y worker.js no tenga errores de
// sintaxis, que las páginas no lleven código incrustado (lo bloquearía la
// política de seguridad del navegador) y ejecuta las pruebas del worker.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const raiz = path.join(__dirname, "..");
let fallos = 0;

for (const f of ["app.js", "admin.js", "worker.js"]) {
  try {
    execFileSync(process.execPath, ["--check", path.join(raiz, f)], { stdio: "pipe" });
    console.log(`OK    ${f}`);
  } catch (e) {
    fallos++;
    console.error(`FALLO ${f}: ` + String(e.stderr || e.message).split("\n").slice(0, 5).join("\n"));
  }
}

for (const [f, js] of [["index.html", "app.js"], ["admin.html", "admin.js"]]) {
  const html = fs.readFileSync(path.join(raiz, f), "utf8");
  if (/<script(?![^>]*\bsrc=)[^>]*>/.test(html)) { fallos++; console.error(`FALLO ${f}: tiene un <script> con código dentro; el código va en ${js}`); }
  else if (!html.includes(`<script src="${js}`)) { fallos++; console.error(`FALLO ${f}: no carga ${js}`); }
  else console.log(`OK    ${f}`);
}

// Pruebas automáticas del worker (seguridad, datos, copias de seguridad, emails)
try {
  execFileSync(process.execPath, ["--test", path.join(raiz, "tests", "worker.test.cjs")], { stdio: "pipe" });
  console.log("OK    pruebas del worker");
} catch (e) {
  fallos++;
  console.error("FALLO pruebas del worker:\n" + String(e.stdout || e.message).split("\n").filter(l => /not ok|error|expected|actual/i.test(l)).slice(0, 15).join("\n"));
}

if (fallos) { console.error(`\n${fallos} comprobación(es) con fallo.`); process.exit(1); }
console.log("\nTodo correcto.");
