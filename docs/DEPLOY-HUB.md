# Deploy do hub (HTTPS em apibot.atomoz.io / bot.atomoz.io)

O hub (`hub/server.js`) é **HTTP puro**. O HTTPS é terminado num **reverse proxy**
na frente (Caddy/nginx/Cloudflare) que encaminha pro Node. **Nenhuma mudança de
código é necessária pra TLS.**

## Pontos de atenção

1. **Os 2 domínios apontam pro MESMO hub.** A página de upload usa URLs relativas
   (`/upload`, `/agents`), então o domínio que serve a página também atende a API.
   Aponte `apibot.atomoz.io` e `bot.atomoz.io` pro mesmo processo. (Se quiser API e
   UI em domínios separados, precisaria de CORS — evite, deixe os dois iguais.)
2. **Upload grande** (zips de sessions e vídeo): aumente o limite de corpo no proxy
   (`client_max_body_size` / `max_size`). O Node não limita.
3. **Cloudflare proxied (nuvem laranja)** limita upload a 100 MB no plano free — se o
   vídeo/zip passar disso, use Caddy/nginx direto (DNS-only) ou plano pago.
4. **HUB_TOKEN** obrigatório no ambiente do hub. Use HTTPS pra não vazar o token.
5. **Mantenha o processo vivo** (systemd/pm2/nssm). Ex.: `pm2 start hub/server.js --name wppbot-hub`.
6. **Agente**: `HUB_URL` aponta pra um dos domínios (ex.: `https://apibot.atomoz.io`).
   O cert precisa ser válido (Let's Encrypt) — o `fetch` do Node rejeita self-signed.

## Caddy (mais fácil — HTTPS automático via Let's Encrypt)

`/etc/caddy/Caddyfile`:

```
apibot.atomoz.io, bot.atomoz.io {
    encode gzip
    request_body {
        max_size 2GB
    }
    reverse_proxy localhost:8787
}
```

Caddy já injeta `X-Forwarded-For` (o hub usa pra mostrar o IP real do agente).

## nginx (alternativa)

```nginx
server {
    listen 443 ssl;
    server_name apibot.atomoz.io bot.atomoz.io;
    ssl_certificate     /etc/letsencrypt/live/atomoz.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/atomoz.io/privkey.pem;

    client_max_body_size 2g;            # zips/vídeo grandes

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 600s;        # syncs longos
        proxy_send_timeout 600s;
    }
}
```

## Subir o hub

```bash
# no servidor (com Node 22+):
git clone https://github.com/Martyzaum/botmkt.git && cd botmkt
npm install
# .env mínimo:
#   HUB_TOKEN=<um token forte>
#   HUB_PORT=8787
node hub/server.js          # ou: pm2 start hub/server.js --name wppbot-hub
```

Teste: `https://bot.atomoz.io/health` deve responder `{ "ok": true, ... }`.
A página de upload abre em `https://bot.atomoz.io/`.
