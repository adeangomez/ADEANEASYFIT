# Despliegue

Todo se publica solo al subir cambios a `main`.

| Qué cambia | Dónde se publica | Cuánto tarda |
| --- | --- | --- |
| `index.html`, `app.js`, `admin.html`, `admin.js`, `manifest.webmanifest`, `assets/` | GitHub Pages | 1 a 2 minutos |
| `worker.js`, `wrangler.toml` | Cloudflare (despliegue por Git) | 1 a 2 minutos |

Los secretos `ADMIN_KEY` y `RESEND_API_KEY` **no** están en el repositorio: se guardan cifrados en Cloudflare (Settings, Variables and Secrets) y los despliegues los respetan.

## Antes de subir

```bash
node scripts/comprobar.js
```

Comprueba que el código de la app, del panel y del worker no tiene errores de sintaxis y ejecuta las pruebas del worker (`tests/`): acceso, datos de cada usuario, panel de administrador, copias de seguridad y emails. La misma comprobación corre sola en GitHub (pestaña Actions) en cada subida.

## Si algo sale mal

- Volver atrás: en GitHub, abrir el último commit bueno y usar "Revert" sobre el commit que rompió algo.
- La app no se actualiza en el móvil: cerrar la app del todo y volver a abrirla, o borrar los datos del sitio en el navegador.
- Las rutas de GitHub Pages distinguen mayúsculas: `/ADEANEASYFIT/` funciona, `/adeaneasyfit/` no.

## Trabajar con ramas (recomendado)

1. Crear una rama para cada cambio (`feat/…`, `fix/…`) y subir a ella, no a `main`.
2. Abrir un Pull Request. GitHub ejecuta la comprobación sola.
3. Si está en verde, fusionar. Solo entonces se publica.

Para que GitHub **obligue** a pasar la comprobación antes de fusionar: Settings, Branches, Add branch protection rule sobre `main`, marcar "Require a pull request before merging" y "Require status checks to pass" (elige `Sintaxis de la app y del worker`).

## Copias de seguridad

Panel de administrador, Usuarios, **Copia de seguridad**: descarga un archivo con todas las cuentas y datos, y permite restaurarlo. Conviene hacer una antes de cualquier cambio importante y guardarla en un sitio seguro, porque contiene datos de salud.

## Punto de retorno

La rama `estable-2026-10-13` guarda el estado del repositorio antes de las mejoras de seguridad y pruebas. Para volver a ese punto se puede crear un Pull Request desde esa rama hacia `main`.

## Dónde está cada cosa

- `index.html` y `admin.html` solo llevan la estructura y los estilos. **El código va en `app.js` (app) y `admin.js` (panel)**. No hay que volver a meter código dentro de un `<script>` en las páginas ni usar `onclick="…"`: el navegador lo bloquearía (ver "Política de seguridad").
- Cuando cambies `app.js` o `admin.js`, sube también el número de versión de la línea `<script src="app.js?v=…">` (o `admin.js?v=…`) al final de la página. Así los móviles cogen el código nuevo al momento en vez de tardar hasta 10 minutos.

## Política de seguridad del navegador

Las dos páginas llevan una línea `Content-Security-Policy` en la cabecera. Le dice al navegador que solo ejecute nuestro código (`app.js` / `admin.js`) y que solo hable con nuestro servidor. Es la red de seguridad por si algún día se cuela texto malicioso en un nombre de rutina, una sugerencia, etc.

Si cambia la dirección de la app (dominio propio) o la del servidor, hay que actualizar **tres sitios**:

1. `connect-src` en la línea `Content-Security-Policy` de `index.html` y `admin.html` (dirección del servidor).
2. `ALLOWED_ORIGINS` al principio de `worker.js` (dirección de la app).
3. `API_BASE` en `app.js` y el campo "URL del servidor" de `admin.html`.

## Protección de acceso

- Contraseña mínima de 8 caracteres para cuentas nuevas y al cambiarla. Las cuentas antiguas con contraseñas más cortas siguen entrando.
- Tras 5 intentos fallidos con un usuario (o 30 desde una misma IP) el acceso se bloquea 15 minutos. Tras 10 claves de administrador erróneas se bloquea esa IP 15 minutos. Lo mismo al probar la contraseña actual en "Cambiar contraseña".
- Las contraseñas se guardan con PBKDF2. Las cuentas antiguas se pasan solas al formato nuevo la próxima vez que entran; no hay que hacer nada.
- Cambiar la contraseña (el usuario o tú desde el panel) cierra las sesiones abiertas en otros dispositivos.
- Topes de uso por usuario: 20 usos de la IA por hora, 10 emails por hora, 10 sugerencias al día. Se cambian al principio de `worker.js`.
- El servidor solo responde a navegadores que vengan de la web de la app (`ALLOWED_ORIGINS`).

## La clave de administrador

Quien tenga la `ADMIN_KEY` puede ver y borrar los datos de todos los usuarios. Guárdala solo en un gestor de contraseñas: no en archivos del ordenador, ni en notas, ni pegada en chats. Si alguna vez ha estado en uno de esos sitios, cámbiala: Cloudflare, Worker `adeanfit-api`, Settings, Variables and Secrets, `ADMIN_KEY`, poner una nueva (larga y aleatoria) y desplegar. La casilla "Recordar clave en este navegador" del panel úsala solo en tu propio dispositivo.
