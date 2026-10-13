# Despliegue

Todo se publica solo al subir cambios a `main`.

| Qué cambia | Dónde se publica | Cuánto tarda |
| --- | --- | --- |
| `index.html`, `admin.html`, `assets/` | GitHub Pages | 1 a 2 minutos |
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

## Protección de acceso

- Contraseña mínima de 8 caracteres para cuentas nuevas y al cambiarla. Las cuentas antiguas con contraseñas más cortas siguen entrando.
- Tras 5 intentos fallidos con un usuario (o 30 desde una misma IP) el acceso se bloquea 15 minutos. Tras 10 claves de administrador erróneas se bloquea esa IP 15 minutos.
