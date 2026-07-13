# node.js-web_terminal

node index.js -c admin/123456 & sleep 3 && curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cf && chmod +x cf && ./cf tunnel --protocol http2 run --token eyXXXXXXXXXXXX
