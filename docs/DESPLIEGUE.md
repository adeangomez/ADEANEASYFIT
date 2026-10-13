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

Comprueba que el código de la app, del panel y del worker no tiene errores de sintaxis. La misma comprobación corre sola en GitHub (pestaña Actions) en cada subida.

## Si algo sale mal

- Volver atrás: en GitHub, abrir el último commit bueno y usar "Revert" sobre el commit que rompió algo.
- La app no se actualiza en el móvil: cerrar la app del todo y volver a abrirla, o borrar los datos del sitio en el navegador.
- Las rutas de GitHub Pages distinguen mayúsculas: `/ADEANEASYFIT/` funciona, `/adeaneasyfit/` no.
