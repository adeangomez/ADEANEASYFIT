// Comprobación rápida antes de subir cambios.  Uso:  node scripts/comprobar.js
// Revisa que el código de index.html, admin.html y worker.js no tenga errores de sintaxis.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const raiz = path.join(__dirname, "..");
let fallos = 0;

for (const f of ["index.html", "admin.html"]) {
  const html = fs.readFileSync(path.join(raiz, f), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  scripts.forEach((m, i) => {
    try { new Function(m[1]); console.log(`OK    ${f} (script ${i + 1})`); }
    catch (e) { fallos++; console.error(`FALLO ${f} (script ${i + 1}): ${e.message}`); }
  });
  if (scripts.length === 0) { fallos++; console.error(`FALLO ${f}: no se encontró ningún <script>`); }
}

try {
  execFileSync(process.execPath, ["--check", path.join(raiz, "worker.js")], { stdio: "pipe" });
  console.log("OK    worker.js");
} catch (e) {
  fallos++;
  console.error("FALLO worker.js: " + String(e.stderr || e.message).split("\n").slice(0, 5).join("\n"));
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
